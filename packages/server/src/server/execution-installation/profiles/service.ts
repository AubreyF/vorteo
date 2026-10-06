import type {
  InstallationProfilesSnapshot,
  InstallationProfilesPatch,
  ProfileSharingStatus,
} from "@getpaseo/protocol/execution-installation";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  ProviderPreferencesSchema,
  SharedProviderPreferencesSchema,
  type MutableDaemonConfig,
  type MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import {
  importEnvironmentProfiles,
  projectEnvironmentProfiles,
  prepareEnvironmentProfiles,
  canonicalizeWorkerReferences,
  shareWorkerAccountBindings,
} from "./migration.js";
import { ProfileSharingConflict } from "./merge.js";
import { validateProviderPreferences } from "../../agent/provider-preferences/validation.js";
import type { SharedProviderPreferences } from "@getpaseo/protocol/messages";

const ProvidersSchema = z.record(z.string(), ProviderPreferencesSchema);

function assertRetainedWorkflow(
  state: ProfileSharingState,
  type: string,
  id: string,
  reference: string,
): void {
  if (state.providers[type]?.workflows.some((workflow) => workflow.id === id)) return;
  const field = `profiles.${type}.workflows.${id}`;
  throw new ProfileSharingConflict(
    [field],
    [{ field, sharedValue: `Retained by ${reference}`, environmentValue: "Deleted" }],
  );
}

function assertWorkerReference(
  state: ProfileSharingState,
  reference: string | undefined,
  owner: string,
): void {
  if (!reference) return;
  const parts = reference.split("/");
  if (parts.length !== 3 || parts[0] !== "shared-workflow") return;
  assertRetainedWorkflow(state, decodeURIComponent(parts[1]), decodeURIComponent(parts[2]), owner);
}

const SourceSchema = z.object({
  projection: SharedProviderPreferencesSchema.optional(),
  base: ProvidersSchema,
  workflowIds: z.record(z.string(), z.record(z.string(), z.string())),
  error: z.string().nullable(),
  conflicts: z.array(z.string()),
  conflictValues: z.array(
    z.object({ field: z.string(), sharedValue: z.string(), environmentValue: z.string() }),
  ),
  conflictRevision: z.number().int().nonnegative().nullable(),
  retainedWorkflows: z.record(z.string(), z.array(z.string())),
});
export const ProfileSharingStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().positive(),
  providers: ProvidersSchema,
  sources: z.record(z.string(), SourceSchema),
});
export type ProfileSharingState = z.infer<typeof ProfileSharingStateSchema>;

export interface ProfileEnvironment {
  serverId: string;
  kind: "host" | "container";
  read(): Promise<MutableDaemonConfig>;
  patch(patch: MutableDaemonConfigPatch): Promise<MutableDaemonConfig>;
}
export interface ProfileSharingJournal {
  read(): ProfileSharingState | null;
  write(state: ProfileSharingState): void;
  backup(
    configs: Record<
      string,
      Pick<MutableDaemonConfig, "agentProfiles" | "sharedProviderPreferences">
    >,
  ): void;
}

/** Runs independently of browser sessions. Journal the shared edit before touching a replica. */
export class InstallationProfiles {
  private state: ProfileSharingState | null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly journal: ProfileSharingJournal,
    private readonly environments: ProfileEnvironment[],
    private readonly installationId: string,
  ) {
    this.state = journal.read();
  }

  inspect(): ProfileSharingState | null {
    return structuredClone(this.state);
  }

  status(): ProfileSharingStatus | null {
    if (!this.state) return null;
    const sources: ProfileSharingStatus["sources"] = {};
    for (const [serverId, source] of Object.entries(this.state.sources)) {
      sources[serverId] = {
        error: source.error,
        conflicts: source.conflicts,
        conflictValues: source.conflictValues,
      };
    }
    return structuredClone({ version: this.state.version, revision: this.state.revision, sources });
  }

  synchronize(): Promise<void> {
    const operation = this.queue.then(() => this.reconcile());
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  resolve(input: {
    serverId: string;
    expectedRevision: number;
    choice: "shared" | "environment";
  }): Promise<void> {
    const operation = this.queue.then(() => this.resolveConflict(input));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  snapshot(): InstallationProfilesSnapshot | null {
    const status = this.status();
    if (
      !status ||
      !this.state ||
      Object.values(this.state.sources).some((source) => !source.projection)
    )
      return null;
    return { ...status, providers: structuredClone(this.state.providers) };
  }

  patch(input: InstallationProfilesPatch): Promise<InstallationProfilesSnapshot> {
    const operation = this.queue.then(() => this.patchCanonical(input));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private patchCanonical(input: InstallationProfilesPatch): InstallationProfilesSnapshot {
    const state = this.state;
    if (!this.snapshot() || !state || state.revision !== input.expectedRevision)
      throw new ProfileSharingConflict(["revision"]);
    const next = structuredClone(state);
    next.providers = ProvidersSchema.parse(input.providers);
    this.validateRetainedWorkflows(next);
    validateProviderPreferences({
      preferences: {
        version: 1,
        revision: next.revision,
        providers: next.providers,
        legacyProfiles: {},
      },
      providers: {},
      legacyProfiles: [],
    });
    if (!isDeepStrictEqual(state.providers, next.providers)) this.commit(next);
    const saved = this.snapshot();
    if (!saved) throw new Error("Missing installation profiles");
    return saved;
  }

  admission(serverId: string): SharedProviderPreferences {
    const state = this.state;
    const projection = state?.sources[serverId]?.projection;
    if (!state || !projection) throw new Error("Installation profile migration is incomplete");
    return {
      ...structuredClone(projection),
      revision: state.revision,
      providers: structuredClone(state.providers),
    };
  }

  private async resolveConflict(input: {
    serverId: string;
    expectedRevision: number;
    choice: "shared" | "environment";
  }): Promise<void> {
    if (!this.state || this.state.revision !== input.expectedRevision)
      throw new ProfileSharingConflict(["revision"]);
    if (input.choice === "environment")
      throw new ProfileSharingConflict([
        "Environment profiles are read-only projections. Edit installation profiles instead.",
      ]);
    await this.reconcile();
  }

  private validateRetainedWorkflows(state: ProfileSharingState): void {
    for (const source of Object.values(state.sources)) {
      const projection = source.projection;
      if (!projection) throw new ProfileSharingConflict(["migration"]);
      for (const [id, binding] of Object.entries(projection.legacyProfiles))
        assertRetainedWorkflow(
          state,
          binding.providerType,
          binding.workflowId,
          `legacy profile ${id}`,
        );
      for (const [type, aliases] of Object.entries(projection.workflowAliases ?? {})) {
        for (const [id, target] of Object.entries(aliases))
          assertRetainedWorkflow(state, type, target, `legacy workflow alias ${id}`);
      }
    }
    for (const [type, group] of Object.entries(state.providers)) {
      assertWorkerReference(state, group.defaults.workerProfileId, `${type} default worker`);
      for (const workflow of group.workflows)
        assertWorkerReference(state, workflow.workerProfileId, `worker for ${workflow.id}`);
    }
  }

  private commit(state: ProfileSharingState, canonicalChange = true): void {
    state.revision = (this.state?.revision ?? 0) + Number(canonicalChange);
    this.journal.write(state);
    this.state = state;
  }

  private async reconcile(): Promise<void> {
    const observations = await Promise.allSettled(
      this.environments.map((environment) => environment.read()),
    );
    const configs: Record<string, MutableDaemonConfig> = {};
    for (const [index, observation] of observations.entries()) {
      if (observation.status === "fulfilled")
        configs[this.environments[index].serverId] = observation.value;
    }
    if (!this.state) {
      if (Object.keys(configs).length !== this.environments.length)
        throw new Error("Connect every environment before importing shared profiles");
      const imports = this.environments.map(({ serverId }) => {
        const preferences = configs[serverId].sharedProviderPreferences;
        if (!preferences)
          throw new Error(
            "Update every daemon to shared provider preferences before importing profiles",
          );
        return {
          serverId,
          preferences: prepareEnvironmentProfiles(configs[serverId], serverId),
          providers: configs[serverId].providers,
        };
      });
      const imported = importEnvironmentProfiles(imports);
      const backups: Parameters<ProfileSharingJournal["backup"]>[0] = {};
      const sources: ProfileSharingState["sources"] = {};
      for (const { serverId, preferences } of imports) {
        backups[serverId] = {
          agentProfiles: configs[serverId].agentProfiles,
          sharedProviderPreferences: configs[serverId].sharedProviderPreferences,
        };
        const retainedWorkflows: Record<string, string[]> = {};
        for (const binding of Object.values(preferences.legacyProfiles)) {
          const id = imported.workflowIds[serverId][binding.providerType][binding.workflowId];
          retainedWorkflows[binding.providerType] ??= [];
          retainedWorkflows[binding.providerType].push(id);
        }
        sources[serverId] = {
          projection: projectEnvironmentProfiles({
            config: { ...configs[serverId], sharedProviderPreferences: preferences },
            providers: imported.providers,
            workflowIds: imported.workflowIds[serverId],
          }),
          base: preferences.providers,
          workflowIds: imported.workflowIds[serverId],
          error: null,
          conflicts: [],
          conflictValues: [],
          conflictRevision: null,
          retainedWorkflows,
        };
      }
      shareWorkerAccountBindings(
        imports.map(({ serverId }) => {
          const preferences = sources[serverId].projection;
          if (!preferences) throw new Error("Missing imported profile projection");
          return { preferences, providers: configs[serverId].providers };
        }),
      );
      validateProviderPreferences({
        preferences: { version: 1, revision: 1, providers: imported.providers, legacyProfiles: {} },
        providers: {},
        legacyProfiles: [],
      });
      this.journal.backup(backups);
      this.commit({ version: 1, revision: 1, providers: imported.providers, sources });
    }
    if (Object.values(this.state?.sources ?? {}).some((source) => !source.projection)) {
      this.upgradeLegacyJournal(configs);
    }
    for (const [index, observation] of observations.entries()) {
      await this.reconcileEnvironment(this.environments[index], observation);
    }
  }

  private upgradeLegacyJournal(configs: Record<string, MutableDaemonConfig>): void {
    if (!this.state) throw new Error("Missing profile journal");
    if (Object.keys(configs).length !== this.environments.length)
      throw new Error("Connect every environment before migrating installation profile authority");
    const next = structuredClone(this.state);
    const backups: Parameters<ProfileSharingJournal["backup"]>[0] = {};
    for (const { serverId } of this.environments) {
      const config = configs[serverId];
      const preferences = config.sharedProviderPreferences;
      if (!preferences)
        throw new Error("Update every daemon before migrating installation profiles");
      backups[serverId] = {
        agentProfiles: config.agentProfiles,
        sharedProviderPreferences: preferences,
      };
      const source = next.sources[serverId];
      if (!source) throw new Error("Installation environment identity changed");
      const remapped = structuredClone(preferences);
      remapped.providers = structuredClone(next.providers);
      for (const binding of Object.values(remapped.legacyProfiles))
        binding.workflowId =
          source.workflowIds[binding.providerType]?.[binding.workflowId] ?? binding.workflowId;
      const normalized = prepareEnvironmentProfiles(
        { ...config, sharedProviderPreferences: remapped },
        serverId,
      );
      source.projection = projectEnvironmentProfiles({
        config: { ...config, sharedProviderPreferences: normalized },
        providers: normalized.providers,
        workflowIds: source.workflowIds,
      });
      canonicalizeWorkerReferences(source.projection, config.providers);
      next.providers = source.projection.providers;
      for (const binding of Object.values(normalized.legacyProfiles)) {
        source.retainedWorkflows[binding.providerType] ??= [];
        if (!source.retainedWorkflows[binding.providerType].includes(binding.workflowId))
          source.retainedWorkflows[binding.providerType].push(binding.workflowId);
      }
    }
    shareWorkerAccountBindings(
      this.environments.map(({ serverId }) => {
        const preferences = next.sources[serverId].projection;
        if (!preferences) throw new Error("Missing upgraded profile projection");
        return { preferences, providers: configs[serverId].providers };
      }),
    );
    this.validateRetainedWorkflows(next);
    validateProviderPreferences({
      preferences: {
        version: 1,
        revision: next.revision,
        providers: next.providers,
        legacyProfiles: {},
      },
      providers: {},
      legacyProfiles: [],
    });
    this.journal.backup(backups);
    this.commit(next);
  }

  private async reconcileEnvironment(
    environment: ProfileEnvironment,
    observation: PromiseSettledResult<MutableDaemonConfig>,
  ): Promise<void> {
    const state = this.state;
    if (!state) throw new Error("Missing profile sharing journal");
    const next = structuredClone(state);
    const source = next.sources[environment.serverId];
    if (!source)
      throw new Error(
        "Profile sharing environment identity changed; review migration before joining it",
      );
    if (observation.status === "rejected") {
      source.error =
        "Environment is offline. New profile launches require the coordinator; this cache will refresh after reconnecting.";
      if (!isDeepStrictEqual(state, next)) this.commit(next, false);
      return;
    }
    const config = observation.value;
    const preferences = config.sharedProviderPreferences;
    if (!preferences) {
      source.error = "Update this daemon before synchronizing profiles.";
      if (!isDeepStrictEqual(state, next)) this.commit(next, false);
      return;
    }
    try {
      if (!source.projection) throw new Error("Installation profile migration is incomplete");
      source.error = null;
      source.conflicts = [];
      source.conflictValues = [];
      source.conflictRevision = null;
      const target = {
        ...structuredClone(source.projection),
        revision: preferences.revision,
        providers: structuredClone(state.providers),
      };
      target.installation = {
        installationId: this.installationId,
        environment: environment.kind,
        serverId: environment.serverId,
        revision: state.revision,
      };
      source.projection = structuredClone(target);
      if (!isDeepStrictEqual(state, next)) this.commit(next, false);
      if (isDeepStrictEqual(target, preferences)) return;
      const saved = await environment.patch({
        sharedProviderPreferences: target,
        expectedProviderPreferencesRevision: preferences.revision,
      });
      if (!saved.sharedProviderPreferences)
        throw new Error("Daemon did not retain shared profiles");
      const acknowledged = structuredClone(this.state);
      if (!acknowledged) throw new Error("Missing profile sharing journal");
      acknowledged.sources[environment.serverId].base = saved.sharedProviderPreferences.providers;
      this.commit(acknowledged, false);
    } catch (error) {
      const failed = structuredClone(this.state);
      if (!failed) throw error;
      const failedSource = failed.sources[environment.serverId];
      if (error instanceof ProfileSharingConflict) {
        failedSource.conflicts = error.fields;
        failedSource.conflictValues = error.values;
        failedSource.conflictRevision = preferences.revision;
        failedSource.error = error.message;
      } else {
        failedSource.error =
          "Profile cache refresh failed. Canonical profiles are retained; refresh will retry with the current daemon revision.";
      }
      if (!isDeepStrictEqual(this.state, failed)) this.commit(failed, false);
    }
  }
}
