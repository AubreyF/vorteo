import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { FileEnrollmentJournal, reserveActivationStep } from "./maintenance/authorization.js";

/** Native admitted callers validate the immutable plan before entering here.
 * Reservation consumes the activation slot before approval can become dispatchable.
 * An interruption between these writes is retained uncertainty, never replay intent. */
export function approveEnrolledBootstrap(input: {
  request: CoordinatorBootstrapRequest;
  admissionSha256: string;
  review: { id: string; revision: string; manifestSha256: string };
}): CoordinatorBootstrapRequest {
  const { request, review } = input;
  const directory = request.plan.state.directory;
  const enrollment = new FileEnrollmentJournal(directory);
  const state = enrollment.read();
  if (
    state.status !== "enrolled" ||
    request.status !== "pending" ||
    request.execution ||
    request.enrollment ||
    request.automaticSubmission ||
    request.automaticApproval ||
    request.enrollmentDispatch ||
    request.automaticDispatch
  )
    throw new BootstrapRequestConflict("Exact pending enrolled coordinator request required");
  const { grant } = state;
  const binding = grant.manifest.provisioning;
  if (
    grant.approval.requestId !== review.id ||
    grant.approval.reviewRevision !== review.revision ||
    grant.approval.manifestSha256 !== review.manifestSha256 ||
    binding?.admissionSha256 !== input.admissionSha256
  )
    throw new BootstrapRequestConflict("Coordinator enrollment decision changed");
  const reserved = reserveActivationStep(enrollment, {
    grantRevision: grant.revision,
    stepId: binding.coordinatorStepId,
  });
  if (reserved.status !== "enrolled")
    throw new BootstrapRequestConflict("Enrollment reservation missing");
  const step = reserved.activation.steps.find((item) => item.id === binding.coordinatorStepId);
  if (step?.status !== "reserved")
    throw new BootstrapRequestConflict("Enrollment reservation changed");
  const approved: CoordinatorBootstrapRequest = {
    ...request,
    revision: randomUUID(),
    status: "approved",
    decisionAt: grant.approval.approvedAt,
    enrollment: {
      grantId: grant.id,
      grantRevision: grant.revision,
      manifestSha256: review.manifestSha256,
      reviewId: review.id,
      reviewRevision: review.revision,
      admissionSha256: input.admissionSha256,
      stepId: step.id,
      generation: step.generation,
    },
  };
  new FileBootstrapRequestJournal(directory).withRecoveryTransaction((records, replace) => {
    if (
      !isDeepStrictEqual(
        records.find((item) => item.id === request.id),
        request,
      )
    )
      throw new BootstrapRequestConflict(
        "Coordinator request changed after enrollment reservation",
      );
    // replace repeats current grant verification under this same shared lock.
    replace(records.map((item) => (item.id === request.id ? approved : item)));
  });
  return approved;
}

/** Reserve exactly one native spawn. Lost replies never make this slot reusable. */
export function reserveEnrolledBootstrapLaunch(
  request: CoordinatorBootstrapRequest,
): CoordinatorBootstrapRequest {
  if (
    !request.enrollment ||
    request.status !== "approved" ||
    request.execution ||
    request.enrollmentDispatch
  )
    throw new BootstrapRequestConflict("Exact undispatched enrollment approval required");
  const next: CoordinatorBootstrapRequest = {
    ...request,
    revision: randomUUID(),
    enrollmentDispatch: {
      approvedRevision: request.revision,
      requestedAt: new Date().toISOString(),
    },
  };
  new FileBootstrapRequestJournal(request.plan.state.directory).withRecoveryTransaction(
    (records, replace) => {
      if (
        !isDeepStrictEqual(
          records.find((item) => item.id === request.id),
          request,
        )
      )
        throw new BootstrapRequestConflict("Enrollment dispatch changed or was already reserved");
      replace(records.map((item) => (item.id === request.id ? next : item)));
    },
  );
  return next;
}
