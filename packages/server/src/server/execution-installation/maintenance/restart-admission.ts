import { RestartJobSchema } from "@getpaseo/protocol/execution-installation";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  RestartJob,
  StandingRestartDecision,
} from "@getpaseo/protocol/execution-installation";
import type { InstallationEnrollmentState } from "@getpaseo/protocol/installation-enrollment";
import type { LifecycleJob } from "../lifecycle-journal.js";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import { enrollmentManifestDigest } from "./authorization.js";

type Decision = Omit<StandingRestartDecision, "requestRevision">;
export type StandingRestartPhase = "preparation" | "hold" | "replacement";

/** Only request content participates; queue progress must not change the reviewed plan. */
export function standingRestartPlanDigest(job: RestartJob): string {
  job = RestartJobSchema.parse(job);
  return digest({
    id: job.id,
    target: job.target,
    requestedBy: job.requestedBy,
    requester: job.requester ?? null,
    reason: job.reason,
    createdAt: job.createdAt,
    requireOwnerApproval: job.requireOwnerApproval ?? false,
    update: job.update ?? null,
    sourceBatch: job.sourceBatch ?? null,
    supervisorPlanSha256: job.supervisorPlanSha256 ?? null,
    factoryRuntimePlanSha256: job.factoryRuntimePlanSha256 ?? null,
    factoryRuntimeRecoveryOf: job.factoryRuntimeRecoveryOf ?? null,
    devRepairs: job.devRepairs ?? [],
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function enrolledOperation(job: RestartJob) {
  if (job.supervisorPlanSha256) return "replacement";
  if (job.factoryRuntimePlanSha256) return "runtime-adoption";
  if (job.devRepairs?.some((repair) => repair.status === "prepared")) return "source-repair";
  return job.update ? "source-update" : "restart";
}

/** Policy only. The Host supplies independently inspected identity, repository
 * and credential binding. The locked admission below grants each exact effect. */
export function evaluateStandingRestart(input: {
  state: InstallationEnrollmentState;
  job: RestartJob;
  installationId: string;
  nativeIdentitySha256: string;
  repository: string | null;
  credentialBindingSha256: string;
}): Decision | null | undefined {
  if (input.state.status === "absent") return undefined;
  const { grant, activation } = input.state;
  const { job } = input;
  const target = job.supervisorPlanSha256 ? "supervisor" : job.target;
  const binding = grant.manifest.targets.find((item) => item.target === target);
  if (
    grant.manifest.installationId !== input.installationId ||
    grant.paused ||
    grant.revokedAt ||
    grant.disabledTargets.includes(target) ||
    !binding ||
    binding.identitySha256 !== input.nativeIdentitySha256 ||
    !binding.operations.includes(enrolledOperation(job))
  )
    return null;
  if (!sourceApprovalAllowed(job, input.repository, grant.manifest.trustedRepositories))
    return null;
  const manifestSha256 = enrollmentManifestDigest(grant.manifest);
  const planSha256 = standingRestartPlanDigest(job);
  const activationStep = activationChildBinding(input.state, job, planSha256);
  if (activation.steps.some((step) => step.status !== "succeeded") && !activationStep) return null;
  return {
    ...(activationStep ? { activationStep } : {}),
    grantId: grant.id,
    grantRevision: grant.revision,
    manifestSha256,
    planSha256,
    targetIdentitySha256: binding.identitySha256,
    authoritySha256: digest({
      scope: "installation-standing-restart-v1",
      installationId: input.installationId,
      grantId: grant.id,
      grantRevision: grant.revision,
      manifestSha256,
      planSha256,
      nativeIdentitySha256: input.nativeIdentitySha256,
      credentialBindingSha256: input.credentialBindingSha256,
      activationStep: activationStep ?? null,
    }),
    policyActivatedAt: grant.approval.approvedAt,
  };
}

function sourceApprovalAllowed(
  job: RestartJob,
  repository: string | null,
  trustedRepositories: string[],
): boolean {
  if (
    job.requireOwnerApproval ||
    job.sourceBatch?.contributions.some(
      (item) => item.status !== "superseded" && item.requireOwnerApproval,
    )
  )
    return false;
  if (job.update && (!repository || !trustedRepositories.includes(repository))) return false;
  if (
    job.update &&
    (!job.sourceBatch ||
      job.sourceBatch.status !== "ready" ||
      !job.sourceBatch.contributions.some((item) => item.status === "included") ||
      job.sourceBatch.contributions.some(
        (item) => !["included", "superseded"].includes(item.status),
      ))
  )
    return false;
  return true;
}

/** Only one exact reserved initial migration may proceed before enrollment completes.
 * The plan digest includes the genuine request ID and all contributed source bytes. */
function activationChildBinding(
  state: Extract<InstallationEnrollmentState, { status: "enrolled" }>,
  job: RestartJob,
  planSha256: string,
): Decision["activationStep"] | null {
  const candidates = state.grant.manifest.steps.filter(
    (step) =>
      step.target === job.target &&
      step.operation === enrolledOperation(job) &&
      step.planSha256 === planSha256,
  );
  if (candidates.length !== 1) return null;
  const step = candidates[0];
  const progress = state.activation.steps.find((item) => item.id === step.id);
  if (progress?.status !== "reserved" || progress.grantRevision !== state.grant.revision)
    return null;
  if (
    state.activation.steps.some(
      (item) => item.id !== step.id && ["reserved", "recovery_required"].includes(item.status),
    )
  )
    return null;
  if (
    !step.dependsOn.every((id) =>
      state.activation.steps.some((item) => item.id === id && item.status === "succeeded"),
    )
  )
    return null;
  if (job.update && job.update.sourceCommit !== step.candidate.sourceCommit) return null;
  return {
    stepId: step.id,
    generation: progress.generation,
    candidateArtifactSha256: step.candidate.artifactSha256,
  };
}

interface AdmissionInput {
  previous: readonly LifecycleJob[];
  next: readonly LifecycleJob[];
  /** Must be read under the same installation lifecycle lock as this transition. */
  state: InstallationEnrollmentState;
  evaluate(job: RestartJob, state: InstallationEnrollmentState): Decision | null | undefined;
  /** Read protected preparation/admission receipts only. Heavy native validation
   * happens before the lock; the executor rechecks actual selection before effects. */
  assertEvidence(job: RestartJob, phase: StandingRestartPhase): void;
}

/** Called only inside FileBootstrapRequestJournal.writeLifecycle's admission hook.
 * Cancellation, hold release and terminal observations never acquire fresh authority. */
export function assertStandingRestartAdmission(input: AdmissionInput): void {
  const previous = new Map(input.previous.map((job) => [job.id, job]));
  const next = new Map(input.next.map((job) => [job.id, job]));
  for (const retained of input.previous) {
    if (
      (retained.target === "host" || retained.target === "container-daemon") &&
      retained.standingDecision &&
      !next.has(retained.id)
    )
      throw new BootstrapRequestConflict("Standing maintenance history cannot be discarded");
  }
  for (const proposed of input.next) {
    if (proposed.target !== "host" && proposed.target !== "container-daemon") continue;
    const prior = previous.get(proposed.id);
    const retained =
      prior && (prior.target === "host" || prior.target === "container-daemon") ? prior : undefined;
    assertRetainedBindings(retained, proposed);
    const phase = effectPhase(retained, proposed);
    if (!phase) continue;
    assertEffectAdmission(input, retained, proposed, phase);
  }
}

function assertEffectAdmission(
  input: AdmissionInput,
  retained: RestartJob | undefined,
  proposed: RestartJob,
  phase: StandingRestartPhase,
): void {
  if (input.state.status === "absent") {
    if (proposed.standingDecision)
      throw new BootstrapRequestConflict("Standing decision has no retained enrollment");
    return;
  }
  // Enrollment governs standing effects. Exact owner-approved operations retain
  // the existing authenticated manual path, including while the grant is paused.
  if (!proposed.standingDecision && !proposed.automaticApproval && !proposed.standingHold) return;
  if (hasExactManualApproval(proposed)) {
    if (phase !== "preparation") {
      const result: unknown = input.assertEvidence(proposed, phase);
      if (result instanceof Promise)
        throw new BootstrapRequestConflict("Standing admission must be synchronous");
    }
    return;
  }
  const current = input.evaluate(proposed, input.state);
  if (
    !current ||
    !proposed.standingDecision ||
    !proposed.automaticApproval ||
    !proposed.whenIdle ||
    !proposed.finishCurrentTurns ||
    !isDeepStrictEqual(
      { ...current, requestRevision: proposed.revision },
      proposed.standingDecision,
    )
  )
    throw new BootstrapRequestConflict("Standing maintenance authority changed before admission");
  assertStandingEffectPrerequisites(retained, proposed, phase);
  const result: unknown = input.assertEvidence(proposed, phase);
  if (result instanceof Promise)
    throw new BootstrapRequestConflict("Standing admission must be synchronous");
}

function hasExactManualApproval(job: RestartJob): boolean {
  const history = job.standingManualApprovals;
  if (!history?.length || !job.standingDecision || job.automaticApproval) return false;
  let previousRevision = job.standingDecision.requestRevision;
  for (const decision of history) {
    if (decision.previousRevision !== previousRevision) return false;
    previousRevision = decision.revision;
  }
  const last = history.at(-1)!;
  return (
    previousRevision === job.revision &&
    (last.decision === "approve"
      ? job.whenIdle === false
      : job.whenIdle === true && job.finishCurrentTurns === true)
  );
}

function assertManualHistory(previous: RestartJob, next: RestartJob): void {
  const before = previous.standingManualApprovals ?? [];
  const after = next.standingManualApprovals ?? [];
  if (!isDeepStrictEqual(before, after.slice(0, before.length)) || after.length > before.length + 1)
    throw new BootstrapRequestConflict("Standing owner approval history changed");
  if (after.length !== before.length || previous.revision !== next.revision) {
    const approval = after.at(-1);
    if (
      after.length !== before.length + 1 ||
      approval?.previousRevision !== previous.revision ||
      approval.revision !== next.revision ||
      !hasExactManualApproval(next)
    )
      throw new BootstrapRequestConflict("Standing revision requires exact owner supersession");
  }
}

function assertStandingEffectPrerequisites(
  retained: RestartJob | undefined,
  proposed: RestartJob,
  phase: StandingRestartPhase,
): void {
  if (phase !== "preparation" && !proposed.standingHold)
    throw new BootstrapRequestConflict("Standing effect requires its exact hold reservation");
  if (
    phase === "replacement" &&
    (retained?.status !== "approved" || !holdConfirmed(retained) || !holdConfirmed(proposed))
  )
    throw new BootstrapRequestConflict("Standing replacement requires a verified hold");
  assertHoldBinding(proposed);
}

function holdConfirmed(job: RestartJob): boolean {
  const hold = job.standingHold;
  if (hold?.releaseRequestedAt) return false;
  if (hold?.initialDaemonInstanceSha256 || hold?.acknowledgedAt)
    return Boolean(
      job.standingDecision?.activationStep &&
      hold.initialDaemonInstanceSha256 &&
      hold.acknowledgedAt &&
      !hold.observedAt,
    );
  return Boolean(hold?.observedAt);
}

function effectPhase(
  previous: RestartJob | undefined,
  next: RestartJob,
): StandingRestartPhase | null {
  if (next.status === "running" && previous?.status !== "running") return "replacement";
  if (next.standingHold && !previous?.standingHold) return "hold";
  if (
    next.status === "approved" &&
    (previous?.status !== "approved" ||
      !isDeepStrictEqual(previous.standingDecision, next.standingDecision))
  )
    return "preparation";
  return null;
}

function assertHoldBinding(job: RestartJob): void {
  if (!job.standingHold) return;
  if (
    job.standingHold.grantRevision !== job.standingDecision?.grantRevision ||
    job.standingHold.decisionSha256 !== digest(job.standingDecision)
  )
    throw new BootstrapRequestConflict("Standing hold differs from its recorded policy decision");
  if (
    (job.standingHold.initialDaemonInstanceSha256 || job.standingHold.acknowledgedAt) &&
    (!job.standingDecision?.activationStep ||
      !job.standingHold.initialDaemonInstanceSha256 ||
      job.standingHold.observedAt)
  )
    throw new BootstrapRequestConflict(
      "Legacy hold acknowledgment requires the exact initial child",
    );
}

function assertRetainedBindings(previous: RestartJob | undefined, next: RestartJob): void {
  if (!previous?.standingDecision) return;
  assertManualHistory(previous, next);
  if (
    !isDeepStrictEqual(previous.standingDecision, next.standingDecision) ||
    standingRestartPlanDigest(previous) !== standingRestartPlanDigest(next)
  )
    throw new BootstrapRequestConflict("Standing maintenance plan changed after authorization");
  if (previous.standingHold) {
    if (!next.standingHold) throw new BootstrapRequestConflict("Standing hold reservation changed");
    const {
      observedAt: previousObservation,
      acknowledgedAt: previousAcknowledgment,
      releaseRequestedAt: previousRelease,
      ...previousBinding
    } = previous.standingHold;
    const {
      observedAt: nextObservation,
      acknowledgedAt: nextAcknowledgment,
      releaseRequestedAt: nextRelease,
      ...nextBinding
    } = next.standingHold;
    if (
      !isDeepStrictEqual(previousBinding, nextBinding) ||
      (previousObservation !== undefined && previousObservation !== nextObservation) ||
      (previousAcknowledgment !== undefined && previousAcknowledgment !== nextAcknowledgment) ||
      (previousRelease !== undefined && previousRelease !== nextRelease)
    )
      throw new BootstrapRequestConflict("Standing hold reservation changed");
    if (nextRelease && !["rejected", "failed", "succeeded"].includes(next.status))
      throw new BootstrapRequestConflict("Hold release requires a terminal lifecycle result");
  }
}
