import {
  assertHostContinuationExclusion,
  FileEnrollmentJournal,
  unresolvedHostContinuations,
} from "./maintenance/authorization.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { InstallationEnrollmentStateSchema } from "@getpaseo/protocol/installation-enrollment";
import { CoordinatorBootstrapRequestSchema } from "@getpaseo/protocol/coordinator-bootstrap";

/** Called inside the existing bootstrap transaction, so it must not reacquire
 * that lock through FileEnrollmentJournal. No native effect is performed here. */
export function readMaintenanceEnrollmentForClaim(directory: string): unknown {
  return new FileEnrollmentJournal(directory).readUnderLifecycleLock();
}

/** Verify current authority only for a new approval/claim. Historical execution
 * and rollback retain their exact proof without requiring a still-active grant. */
export function assertMaintenanceEnrollmentClaim(value: unknown, retained: unknown): void {
  const request = CoordinatorBootstrapRequestSchema.parse(value);
  const proof = request.enrollment;
  const state = InstallationEnrollmentStateSchema.parse(retained);
  assertHostContinuationExclusion(state);
  if (!proof || state.status !== "enrolled") throw new Error("Exact enrollment authority required");
  const { grant, activation } = state;
  const manifest = grant.manifest;
  const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const progress = activation.steps.find((item) => item.id === proof.stepId);
  const target = manifest.targets.find((item) => item.target === "coordinator");
  if (
    grant.paused ||
    grant.revokedAt !== null ||
    grant.disabledTargets.includes("coordinator") ||
    !target?.operations.includes("replacement") ||
    progress?.status !== "reserved" ||
    request.status !== "approved" ||
    request.execution ||
    request.automaticApproval ||
    request.automaticSubmission ||
    request.automaticDispatch
  )
    throw new Error("Enrollment no longer authorizes this coordinator claim");
  const expected = {
    grantId: grant.id,
    grantRevision: grant.revision,
    manifestSha256: digest,
    reviewId: grant.approval.requestId,
    reviewRevision: manifest.revision,
    admissionSha256: manifest.provisioning?.admissionSha256,
    stepId: manifest.provisioning?.coordinatorStepId,
    generation: progress.generation,
  };
  if (!isDeepStrictEqual(proof, expected) || progress.grantRevision !== grant.revision)
    throw new Error("Enrollment no longer authorizes this coordinator claim");
  assertEnrollmentPlan(request, state, digest);
}

function assertEnrollmentPlan(
  request: ReturnType<typeof CoordinatorBootstrapRequestSchema.parse>,
  state: Extract<
    ReturnType<typeof InstallationEnrollmentStateSchema.parse>,
    { status: "enrolled" }
  >,
  digest: string,
) {
  const { grant, activation } = state;
  const manifest = grant.manifest;
  const step = manifest.steps.find((item) => item.id === request.enrollment!.stepId);
  const planDigest = createHash("sha256").update(JSON.stringify(request.plan)).digest("hex");
  if (
    grant.approval.reviewRevision !== manifest.revision ||
    grant.approval.manifestSha256 !== digest ||
    activation.manifestSha256 !== digest ||
    manifest.installationId !== request.plan.installationId ||
    step?.target !== "coordinator" ||
    step.operation !== "replacement" ||
    step.planSha256 !== request.planSha256 ||
    planDigest !== request.planSha256
  )
    throw new Error("Enrollment no longer authorizes this coordinator claim");
  if (
    new Set(manifest.steps.map((item) => item.id)).size !== manifest.steps.length ||
    new Set(manifest.targets.map((item) => item.target)).size !== manifest.targets.length ||
    activation.steps.length !== manifest.steps.length ||
    activation.steps.some((item, index) => item.id !== manifest.steps[index].id) ||
    activation.steps.some(
      (item) =>
        item.id !== step.id && (item.status === "reserved" || item.status === "recovery_required"),
    ) ||
    !step.dependsOn.every((id) =>
      activation.steps.some((item) => item.id === id && item.status === "succeeded"),
    )
  )
    throw new Error("Enrollment activation prerequisites changed");
  const artifact = (release: { sourceCommit: string; artifactSha256: string }) => ({
    sourceCommit: release.sourceCommit,
    artifactSha256: release.artifactSha256,
  });
  if (
    !isDeepStrictEqual(step.candidate, artifact(request.plan.candidate)) ||
    !isDeepStrictEqual(step.previous, artifact(request.plan.previous))
  )
    throw new Error("Enrollment coordinator artifacts changed");
}

/** The durable activation reservation is also an exclusion fence. A revoked
 * grant does not erase an uncertain effect. Only observation can settle it. */
export function unresolvedMaintenanceActivations(retained: unknown) {
  const state = InstallationEnrollmentStateSchema.parse(retained);
  const continuationSteps = new Set(unresolvedHostContinuations(state).map((item) => item.stepId));
  return state.status === "enrolled"
    ? state.activation.steps.filter(
        (step) =>
          step.status === "reserved" ||
          step.status === "recovery_required" ||
          continuationSteps.has(step.id),
      )
    : [];
}
