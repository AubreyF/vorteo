import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  MaintenanceServiceJobSchema,
  MaintenanceServiceReservationSchema,
  type MaintenanceServiceJob,
  type MaintenanceServiceReservation,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { inspectMaintenanceLauncherPlan } from "./coordinator-bootstrap-maintenance-launcher.js";

/** This is the native executor's independent binding check, not queue approval.
 * The caller supplies the job freshly read under mutateLifecycle and compares
 * native evidence before inserting its exclusive effectIntent in that job. */
export function inspectMaintenanceServiceExecution(input: {
  retained: unknown;
  reservation: unknown;
  plan: unknown;
  account: { uid: number; home: string };
}) {
  const job = MaintenanceServiceJobSchema.parse(input.retained);
  const reservation = MaintenanceServiceReservationSchema.parse(input.reservation);
  const native = inspectMaintenanceLauncherPlan(input.plan, input.account);
  const { proposal, approval } = job;
  if (
    job.operation !== "replacement" ||
    proposal.operation !== "replacement" ||
    reservation.operation !== "replacement" ||
    proposal.recoveryOf ||
    reservation.recoveryOf
  )
    throw new BootstrapRequestConflict("Native service recovery and rollback are not available");
  if (
    job.status !== "running" ||
    !approval ||
    !job.reservation ||
    job.effectIntent ||
    !isDeepStrictEqual(job.reservation, reservation)
  )
    throw new BootstrapRequestConflict(
      "Native service requires an unconsumed retained reservation",
    );
  requireServicePlan(job, reservation, native);
  requireServiceApproval(approval, reservation, proposal);
  requireServiceAdmissionEvidence(job, reservation);
  return { ...native, job, reservation };
}

/** Reopening a consumed operation is observation only. This preserves the
 * original approved revision even after queue CAS revisions or grant revocation.
 * It never returns an unconsumed job or permission to repeat native effects. */
export function inspectRetainedMaintenanceServiceEffect(input: {
  retained: unknown;
  plan: unknown;
  account: { uid: number; home: string };
}) {
  const job = MaintenanceServiceJobSchema.parse(input.retained);
  const { reservation, approval, effectIntent } = requireConsumedService(job);
  const native = inspectMaintenanceLauncherPlan(input.plan, input.account);
  requireServicePlan(job, reservation, native);
  requireServiceApproval(approval, reservation, job.proposal);
  requireRetainedServiceIntent(job, reservation, native);
  return { ...native, job, reservation, intent: effectIntent };
}

function requireConsumedService(job: MaintenanceServiceJob) {
  const { reservation, approval, effectIntent } = job;
  if (
    !reservation ||
    !approval ||
    !effectIntent ||
    !["running", "succeeded", "failed"].includes(job.status) ||
    job.operation !== "replacement" ||
    job.proposal.operation !== "replacement" ||
    reservation.operation !== "replacement" ||
    job.proposal.recoveryOf ||
    reservation.recoveryOf
  )
    throw new BootstrapRequestConflict("Retained service effect is unavailable");
  return { reservation, approval, effectIntent };
}

function requireServicePlan(
  job: MaintenanceServiceJob,
  reservation: MaintenanceServiceReservation,
  native: ReturnType<typeof inspectMaintenanceLauncherPlan>,
) {
  const { proposal } = job;
  const candidate = {
    sourceCommit: native.plan.candidate.sourceCommit,
    artifactSha256: native.plan.candidate.artifactSha256,
  };
  const previous = native.plan.previous && {
    sourceCommit: native.plan.previous.sourceCommit,
    artifactSha256: native.plan.previous.artifactSha256,
  };
  if (
    proposal.id !== job.id ||
    reservation.requestId !== job.id ||
    job.target !== proposal.target ||
    job.target !== reservation.target ||
    job.target !== native.plan.identity.target ||
    proposal.installationId !== native.plan.identity.installationId ||
    proposal.planSha256 !== native.planSha256 ||
    reservation.planSha256 !== native.planSha256 ||
    proposal.identitySha256 !== native.identitySha256 ||
    reservation.identitySha256 !== native.identitySha256
  )
    throw new BootstrapRequestConflict("Native service request differs from the reviewed plan");
  if (
    proposal.sourceCommit !== candidate.sourceCommit ||
    proposal.artifactSha256 !== candidate.artifactSha256 ||
    reservation.sourceCommit !== candidate.sourceCommit ||
    reservation.artifactSha256 !== candidate.artifactSha256 ||
    !isDeepStrictEqual(proposal.previous, previous) ||
    !isDeepStrictEqual(reservation.previous, previous)
  )
    throw new BootstrapRequestConflict("Native service artifacts differ from the reviewed slots");
}

export function requireServiceApproval(
  approval: NonNullable<MaintenanceServiceJob["approval"]>,
  reservation: MaintenanceServiceReservation,
  proposal: MaintenanceServiceJob["proposal"],
) {
  const proposalSha256 = createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
  if (
    approval.requestRevision !== reservation.requestRevision ||
    approval.grantId !== reservation.grantId ||
    approval.grantRevision !== reservation.grantRevision ||
    approval.manifestSha256 !== reservation.manifestSha256 ||
    approval.proposalSha256 !== proposalSha256 ||
    reservation.proposalSha256 !== proposalSha256
  )
    throw new BootstrapRequestConflict("Native service reservation differs from its approval");
  if (
    Date.parse(reservation.reservedAt) < Date.parse(approval.dispatchAfter) ||
    Date.parse(approval.dispatchAfter) < Date.parse(approval.approvedAt) + 30_000 ||
    Date.parse(reservation.reservedAt) > Date.now()
  )
    throw new BootstrapRequestConflict(
      "Native service reservation bypasses its cancellation interval",
    );
}

/** Approval and reservation inspect different journal revisions. Validate their
 * addressed proofs independently; their digests are not interchangeable. This
 * is dispatch validation, not a new requirement on legacy observation. */
export function requireServiceAdmissionEvidence(
  job: MaintenanceServiceJob,
  reservation: MaintenanceServiceReservation,
): void {
  const approval = job.approval!;
  for (const sha256 of [approval.nativeEvidenceSha256, reservation.nativeEvidenceSha256]) {
    const matches = job.evidence.filter((item) => item.sha256 === sha256);
    const record = matches[0]?.record;
    if (
      matches.length !== 1 ||
      !record ||
      createHash("sha256").update(JSON.stringify(record)).digest("hex") !== sha256 ||
      record.requestId !== job.id ||
      record.planSha256 !== reservation.planSha256 ||
      record.identitySha256 !== reservation.identitySha256 ||
      record.sourceCommit !== reservation.sourceCommit ||
      record.artifactSha256 !== reservation.artifactSha256 ||
      (sha256 === approval.nativeEvidenceSha256 &&
        record.requestRevision !== approval.reviewedRevision)
    )
      throw new BootstrapRequestConflict(
        "Native service admission evidence differs from its retained proof",
      );
  }
}

export function requireRetainedServiceIntent(
  job: MaintenanceServiceJob,
  reservation: MaintenanceServiceReservation,
  expected: { planSha256: string; identitySha256: string },
) {
  const effectIntent = job.effectIntent;
  if (!effectIntent || !["running", "failed", "succeeded"].includes(job.status))
    throw new BootstrapRequestConflict("Retained service effect is unavailable");
  const evidence = job.evidence.filter((item) => item.sha256 === effectIntent.nativeEvidenceSha256);
  const record = evidence[0]?.record;
  if (
    effectIntent.generation !== reservation.generation ||
    effectIntent.requestRevision !== reservation.requestRevision ||
    Date.parse(effectIntent.consumedAt) < Date.parse(reservation.reservedAt) ||
    evidence.length !== 1 ||
    !record ||
    createHash("sha256").update(JSON.stringify(record)).digest("hex") !== evidence[0]!.sha256 ||
    record.requestId !== job.id ||
    record.planSha256 !== expected.planSha256 ||
    record.identitySha256 !== expected.identitySha256 ||
    record.sourceCommit !== reservation.sourceCommit ||
    record.artifactSha256 !== reservation.artifactSha256 ||
    record.native.bootId !== effectIntent.executor.bootId
  )
    throw new BootstrapRequestConflict("Retained service effect proof differs from reservation");
  return effectIntent;
}
