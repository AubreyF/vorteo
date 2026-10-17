import {
  inspectInitialHostSupervisorMigrationPlan,
  InitialHostMigrationIntentSchema,
  InitialHostMigrationClaimSchema,
  initialHostPublicationRecords,
  type InitialHostSupervisorMigrationPlan,
} from "./host-supervisor-contract.js";
export {
  InitialHostSupervisorMigrationPlanSchema,
  inspectInitialHostSupervisorMigrationPlan,
  InitialHostMigrationIntentSchema,
  InitialHostMigrationClaimSchema,
  initialHostPublicationRecords,
  type InitialHostSupervisorMigrationPlan,
} from "./host-supervisor-contract.js";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
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
import { readPrivateBootstrapConfiguration } from "../coordinator-bootstrap-private-configuration.js";
import {
  selectMaintenanceFiles,
  selectMaintenanceReleaseLink,
  retainMaintenancePublishedFile,
  retainMaintenancePublishedLink,
} from "../coordinator-bootstrap-maintenance-file-selection.js";
import {
  FileEnrollmentJournal,
  enrollmentManifestDigest,
  enrollmentWriteFiles,
  type EnrollmentWriteFiles,
} from "./authorization.js";
import type { inspectInitialHostSupervisorMigration } from "./native-daemon-inspection.js";
import { inspectInitialHostModuleContract } from "./host-startup-contract.js";
import { inspectInitialHostFallbackCopy } from "./host-supervisor-fallback.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function requireMatch(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(message);
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
    plan.candidate.launcher.path,
    plan.fallback.launcher.path,
    plan.precondition.configuration.path,
  ]);
  const configuration = InstallationConfigSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(plan.precondition.configuration, roots)).toString("utf8"),
    ),
  );
  const fallback = await readBootstrapLauncher(plan.fallback.launcher, roots);
  const candidate = await readBootstrapLauncher(plan.candidate.launcher, roots);
  verifyInitialHostMigrationLaunchers({
    plan,
    sourceUpdates: configuration.sourceUpdates,
    // Its exact pinned hash equals the original live launcher's hash. This copy
    // remains immutable when the live launcher is intentionally replaced.
    current: fallback,
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

interface InitialHostMigrationIntentInput extends Omit<MigrationEnrollmentInput, "journal"> {
  /** Verified controller state, never a review-supplied path. */
  enrollmentStateDirectory: string;
  native: Awaited<ReturnType<typeof inspectInitialHostSupervisorMigration>>;
  artifacts: Awaited<ReturnType<typeof inspectInitialHostMigrationArtifacts>>;
}

interface InitialHostMigrationPublicationInput extends Omit<
  MigrationEnrollmentInput,
  "journal" | "grantId" | "grantRevision"
> {
  enrollmentStateDirectory: string;
  candidateLauncher: Buffer;
  artifacts: Awaited<ReturnType<typeof inspectInitialHostMigrationArtifacts>>;
  executor: { process: unknown; assertCurrent(): void };
  absence: {
    identitySha256: string;
    preconditionSha256: string;
    bootId: string;
    observedAt: string;
    assertCurrent(): void;
  };
}

/** File phase of the claimed child, after independently proven native absence.
 * Both addressed attempts belong to the same claim. A partial result is for the
 * independent observer to reconcile; this function never resumes publication. */
export function publishInitialHostMigrationSelection(input: InitialHostMigrationPublicationInput) {
  const { plan, planSha256 } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const launcher = Buffer.from(input.candidateLauncher);
  requireMatch(
    createHash("sha256").update(launcher).digest("hex") === plan.candidate.launcher.sha256,
    "Initial Host candidate launcher bytes changed",
  );
  const executor = BootstrapProcessIdentitySchema.parse(input.executor.process);
  const directory = input.enrollmentStateDirectory;
  const bootstrap = new FileBootstrapRequestJournal(directory);
  const journal = new FileEnrollmentJournal(directory);
  return bootstrap.withRecoveryTransaction((requests) => {
    if (openBootstrapRequests(requests).some((request) => request.execution))
      throw new BootstrapRequestConflict("Coordinator execution conflicts with Host publication");
    assertCoordinatorLifecycleIdle(bootstrap.readLifecycle());
    const state = journal.readUnderLifecycleLock();
    requireMatch(state.status === "enrolled", "Initial Host publication requires enrollment");
    const bindingInput = {
      ...input,
      journal,
      plan,
      grantId: state.grant.id,
      grantRevision: state.grant.revision,
    };
    const binding = inspectInitialHostMigrationEnrollment(bindingInput);
    const intentFile = path.join(
      directory,
      `initial-host-${binding.stepId}-${binding.generation}.json`,
    );
    const claimFile = path.join(
      directory,
      `initial-host-claim-${binding.stepId}-${binding.generation}.json`,
    );
    const assertFiles = retainServiceFiles([intentFile, claimFile]);
    const intent = InitialHostMigrationIntentSchema.parse(
      readPrivateBootstrapConfiguration(intentFile, executor.uid),
    );
    const claim = InitialHostMigrationClaimSchema.parse(
      readPrivateBootstrapConfiguration(claimFile, executor.uid),
    );
    requireInitialHostClaimBinding(binding, intent, claim, executor);
    const assertCurrent = () => {
      assertFiles();
      requireMatch(
        input.executor.assertCurrent() === undefined && input.absence.assertCurrent() === undefined,
        "Initial Host publication requires synchronous native custody",
      );
      requireMatch(
        input.artifacts.assertPreparedCurrent() === undefined,
        "Initial Host prepared custody must be synchronous",
      );
      requireMatch(
        input.artifacts.planSha256 === planSha256 &&
          hash(input.artifacts.plan) === planSha256 &&
          input.absence.identitySha256 === plan.identitySha256 &&
          input.absence.preconditionSha256 === plan.preconditionSha256 &&
          input.absence.bootId === executor.bootId &&
          Date.now() - Date.parse(input.absence.observedAt) >= 0 &&
          Date.now() - Date.parse(input.absence.observedAt) < 30_000 &&
          isDeepStrictEqual(binding, inspectInitialHostMigrationEnrollment(bindingInput)) &&
          isDeepStrictEqual(executor, BootstrapProcessIdentitySchema.parse(input.executor.process)),
        "Initial Host publication authority or native absence changed",
      );
      assertFiles();
    };
    requireMatch(
      input.artifacts.assertCurrent() === undefined,
      "Initial Host artifact custody must be synchronous",
    );
    assertCurrent();
    const records = initialHostPublicationRecords({
      plan,
      intent,
      claim,
      enrollmentStateDirectory: directory,
    });
    const receipt = records.phase.record;
    const reservationSha256 = receipt.claimSha256;
    const launcherAttemptFile = records.launcherAttempt.file;
    const publicationFile = records.phase.file;
    const launcherAttempt = selectMaintenanceFiles({
      attemptFile: launcherAttemptFile,
      reservationSha256,
      launcher: {
        path: plan.precondition.launcher.path,
        previousSha256: plan.precondition.launcher.sha256,
        bytes: launcher,
      },
      selection: {
        path: publicationFile,
        previousSha256: null,
        bytes: Buffer.from(JSON.stringify(receipt)),
      },
      assertCurrent,
    });
    const assertLauncher = retainMaintenancePublishedFile(
      plan.precondition.launcher.path,
      launcher,
    );
    const selectorAttemptFile = records.selectorAttempt.file;
    const selectorAttempt = selectMaintenanceReleaseLink({
      attemptFile: selectorAttemptFile,
      reservationSha256,
      link: plan.precondition.identity.selectionPath!,
      previous: plan.precondition.selectedRelease,
      candidate: plan.candidate.directory,
      assertCurrent: () => {
        assertCurrent();
        assertLauncher();
      },
    });
    const assertLink = retainMaintenancePublishedLink(
      plan.precondition.identity.selectionPath!,
      plan.candidate.directory,
    );
    requireMatch(
      isDeepStrictEqual(launcherAttempt, records.launcherAttempt.record) &&
        isDeepStrictEqual(selectorAttempt, records.selectorAttempt.record),
      "Host publication attempt differs from its canonical record",
    );
    const retainedArtifacts = [
      retainMaintenancePublishedFile(publicationFile, Buffer.from(JSON.stringify(receipt))),
      retainMaintenancePublishedFile(
        launcherAttemptFile,
        Buffer.from(JSON.stringify(launcherAttempt)),
      ),
      retainMaintenancePublishedFile(
        selectorAttemptFile,
        Buffer.from(JSON.stringify(selectorAttempt)),
      ),
    ];
    const assertSelection = () => {
      requireMatch(
        input.artifacts.assertPreparedCurrent() === undefined,
        "Initial Host prepared custody must be synchronous",
      );
      requireMatch(
        input.artifacts.planSha256 === planSha256 && hash(input.artifacts.plan) === planSha256,
        "Initial Host prepared plan changed",
      );
      assertFiles();
      assertLauncher();
      assertLink();
      for (const assertArtifact of retainedArtifacts) assertArtifact();
    };
    assertCurrent();
    assertSelection();
    return { ...receipt, assertSelection };
  });
}

function requireInitialHostClaimBinding(
  binding: ReturnType<typeof inspectInitialHostMigrationEnrollment>,
  intent: z.infer<typeof InitialHostMigrationIntentSchema>,
  claim: z.infer<typeof InitialHostMigrationClaimSchema>,
  executor: z.infer<typeof BootstrapProcessIdentitySchema>,
) {
  requireMatch(
    intent.grantId === binding.grantId &&
      intent.grantRevision === binding.grantRevision &&
      intent.manifestSha256 === binding.manifestSha256 &&
      intent.stepId === binding.stepId &&
      intent.generation === binding.generation &&
      intent.planSha256 === binding.planSha256 &&
      intent.preconditionSha256 === binding.preconditionSha256 &&
      claim.intentId === intent.id &&
      claim.intentSha256 === hash(intent) &&
      claim.stepId === intent.stepId &&
      claim.generation === intent.generation &&
      claim.planSha256 === intent.planSha256 &&
      executor.pid === process.pid &&
      executor.uid === process.getuid?.() &&
      isDeepStrictEqual(claim.executor, executor),
    "Initial Host publication differs from its exact native claim",
  );
}

/** A reservation or saved intent does not authorize another child. This claim
 * is exclusive even if synchronization fails after creation. Native interruption
 * still requires its own retained custody before any service command. */
export function claimInitialHostMigration(
  input: InitialHostMigrationIntentInput & {
    executor: { process: unknown; assertCurrent(): void };
  },
  files: Pick<EnrollmentWriteFiles, "open" | "write" | "sync" | "close"> = enrollmentWriteFiles,
) {
  const { plan, planSha256 } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const executor = BootstrapProcessIdentitySchema.parse(input.executor.process);
  requireMatch(
    executor.pid === process.pid &&
      executor.uid === process.getuid?.() &&
      executor.bootId === plan.precondition.supervisor.bootId &&
      executor.pid !== plan.precondition.supervisor.pid &&
      executor.pid !== plan.precondition.worker.pid,
    "Initial Host claim requires its independent native child",
  );
  const directory = input.enrollmentStateDirectory;
  const bootstrap = new FileBootstrapRequestJournal(directory);
  const journal = new FileEnrollmentJournal(directory);
  return bootstrap.withRecoveryTransaction((requests) => {
    if (openBootstrapRequests(requests).some((request) => request.execution))
      throw new BootstrapRequestConflict("Coordinator execution conflicts with initial Host claim");
    assertCoordinatorLifecycleIdle(bootstrap.readLifecycle());
    const binding = inspectInitialHostMigrationEnrollment({ ...input, journal, plan });
    const intentFile = path.join(
      directory,
      `initial-host-${binding.stepId}-${binding.generation}.json`,
    );
    const retainIntent = retainServiceFiles([intentFile]);
    const intent = InitialHostMigrationIntentSchema.parse(
      readPrivateBootstrapConfiguration(intentFile, executor.uid),
    );
    requireMatch(
      intent.grantId === binding.grantId &&
        intent.grantRevision === binding.grantRevision &&
        intent.manifestSha256 === binding.manifestSha256 &&
        intent.stepId === binding.stepId &&
        intent.generation === binding.generation &&
        intent.planSha256 === planSha256 &&
        intent.identitySha256 === plan.identitySha256 &&
        intent.preconditionSha256 === plan.preconditionSha256,
      "Initial Host claim differs from its retained intent",
    );
    requireMatch(
      input.executor.assertCurrent() === undefined,
      "Initial Host child custody must be synchronous",
    );
    assertInitialHostIntentProofs(input, plan, planSha256);
    retainIntent();
    requireMatch(
      isDeepStrictEqual(
        binding,
        inspectInitialHostMigrationEnrollment({ ...input, journal, plan }),
      ) &&
        isDeepStrictEqual(executor, BootstrapProcessIdentitySchema.parse(input.executor.process)),
      "Initial Host claim authority changed during native verification",
    );
    const claim = InitialHostMigrationClaimSchema.parse({
      version: 1,
      operation: "initial-host-supervisor-migration",
      intentId: intent.id,
      intentSha256: hash(intent),
      stepId: binding.stepId,
      generation: binding.generation,
      planSha256,
      executor,
      consumedAt: new Date().toISOString(),
    });
    const file = path.join(
      directory,
      `initial-host-claim-${binding.stepId}-${binding.generation}.json`,
    );
    writeInitialHostArtifact(directory, file, claim, files);
    return { file, claim, intentFile, intent };
  });
}

export function writeInitialHostArtifact(
  directory: string,
  file: string,
  value: unknown,
  files: Pick<EnrollmentWriteFiles, "open" | "write" | "sync" | "close"> = enrollmentWriteFiles,
) {
  requireMatch(
    path.isAbsolute(file) && path.dirname(file) === directory,
    "Initial Host artifact must remain in its private controller state",
  );
  const parent = lstatSync(directory);
  requireMatch(
    realpathSync(directory) === directory &&
      parent.isDirectory() &&
      parent.uid === process.getuid?.() &&
      (parent.mode & 0o077) === 0,
    "Initial Host effect requires its private controller state",
  );
  const descriptor = files.open(
    file,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    files.write(descriptor, JSON.stringify(value));
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

export function assertInitialHostIntentProofs(
  input: Pick<InitialHostMigrationIntentInput, "native" | "artifacts">,
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
  const { plan } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const signal = input.signal;
  const roots = [...input.writableMountRoots];
  const started = Date.now();
  const original = retainServiceFiles([plan.precondition.launcher.path]);
  signal.throwIfAborted();
  await readBootstrapPreparedFile(plan.precondition.launcher, roots);
  original();
  const prepared = await inspectInitialHostPreparedArtifacts({
    plan,
    writableMountRoots: roots,
    signal,
  });
  const assertCurrent = () => {
    original();
    prepared.assertPreparedCurrent();
    original();
  };
  assertCurrent();
  requireMatch(Date.now() - started < 30_000, "Initial Host artifact collection deadline exceeded");
  return { ...prepared, assertCurrent };
}

/** Prepared integrity and launcher semantics remain inspectable after live
 * publication. This grants neither incumbent custody nor effect authority. */
export async function inspectInitialHostPreparedArtifacts(input: {
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
  const launcherProof = await inspectInitialHostMigrationLaunchers(plan, roots);
  const proofs: Array<{ assertCurrent(): void }> = [launcherProof];
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
  const assertPreparedCurrent = () => {
    signal.throwIfAborted();
    for (const proof of proofs) proof.assertCurrent();
    requireMatch(hash(plan) === planSha256, "Initial Host migration artifact plan changed");
    signal.throwIfAborted();
  };
  const assertCurrent = () => {
    launcherProof.assertCurrent();
    assertPreparedCurrent();
    launcherProof.assertCurrent();
  };
  assertCurrent();
  checkCollection();
  return { plan, planSha256, assertCurrent, assertPreparedCurrent };
}
