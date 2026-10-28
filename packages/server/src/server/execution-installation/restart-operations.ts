import type { RestartJob, RestartRequest } from "@getpaseo/protocol/execution-installation";

type RestartTarget = RestartJob["target"];

/** The wire field that binds a restart request to one exact reviewed plan. */
export type RestartPlanField =
  | "supervisorPlanSha256"
  | "factoryRuntimePlanSha256"
  | "engineRestartPlanSha256"
  | "engineRecoveryPlanSha256"
  | "hostLauncherPlanSha256";

/**
 * When the coordinator may approve the operation without an owner: "never", only under
 * a standing owner decision, or under the general automatic policy. Omitted means never.
 */
export type RestartOperationAutomatic = "never" | "standing" | "allowed";

/** The plan and executor an operation needs; RestartExecutor satisfies this. */
export interface RestartOperationExecutor {
  supervisorPlan?(): string | undefined;
  restartSupervisor?(job: RestartJob): Promise<string>;
  factoryRuntimePlan?(): string | undefined;
  adoptFactoryRuntime?(job: RestartJob): Promise<string>;
  engineRecoveryPlan?(): string | undefined;
  recoverEngine?(job: RestartJob): Promise<string>;
  engineRestartPlan?(): string | undefined;
  restartEngine?(job: RestartJob): Promise<string>;
  hostLauncherPlan?(): string | undefined;
  updateHostLauncher?(job: RestartJob): Promise<string>;
}

export interface ReviewedRestartOperation {
  field: RestartPlanField;
  target: RestartTarget;
  /** Names the operation in refusals: "<label> requires a trusted Host request". */
  label: string;
  /** Names the plan in refusals: "<planLabel> is unavailable or changed". */
  planLabel: string;
  automatic?: RestartOperationAutomatic;
  /** Unavailable work cannot be drained. Requires exact immediate interruption approval. */
  immediateOnly?: boolean;
  /** A worker launch request may accompany it. Omitted means refused. */
  allowsWorkerLaunch?: boolean;
  /** Factory recovery-of may accompany it. Omitted means refused. */
  allowsFactoryRecovery?: boolean;
  /** Factory adoption owns recovery-of: it counts as requesting the operation and
   * must match when the target is shared. */
  ownsFactoryRecovery?: boolean;
  /** Refuse requireOwnerApproval as redundant, because the operation is always reviewed. */
  refusesRedundantOwnerApproval?: boolean;
  /** Overrides the shared-target refusal for this operation. */
  ownedTargetMessage?: string;
  reviewMessage: string;
  idleMessage: string;
  /** Capability key and query flag that a client negotiates to review the plan. */
  capability: string;
  /**
   * COMPAT projection for clients that did not negotiate `capability`: the plan
   * fields are removed and the job reads as an ordinary restart they can only cancel.
   * Absent for supervisor maintenance, which projects inside restartReply.
   */
  legacyReply?: { reason: string; detail: string; strips?: readonly (keyof RestartJob)[] };
  plan(executor: RestartOperationExecutor): string | undefined;
  run(executor: RestartOperationExecutor): ((job: RestartJob) => Promise<string>) | undefined;
}

/**
 * Reviewed plan-bound restart operations. Order is evaluation order and keeps every
 * refusal message unchanged: each entry refuses requests that also name an earlier
 * entry, so every pair of operations is refused once, by the later entry. Executors
 * stay with each operation; this table only selects and guards them.
 */
export const RESTART_OPERATIONS: readonly ReviewedRestartOperation[] = [
  {
    field: "supervisorPlanSha256",
    target: "container-daemon",
    label: "Supervisor maintenance",
    planLabel: "Supervisor maintenance plan",
    automatic: "allowed",
    allowsWorkerLaunch: true,
    allowsFactoryRecovery: true,
    reviewMessage: "Review this exact supervisor maintenance plan before approval",
    idleMessage: "Use Finish turns and restart for supervisor maintenance",
    plan: (executor) => executor.supervisorPlan?.(),
    run: (executor) => executor.restartSupervisor?.bind(executor),
    capability: "supervisorMaintenance",
  },
  {
    field: "factoryRuntimePlanSha256",
    target: "container-daemon",
    label: "Factory adoption",
    planLabel: "Factory adoption plan",
    automatic: "standing",
    allowsWorkerLaunch: true,
    allowsFactoryRecovery: true,
    ownsFactoryRecovery: true,
    refusesRedundantOwnerApproval: true,
    ownedTargetMessage:
      "A different restart scope or Factory adoption plan already owns this target",
    reviewMessage: "Review the exact Factory adoption plan before approval",
    idleMessage: "Use Finish turns and restart for Factory adoption",
    plan: (executor) => executor.factoryRuntimePlan?.(),
    run: (executor) => executor.adoptFactoryRuntime?.bind(executor),
    capability: "factoryRuntimeAdoption",
    // COMPAT(factoryRuntimeAdoption): v285, remove after legacy installation clients are retired.
    legacyReply: {
      reason: "Factory startup adoption. Reload Vorteo to review the exact operation.",
      detail: "Reload to review Factory adoption. Cancellation remains available.",
      strips: [
        "factoryRuntimeRecoveryRequired",
        "factoryRuntimeRecoveryOf",
        "factoryRuntimeRecoveredBy",
      ],
    },
  },
  {
    field: "engineRestartPlanSha256",
    target: "container-daemon",
    label: "Docker restart",
    planLabel: "Docker restart plan",
    // A Docker restart interrupts all of Dev and the gateway; only an owner or delegate approves it.
    automatic: "never",
    refusesRedundantOwnerApproval: true,
    reviewMessage: "Review this exact Docker restart plan before approval",
    idleMessage: "Use Finish turns and restart for a Docker restart",
    plan: (executor) => executor.engineRestartPlan?.(),
    run: (executor) => executor.restartEngine?.bind(executor),
    capability: "engineRestart",
    // COMPAT(engineRestart): added 2026-10-23; remove after 2027-04-23 once all supported
    // clients negotiate Docker restart review. Old clients see a Dev restart they can only cancel.
    legacyReply: {
      reason: "Docker restart for Dev. Reload Vorteo to review the exact operation.",
      detail: "Reload to review the Docker restart. Cancellation remains available.",
    },
  },
  {
    field: "engineRecoveryPlanSha256",
    target: "container-daemon",
    label: "Degraded Docker recovery",
    planLabel: "Degraded Docker recovery plan",
    automatic: "never",
    immediateOnly: true,
    refusesRedundantOwnerApproval: true,
    reviewMessage:
      "Review the exact degraded recovery plan and unknown work interruption before approval",
    idleMessage: "Degraded recovery requires explicit immediate interruption approval",
    plan: (executor) => executor.engineRecoveryPlan?.(),
    run: (executor) => executor.recoverEngine?.bind(executor),
    capability: "engineRecovery",
    // COMPAT(engineRecovery): added 2026-10-28; old clients can cancel but cannot approve.
    legacyReply: {
      reason: "Degraded Docker recovery. Reload to review unknown work interruption.",
      detail: "Reload to review this recovery. Cancellation remains available.",
    },
  },
  {
    field: "hostLauncherPlanSha256",
    target: "host",
    label: "Host launcher update",
    planLabel: "Host launcher update plan",
    // The Host launcher update restarts every Host agent; it is never automatic either.
    automatic: "never",
    refusesRedundantOwnerApproval: true,
    reviewMessage: "Review this exact Host launcher update before approval",
    idleMessage: "Use Finish turns and restart for the Host launcher update",
    plan: (executor) => executor.hostLauncherPlan?.(),
    run: (executor) => executor.updateHostLauncher?.bind(executor),
    capability: "hostLauncherUpdate",
    // COMPAT(hostLauncherUpdate): added 2026-10-23; remove after 2027-04-23 once all supported
    // clients negotiate Host launcher review. Old clients see a Host restart they can only cancel.
    legacyReply: {
      reason: "Host launcher update. Reload Vorteo to review the exact operation.",
      detail: "Reload to review the Host launcher update. Cancellation remains available.",
    },
  },
];

export const DEFAULT_SHARED_TARGET_MESSAGE =
  "A different restart scope or maintenance plan already owns this target";

export function operationFor(field: RestartPlanField): ReviewedRestartOperation {
  return RESTART_OPERATIONS.find((operation) => operation.field === field)!;
}

/** New operations default to never automatic. */
export function automaticPolicy(operation: ReviewedRestartOperation): RestartOperationAutomatic {
  return operation.automatic ?? "never";
}

/** Whether a request or job names the operation, including Factory recovery-of. */
export function namesOperation(
  operation: ReviewedRestartOperation,
  input: Pick<RestartRequest, RestartPlanField | "factoryRuntimeRecoveryOf">,
): boolean {
  return Boolean(
    input[operation.field] || (operation.ownsFactoryRecovery && input.factoryRuntimeRecoveryOf),
  );
}

/** Whether a job is bound to any reviewed plan. */
export function planBound(job: Pick<RestartJob, RestartPlanField>): boolean {
  return RESTART_OPERATIONS.some((operation) => Boolean(job[operation.field]));
}

/**
 * Whether every plan the job carries permits automatic approval. `standing` is
 * whether an owner's standing decision covers the job.
 */
export function automaticPermitted(
  job: Pick<RestartJob, RestartPlanField>,
  standing: boolean,
  operations: readonly ReviewedRestartOperation[] = RESTART_OPERATIONS,
): boolean {
  return operations.every((operation) => {
    if (!job[operation.field]) return true;
    const policy = automaticPolicy(operation);
    return policy === "allowed" || (policy === "standing" && standing);
  });
}

/** Apply every operation's older-client projection; `negotiated` is keyed by capability. */
export function legacyOperationReplies(
  job: RestartJob,
  negotiated: Record<string, boolean | undefined>,
): RestartJob {
  for (const operation of RESTART_OPERATIONS)
    job = legacyOperationReply(job, operation, negotiated[operation.capability]);
  return job;
}

/** Owner-reviewed plan capabilities, keyed by capability, for operations with a
 * legacy projection. Supervisor maintenance advertises its own automatic rule. */
export function reviewedPlanCapabilities(
  advertisedPlan: (operation: ReviewedRestartOperation) => string | undefined,
  executor: RestartOperationExecutor,
) {
  const capabilities: Record<
    string,
    { available: boolean; ownerApprovalRequired: true; sha256?: string }
  > = {};
  for (const operation of RESTART_OPERATIONS) {
    if (!operation.legacyReply) continue;
    const plan = advertisedPlan(operation);
    capabilities[operation.capability] = {
      available: Boolean(plan && operation.run(executor)),
      ownerApprovalRequired: true,
      ...(plan ? { sha256: plan } : {}),
    };
  }
  return capabilities;
}

/** The job as a client that did not negotiate the operation may see it. */
export function legacyOperationReply(
  job: RestartJob,
  operation: ReviewedRestartOperation,
  negotiated: boolean | undefined,
): RestartJob {
  const legacy = operation.legacyReply;
  if (!legacy || !job[operation.field] || negotiated) return job;
  const compatible: Partial<RestartJob> = { ...job };
  for (const field of [operation.field, ...(legacy.strips ?? [])]) delete compatible[field];
  return { ...(compatible as RestartJob), reason: legacy.reason, detail: legacy.detail };
}
