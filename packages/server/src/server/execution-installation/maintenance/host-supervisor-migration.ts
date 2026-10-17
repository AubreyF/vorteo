import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CoordinatorBootstrapPlanSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import type {
  InstallationActivation,
  EnrollmentStep,
} from "@getpaseo/protocol/installation-enrollment";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import { FileEnrollmentJournal, enrollmentManifestDigest } from "./authorization.js";
import { enrollmentNativeIdentityDigest } from "./native-identity.js";
import { InitialHostSupervisorPreconditionSchema } from "./native-daemon-inspection.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const InitialHostSupervisorMigrationPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("initial-host-supervisor-migration"),
  installationId: z.string().uuid(),
  identitySha256: digest,
  preconditionSha256: digest,
  precondition: InitialHostSupervisorPreconditionSchema,
  candidate: CoordinatorBootstrapPlanSchema.shape.candidate,
  fallback: CoordinatorBootstrapPlanSchema.shape.candidate,
  interruption: z.strictObject({
    finishTurnsSeconds: z.number().int().min(1).max(3600),
    terminateGraceSeconds: z.number().int().min(1).max(300),
  }),
});
export type InitialHostSupervisorMigrationPlan = z.infer<
  typeof InitialHostSupervisorMigrationPlanSchema
>;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function requireMatch(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(message);
}

/** Exact reviewed declarations only. Native custody, runtime artifact integrity
 * and safe interruption must be independently established before any effect. */
export function inspectInitialHostSupervisorMigrationPlan(value: unknown) {
  const plan = InitialHostSupervisorMigrationPlanSchema.parse(value);
  const previous = plan.precondition;
  const identity = previous.identity;
  requireMatch(
    identity.environment === "host" &&
      identity.target === "host" &&
      identity.installationId === plan.installationId &&
      enrollmentNativeIdentityDigest(identity) === plan.identitySha256 &&
      hash(previous) === plan.preconditionSha256,
    "Initial Host migration changed its exact precondition or identity",
  );
  requireMatch(
    (previous.workerInstanceSupport === "unsupported") === (previous.workerInstanceId === null),
    "Initial Host migration has inconsistent worker capability evidence",
  );
  requireMatch(
    plan.candidate.directory !== plan.fallback.directory &&
      plan.candidate.artifactSha256 !== plan.fallback.artifactSha256,
    "Initial Host migration requires a distinct compatible fallback",
  );
  for (const release of [plan.candidate, plan.fallback]) {
    requireMatch(
      path.posix.normalize(release.directory) === release.directory &&
        release.entrypoint.path ===
          path.join(release.directory, "packages/server/dist/scripts/supervisor-entrypoint.js") &&
        isDeepStrictEqual(release.node, previous.node) &&
        isDeepStrictEqual(release.configuration, previous.configuration),
      "Initial Host migration changed its startup or protected configuration",
    );
  }
  return { plan, planSha256: hash(plan) };
}

interface MigrationEnrollmentInput {
  journal: FileEnrollmentJournal;
  plan: unknown;
  grantId: string;
  grantRevision: string;
  stepId: string;
  generation: string;
}

/** Enrollment scope validation, not effect admission. The eventual intent writer
 * calls this under the existing lifecycle lock, alongside native custody and
 * prior/next exclusion. Reopening this binding cannot dispatch or repeat work. */
export function inspectInitialHostMigrationEnrollment(input: MigrationEnrollmentInput) {
  const { plan, planSha256 } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const { state, manifestSha256 } = requireMigrationGrant(input, plan);
  const { grant, activation } = state;
  const manifest = grant.manifest;
  const step = manifest.steps.find((item) => item.id === input.stepId);
  const reserved = activation.steps.find((item) => item.id === input.stepId);
  requireMatch(
    step?.target === "host" &&
      step.operation === "replacement" &&
      step.planSha256 === planSha256 &&
      reserved?.status === "reserved" &&
      reserved.generation === input.generation &&
      reserved.grantRevision === input.grantRevision,
    "Initial Host migration differs from its exact reserved step",
  );
  const artifact = (release: InitialHostSupervisorMigrationPlan["candidate"]) => ({
    sourceCommit: release.sourceCommit,
    artifactSha256: release.artifactSha256,
  });
  // For this initial migration, previous explicitly names the reviewed compatible
  // fallback. The incumbent service-custody record claims no loaded-code provenance.
  requireMatch(
    isDeepStrictEqual(step.candidate, artifact(plan.candidate)) &&
      isDeepStrictEqual(step.previous, artifact(plan.fallback)) &&
      isDeepStrictEqual(manifest.interruption, plan.interruption),
    "Initial Host migration changed its reviewed releases or interruption limits",
  );
  requireMigrationPrerequisites(step, activation);
  return {
    grantId: grant.id,
    grantRevision: grant.revision,
    manifestSha256,
    stepId: step.id,
    generation: reserved.generation,
    planSha256,
    preconditionSha256: plan.preconditionSha256,
    candidate: artifact(plan.candidate),
    fallback: artifact(plan.fallback),
  };
}

function requireMigrationGrant(
  input: MigrationEnrollmentInput,
  plan: InitialHostSupervisorMigrationPlan,
) {
  const state = input.journal.readUnderLifecycleLock();
  requireMatch(state.status === "enrolled", "Initial Host migration requires enrollment");
  const { grant, activation } = state;
  const manifest = grant.manifest;
  const manifestSha256 = enrollmentManifestDigest(manifest);
  const target = manifest.targets.find((item) => item.target === "host");
  requireMatch(
    grant.id === input.grantId &&
      grant.revision === input.grantRevision &&
      !grant.paused &&
      grant.revokedAt === null &&
      !grant.disabledTargets.includes("host") &&
      manifest.installationId === plan.installationId &&
      grant.approval.reviewRevision === manifest.revision &&
      grant.approval.manifestSha256 === manifestSha256 &&
      activation.manifestSha256 === manifestSha256 &&
      target?.identitySha256 === plan.identitySha256 &&
      target.operations.includes("replacement"),
    "Initial Host migration enrollment authority changed",
  );
  return { state, manifestSha256 };
}

function requireMigrationPrerequisites(step: EnrollmentStep, activation: InstallationActivation) {
  requireMatch(
    step.dependsOn.every((id) =>
      activation.steps.some((item) => item.id === id && item.status === "succeeded"),
    ) &&
      !activation.steps.some(
        (item) =>
          item.id !== step.id &&
          (item.status === "reserved" || item.status === "recovery_required"),
      ),
    "Initial Host migration prerequisites require reconciliation",
  );
}
