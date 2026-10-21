import { retainCustodyBinding, retainCustodyProof } from "../retained-custody-binding.js";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  BootstrapProcessIdentitySchema,
  CoordinatorBootstrapPlanSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "../coordinator-bootstrap-errors.js";
import {
  retainMaintenancePublishedFile,
  retainMaintenancePublishedLink,
  selectMaintenanceFiles,
  selectMaintenanceReleaseLink,
} from "../coordinator-bootstrap-maintenance-file-selection.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { verifyRetainedProcessExited } from "../coordinator-bootstrap-service.js";
import { readBoundedMaintenanceInspection } from "../coordinator-bootstrap-maintenance-service-native.js";
import {
  FileEnrollmentJournal,
  consumeHostContinuation,
  hostContinuationReservationDigest,
  observeHostContinuation,
  withHostContinuationAdmission,
  type EnrollmentWriteFiles,
  type HostContinuationConsumption,
} from "./authorization.js";
import {
  inspectInitialHostSupervisorMigrationPlan,
  verifyInitialHostMigrationLaunchers,
  writeInitialHostArtifact,
} from "./host-supervisor-migration.js";
import {
  classifyInitialHostPublication,
  type InitialHostRecoveryImage,
} from "./host-supervisor-recovery.js";
import type { EnrollmentDaemonObservation } from "./native-daemon-inspection.js";
import { readInitialHostObservation } from "./host-supervisor-recovery-inspection.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Data for a FUTURE exclusive native constructor. No producer/election or
 * immutable child launch facility is implemented or advertised here. The native
 * owner must publish this exact intent exclusively BEFORE child birth. */
export const HostRestorationLaunchIntentSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("host-continuation-launch"),
  role: z.literal("restoration"),
  installationId: z.uuid(),
  grantId: z.uuid(),
  grantRevision: z.uuid(),
  manifestSha256: digest,
  stepId: z.uuid(),
  generation: z.uuid(),
  reservationSha256: digest,
  planSha256: digest,
  originalClaimSha256: digest,
  publicationSnapshotSha256: digest,
  arrangementSha256: digest,
  runtime: CoordinatorBootstrapPlanSchema.shape.candidate.pick({
    directory: true,
    sourceCommit: true,
    artifactSha256: true,
    node: true,
    entrypoint: true,
  }),
  createdAt: z.iso.datetime(),
});
export const HostRestorationClaimSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("host-continuation-claim"),
  role: z.literal("restoration"),
  intentSha256: digest,
  reservationSha256: digest,
  stepId: z.uuid(),
  generation: z.uuid(),
  planSha256: digest,
  executor: BootstrapProcessIdentitySchema,
  consumedAt: z.iso.datetime(),
});
type Intent = z.infer<typeof HostRestorationLaunchIntentSchema>;
type Claim = z.infer<typeof HostRestorationClaimSchema>;
type Plan = ReturnType<typeof inspectInitialHostSupervisorMigrationPlan>["plan"];
type Publication = ReturnType<typeof classifyInitialHostPublication>;

function requireProof(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(`Host restoration child: ${message}`);
}
function sha(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}
function hash(value: unknown) {
  return sha(JSON.stringify(value));
}
function missing(file: string) {
  try {
    lstatSync(file);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
function synchronous(action: () => void) {
  requireProof(action() === undefined, "proof must be synchronous");
}

/** Detached data and original callbacks share the initial-launch custody checks. */
export function retainBinding<T>(source: T) {
  return retainCustodyBinding(source, requireProof);
}
export function retainProof<T extends { assertCurrent(): void }>(source: T) {
  return retainCustodyProof(source, requireProof);
}

export function boundedRead<T>(read: (signal: AbortSignal) => Promise<T>, detail: string) {
  // Reuse the existing read owner. A deadline must not release custody of an
  // underlying native read that ignores abort. Ports are leaf collectors and
  // must not recursively reacquire this same observation owner.
  return readBoundedMaintenanceInspection(
    (signal) => readInitialHostObservation(() => read(signal)),
    { timeoutMs: 30_000, detail },
  );
}

/** Flat addresses only. This does not create or elect a native constructor. */
export function hostContinuationPaths(
  directory: string,
  stepValue: string,
  role: "restoration" | "candidate",
  generationValue: string,
) {
  const step = z.uuid().parse(stepValue),
    generation = z.uuid().parse(generationValue);
  requireProof(
    path.isAbsolute(directory) && path.normalize(directory) === directory && directory !== "/",
    "noncanonical enrollment directory",
  );
  z.enum(["restoration", "candidate"]).parse(role);
  const prefix = path.join(directory, `host-continuation-${step}-${role}-${generation}`);
  return {
    intent: prefix + "-intent.json",
    claim: prefix + "-claim.json",
    phase: prefix + "-publication.json",
    launcherAttempt: prefix + "-launcher-attempt.json",
    selectorAttempt: prefix + "-selector-attempt.json",
    bootstrapAttempt: prefix + "-bootstrap-attempt.json",
    result: prefix + "-result.json",
  };
}

export function hostRestorationPaths(directory: string, step: string, generation: string) {
  return hostContinuationPaths(directory, step, "restoration", generation);
}

export function readCaptured<T>(file: string, parse: (value: unknown) => T) {
  const parent = lstatSync(path.dirname(file));
  requireProof(
    parent.isDirectory() &&
      parent.uid === process.getuid?.() &&
      (parent.mode & 0o077) === 0 &&
      realpathSync(path.dirname(file)) === path.dirname(file),
    "control namespace is not private owned state",
  );
  // Pin name, parents and lifetime BEFORE reading any authoritative bytes.
  const lifetime = retainServiceFiles([file]);
  const descriptor = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  try {
    const stat = fstatSync(descriptor);
    requireProof(
      stat.isFile() &&
        stat.uid === process.getuid?.() &&
        stat.nlink === 1 &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 1024 * 1024,
      "control record is not private owned bounded data",
    );
    bytes = readFileSync(descriptor);
    lifetime();
  } finally {
    closeSync(descriptor);
  }
  const record = parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  requireProof(
    bytes.equals(Buffer.from(JSON.stringify(record))),
    "control record bytes are not canonical",
  );
  const contents = retainMaintenancePublishedFile(file, bytes);
  const assertCurrent = () => {
    lifetime();
    contents();
    lifetime();
  };
  assertCurrent();
  return { record, sha256: sha(bytes), bytesBase64: bytes.toString("base64"), assertCurrent };
}

export interface HostRestorationInput {
  journal: FileEnrollmentJournal;
  stepId: string;
  generation: string;
  plan: unknown;
  publication: InitialHostRecoveryImage;
}
export interface HostRestorationLaunchContext {
  plan: Plan;
  intent: Intent;
  intentSha256: string;
  executor: z.infer<typeof BootstrapProcessIdentitySchema>;
  publication: Publication;
}
interface RestorationContext extends HostRestorationLaunchContext {
  claim: Claim;
  claimSha256: string;
}
export interface HostRestorationPrepared {
  planSha256: string;
  launcher: Uint8Array;
  launchers: { current: unknown; fallback: unknown; candidate: unknown; sourceUpdates: unknown };
  /** Retains BOTH complete inventories, sealed provenance and launcher semantics. */
  assertCurrent(): void;
}
export interface HostRestorationAbsence {
  absent: true;
  identitySha256: string;
  bootId: string;
  service: string;
  runtimeDirectories: string[];
  observedAt: string;
  evidenceSha256: string;
  /** Independent service and every declared runtime inventory/descendant proof.
   * A readiness error, empty scan or worker exit cannot supply this proof. */
  assertCurrent(): void;
}
export interface HostRestorationExecutionPorts {
  executor: { identity: unknown; assertCurrent(context: HostRestorationLaunchContext): void };
  /** Verifies actual prebirth exclusive election and pinned immutable child
   * runtime against protected native owner artifacts. No factory exists here. */
  assertLaunchArrangement(context: HostRestorationLaunchContext): void;
  assertOriginalPublication(): void;
  assertExclusive: HostContinuationConsumption["assertExclusive"];
  collectPrepared(
    context: HostRestorationLaunchContext,
    signal: AbortSignal,
  ): Promise<HostRestorationPrepared>;
  collectAbsence(
    context: HostRestorationLaunchContext,
    signal: AbortSignal,
  ): Promise<HostRestorationAbsence>;
  bootstrap(context: RestorationContext): Promise<void>;
  files?: Pick<EnrollmentWriteFiles, "open" | "write" | "sync" | "close">;
}

function requireLineage(input: HostRestorationInput, intent: Intent, publication: Publication) {
  const state = input.journal.readPolicySnapshot();
  requireProof(state.status === "enrolled", "enrollment is absent");
  const lineage = state.activation.hostContinuations?.find((item) => item.stepId === input.stepId);
  requireProof(
    lineage && !lineage.candidate && lineage.restoration.generation === input.generation,
    "restoration is not the active lineage",
  );
  requireProof(
    intent.installationId === state.grant.manifest.installationId &&
      intent.grantId === state.grant.id &&
      intent.grantRevision === lineage.restoration.grantRevision &&
      intent.manifestSha256 === state.activation.manifestSha256 &&
      intent.stepId === input.stepId &&
      intent.generation === input.generation &&
      intent.reservationSha256 === hostContinuationReservationDigest(lineage, "restoration") &&
      intent.planSha256 === lineage.binding.planSha256 &&
      intent.originalClaimSha256 === lineage.original.claimSha256 &&
      intent.publicationSnapshotSha256 === lineage.restoration.evidence.publicationSnapshotSha256 &&
      publication.snapshotSha256 === intent.publicationSnapshotSha256,
    "intent differs from the reserved failed claim/image",
  );
  return lineage;
}

function phaseRecord(context: RestorationContext) {
  const { intent, claim, claimSha256, publication } = context;
  return {
    version: 1,
    role: "restoration",
    slot: "fallback",
    stepId: intent.stepId,
    generation: intent.generation,
    intentSha256: context.intentSha256,
    claimSha256,
    reservationSha256: claim.reservationSha256,
    planSha256: intent.planSha256,
    originalClaimSha256: intent.originalClaimSha256,
    publicationSnapshotSha256: publication.snapshotSha256,
  };
}
const continuationPhase = z.strictObject({
  version: z.literal(1),
  role: z.literal("restoration"),
  slot: z.literal("fallback"),
  stepId: z.uuid(),
  generation: z.uuid(),
  intentSha256: digest,
  claimSha256: digest,
  reservationSha256: digest,
  planSha256: digest,
  originalClaimSha256: digest,
  publicationSnapshotSha256: digest,
});
export const HostContinuationPhaseSchema = z.discriminatedUnion("role", [
  continuationPhase,
  continuationPhase.extend({
    role: z.literal("candidate"),
    slot: z.literal("candidate"),
    restorationGeneration: z.uuid(),
    restorationObservationSha256: digest,
    restorationChildExitSha256: digest,
    restorationClaimSha256: digest,
    preconditionSha256: digest,
  }),
]);
/** Canonical DATA only. Native authority and captured file custody are separate.
 * The strict role union rejects mixed restoration/candidate namespaces. */
export function hostContinuationPublicationRecords(input: {
  plan: unknown;
  directory: string;
  phase: unknown;
  previousLauncherSha256: string;
  previousSelector: string;
}) {
  const { plan, planSha256 } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const phase = HostContinuationPhaseSchema.parse(input.phase);
  requireProof(phase.planSha256 === planSha256, "publication plan binding differs");
  digest.parse(input.previousLauncherSha256);
  requireProof(path.isAbsolute(input.previousSelector), "publication selector baseline is invalid");
  if (phase.role === "candidate")
    requireProof(
      input.previousLauncherSha256 === plan.fallback.launcher.sha256 &&
        input.previousSelector === plan.fallback.directory &&
        phase.preconditionSha256 !== plan.preconditionSha256 &&
        phase.restorationGeneration !== phase.generation &&
        phase.restorationClaimSha256 !== phase.claimSha256 &&
        phase.originalClaimSha256 !== phase.claimSha256,
      "candidate publication requires its exact restored predecessor",
    );
  const paths = hostContinuationPaths(input.directory, phase.stepId, phase.role, phase.generation);
  const selected = phase.role === "candidate" ? plan.candidate : plan.fallback;
  const launcherAttempt = {
    version: 1,
    reservationSha256: phase.claimSha256,
    files: [
      {
        path: plan.precondition.launcher.path,
        previousSha256: input.previousLauncherSha256,
        sha256: selected.launcher.sha256,
      },
      { path: paths.phase, previousSha256: null, sha256: hash(phase) },
    ],
  };
  const selectorAttempt = {
    version: 1,
    operation: "release-link-selection",
    reservationSha256: phase.claimSha256,
    link: plan.precondition.identity.selectionPath!,
    previous: input.previousSelector,
    candidate: selected.directory,
  };
  return { paths, phase, launcherAttempt, selectorAttempt };
}
function prepareRecords(context: RestorationContext, directory: string) {
  requireProof(
    context.publication.snapshot.launcher.state === "present",
    "original launcher capture is absent",
  );
  return hostContinuationPublicationRecords({
    plan: context.plan,
    directory,
    phase: phaseRecord(context),
    previousLauncherSha256: context.publication.snapshot.launcher.sha256,
    previousSelector: context.publication.snapshot.selector.resolvedTarget,
  });
}

function retainOriginal(context: HostRestorationLaunchContext) {
  const snapshot = context.publication.snapshot;
  const controls = retainOriginalControls(context);
  requireProof(snapshot.launcher.state === "present", "original launcher is absent");
  const launcher = retainMaintenancePublishedFile(
    snapshot.launcher.path,
    Buffer.from(snapshot.launcher.bytesBase64, "base64"),
  );
  const link = retainMaintenancePublishedLink(
    snapshot.selector.path,
    snapshot.selector.resolvedTarget,
  );
  const selector = () => {
    link();
    requireProof(
      readlinkSync(snapshot.selector.path) === snapshot.selector.text,
      "original selector text changed",
    );
    link();
  };
  return {
    controls,
    launcher,
    selector,
  };
}

function requirePrepared(
  context: HostRestorationLaunchContext,
  retained: ReturnType<typeof retainProof<HostRestorationPrepared>>,
) {
  const prepared = retained.data;
  retained.check();
  requireProof(
    prepared.planSha256 === context.intent.planSha256 &&
      sha(prepared.launcher) === context.plan.fallback.launcher.sha256,
    "prepared fallback bytes or plan changed",
  );
  verifyInitialHostMigrationLaunchers({ plan: context.plan, ...prepared.launchers });
  retained.assertCurrent();
}
export function restorationService(plan: Plan) {
  const identity = plan.precondition.identity;
  requireProof(
    identity.environment === "host" && identity.target === "host",
    "restoration requires the enrolled Host service",
  );
  return `${identity.serviceDomain}/${identity.serviceLabel}`;
}
function checkAbsence(context: HostRestorationLaunchContext, absence: HostRestorationAbsence) {
  const expected = [
    ...new Set([
      context.plan.precondition.selectedRelease,
      context.plan.candidate.directory,
      context.plan.fallback.directory,
    ]),
  ].sort();
  const age = Date.now() - Date.parse(absence.observedAt);
  requireProof(
    absence.absent === true &&
      age >= 0 &&
      age < 30_000 &&
      absence.identitySha256 === context.plan.identitySha256 &&
      absence.bootId === context.executor.bootId &&
      absence.service === restorationService(context.plan) &&
      isDeepStrictEqual([...absence.runtimeDirectories].sort(), expected),
    "fresh service and all-slot absence is required",
  );
  digest.parse(absence.evidenceSha256);
}
function requireAbsence(
  context: HostRestorationLaunchContext,
  absence: ReturnType<typeof retainProof<HostRestorationAbsence>>,
) {
  absence.check();
  checkAbsence(context, absence.data);
  absence.assertCurrent();
  // Native verification may consume the remainder of the freshness allowance.
  checkAbsence(context, absence.data);
}
function birth(value: string) {
  const match = /^(\d+):(\d{1,6})$/.exec(value);
  requireProof(match, "native birth identity is invalid");
  return BigInt(match[1]) * 1_000_000n + BigInt(match[2]);
}
function requireSelf(
  context: HostRestorationLaunchContext,
  ports: HostRestorationExecutionPorts,
  checkPorts: () => void,
) {
  const captured = hash(context);
  const executor = context.executor;
  requireProof(
    executor.pid === process.pid &&
      executor.parentPid === process.ppid &&
      executor.uid === process.getuid?.() &&
      executor.executable === context.intent.runtime.node.path &&
      birth(executor.startIdentity) >= BigInt(Date.parse(context.intent.createdAt)) * 1000n &&
      birth(executor.startIdentity) <= BigInt(Date.now()) * 1000n,
    "actual born child differs from prebirth intent",
  );
  for (const callback of [ports.assertLaunchArrangement, ports.executor.assertCurrent]) {
    checkPorts();
    requireProof(callback(context) === undefined, "native launch/self custody must be synchronous");
    checkPorts();
    requireProof(hash(context) === captured, "native self custody mutated its binding");
  }
}

/** Called once by an already-elected immutable child, never by a reservation
 * requester. There is no constructor or default native command/proof factory.
 * Any uncertainty preserves addressed fences and cannot reenter execution. */
export async function executeHostRestorationChild(
  input: HostRestorationInput,
  ports: HostRestorationExecutionPorts,
) {
  try {
    return await executeRestoration(input, ports);
  } catch {
    return { status: "unresolved" as const };
  }
}
async function executeRestoration(
  input: HostRestorationInput,
  suppliedPorts: HostRestorationExecutionPorts,
) {
  const retainedPorts = retainBinding(suppliedPorts);
  const ports = retainedPorts.snapshot;
  const { plan, planSha256 } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const publication = classifyInitialHostPublication(input.publication);
  const paths = hostRestorationPaths(input.journal.stateDirectory, input.stepId, input.generation);
  const intent = readCaptured(paths.intent, (value) =>
    HostRestorationLaunchIntentSchema.parse(value),
  );
  const lineage = requireLineage(input, intent.record, publication);
  requireProof(planSha256 === intent.record.planSha256, "reviewed plan differs from intent");
  if (
    lineage.restoration.claim ||
    [
      paths.claim,
      paths.phase,
      paths.launcherAttempt,
      paths.selectorAttempt,
      paths.bootstrapAttempt,
      paths.result,
    ].some((file) => !missing(file))
  )
    return { status: "observe-only" as const };
  const executor = BootstrapProcessIdentitySchema.parse(ports.executor.identity);
  const launch: HostRestorationLaunchContext = {
    plan,
    intent: intent.record,
    intentSha256: intent.sha256,
    executor,
    publication,
  };
  const fixedLaunch = hash(launch);
  retainedPorts.check();
  requireSelf(launch, ports, retainedPorts.check);
  retainedPorts.check();
  synchronous(ports.assertOriginalPublication);
  retainedPorts.check();
  const original = retainOriginal(launch);
  const prepared = retainProof(
    await boundedRead(
      (signal) => ports.collectPrepared(launch, signal),
      "Host restoration preparation timed out",
    ),
  );
  const launcher = Buffer.from(prepared.data.launcher);
  requireProof(sha(launcher) === plan.fallback.launcher.sha256, "copied fallback launcher changed");
  const absence = retainProof(
    await boundedRead(
      (signal) => ports.collectAbsence(launch, signal),
      "Host restoration absence timed out",
    ),
  );
  requireProof(hash(launch) === fixedLaunch, "preparation mutated the pinned launch");
  const claim = HostRestorationClaimSchema.parse({
    version: 1,
    operation: "host-continuation-claim",
    role: "restoration",
    intentSha256: intent.sha256,
    reservationSha256: intent.record.reservationSha256,
    stepId: input.stepId,
    generation: input.generation,
    planSha256,
    executor,
    consumedAt: new Date().toISOString(),
  });
  const context: RestorationContext = { ...launch, claim, claimSha256: hash(claim) };
  const fixedContext = hash(context);
  const records = prepareRecords(context, input.journal.stateDirectory);
  let targetProof = () => {
    original.launcher();
    original.selector();
  };
  let launcherPhaseProof: (() => void) | undefined;
  let bootstrapProof: (() => void) | undefined;
  let nativeClaim: ReturnType<typeof readCaptured<Claim>> | undefined;
  const assertCurrent = () => {
    retainedPorts.check();
    requireProof(hash(context) === fixedContext, "retained child context changed");
    intent.assertCurrent();
    original.controls();
    targetProof();
    requireSelf(context, ports, retainedPorts.check);
    requirePrepared(context, prepared);
    requireAbsence(context, absence);
    requireProof(
      absence.data.evidenceSha256 === lineage.restoration.evidence.targetAbsenceSha256,
      "absence differs from retained reservation",
    );
    nativeClaim?.assertCurrent();
    bootstrapProof?.();
    intent.assertCurrent();
    original.controls();
    targetProof();
    retainedPorts.check();
    prepared.check();
    absence.check();
    checkAbsence(context, absence.data);
    requireProof(hash(context) === fixedContext, "custody mutated the retained context");
  };
  const consumption: HostContinuationConsumption = {
    grantRevision: intent.record.grantRevision,
    stepId: input.stepId,
    generation: input.generation,
    role: "restoration",
    plan,
    reservationSha256: claim.reservationSha256,
    intentSha256: intent.sha256,
    claimSha256: context.claimSha256,
    executor,
    publication: input.publication,
    assertExclusive(custody) {
      retainedPorts.check();
      requireProof(
        ports.assertExclusive(custody) === undefined,
        "exclusive custody must be synchronous",
      );
      retainedPorts.check();
      prepared.check();
      absence.check();
    },
    assertCurrent() {
      assertCurrent();
      if (!nativeClaim) {
        writeInitialHostArtifact(input.journal.stateDirectory, paths.claim, claim, ports.files);
        nativeClaim = readCaptured(paths.claim, (value) => HostRestorationClaimSchema.parse(value));
        requireProof(nativeClaim.sha256 === context.claimSha256, "native claim bytes disagree");
      }
      assertCurrent();
    },
  };
  consumeHostContinuation(input.journal, consumption);
  // Every subsequent proof is read-only. Claim creation is not reusable.
  consumption.assertCurrent = () => {
    requireProof(nativeClaim, "native claim is missing");
    assertCurrent();
  };
  withHostContinuationAdmission(input.journal, consumption, (_context, reassert) => {
    reassert();
    const receipt = selectMaintenanceFiles({
      attemptFile: paths.launcherAttempt,
      reservationSha256: context.claimSha256,
      launcher: {
        path: plan.precondition.launcher.path,
        previousSha256: publication.snapshot.launcher.sha256!,
        bytes: launcher,
      },
      selection: {
        path: paths.phase,
        previousSha256: null,
        bytes: Buffer.from(JSON.stringify(records.phase)),
      },
      assertCurrent: reassert,
    });
    requireProof(
      isDeepStrictEqual(receipt, records.launcherAttempt),
      "launcher attempt differs from exact claim",
    );
    const proofs = [
      retainMaintenancePublishedFile(
        paths.launcherAttempt,
        Buffer.from(JSON.stringify(records.launcherAttempt)),
      ),
      retainMaintenancePublishedFile(paths.phase, Buffer.from(JSON.stringify(records.phase))),
      retainMaintenancePublishedFile(plan.precondition.launcher.path, launcher),
    ];
    launcherPhaseProof = () => {
      for (const proof of proofs) proof();
    };
    targetProof = () => {
      for (const proof of proofs) proof();
      original.selector();
    };
    reassert();
  });
  withHostContinuationAdmission(input.journal, consumption, (_context, reassert) => {
    reassert();
    const receipt = selectMaintenanceReleaseLink({
      attemptFile: paths.selectorAttempt,
      reservationSha256: context.claimSha256,
      link: records.selectorAttempt.link,
      previous: records.selectorAttempt.previous,
      candidate: records.selectorAttempt.candidate,
      assertCurrent: reassert,
    });
    requireProof(
      isDeepStrictEqual(receipt, records.selectorAttempt),
      "selector attempt differs from exact claim",
    );
    // Preserve the NEW launcher/phase proof. Never recapture the old CAS image.
    requireProof(launcherPhaseProof, "launcher phase was not retained");
    const retainedLauncher = launcherPhaseProof;
    const selectorAttemptProof = retainMaintenancePublishedFile(
      paths.selectorAttempt,
      Buffer.from(JSON.stringify(records.selectorAttempt)),
    );
    const selectorProof = retainMaintenancePublishedLink(
      records.selectorAttempt.link,
      plan.fallback.directory,
    );
    targetProof = () => {
      retainedLauncher();
      selectorAttemptProof();
      selectorProof();
      requireProof(
        readlinkSync(records.selectorAttempt.link) === plan.fallback.directory,
        "fallback selector text changed",
      );
    };
    reassert();
  });
  withHostContinuationAdmission(input.journal, consumption, (_context, reassert) => {
    reassert();
    const attempt = { ...records.phase, operation: "bootstrap", service: absence.data.service };
    writeInitialHostArtifact(
      input.journal.stateDirectory,
      paths.bootstrapAttempt,
      attempt,
      ports.files,
    );
    bootstrapProof = retainMaintenancePublishedFile(
      paths.bootstrapAttempt,
      Buffer.from(JSON.stringify(attempt)),
    );
    reassert();
    bootstrapProof();
  });
  // Outer admission fsync must succeed before this single async invocation.
  // The durable fence prevents replay even if the command or later reply fails.
  // Admission performs its journal fsync after the action. It may take long
  // enough for proof freshness to expire or expose changed protected files.
  // This is read-only and never reopens the already-created bootstrap fence.
  assertCurrent();
  await ports.bootstrap(structuredClone(context));
  return { status: "bootstrap-requested" as const };
}

export interface HostRestorationObservationPorts {
  reader: Parameters<typeof verifyRetainedProcessExited>[0];
  assertLaunchIntent(context: RestorationContext): void;
  collectPrepared(
    context: HostRestorationLaunchContext,
    signal: AbortSignal,
  ): Promise<HostRestorationPrepared>;
  collectLegacy(
    context: RestorationContext,
    signal: AbortSignal,
  ): Promise<{ ready: true; observation: EnrollmentDaemonObservation } | { ready: false }>;
}

/** No launch, publication, absence or command ports exist on reopening. Missing
 * exit/readiness/settlement stays unresolved; it never writes a terminal failure. */
export async function observeHostRestorationChild(
  input: HostRestorationInput,
  ports: HostRestorationObservationPorts,
) {
  try {
    return await observeRestoration(input, ports);
  } catch {
    return { status: "unresolved" as const };
  }
}
async function observeRestoration(
  input: HostRestorationInput,
  suppliedPorts: HostRestorationObservationPorts,
) {
  const retainedPorts = retainBinding(suppliedPorts);
  const ports = retainedPorts.snapshot;
  const { plan, planSha256 } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const publication = classifyInitialHostPublication(input.publication);
  const paths = hostRestorationPaths(input.journal.stateDirectory, input.stepId, input.generation);
  const intent = readCaptured(paths.intent, (value) =>
    HostRestorationLaunchIntentSchema.parse(value),
  );
  const claim = readCaptured(paths.claim, (value) => HostRestorationClaimSchema.parse(value));
  const lineage = requireLineage(input, intent.record, publication);
  requireProof(
    planSha256 === intent.record.planSha256,
    "reviewed observer plan differs from intent",
  );
  const consumed = lineage.restoration.claim;
  requireProof(
    consumed &&
      consumed.intentSha256 === intent.sha256 &&
      consumed.claimSha256 === claim.sha256 &&
      consumed.executorSha256 === hash(claim.record.executor) &&
      claim.record.intentSha256 === intent.sha256 &&
      claim.record.generation === input.generation &&
      claim.record.stepId === input.stepId &&
      claim.record.planSha256 === planSha256 &&
      claim.record.reservationSha256 === intent.record.reservationSha256,
    "native claim and ledger disagree; observation only",
  );
  const context: RestorationContext = {
    plan,
    intent: intent.record,
    intentSha256: intent.sha256,
    executor: claim.record.executor,
    claim: claim.record,
    claimSha256: claim.sha256,
    publication,
  };
  const fixedContext = hash(context);
  const control = () => {
    retainedPorts.check();
    intent.assertCurrent();
    claim.assertCurrent();
    requireProof(hash(context) === fixedContext, "observation context changed");
    requireProof(
      ports.assertLaunchIntent(context) === undefined,
      "intent custody must be synchronous",
    );
    intent.assertCurrent();
    claim.assertCurrent();
    retainedPorts.check();
    requireProof(hash(context) === fixedContext, "intent custody mutated its binding");
  };
  control();
  await boundedRead(
    () => verifyRetainedProcessExited(ports.reader, claim.record.executor),
    "Host restoration child exit remains unresolved",
  );
  control();
  // No target artifacts or readiness are read before the exact exit gate.
  const original = retainOriginalControls(context);
  const prepared = retainProof(
    await boundedRead(
      (signal) => ports.collectPrepared(context, signal),
      "Host restored preparation timed out",
    ),
  );
  requirePrepared(context, prepared);
  const records = prepareRecords(context, input.journal.stateDirectory);
  const proofs = [
    retainMaintenancePublishedFile(paths.phase, Buffer.from(JSON.stringify(records.phase))),
    retainMaintenancePublishedFile(
      paths.launcherAttempt,
      Buffer.from(JSON.stringify(records.launcherAttempt)),
    ),
    retainMaintenancePublishedFile(
      paths.selectorAttempt,
      Buffer.from(JSON.stringify(records.selectorAttempt)),
    ),
    retainMaintenancePublishedFile(
      paths.bootstrapAttempt,
      Buffer.from(
        JSON.stringify({
          ...records.phase,
          operation: "bootstrap",
          service: restorationService(plan),
        }),
      ),
    ),
    retainMaintenancePublishedFile(
      plan.precondition.launcher.path,
      Buffer.from(prepared.data.launcher),
    ),
    retainMaintenancePublishedLink(records.selectorAttempt.link, plan.fallback.directory),
  ];
  const readiness = await boundedRead(
    (signal) => ports.collectLegacy(context, signal),
    "Host restored readiness timed out",
  );
  requireProof(readiness.ready === true, "legacy readiness remains unresolved");
  const observed = retainProof(readiness.observation);
  const record = legacyRecord(context, observed.data);
  const checkImage = () => {
    intent.assertCurrent();
    claim.assertCurrent();
    original();
    for (const proof of proofs) proof();
    requireProof(
      readlinkSync(records.selectorAttempt.link) === plan.fallback.directory,
      "restored selector text changed",
    );
    retainedPorts.check();
    prepared.check();
    observed.check();
    requireProof(hash(context) === fixedContext, "observation context changed");
    requireProof(
      isDeepStrictEqual(legacyRecord(context, observed.data), record),
      "legacy readiness changed during custody",
    );
  };
  const assertCurrent = () => {
    checkImage();
    control();
    checkImage();
    requirePrepared(context, prepared);
    checkImage();
    observed.assertCurrent();
    checkImage();
    control();
    // No injected callback may follow the final exact image/freshness check.
    checkImage();
  };
  assertCurrent();
  let retainedRecord = record;
  if (missing(paths.result))
    writeInitialHostArtifact(input.journal.stateDirectory, paths.result, record);
  else {
    const existing = readCaptured(paths.result, (value) =>
      z.record(z.string(), z.unknown()).parse(value),
    );
    requireProof(
      typeof existing.record.observedAt === "string" &&
        Date.parse(existing.record.observedAt) <= Date.parse(record.observedAt) &&
        isDeepStrictEqual({ ...existing.record, observedAt: record.observedAt }, record),
      "retained legacy result differs",
    );
    retainedRecord = { ...record, observedAt: existing.record.observedAt };
    existing.assertCurrent();
    for (const file of [paths.result, path.dirname(paths.result)]) {
      const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    existing.assertCurrent();
  }
  const resultProof = retainMaintenancePublishedFile(
    paths.result,
    Buffer.from(JSON.stringify(retainedRecord)),
  );
  observeHostContinuation(input.journal, {
    stepId: input.stepId,
    generation: input.generation,
    role: "restoration",
    claimSha256: claim.sha256,
    executor: claim.record.executor,
    outcome: "legacy-restored",
    observationSha256: hash(retainedRecord),
    childExitSha256: hash({
      claimSha256: claim.sha256,
      executor: claim.record.executor,
      exited: true,
    }),
    assertCurrent: () => {
      assertCurrent();
      resultProof();
    },
  });
  return { status: "legacy-restored" as const, observationSha256: hash(retainedRecord) };
}

function retainOriginalControls(context: Pick<HostRestorationLaunchContext, "publication">) {
  const snapshot = context.publication.snapshot;
  const proofs = [
    snapshot.plan,
    snapshot.intent,
    snapshot.claim,
    snapshot.phase,
    snapshot.launcherAttempt,
    snapshot.selectorAttempt,
  ].map((file) => {
    const parent = retainServiceFiles([path.dirname(file.path)]);
    const contents =
      file.state === "present"
        ? retainMaintenancePublishedFile(file.path, Buffer.from(file.bytesBase64, "base64"))
        : () => requireProof(missing(file.path), "original control artifact appeared");
    return () => {
      parent();
      contents();
      parent();
    };
  });
  return () => {
    for (const proof of proofs) proof();
  };
}
function legacyRecord(context: RestorationContext, observed: EnrollmentDaemonObservation) {
  const age = Date.now() - Date.parse(observed.observedAt),
    previous = context.plan.precondition;
  requireProof(
    age >= 0 &&
      age < 30_000 &&
      observed.identitySha256 === context.plan.identitySha256 &&
      isDeepStrictEqual(observed.descriptor, previous.identity) &&
      observed.serverId === previous.serverId &&
      observed.selectedRelease === context.plan.fallback.directory &&
      observed.sourceCommit === context.plan.fallback.sourceCommit &&
      observed.worker.parentPid === observed.supervisor.pid,
    "readiness is not the exact sealed legacy runtime",
  );
  for (const current of [observed.supervisor, observed.worker]) {
    requireProof(
      current.uid === previous.identity.custodyOwnerUid &&
        current.bootId === context.claim.executor.bootId &&
        birth(current.startIdentity) >= BigInt(Date.parse(context.claim.consumedAt)) * 1000n &&
        !isDeepStrictEqual(current, previous.supervisor) &&
        !isDeepStrictEqual(current, previous.worker) &&
        !isDeepStrictEqual(current, context.claim.executor),
      "legacy process lifetime is not fresh",
    );
  }
  return {
    ...phaseRecord(context),
    outcome: "legacy-restored",
    identitySha256: context.plan.identitySha256,
    serverId: observed.serverId,
    selectedRelease: observed.selectedRelease,
    sourceCommit: observed.sourceCommit,
    supervisor: structuredClone(observed.supervisor),
    worker: structuredClone(observed.worker),
    observedAt: observed.observedAt,
  };
}
