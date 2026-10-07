import type { MutableDaemonConfig, AgentProfile } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  materializeSharedProfiles,
  resolveProviderType,
  sharedWorkflowProfileId,
  type ProviderAncestry,
} from "@getpaseo/protocol/provider-preferences";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";

interface WorkerChoice {
  id: string;
  value: string;
  label: string;
  description?: string;
}

interface WorkerChoiceInput {
  profiles: readonly AgentProfile[];
  entries: readonly ProviderSnapshotEntry[];
  providers: Readonly<Record<string, ProviderAncestry>>;
  supervisor: { id: string; provider: string };
  selectedWorkerId: string;
  originalWorkerId?: string;
  accountId: string | null;
  environment?: ExecutionEnvironmentKind;
}

export function workerChoices(input: WorkerChoiceInput) {
  const family = resolveProviderType(input.supervisor.provider, input.providers);
  const selectedWorkerId = localWorkerId(input);
  const selected = input.profiles.find((profile) => profile.id === selectedWorkerId);
  const accountId =
    input.accountId ?? selected?.provider ?? (input.selectedWorkerId ? "unavailable" : "");
  const eligible = input.profiles.filter((profile) => {
    if (!profile.model?.trim() || profile.workerProfileId) return false;
    if (input.environment && profile.excludedEnvironments?.includes(input.environment))
      return false;
    const sameFamily = resolveProviderType(profile.provider, input.providers) === family;
    const ownAccountView =
      profile.id === sharedWorkflowProfileId(profile.provider, input.supervisor.id);
    if (profile.id === input.supervisor.id || (sameFamily && ownAccountView)) return false;
    const entry = input.entries.find((candidate) => candidate.provider === profile.provider);
    if (!entry?.enabled || entry.status !== "ready") return false;
    return (
      entry.models?.some((model) => model.id === profile.model && model.isSelectable !== false) ===
      true
    );
  });
  const accounts = new Map<string, WorkerChoice>();
  for (const profile of eligible) {
    const entry = input.entries.find((candidate) => candidate.provider === profile.provider);
    const type = resolveProviderType(profile.provider, input.providers);
    const familyEntry = input.entries.find((candidate) => candidate.provider === type);
    accounts.set(profile.provider, {
      id: profile.provider,
      value: profile.provider,
      label: entry?.label ?? profile.provider,
      description: familyEntry?.label ?? type,
    });
  }
  const profiles: WorkerChoice[] = eligible
    .filter((profile) => profile.provider === accountId)
    .map((profile) => {
      const entry = input.entries.find((candidate) => candidate.provider === profile.provider);
      const model = entry?.models?.find((candidate) => candidate.id === profile.model);
      return {
        id: profile.id,
        value: profile.id,
        label: profile.name,
        description: model?.label ?? profile.model,
      };
    });
  const accountOptions: WorkerChoice[] = [
    { id: "none", value: "", label: "No workers" },
    ...accounts.values(),
  ];
  const selectedEntry = input.entries.find((entry) => entry.provider === accountId);
  const accountDisplay = accountOptions.find((option) => option.value === accountId) ?? {
    label:
      selectedEntry?.label ??
      (accountId === "unavailable" ? "Saved worker account unavailable" : accountId),
    description: "Saved worker account is unavailable",
  };
  const profileDisplay = profiles.find((option) => option.value === selectedWorkerId) ?? {
    label: selected?.name ?? "Saved worker profile unavailable",
    description: selected?.model ?? selectedWorkerId,
  };
  const unavailable =
    Boolean(input.selectedWorkerId) && !eligible.some((profile) => profile.id === selectedWorkerId);
  return {
    accountId,
    accountOptions,
    profiles,
    accountDisplay,
    profileDisplay,
    unavailable,
    selectedWorkerId,
  };
}

function localWorkerId(input: WorkerChoiceInput): string {
  // Installation references can differ from local account IDs. Display the runtime's
  // materialized binding until the user explicitly changes the saved worker.
  const supervisor = input.profiles.find(
    (profile) =>
      profile.id === input.supervisor.id ||
      profile.id === sharedWorkflowProfileId(input.supervisor.provider, input.supervisor.id),
  );
  return input.originalWorkerId && input.selectedWorkerId === input.originalWorkerId
    ? (supervisor?.workerProfileId ?? input.selectedWorkerId)
    : input.selectedWorkerId;
}

export function workerAccountProfiles(
  config: MutableDaemonConfig | null | undefined,
  entries: readonly ProviderSnapshotEntry[],
  profiles: readonly AgentProfile[],
  legacyProfiles: readonly AgentProfile[],
  selectedWorkerId: string,
): AgentProfile[] {
  const accountProfiles = config?.sharedProviderPreferences
    ? materializeSharedProfiles({
        preferences: config.sharedProviderPreferences,
        providers: config.providers,
        providerIds: entries.map((entry) => entry.provider),
      })
    : [...profiles];
  return [
    ...accountProfiles,
    ...legacyProfiles.filter(
      (entry) =>
        entry.id === selectedWorkerId &&
        !accountProfiles.some((candidate) => candidate.id === entry.id),
    ),
  ];
}
