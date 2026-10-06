import type {
  AgentProfile,
  MutableDaemonConfig,
  SharedProviderPreferences,
} from "@getpaseo/protocol/messages";
import {
  isSharedWorkflowProfile,
  sharedWorkflowProfileId,
  materializeSharedProfiles,
  materializeLegacyProfiles,
  resolveProviderType,
} from "@getpaseo/protocol/provider-preferences";
import type { AgentSessionConfig } from "../agent-sdk-types.js";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";
import {
  DEFAULT_QUOTA_RESERVE_POLICY,
  parseQuotaReservePolicy,
} from "@getpaseo/protocol/quota-reserve";

export class ProfileLaunchError extends Error {
  constructor(
    readonly profileId: string,
    message: string,
  ) {
    super(message);
    this.name = "ProfileLaunchError";
  }
}

function resolveWorkerProfile(profile: AgentProfile, profiles: readonly AgentProfile[]) {
  const workerId = profile.workerProfileId?.trim();
  const worker = workerId ? profiles.find((entry) => entry.id === workerId) : undefined;
  if (workerId && !worker) {
    throw new ProfileLaunchError(workerId, "Worker profile not found.");
  }
  if (worker && (worker.id === profile.id || worker.workerProfileId?.trim())) {
    throw new ProfileLaunchError(worker.id, "A worker profile cannot supervise another team.");
  }
  if (worker && !worker.model?.trim()) {
    throw new ProfileLaunchError(worker.id, "Select an explicit model for the worker profile.");
  }
  return worker;
}

function applySharedSelection(
  profile: AgentProfile,
  config: AgentSessionConfig,
  preferences: SharedProviderPreferences | undefined,
): void {
  if (profile.provider !== config.provider)
    throw new ProfileLaunchError(profile.id, "The selected workflow belongs to another account.");
  // Frozen worker snapshots resolve without mutable preferences and cannot be overridden.
  if (preferences && !preferences.installation) {
    profile.model = config.model ?? profile.model;
    profile.thinkingOptionId = config.thinkingOptionId ?? profile.thinkingOptionId;
  }
}

function resolveProfileSelection(
  config: AgentSessionConfig,
  profiles: readonly AgentProfile[],
  settings?: MutableDaemonConfig,
) {
  const profileId = config.profileId ?? "";
  const shared = isSharedWorkflowProfile(profileId);
  const preferences = settings?.sharedProviderPreferences;
  const candidates = legacyProfileCandidates(profiles, settings);
  let provenance = {};
  let resolvedProfileId = config.profileId;
  if (settings && preferences) {
    const providerIds = [
      ...new Set([
        config.provider,
        ...Object.keys(settings.providers),
        ...Object.keys(preferences.providers),
      ]),
    ];
    candidates.push(
      ...materializeSharedProfiles({ preferences, providers: settings.providers, providerIds }),
    );
    const binding = preferences.legacyProfiles[profileId];
    const requestedWorkflowId = decodeURIComponent(profileId.split("/")[2] ?? "");
    const providerType = resolveProviderType(config.provider, settings.providers);
    const workflowId =
      preferences.workflowAliases?.[providerType]?.[requestedWorkflowId] ?? requestedWorkflowId;
    if (shared) {
      const selectedProvider = decodeURIComponent(profileId.split("/")[1]);
      resolvedProfileId = sharedWorkflowProfileId(selectedProvider, workflowId);
    }

    if (shared || binding) {
      provenance = {
        configurationRevision: preferences.revision,
        providerType:
          binding?.providerType ?? resolveProviderType(config.provider, settings.providers),
        workflowId: binding?.workflowId ?? workflowId,
      };
    }
  }
  const found = candidates.find((entry) => entry.id === resolvedProfileId);
  if (!found) throw new ProfileLaunchError(profileId, "Selected profile not found.");
  const profile = structuredClone(found);
  if (shared) applySharedSelection(profile, config, preferences);

  return { profile, candidates, provenance, shared };
}

function legacyProfileCandidates(
  profiles: readonly AgentProfile[],
  settings?: MutableDaemonConfig,
): AgentProfile[] {
  const preferences = settings?.sharedProviderPreferences;
  const legacy = preferences ? materializeLegacyProfiles(preferences, settings?.providers) : [];
  if (preferences?.installation) return legacy;
  const legacyIds = new Set(legacy.map((profile) => profile.id));
  return [...legacy, ...profiles.filter((profile) => !legacyIds.has(profile.id))];
}

/** Resolve only explicit launches. Resumes already contain their frozen instructions. */
function resolveProfileConfiguration(
  config: AgentSessionConfig,
  profiles: readonly AgentProfile[],
  sharedConfig?: MutableDaemonConfig,
  environment?: ExecutionEnvironmentKind,
): AgentSessionConfig {
  if (!config.profileId) return config;
  const selection = resolveProfileSelection(config, profiles, sharedConfig);
  const { profile, candidates, provenance, shared } = selection;
  assertProfileEnvironment(profile, environment);
  const worker = resolveWorkerProfile(profile, candidates);
  if (worker) assertProfileEnvironment(worker, environment);
  const instructions = [profile.instructions?.trim(), config.systemPrompt?.trim()];
  if (worker) {
    instructions.push(
      `You supervise local workers using Vorteo's create_agent tool. Use profileId ${JSON.stringify(worker.id)} ` +
        `and provider ${JSON.stringify(`${worker.provider}/${worker.model}`)}. ` +
        `Assign bounded tasks with explicit file ownership. Use separate worktrees for concurrent edits. ` +
        `Review each worker's diff and run relevant tests before accepting it. ` +
        `At most ${profile.maxWorkers ?? 2} managed workers may run at once. ` +
        `Worker instructions and tools do not grant permission beyond the user's task. ` +
        `On quota exhaustion stop, preserve progress, and ask the user to select another profile.`,
    );
  }
  const { profileId: _, ...base } = config;
  return {
    ...base,
    provider: profile.provider,
    modeId: shared
      ? profile.modeId?.trim() || undefined
      : (config.modeId ?? (profile.modeId?.trim() || undefined)),
    model: profile.model?.trim() || config.model,
    thinkingOptionId: profile.thinkingOptionId?.trim() || undefined,
    featureValues: profile.featureValues ?? {},
    systemPrompt: instructions.filter(Boolean).join("\n\n") || undefined,
    profileLaunch: {
      profile,
      ...(worker ? { worker: structuredClone(worker) } : {}),
      ...provenance,
    },
  };
}

export function resolveProfileLaunch(
  config: AgentSessionConfig,
  profiles: readonly AgentProfile[],
  nowMs = Date.now(),
  sharedConfig?: MutableDaemonConfig,
  environment?: ExecutionEnvironmentKind,
): AgentSessionConfig {
  environment ??= sharedConfig?.sharedProviderPreferences?.installation?.environment;
  const { quotaReservePolicy: requested, ...launchConfig } = config;
  if (!requested) return resolveProfileConfiguration(config, profiles, sharedConfig, environment);
  if (config.quotaReserve) throw new Error("Use task controls to change a frozen reserve policy.");
  const resolved = resolveProfileConfiguration(launchConfig, profiles, sharedConfig, environment);
  const policy =
    requested.kind === "profile"
      ? (resolved.profileLaunch?.profile.quotaReservePolicy ?? DEFAULT_QUOTA_RESERVE_POLICY)
      : requested;
  return {
    ...resolved,
    quotaReserve: {
      policy: parseQuotaReservePolicy(policy),
      state: { kind: "ready", revision: 0, changedAt: new Date(nowMs).toISOString() },
    },
  };
}

function assertProfileEnvironment(
  profile: AgentProfile,
  environment?: ExecutionEnvironmentKind,
): void {
  const exclusions = profile.excludedEnvironments ?? [];
  if (!exclusions.length) return;
  if (!environment)
    throw new ProfileLaunchError(
      profile.id,
      "Cannot verify the execution environment for this profile.",
    );
  if (exclusions.includes(environment))
    throw new ProfileLaunchError(
      profile.id,
      `This profile is excluded from the ${environment} environment.`,
    );
}
