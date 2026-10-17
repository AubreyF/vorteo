import { isDeepStrictEqual } from "node:util";
import {
  MaintenanceServiceJobSchema,
  MaintenanceServiceReservationSchema,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { inspectMaintenanceRecoveryPlan } from "./coordinator-bootstrap-maintenance-recovery-plan.js";
import {
  requireServiceApproval,
  requireServiceAdmissionEvidence,
  requireRetainedServiceIntent,
} from "./coordinator-bootstrap-maintenance-service-binding.js";

/** Independent request binding only. Predecessor evidence, native custody,
 * current grant and shared exclusion must still be checked at effect claim. */
export function inspectMaintenanceRecoveryExecution(input: {
  retained: unknown;
  reservation: unknown;
  plan: unknown;
  account: { uid: number; home: string };
}) {
  const job = MaintenanceServiceJobSchema.parse(input.retained);
  const reservation = MaintenanceServiceReservationSchema.parse(input.reservation);
  const context = inspectMaintenanceRecoveryPlan(input.plan, input.account);
  const operation = context.slot === "candidate" ? "recovery" : "rollback";
  if (
    job.status !== "running" ||
    !job.approval ||
    !job.reservation ||
    job.effectIntent ||
    !isDeepStrictEqual(job.reservation, reservation) ||
    job.id === context.plan.recoveryOf.requestId ||
    reservation.generation === context.plan.recoveryOf.generation
  ) {
    throw new BootstrapRequestConflict("Recovery requires a fresh unconsumed tracked reservation");
  }
  requireRecoveryPlanBinding(job, reservation, context, operation);
  requireServiceApproval(job.approval, reservation, job.proposal);
  requireServiceAdmissionEvidence(job, reservation);
  return { ...context, job, reservation };
}

function requireRecoveryPlanBinding(
  job: ReturnType<typeof MaintenanceServiceJobSchema.parse>,
  reservation: ReturnType<typeof MaintenanceServiceReservationSchema.parse>,
  context: ReturnType<typeof inspectMaintenanceRecoveryPlan>,
  operation: "recovery" | "rollback",
) {
  const { proposal } = job;
  const previousSlot =
    operation === "recovery"
      ? context.predecessor.plan.previous
      : context.predecessor.plan.candidate;
  const previous = previousSlot && {
    sourceCommit: previousSlot.sourceCommit,
    artifactSha256: previousSlot.artifactSha256,
  };

  const expected = {
    installationId: context.identity.installationId,
    target: context.identity.target,
    operation,
    identitySha256: context.identitySha256,
    planSha256: context.planSha256,
    sourceCommit: context.selected.sourceCommit,
    artifactSha256: context.selected.artifactSha256,
    recoveryOf: context.plan.recoveryOf,
  };
  const proposed = {
    installationId: proposal.installationId,
    target: proposal.target,
    operation: proposal.operation,
    identitySha256: proposal.identitySha256,
    planSha256: proposal.planSha256,
    sourceCommit: proposal.sourceCommit,
    artifactSha256: proposal.artifactSha256,
    recoveryOf: proposal.recoveryOf,
  };
  const reserved = {
    installationId: proposal.installationId,
    target: reservation.target,
    operation: reservation.operation,
    identitySha256: reservation.identitySha256,
    planSha256: reservation.planSha256,
    sourceCommit: reservation.sourceCommit,
    artifactSha256: reservation.artifactSha256,
    recoveryOf: reservation.recoveryOf,
  };
  if (
    job.target !== expected.target ||
    job.operation !== operation ||
    proposal.id !== job.id ||
    reservation.requestId !== job.id ||
    !isDeepStrictEqual(proposed, expected) ||
    !isDeepStrictEqual(reserved, expected) ||
    !isDeepStrictEqual(proposal.previous, previous) ||
    !isDeepStrictEqual(reservation.previous, previous)
  ) {
    throw new BootstrapRequestConflict("Recovery reservation differs from its exact retained plan");
  }
}

export function inspectRetainedMaintenanceRecoveryEffect(input: {
  retained: unknown;
  plan: unknown;
  account: { uid: number; home: string };
}) {
  const job = MaintenanceServiceJobSchema.parse(input.retained);
  const { reservation, approval } = job;
  if (!reservation || !approval)
    throw new BootstrapRequestConflict("Retained recovery approval is unavailable");
  const context = inspectMaintenanceRecoveryPlan(input.plan, input.account);
  const operation = context.slot === "candidate" ? "recovery" : "rollback";
  if (
    job.id === context.plan.recoveryOf.requestId ||
    reservation.generation === context.plan.recoveryOf.generation
  )
    throw new BootstrapRequestConflict("Retained recovery reuses its predecessor identity");
  requireRecoveryPlanBinding(job, reservation, context, operation);
  requireServiceApproval(approval, reservation, job.proposal);
  const intent = requireRetainedServiceIntent(job, reservation, context);
  return { ...context, job, reservation, intent };
}
