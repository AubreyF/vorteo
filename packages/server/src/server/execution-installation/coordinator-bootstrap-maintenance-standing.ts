import { isDeepStrictEqual } from "node:util";
import { CoordinatorBootstrapRequestSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { InstallationEnrollmentStateSchema } from "@getpaseo/protocol/installation-enrollment";
import { BootstrapRequestConflict, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import { enrollmentManifestDigest, evaluateStandingProposal } from "./maintenance/authorization.js";

/** Current authority is checked inside the existing lifecycle lock for new
 * approval, dispatch reservation and execution claim. Native/source evidence
 * must be independently established by the admitted controller before approval.
 * Historical terminal observation does not call this authorization function. */
export function assertStandingBootstrapAuthority(value: unknown, retained: unknown, now: number) {
  const request = CoordinatorBootstrapRequestSchema.parse(value);
  const proof = request.standingAuthority;
  const state = InstallationEnrollmentStateSchema.parse(retained);
  if (!proof || state.status !== "enrolled")
    throw new BootstrapRequestConflict("Standing coordinator authority is absent");
  if (
    request.enrollment ||
    request.enrollmentDispatch ||
    request.automaticApproval ||
    request.automaticSubmission ||
    request.automaticDispatch ||
    request.status !== "approved" ||
    state.activation.steps.some((step) => step.status !== "succeeded")
  )
    throw new BootstrapRequestConflict("Standing coordinator requires completed enrollment");
  assertStandingPlan(request, proof, state);
  const decidedAt = Date.parse(proof.decidedAt);
  const dispatchAfter = Date.parse(proof.dispatchAfter);
  if (
    request.decisionAt !== proof.decidedAt ||
    !Number.isFinite(now) ||
    decidedAt > now ||
    decidedAt < Date.parse(state.grant.approval.approvedAt) ||
    decidedAt < Date.parse(request.createdAt) ||
    dispatchAfter < decidedAt + 30_000 ||
    ((request.standingDispatch || request.execution) && now < dispatchAfter)
  )
    throw new BootstrapRequestConflict(
      "Standing coordinator cancellation interval has not elapsed",
    );
}

export function assertStandingBootstrapTransition(
  previous: ReturnType<typeof CoordinatorBootstrapRequestSchema.parse> | undefined,
  next: ReturnType<typeof CoordinatorBootstrapRequestSchema.parse>,
) {
  assertRetainedStandingProof(previous, next);
  const adds = next.standingAuthority && !previous?.standingAuthority;
  const dispatches = next.standingDispatch && !previous?.standingDispatch;
  const claims = next.standingAuthority && next.execution && !previous?.execution;
  assertStandingAdmissionTransitions(previous, next, Boolean(adds), Boolean(dispatches));
  if (claims && !previous?.standingDispatch)
    throw new BootstrapRequestConflict("Standing claim requires reserved native dispatch");
  return Boolean(adds || dispatches || claims);
}

type StandingRequest = ReturnType<typeof CoordinatorBootstrapRequestSchema.parse>;
type StandingProof = NonNullable<StandingRequest["standingAuthority"]>;
function assertStandingPlan(
  request: StandingRequest,
  proof: StandingProof,
  state: Extract<
    ReturnType<typeof InstallationEnrollmentStateSchema.parse>,
    { status: "enrolled" }
  >,
) {
  const decision = evaluateStandingProposal({
    state,
    grantRevision: proof.grantRevision,
    proposal: proof.proposal,
  });
  if (
    decision.grantId !== proof.grantId ||
    enrollmentManifestDigest(state.grant.manifest) !== proof.manifestSha256 ||
    proof.proposal.id !== request.id ||
    proof.proposal.target !== "coordinator" ||
    proof.proposal.operation !== "replacement" ||
    proof.proposal.installationId !== request.plan.installationId ||
    proof.proposal.planSha256 !== request.planSha256 ||
    coordinatorPlanDigest(request.plan) !== request.planSha256 ||
    proof.proposal.sourceCommit !== request.plan.candidate.sourceCommit ||
    proof.proposal.artifactSha256 !== request.plan.candidate.artifactSha256
  )
    throw new BootstrapRequestConflict("Standing coordinator proposal changed");
}

function assertRetainedStandingProof(previous: StandingRequest | undefined, next: StandingRequest) {
  if (
    previous?.standingAuthority &&
    (previous.planSha256 !== next.planSha256 || !isDeepStrictEqual(previous.plan, next.plan))
  )
    throw new BootstrapRequestConflict("Retained standing coordinator plan cannot change");
  if (
    previous?.standingAuthority &&
    !isDeepStrictEqual(previous.standingAuthority, next.standingAuthority)
  )
    throw new BootstrapRequestConflict("Retained standing coordinator authority cannot change");
  if (
    previous?.standingDispatch &&
    !isDeepStrictEqual(previous.standingDispatch, next.standingDispatch)
  )
    throw new BootstrapRequestConflict("Retained standing dispatch cannot change");
}

function assertStandingAdmissionTransitions(
  previous: StandingRequest | undefined,
  next: StandingRequest,
  adds: boolean,
  dispatches: boolean,
) {
  if (
    adds &&
    (!previous ||
      previous.status !== "pending" ||
      previous.execution ||
      next.execution ||
      next.standingDispatch)
  )
    throw new BootstrapRequestConflict("Standing decision requires an exact pending request");
  if (
    dispatches &&
    (!previous?.standingAuthority ||
      previous.status !== "approved" ||
      previous.execution ||
      next.standingDispatch!.approvedRevision !== previous.revision)
  )
    throw new BootstrapRequestConflict("Standing dispatch requires its exact retained approval");
}
