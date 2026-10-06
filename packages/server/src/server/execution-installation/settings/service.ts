import { validateProviderAccountSetup } from "./providers.js";
import {
  enrollInstallationPluginProviders,
  readInstallationProviders,
  mergeInstallationProviders,
  installationProvidersSettled,
} from "./providers.js";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { mergeInstallationSkills } from "./skill-catalog.js";
import type { InstallationSkill } from "@getpaseo/protocol/skill-library";
import {
  readInstallationPlugins,
  mergeInstallationPlugins,
  installationPluginsSettled,
} from "./plugins.js";
import type { InstallationPlugin } from "@getpaseo/protocol/plugin-installation";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  AgentSkillSelection,
  AgentSkillsSaveResult,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import {
  InstallationSettingsFieldSchema,
  InstallationSettingsSchema,
  InstallationSettingsSnapshotSchema,
  InstallationSettingsUpdateSchema,
  type InstallationSettings,
  type InstallationSettingsField,
  type InstallationSettingsSnapshot,
  type InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import {
  InstallationAccountBindingUnavailable,
  projectInstallationSettings,
  readInstallationSettings,
} from "./projection.js";

export interface SettingsEnvironment {
  serverId: string;
  /** Trusted installation metadata, not a value read from a guest daemon. */
  installationInstructions?: string;
  read(): Promise<MutableDaemonConfig>;
  prepareProviderAccounts(definitions: readonly InstallationProvider[]): Promise<void>;
  readPlugins(): Promise<PluginListItem[]>;
  readSkillCatalog(): Promise<InstallationSkill[]>;
  skillCatalogSettled(definitions: readonly InstallationSkill[]): Promise<boolean>;
  projectSkillCatalog(definitions: readonly InstallationSkill[]): Promise<void>;
  projectPlugins(
    definitions: readonly InstallationPlugin[],
    excludedIds: readonly string[],
  ): Promise<void>;
  previewSkills(selection: AgentSkillSelection): Promise<AgentSkillsSaveResult>;
  patch(
    patch: MutableDaemonConfigPatch,
    confirmedSkillRemovals?: readonly string[],
  ): Promise<MutableDaemonConfig>;
}

interface SettingsProjectionVerification {
  environment: SettingsEnvironment;
  expected: InstallationSettings;
  patch: ReturnType<typeof projectInstallationSettings>;
  skills: InstallationSettings["skills"];
  plugins: InstallationSettings["plugins"];
  skillLibrary: InstallationSettings["skillLibrary"];
  excludedPluginIds: readonly string[];
}

export const SettingsBackupSchema = z.strictObject({
  reason: z.enum([
    "initial-migration",
    "browser-policy-migration",
    "plugin-catalog-migration",
    "skill-catalog-migration",
    "provider-catalog-migration",
    "plugin-provider-enrollment",
    "owner-update",
    "environment-projection",
  ]),
  previous: InstallationSettingsSnapshotSchema,
  observations: z.record(z.string().min(1), InstallationSettingsSchema),
});
export type SettingsBackup = z.infer<typeof SettingsBackupSchema>;

export interface SettingsJournal {
  validateSkillCatalog(definitions: readonly InstallationSkill[]): void;
  read(): InstallationSettingsSnapshot | null;
  write(snapshot: InstallationSettingsSnapshot): void;
  backup(backup: SettingsBackup): void;
}

export class InstallationSettingsConflict extends Error {
  constructor(
    readonly revision: number,
    readonly fields: InstallationSettingsField[] = [],
  ) {
    super("Reload shared settings and explicitly resolve every initial policy difference.");
    this.name = "InstallationSettingsConflict";
  }
}

export class InstallationSettingsInvalidUpdate extends Error {
  constructor(
    readonly reason:
      | "environment"
      | "provider"
      | "provider-binding"
      | "plugin"
      | "skill"
      | "terminal-profile"
      | "metadata-provider"
      | "installation-instructions",
  ) {
    super("Shared settings reference an unknown environment or resource.");
    this.name = "InstallationSettingsInvalidUpdate";
  }
}

export class InstallationSettingsNotInitialized extends Error {
  constructor() {
    super("Read every installation environment before editing shared settings.");
    this.name = "InstallationSettingsNotInitialized";
  }
}

/** A single installation authority. Environment observations never become edits after migration. */
export class InstallationSettingsService {
  private state: InstallationSettingsSnapshot;
  private queue: Promise<void> = Promise.resolve();
  private projectionRevision: number | null = null;
  private readonly installationInstructions: string[] = [];
  private skillRemovalConfirmations: Record<string, readonly string[]> = {};

  constructor(
    private readonly journal: SettingsJournal,
    private readonly environments: readonly SettingsEnvironment[],
  ) {
    const ids = environments.map((environment) => environment.serverId);
    if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !id))
      throw new InstallationSettingsInvalidUpdate("environment");
    for (const environment of environments) {
      if (environment.installationInstructions)
        this.installationInstructions.push(environment.installationInstructions);
    }
    const stored = journal.read();
    this.state =
      stored === null ? this.emptySnapshot() : InstallationSettingsSnapshotSchema.parse(stored);
    if (!isDeepStrictEqual(Object.keys(this.state.sources).sort(), ids.toSorted()))
      throw new InstallationSettingsInvalidUpdate("environment");
    if (
      this.state.conflicts !== undefined &&
      !isDeepStrictEqual(Object.keys(this.state.conflicts.candidates).sort(), ids.toSorted())
    )
      throw new InstallationSettingsInvalidUpdate("environment");
    if (this.state.settings !== null) this.validateResources(this.state.settings);
  }

  snapshot(): InstallationSettingsSnapshot {
    return structuredClone(this.state);
  }

  previewSkills(
    selection: AgentSkillSelection,
  ): Promise<Record<string, AgentSkillsSaveResult | null>> {
    return this.enqueue(async () => {
      const plans: Record<string, AgentSkillsSaveResult | null> = {};
      for (const environment of this.environments) {
        try {
          plans[environment.serverId] = await environment.previewSkills(selection);
        } catch {
          plans[environment.serverId] = null;
        }
      }
      return plans;
    });
  }

  async update(input: InstallationSettingsUpdate): Promise<InstallationSettingsSnapshot> {
    const request = InstallationSettingsUpdateSchema.parse(input);
    if (request.confirmedSkillRemovals) {
      if (
        !request.settings.skills ||
        Object.keys(request.confirmedSkillRemovals).some((id) => !this.state.sources[id])
      )
        throw new InstallationSettingsInvalidUpdate("environment");
    }
    const previous = this.state;
    if (
      this.needsPluginCatalogMigration() ||
      this.needsSkillCatalogMigration() ||
      this.needsProviderCatalogMigration() ||
      this.needsBrowserPolicyMigration()
    )
      throw new InstallationSettingsNotInitialized();
    if (request.expectedRevision !== previous.revision)
      throw new InstallationSettingsConflict(previous.revision);
    if (previous.settings === null && previous.conflicts === undefined)
      throw new InstallationSettingsNotInitialized();
    let base: InstallationSettings;
    if (previous.conflicts !== undefined) {
      const unresolved = previous.conflicts.fields.filter(
        (field) => request.settings[field] === undefined,
      );
      if (unresolved.length) throw new InstallationSettingsConflict(previous.revision, unresolved);
      base = previous.conflicts.candidates[this.environments[0].serverId];
    } else {
      base = previous.settings;
    }
    const settings = InstallationSettingsSchema.parse({ ...base, ...request.settings });
    if (request.settings.resourceExclusions === undefined) pruneResourceExclusions(settings);
    this.validateResources(settings);
    if (previous.settings !== null && isDeepStrictEqual(settings, previous.settings)) {
      this.skillRemovalConfirmations = request.confirmedSkillRemovals ?? {};
      return this.snapshot();
    }
    const revision = previous.revision + 1;
    const next: InstallationSettingsSnapshot = {
      version: 1,
      revision,
      settings,
      sources: structuredClone(previous.sources),
    };
    for (const status of Object.values(next.sources)) {
      status.pendingRevision = revision;
      status.error = null;
    }
    this.journal.backup({ reason: "owner-update", previous: this.snapshot(), observations: {} });
    this.commit(next);
    this.skillRemovalConfirmations = request.confirmedSkillRemovals ?? {};
    // Reconciliation is explicit so the route can acknowledge durable ownership before RPC work.
    return this.snapshot();
  }

  reconcile(): Promise<InstallationSettingsSnapshot> {
    return this.enqueue(async () => {
      this.projectionRevision = null;
      if (this.state.settings === null && this.state.conflicts === undefined) await this.migrate();
      if (this.needsPluginCatalogMigration()) await this.migratePluginCatalog();
      if (this.needsPluginCatalogMigration()) return this.snapshot();
      if (this.needsSkillCatalogMigration()) await this.migrateSkillCatalog();
      if (this.needsSkillCatalogMigration()) return this.snapshot();
      if (this.needsProviderCatalogMigration()) await this.migrateProviderCatalog();
      if (this.needsProviderCatalogMigration()) return this.snapshot();
      if (this.needsBrowserPolicyMigration()) await this.migrateBrowserPolicy();
      if (this.needsBrowserPolicyMigration()) return this.snapshot();
      if (this.state.settings !== null) {
        const unavailable = await this.enrollPluginProviders();
        for (const environment of this.environments)
          if (!unavailable.has(environment.serverId)) await this.project(environment);
      }
      return this.snapshot();
    });
  }

  private async enrollPluginProviders(): Promise<Set<string>> {
    const unavailable = new Set<string>();
    const previous = this.snapshot();
    if (!previous.settings?.pluginsEnabled || !previous.settings.providerDefinitions)
      return unavailable;
    const settings = structuredClone(previous.settings);
    for (const environment of this.environments) {
      try {
        const plugins = await environment.readPlugins();
        if (!plugins.some((plugin) => plugin.providers?.length)) continue;
        const local = await environment.read();
        settings.providerDefinitions = enrollInstallationPluginProviders({
          settings,
          serverId: environment.serverId,
          plugins,
          providers: local.providers,
        });
      } catch {
        unavailable.add(environment.serverId);
      }
    }
    if (previous.revision !== this.state.revision) return unavailable;
    if (!isDeepStrictEqual(settings.providerDefinitions, previous.settings.providerDefinitions)) {
      this.validateResources(settings);
      const next = { ...previous, revision: previous.revision + 1, settings };
      for (const source of Object.values(next.sources)) source.pendingRevision = next.revision;
      this.journal.backup({ reason: "plugin-provider-enrollment", previous, observations: {} });
      this.commit(next);
    }
    for (const serverId of unavailable) this.recordStatus(serverId, "read_failed");
    return unavailable;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private emptySnapshot(): InstallationSettingsSnapshot {
    const sources: InstallationSettingsSnapshot["sources"] = {};
    for (const { serverId } of this.environments) {
      sources[serverId] = { appliedRevision: null, pendingRevision: null, error: null };
    }
    return { version: 1, revision: 0, settings: null, sources };
  }

  private commit(next: InstallationSettingsSnapshot): void {
    if (isDeepStrictEqual(next, this.state)) return;
    this.journal.write(structuredClone(next));
    this.state = next;
  }

  private validateSkillCatalog(settings: InstallationSettings): string[] {
    if (settings.skillLibrary) this.journal.validateSkillCatalog(settings.skillLibrary);
    const skillIds = settings.skillLibrary?.map((skill) => skill.identity) ?? [];
    const skillNames = settings.skillLibrary?.map((skill) => skill.name) ?? [];
    if (
      new Set(skillIds).size !== skillIds.length ||
      new Set(skillNames).size !== skillNames.length
    )
      throw new InstallationSettingsInvalidUpdate("skill");
    return skillIds;
  }

  private validateProviderCatalog(settings: InstallationSettings): string[] {
    const ids: string[] = [];
    const bindings = new Set<string>();
    for (const definition of settings.providerDefinitions ?? []) {
      if (ids.includes(definition.id)) throw new InstallationSettingsInvalidUpdate("provider");
      validateProviderAccountSetup(definition);
      if (
        !definition.policy.label &&
        Object.values(definition.bindings).some((localId) => localId !== definition.providerType)
      )
        throw new InstallationSettingsInvalidUpdate("provider");
      ids.push(definition.id);
      for (const [serverId, providerId] of Object.entries(definition.bindings)) {
        const key = JSON.stringify([serverId, providerId]);
        if (!Object.hasOwn(this.state.sources, serverId) || bindings.has(key))
          throw new InstallationSettingsInvalidUpdate("provider-binding");
        bindings.add(key);
      }
    }
    return ids;
  }

  private validateResources(settings: InstallationSettings): void {
    if (
      this.installationInstructions.some((instructions) =>
        settings.appendSystemPrompt.includes(instructions),
      )
    )
      throw new InstallationSettingsInvalidUpdate("installation-instructions");
    const pluginIds = settings.plugins?.map((plugin) => plugin.id) ?? [];
    if (new Set(pluginIds).size !== pluginIds.length)
      throw new InstallationSettingsInvalidUpdate("plugin");
    const skillIds = this.validateSkillCatalog(settings);
    const definitionIds = this.validateProviderCatalog(settings);
    const terminalIds = settings.terminalProfiles.map((profile) => profile.id);
    if (new Set(terminalIds).size !== terminalIds.length)
      throw new InstallationSettingsInvalidUpdate("terminal-profile");
    const providers = new Set(settings.metadataGeneration.providers.map((entry) => entry.provider));
    for (const [serverId, exclusions] of Object.entries(settings.resourceExclusions)) {
      if (!this.state.sources[serverId]) throw new InstallationSettingsInvalidUpdate("environment");
      if (exclusions.providerIds?.some((id) => !definitionIds.includes(id)))
        throw new InstallationSettingsInvalidUpdate("provider");
      if (exclusions.skillIdentities?.some((id) => !skillIds.includes(id)))
        throw new InstallationSettingsInvalidUpdate("skill");
      if (exclusions.pluginIds?.some((id) => !pluginIds.includes(id)))
        throw new InstallationSettingsInvalidUpdate("plugin");
      if (exclusions.terminalProfileIds.some((id) => !terminalIds.includes(id)))
        throw new InstallationSettingsInvalidUpdate("terminal-profile");
      if (exclusions.metadataProviderIds.some((id) => !providers.has(id)))
        throw new InstallationSettingsInvalidUpdate("metadata-provider");
    }
  }

  private needsPluginCatalogMigration(): boolean {
    if (this.state.settings) return this.state.settings.plugins === undefined;
    return (
      this.state.conflicts !== undefined &&
      Object.values(this.state.conflicts.candidates).some(
        (candidate) => candidate.plugins === undefined,
      )
    );
  }

  private async migratePluginCatalog(): Promise<void> {
    const observations = await Promise.allSettled(
      this.environments.map(async (environment) =>
        readInstallationPlugins(await environment.readPlugins()),
      ),
    );
    const previous = this.snapshot();
    const sources = structuredClone(previous.sources);
    const inventories: Record<string, InstallationPlugin[]> = {};
    for (const [index, observation] of observations.entries()) {
      const id = this.environments[index].serverId;
      sources[id].pendingRevision = previous.revision;
      sources[id].error = observation.status === "rejected" ? "read_failed" : null;
      if (observation.status === "fulfilled") inventories[id] = observation.value;
    }
    if (observations.some((observation) => observation.status === "rejected")) {
      this.commit({ ...previous, sources });
      return;
    }
    const merged = mergeInstallationPlugins(inventories);
    const candidates: Record<string, InstallationSettings> = {};
    for (const { serverId } of this.environments) {
      const base = previous.settings ?? previous.conflicts?.candidates[serverId];
      if (!base) throw new InstallationSettingsNotInitialized();
      candidates[serverId] = Object.assign(structuredClone(base), {
        plugins: merged.candidates[serverId],
      });
    }
    const fields = new Set(previous.conflicts?.fields ?? []);
    if (merged.needsReview) fields.add("plugins");
    const revision = previous.revision + 1;
    for (const status of Object.values(sources)) status.pendingRevision = revision;
    this.journal.backup({ reason: "plugin-catalog-migration", previous, observations: candidates });
    if (fields.size) {
      this.commit({
        version: 1,
        revision,
        sources,
        settings: null,
        conflicts: { candidates, fields: [...fields] },
      });
    } else {
      const settings = candidates[this.environments[0].serverId];
      this.validateResources(settings);
      this.commit({ version: 1, revision, sources, settings });
    }
  }

  private needsSkillCatalogMigration(): boolean {
    if (this.state.settings) return this.state.settings.skillLibrary === undefined;
    return (
      this.state.conflicts !== undefined &&
      Object.values(this.state.conflicts.candidates).some(
        (candidate) => candidate.skillLibrary === undefined,
      )
    );
  }

  private async migrateSkillCatalog(): Promise<void> {
    const previous = this.snapshot();
    const observations: Record<string, InstallationSkill[]> = {};
    for (const environment of this.environments) {
      try {
        observations[environment.serverId] = await environment.readSkillCatalog();
      } catch {
        this.recordStatus(environment.serverId, "read_failed");
        return;
      }
    }
    const merged = mergeInstallationSkills(observations);
    const candidates: Record<string, InstallationSettings> = {};
    for (const { serverId } of this.environments) {
      const base = previous.settings ?? previous.conflicts?.candidates[serverId];
      if (!base) throw new InstallationSettingsNotInitialized();
      candidates[serverId] = {
        ...structuredClone(base),
        skillLibrary: merged.candidates[serverId],
      };
    }
    const fields = new Set(previous.conflicts?.fields ?? []);
    if (merged.needsReview) fields.add("skillLibrary");
    const revision = previous.revision + 1;
    const sources = structuredClone(this.state.sources);
    for (const source of Object.values(sources)) {
      source.pendingRevision = revision;
      source.error = null;
    }
    this.journal.backup({ reason: "skill-catalog-migration", previous, observations: candidates });
    if (fields.size)
      this.commit({
        version: 1,
        revision,
        sources,
        settings: null,
        conflicts: { candidates, fields: [...fields] },
      });
    else {
      const settings = candidates[this.environments[0].serverId];
      this.validateResources(settings);
      this.commit({ version: 1, revision, sources, settings });
    }
  }

  private needsProviderCatalogMigration(): boolean {
    if (this.state.settings) return this.state.settings.providerDefinitions === undefined;
    return (
      this.state.conflicts !== undefined &&
      Object.values(this.state.conflicts.candidates).some(
        (candidate) => candidate.providerDefinitions === undefined,
      )
    );
  }

  private async migrateProviderCatalog(): Promise<void> {
    const previous = this.snapshot();
    const observations: Record<string, InstallationProvider[]> = {};
    for (const environment of this.environments) {
      try {
        observations[environment.serverId] = readInstallationProviders(
          environment.serverId,
          (await environment.read()).providers,
        );
      } catch {
        this.recordStatus(environment.serverId, "read_failed");
        return;
      }
    }
    const merged = mergeInstallationProviders(observations);
    const candidates: Record<string, InstallationSettings> = {};
    for (const { serverId } of this.environments) {
      const base = previous.settings ?? previous.conflicts?.candidates[serverId];
      if (!base) throw new InstallationSettingsNotInitialized();
      candidates[serverId] = {
        ...structuredClone(base),
        providerDefinitions: merged.candidates[serverId],
      };
    }
    const fields = new Set(previous.conflicts?.fields ?? []);
    if (merged.needsReview) fields.add("providerDefinitions");
    const revision = previous.revision + 1;
    const sources = structuredClone(this.state.sources);
    for (const source of Object.values(sources)) {
      source.pendingRevision = revision;
      source.error = null;
    }
    this.journal.backup({
      reason: "provider-catalog-migration",
      previous,
      observations: candidates,
    });
    if (fields.size)
      this.commit({
        version: 1,
        revision,
        sources,
        settings: null,
        conflicts: { candidates, fields: [...fields] },
      });
    else {
      const settings = candidates[this.environments[0].serverId];
      this.validateResources(settings);
      this.commit({ version: 1, revision, sources, settings });
    }
  }

  private needsBrowserPolicyMigration(): boolean {
    if (this.state.settings) return this.state.settings.browserTools === undefined;
    return Object.values(this.state.conflicts?.candidates ?? {}).some(
      (candidate) => candidate.browserTools === undefined,
    );
  }

  private async migrateBrowserPolicy(): Promise<void> {
    const previous = this.snapshot();
    const sources = structuredClone(previous.sources);
    const candidates: Record<string, InstallationSettings> = {};
    const observations = await Promise.allSettled(
      this.environments.map(async (environment) => (await environment.read()).browserTools.enabled),
    );
    for (const [index, observation] of observations.entries()) {
      const id = this.environments[index].serverId;
      sources[id].error = observation.status === "rejected" ? "read_failed" : null;
      if (observation.status === "rejected") continue;
      const base = previous.settings ?? previous.conflicts?.candidates[id];
      if (!base) throw new InstallationSettingsNotInitialized();
      candidates[id] = { ...structuredClone(base), browserTools: { enabled: observation.value } };
    }
    if (observations.some((observation) => observation.status === "rejected")) {
      this.commit({ ...previous, sources });
      return;
    }
    this.journal.backup({ reason: "browser-policy-migration", previous, observations: candidates });
    shareBrowserTools(candidates);
    const revision = previous.revision + 1;
    for (const status of Object.values(sources)) status.pendingRevision = revision;
    if (previous.conflicts) {
      this.commit({
        ...previous,
        revision,
        sources,
        conflicts: { ...previous.conflicts, candidates },
      });
    } else {
      const settings = candidates[this.environments[0].serverId];
      this.validateResources(settings);
      this.commit({ version: 1, revision, sources, settings });
    }
  }

  private async migrate(): Promise<void> {
    const observations = await Promise.allSettled(
      this.environments.map(async (environment) => {
        const local = await environment.read();
        return {
          ...readInstallationSettings(local, this.installationInstructions),
          providerDefinitions: readInstallationProviders(environment.serverId, local.providers),
          plugins: readInstallationPlugins(await environment.readPlugins()),
          skillLibrary: await environment.readSkillCatalog(),
        };
      }),
    );
    const next = this.snapshot();
    const candidates: Record<string, InstallationSettings> = {};
    const conflicts = new Set<InstallationSettingsField>();
    for (const [index, observation] of observations.entries()) {
      const id = this.environments[index].serverId;
      next.sources[id].error = observation.status === "rejected" ? "read_failed" : null;
      if (observation.status === "fulfilled") {
        candidates[id] = observation.value;
      }
    }
    if (observations.some((observation) => observation.status === "rejected")) {
      this.commit(next);
      return;
    }
    const mergedPlugins = mergeInstallationPlugins(
      Object.fromEntries(
        Object.entries(candidates).map(([id, candidate]) => [id, candidate.plugins ?? []]),
      ),
    );
    for (const [id, plugins] of Object.entries(mergedPlugins.candidates))
      candidates[id].plugins = plugins;
    if (mergedPlugins.needsReview) conflicts.add("plugins");
    const skillObservations: Record<string, InstallationSkill[]> = {};
    for (const [id, candidate] of Object.entries(candidates))
      skillObservations[id] = candidate.skillLibrary ?? [];
    const mergedSkills = mergeInstallationSkills(skillObservations);
    for (const [id, candidate] of Object.entries(candidates))
      candidate.skillLibrary = mergedSkills.candidates[id];
    if (mergedSkills.needsReview) conflicts.add("skillLibrary");
    const mergedProviders = mergeInstallationProviders(
      Object.fromEntries(
        Object.entries(candidates).map(([id, candidate]) => [
          id,
          candidate.providerDefinitions ?? [],
        ]),
      ),
    );
    for (const [id, definitions] of Object.entries(mergedProviders.candidates))
      candidates[id].providerDefinitions = definitions;
    if (mergedProviders.needsReview) conflicts.add("providerDefinitions");
    const browserObservations = structuredClone(candidates);
    shareBrowserTools(candidates);
    const first = candidates[this.environments[0].serverId];
    for (const field of InstallationSettingsFieldSchema.options) {
      if (
        Object.values(candidates).some(
          (candidate) => !isDeepStrictEqual(first[field], candidate[field]),
        )
      )
        conflicts.add(field);
    }
    const revision = 1;
    for (const status of Object.values(next.sources)) status.pendingRevision = revision;
    this.journal.backup({
      reason: "initial-migration",
      previous: this.snapshot(),
      observations: browserObservations,
    });
    if (conflicts.size) {
      this.commit({
        ...next,
        revision,
        settings: null,
        conflicts: { candidates, fields: [...conflicts] },
      });
    } else {
      this.validateResources(first);
      this.commit({ ...next, revision, settings: first, conflicts: undefined });
    }
  }

  private availableSkills(settings: InstallationSettings, serverId: string): InstallationSkill[] {
    const excluded = settings.resourceExclusions[serverId]?.skillIdentities ?? [];
    return (settings.skillLibrary ?? []).filter((skill) => !excluded.includes(skill.identity));
  }

  private async inspectResources(environment: SettingsEnvironment, settings: InstallationSettings) {
    const localConfig = await environment.read();
    const observed = readInstallationSettings(localConfig, this.installationInstructions);
    const excludedPluginIds = settings.resourceExclusions[environment.serverId]?.pluginIds ?? [];
    let pluginsSettled = true;
    if (settings.plugins)
      pluginsSettled = installationPluginsSettled(
        await environment.readPlugins(),
        settings.plugins,
        excludedPluginIds,
      );
    let skillCatalogSettled = true;
    if (settings.skillLibrary)
      skillCatalogSettled = await environment.skillCatalogSettled(
        this.availableSkills(settings, environment.serverId),
      );
    let skillPlan: AgentSkillsSaveResult | null = null;
    if (settings.skills) skillPlan = await environment.previewSkills(settings.skills.selection);
    return {
      localConfig,
      observed,
      excludedPluginIds,
      pluginsSettled,
      skillCatalogSettled,
      skillPlan,
    };
  }

  private async prepareEnvironment(
    environment: SettingsEnvironment,
    settings: InstallationSettings,
  ) {
    const excluded = settings.resourceExclusions[environment.serverId]?.providerIds ?? [];
    const accounts =
      settings.providerDefinitions?.filter(
        (definition) =>
          !definition.removed &&
          definition.accountSetup &&
          Object.hasOwn(definition.bindings, environment.serverId) &&
          !excluded.includes(definition.id),
      ) ?? [];
    if (accounts.length) {
      try {
        await environment.prepareProviderAccounts(accounts);
      } catch {
        this.recordStatus(environment.serverId, "account_binding_unavailable");
        return null;
      }
    }
    try {
      const inspected = await this.inspectResources(environment, settings);
      return this.projectionRevision === this.state.revision ? inspected : null;
    } catch {
      this.recordStatus(environment.serverId, "read_failed");
      return null;
    }
  }

  private async project(environment: SettingsEnvironment): Promise<void> {
    const state = this.state;
    this.projectionRevision = state.revision;
    if (state.settings === null) return;
    const confirmedRemovals = this.skillRemovalConfirmations[environment.serverId] ?? [];
    delete this.skillRemovalConfirmations[environment.serverId];
    const inspected = await this.prepareEnvironment(environment, state.settings);
    if (!inspected) return;
    const {
      observed,
      localConfig,
      skillPlan,
      pluginsSettled,
      skillCatalogSettled,
      excludedPluginIds,
    } = inspected;
    if (
      skillPlan?.confirmationRequired?.removals.some((name) => !confirmedRemovals.includes(name))
    ) {
      this.recordStatus(environment.serverId, "skill_removal_review_required");
      return;
    }
    let patch: ReturnType<typeof projectInstallationSettings>;
    try {
      patch = projectInstallationSettings(
        state.settings,
        environment.serverId,
        localConfig,
        environment.installationInstructions,
      );
    } catch (error) {
      if (!(error instanceof InstallationAccountBindingUnavailable)) throw error;
      this.recordStatus(environment.serverId, "account_binding_unavailable");
      return;
    }
    // Compare only canonical policy. Local resource bindings never enter the journal.
    const expected = readInstallationSettings(
      {
        ...localConfig,
        ...patch,
        mcp: { ...localConfig.mcp, ...patch.mcp },
      },
      this.installationInstructions,
    );
    const instructionsMatch = localConfig.appendSystemPrompt === patch.appendSystemPrompt;
    const bindingsMatch = isDeepStrictEqual(
      localConfig.installationResourceBindings ?? { terminalProfiles: [], metadataProviders: [] },
      patch.installationResourceBindings,
    );
    const skillsSettled = skillPlan === null || skillPlan.ops.length === 0;
    if (
      isDeepStrictEqual(observed, expected) &&
      instructionsMatch &&
      bindingsMatch &&
      skillsSettled &&
      skillCatalogSettled &&
      pluginsSettled &&
      (!state.settings.providerDefinitions ||
        installationProvidersSettled(
          state.settings.providerDefinitions,
          environment.serverId,
          localConfig.providers,
          state.settings.resourceExclusions[environment.serverId]?.providerIds,
        ))
    ) {
      this.recordStatus(environment.serverId, null);
      return;
    }
    const pending = this.snapshot();
    pending.sources[environment.serverId].pendingRevision = state.revision;
    pending.sources[environment.serverId].error = null;
    this.journal.backup({
      reason: "environment-projection",
      previous: this.snapshot(),
      observations: { [environment.serverId]: observed },
    });
    this.commit(pending);
    await this.applyProjection(
      {
        environment,
        expected,
        patch,
        skills: state.settings.skills,
        plugins: state.settings.plugins,
        skillLibrary: this.availableSkills(state.settings, environment.serverId),
        excludedPluginIds,
      },
      confirmedRemovals,
    );
  }

  private async applyProjection(
    verification: SettingsProjectionVerification,
    confirmedRemovals: readonly string[],
  ): Promise<void> {
    const { environment, patch, plugins, excludedPluginIds } = verification;
    if (this.projectionRevision !== this.state.revision) return;
    try {
      await environment.patch(patch, confirmedRemovals);
    } catch {
      this.recordStatus(environment.serverId, "patch_failed");
      return;
    }
    if (this.projectionRevision !== this.state.revision) return;
    if (plugins) {
      try {
        await environment.projectPlugins(plugins, excludedPluginIds);
      } catch {
        this.recordStatus(environment.serverId, "plugin_projection_failed");
        return;
      }
    }
    if (this.projectionRevision !== this.state.revision) return;
    if (verification.skillLibrary) {
      try {
        await environment.projectSkillCatalog(verification.skillLibrary);
      } catch {
        this.recordStatus(environment.serverId, "skill_projection_failed");
        return;
      }
    }
    await this.verifyProjection(verification);
  }

  private async verifyProjection({
    environment,
    expected,
    patch,
    skills,
    plugins,
    excludedPluginIds,
    skillLibrary,
  }: SettingsProjectionVerification): Promise<void> {
    let verified: InstallationSettings;
    let verifiedConfig: MutableDaemonConfig;
    let verifiedSkillsSettled = true;
    let verifiedPluginsSettled = true;
    let verifiedCatalogSettled = true;
    let verifiedProvidersSettled = true;
    try {
      verifiedConfig = await environment.read();
      verified = readInstallationSettings(verifiedConfig, this.installationInstructions);
      if (patch.installationProviderPolicy)
        verifiedProvidersSettled = installationProvidersSettled(
          patch.installationProviderPolicy.definitions,
          environment.serverId,
          verifiedConfig.providers,
          patch.installationProviderPolicy.excludedIds,
        );
      if (plugins)
        verifiedPluginsSettled = installationPluginsSettled(
          await environment.readPlugins(),
          plugins,
          excludedPluginIds,
        );
      if (skillLibrary)
        verifiedCatalogSettled = await environment.skillCatalogSettled(skillLibrary);
      if (skills)
        verifiedSkillsSettled =
          (await environment.previewSkills(skills.selection)).ops.length === 0;
    } catch {
      this.recordStatus(environment.serverId, "verification_failed");
      return;
    }
    this.recordStatus(
      environment.serverId,
      verifiedSkillsSettled &&
        verifiedCatalogSettled &&
        verifiedPluginsSettled &&
        verifiedProvidersSettled &&
        isDeepStrictEqual(verified, expected) &&
        verifiedConfig.appendSystemPrompt === patch.appendSystemPrompt &&
        isDeepStrictEqual(
          verifiedConfig.installationResourceBindings,
          patch.installationResourceBindings,
        )
        ? null
        : "verification_failed",
    );
  }

  private recordStatus(
    serverId: string,
    error: InstallationSettingsSnapshot["sources"][string]["error"],
  ): void {
    if (this.projectionRevision !== null && this.projectionRevision !== this.state.revision) return;
    const next = this.snapshot();
    const status = next.sources[serverId];
    status.error = error;
    status.pendingRevision = error === null ? null : next.revision;
    if (error === null) status.appliedRevision = next.revision;
    this.commit(next);
  }
}

function pruneResourceExclusions(settings: InstallationSettings) {
  const terminalIds = new Set(settings.terminalProfiles.map((profile) => profile.id));
  const providerIds = new Set(settings.metadataGeneration.providers.map((entry) => entry.provider));
  const pluginIds = new Set(settings.plugins?.map((plugin) => plugin.id));
  const definitionIds = new Set(settings.providerDefinitions?.map((provider) => provider.id));
  for (const exclusion of Object.values(settings.resourceExclusions)) {
    if (exclusion.providerIds)
      exclusion.providerIds = exclusion.providerIds.filter((id) => definitionIds.has(id));
    if (exclusion.pluginIds)
      exclusion.pluginIds = exclusion.pluginIds.filter((id) => pluginIds.has(id));
    exclusion.terminalProfileIds = exclusion.terminalProfileIds.filter((id) => terminalIds.has(id));
    exclusion.metadataProviderIds = exclusion.metadataProviderIds.filter((id) =>
      providerIds.has(id),
    );
  }
}

/** Preserve existing browser permission differences as explicit environment exceptions. */
function shareBrowserTools(candidates: Record<string, InstallationSettings>): void {
  const enabled = Object.values(candidates).some((candidate) => candidate.browserTools?.enabled);
  const excluded = Object.entries(candidates).filter(
    ([, candidate]) => !candidate.browserTools?.enabled,
  );
  for (const candidate of Object.values(candidates)) {
    candidate.browserTools = { enabled };
    if (!enabled) continue;
    for (const [serverId] of excluded) {
      candidate.resourceExclusions[serverId] = {
        ...(candidate.resourceExclusions[serverId] ?? {
          terminalProfileIds: [],
          metadataProviderIds: [],
        }),
        browserTools: true,
      };
    }
  }
}
