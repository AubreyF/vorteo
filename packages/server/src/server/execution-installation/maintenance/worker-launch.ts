import { isDeepStrictEqual } from "node:util";
import type {
  RestartJob,
  WorkerLaunch,
  WorkerLaunchBinding,
  WorkerLaunchVerifiedCause,
} from "@getpaseo/protocol/execution-installation";
import type { InstallationEnrollmentState } from "@getpaseo/protocol/installation-enrollment";
import type { LifecycleJob } from "../lifecycle-journal.js";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import { enrollmentManifestDigest } from "./authorization.js";

function conflict(message: string): never {
  throw new BootstrapRequestConflict(message);
}
function restart(job: LifecycleJob): job is RestartJob {
  return job.target === "host" || job.target === "container-daemon";
}
function causeHint(cause: WorkerLaunchBinding["cause"]) {
  return cause.kind === "predecessor"
    ? { kind: cause.kind, generation: cause.generation }
    : { kind: cause.kind, registrationGeneration: cause.registrationGeneration };
}
function sameCause(a: WorkerLaunchVerifiedCause, b: WorkerLaunchVerifiedCause): boolean {
  return (
    isDeepStrictEqual(a.supervisor, b.supervisor) &&
    isDeepStrictEqual(causeHint(a.cause), causeHint(b.cause))
  );
}
export function retainedWorkerLaunchForCause(
  previous: readonly LifecycleJob[],
  cause: WorkerLaunchVerifiedCause,
): RestartJob | undefined {
  const duplicate = previous.find(
    (job): job is RestartJob =>
      restart(job) && Boolean(job.workerLaunch && sameCause(job.workerLaunch.binding, cause)),
  );
  if (
    duplicate &&
    (duplicate.workerLaunch!.binding.profileSha256 !== cause.profileSha256 ||
      duplicate.workerLaunch!.binding.targetIdentitySha256 !== cause.targetIdentitySha256)
  )
    conflict("Worker launch cause already belongs to a different protected profile");
  return duplicate;
}

export function workerLaunchRequestCompatible(
  job: Pick<
    RestartJob,
    | "target"
    | "workerLaunchRequest"
    | "update"
    | "sourceBatch"
    | "supervisorPlanSha256"
    | "factoryRuntimePlanSha256"
    | "factoryRuntimeRecoveryOf"
    | "engineRestartPlanSha256"
    | "devRepairs"
  >,
): boolean {
  return (
    !job.workerLaunchRequest ||
    (job.target === "container-daemon" &&
      !job.update &&
      !job.sourceBatch &&
      !job.supervisorPlanSha256 &&
      !job.factoryRuntimePlanSha256 &&
      !job.factoryRuntimeRecoveryOf &&
      !job.engineRestartPlanSha256 &&
      !job.devRepairs?.length)
  );
}

/** Runs inside the existing journal mutation. A cross-form retry observes the
 * retained child, including uncertain consumption, rather than minting a nonce. */
export function reserveWorkerLaunch(
  previous: readonly LifecycleJob[],
  input: {
    parentId: string;
    expectedParent: RestartJob;
    binding: WorkerLaunchBinding;
    now: string;
  },
): { jobs: LifecycleJob[]; retained: RestartJob } {
  const duplicate = retainedWorkerLaunchForCause(previous, input.binding);
  if (duplicate) return { jobs: [...previous], retained: duplicate };
  const parent = previous.find(
    (job): job is RestartJob => restart(job) && job.id === input.parentId,
  );
  if (!parent || !isDeepStrictEqual(parent, input.expectedParent) || parent.workerLaunch)
    conflict("Worker launch parent changed; inspect its current receipt");
  const retained: RestartJob = {
    ...parent,
    workerLaunch: {
      phase: "reserved",
      binding: input.binding,
      reservedAt: input.now,
    },
  };
  return { jobs: previous.map((job) => (job.id === retained.id ? retained : job)), retained };
}

/** Reopening consumed or uncertain generations is observation-only. */
export function progressWorkerLaunch(
  previous: readonly LifecycleJob[],
  parentId: string,
  expected: WorkerLaunch,
  next: WorkerLaunch,
): LifecycleJob[] {
  const parent = previous.find((job): job is RestartJob => restart(job) && job.id === parentId);
  if (!parent || !isDeepStrictEqual(parent.workerLaunch, expected))
    conflict("Worker launch progress changed; reopen its retained generation");
  return previous.map((job) => (job.id === parentId ? { ...parent, workerLaunch: next } : job));
}

interface WorkerLaunchAdmission {
  previous: readonly LifecycleJob[];
  next: readonly LifecycleJob[];
  state: InstallationEnrollmentState;
  /** Protected synchronous receipt verification under the existing lifecycle lock. */
  assertNativeWorkerEvidence?: (job: RestartJob, phase: "reserve" | "consume" | "observe") => void;
}

function transitionPhase(
  before: WorkerLaunch | undefined,
  after: WorkerLaunch,
): "reserve" | "consume" | "observe" {
  if (!before) {
    if (after.phase !== "reserved") conflict("Worker custody must be reserved before consumption");
    return "reserve";
  }
  if (!isDeepStrictEqual(before.binding, after.binding) || before.reservedAt !== after.reservedAt)
    conflict("Worker custody binding is immutable");
  if (before.phase === "reserved" && after.phase === "consumed") return "consume";
  if (
    (before.phase === "consumed" || before.phase === "uncertain") &&
    (after.phase === "uncertain" || after.phase === "settled") &&
    before.consumedAt === after.consumedAt
  )
    return "observe";
  return conflict("Consumed worker custody is observation-only and cannot be replayed");
}

function assertCurrentGrant(state: InstallationEnrollmentState, binding: WorkerLaunchBinding) {
  if (state.status !== "enrolled") conflict("Worker launch requires explicit standing authority");
  const { grant } = state;
  const target = grant.manifest.targets.find((item) => item.target === "container-daemon");
  if (
    grant.paused ||
    grant.revokedAt ||
    grant.disabledTargets.includes("container-daemon") ||
    !target?.operations.includes("worker-launch") ||
    grant.manifest.workerLaunchProfile?.profileSha256 !== binding.profileSha256 ||
    target.identitySha256 !== binding.targetIdentitySha256 ||
    grant.id !== binding.grantId ||
    grant.revision !== binding.grantRevision ||
    enrollmentManifestDigest(grant.manifest) !== binding.manifestSha256
  )
    conflict("Current grant does not admit this exact protected worker launch");
  return state;
}

function assertParentReservation(job: RestartJob, binding: WorkerLaunchBinding): void {
  const decision = job.standingDecision;
  if (
    job.id !== binding.requestId ||
    job.revision !== binding.approvalRevision ||
    job.status !== "running" ||
    !decision ||
    decision.grantId !== binding.grantId ||
    decision.manifestSha256 !== binding.manifestSha256 ||
    decision.targetIdentitySha256 !== binding.targetIdentitySha256 ||
    decision.grantRevision !== binding.grantRevision ||
    decision.requestRevision !== binding.approvalRevision
  )
    conflict("Worker launch requires its exact running parent reservation");
  if (job.update && job.update.sourceCommit !== binding.sourceCommit)
    conflict("Maintenance child must use its parent reviewed candidate");
  const hints = job.workerLaunchRequest;
  if (
    hints &&
    (hints.profileSha256 !== binding.profileSha256 ||
      hints.supervisorPid !== binding.supervisor.pid ||
      !isDeepStrictEqual(hints.cause, causeHint(binding.cause)))
  )
    conflict("Worker launch hints differ from independent custody admission");
}

function assertActivationParent(
  state: Extract<InstallationEnrollmentState, { status: "enrolled" }>,
  job: RestartJob,
  binding: WorkerLaunchBinding,
): void {
  if (state.activation.steps.every((item) => item.status === "succeeded")) return;
  const activationStep = job.standingDecision?.activationStep;
  const step = state.activation.steps.find((item) => item.id === activationStep?.stepId);
  const plan = state.grant.manifest.steps.find((item) => item.id === activationStep?.stepId);
  if (
    !step ||
    step.status !== "reserved" ||
    step.generation !== activationStep?.generation ||
    step.grantRevision !== state.grant.revision ||
    !plan ||
    plan.target !== job.target ||
    plan.candidate.sourceCommit !== binding.sourceCommit ||
    plan.candidate.artifactSha256 !== binding.artifactSha256 ||
    !plan.dependsOn.every((id) =>
      state.activation.steps.some((item) => item.id === id && item.status === "succeeded"),
    )
  )
    conflict("Incomplete enrollment requires the exact dependency-bound activation parent");
}

function admitChild(
  input: WorkerLaunchAdmission,
  job: RestartJob,
  after: WorkerLaunch,
  before: WorkerLaunch | undefined,
): void {
  if (isDeepStrictEqual(before, after)) return;
  if (
    job.target !== "container-daemon" ||
    job.supervisorPlanSha256 ||
    job.factoryRuntimePlanSha256 ||
    job.factoryRuntimeRecoveryOf ||
    job.engineRestartPlanSha256
  )
    conflict("Worker custody requires an exact Dev worker parent");
  const phase = transitionPhase(before, after);
  if (phase !== "observe") {
    const state = assertCurrentGrant(input.state, after.binding);
    assertParentReservation(job, after.binding);
    assertActivationParent(state, job, after.binding);
    if (
      [...input.previous, ...input.next].some(
        (other) => other.id !== job.id && other.status === "running",
      )
    )
      conflict("Another lifecycle operation owns exclusion");
  }
  if (!input.assertNativeWorkerEvidence)
    conflict("Protected Linux worker launch capability is unavailable");
  const captured = structuredClone(job);
  const result: unknown = input.assertNativeWorkerEvidence(job, phase);
  if (result !== undefined) conflict("Worker launch admission must return undefined synchronously");
  if (!isDeepStrictEqual(job, captured))
    conflict("Worker launch authority changed during native admission");
}

export function assertWorkerLaunchAdmission(input: WorkerLaunchAdmission): void {
  for (const before of input.previous) {
    if (!restart(before) || !before.workerLaunch) continue;
    const after = input.next.find((job) => job.id === before.id);
    if (!after || !restart(after) || !after.workerLaunch)
      conflict("Retained worker custody cannot be discarded");
  }
  const causes: WorkerLaunchBinding[] = [];
  for (const job of input.next) {
    if (!restart(job)) continue;
    if (!workerLaunchRequestCompatible(job))
      conflict("Worker launch cannot inherit restart, update or Factory effects");
    const after = job.workerLaunch;
    if (!after) continue;
    if (causes.some((binding) => sameCause(binding, after.binding)))
      conflict("Worker launch cause already has a retained generation");
    causes.push(after.binding);
    const beforeJob = input.previous.find((item) => item.id === job.id);
    admitChild(
      input,
      job,
      after,
      beforeJob && restart(beforeJob) ? beforeJob.workerLaunch : undefined,
    );
  }
}
