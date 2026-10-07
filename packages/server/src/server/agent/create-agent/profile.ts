import type {
  AgentProfile,
  MutableDaemonConfig,
  SharedProviderPreferences,
} from "@getpaseo/protocol/messages";
import {
  isSharedWorkflowProfile,
  canonicalProfileId,
  sharedWorkflowProfileId,
  resolveSharedWorkflow,
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

function resolveWorkerProfile(
  profile: AgentProfile,
  profiles: readonly AgentProfile[],
  settings?: MutableDaemonConfig,
) {
  const workerId = profile.workerProfileId?.trim();
  if (!workerId) return undefined;
  let worker = profiles.find((entry) => entry.id === workerId);
  if (!worker && settings && isSharedWorkflowProfile(workerId)) {
    try {
      worker = resolveSharedReference(
        workerId,
        decodeURIComponent(workerId.split("/")[1]),
        settings,
      );
    } catch (error) {
      if (!(error instanceof ProfileLaunchError)) throw error;
      throw new ProfileLaunchError(workerId, "Worker profile not found.");
    }
  }
  if (!worker) {
    throw new ProfileLaunchError(workerId, "Worker profile not found.");
  }
  if (worker.id === profile.id || worker.workerProfileId?.trim()) {
    throw new ProfileLaunchError(worker.id, "A worker profile cannot supervise another team.");
  }
  if (!worker.model?.trim()) {
    throw new ProfileLaunchError(worker.id, "Select an explicit model for the worker profile.");
  }
  const snapshot = structuredClone(worker);
  if (profile.id.startsWith("shared-profile/") && settings?.sharedProviderPreferences) {
    snapshot.id = canonicalProfileId(
      snapshot.id,
      settings.sharedProviderPreferences,
      settings.providers,
    );
    profile.workerProfileId = snapshot.id;
  }
  return snapshot;
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
    const binding = preferences.legacyProfiles[profileId];
    const requestedWorkflowId = decodeURIComponent(profileId.split("/")[2] ?? "");
    const canonical = canonicalProfileId(profileId, preferences, settings.providers);
    const workflowId = decodeURIComponent(canonical.split("/")[2] ?? requestedWorkflowId);
    if (shared) {
      const profile = resolveSharedReference(profileId, config.provider, settings);
      candidates.push(profile);
      resolvedProfileId = profile.id;
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

function resolveSharedReference(
  reference: string,
  provider: string,
  settings: MutableDaemonConfig,
): AgentProfile {
  const parts = reference.split("/");
  if (parts.length !== 3) throw new ProfileLaunchError(reference, "Invalid profile reference.");
  const referenceProvider = decodeURIComponent(parts[1]);
  const providerType = resolveProviderType(provider, settings.providers);
  // Canonical references name the provider type. Old references remain bound to their account.
  const canonical = parts[0] === "shared-profile";
  const expectedProvider = canonical ? providerType : provider;
  if (referenceProvider !== expectedProvider)
    throw new ProfileLaunchError(reference, "The selected workflow belongs to another account.");
  const preferences = settings.sharedProviderPreferences;
  const profile =
    preferences &&
    resolveSharedWorkflow({
      preferences,
      providers: settings.providers,
      provider,
      workflowId: decodeURIComponent(parts[2]),
      accountBound: !canonical,
    });
  if (!profile) throw new ProfileLaunchError(reference, "Selected profile not found.");
  if (!canonical) {
    const workflowId = decodeURIComponent(profile.id.split("/")[2]);
    profile.id = sharedWorkflowProfileId(referenceProvider, workflowId);
  }
  return profile;
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
  const worker = resolveWorkerProfile(profile, candidates, sharedConfig);
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
