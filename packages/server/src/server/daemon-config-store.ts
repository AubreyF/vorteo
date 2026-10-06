import {
  changesInstallationProviders,
  assertInstallationProviderProjection,
} from "./execution-installation/settings/provider-admission.js";
import {
  projectInstallationProviders,
  persistInstallationProviders,
} from "./execution-installation/settings/providers.js";
import {
  assertInstallationSettingsProjection,
  changesInstallationSettings,
  createInstallationSettingsReader,
  InstallationSettingsAdmissionError,
  type InstallationSettingsReader,
  type InstallationSettingsAdmission,
} from "./execution-installation/settings/admission.js";
import { installationResourceRevision } from "./execution-installation/settings/resource-bindings.js";
import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import {
  MutableDaemonConfigSchema,
  MutableDaemonConfigPatchSchema,
} from "@getpaseo/protocol/messages";
import type { AgentSkillSelection } from "@getpaseo/protocol/messages";
import { parseQuotaReservePolicy } from "@getpaseo/protocol/quota-reserve";
import {
  assertProviderConfigRemoval,
  defaultProviderAccountHomes,
} from "../services/provider-login/removal.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { validateProviderPreferences } from "./agent/provider-preferences/validation.js";
import { planProviderPreferencesMigration } from "./agent/provider-preferences/migration.js";

export type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

type MutableDaemonConfig = import("@getpaseo/protocol/messages").MutableDaemonConfig;
type MutableDaemonConfigPatch = import("@getpaseo/protocol/messages").MutableDaemonConfigPatch;
type ProviderOverride = import("./agent/provider-launch-config.js").ProviderOverride;

interface SupportedMutableConfigPatch {
  replaceProviders?: MutableDaemonConfig["providers"];
  relay?: { enabled?: boolean };
  mcp?: { injectIntoAgents?: boolean };
  browserTools?: { enabled?: boolean };
  providers?: MutableDaemonConfig["providers"];
  removeProviders?: string[];
  metadataGeneration?: MutableDaemonConfig["metadataGeneration"];
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: MutableDaemonConfig["terminalProfiles"];
  installationResourceBindings?: MutableDaemonConfig["installationResourceBindings"];
  agentProfiles?: MutableDaemonConfig["agentProfiles"];
  sharedProviderPreferences?: MutableDaemonConfig["sharedProviderPreferences"];
  skills?: MutableDaemonConfig["skills"];
  pluginsEnabled?: boolean;
  plugins?: MutableDaemonConfig["plugins"];
}

function replacementProviderPreferences(patch: SupportedMutableConfigPatch) {
  return patch.sharedProviderPreferences === undefined
    ? {}
    : { sharedProviderPreferences: patch.sharedProviderPreferences };
}

export class ProviderPreferencesConflictError extends Error {
  constructor(readonly currentRevision: number | null) {
    super("Provider preferences changed on another device. Reload the editor before saving.");
    this.name = "ProviderPreferencesConflictError";
  }
}

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

export interface DaemonConfigChangeDetails {
  removedProviders: readonly string[];
}

export interface DaemonConfigReloadResult {
  appliedPaths: string[];
  restartRequiredPaths: string[];
  overrideControlledPaths: string[];
}

export interface DaemonConfigReloadSource {
  resolve(persisted: PersistedConfig): {
    mutable: MutableDaemonConfig;
    overrideControlledPaths: readonly string[];
  };
}

type ConfigListener = (config: MutableDaemonConfig, details: DaemonConfigChangeDetails) => void;
type ConfigApplyRollback = () => void;
type ConfigApplyListener = (
  config: MutableDaemonConfig,
  previous: MutableDaemonConfig,
  details: DaemonConfigChangeDetails,
) => ConfigApplyRollback;
type FieldChangeHandler = (value: unknown) => void;

interface AppliedFieldChange {
  handler: FieldChangeHandler;
  previousValue: unknown;
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "daemon-config-store" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown>,
): T {
  const next: Record<string, unknown> = { ...current };

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) {
      continue;
    }
    const currentValue = next[key];
    if (isRecord(currentValue) && isRecord(patchValue)) {
      next[key] = deepMerge(currentValue, patchValue);
      continue;
    }
    next[key] = patchValue;
  }

  return next as T;
}

function omitProvidersFromConfig<T extends { providers?: Record<string, unknown> }>(
  config: T,
  providers: readonly string[],
): T {
  if (providers.length === 0 || !config.providers) {
    return config;
  }

  let changed = false;
  const nextProviders = { ...config.providers };
  for (const provider of providers) {
    if (provider in nextProviders) {
      delete nextProviders[provider];
      changed = true;
    }
  }

  return changed ? ({ ...config, providers: nextProviders } as T) : config;
}

function omitMetadataGenerationProvidersFromConfig<
  T extends { metadataGeneration?: { providers?: Array<{ provider?: unknown }> } },
>(config: T, providers: readonly string[]): T {
  if (providers.length === 0 || !config.metadataGeneration?.providers) {
    return config;
  }

  const removedProviderIds = new Set(providers);
  const nextProviders = config.metadataGeneration.providers.filter((entry) => {
    return typeof entry.provider !== "string" || !removedProviderIds.has(entry.provider);
  });
  if (nextProviders.length === config.metadataGeneration.providers.length) {
    return config;
  }

  return {
    ...config,
    metadataGeneration: {
      ...config.metadataGeneration,
      providers: nextProviders,
    },
  } as T;
}

function omitProvidersFromOverrides(
  overrides: Record<string, ProviderOverride> | undefined,
  providers: readonly string[],
): Record<string, ProviderOverride> | undefined {
  if (!overrides) {
    return undefined;
  }

  const nextOverrides = { ...overrides };
  for (const provider of providers) {
    delete nextOverrides[provider];
  }

  return Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;
}

function getValueAtPath(config: MutableDaemonConfig, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), config);
}

function isEqualValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const RELOADABLE_PATHS = [
  "daemon.relay.enabled",
  "daemon.mcp.enabled",
  "daemon.mcp.injectIntoAgents",
  "daemon.browserTools.enabled",
  "daemon.hostnames",
  "daemon.cors.allowedOrigins",
  "daemon.trustedProxies",
  "daemon.git.maxProcessesPerSecond",
  "daemon.git.maxProcessConcurrency",
  "daemon.autoArchiveAfterMerge",
  "daemon.enableTerminalAgentHooks",
  "daemon.appendSystemPrompt",
  "daemon.terminalProfiles",
  "daemon.installationResourceBindings",
  "daemon.agentProfiles",
  "daemon.sharedProviderPreferences",
  "app.baseUrl",
  "agents.providers",
  "agents.catalogRefreshTimeoutMs",
  "agents.metadataGeneration",
  "agents.skills.selection",
  "pluginsEnabled",
] as const;

const PERSISTED_TO_MUTABLE_PATH = new Map<string, string>([
  ["daemon.relay.enabled", "relay.enabled"],
  ["daemon.mcp.enabled", "mcp.enabled"],
  ["daemon.mcp.injectIntoAgents", "mcp.injectIntoAgents"],
  ["daemon.browserTools.enabled", "browserTools.enabled"],
  ["daemon.hostnames", "hostnames"],
  ["daemon.cors.allowedOrigins", "cors.allowedOrigins"],
  ["daemon.trustedProxies", "trustedProxies"],
  ["daemon.git.maxProcessesPerSecond", "git.maxProcessesPerSecond"],
  ["daemon.git.maxProcessConcurrency", "git.maxProcessConcurrency"],
  ["daemon.autoArchiveAfterMerge", "autoArchiveAfterMerge"],
  ["daemon.enableTerminalAgentHooks", "enableTerminalAgentHooks"],
  ["daemon.appendSystemPrompt", "appendSystemPrompt"],
  ["daemon.terminalProfiles", "terminalProfiles"],
  ["daemon.installationResourceBindings", "installationResourceBindings"],
  ["daemon.agentProfiles", "agentProfiles"],
  ["daemon.sharedProviderPreferences", "sharedProviderPreferences"],
  ["app.baseUrl", "app.baseUrl"],
  ["agents.providers", "providers"],
  ["agents.catalogRefreshTimeoutMs", "catalogRefreshTimeoutMs"],
  ["agents.metadataGeneration", "metadataGeneration"],
  ["agents.skills.selection", "skills.selection"],
  ["pluginsEnabled", "pluginsEnabled"],
]);

function pathBelongsTo(path: string, owner: string): boolean {
  return path === owner || path.startsWith(`${owner}.`);
}

function diffPaths(previous: unknown, next: unknown, prefix = ""): string[] {
  if (isEqualValue(previous, next)) return [];
  if (!isRecord(previous) || !isRecord(next)) {
    if (isRecord(previous)) return leafPaths(previous, prefix);
    if (isRecord(next)) return leafPaths(next, prefix);
    return prefix ? [prefix] : [];
  }

  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return Array.from(keys).flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return diffPaths(previous[key], next[key], path);
  });
}

function leafPaths(record: Record<string, unknown>, prefix: string): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return isRecord(value) ? leafPaths(value, path) : [path];
  });
}

function compactOwnedPaths(paths: readonly string[], owners: readonly string[]): string[] {
  const compacted = new Set<string>();
  for (const path of paths) {
    const owner = owners.find((candidate) => pathBelongsTo(path, candidate));
    compacted.add(owner ?? path);
  }
  return Array.from(compacted).sort();
}

function pickSupportedPatchFields(patch: MutableDaemonConfigPatch): SupportedMutableConfigPatch {
  return {
    ...(patch.relay?.enabled !== undefined ? { relay: { enabled: patch.relay.enabled } } : {}),
    ...(patch.mcp?.injectIntoAgents !== undefined
      ? { mcp: { injectIntoAgents: patch.mcp.injectIntoAgents } }
      : {}),
    ...(patch.browserTools?.enabled !== undefined
      ? { browserTools: { enabled: patch.browserTools.enabled } }
      : {}),
    ...(patch.providers !== undefined ? { providers: patch.providers } : {}),
    skills: patch.skills,
    ...(patch.removeProviders !== undefined ? { removeProviders: patch.removeProviders } : {}),
    ...(patch.metadataGeneration?.providers !== undefined
      ? { metadataGeneration: { providers: patch.metadataGeneration.providers } }
      : {}),
    ...(patch.autoArchiveAfterMerge !== undefined
      ? { autoArchiveAfterMerge: patch.autoArchiveAfterMerge }
      : {}),
    ...(patch.enableTerminalAgentHooks !== undefined
      ? { enableTerminalAgentHooks: patch.enableTerminalAgentHooks }
      : {}),
    ...(patch.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: patch.appendSystemPrompt }
      : {}),
    ...(patch.terminalProfiles !== undefined ? { terminalProfiles: patch.terminalProfiles } : {}),
    ...(patch.installationResourceBindings !== undefined
      ? { installationResourceBindings: patch.installationResourceBindings }
      : {}),
    ...(patch.agentProfiles !== undefined ? { agentProfiles: patch.agentProfiles } : {}),
    ...(patch.sharedProviderPreferences !== undefined
      ? { sharedProviderPreferences: patch.sharedProviderPreferences }
      : {}),
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
  };
}

export function applyMutableProviderConfigToOverrides(
  baseOverrides: Record<string, ProviderOverride> | undefined,
  mutableProviders: MutableDaemonConfig["providers"] | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!baseOverrides && (!mutableProviders || Object.keys(mutableProviders).length === 0)) {
    return undefined;
  }

  const nextOverrides: Record<string, ProviderOverride> = { ...baseOverrides };
  for (const [providerId, providerConfig] of Object.entries(mutableProviders ?? {})) {
    const previousOverride = nextOverrides[providerId];
    const parsedOverride = ProviderOverrideSchema.strip().parse(providerConfig);
    nextOverrides[providerId] = {
      ...previousOverride,
      ...parsedOverride,
      ...(parsedOverride.paseoTools
        ? {
            paseoTools: {
              ...previousOverride?.paseoTools,
              ...parsedOverride.paseoTools,
            },
          }
        : {}),
    };
  }

  return nextOverrides;
}

export class DaemonConfigStore {
  private current: MutableDaemonConfig;
  private registeredProviderDefaults: MutableDaemonConfig["providers"] = {};
  private installationSettingsReader: InstallationSettingsReader | undefined;
  private readonly paseoHome: string;
  private readonly logger: LoggerLike | undefined;
  private readonly changeListeners = new Set<ConfigListener>();
  private readonly applyListeners = new Set<ConfigApplyListener>();
  private readonly fieldChangeHandlers = new Map<string, Set<FieldChangeHandler>>();
  private readonly relayEnabledMutable: boolean;
  private readonly reloadSource: DaemonConfigReloadSource | undefined;
  private readonly startupPersisted: PersistedConfig;
  private lastKnownPersisted: PersistedConfig;

  constructor(
    paseoHome: string,
    initial: MutableDaemonConfig,
    logger?: LoggerLike,
    options: {
      installationSettingsReader?: InstallationSettingsReader;
      relayEnabledMutable?: boolean;
      reloadSource?: DaemonConfigReloadSource;
      startupPersisted?: PersistedConfig;
    } = {},
  ) {
    this.paseoHome = paseoHome;
    this.installationSettingsReader = options.installationSettingsReader;
    this.logger = getLogger(logger);
    this.current = MutableDaemonConfigSchema.parse({
      ...initial,
      relay: initial.relay ?? { enabled: true },
    });
    this.relayEnabledMutable = options.relayEnabledMutable ?? true;
    this.reloadSource = options.reloadSource;
    this.startupPersisted = options.startupPersisted ?? loadPersistedConfig(paseoHome, this.logger);
    this.lastKnownPersisted = this.startupPersisted;
  }

  public registerProviderDefaults(providerIds: readonly string[]): void {
    const defaults = Object.fromEntries(
      providerIds.filter((id) => !Object.hasOwn(this.current.providers, id)).map((id) => [id, {}]),
    );
    this.registeredProviderDefaults = { ...this.registeredProviderDefaults, ...defaults };
    this.current = { ...this.current, providers: { ...defaults, ...this.current.providers } };
  }

  public get(): MutableDaemonConfig {
    return this.current;
  }

  public patch(partial: MutableDaemonConfigPatch): MutableDaemonConfig {
    return this.applyPatch(partial);
  }

  public async createProviderAccountBinding(
    providerId: string,
    provider: MutableDaemonConfig["providers"][string],
  ): Promise<MutableDaemonConfig> {
    const admission = await this.readInstallationSettingsAuthority();
    if (!admission) return this.patch({ providers: { [providerId]: provider } });
    const definitions = admission.settings.providerDefinitions?.filter(
      (definition) => definition.bindings[admission.serverId] === providerId,
    );
    if (!definitions || definitions.length !== 1 || definitions[0].accountId)
      throw new InstallationSettingsAdmissionError(
        "Create this account through the shared provider catalog first.",
      );
    if (
      admission.settings.resourceExclusions[admission.serverId]?.providerIds?.includes(
        definitions[0].id,
      )
    )
      throw new InstallationSettingsAdmissionError(
        "This account is excluded from this environment.",
      );
    const projected = projectInstallationProviders(
      definitions,
      admission.serverId,
      { [providerId]: provider },
      admission.settings.resourceExclusions[admission.serverId]?.providerIds ?? [],
    );
    return this.applyPatch({ providers: projected }, admission);
  }

  public async patchFromClient(partial: MutableDaemonConfigPatch): Promise<MutableDaemonConfig> {
    const parsed = MutableDaemonConfigPatchSchema.parse(partial);
    const before = this.current;
    const binding = before.sharedProviderPreferences?.installation;
    if (binding && parsed.plugins !== undefined && !isEqualValue(parsed.plugins, before.plugins))
      throw new InstallationSettingsAdmissionError(
        "Use the shared plugin controls and environment binding operations to change plugins.",
      );
    if (
      !binding ||
      (!changesInstallationSettings(before, parsed) &&
        !changesInstallationProviders(before, parsed))
    )
      return this.patch(parsed);
    const admission = await this.readInstallationSettingsAuthority();
    if (this.current !== before)
      throw new InstallationSettingsAdmissionError(
        "Daemon settings changed while verifying installation authority. Read them again before retrying.",
      );
    return this.applyPatch(parsed, admission ?? undefined);
  }

  public async readInstallationSettingsAuthority(): Promise<InstallationSettingsAdmission | null> {
    const before = this.current;
    const binding = before.sharedProviderPreferences?.installation;
    if (!binding) return null;
    this.installationSettingsReader ??= createInstallationSettingsReader(
      process.env.VORTEO_INSTALLATION_CLIENT_CONFIG,
    );
    const admission = await this.installationSettingsReader.read(binding);
    if (this.current !== before)
      throw new InstallationSettingsAdmissionError(
        "Daemon settings changed while verifying installation authority. Read them again before retrying.",
      );
    if (
      admission.installationId !== binding.installationId ||
      admission.serverId !== binding.serverId ||
      admission.environment !== binding.environment
    )
      throw new InstallationSettingsAdmissionError(
        "Settings authority returned a different installation or environment.",
      );
    return admission;
  }

  private applyPatch(
    partial: MutableDaemonConfigPatch,
    admission?: InstallationSettingsAdmission,
  ): MutableDaemonConfig {
    const parsed = MutableDaemonConfigPatchSchema.parse(partial);
    if (
      parsed.installationResourceBindings !== undefined &&
      parsed.expectedInstallationResourceRevision !== installationResourceRevision(this.current)
    ) {
      throw new Error(
        "Environment resource bindings changed. Read them again before projecting settings.",
      );
    }
    assertInstallationProviderProjection(this.current, parsed, admission);
    assertInstallationSettingsProjection({ current: this.current, patch: parsed, admission });
    this.validateInstallationProjection(parsed);
    if (parsed.sharedProviderPreferences) {
      const revision = this.current.sharedProviderPreferences?.revision ?? null;
      if (parsed.expectedProviderPreferencesRevision !== revision) {
        throw new ProviderPreferencesConflictError(revision);
      }
      // COMPAT(workflowAliases): added in v0.9.0-beta.2.vorton.39, remove after 2027-04-03 once clients preserve aliases.
      if (
        parsed.sharedProviderPreferences.workflowAliases === undefined &&
        this.current.sharedProviderPreferences?.workflowAliases !== undefined
      ) {
        parsed.sharedProviderPreferences.workflowAliases = structuredClone(
          this.current.sharedProviderPreferences.workflowAliases,
        );
      }
      validateProviderPreferences({
        preferences: parsed.sharedProviderPreferences,
        providers: { ...this.current.providers, ...parsed.providers },
        legacyProfiles: parsed.agentProfiles ?? this.current.agentProfiles ?? [],
      });
      parsed.sharedProviderPreferences.revision = (revision ?? 0) + 1;
    }
    if (
      parsed.expectedAgentProfiles &&
      !isEqualValue(parsed.expectedAgentProfiles, this.current.agentProfiles ?? [])
    ) {
      throw new Error("Profiles changed on another device. Reload the editor before saving.");
    }
    // Old clients replace the list without knowing launch-only fields. Preserve
    // those fields when omitted; newer editors send empty strings to clear them.
    if (parsed.agentProfiles) {
      parsed.agentProfiles = parsed.agentProfiles.map((profile) => {
        if (profile.quotaReservePolicy) parseQuotaReservePolicy(profile.quotaReservePolicy);
        const previous = this.current.agentProfiles?.find((entry) => entry.id === profile.id);
        return {
          // COMPAT(quotaReserveProfile): added in v0.7.2, remove after 2027-03-10 once editors preserve reserve defaults.
          ...(previous?.quotaReservePolicy !== undefined
            ? { quotaReservePolicy: previous.quotaReservePolicy }
            : {}),
          ...(previous?.instructions !== undefined ? { instructions: previous.instructions } : {}),
          ...(previous?.workerProfileId !== undefined
            ? { workerProfileId: previous.workerProfileId }
            : {}),
          ...(previous?.maxWorkers !== undefined ? { maxWorkers: previous.maxWorkers } : {}),
          ...(previous?.isDefault !== undefined ? { isDefault: previous.isDefault } : {}),
          ...profile,
        };
      });
    }
    this.preserveLegacyProfileEdits(parsed);
    const parsedPatch = pickSupportedPatchFields(parsed);
    if (parsed.installationProviderPolicy) {
      const policy = parsed.installationProviderPolicy;
      const serverId = this.current.sharedProviderPreferences!.installation!.serverId;
      parsedPatch.replaceProviders = projectInstallationProviders(
        policy.definitions,
        serverId,
        this.current.providers,
        policy.excludedIds,
      );
    }
    return this.applySupportedPatch(parsedPatch);
  }

  private validateInstallationProjection(patch: MutableDaemonConfigPatch): void {
    const installation = this.current.sharedProviderPreferences?.installation;
    if (installation) {
      if (patch.agentProfiles && !isEqualValue(patch.agentProfiles, this.current.agentProfiles))
        throw new Error(
          "Installation profiles must be edited through the installation coordinator.",
        );
      const target = patch.sharedProviderPreferences;
      if (target) {
        const binding = target.installation;
        if (
          !binding ||
          binding.installationId !== installation.installationId ||
          binding.serverId !== installation.serverId ||
          binding.environment !== installation.environment ||
          binding.revision < installation.revision
        )
          throw new Error("Installation profile cache identity cannot be replaced or downgraded.");
        if (
          binding.revision === installation.revision &&
          !isEqualValue(target.providers, this.current.sharedProviderPreferences?.providers)
        )
          throw new Error(
            "Installation profiles must be edited through the installation coordinator.",
          );
      }
    }
  }

  private preserveLegacyProfileEdits(patch: MutableDaemonConfigPatch): void {
    if (!patch.agentProfiles || patch.sharedProviderPreferences) return;
    const shared = this.current.sharedProviderPreferences;
    if (!shared) return;
    const next = structuredClone(shared);
    let changed = false;
    for (const profile of patch.agentProfiles) {
      const previous = this.current.agentProfiles?.find((entry) => entry.id === profile.id);
      if (!next.legacyProfiles[profile.id] || isEqualValue(profile, previous)) continue;
      // COMPAT(sharedProviderPreferences): added in v0.7.2, remove after 2027-04-01 once legacy editors are retired.
      // An older editor cannot knowingly change every account's workflow. Keep its edited record account-specific.
      delete next.legacyProfiles[profile.id];
      changed = true;
    }
    if (changed) patch.sharedProviderPreferences = { ...next, revision: shared.revision + 1 };
  }

  public initializeProviderPreferences(): MutableDaemonConfig {
    if (this.current.sharedProviderPreferences) return this.current;
    const plan = planProviderPreferencesMigration({
      profiles: this.current.agentProfiles ?? [],
      providers: this.current.providers,
    });
    const directory = join(this.paseoHome, "backups", "provider-preferences-v1");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const receipt = {
      persistedConfig: loadPersistedConfig(this.paseoHome, this.logger),
      profiles: this.current.agentProfiles ?? [],
      report: plan.report,
      proposed: plan.preferences,
    };
    // Write a private recovery receipt before touching configuration. A failed save can retry.
    writeFileSync(join(directory, `${randomUUID()}.json`), JSON.stringify(receipt, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    return this.patch({
      expectedProviderPreferencesRevision: null,
      sharedProviderPreferences: plan.preferences,
    });
  }

  public setAgentSkillSelection(selection: AgentSkillSelection): Promise<MutableDaemonConfig> {
    return this.patchFromClient({ skills: { selection } });
  }

  private applySupportedPatch(parsedPatch: SupportedMutableConfigPatch): MutableDaemonConfig {
    if (parsedPatch.relay?.enabled !== undefined && !this.relayEnabledMutable) {
      throw new Error(
        "Relay is controlled by a daemon launch override. Remove PASEO_RELAY_ENABLED or the relay CLI flag before changing it here.",
      );
    }
    const { removeProviders = [], ...configPatch } = parsedPatch;
    const removedProviders = Array.from(new Set(removeProviders));
    const installationOwned = Boolean(this.current.sharedProviderPreferences?.installation);
    if (
      installationOwned &&
      removedProviders.length > 0 &&
      configPatch.metadataGeneration === undefined
    )
      configPatch.metadataGeneration = this.current.metadataGeneration;
    assertProviderConfigRemoval({
      paseoHome: this.paseoHome,
      providers: this.current.providers,
      removeProviders: removedProviders,
      ...defaultProviderAccountHomes(),
    });
    const merged = deepMerge(this.current, configPatch);
    delete merged.replaceProviders;
    if (parsedPatch.replaceProviders) merged.providers = parsedPatch.replaceProviders;
    if (parsedPatch.skills?.selection !== undefined) {
      merged.skills = { selection: parsedPatch.skills.selection };
    }
    if (parsedPatch.plugins !== undefined) merged.plugins = parsedPatch.plugins;
    Object.assign(merged, replacementProviderPreferences(parsedPatch));
    const next = MutableDaemonConfigSchema.parse(
      installationOwned
        ? omitProvidersFromConfig(merged, removedProviders)
        : omitMetadataGenerationProvidersFromConfig(
            omitProvidersFromConfig(merged, removedProviders),
            removedProviders,
          ),
    );

    const configChanged = !isEqualValue(this.current, next);

    if (!configChanged && removedProviders.length === 0) {
      return this.current;
    }

    const { previous: persistedBeforePatch, knownNext } = this.persistConfig(
      configPatch,
      removedProviders,
    );
    if (!configChanged) {
      this.lastKnownPersisted = knownNext;
      return this.current;
    }

    try {
      this.applyReplacement(next, { removedProviders });
      this.lastKnownPersisted = knownNext;
    } catch (error) {
      savePersistedConfig(this.paseoHome, persistedBeforePatch, this.logger);
      throw error;
    }

    return this.current;
  }

  public reload(): DaemonConfigReloadResult {
    if (!this.reloadSource) {
      throw new Error("Daemon config reload is unavailable for this daemon instance");
    }

    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const resolved = this.reloadSource.resolve(persisted);
    // Plugin source changes require the plugin lifecycle operation or a daemon
    // restart. The global switch is independently reloadable.
    const desired = MutableDaemonConfigSchema.parse({
      ...resolved.mutable,
      providers: { ...this.registeredProviderDefaults, ...resolved.mutable.providers },
      plugins: this.current.plugins,
      ...(this.current.sharedProviderPreferences?.installation
        ? {
            agentProfiles: this.current.agentProfiles,
            sharedProviderPreferences: this.current.sharedProviderPreferences,
          }
        : {}),
    });
    assertInstallationProviderProjection(this.current, {
      ...desired,
      removeProviders: Object.keys(this.current.providers).filter((id) => !desired.providers[id]),
    });
    assertInstallationSettingsProjection({ current: this.current, patch: desired });
    const changedSinceLastApply = diffPaths(this.lastKnownPersisted, persisted);
    const overrideControlledPaths = compactOwnedPaths(
      changedSinceLastApply.filter((path) =>
        resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner)),
      ),
      resolved.overrideControlledPaths,
    );
    const appliedPaths = RELOADABLE_PATHS.filter((persistedPath) => {
      if (resolved.overrideControlledPaths.some((owner) => pathBelongsTo(persistedPath, owner))) {
        return false;
      }
      const mutablePath = PERSISTED_TO_MUTABLE_PATH.get(persistedPath);
      return (
        mutablePath !== undefined &&
        !isEqualValue(
          getValueAtPath(this.current, mutablePath),
          getValueAtPath(desired, mutablePath),
        )
      );
    });
    const restartRequiredPaths = compactOwnedPaths(
      diffPaths(this.startupPersisted, persisted).filter((path) => {
        if (path === "$schema" || path === "version") return false;
        if (RELOADABLE_PATHS.some((owner) => pathBelongsTo(path, owner))) return false;
        return !resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner));
      }),
      [],
    );

    const removedProviders = Object.keys(this.current.providers).filter(
      (provider) => !(provider in desired.providers),
    );
    this.applyReplacement(desired, { removedProviders });
    this.lastKnownPersisted = persisted;

    return {
      appliedPaths: [...appliedPaths].sort(),
      restartRequiredPaths,
      overrideControlledPaths,
    };
  }

  private applyReplacement(
    next: MutableDaemonConfig,
    changeDetails: DaemonConfigChangeDetails,
  ): void {
    const changedFieldPaths = Array.from(this.fieldChangeHandlers.keys()).filter((path) => {
      return !isEqualValue(getValueAtPath(this.current, path), getValueAtPath(next, path));
    });
    if (isEqualValue(this.current, next) && changeDetails.removedProviders.length === 0) return;

    const previous = this.current;
    const appliedFieldChanges: AppliedFieldChange[] = [];
    const applyRollbacks: ConfigApplyRollback[] = [];
    this.current = next;
    try {
      for (const path of changedFieldPaths) {
        const handlers = this.fieldChangeHandlers.get(path);
        if (!handlers) {
          continue;
        }
        const value = getValueAtPath(next, path);
        const previousValue = getValueAtPath(previous, path);
        for (const handler of handlers) {
          appliedFieldChanges.push({ handler, previousValue });
          handler(value);
        }
      }
      for (const listener of this.applyListeners) {
        applyRollbacks.push(listener(next, previous, changeDetails));
      }
    } catch (error) {
      this.current = previous;
      const rollbackErrors: unknown[] = [];
      for (const rollback of applyRollbacks.toReversed()) {
        try {
          rollback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const change of appliedFieldChanges.toReversed()) {
        try {
          change.handler(change.previousValue);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        const rollbackFailure = new Error(
          "Daemon config apply failed and one or more live owners could not roll back",
          { cause: error },
        );
        Object.assign(rollbackFailure, { rollbackErrors });
        throw rollbackFailure;
      }
      throw error;
    }

    for (const listener of this.changeListeners) {
      try {
        listener(next, changeDetails);
      } catch (error) {
        this.logger?.info({ error }, "Daemon config change notification failed");
      }
    }
  }

  public onFieldChange(path: string, handler: FieldChangeHandler): () => void {
    const handlers = this.fieldChangeHandlers.get(path) ?? new Set<FieldChangeHandler>();
    handlers.add(handler);
    this.fieldChangeHandlers.set(path, handlers);

    return () => {
      const currentHandlers = this.fieldChangeHandlers.get(path);
      if (!currentHandlers) {
        return;
      }
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) {
        this.fieldChangeHandlers.delete(path);
      }
    };
  }

  public onChange(listener: ConfigListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  public onApply(listener: ConfigApplyListener): () => void {
    // A live owner must either throw before changing its state or return a
    // rollback that restores the previous config. Notifications belong in
    // onChange so they run only after every live owner commits.
    this.applyListeners.add(listener);
    return () => {
      this.applyListeners.delete(listener);
    };
  }

  private persistConfig(
    patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
    removeProviders: readonly string[],
  ): { previous: PersistedConfig; knownNext: PersistedConfig } {
    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const merge = (source: PersistedConfig) =>
      mergeMutablePatchIntoPersistedConfig({
        persisted: source,
        patch,
        removeProviders,
        persistRelayEnabled: this.relayEnabledMutable,
      });
    const nextPersisted = merge(persisted);
    const knownNext = merge(this.lastKnownPersisted);
    savePersistedConfig(this.paseoHome, nextPersisted, this.logger);
    return { previous: persisted, knownNext };
  }
}

function mergeMutablePatchIntoPersistedConfig(params: {
  persisted: PersistedConfig;
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">;
  removeProviders: readonly string[];
  persistRelayEnabled: boolean;
}): PersistedConfig {
  const { persisted, patch, removeProviders, persistRelayEnabled } = params;
  const daemon = mergeMutableDaemonPatch(persisted.daemon, patch, persistRelayEnabled);
  const agents = mergeMutableAgentPatch(persisted.agents, patch, removeProviders);
  return {
    ...persisted,
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
    ...(daemon ? { daemon } : { daemon: undefined }),
    ...(agents ? { agents } : { agents: undefined }),
  } as PersistedConfig;
}

function mergeMutableAgentPatch(
  persistedAgents: PersistedConfig["agents"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  removeProviders: readonly string[],
): PersistedConfig["agents"] {
  if (
    patch.providers === undefined &&
    patch.replaceProviders === undefined &&
    patch.metadataGeneration === undefined &&
    patch.skills === undefined &&
    removeProviders.length === 0
  ) {
    return persistedAgents;
  }

  const next = { ...persistedAgents } as Record<string, unknown>;
  const persistedProviderOverrides = omitProvidersFromOverrides(
    persistedAgents?.providers as Record<string, ProviderOverride> | undefined,
    removeProviders,
  );
  const providerOverrides =
    patch.replaceProviders === undefined
      ? applyMutableProviderConfigToOverrides(persistedProviderOverrides, patch.providers)
      : persistInstallationProviders(persistedProviderOverrides, patch.replaceProviders);
  if (providerOverrides) next["providers"] = providerOverrides;
  else delete next["providers"];

  if (patch.metadataGeneration?.providers !== undefined) {
    next["metadataGeneration"] = { providers: patch.metadataGeneration.providers };
  } else if (removeProviders.length > 0 && persistedAgents?.metadataGeneration?.providers) {
    const removed = new Set(removeProviders);
    next["metadataGeneration"] = {
      providers: persistedAgents.metadataGeneration.providers.filter(
        (entry) => !removed.has(entry.provider),
      ),
    };
  }

  if (patch.skills?.selection !== undefined) {
    next["skills"] = { selection: patch.skills.selection };
  }

  return Object.keys(next).length > 0 ? (next as PersistedConfig["agents"]) : undefined;
}

function mergeMutableDaemonPatch(
  persistedDaemon: PersistedConfig["daemon"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  persistRelayEnabled: boolean,
): PersistedConfig["daemon"] {
  const next = { ...persistedDaemon } as NonNullable<PersistedConfig["daemon"]>;
  if (persistRelayEnabled && patch.relay?.enabled !== undefined) {
    next.relay = { ...next.relay, enabled: patch.relay.enabled };
  }
  if (patch.mcp?.injectIntoAgents !== undefined) {
    next.mcp = { ...next.mcp, injectIntoAgents: patch.mcp.injectIntoAgents };
  }
  if (patch.browserTools?.enabled !== undefined) {
    next.browserTools = { ...next.browserTools, enabled: patch.browserTools.enabled };
  }
  if (patch.autoArchiveAfterMerge !== undefined) {
    next.autoArchiveAfterMerge = patch.autoArchiveAfterMerge;
  }
  if (patch.enableTerminalAgentHooks !== undefined) {
    next.enableTerminalAgentHooks = patch.enableTerminalAgentHooks;
  }
  if (patch.appendSystemPrompt !== undefined) next.appendSystemPrompt = patch.appendSystemPrompt;
  if (patch.terminalProfiles !== undefined) next.terminalProfiles = patch.terminalProfiles;
  if (patch.installationResourceBindings !== undefined)
    next.installationResourceBindings = patch.installationResourceBindings;
  if (patch.agentProfiles !== undefined) next.agentProfiles = patch.agentProfiles;
  if (patch.sharedProviderPreferences !== undefined)
    next.sharedProviderPreferences = patch.sharedProviderPreferences;
  return Object.keys(next).length > 0 ? next : undefined;
}
