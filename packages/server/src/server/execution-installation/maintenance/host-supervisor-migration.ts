import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CoordinatorBootstrapPlanSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import type {
  InstallationActivation,
  EnrollmentStep,
} from "@getpaseo/protocol/installation-enrollment";
import {
  BootstrapRequestConflict,
  assertCoordinatorLifecycleIdle,
  openBootstrapRequests,
} from "../coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import {
  inspectBootstrapReleaseArtifacts,
  readBootstrapPreparedFile,
} from "../coordinator-bootstrap-artifact.js";
import { readBootstrapLauncher } from "../coordinator-bootstrap-service.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { InstallationConfigSchema } from "../config.js";
import {
  FileEnrollmentJournal,
  enrollmentManifestDigest,
  enrollmentWriteFiles,
  type EnrollmentWriteFiles,
} from "./authorization.js";
import { enrollmentNativeIdentityDigest } from "./native-identity.js";
import { InitialHostSupervisorPreconditionSchema } from "./native-daemon-inspection.js";
import type { inspectInitialHostSupervisorMigration } from "./native-daemon-inspection.js";
import { inspectInitialHostModuleContract } from "./host-startup-contract.js";
import { inspectInitialHostFallbackCopy } from "./host-supervisor-fallback.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const InitialHostSupervisorMigrationPlanSchema = z.strictObject({
  version: z.literal(3),
  operation: z.literal("initial-host-supervisor-migration"),
  managedReleaseRoot: z.string().startsWith("/").max(4096),
  installationId: z.string().uuid(),
  identitySha256: digest,
  preconditionSha256: digest,
  precondition: InitialHostSupervisorPreconditionSchema,
  candidate: CoordinatorBootstrapPlanSchema.shape.candidate,
  fallback: CoordinatorBootstrapPlanSchema.shape.candidate,
  fallbackProvenance: z.strictObject({
    path: z.string().startsWith("/").max(4096),
    sha256: digest,
  }),
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
  requireMatch(
    path.normalize(plan.managedReleaseRoot) === plan.managedReleaseRoot &&
      plan.candidate.directory.startsWith(plan.managedReleaseRoot + path.sep) &&
      identity.selectionPath !== null,
    "Initial Host migration changed its managed release root",
  );
  const launcherPaths = [
    previous.launcher.path,
    plan.candidate.launcher.path,
    plan.fallback.launcher.path,
  ];
  requireMatch(
    new Set(launcherPaths).size === launcherPaths.length &&
      plan.fallback.launcher.sha256 === previous.launcher.sha256,
    "Initial Host migration requires its original immutable persistent launcher",
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
  requireMatch(
    plan.fallback.sourceCommit === previous.sourceCommit &&
      plan.fallback.entrypoint.sha256 === previous.supervisorEntrypoint.sha256 &&
      previous.supervisorEntrypoint.path ===
        path.join(
          previous.selectedRelease,
          "packages/server/dist/scripts/supervisor-entrypoint.js",
        ) &&
      previous.workerEntrypoint.path ===
        path.join(
          previous.selectedRelease,
          "packages/server/dist/server/server/daemon-worker.js",
        ) &&
      previous.sourceReceipt.path ===
        path.join(previous.selectedRelease, ".installation-source.json"),
    "Initial Host migration changed its reviewed incumbent fallback",
  );
  return { plan, planSha256: hash(plan) };
}

/** Semantic binding supplements byte custody. The exact original bytes must be
 * retained separately because the installed plist will change during migration. */
export function verifyInitialHostMigrationLaunchers(input: {
  plan: unknown;
  sourceUpdates: unknown;
  current: unknown;
  fallback: unknown;
  candidate: unknown;
}) {
  const { plan } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  requireMatch(
    plan.precondition.identity.environment === "host",
    "Initial Host launcher identity is not native",
  );
  const selected = plan.precondition.identity.selectionPath;
  requireMatch(selected !== null, "Initial Host launcher selector is missing");
  const updates = z
    .object({ releaseRoot: z.string(), currentReleaseLink: z.string() })
    .parse(input.sourceUpdates);
  requireMatch(
    updates.releaseRoot === plan.managedReleaseRoot && updates.currentReleaseLink === selected,
    "Initial Host managed startup differs from configured source updates",
  );
  const record = z.record(z.string(), z.unknown());
  const current = record.parse(input.current);
  const fallback = record.parse(input.fallback);
  const candidate = record.parse(input.candidate);
  const previous = plan.precondition;
  const environment = z.record(z.string(), z.string()).parse(current.EnvironmentVariables);
  requireMatch(
    current.Label === plan.precondition.identity.serviceLabel &&
      isDeepStrictEqual(current.ProgramArguments, [
        previous.node.path,
        path.join(selected, "packages/server/dist/scripts/supervisor-entrypoint.js"),
      ]) &&
      isDeepStrictEqual(current.ProgramArguments, previous.registration.arguments) &&
      (current.Program ?? null) === previous.registration.program &&
      isDeepStrictEqual(environment, previous.registration.environment),
    "Initial Host original launcher differs from native registration",
  );
  requireMatch(
    isDeepStrictEqual(current, fallback),
    "Initial Host fallback launcher changed its original settings",
  );
  requireMatch(
    isDeepStrictEqual(candidate, {
      ...current,
      EnvironmentVariables: {
        ...environment,
        PASEO_MANAGED_RELEASE_LINK: selected,
        PASEO_MANAGED_RELEASE_ROOT: plan.managedReleaseRoot,
      },
    }),
    "Initial Host candidate launcher changes unreviewed settings",
  );
  verifyLegacyManagedFallback(plan, environment);
}

function verifyLegacyManagedFallback(
  plan: InitialHostSupervisorMigrationPlan,
  environment: Record<string, string>,
) {
  const link = environment.PASEO_MANAGED_RELEASE_LINK;
  const root = environment.PASEO_MANAGED_RELEASE_ROOT;
  if (!link && !root) return;
  requireMatch(
    link === plan.precondition.identity.selectionPath &&
      !!root &&
      path.isAbsolute(root) &&
      path.normalize(root) === root &&
      plan.fallback.directory.startsWith(root + path.sep),
    "Initial Host fallback no longer fits its original managed startup",
  );
}

async function inspectInitialHostMigrationLaunchers(
  plan: InitialHostSupervisorMigrationPlan,
  roots: readonly string[],
) {
  const assertCurrent = retainServiceFiles([
    plan.precondition.launcher.path,
    plan.candidate.launcher.path,
    plan.fallback.launcher.path,
    plan.precondition.configuration.path,
  ]);
  const configuration = InstallationConfigSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(plan.precondition.configuration, roots)).toString("utf8"),
    ),
  );
  const current = await readBootstrapLauncher(plan.precondition.launcher, roots);
  const fallback = await readBootstrapLauncher(plan.fallback.launcher, roots);
  const candidate = await readBootstrapLauncher(plan.candidate.launcher, roots);
  verifyInitialHostMigrationLaunchers({
    plan,
    sourceUpdates: configuration.sourceUpdates,
    current,
    fallback,
    candidate,
  });
  assertCurrent();
  return { assertCurrent };
}

interface MigrationEnrollmentInput {
  journal: FileEnrollmentJournal;
  plan: unknown;
  grantId: string;
  grantRevision: string;
  stepId: string;
  generation: string;
}

const InitialHostMigrationIntentSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  operation: z.literal("initial-host-supervisor-migration"),
  grantId: z.string().uuid(),
  grantRevision: z.string().uuid(),
  manifestSha256: digest,
  stepId: z.string().uuid(),
  generation: z.string().uuid(),
  planSha256: digest,
  identitySha256: digest,
  preconditionSha256: digest,
  observedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

interface InitialHostMigrationIntentInput extends Omit<MigrationEnrollmentInput, "journal"> {
  /** Verified controller state, never a review-supplied path. */
  enrollmentStateDirectory: string;
  native: Awaited<ReturnType<typeof inspectInitialHostSupervisorMigration>>;
  artifacts: Awaited<ReturnType<typeof inspectInitialHostMigrationArtifacts>>;
}

/** Consume the existing activation reservation exactly once. This writes only
 * its addressed intent; native interruption and selection remain separate,
 * unwired operations requiring their own current custody and grant checks. */
export function reserveInitialHostMigrationIntent(
  input: InitialHostMigrationIntentInput,
  files: Pick<EnrollmentWriteFiles, "open" | "write" | "sync" | "close"> = enrollmentWriteFiles,
) {
  const { plan, planSha256 } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const directory = input.enrollmentStateDirectory;
  const bootstrap = new FileBootstrapRequestJournal(directory);
  const journal = new FileEnrollmentJournal(directory);
  return bootstrap.withRecoveryTransaction((requests) => {
    if (openBootstrapRequests(requests).some((request) => request.execution))
      throw new BootstrapRequestConflict(
        "Coordinator execution conflicts with initial Host migration",
      );
    assertCoordinatorLifecycleIdle(bootstrap.readLifecycle());
    const binding = inspectInitialHostMigrationEnrollment({ ...input, journal, plan });
    assertInitialHostIntentProofs(input, plan, planSha256);
    requireMatch(
      isDeepStrictEqual(
        binding,
        inspectInitialHostMigrationEnrollment({ ...input, journal, plan }),
      ),
      "Initial Host migration authority changed during custody checks",
    );
    const parent = lstatSync(directory);
    requireMatch(
      realpathSync(directory) === directory &&
        parent.isDirectory() &&
        parent.uid === process.getuid?.() &&
        (parent.mode & 0o077) === 0,
      "Initial Host intent requires its private controller state",
    );
    const intent = InitialHostMigrationIntentSchema.parse({
      version: 1,
      id: randomUUID(),
      operation: "initial-host-supervisor-migration",
      grantId: binding.grantId,
      grantRevision: binding.grantRevision,
      manifestSha256: binding.manifestSha256,
      stepId: binding.stepId,
      generation: binding.generation,
      planSha256,
      identitySha256: plan.identitySha256,
      preconditionSha256: plan.preconditionSha256,
      observedAt: input.native.observedAt,
      createdAt: new Date().toISOString(),
    });
    const file = path.join(directory, `initial-host-${binding.stepId}-${binding.generation}.json`);
    const descriptor = files.open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      files.write(descriptor, JSON.stringify(intent));
      files.sync(descriptor);
    } finally {
      files.close(descriptor);
    }
    const parentDescriptor = files.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      files.sync(parentDescriptor);
    } finally {
      files.close(parentDescriptor);
    }
    return { file, intent };
  });
}

function assertInitialHostIntentProofs(
  input: InitialHostMigrationIntentInput,
  plan: InitialHostSupervisorMigrationPlan,
  planSha256: string,
) {
  const assertBinding = () =>
    requireMatch(
      input.native.preconditionSha256 === plan.preconditionSha256 &&
        hash(input.native.precondition) === plan.preconditionSha256 &&
        input.artifacts.planSha256 === planSha256 &&
        hash(input.artifacts.plan) === planSha256,
      "Initial Host migration proofs name different reviewed bytes",
    );
  assertBinding();
  if (input.native.assertCurrent() !== undefined || input.artifacts.assertCurrent() !== undefined)
    throw new BootstrapRequestConflict("Initial Host custody checks must remain synchronous");
  assertBinding();
  const observed = Date.parse(input.native.observedAt);
  const age = Date.now() - observed;
  requireMatch(
    Number.isFinite(age) && age >= 0 && age < 30_000,
    "Initial Host native proof is no longer fresh",
  );
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
  // Previous names the sealed legacy restoration, not new standing readiness.
  // Restoration must leave activation recovery_required, preserving dependencies.
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
  const referenceRoot = fileURLToPath(new URL("../../../../../../../", import.meta.url));
  const proofs: Array<{ assertCurrent(): void }> = [];
  proofs.push(await inspectInitialHostMigrationLaunchers(plan, roots));
  checkCollection();
  proofs.push(
    await inspectBootstrapReleaseArtifacts(plan.candidate, roots, {
      signal,
      timeoutMs: deadline - Date.now(),
      maxFiles: 100_000,
      maxBytes: 2 * 1024 ** 3,
    }),
  );
  checkCollection();
  proofs.push(
    await inspectInitialHostModuleContract({
      referenceRoot,
      candidateRoot: plan.candidate.directory,
      writableMountRoots: roots,
      signal,
    }),
  );
  checkCollection();
  proofs.push(
    await inspectInitialHostFallbackCopy({
      reference: plan.fallbackProvenance,
      release: plan.fallback,
      precondition: plan.precondition,
      writableMountRoots: roots,
      signal,
    }),
  );
  const assertCurrent = () => {
    signal.throwIfAborted();
    for (const proof of proofs) proof.assertCurrent();
    requireMatch(hash(plan) === planSha256, "Initial Host migration artifact plan changed");
    signal.throwIfAborted();
  };
  assertCurrent();
  checkCollection();
  return { plan, planSha256, assertCurrent };
}
