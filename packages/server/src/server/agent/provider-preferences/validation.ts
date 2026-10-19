import type {
  AgentProfile,
  MutableDaemonConfig,
  SharedProviderPreferences,
} from "@getpaseo/protocol/messages";
import {
  materializeLegacyProfiles,
  sharedProfileDefinitions,
  canonicalProfileId,
  resolveProviderType,
} from "@getpaseo/protocol/provider-preferences";

export class ProviderPreferencesValidationError extends Error {
  constructor(
    readonly reference: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderPreferencesValidationError";
  }
}

export function validateProviderPreferences(input: {
  preferences: SharedProviderPreferences;
  providers: MutableDaemonConfig["providers"];
  legacyProfiles: readonly AgentProfile[];
}): void {
  const { preferences, providers } = input;
  for (const [providerType, group] of Object.entries(preferences.providers)) {
    const ids = new Set<string>();
    for (const workflow of group.workflows) {
      if (!workflow.id || ids.has(workflow.id))
        throw new ProviderPreferencesValidationError(
          workflow.id,
          "Workflow IDs must be unique within a provider.",
        );
      ids.add(workflow.id);
      if (
        workflow.provider !== providerType ||
        resolveProviderType(providerType, providers) !== providerType
      ) {
        throw new ProviderPreferencesValidationError(
          workflow.id,
          "Workflows must belong to a provider type, not an account.",
        );
      }
    }
    if (group.defaultWorkflowId !== null && !ids.has(group.defaultWorkflowId)) {
      throw new ProviderPreferencesValidationError(
        group.defaultWorkflowId,
        "The default workflow does not exist.",
      );
    }
  }
  for (const [id, binding] of Object.entries(preferences.legacyProfiles)) {
    const workflows = preferences.providers[binding.providerType]?.workflows ?? [];
    if (!workflows.some((workflow) => workflow.id === binding.workflowId)) {
      throw new ProviderPreferencesValidationError(
        id,
        "Keep workflows referenced by legacy profiles or workers.",
      );
    }
  }
  const sharedProfiles = sharedProfileDefinitions(preferences, providers);
  const profiles = [
    ...materializeLegacyProfiles(preferences, providers),
    ...input.legacyProfiles,
    ...sharedProfiles,
  ];
  for (const profile of sharedProfiles) {
    if (!profile.workerProfileId) continue;
    const workerId = canonicalProfileId(profile.workerProfileId, preferences, providers);
    const worker = profiles.find((candidate) => candidate.id === workerId);
    if (!worker || !worker.model || worker.workerProfileId) {
      throw new ProviderPreferencesValidationError(
        profile.workerProfileId,
        "Choose an existing worker with an explicit model and no worker team.",
      );
    }
  }
}
