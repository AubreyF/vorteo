import { resolveProviderType, sharedProfileId } from "@getpaseo/protocol/provider-preferences";
import { installationProviderReference } from "@getpaseo/protocol/installation-settings";
import type { ProviderOverrides } from "@getpaseo/protocol/provider-config";
import type { AgentProfileValue } from "../internal/profile-form-model";
import type { AgentProfile, ProviderPreferences } from "@getpaseo/protocol/messages";

/** Moving delegation out of defaults must not change any existing profile's team. */
export function replaceProviderDefaults(
  group: ProviderPreferences,
  defaults: ProviderPreferences["defaults"],
): ProviderPreferences {
  const {
    workerProfileId: _worker,
    workerAccount: _account,
    maxWorkers: _limit,
    ...launchDefaults
  } = defaults;
  const inheritedWorker = {
    ...(group.defaults.workerAccount !== undefined
      ? { workerAccount: group.defaults.workerAccount }
      : {}),
    ...(group.defaults.workerProfileId !== undefined
      ? { workerProfileId: group.defaults.workerProfileId }
      : {}),
    ...(group.defaults.maxWorkers !== undefined ? { maxWorkers: group.defaults.maxWorkers } : {}),
  };
  return {
    ...group,
    defaults: launchDefaults,
    workflows: group.workflows.map((profile) => Object.assign({}, inheritedWorker, profile)),
  };
}

/** Keep inheritance for untouched defaults, while allowing an explicit skill-policy reset. */
export function editSharedProfile(
  group: ProviderPreferences,
  id: string,
  providerType: string,
  value: AgentProfileValue,
  providers: ProviderOverrides = {},
  installation = false,
): AgentProfile {
  const { thinkingOptionId: _thinkingOptionId, ...workflowValue } = value;
  const original = group.workflows.find((item) => item.id === id);
  const workflow: AgentProfile = {
    ...original,
    ...workflowValue,
    skillPolicy: value.skillPolicy,
    workerAccount: value.workerAccount,
    id,
    provider: providerType,
  };
  const workerParts = value.workerProfileId?.split("/");
  const savedWorker = original?.workerProfileId ?? group.defaults.workerProfileId;
  if (
    value.workerProfileId !== savedWorker &&
    workerParts?.length === 3 &&
    workerParts[0] === "shared-workflow"
  ) {
    const account = decodeURIComponent(workerParts[1]);
    if (providers[account]) {
      const type = resolveProviderType(account, providers);
      workflow.workerProfileId = sharedProfileId(type, decodeURIComponent(workerParts[2]));
      workflow.workerAccount = installation
        ? installationProviderReference(account, providers)
        : account;
    }
  }
  for (const key of [
    "instructions",
    "skillPolicy",
    "workerProfileId",
    "workerAccount",
    "maxWorkers",
    "featureValues",
    "quotaReservePolicy",
  ] as const) {
    if (
      original?.[key] === undefined &&
      JSON.stringify(workflow[key]) === JSON.stringify(group.defaults[key])
    )
      delete workflow[key];
  }
  if (workflow.model === group.defaults.model) delete workflow.model;
  if (workflow.modeId === group.defaults.modeId) delete workflow.modeId;
  return workflow;
}
