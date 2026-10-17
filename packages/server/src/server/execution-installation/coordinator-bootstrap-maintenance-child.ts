import { z } from "zod";
import { InstallationEnrollmentStateSchema } from "@getpaseo/protocol/installation-enrollment";
import { enrollmentManifestDigest } from "./maintenance/authorization.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import type { LifecycleJob } from "./lifecycle-journal.js";
import { standingRestartPlanDigest } from "./maintenance/restart-admission.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const LifecycleActivationChildSchema = z.strictObject({
  grantId: z.uuid(),
  grantRevision: z.uuid(),
  manifestSha256: digest,
  stepId: z.uuid(),
  generation: z.uuid(),
  requestId: z.uuid(),
  requestRevision: z.uuid(),
  planSha256: digest,
  target: z.enum(["host", "container-daemon", "supervisor"]),
});
export type LifecycleActivationChild = z.infer<typeof LifecycleActivationChildSchema>;

/** Called only under shared lifecycle exclusion after the mandatory synchronous
 * policy callback verifies native identity and prepared candidate evidence. This
 * verifies the exact initial migration reservation, never standing eligibility. */
export function inspectLifecycleActivationChild(
  value: LifecycleActivationChild,
  retained: unknown,
  jobs: readonly LifecycleJob[],
) {
  const proof = LifecycleActivationChildSchema.parse(value);
  const { grant, activation } = requireChildReservation(proof, retained);
  const step = grant.manifest.steps.find((item) => item.id === proof.stepId);
  const target = grant.manifest.targets.find((item) => item.target === proof.target);
  const operation = proof.target === "supervisor" ? "replacement" : "source-update";
  if (
    step?.target !== proof.target ||
    step.operation !== operation ||
    step.planSha256 !== proof.planSha256 ||
    !target?.operations.includes(operation) ||
    !step.dependsOn.every((id) =>
      activation.steps.some((item) => item.id === id && item.status === "succeeded"),
    ) ||
    activation.steps.some(
      (item) =>
        item.id !== step.id && (item.status === "reserved" || item.status === "recovery_required"),
    )
  )
    throw new BootstrapRequestConflict("Activation child plan or prerequisites changed");
  if (proof.target === "supervisor") return inspectSupervisorChild(proof, grant, step, jobs);
  const job = jobs.find((item) => item.id === proof.requestId);
  if (
    !job ||
    job.target !== proof.target ||
    job.revision !== proof.requestRevision ||
    !["pending", "approved", "running"].includes(job.status) ||
    !job.update ||
    job.update.sourceCommit !== step.candidate.sourceCommit
  )
    throw new BootstrapRequestConflict("Activation child request changed");
  const { requestRevision, ...identity } = proof;
  return {
    proof,
    // Revision advances through the existing queue. Retain the first revision as
    // history; immutable source and request identity cannot be rebound afterward.
    binding: { version: 1, ...identity, source: job.update },
    initialRevision: requestRevision,
  };
}

/** Supervisor replacement carries a reviewed script, not a source-update bundle.
 * Its immutable request and prepared release remain bound as queue progress changes. */
function inspectSupervisorChild(
  proof: LifecycleActivationChild,
  grant: ReturnType<typeof requireChildReservation>["grant"],
  step: ReturnType<typeof requireChildReservation>["grant"]["manifest"]["steps"][number],
  jobs: readonly LifecycleJob[],
) {
  const job = requireSupervisorChildRequest(proof, jobs);
  const decision = job.standingDecision;
  const target = grant.manifest.targets.find((item) => item.target === "supervisor");
  if (
    !decision ||
    decision.grantId !== proof.grantId ||
    decision.grantRevision !== proof.grantRevision ||
    decision.manifestSha256 !== proof.manifestSha256 ||
    decision.planSha256 !== proof.planSha256 ||
    decision.requestRevision !== proof.requestRevision ||
    decision.targetIdentitySha256 !== target?.identitySha256 ||
    decision.policyActivatedAt !== grant.approval.approvedAt ||
    decision.activationStep?.stepId !== proof.stepId ||
    decision.activationStep.generation !== proof.generation ||
    decision.activationStep.candidateArtifactSha256 !== step.candidate.artifactSha256
  )
    throw new BootstrapRequestConflict("Supervisor activation child decision changed");
  const { requestRevision, ...identity } = proof;
  return {
    proof,
    binding: {
      version: 1,
      ...identity,
      supervisor: {
        scriptSha256: job.supervisorPlanSha256,
        requestPlanSha256: proof.planSha256,
        candidate: step.candidate,
      },
    },
    initialRevision: requestRevision,
  };
}

function requireSupervisorChildRequest(
  proof: LifecycleActivationChild,
  jobs: readonly LifecycleJob[],
) {
  const matches = jobs.filter((item) => item.id === proof.requestId);
  const job = matches[0];
  if (
    matches.length !== 1 ||
    !job ||
    job.target !== "container-daemon" ||
    job.revision !== proof.requestRevision ||
    !["pending", "approved", "running"].includes(job.status) ||
    !job.supervisorPlanSha256 ||
    job.update ||
    job.factoryRuntimePlanSha256 ||
    job.factoryRuntimeRecoveryOf ||
    job.workerLaunchRequest ||
    standingRestartPlanDigest(job) !== proof.planSha256
  )
    throw new BootstrapRequestConflict("Supervisor activation child request changed");
  return job;
}

function requireChildReservation(proof: LifecycleActivationChild, retained: unknown) {
  const state = InstallationEnrollmentStateSchema.parse(retained);
  if (state.status !== "enrolled")
    throw new BootstrapRequestConflict("Activation enrollment is absent");
  const { grant, activation } = state;
  const progress = activation.steps.find((item) => item.id === proof.stepId);
  if (
    grant.id !== proof.grantId ||
    grant.revision !== proof.grantRevision ||
    grant.paused ||
    grant.revokedAt ||
    grant.disabledTargets.includes(proof.target) ||
    enrollmentManifestDigest(grant.manifest) !== proof.manifestSha256 ||
    activation.manifestSha256 !== proof.manifestSha256 ||
    progress?.status !== "reserved" ||
    progress.generation !== proof.generation ||
    progress.grantRevision !== proof.grantRevision
  )
    throw new BootstrapRequestConflict("Activation child authority changed");
  return { grant, activation };
}
