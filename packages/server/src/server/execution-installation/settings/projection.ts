import { projectInstallationProviders } from "./providers.js";
import { installationResourceRevision } from "./resource-bindings.js";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { DEFAULT_TERMINAL_PROFILES } from "@getpaseo/protocol/terminal-profiles";
import {
  InstallationSettingsSchema,
  installationProviderReference,
  localInstallationProvider,
  type InstallationSettings,
} from "@getpaseo/protocol/installation-settings";
import { composeEnvironmentSystemPrompt, readUserSystemPrompt } from "./instructions.js";

export class InstallationAccountBindingUnavailable extends Error {
  constructor(readonly reference: string) {
    super("The shared account needs a unique binding in this environment.");
    this.name = "InstallationAccountBindingUnavailable";
  }
}

/** Pick known policy values only. Never journal the daemon config or extension fields. */
export function readInstallationSettings(
  config: MutableDaemonConfig,
  installationInstructions: readonly string[] = [],
): InstallationSettings {
  return InstallationSettingsSchema.parse({
    browserTools: { enabled: config.browserTools.enabled },
    skills: { selection: config.skills?.selection ?? { mode: "all" } },
    mcp: { injectIntoAgents: config.mcp.injectIntoAgents },
    appendSystemPrompt: readUserSystemPrompt(config.appendSystemPrompt, installationInstructions),
    autoArchiveAfterMerge: config.autoArchiveAfterMerge,
    enableTerminalAgentHooks: config.enableTerminalAgentHooks,
    metadataGeneration: {
      providers: config.metadataGeneration.providers.map(
        ({ provider, model, thinkingOptionId }) => ({
          provider: installationProviderReference(provider, config.providers),
          ...(model === undefined ? {} : { model }),
          ...(thinkingOptionId === undefined ? {} : { thinkingOptionId }),
        }),
      ),
    },
    pluginsEnabled: config.pluginsEnabled ?? false,
    terminalProfiles: (config.terminalProfiles ?? DEFAULT_TERMINAL_PROFILES).map(
      ({ id, name, command, args, icon }) => {
        const profile: InstallationSettings["terminalProfiles"][number] = { id, name, command };
        if (args !== undefined) profile.args = args;
        if (icon !== undefined) profile.icon = icon;
        return profile;
      },
    ),
    resourceExclusions: {},
  });
}

export function projectInstallationSettings(
  settings: InstallationSettings,
  serverId: string,
  localConfig: MutableDaemonConfig,
  installationInstructions = "",
) {
  const exclusions = settings.resourceExclusions[serverId];
  let effectiveProviders = localConfig.providers;
  if (settings.providerDefinitions) {
    try {
      effectiveProviders = projectInstallationProviders(
        settings.providerDefinitions,
        serverId,
        localConfig.providers,
        exclusions?.providerIds,
      );
    } catch {
      throw new InstallationAccountBindingUnavailable("provider-definition");
    }
  }
  const saved = localConfig.installationResourceBindings;
  const localTerminals = [
    ...(localConfig.terminalProfiles ?? DEFAULT_TERMINAL_PROFILES),
    ...(saved?.terminalProfiles ?? []),
  ];
  const localProviders = [
    ...localConfig.metadataGeneration.providers,
    ...(saved?.metadataProviders ?? []),
  ];
  const retainedTerminals = settings.terminalProfiles.flatMap((profile) => {
    if (!exclusions?.terminalProfileIds.includes(profile.id)) return [];
    const local = localTerminals.find((entry) => entry.id === profile.id);
    return local ? [local] : [];
  });
  const metadataProviders = settings.metadataGeneration.providers.map((provider) => {
    const definition = settings.providerDefinitions?.find((entry) => {
      const reference = entry.accountId
        ? `installation-account/${entry.accountId}`
        : entry.bindings[serverId];
      return reference === provider.provider;
    });
    const providerExcluded =
      definition !== undefined &&
      (definition.policy.enabled === false || exclusions?.providerIds?.includes(definition.id));
    const excluded =
      providerExcluded || exclusions?.metadataProviderIds.includes(provider.provider);
    const availableId = localInstallationProvider(provider.provider, effectiveProviders);
    // An excluded account can be disabled or physically removed. Its stable catalog
    // binding still identifies the private metadata options to retain for recovery.
    const localId = excluded ? (definition?.bindings[serverId] ?? availableId) : availableId;
    return { provider, localId, excluded };
  });
  const retainedProviders = metadataProviders.flatMap(({ provider, localId, excluded }) => {
    if (!excluded) return [];
    const choices = localProviders.filter((entry) => entry.provider === localId);
    const local =
      choices.find(
        (entry) =>
          entry.model === provider.model && entry.thinkingOptionId === provider.thinkingOptionId,
      ) ?? choices[0];
    return local ? [local] : [];
  });
  const availableProfiles = settings.terminalProfiles.filter(
    (profile) => !exclusions?.terminalProfileIds.includes(profile.id),
  );
  const terminalProfiles = availableProfiles.map((profile) => {
    const local = localTerminals.find((entry) => entry.id === profile.id);
    const projected = Object.assign({}, local, profile);
    if (profile.args === undefined) delete projected.args;
    if (profile.icon === undefined) delete projected.icon;
    return projected;
  });
  const availableProviders = metadataProviders.filter((entry) => !entry.excluded);
  const providers = availableProviders.map(({ provider, localId }) => {
    if (localId === null) throw new InstallationAccountBindingUnavailable(provider.provider);
    const localChoices = localProviders.filter((entry) => entry.provider === localId);
    const local =
      localChoices.find(
        (entry) =>
          entry.model === provider.model && entry.thinkingOptionId === provider.thinkingOptionId,
      ) ?? localChoices[0];
    const projected = Object.assign({}, local, provider, { provider: localId });
    if (provider.model === undefined) delete projected.model;
    if (provider.thinkingOptionId === undefined) delete projected.thinkingOptionId;
    return projected;
  });
  return structuredClone({
    ...(settings.browserTools
      ? { browserTools: { enabled: settings.browserTools.enabled && !exclusions?.browserTools } }
      : {}),
    ...(settings.providerDefinitions
      ? {
          installationProviderPolicy: {
            definitions: settings.providerDefinitions,
            excludedIds: exclusions?.providerIds ?? [],
          },
        }
      : {}),
    ...(settings.skills ? { skills: settings.skills } : {}),
    expectedInstallationResourceRevision: installationResourceRevision(localConfig),
    installationResourceBindings: {
      terminalProfiles: retainedTerminals,
      metadataProviders: retainedProviders,
    },
    mcp: settings.mcp,
    appendSystemPrompt: composeEnvironmentSystemPrompt(
      settings.appendSystemPrompt,
      installationInstructions,
    ),
    autoArchiveAfterMerge: settings.autoArchiveAfterMerge,
    enableTerminalAgentHooks: settings.enableTerminalAgentHooks,
    metadataGeneration: Object.assign({}, localConfig.metadataGeneration, { providers }),
    pluginsEnabled: settings.pluginsEnabled,
    terminalProfiles,
  });
}
