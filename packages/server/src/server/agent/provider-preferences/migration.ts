import { isDeepStrictEqual } from "node:util";
import type { AgentProfile, SharedProviderPreferences } from "@getpaseo/protocol/messages";
import {
  resolveProviderType,
  type ProviderAncestry,
} from "@getpaseo/protocol/provider-preferences";

interface MergedProfile {
  profileId: string;
  workflowId: string;
}

export interface ProviderPreferencesMigrationReport {
  version: 1;
  sourceProfiles: number;
  workflows: number;
  mergedProfiles: MergedProfile[];
  preservedWorkerReferences: string[];
}

/** Unknown profile fields participate in equality so future behavior cannot be silently merged. */
function workflowBehavior(profile: AgentProfile) {
  const { id: _id, provider: _provider, isDefault: _isDefault, ...behavior } = profile;
  return behavior;
}

export function planProviderPreferencesMigration(input: {
  profiles: readonly AgentProfile[];
  providers: Readonly<Record<string, ProviderAncestry>>;
}): { preferences: SharedProviderPreferences; report: ProviderPreferencesMigrationReport } {
  const preferences: SharedProviderPreferences = {
    version: 1,
    revision: 1,
    providers: {},
    legacyProfiles: {},
  };
  const report: ProviderPreferencesMigrationReport = {
    version: 1,
    sourceProfiles: input.profiles.length,
    workflows: 0,
    mergedProfiles: [],
    preservedWorkerReferences: [],
  };
  for (const profile of input.profiles) {
    if (profile.isDefault) preferences.defaultProvider = profile.provider;
    const providerType = resolveProviderType(profile.provider, input.providers);
    let group = preferences.providers[providerType];
    if (!group) {
      group = {
        defaults: {},
        preferredModels: [],
        preferredThinkingOptions: [],
        workflows: [],
        defaultWorkflowId: null,
      };
      preferences.providers[providerType] = group;
    }
    const behavior = workflowBehavior(profile);
    let workflow = group.workflows.find((entry) =>
      isDeepStrictEqual(workflowBehavior(entry), behavior),
    );
    if (!workflow) {
      const { isDefault: _isDefault, ...source } = profile;
      workflow = { ...structuredClone(source), provider: providerType };
      group.workflows.push(workflow);
      report.workflows += 1;
    } else {
      report.mergedProfiles.push({ profileId: profile.id, workflowId: workflow.id });
    }
    if (profile.model && !group.preferredModels.includes(profile.model))
      group.preferredModels.push(profile.model);
    if (
      profile.thinkingOptionId &&
      !group.preferredThinkingOptions.includes(profile.thinkingOptionId)
    )
      group.preferredThinkingOptions.push(profile.thinkingOptionId);
    if (group.defaultWorkflowId === null || profile.isDefault) {
      group.defaultWorkflowId = workflow.id;
      group.defaults = {
        model: profile.model,
        thinkingOptionId: profile.thinkingOptionId,
        modeId: profile.modeId,
      };
    }
    // Legacy bindings retain exact account and reasoning choices for legacy launches and workers.
    preferences.legacyProfiles[profile.id] = {
      provider: profile.provider,
      providerType,
      workflowId: workflow.id,
      model: profile.model ?? null,
      thinkingOptionId: profile.thinkingOptionId ?? null,
    };
    if (profile.workerProfileId) report.preservedWorkerReferences.push(profile.workerProfileId);
  }
  for (const group of Object.values(preferences.providers)) {
    for (const workflow of group.workflows) {
      if (workflow.model === group.defaults.model) delete workflow.model;
      else if (!workflow.model) workflow.model = "";
      if (workflow.modeId === group.defaults.modeId) delete workflow.modeId;
      else if (!workflow.modeId) workflow.modeId = "";
    }
  }
  return { preferences, report };
}
