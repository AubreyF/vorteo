import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, openSync, closeSync, fsyncSync, existsSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { z } from "zod";
import { InstallationConfigSchema } from "../config.js";
import { BootstrapAdmissionSetupSchema } from "../coordinator-bootstrap-host.js";
import { BootstrapRunnerSetupSchema } from "../coordinator-bootstrap-runner.js";
import { readBootstrapPreparedFile } from "../coordinator-bootstrap-artifact.js";
import {
  retainMaintenancePublishedFile,
  retainMaintenancePublishedLink,
} from "../coordinator-bootstrap-maintenance-file-selection.js";
import {
  BootstrapRequestConflict,
  assertCoordinatorLifecycleIdle,
  openBootstrapRequests,
} from "../coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import { readPrivateBootstrapConfiguration } from "../coordinator-bootstrap-private-configuration.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { readBoundedMaintenanceInspection } from "../coordinator-bootstrap-maintenance-service-native.js";
import {
  verifyRetainedProcessExited,
  type NativeBootstrapServiceReader,
} from "../coordinator-bootstrap-service.js";
import {
  FileEnrollmentJournal,
  enrollmentManifestDigest,
  observeActivationStep,
  reconcileActivationStep,
} from "./authorization.js";
import {
  claimInitialHostMigration,
  inspectInitialHostMigrationEnrollment,
  inspectInitialHostSupervisorMigrationPlan,
  publishInitialHostMigrationSelection,
  writeInitialHostArtifact,
  InitialHostMigrationClaimSchema,
  InitialHostMigrationIntentSchema,
  inspectInitialHostPreparedArtifacts,
  initialHostPublicationRecords,
  type InitialHostSupervisorMigrationPlan,
} from "./host-supervisor-migration.js";
import {
  inspectEnrollmentDaemonIdentity,
  retainNativeHostServiceCustody,
  type EnrollmentDaemonObservation,
} from "./native-daemon-inspection.js";

type ExecutionInput = Parameters<typeof claimInitialHostMigration>[0];
type AbsenceProof = Parameters<typeof publishInitialHostMigrationSelection>[0]["absence"];
type Claimed = ReturnType<typeof claimInitialHostMigration>;
interface HostExecutionContext extends Claimed {
  plan: InitialHostSupervisorMigrationPlan;
  planSha256: string;
}

interface HostObservationPorts {
  reader: HostTransitionPorts["reader"];
  /** Called only after independently verified executor exit. This factory must
   * verify prepared runtime custody and both exact published selections. */
  collectCandidate(
    context: HostExecutionContext,
    signal: AbortSignal,
  ): Promise<{
    observation: EnrollmentDaemonObservation;
    assertSelection(): void;
  }>;
}

/** Exact published bytes only. The caller must additionally retain prepared
 * runtime and ordinary native custody before accepting candidate readiness. */
export function inspectInitialHostCandidatePublication(
  context: HostExecutionContext,
  launcher: Buffer,
) {
  const { plan, claim, intent, planSha256 } = context;
  requireMatch(sha(plan) === planSha256, "Host publication differs from its exact claim");
  requireMatch(
    createHash("sha256").update(launcher).digest("hex") === plan.candidate.launcher.sha256,
    "Host published launcher differs from candidate",
  );
  const records = initialHostPublicationRecords({
    plan,
    intent,
    claim,
    enrollmentStateDirectory: path.dirname(context.file),
  });
  const proofs = [
    retainMaintenancePublishedFile(
      records.phase.file,
      Buffer.from(JSON.stringify(records.phase.record)),
    ),
    retainMaintenancePublishedFile(
      records.launcherAttempt.file,
      Buffer.from(JSON.stringify(records.launcherAttempt.record)),
    ),
    retainMaintenancePublishedFile(
      records.selectorAttempt.file,
      Buffer.from(JSON.stringify(records.selectorAttempt.record)),
    ),
    retainMaintenancePublishedFile(plan.precondition.launcher.path, launcher),
    retainMaintenancePublishedLink(
      plan.precondition.identity.selectionPath!,
      plan.candidate.directory,
    ),
  ];
  return () => {
    for (const proof of proofs) proof();
  };
}

/** Production read-only collection. Use only behind the observer's exact child
 * exit gate; this intentionally contains no service or publication commands. */
export async function collectInitialHostCandidate(
  context: HostExecutionContext,
  writableMountRoots: readonly string[],
  signal: AbortSignal,
) {
  const roots = [...writableMountRoots];
  const prepared = await inspectInitialHostPreparedArtifacts({
    plan: context.plan,
    writableMountRoots: roots,
    signal,
  });
  const configuration = context.plan.precondition.configuration;
  const configFiles = retainServiceFiles([configuration.path]);
  const config = InstallationConfigSchema.parse(
    JSON.parse((await readBootstrapPreparedFile(configuration, roots)).toString("utf8")),
  );
  configFiles();
  const launcher = await readBootstrapPreparedFile(context.plan.candidate.launcher, roots);
  const publication = inspectInitialHostCandidatePublication(context, launcher);
  const observation = await inspectEnrollmentDaemonIdentity(
    config,
    context.plan.precondition.identity,
  );
  const native = await retainCandidateNativeCustody(context, observation, roots);
  signal.throwIfAborted();
  requireMatch(
    isDeepStrictEqual([...observation.writableMountRoots].sort(), roots.sort()),
    "Host candidate mount custody changed during observation",
  );
  const assertSelection = () => {
    signal.throwIfAborted();
    requireMatch(
      prepared.assertPreparedCurrent() === undefined,
      "Host prepared observation custody must be synchronous",
    );
    configFiles();
    publication();
    requireMatch(
      sha(context.plan) === prepared.planSha256 && context.planSha256 === prepared.planSha256,
      "Host candidate prepared plan changed",
    );
    signal.throwIfAborted();
    const age = Date.now() - Date.parse(observation.observedAt);
    requireMatch(age >= 0 && age < 30_000, "Host native candidate custody expired");
  };
  const assertNative = () => {
    requireMatch(
      observation.assertCurrent() === undefined && native() === undefined,
      "Host native observation custody must be synchronous",
    );
    assertSelection();
  };
  assertNative();
  return { observation: { ...observation, assertCurrent: assertNative }, assertSelection };
}

async function retainCandidateNativeCustody(
  context: HostExecutionContext,
  observed: EnrollmentDaemonObservation,
  roots: string[],
) {
  const original = context.plan.precondition;
  const runnerFile = path.join(
    original.identity.installationRoot,
    "coordinator-bootstrap-runner.json",
  );
  const runnerFiles = retainServiceFiles([runnerFile]);
  const runner = BootstrapRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(runnerFile, nativeUid()),
  );
  const admissionFiles = retainServiceFiles([runner.admissionSetupFile]);
  const setup = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(runner.admissionSetupFile, nativeUid()),
  );
  requireMatch(
    setup.configurationFile === original.configuration.path,
    "Host native candidate admission configuration changed",
  );
  const environment = {
    ...original.registration.environment,
    PASEO_MANAGED_RELEASE_LINK: original.identity.selectionPath!,
    PASEO_MANAGED_RELEASE_ROOT: context.plan.managedReleaseRoot,
  };
  const native = await retainNativeHostServiceCustody(setup, roots, {
    identity: original.identity,
    registration: {
      program: original.registration.program,
      arguments: original.registration.arguments,
      environment,
      loadedEnvironment: {
        ...original.registration.loadedEnvironment,
        PASEO_MANAGED_RELEASE_LINK: original.identity.selectionPath!,
        PASEO_MANAGED_RELEASE_ROOT: context.plan.managedReleaseRoot,
      },
    },
    supervisor: observed.supervisor,
    worker: observed.worker,
  });
  return () => {
    runnerFiles();
    admissionFiles();
    native();
    runnerFiles();
    admissionFiles();
  };
}

interface InitialHostObservationInput {
  enrollmentStateDirectory: string;
  plan: unknown;
  stepId: string;
  generation: string;
}

/** Protected control metadata only. Callers must prove this exact executor
 * exited before collecting any target files or runtime artifacts. */
export function readInitialHostRetainedClaim(input: InitialHostObservationInput) {
  const stepId = z.uuid().parse(input.stepId);
  const generation = z.uuid().parse(input.generation);
  const inspected = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const directory = input.enrollmentStateDirectory;
  const intentFile = path.join(directory, `initial-host-${stepId}-${generation}.json`);
  const file = path.join(directory, `initial-host-claim-${stepId}-${generation}.json`);
  const files = retainServiceFiles([intentFile, file]);
  const uid = nativeUid();
  const intent = InitialHostMigrationIntentSchema.parse(
    readPrivateBootstrapConfiguration(intentFile, uid),
  );
  const claim = InitialHostMigrationClaimSchema.parse(readPrivateBootstrapConfiguration(file, uid));
  requireMatch(
    intent.stepId === stepId &&
      intent.generation === generation &&
      intent.planSha256 === inspected.planSha256 &&
      intent.identitySha256 === inspected.plan.identitySha256 &&
      intent.preconditionSha256 === inspected.plan.preconditionSha256 &&
      claim.stepId === stepId &&
      claim.generation === generation &&
      claim.intentId === intent.id &&
      claim.intentSha256 === sha(intent) &&
      claim.planSha256 === inspected.planSha256,
    "Host observation differs from its retained claim",
  );
  files();
  const context = { ...inspected, file, intentFile, intent, claim };
  const retained = retainHostClaim(directory, context);
  retained();
  return { context, assertCurrent: retained };
}

/** Reopening is observation-only, including after revocation. No command port,
 * child constructor or publication operation is available on this path. */
export async function observeInitialHostMigrationTransition(
  input: InitialHostObservationInput,
  ports: HostObservationPorts,
) {
  const { context, assertCurrent: retained } = readInitialHostRetainedClaim(input);
  const { claim } = context;
  await verifyRetainedProcessExited(ports.reader, claim.executor);
  retained();
  const collected = await readBoundedMaintenanceInspection(
    (signal) => ports.collectCandidate(context, signal),
    { timeoutMs: 30_000, detail: "Host retained candidate observation timed out" },
  );
  return recordHostCandidate(input.enrollmentStateDirectory, context, collected.observation, () => {
    requireMatch(
      collected.assertSelection() === undefined,
      "Host retained selection custody must be synchronous",
    );
    retained();
  });
}
interface InterruptedHostCustody {
  claimSha256: string;
  planSha256: string;
  interruption: InitialHostSupervisorMigrationPlan["interruption"];
  assertCurrent(): void;
}
interface HostTransitionPorts {
  /** Independently collected native mount roots, retained by prepared custody. */
  writableMountRoots: readonly string[];
  reader: Pick<
    NativeBootstrapServiceReader,
    "verifyProcessExited" | "inspectProcess" | "verifyServiceAbsent"
  >;
  /** Established by the tracked child, never an HTTP callback or idle inventory.
   * The proof must retain closed provider custody after native target retirement. */
  interrupt(context: HostExecutionContext): Promise<InterruptedHostCustody>;
  /** Fresh exact registration/process custody after interruption. An already
   * retired target requires independently verified absence, not a failed read. */
  collectRetirement(
    context: HostExecutionContext,
  ): Promise<
    | { status: "present"; native: ExecutionInput["native"] }
    | { status: "absent"; absence: AbsenceProof }
  >;
  collectAbsence(context: HostExecutionContext): Promise<AbsenceProof>;
  readCandidate(signal: AbortSignal): Promise<EnrollmentDaemonObservation>;
  command?: { run(args: readonly string[]): Promise<void> };
}
const nativeCommand = {
  async run(args: readonly string[]) {
    await promisify(execFile)("/bin/launchctl", [...args], {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10_000,
      maxBuffer: 8192,
    });
  },
};
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireMatch(value: unknown, detail: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(detail);
}

function nativeUid() {
  const uid = process.getuid?.();
  requireMatch(uid !== undefined, "Host transition requires a native account");
  return uid;
}

/** Exactly one claimed child owns the service effects. An error, including a
 * lost bootstrap reply, leaves the claim and file attempts for independent
 * observation. This path never retries native commands or guesses rollback. */
export async function executeInitialHostMigrationTransition(
  input: ExecutionInput,
  ports: HostTransitionPorts,
) {
  const writableMountRoots = [...ports.writableMountRoots];
  const inspected = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const context: HostExecutionContext = { ...inspected, ...claimInitialHostMigration(input) };
  const retained = retainHostClaim(input.enrollmentStateDirectory, context);
  const assertActive = () => assertActiveHostClaim(input, context, retained);
  assertActive();
  const interrupted = await ports.interrupt(context);
  const assertInterrupted = () => {
    requireMatch(
      interrupted.assertCurrent() === undefined &&
        interrupted.claimSha256 === sha(context.claim) &&
        interrupted.planSha256 === context.planSha256 &&
        isDeepStrictEqual(interrupted.interruption, context.plan.interruption),
      "Host interruption custody differs from its exact claim",
    );
  };
  assertInterrupted();
  assertActive();
  const identity = context.plan.precondition.identity;
  requireMatch(identity.environment === "host", "Host transition requires native registration");
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  const command = ports.command ?? nativeCommand;
  const retirement = await ports.collectRetirement(context);
  assertInterrupted();
  assertActive();
  if (retirement.status === "present") {
    requireMatch(
      retirement.native.assertCurrent() === undefined &&
        retirement.native.preconditionSha256 === context.plan.preconditionSha256 &&
        isDeepStrictEqual(retirement.native.precondition, context.plan.precondition) &&
        Date.now() - Date.parse(retirement.native.observedAt) >= 0 &&
        Date.now() - Date.parse(retirement.native.observedAt) < 30_000,
      "Host registration changed before retirement",
    );
    await command.run(["bootout", service]);
  } else {
    assertHostAbsence(context, retirement.absence);
  }
  await waitForHostRetirement(ports.reader, context, service);
  assertInterrupted();
  assertActive();
  const absence = await ports.collectAbsence(context);
  assertInterrupted();
  assertActive();
  const launcher = await readBoundedMaintenanceInspection(
    async () => {
      return readBootstrapPreparedFile(context.plan.candidate.launcher, writableMountRoots);
    },
    { timeoutMs: 10_000, detail: "Host launcher collection timed out" },
  );
  const published = publishInitialHostMigrationSelection({
    ...input,
    candidateLauncher: launcher,
    absence: {
      ...absence,
      assertCurrent: () => {
        assertInterrupted();
        requireMatch(
          absence.assertCurrent() === undefined,
          "Host absence custody must be synchronous",
        );
        assertInterrupted();
      },
    },
  });
  await ports.reader.verifyServiceAbsent(service);
  assertInterrupted();
  assertActive();
  published.assertSelection();
  assertHostAbsence(context, absence);
  await command.run(["bootstrap", identity.serviceDomain, identity.launcherPath]);
  const observation = await readHostCandidate(ports.readCandidate);
  return recordHostCandidate(input.enrollmentStateDirectory, context, observation, () => {
    retained();
    requireMatch(
      input.executor.assertCurrent() === undefined &&
        isDeepStrictEqual(input.executor.process, context.claim.executor),
      "Host child custody changed",
    );
    published.assertSelection();
  });
}

/** Bootout can return while its process is exiting. Reconcile the one consumed
 * effect with bounded native reads; this never extends signal authority. */
async function waitForHostRetirement(
  reader: HostTransitionPorts["reader"],
  context: HostExecutionContext,
  service: string,
) {
  await readBoundedMaintenanceInspection(
    async (signal) => {
      for (;;) {
        signal.throwIfAborted();
        try {
          await verifyRetainedProcessExited(reader, context.plan.precondition.supervisor);
          signal.throwIfAborted();
          await verifyRetainedProcessExited(reader, context.plan.precondition.worker);
          signal.throwIfAborted();
          await reader.verifyServiceAbsent(service);
          signal.throwIfAborted();
          return;
        } catch {
          signal.throwIfAborted();
          await new Promise<void>((resolve, reject) => {
            function finished() {
              signal.removeEventListener("abort", aborted);
              resolve();
            }
            function aborted() {
              clearTimeout(timer);
              reject(signal.reason);
            }
            const timer = setTimeout(finished, 100);
            signal.addEventListener("abort", aborted, { once: true });
          });
        }
      }
    },
    { timeoutMs: 30_000, detail: "Host retirement remains unverified after bootout" },
  );
}

function assertHostAbsence(context: HostExecutionContext, absence: AbsenceProof) {
  requireMatch(
    absence.assertCurrent() === undefined &&
      absence.identitySha256 === context.plan.identitySha256 &&
      absence.preconditionSha256 === context.plan.preconditionSha256 &&
      absence.bootId === context.claim.executor.bootId &&
      Date.now() - Date.parse(absence.observedAt) >= 0 &&
      Date.now() - Date.parse(absence.observedAt) < 30_000,
    "Host target absence changed before launch",
  );
}

function retainHostClaim(directory: string, context: HostExecutionContext) {
  const files = retainServiceFiles([context.file, context.intentFile]);
  return () => {
    files();
    requireMatch(sha(context.plan) === context.planSha256, "Retained Host transition plan changed");
    requireMatch(
      isDeepStrictEqual(
        context.claim,
        readPrivateBootstrapConfiguration(context.file, context.claim.executor.uid),
      ) &&
        isDeepStrictEqual(
          context.intent,
          readPrivateBootstrapConfiguration(context.intentFile, context.claim.executor.uid),
        ),
      "Retained Host claim changed",
    );
    assertHostHistory(new FileEnrollmentJournal(directory), context);
    files();
  };
}

function assertActiveHostClaim(
  input: ExecutionInput,
  context: HostExecutionContext,
  retained: () => void,
) {
  const bootstrap = new FileBootstrapRequestJournal(input.enrollmentStateDirectory);
  bootstrap.withRecoveryTransaction((requests) => {
    if (openBootstrapRequests(requests).some((request) => request.execution))
      throw new BootstrapRequestConflict("Coordinator execution conflicts with Host transition");
    assertCoordinatorLifecycleIdle(bootstrap.readLifecycle());
    const binding = inspectInitialHostMigrationEnrollment({
      ...input,
      journal: new FileEnrollmentJournal(input.enrollmentStateDirectory),
    });
    requireMatch(
      binding.planSha256 === context.planSha256 && binding.generation === context.claim.generation,
      "Host transition reservation changed",
    );
    requireMatch(
      input.executor.assertCurrent() === undefined &&
        input.artifacts.assertPreparedCurrent() === undefined,
      "Host transition custody must be synchronous",
    );
    requireMatch(
      isDeepStrictEqual(input.executor.process, context.claim.executor) &&
        input.artifacts.planSha256 === context.planSha256 &&
        sha(input.artifacts.plan) === context.planSha256,
      "Host transition child or prepared plan changed",
    );
    retained();
    inspectInitialHostMigrationEnrollment({
      ...input,
      journal: new FileEnrollmentJournal(input.enrollmentStateDirectory),
    });
  });
}

/** Observation retains original manifest and dispatch identity after revocation.
 * It neither authorizes another child nor substitutes a current grant revision. */
function assertHostHistory(journal: FileEnrollmentJournal, context: HostExecutionContext) {
  const state = journal.readPolicySnapshot();
  requireMatch(state.status === "enrolled", "Host transition enrollment is unavailable");
  const manifestSha256 = enrollmentManifestDigest(state.grant.manifest);
  const planned = state.grant.manifest.steps.find((step) => step.id === context.intent.stepId);
  const progress = state.activation.steps.find((step) => step.id === context.intent.stepId);
  requireMatch(
    state.grant.id === context.intent.grantId &&
      manifestSha256 === context.intent.manifestSha256 &&
      state.grant.approval.manifestSha256 === manifestSha256 &&
      state.activation.manifestSha256 === manifestSha256 &&
      planned?.target === "host" &&
      planned.operation === "replacement" &&
      planned.planSha256 === context.planSha256 &&
      progress &&
      progress.status !== "pending" &&
      progress.generation === context.intent.generation &&
      progress.grantRevision === context.intent.grantRevision,
    "Host transition history differs from its original dispatch",
  );
  return progress;
}

function readHostCandidate(read: HostTransitionPorts["readCandidate"]) {
  return readBoundedMaintenanceInspection(read, {
    timeoutMs: 30_000,
    detail: "Host candidate readiness timed out",
  });
}

function requireHostCandidate(
  context: HostExecutionContext,
  observed: EnrollmentDaemonObservation,
) {
  const age = Date.now() - Date.parse(observed.observedAt);
  requireMatch(age >= 0 && age < 30_000, "Host candidate observation is stale");
  const previous = context.plan.precondition;
  requireMatch(
    observed.identitySha256 === context.plan.identitySha256 &&
      isDeepStrictEqual(observed.descriptor, previous.identity) &&
      observed.serverId === previous.serverId &&
      observed.sourceCommit === context.plan.candidate.sourceCommit &&
      observed.selectedRelease === context.plan.candidate.directory &&
      observed.supervisor.bootId === context.claim.executor.bootId &&
      observed.worker.bootId === context.claim.executor.bootId &&
      !isDeepStrictEqual(observed.supervisor, previous.supervisor) &&
      !isDeepStrictEqual(observed.worker, previous.worker),
    "Host readiness does not name the reviewed candidate",
  );
  for (const process of [observed.supervisor, observed.worker]) {
    const birth = /^([0-9]+):([0-9]{1,6})$/.exec(process.startIdentity);
    requireMatch(
      birth &&
        BigInt(birth[1]) * 1_000_000n + BigInt(birth[2]) >=
          BigInt(Date.parse(context.claim.consumedAt)) * 1000n,
      "Host candidate lifetime predates its native claim",
    );
  }
}

function recordHostCandidate(
  directory: string,
  context: HostExecutionContext,
  observed: EnrollmentDaemonObservation,
  assertSelection: () => void,
) {
  requireHostCandidate(context, observed);
  const snapshot = () =>
    structuredClone({
      version: 1,
      intentId: context.intent.id,
      claimSha256: sha(context.claim),
      stepId: context.intent.stepId,
      generation: context.intent.generation,
      planSha256: context.planSha256,
      outcome: "candidate",
      identitySha256: context.plan.identitySha256,
      observedAt: observed.observedAt,
      serverId: observed.serverId,
      sourceCommit: observed.sourceCommit,
      selectedRelease: observed.selectedRelease,
      supervisor: observed.supervisor,
      worker: observed.worker,
    });
  const record = snapshot();
  const assertCurrent = () => {
    requireMatch(
      assertSelection() === undefined && observed.assertCurrent() === undefined,
      "Host candidate custody must be synchronous",
    );
    requireMatch(assertSelection() === undefined, "Host selection custody must be synchronous");
    requireMatch(isDeepStrictEqual(snapshot(), record), "Host candidate observation changed");
    requireHostCandidate(context, observed);
  };
  assertCurrent();
  const file = path.join(directory, `initial-host-result-${context.intent.id}.json`);
  const retainedRecord = existsSync(file)
    ? readRetainedHostResult(file, record, assertCurrent)
    : (writeInitialHostArtifact(directory, file, record), record);
  requireMatch(
    Date.parse(retainedRecord.observedAt) >= Date.parse(context.claim.consumedAt),
    "Host result predates its consumed claim",
  );
  const retainResult = retainServiceFiles([file]);
  const observationSha256 = sha(retainedRecord);
  const journal = new FileEnrollmentJournal(directory);
  const progress = assertHostHistory(journal, context);
  const observation = {
    stepId: context.intent.stepId,
    generation: context.intent.generation,
    outcome: "succeeded",
    observationSha256,
    assertCurrent: () => {
      assertCurrent();
      retainResult();
    },
  } as const;
  if (progress.status === "recovery_required") {
    reconcileActivationStep(journal, {
      ...observation,
      id: context.intent.id,
      failedObservationSha256: progress.observationSha256,
    });
  } else observeActivationStep(journal, observation);
  return { file, record: retainedRecord, observationSha256 };
}

/** An existing exact result can survive a lost journal reply. Reopening never
 * replaces it with a newer process or timestamp, and retries its fsync before
 * acknowledging success. Partial or substituted records remain uncertain. */
function readRetainedHostResult<T extends { observedAt: string }>(
  file: string,
  expected: T,
  assertCurrent: () => void,
): T {
  const retained = retainServiceFiles([file]);
  const record = readPrivateBootstrapConfiguration(file, nativeUid()) as T;
  requireMatch(
    record !== null &&
      typeof record === "object" &&
      Number.isFinite(Date.parse(record.observedAt)) &&
      Date.parse(record.observedAt) <= Date.parse(expected.observedAt) &&
      isDeepStrictEqual({ ...record, observedAt: expected.observedAt }, expected),
    "Retained Host result differs from current candidate custody",
  );
  assertCurrent();
  retained();
  for (const target of [file, path.dirname(file)]) {
    const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  assertCurrent();
  retained();
  return structuredClone(record);
}
