import {
  InstallationProviderPolicySchema,
  type InstallationProvider,
} from "@getpaseo/protocol/installation-provider";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import {
  InstallationSettingsFieldSchema,
  InstallationSettingsPatchSchema,
  installationProviderReference,
  localInstallationProvider,
  type InstallationSettings,
} from "@getpaseo/protocol/installation-settings";

export function sharedSettingsPatch(patch: MutableDaemonConfigPatch, local?: MutableDaemonConfig) {
  const entries = Object.entries(patch);
  const shared = entries.filter(([key]) => InstallationSettingsFieldSchema.safeParse(key).success);
  if (!shared.length) return null;
  if (shared.length !== entries.length)
    throw new Error("Save shared settings and environment credentials separately.");
  const settings = InstallationSettingsPatchSchema.parse(Object.fromEntries(shared));
  if (settings.metadataGeneration?.providers.length) {
    if (!local)
      throw new Error("Load the environment account bindings before selecting a metadata account.");
    settings.metadataGeneration.providers = settings.metadataGeneration.providers.map((entry) => ({
      ...entry,
      provider: installationProviderReference(entry.provider, local.providers),
    }));
  }
  return settings;
}

interface ProviderPolicyContext {
  settings: InstallationSettings | null | undefined;
  serverId: string | null;
}

const providerPolicyKeys = new Set<string>(InstallationProviderPolicySchema.keyof().options);

export function sharedProviderSettingsPatch(
  patch: MutableDaemonConfigPatch,
  context: ProviderPolicyContext,
) {
  const providers = Object.entries(patch.providers ?? {});
  if (
    !providers.some(([, provider]) =>
      Object.keys(provider).some((key) => providerPolicyKeys.has(key)),
    )
  )
    return null;
  if (
    Object.keys(patch).some((key) => key !== "providers") ||
    providers.some(([, provider]) =>
      Object.keys(provider).some((key) => !providerPolicyKeys.has(key)),
    )
  )
    throw new Error("Save shared provider policy and environment credentials separately.");
  const definitions = context.settings?.providerDefinitions;
  if (!definitions || !context.serverId)
    throw new Error("Load the shared provider catalog before saving.");
  const next = structuredClone(definitions);
  for (const [providerId, values] of providers) {
    const matches = next.filter(
      (definition) => definition.bindings[context.serverId!] === providerId,
    );
    if (matches.length !== 1)
      throw new Error(
        "Connect this account through the shared provider catalog before editing its policy.",
      );
    const definition = matches[0]!;
    const policy = InstallationProviderPolicySchema.parse(values);
    definition.policy = {
      ...definition.policy,
      ...policy,
      ...(policy.paseoTools
        ? { paseoTools: { ...definition.policy.paseoTools, ...policy.paseoTools } }
        : {}),
    };
  }
  return { providerDefinitions: next };
}

function withSharedProviderPolicy(
  config: MutableDaemonConfig,
  settings: InstallationSettings,
  serverId?: string,
) {
  if (!serverId || !settings.providerDefinitions) return config.providers;
  const providers = { ...config.providers };
  for (const definition of settings.providerDefinitions) {
    const id = definition.bindings[serverId];
    if (!id || !Object.hasOwn(providers, id)) continue;
    providers[id] = {
      ...Object.fromEntries(
        Object.entries(providers[id]).filter(([key]) => !providerPolicyKeys.has(key)),
      ),
      ...definition.policy,
    };
  }
  return providers;
}

export function withSharedSettings(
  config: MutableDaemonConfig,
  settings: InstallationSettings,
  serverId?: string,
): MutableDaemonConfig {
  return {
    ...config,
    providers: withSharedProviderPolicy(config, settings, serverId),
    browserTools: settings.browserTools
      ? { ...config.browserTools, ...settings.browserTools }
      : config.browserTools,
    skills: settings.skills ?? config.skills,
    mcp: { ...config.mcp, ...settings.mcp },
    appendSystemPrompt: settings.appendSystemPrompt,
    autoArchiveAfterMerge: settings.autoArchiveAfterMerge,
    enableTerminalAgentHooks: settings.enableTerminalAgentHooks,
    metadataGeneration: {
      providers: settings.metadataGeneration.providers.map((entry) => ({
        ...entry,
        provider: localInstallationProvider(entry.provider, config.providers) ?? entry.provider,
      })),
    },
    pluginsEnabled: settings.pluginsEnabled,
    terminalProfiles: settings.terminalProfiles,
  };
}

/** Enroll a catalog runtime without storing its command, environment or credentials globally. */
export function sharedCatalogProviderEnrollment(
  providerId: string,
  provider: MutableDaemonConfig["providers"][string],
  context: ProviderPolicyContext,
) {
  const definitions = context.settings?.providerDefinitions;
  const serverId = context.serverId;
  if (!definitions || !serverId)
    throw new Error("Load the shared provider catalog before installing a runtime.");
  if (provider.extends !== "acp" || provider.installationAccountId)
    throw new Error("Catalog enrollment requires an ACP runtime without an account identity.");
  const id = `catalog/acp/${providerId}`;
  const bound = definitions.filter((definition) => definition.bindings[serverId] === providerId);
  if (bound.length > 1) throw new Error("This runtime has conflicting shared bindings.");
  const existing = bound[0] ?? definitions.find((definition) => definition.id === id);
  assertCatalogProviderBinding(existing, providerId, serverId);
  const policy =
    existing?.policy ??
    InstallationProviderPolicySchema.parse(
      Object.fromEntries(Object.entries(provider).filter(([key]) => providerPolicyKeys.has(key))),
    );
  const definition = existing
    ? { ...existing, bindings: { ...existing.bindings, [serverId]: providerId } }
    : { id, providerType: providerId, bindings: { [serverId]: providerId }, policy };
  const providerDefinitions = existing
    ? definitions.map((entry) => (entry.id === existing.id ? definition : entry))
    : [...definitions, definition];
  const local = {
    ...Object.fromEntries(Object.entries(provider).filter(([key]) => !providerPolicyKeys.has(key))),
    ...policy,
    ...(context.settings?.resourceExclusions[serverId]?.providerIds?.includes(definition.id)
      ? { enabled: false }
      : {}),
  };
  return {
    settings: existing?.bindings[serverId] === providerId ? null : { providerDefinitions },
    patch: { providers: { [providerId]: local } } satisfies MutableDaemonConfigPatch,
  };
}

function assertCatalogProviderBinding(
  existing: InstallationProvider | undefined,
  providerId: string,
  serverId: string,
) {
  if (
    existing &&
    (existing.providerType !== providerId ||
      existing.accountId ||
      existing.accountSetup ||
      (existing.bindings[serverId] && existing.bindings[serverId] !== providerId))
  )
    throw new Error("This runtime already belongs to a different shared provider.");
}
