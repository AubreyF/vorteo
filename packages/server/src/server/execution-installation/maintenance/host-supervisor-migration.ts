import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CoordinatorBootstrapPlanSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import type {
  InstallationActivation,
  EnrollmentStep,
} from "@getpaseo/protocol/installation-enrollment";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import {
  inspectBootstrapReleaseArtifacts,
  assertBootstrapPathsProtected,
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "../coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
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
      release.launcher.sha256 === previous.launcher.sha256,
      "Initial Host migration changed its reviewed persistent launcher",
    );
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

// These modules implement the initial migration's launch, selector, lock and
// native-argv contract. This is deliberately stricter than source-version checks.
const initialHostContractFiles = [
  "scripts/supervisor-entrypoint.js",
  "scripts/supervisor.js",
  "scripts/managed-release.js",
  "scripts/supervisor-log-config.js",
  "server/server/daemon-worker.js",
  "server/server/pid-lock.js",
  "server/server/paseo-home.js",
  "server/server/daemon-instance.js",
  "server/server/private-files.js",
  "server/server/persisted-config.js",
  "server/server/host-name.js",
  "server/server/config-environment.js",
  "server/server/local-credential.js",
  "server/server/config-writer.js",
  "server/server/agent/provider-launch-config.js",
  "server/utils/tree-kill.js",
  "src/server/pid-lock.js",
  "src/server/paseo-home.js",
  "src/server/daemon-instance.js",
  "src/server/private-files.js",
  "src/server/persisted-config.js",
  "src/server/host-name.js",
  "src/server/config-environment.js",
  "src/server/local-credential.js",
  "src/server/config-writer.js",
  "src/server/agent/provider-launch-config.js",
  "src/utils/tree-kill.js",
] as const;

/** Reviewed bytes and a known startup contract, not permission to interrupt or
 * replace the incumbent. The executing runtime needs independent native custody. */
export async function inspectInitialHostMigrationArtifacts(input: {
  plan: unknown;
  writableMountRoots: readonly string[];
  signal: AbortSignal;
}) {
  const { plan, planSha256 } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const signal = input.signal;
  const roots = [...input.writableMountRoots];
  const deadline = Date.now() + 30_000;
  const checkCollection = () => {
    signal.throwIfAborted();
    requireMatch(Date.now() < deadline, "Initial Host artifact collection deadline exceeded");
  };
  checkCollection();
  const trustedRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const trustedFiles = initialHostContractFiles.map((name) => path.join(trustedRoot, name));
  const assertContract = retainServiceFiles(trustedFiles);
  await assertBootstrapPathsProtected(trustedFiles, roots);
  const contract: Array<{ name: string; sha256: string }> = [];
  for (const [index, name] of initialHostContractFiles.entries()) {
    checkCollection();
    const bytes = await readProtectedDocument(trustedFiles[index]);
    contract.push({ name, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const proofs: Array<{ assertCurrent(): void }> = [];
  for (const release of [plan.candidate, plan.fallback]) {
    checkCollection();
    const proof = await inspectBootstrapReleaseArtifacts(release, roots, {
      signal,
      timeoutMs: deadline - Date.now(),
      maxFiles: 100_000,
      maxBytes: 2 * 1024 * 1024 * 1024,
    });
    proofs.push(proof);
    for (const entry of contract) {
      checkCollection();
      await readBootstrapPreparedFile(
        {
          path: path.join(release.directory, "packages/server/dist", entry.name),
          sha256: entry.sha256,
        },
        roots,
      );
    }
    proof.assertCurrent();
  }
  const assertCurrent = () => {
    signal.throwIfAborted();
    assertContract();
    for (const proof of proofs) proof.assertCurrent();
    requireMatch(hash(plan) === planSha256, "Initial Host migration artifact plan changed");
    signal.throwIfAborted();
  };
  assertCurrent();
  checkCollection();
  return { plan, planSha256, assertCurrent };
}
