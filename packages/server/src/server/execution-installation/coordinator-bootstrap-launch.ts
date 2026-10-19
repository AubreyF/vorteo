import { verifyCoordinatorSubmission } from "./daemon-automation.js";
import { createHash } from "node:crypto";
import { lstatSync, constants, realpathSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  BootstrapPreclaimRecoveryRequestSchema,
  type BootstrapPreclaimRecoveryRequest,
  type BootstrapPreclaimRecoveryPlan,
  type BootstrapPreclaimDispatchObservation,
  CoordinatorBootstrapRequestSchema,
  CoordinatorBootstrapPreparationSchema,
  CoordinatorBootstrapDecisionSchema,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import type {
  BootstrapReviewService,
  PreclaimRecoveryReviewService,
} from "./coordinator-bootstrap-session.js";
import {
  BootstrapAdmissionSetupSchema,
  createBootstrapReviewService,
  inspectBootstrapWritableMountRoots,
  readPrivateBootstrapConfiguration,
  readBootstrapHostBinding,
} from "./coordinator-bootstrap-host.js";
import {
  assertBootstrapPathsProtected,
  digestBootstrapArtifact,
  readBootstrapPreparedFile,
  readProtectedDocument,
  verifyBootstrapReleaseArtifacts,
} from "./coordinator-bootstrap-artifact.js";
import {
  BootstrapRunnerSetupSchema,
  waitForBootstrapWatchdog,
} from "./coordinator-bootstrap-runner.js";
import {
  BootstrapRenewalSchema,
  deriveBootstrapRenewal,
  terminalBootstrapRelease,
  persistRenewalSetup,
  verifyRenewalPlan,
  verifyRetainedRenewal,
} from "./coordinator-bootstrap-renewal.js";

import { FileBootstrapPreclaimJournal } from "./coordinator-bootstrap-preclaim-journal.js";
import {
  validatePreclaimRecoveryPlan,
  preclaimRecoveryPlanDigest,
  reconcilePreclaimRecovery,
  verifyPreclaimRecoveryOwnership,
  PreclaimRecoveryReviews,
  createPreclaimNativeOperations,
  executePreclaimRecovery,
  verifySupportedPreclaimRunner,
  verifyPreclaimPreparationIsolation,
  observePreclaimExecutor,
  verifyPreclaimSelectedService,
} from "./coordinator-bootstrap-preclaim-recovery.js";
import { InstallationConfigSchema } from "./config.js";
import {
  AuditedProcessObservationSchema,
  ProcessObservationSchema,
} from "./coordinator-bootstrap-process.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  createNativeBootstrapServiceReader,
  verifyLoadedBootstrapService,
} from "./coordinator-bootstrap-service.js";

/** Recovery may inspect the selected Host while its one exact approved target
 * remains unclaimed. Nothing is canceled, claimed or
 * excluded from the persisted journal. Other nonterminal requests still block. */
interface PreclaimRuntimeInput {
  setupFile: string;
  daemonId: string;
  original: CoordinatorBootstrapRequest;
  ownerCancellation?: CoordinatorBootstrapRequest;
  ports?: NonNullable<Parameters<typeof deriveBootstrapRenewal>[0]["ports"]> & {
    moduleFile: string;
    hostProcessId?: number;
  };
}

function unclaimedPreclaimRequests(
  records: CoordinatorBootstrapRequest[],
  identity: Parameters<typeof terminalBootstrapRelease>[1],
) {
  // Failed generations remain in history after an exact successor recovers them.
  // Validate that complete chain before excluding executed records from admission.
  terminalBootstrapRelease(records, identity);
  return records.filter((record) => record.status !== "canceled" && !record.execution);
}

function readPreclaimRuntimeAnchor(input: PreclaimRuntimeInput) {
  const request = CoordinatorBootstrapRequestSchema.parse(input.original);
  const uid = process.getuid?.();
  if (
    process.platform !== "darwin" ||
    uid === undefined ||
    request.status !== "approved" ||
    request.execution
  )
    throw new BootstrapRequestConflict("Exact approved unclaimed recovery target required");
  const setup = BootstrapRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(input.setupFile, uid),
  );
  if (setup.daemonId !== input.daemonId || setup.renewal)
    throw new BootstrapRequestConflict("Recovery requires the installed Host bootstrap anchor");
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
  );
  const binding = readBootstrapHostBinding(admission.configurationFile, input.daemonId);
  if (
    binding.stateDirectory !== request.plan.state.directory ||
    binding.binding.installationId !== request.plan.installationId ||
    binding.binding.service !== request.plan.service
  )
    throw new BootstrapRequestConflict("Recovery target belongs to another installation");
  const journal = new FileBootstrapRequestJournal(binding.stateDirectory);
  const verifyOriginal = () => {
    const records = journal.read();
    const current = records.find((record) => record.id === request.id);
    const openRequests = unclaimedPreclaimRequests(records, {
      installationId: binding.binding.installationId,
      stateDirectory: binding.stateDirectory,
      service: binding.binding.service,
    });
    if (openRequests.some((record) => record.id !== request.id))
      throw new BootstrapRequestConflict("Another bootstrap review or execution remains open");
    if (!isDeepStrictEqual(current, input.ownerCancellation ?? request))
      throw new BootstrapRequestConflict("Recovery target changed during runtime derivation");
  };
  return { request, uid, setup, admission, verifyOriginal };
}

export async function derivePreclaimHostRuntime(
  input: PreclaimRuntimeInput,
): Promise<z.infer<typeof BootstrapRunnerSetupSchema>> {
  const { request, uid, setup, admission, verifyOriginal } = readPreclaimRuntimeAnchor(input);
  verifyOriginal();
  const derived = await deriveBootstrapRenewal({
    setupFile: input.setupFile,
    setup,
    moduleFile: input.ports?.moduleFile ?? fileURLToPath(import.meta.url),
    hostPid: input.ports?.hostProcessId ?? process.pid,
    ports: input.ports,
    ...(input.ownerCancellation
      ? {}
      : { dispatchedRequest: { id: request.id, planSha256: request.planSha256 } }),
  });
  if (!derived?.renewal)
    throw new BootstrapRequestConflict("Recovery requires verified selected Host renewal context");
  const roots = await (input.ports?.writableMountRoots?.() ??
    inspectBootstrapWritableMountRoots(admission));
  await readBootstrapPreparedFile(
    { path: admission.launcherFile, sha256: request.plan.previous.launcher.sha256 },
    roots,
  );
  if (derived.renewal.configuration.sha256 !== request.plan.previous.configuration.sha256)
    throw new BootstrapRequestConflict("Recovery target selected configuration changed");
  const reader =
    input.ports?.reader ??
    (await createNativeBootstrapServiceReader({
      helperPath: admission.helperPath,
      helperSha256: admission.helperSha256,
      writableMountRoots: roots,
    }));
  await verifyLoadedBootstrapService({
    plan: request.plan,
    hostUid: uid,
    configurationFile: derived.renewal.configuration.path,
    reader,
  });
  verifyOriginal();
  if (
    !isDeepStrictEqual(setup, readPrivateBootstrapConfiguration(input.setupFile, uid)) ||
    !isDeepStrictEqual(
      admission,
      BootstrapAdmissionSetupSchema.parse(
        readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
      ),
    )
  )
    throw new BootstrapRequestConflict("Recovery anchor changed during runtime derivation");
  return derived;
}

const PreclaimReferenceSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Historical observations only. Missing receipts never establish that a
 * process is absent, and retained birth never establishes current liveness. */
export function readPreclaimDispatchObservation(
  stateDirectory: string,
  request: BootstrapPreclaimRecoveryRequest,
): BootstrapPreclaimDispatchObservation {
  try {
    const uid = process.getuid?.();
    if (uid === undefined || stateDirectory !== request.plan.original.plan.state.directory)
      throw new BootstrapRequestConflict("Recovery observation state changed");
    return readPreclaimDispatchReceipts(stateDirectory, request, uid);
  } catch {
    return { state: "unavailable" };
  }
}

function findPreclaimAttempt(stateDirectory: string, requestId: string): string | undefined {
  const files = readdirSync(stateDirectory);
  const attempts = files.filter((name) =>
    name.startsWith(`coordinator-preclaim-attempt-${requestId}-`),
  );
  if (
    attempts.length > 1 ||
    (!attempts.length &&
      files.some((name) => name.startsWith(`coordinator-preclaim-executor-${requestId}-`)))
  )
    throw new BootstrapRequestConflict("Recovery receipts are ambiguous or incomplete");
  return attempts[0];
}

function readPreclaimDispatchReceipts(
  stateDirectory: string,
  request: BootstrapPreclaimRecoveryRequest,
  uid: number,
): BootstrapPreclaimDispatchObservation {
  const attemptFile = findPreclaimAttempt(stateDirectory, request.id);
  if (!attemptFile) return { state: "no_receipt" };
  const attempt = z
    .strictObject({
      version: z.literal(1),
      request: PreclaimReferenceSchema,
      setup: z.string(),
      launcherPid: z.number().int().positive(),
      attemptId: z.string().uuid(),
    })
    .parse(readPrivateBootstrapConfiguration(path.join(stateDirectory, attemptFile), uid));
  const reference = attempt.request;
  if (
    reference.id !== request.id ||
    reference.planSha256 !== request.planSha256 ||
    attemptFile !== `coordinator-preclaim-attempt-${request.id}-${reference.revision}.json` ||
    attempt.setup !==
      path.join(
        stateDirectory,
        `coordinator-preclaim-launch-${request.id}-${reference.revision}.json`,
      ) ||
    (request.status === "approved" && !request.execution && request.revision !== reference.revision)
  )
    throw new BootstrapRequestConflict("Recovery attempt differs from its review");
  const observation = { approvedRevision: reference.revision, attemptId: attempt.attemptId };
  const file = path.join(
    stateDirectory,
    `coordinator-preclaim-executor-${request.id}-${reference.revision}.json`,
  );
  try {
    lstatSync(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { state: "attempt_retained", ...observation };
    throw error;
  }
  const birth = z
    .strictObject({
      version: z.literal(1),
      request: PreclaimReferenceSchema,
      attemptId: z.string().uuid(),
      setup: BootstrapRunnerSetupSchema.shape.entrypoint,
      executor: AuditedProcessObservationSchema,
    })
    .parse(readPrivateBootstrapConfiguration(file, uid));
  if (
    !isDeepStrictEqual(birth.request, reference) ||
    birth.attemptId !== attempt.attemptId ||
    birth.setup.path !== attempt.setup ||
    birth.executor.identity.pid !== attempt.launcherPid
  )
    throw new BootstrapRequestConflict("Recovery birth differs from its launch attempt");
  // No native probe or effect belongs in a status read.
  return { state: "birth_retained", ...observation, executor: birth.executor.identity };
}

/** Only a newly recorded decision starts preparation. Construction and reads
 * never scan approvals for replay. Cancellation remains available throughout
 * preparation; the protected launcher repeats this check before claiming. */
export function createDispatchingPreclaimReview(
  reviews: PreclaimRecoveryReviews,
  prepareLaunch: (request: BootstrapPreclaimRecoveryRequest) => Promise<() => Promise<void>>,
): PreclaimRecoveryReviewService {
  return {
    available: true,
    list: () => reviews.list(),
    prepare: (input) => reviews.prepare(input),
    decide: async (input, password, acknowledged) => {
      const request = await reviews.decide(input, password, acknowledged);
      if (request.status !== "approved") return request;
      const launch = await prepareLaunch(structuredClone(request));
      if (
        !isDeepStrictEqual(
          reviews.list().find((item) => item.id === request.id),
          request,
        )
      )
        throw new BootstrapRequestConflict("Recovery decision changed before launch");
      try {
        await launch();
      } catch {
        // A failed observation does not establish whether exec or claim ran.
        // Keep the approval and one-shot attempt for explicit reconciliation.
        throw new BootstrapRequestConflict(
          "Recovery launch is unconfirmed. Inspect its retained status; do not replay approval.",
        );
      }
      const current = reviews.list().find((item) => item.id === request.id);
      if (!current)
        throw new BootstrapRequestConflict("Recovery review is unavailable after launch");
      return current;
    },
  };
}

/** Recovery has independent readiness: ordinary maintenance can be unavailable
 * precisely because its approved executor has not claimed. Initialization only
 * reads authority and history; it never resumes a retained approval. */
export async function createManagedPreclaimRecoveryReview(
  setupFile: string | undefined,
  daemonId: string,
  ports?: PreclaimRuntimeInput["ports"],
): Promise<PreclaimRecoveryReviewService | undefined> {
  if (!setupFile) return undefined;
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native Host recovery initialization required");
  const anchor = BootstrapRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(setupFile, uid),
  );
  if (anchor.daemonId !== daemonId || anchor.renewal)
    throw new BootstrapRequestConflict("Recovery requires the installed Host bootstrap anchor");
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(anchor.admissionSetupFile, uid),
  );
  const binding = readBootstrapHostBinding(admission.configurationFile, daemonId);
  const legacy = new FileBootstrapRequestJournal(binding.stateDirectory);
  const openRequests = unclaimedPreclaimRequests(legacy.read(), {
    installationId: binding.binding.installationId,
    stateDirectory: binding.stateDirectory,
    service: binding.binding.service,
  });
  if (openRequests.length > 1)
    throw new BootstrapRequestConflict(
      "Recovery initialization requires an unambiguous unclaimed target",
    );
  const original = openRequests.find((item) => item.status === "approved");
  const runtime = original
    ? await derivePreclaimHostRuntime({ setupFile, daemonId, original, ports })
    : await deriveBootstrapRenewal({
        setupFile,
        setup: anchor,
        moduleFile: ports?.moduleFile ?? fileURLToPath(import.meta.url),
        hostPid: ports?.hostProcessId ?? process.pid,
        ports,
      });
  if (!runtime?.renewal)
    throw new BootstrapRequestConflict("Recovery requires verified selected Host renewal context");
  const configuration = runtime.renewal.configuration;
  const readBinding = () => {
    const current = readBootstrapHostBinding(configuration.path, daemonId);
    if (
      current.stateDirectory !== binding.stateDirectory ||
      current.binding.installationId !== binding.binding.installationId ||
      current.binding.service !== binding.binding.service
    )
      throw new BootstrapRequestConflict("Recovery installation binding changed");
    return current.binding;
  };
  const reviews = new PreclaimRecoveryReviews(
    new FileBootstrapPreclaimJournal(binding.stateDirectory),
    readBinding,
    (plan) =>
      verifyManagedPreclaimPreparation(
        {
          setupFile,
          daemonId,
          original: plan.original,
          ownerCancellation: plan.ownerCancellation,
          ports,
        },
        plan,
      ),
  );
  // Validate persisted schemas and plan digests before advertising readiness.
  reviews.list();
  readBinding();
  const service = createDispatchingPreclaimReview(reviews, (request) =>
    prepareNativePreclaimLaunch({ setupFile, daemonId, request, ports }),
  );
  return {
    ...service,
    reconcile: (input) => launchPreclaimObservation(binding.stateDirectory, input),
    list: () =>
      service.list().map((request) =>
        Object.assign({}, request, {
          dispatch: readPreclaimDispatchObservation(binding.stateDirectory, request),
        }),
      ),
  };
}

async function verifyManagedPreclaimPreparation(
  input: PreclaimRuntimeInput,
  plan: BootstrapPreclaimRecoveryPlan,
) {
  const runtime = await derivePreclaimHostRuntime(input);
  const renewal = runtime.renewal!;
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse((await readBootstrapPreparedFile(renewal.originalAdmission, [])).toString("utf8")),
  );
  if (
    plan.selectedLauncher.path !== admission.launcherFile ||
    !isDeepStrictEqual(plan.selectedConfiguration, renewal.configuration)
  )
    throw new BootstrapRequestConflict("Recovery selected paths differ from managed authority");
  const roots = await (input.ports?.writableMountRoots?.() ??
    inspectBootstrapWritableMountRoots(admission));
  await verifySupportedPreclaimRunner({
    plan,
    daemonId: input.daemonId,
    admissionSetupFile: runtime.admissionSetupFile,
    anchor: renewal,
    writableMountRoots: roots,
  });
  const inspector = { path: admission.helperPath, sha256: admission.helperSha256 };
  const reader = await createNativeBootstrapServiceReader({
    helperPath: inspector.path,
    helperSha256: inspector.sha256,
    writableMountRoots: roots,
  });
  const context = {
    plan,
    reader,
    inspector,
    writableMountRoots: roots,
    helper: runtime.ownerLauncher,
    launcherFile: admission.launcherFile,
    configurationFile: renewal.configuration.path,
  };
  await verifyPreclaimSelectedService(context);
  const observed = await observePreclaimExecutor({
    plan,
    reader,
    retainedContext: { inspector, writableMountRoots: roots },
  });
  if (observed === "alive") await verifyPreclaimPreparationIsolation(context);
}

export const PreclaimRunnerSetupSchema = BootstrapRunnerSetupSchema.extend({
  version: z.literal(1),
  kind: z.literal("bootstrap-preclaim-recovery"),
  stateDirectory: z.string().startsWith("/"),
  request: PreclaimReferenceSchema,
  original: PreclaimReferenceSchema,
  renewal: BootstrapRenewalSchema,
  inspector: BootstrapRunnerSetupSchema.shape.entrypoint,
  selectedLauncherFile: z.string().startsWith("/"),
});

/** A fresh execution snapshot does not edit the installed runner/admission.
 * Callers receive a path, never a dispatch receipt. The launcher separately
 * consumes its durable attempt and the runner must still verify native admission. */
export async function persistPreclaimLaunchSetup(
  input: Omit<PreclaimRuntimeInput, "original"> & {
    request: BootstrapPreclaimRecoveryRequest;
  },
): Promise<string> {
  return (await persistPreclaimLaunchSnapshot(input)).file;
}

async function persistPreclaimLaunchSnapshot(
  input: Omit<PreclaimRuntimeInput, "original"> & {
    request: BootstrapPreclaimRecoveryRequest;
  },
) {
  const request = BootstrapPreclaimRecoveryRequestSchema.parse(input.request);
  validatePreclaimRecoveryPlan(request.plan);
  if (
    request.status !== "approved" ||
    !request.decisionAt ||
    request.execution ||
    request.planSha256 !== preclaimRecoveryPlanDigest(request.plan)
  )
    throw new BootstrapRequestConflict("Exact undispatched recovery approval required");
  const state = request.plan.original.plan.state.directory;
  const journal = new FileBootstrapPreclaimJournal(state);
  const verifyReview = () => {
    if (
      !isDeepStrictEqual(
        journal.readReviews().find((item) => item.id === request.id),
        request,
      )
    )
      throw new BootstrapRequestConflict("Recovery approval changed during snapshot preparation");
  };
  const reference = { id: request.id, revision: request.revision, planSha256: request.planSha256 };
  const attempt = path.join(
    state,
    `coordinator-preclaim-attempt-${request.id}-${request.revision}.json`,
  );
  const refuseAttempt = () => {
    try {
      lstatSync(attempt);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    throw new BootstrapRequestConflict(
      "Recovery launch was already attempted; inspect its retained outcome",
    );
  };
  verifyReview();
  refuseAttempt();
  const setup = await derivePreclaimHostRuntime({
    ...input,
    original: request.plan.original,
    ownerCancellation: request.plan.ownerCancellation,
  });
  // Verify the captured admission digest before using its Docker or inspector
  // paths. A concurrent anchor edit cannot redirect snapshot preparation.
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(setup.renewal!.originalAdmission, [])).toString("utf8"),
    ),
  );
  const snapshot = PreclaimRunnerSetupSchema.parse({
    ...setup,
    version: 1,
    kind: "bootstrap-preclaim-recovery",
    stateDirectory: state,
    request: reference,
    original: {
      id: request.plan.original.id,
      revision: request.plan.original.revision,
      planSha256: request.plan.original.planSha256,
    },
    inspector: { path: admission.helperPath, sha256: admission.helperSha256 },
    selectedLauncherFile: admission.launcherFile,
  });
  const roots = await (input.ports?.writableMountRoots?.() ??
    inspectBootstrapWritableMountRoots(admission));
  await assertBootstrapPathsProtected([state], roots);
  await readBootstrapPreparedFile(snapshot.renewal.originalAdmission, roots);
  await readBootstrapPreparedFile(snapshot.inspector, roots);
  verifyReview();
  refuseAttempt();
  const file = path.join(
    state,
    `coordinator-preclaim-launch-${request.id}-${request.revision}.json`,
  );
  await writeRecoverySnapshot(file, snapshot);
  const directory = await open(state, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  verifyReview();
  refuseAttempt();
  return { file, snapshot };
}

/** Prepare from the selected immutable Host, then expose a one-use launch.
 * Spawn acknowledgement is deliberately not an execution or success receipt. */
export async function launchPreclaimObservation(
  stateDirectory: string,
  input: { id: string; revision: string; planSha256: string; generation: string },
): Promise<void> {
  const journal = new FileBootstrapPreclaimJournal(stateDirectory);
  const request = journal.readReviews().find((r) => r.id === input.id);
  if (
    !request ||
    request.revision !== input.revision ||
    request.planSha256 !== input.planSha256 ||
    request.status !== "approved" ||
    request.execution?.generation !== input.generation
  )
    throw new BootstrapRequestConflict("Exact retained recovery generation required");
  const observation = readPreclaimDispatchObservation(stateDirectory, request);
  if (observation.state !== "birth_retained")
    throw new BootstrapRequestConflict("Retained recovery birth is unavailable");
  const setupFile = path.join(
    stateDirectory,
    `coordinator-preclaim-launch-${request.id}-${observation.approvedRevision}.json`,
  );
  const setup = PreclaimRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(setupFile, process.getuid!()),
  );
  if (
    setup.stateDirectory !== stateDirectory ||
    setup.request.id !== input.id ||
    setup.request.planSha256 !== input.planSha256
  )
    throw new BootstrapRequestConflict("Retained recovery snapshot changed");
  const source = await readBootstrapPreparedFile(setup.ownerLauncher, []);
  const child = spawn(
    "/usr/bin/python3",
    [
      "-I",
      "-B",
      "-c",
      source.toString("utf8"),
      "preclaim-observe",
      setupFile,
      input.id,
      input.revision,
      input.planSha256,
      input.generation,
    ],
    { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () =>
      reject(new BootstrapRequestConflict("Recovery observation spawn is unconfirmed")),
    );
    child.unref();
  });
}

export async function prepareNativePreclaimLaunch(
  input: Omit<PreclaimRuntimeInput, "original"> & { request: BootstrapPreclaimRecoveryRequest },
): Promise<() => Promise<void>> {
  const request = BootstrapPreclaimRecoveryRequestSchema.parse(input.request);
  const { file: setupFile, snapshot } = await persistPreclaimLaunchSnapshot({ ...input, request });
  // Carry the derived snapshot across the write boundary. Rereading the file
  // must not turn replacement bytes into fresh launcher authority.
  const pin = {
    path: setupFile,
    sha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  };
  await readBootstrapPreparedFile(pin, []);
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(snapshot.renewal.originalAdmission, [])).toString("utf8"),
    ),
  );
  const roots = await (input.ports?.writableMountRoots?.() ??
    inspectBootstrapWritableMountRoots(admission));
  const source = await readBootstrapPreparedFile(snapshot.ownerLauncher, roots);
  const journal = new FileBootstrapPreclaimJournal(snapshot.stateDirectory);
  let attempted = false;
  return async () => {
    if (attempted) throw new BootstrapRequestConflict("Recovery launch was already attempted");
    // Consume the closure before any await so concurrent callers cannot fork twice.
    attempted = true;
    await readBootstrapPreparedFile(pin, roots);
    await readBootstrapPreparedFile(snapshot.ownerLauncher, roots);
    if (
      !isDeepStrictEqual(
        journal.readReviews().find((item) => item.id === request.id),
        request,
      )
    )
      throw new BootstrapRequestConflict("Recovery decision changed before launch");
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-c",
        source.toString("utf8"),
        "preclaim-launch",
        setupFile,
        request.id,
        request.revision,
        request.planSha256,
      ],
      { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () =>
        reject(new BootstrapRequestConflict("Recovery spawn is unconfirmed")),
      );
      child.unref();
    });
  };
}

export async function writeRecoverySnapshot(file: string, snapshot: unknown) {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  let handle;
  let created = true;
  try {
    handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if (!isDeepStrictEqual(readPrivateBootstrapConfiguration(file, process.getuid!()), snapshot))
      throw new BootstrapRequestConflict("Retained recovery execution snapshot differs");
    created = false;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  try {
    if (created) await handle.writeFile(bytes);
    else if (!(await handle.readFile()).equals(bytes))
      throw new BootstrapRequestConflict("Retained recovery snapshot bytes changed");
    // A prior write may have lost its sync result. Identical bytes still need
    // their own successful durability check; never rewrite the existing file.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Retain this new runner's audited birth before expensive artifact validation.
 * This observation is not a claim, cancellation, effect or terminal receipt. */
export async function retainPreclaimExecutorBirth(input: {
  setupFile: string;
  recoveryDescriptor: number;
  writableMountRoots: readonly string[];
}) {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native recovery executor required");
  const setup = PreclaimRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(input.setupFile, uid),
  );
  const identity = setup.request;
  if (
    input.setupFile !==
      path.join(
        setup.stateDirectory,
        `coordinator-preclaim-launch-${identity.id}-${identity.revision}.json`,
      ) ||
    process.execPath !== setup.node.path ||
    process.argv[1] !== setup.entrypoint.path
  )
    throw new BootstrapRequestConflict("Recovery executor does not match its protected launch");
  const ownership = {
    stateDirectory: setup.stateDirectory,
    recoveryDescriptor: input.recoveryDescriptor,
    helper: setup.ownerLauncher,
    writableMountRoots: input.writableMountRoots,
  };
  await verifyPreclaimRecoveryOwnership(ownership);
  await readBootstrapPreparedFile(setup.entrypoint, input.writableMountRoots);
  const attemptFile = path.join(
    setup.stateDirectory,
    `coordinator-preclaim-attempt-${identity.id}-${identity.revision}.json`,
  );
  const attempt = z
    .strictObject({
      version: z.literal(1),
      request: PreclaimReferenceSchema,
      setup: z.string(),
      launcherPid: z.number().int().positive(),
      attemptId: z.string().uuid(),
    })
    .parse(readPrivateBootstrapConfiguration(attemptFile, uid));
  if (
    !isDeepStrictEqual(attempt.request, identity) ||
    attempt.setup !== input.setupFile ||
    attempt.launcherPid !== process.pid
  )
    throw new BootstrapRequestConflict("Recovery launch attempt does not match this executor");
  const reviews = new FileBootstrapPreclaimJournal(setup.stateDirectory);
  const verifyReview = () => {
    const request = reviews.readReviews().find((item) => item.id === identity.id);
    if (
      !request ||
      request.revision !== identity.revision ||
      request.planSha256 !== identity.planSha256 ||
      request.status !== "approved" ||
      !request.decisionAt ||
      request.execution ||
      preclaimRecoveryPlanDigest(request.plan) !== identity.planSha256 ||
      !isDeepStrictEqual(
        {
          id: request.plan.original.id,
          revision: request.plan.original.revision,
          planSha256: request.plan.original.planSha256,
        },
        setup.original,
      )
    )
      throw new BootstrapRequestConflict("Recovery approval changed before birth retention");
  };
  verifyReview();
  const reader = await createNativeBootstrapServiceReader({
    helperPath: setup.inspector.path,
    helperSha256: setup.inspector.sha256,
    writableMountRoots: input.writableMountRoots,
  });
  const executor = AuditedProcessObservationSchema.parse(
    await reader.inspectAuditedProcess(process.pid),
  );
  verifyPreclaimBirthObservation(
    setup,
    input.setupFile,
    executor,
    ProcessObservationSchema.parse(await reader.inspectProcess(setup.renewal.hostProcess.pid)),
  );
  if (!isDeepStrictEqual(setup, readPrivateBootstrapConfiguration(input.setupFile, uid)))
    throw new BootstrapRequestConflict("Recovery launch snapshot changed before birth retention");
  const bytes = await readProtectedDocument(input.setupFile);
  if (
    !isDeepStrictEqual(PreclaimRunnerSetupSchema.parse(JSON.parse(bytes.toString("utf8"))), setup)
  )
    throw new BootstrapRequestConflict("Recovery snapshot bytes changed before birth retention");
  const record = {
    version: 1,
    request: identity,
    attemptId: attempt.attemptId,
    setup: { path: input.setupFile, sha256: createHash("sha256").update(bytes).digest("hex") },
    executor,
  };
  const file = path.join(
    setup.stateDirectory,
    `coordinator-preclaim-executor-${identity.id}-${identity.revision}.json`,
  );
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(setup.stateDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await verifyPreclaimRecoveryOwnership(ownership);
  verifyReview();
  if (!isDeepStrictEqual(executor, await reader.inspectAuditedProcess(process.pid)))
    throw new BootstrapRequestConflict("Recovery executor changed during birth retention");
  return record;
}

function verifyPreclaimBirthObservation(
  setup: z.infer<typeof PreclaimRunnerSetupSchema>,
  setupFile: string,
  executor: z.infer<typeof AuditedProcessObservationSchema>,
  parent: z.infer<typeof AuditedProcessObservationSchema>["identity"],
) {
  const identity = setup.request;
  const argv = [
    setup.node.path,
    setup.entrypoint.path,
    setupFile,
    "preclaim-executor",
    identity.id,
    identity.revision,
    identity.planSha256,
  ];
  const uid = process.getuid!();
  const host = setup.renewal.hostProcess;
  if (
    executor.identity.pid !== process.pid ||
    executor.identity.parentPid !== host.pid ||
    executor.identity.uid !== uid ||
    executor.identity.bootId !== host.bootId ||
    executor.identity.executable !== setup.node.path ||
    executor.identity.argumentsSha256 !==
      createHash("sha256").update(JSON.stringify(argv)).digest("hex") ||
    executor.auditToken[1] !== uid ||
    executor.auditToken[5] !== process.pid ||
    !isDeepStrictEqual(parent, host)
  )
    throw new BootstrapRequestConflict("Recovery executor birth or parent changed");
}

/** Fixed entrypoint only. No RPC supplies callbacks, executable paths or
 * installation identity, and no retained approval is scanned for replay. */
export async function runNativePreclaimRecovery(
  input: {
    setupFile: string;
    identity: z.infer<typeof PreclaimReferenceSchema>;
    recoveryDescriptor: number;
  },
  serviceReader?: Pick<
    Awaited<ReturnType<typeof createNativeBootstrapServiceReader>>,
    "readService"
  >,
  observationGeneration?: string,
): Promise<BootstrapPreclaimRecoveryRequest> {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native recovery runner required");
  const setup = PreclaimRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(input.setupFile, uid),
  );
  if (
    !observationGeneration &&
    !isDeepStrictEqual(PreclaimReferenceSchema.parse(input.identity), setup.request)
  )
    throw new BootstrapRequestConflict("Exact recovery runner approval required");
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(setup.renewal.originalAdmission, [])).toString("utf8"),
    ),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  await assertBootstrapPathsProtected([input.setupFile, setup.stateDirectory], roots);
  // Retain native birth before either runtime's expensive complete-tree digest.
  const birth = observationGeneration
    ? await verifyPreclaimObserver(input, setup, observationGeneration, roots)
    : await retainPreclaimExecutorBirth({ ...input, writableMountRoots: roots });
  await verifyRetainedRenewal(setup, undefined, observationGeneration !== undefined);
  const nativeReader = await createNativeBootstrapServiceReader({
    helperPath: setup.inspector.path,
    helperSha256: setup.inspector.sha256,
    writableMountRoots: roots,
  });
  // The fixed production entrypoint supplies no override. The narrow OS service
  // port lets disposable acceptance retain real audited processes and effects.
  const reader = serviceReader
    ? { ...nativeReader, readService: serviceReader.readService }
    : nativeReader;
  const journal = new FileBootstrapPreclaimJournal(setup.stateDirectory);
  const legacy = new FileBootstrapRequestJournal(setup.stateDirectory);
  const readBinding = () => {
    const current = readBootstrapHostBinding(setup.renewal.configuration.path, setup.daemonId);
    if (current.stateDirectory !== setup.stateDirectory)
      throw new BootstrapRequestConflict("Recovery state directory changed");
    return current.binding;
  };
  const verifyRuntime = async () => {
    await readBootstrapPreparedFile(birth.setup, roots);
    await verifyRetainedRenewal(setup, undefined, true);
    const config = InstallationConfigSchema.parse(
      readPrivateBootstrapConfiguration(setup.renewal.configuration.path, uid),
    );
    if (
      !config.sourceUpdates ||
      realpathSync(config.sourceUpdates.currentReleaseLink) !== setup.runtimeDirectory ||
      !isDeepStrictEqual(await inspectBootstrapWritableMountRoots(admission), roots)
    )
      throw new BootstrapRequestConflict("Recovery selected Host or mount boundaries changed");
  };
  const verifyTarget = async (plan: BootstrapPreclaimRecoveryPlan) => {
    await verifyRuntime();
    assertPreclaimRunnerTarget(setup, plan, journal, legacy);
    await verifySupportedPreclaimRunner({
      plan,
      daemonId: setup.daemonId,
      admissionSetupFile: setup.admissionSetupFile,
      anchor: setup.renewal,
      writableMountRoots: roots,
    });
  };
  const context = {
    stateDirectory: setup.stateDirectory,
    recoveryDescriptor: input.recoveryDescriptor,
    helper: setup.ownerLauncher,
    inspector: setup.inspector,
    reader,
    launcherFile: setup.selectedLauncherFile,
    configurationFile: setup.renewal.configuration.path,
    writableMountRoots: roots,
    journal,
    verifySupportedPlan: verifyTarget,
  };
  const reviews = new PreclaimRecoveryReviews(journal, readBinding, async (plan) => {
    await verifyTarget(plan);
    await verifyPreclaimSelectedService({ ...context, plan });
    const observed = await observePreclaimExecutor({
      plan,
      reader,
      retainedContext: { inspector: setup.inspector, writableMountRoots: roots },
    });
    if (observed === "alive") await verifyPreclaimPreparationIsolation({ ...context, plan });
  });
  const native = createPreclaimNativeOperations(context);
  if (observationGeneration) {
    const current = reviews.list().find((r) => r.id === input.identity.id);
    if (current?.execution?.generation !== observationGeneration)
      throw new BootstrapRequestConflict("Retained recovery generation changed");
    return reconcilePreclaimRecovery({
      reviews,
      identity: input.identity,
      journal,
      native: {
        withRecoveryOwnership: native.withRecoveryOwnership,
        withVerifiedExitAndSelection: native.withVerifiedExitAndSelection,
      },
    });
  }
  return executePreclaimRecovery({
    reviews,
    identity: setup.request,
    journal,
    native: createPreclaimNativeOperations(context),
  });
}

async function verifyPreclaimObserver(
  input: {
    setupFile: string;
    identity: z.infer<typeof PreclaimReferenceSchema>;
    recoveryDescriptor: number;
  },
  setup: z.infer<typeof PreclaimRunnerSetupSchema>,
  generation: string,
  roots: readonly string[],
) {
  z.string().uuid().parse(generation);
  const journal = new FileBootstrapPreclaimJournal(setup.stateDirectory);
  const request = journal.readReviews().find((r) => r.id === input.identity.id);
  if (
    !request ||
    request.status !== "approved" ||
    request.revision !== input.identity.revision ||
    request.planSha256 !== input.identity.planSha256 ||
    request.execution?.generation !== generation ||
    setup.request.id !== request.id ||
    setup.request.planSha256 !== request.planSha256
  )
    throw new BootstrapRequestConflict("Exact retained observation generation required");
  const observed = readPreclaimDispatchObservation(setup.stateDirectory, request);
  if (observed.state !== "birth_retained" || observed.approvedRevision !== setup.request.revision)
    throw new BootstrapRequestConflict("Recovery observation requires retained birth");
  const file = path.join(
    setup.stateDirectory,
    `coordinator-preclaim-executor-${request.id}-${observed.approvedRevision}.json`,
  );
  const birth = z
    .object({ setup: BootstrapRunnerSetupSchema.shape.entrypoint })
    .parse(readPrivateBootstrapConfiguration(file, process.getuid!()));
  const args = [
    setup.node.path,
    setup.entrypoint.path,
    input.setupFile,
    "preclaim-observer",
    request.id,
    request.revision,
    request.planSha256,
    generation,
  ];
  if (
    birth.setup.path !== input.setupFile ||
    process.execPath !== setup.node.path ||
    !isDeepStrictEqual(process.argv, args)
  )
    throw new BootstrapRequestConflict("Observation entrypoint or retained snapshot changed");
  await readBootstrapPreparedFile(birth.setup, roots);
  await verifyPreclaimRecoveryOwnership({
    stateDirectory: setup.stateDirectory,
    recoveryDescriptor: input.recoveryDescriptor,
    helper: setup.ownerLauncher,
    writableMountRoots: roots,
  });
  return birth;
}

function assertPreclaimRunnerTarget(
  setup: z.infer<typeof PreclaimRunnerSetupSchema>,
  plan: BootstrapPreclaimRecoveryPlan,
  journal: FileBootstrapPreclaimJournal,
  legacy: FileBootstrapRequestJournal,
) {
  const original = plan.original;
  if (
    !isDeepStrictEqual(
      { id: original.id, revision: original.revision, planSha256: original.planSha256 },
      setup.original,
    ) ||
    original.plan.state.directory !== setup.stateDirectory ||
    plan.selectedLauncher.path !== setup.selectedLauncherFile ||
    !isDeepStrictEqual(plan.selectedConfiguration, setup.renewal.configuration)
  )
    throw new BootstrapRequestConflict(
      "Recovery runner target differs from its execution snapshot",
    );
  const records = legacy.read();
  const openRequests = unclaimedPreclaimRequests(records, {
    installationId: original.plan.installationId,
    stateDirectory: setup.stateDirectory,
    service: original.plan.service,
  });
  if (openRequests.some((record) => record.id !== original.id))
    throw new BootstrapRequestConflict("Another bootstrap operation remains open");
  const retained = journal.inspect(setup.request.id);
  if (retained?.fenced) {
    if (
      !isDeepStrictEqual(retained.cancellation.original, original) ||
      retained.cancellation.recoveryPlanSha256 !== setup.request.planSha256
    )
      throw new BootstrapRequestConflict("Recovery cancellation provenance changed");
    journal.assertFenced(retained.cancellation);
  } else if (
    !isDeepStrictEqual(
      records.find((record) => record.id === original.id),
      plan.ownerCancellation ?? original,
    )
  )
    throw new BootstrapRequestConflict("Original bootstrap changed before recovery cancellation");
}

/** Artifact verification can outlast Host readiness. Keep all maintenance
 * operations fenced while it runs, then notify connected clients of the result. */
export function deferBootstrapReview(
  initialize: () => Promise<BootstrapReviewService | undefined>,
): BootstrapReviewService {
  let pending = true;
  let service: BootstrapReviewService | undefined;
  let failure: string | undefined;
  const listeners = new Set<() => void>();
  const reason = () =>
    pending
      ? "Checking coordinator maintenance availability. Host remains available while release verification finishes."
      : (failure ?? service?.unavailableReason);
  const ready = () => {
    if (pending || failure || !service || service.unavailableReason || service.available === false)
      throw new BootstrapRequestConflict(reason() ?? "Coordinator maintenance is not configured.");
    return service;
  };
  void Promise.resolve()
    .then(initialize)
    .then(
      (result) => {
        service = result;
        service?.subscribeAvailability?.(() => {
          for (const listener of listeners) {
            try {
              listener();
            } catch {
              /* Keep independent listeners isolated. */
            }
          }
        });
        return undefined;
      },
      () => {
        failure =
          "Coordinator maintenance is unavailable: this Host could not validate its configuration.";
      },
    )
    .then(() => {
      pending = false;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A failed notification cannot change validation or block other clients.
        }
      }
      return undefined;
    });
  return {
    get available() {
      return !pending && !failure && service !== undefined && service.available !== false;
    },
    get unavailableReason() {
      return reason();
    },
    subscribeAvailability(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get automatic() {
      return pending || failure || service?.available === false || service?.unavailableReason
        ? undefined
        : service?.automatic;
    },
    get preclaimRecovery() {
      return pending || failure ? undefined : service?.preclaimRecovery;
    },
    get claimedRecovery() {
      return pending || failure ? undefined : service?.claimedRecovery;
    },
    list: () => ready().list(),
    prepare: async (input) => ready().prepare(input),
    decide: async (input, password) => ready().decide(input, password),
  };
}

/** Existing Host launchers already provide the private installation client.
 * Discover only its fixed sibling, so routine worker delivery needs no plist reload. */
export async function createConfiguredBootstrapReview(
  daemonId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapReviewService | undefined> {
  let setup = environment.VORTEO_COORDINATOR_BOOTSTRAP_SETUP;
  const client = environment.VORTEO_INSTALLATION_CLIENT_CONFIG;
  if (!setup && client) {
    const uid = process.getuid?.();
    if (process.platform !== "darwin" || uid === undefined) return undefined;
    const identity = z
      .object({ kind: z.string() })
      .parse(readPrivateBootstrapConfiguration(client, uid));
    if (identity.kind !== "host-agent") return undefined;
    setup = path.join(path.dirname(client), "coordinator-bootstrap-runner.json");
    try {
      lstatSync(setup);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  const { createManagedClaimedRecoveryReview } =
    await import("./coordinator-bootstrap-claimed-launch.js");
  const [ordinary, recovery, claimed] = await Promise.all([
    createSafeManagedBootstrapReview(setup, daemonId),
    createManagedPreclaimRecoveryReview(setup, daemonId).then(
      (service) => service,
      () => undefined,
    ),
    createManagedClaimedRecoveryReview(setup, daemonId).then(
      (service) => service,
      () => undefined,
    ),
  ]);
  if (ordinary && recovery) ordinary.preclaimRecovery = recovery;
  if (ordinary && claimed) ordinary.claimedRecovery = claimed;
  return ordinary && claimed
    ? refreshBootstrapReviewAfterClaimedRecovery(ordinary, claimed, () =>
        createSafeManagedBootstrapReview(setup, daemonId),
      )
    : ordinary;
}

/** An owner status read may revalidate readiness after completed recovery. It
 * never replays a decision or launches an executor. Failed validation stays
 * unavailable; another explicit read can retry after native exit is provable. */
export function refreshBootstrapReviewAfterClaimedRecovery(
  initial: BootstrapReviewService,
  claimed: NonNullable<BootstrapReviewService["claimedRecovery"]>,
  initialize: () => Promise<BootstrapReviewService | undefined>,
): BootstrapReviewService {
  let current = initial;
  let pending = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* One client cannot suppress other notifications. */
      }
    }
  };
  const ready = () => {
    if (pending || current.available === false || current.unavailableReason)
      throw new BootstrapRequestConflict(
        current.unavailableReason ?? "Checking coordinator maintenance after recovery.",
      );
    return current;
  };
  const recoveries = {
    ...claimed,
    list: () => {
      const records = claimed.list();
      if (
        !pending &&
        (current.available === false || current.unavailableReason) &&
        records.some(
          (record) => record.status === "approved" && record.execution?.stage === "succeeded",
        )
      ) {
        pending = true;
        notify();
        void Promise.resolve()
          .then(initialize)
          .then(
            (result) => {
              if (result) current = result;
              return undefined;
            },
            () => undefined,
          )
          .then(() => {
            pending = false;
            notify();
            return undefined;
          });
      }
      return records;
    },
  };
  return {
    get available() {
      return !pending && current.available !== false && !current.unavailableReason;
    },
    get unavailableReason() {
      return pending
        ? "Checking coordinator maintenance after recovery."
        : current.unavailableReason;
    },
    get automatic() {
      return pending || current.available === false || current.unavailableReason
        ? undefined
        : current.automatic;
    },
    get preclaimRecovery() {
      return initial.preclaimRecovery;
    },
    claimedRecovery: recoveries,
    subscribeAvailability(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () => ready().list(),
    prepare: async (input) => ready().prepare(input),
    decide: async (input, password) => ready().decide(input, password),
  };
}

async function createSafeManagedBootstrapReview(
  setup: string | undefined,
  daemonId: string,
): Promise<BootstrapReviewService | undefined> {
  try {
    return await createManagedBootstrapReview(setup, daemonId);
  } catch (error) {
    // Keep a safe diagnosis reachable through the existing review UI. In
    // particular an older Host must not rewrite history it cannot understand.
    const description =
      error instanceof BootstrapRequestConflict
        ? error.message
        : "Coordinator maintenance is unavailable: this Host cannot validate retained renewal evidence. Install a compatible Host reader; do not replay or rewrite history.";
    const unavailable = () => {
      throw new BootstrapRequestConflict(description);
    };
    return {
      unavailableReason: description,
      list: unavailable,
      prepare: async () => unavailable(),
      decide: async () => unavailable(),
    };
  }
}

/** Launcher configuration, never an RPC, supplies the runner setup. Existing
 * approvals are not scanned or replayed after a Host daemon restart. */
export async function createManagedBootstrapReview(
  setupFile: string | undefined,
  daemonId: string,
): Promise<BootstrapReviewService | undefined> {
  if (!setupFile) return undefined;
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native Host bootstrap launch required");
  const readSetup = () =>
    BootstrapRunnerSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid));
  const original = readSetup();
  if (original.daemonId !== daemonId)
    throw new BootstrapRequestConflict("Bootstrap setup belongs to another daemon");
  if (original.renewal)
    throw new BootstrapRequestConflict(
      "Installed runner anchor cannot be a renewal execution snapshot",
    );
  const reconstruct = () =>
    deriveBootstrapRenewal({
      setupFile,
      setup: original,
      moduleFile: fileURLToPath(import.meta.url),
      hostPid: process.pid,
    });
  const setup = (await reconstruct()) ?? original;
  const readAdmission = () =>
    BootstrapAdmissionSetupSchema.parse(
      readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
    );
  const admission = readAdmission();
  const verifySetup = async () => {
    if (!isDeepStrictEqual(original, readSetup()) || !isDeepStrictEqual(admission, readAdmission()))
      throw new BootstrapRequestConflict("Bootstrap launch setup changed");
    if (setup.renewal) {
      if (!isDeepStrictEqual(await reconstruct(), setup))
        throw new BootstrapRequestConflict("Host renewal context changed; prepare a fresh review");
      await verifyRetainedRenewal(setup);
    }
    const roots = await inspectBootstrapWritableMountRoots(admission);
    await assertBootstrapPathsProtected(
      [setupFile, setup.admissionSetupFile, setup.runtimeDirectory],
      roots,
    );
    const relative = path.relative(setup.runtimeDirectory, setup.entrypoint.path);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new BootstrapRequestConflict("Bootstrap runner is outside its prepared runtime");
    for (const file of [setup.entrypoint, setup.ownerLauncher, setup.ownershipVerifier])
      await readBootstrapPreparedFile(file, roots);
    if ((await digestBootstrapArtifact(setup.runtimeDirectory)) !== setup.runtimeSha256)
      throw new BootstrapRequestConflict("Bootstrap runner artifact changed");
    return roots;
  };
  await verifySetup();
  const requests = await createBootstrapReviewService(
    setup.admissionSetupFile,
    daemonId,
    setup.renewal
      ? {
          setup: { ...admission, configurationFile: setup.renewal.configuration.path },
          verify: async (plan) => {
            await verifySetup();
            await verifyRenewalPlan(setup, plan);
          },
        }
      : undefined,
  );
  const verifyCandidate = async (request: Pick<CoordinatorBootstrapRequest, "plan">) => {
    const candidate = request.plan.candidate;
    if (
      candidate.directory !== setup.runtimeDirectory ||
      candidate.artifactSha256 !== setup.runtimeSha256 ||
      !isDeepStrictEqual(candidate.node, setup.node)
    )
      throw new BootstrapRequestConflict("Bootstrap request does not match the installed runner");
    await verifyBootstrapReleaseArtifacts(candidate, await verifySetup());
    await verifyRenewalPlan(setup, request.plan);
  };
  const dispatch = async (request: CoordinatorBootstrapRequest, automatic: boolean) => {
    await verifyCandidate(request);
    const source = await readBootstrapPreparedFile(setup.ownerLauncher, await verifySetup());
    if (automatic)
      request = requests.reserveAutomaticDispatch({
        id: request.id,
        revision: request.revision,
        planSha256: request.planSha256,
      });
    const current = requests.list().find((item) => item.id === request.id);
    if (!current || current.revision !== request.revision || current.execution)
      throw new BootstrapRequestConflict("Bootstrap decision changed before launch");
    const executionSetup = setup.renewal
      ? persistRenewalSetup(request.plan.state.directory, setup, request)
      : setupFile;
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-c",
        source.toString("utf8"),
        path.join(request.plan.state.directory, "coordinator-bootstrap-execution.lock"),
        setup.node.path,
        setup.entrypoint.path,
        executionSetup,
        "executor",
        request.id,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } },
    );
    child.on("error", () => {});
    try {
      await waitForBootstrapWatchdog(child, "executor");
    } catch {
      // An observation failure is not permission to signal or relaunch a child.
      throw new BootstrapRequestConflict(
        "Bootstrap dispatch is unconfirmed. Refresh its recorded status before recovery.",
      );
    } finally {
      child.stdout?.destroy();
      child.unref();
    }
    const dispatched = requests.list().find((item) => item.id === request.id);
    if (!dispatched?.execution)
      throw new BootstrapRequestConflict("Bootstrap dispatch receipt is unavailable");
    return dispatched;
  };
  return {
    list: () => requests.list(),
    prepare: async (input) => {
      const prepared = CoordinatorBootstrapPreparationSchema.parse(input);
      await verifyCandidate(prepared);
      return requests.prepare(prepared);
    },
    decide: async (input, password) => {
      const decision = CoordinatorBootstrapDecisionSchema.parse(input);
      if (decision.decision === "approve") {
        const pending = requests.list().find((item) => item.id === decision.id);
        if (!pending) throw new BootstrapRequestConflict("Exact bootstrap review is unavailable");
        await verifyCandidate(pending);
      }
      const request = await requests.decide(input, password);
      if (request.status !== "approved") return request;
      return dispatch(request, false);
    },
    automatic: {
      prepare: async (input, proof) => {
        const prepared = CoordinatorBootstrapPreparationSchema.parse(input);
        const config = InstallationConfigSchema.parse(
          readPrivateBootstrapConfiguration(
            setup.renewal?.configuration.path ?? admission.configurationFile,
            uid,
          ),
        );
        const authority = verifyCoordinatorSubmission(config, prepared, proof);
        await verifyCandidate(prepared);
        return requests.prepareAutomatic(prepared, authority);
      },
      reconcile: async (id) => {
        requests.revokeAutomatic();
        const request = requests.list().find((item) => item.id === id);
        if (!request?.automaticSubmission)
          throw new BootstrapRequestConflict("Authenticated coordinator submission required");
        if (request.status === "canceled" || request.execution || request.automaticDispatch)
          return request;
        requests.requireAutomaticReconciliation(request);
        if (request.status === "pending") {
          await verifyCandidate(request);
          return requests.approveAutomatic({
            id: request.id,
            revision: request.revision,
            planSha256: request.planSha256,
          });
        }
        if (!request.automaticApproval)
          throw new BootstrapRequestConflict("Manual approval cannot authorize automatic dispatch");
        if (Date.now() < Date.parse(request.automaticApproval.dispatchAfter)) return request;
        return dispatch(request, true);
      },
    },
  };
}
