import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { constants, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  BootstrapClaimedRecoveryRequestSchema,
  type BootstrapClaimedRecoveryRequest,
  type BootstrapPreclaimDispatchObservation,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import { BootstrapRenewalSchema, deriveBootstrapRenewal } from "./coordinator-bootstrap-renewal.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
  readPrivateBootstrapConfiguration,
  readBootstrapHostBinding,
} from "./coordinator-bootstrap-host.js";
import {
  deriveClaimedHostRuntime,
  verifyManagedClaimedPreparation,
  type ClaimedHostInput,
} from "./coordinator-bootstrap-claimed-host.js";
import {
  ClaimedRecoveryReviews,
  claimedRecoveryPlanDigest,
  validateClaimedRecoveryPlan,
} from "./coordinator-bootstrap-claimed-recovery.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { FileClaimedRecoveryReviewJournal } from "./coordinator-bootstrap-claimed-journal.js";
import {
  readBootstrapPreparedFile,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import type { ClaimedRecoveryReviewService } from "./coordinator-bootstrap-session.js";
import {
  AuditedProcessObservationSchema,
  ProcessObservationSchema,
} from "./coordinator-bootstrap-process.js";
import { writeRecoverySnapshot } from "./coordinator-bootstrap-launch.js";

export const ClaimedReferenceSchema = BootstrapClaimedRecoveryRequestSchema.pick({
  id: true,
  revision: true,
  planSha256: true,
});

export const ClaimedProvisioningContextSchema = z.strictObject({
  installationRoot: z.string().startsWith("/"),
  admissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  hostRuntime: BootstrapRunnerSetupSchema,
  controlProcess: ProcessObservationSchema,
});

export const ClaimedRunnerSetupSchema = BootstrapRunnerSetupSchema.extend({
  version: z.literal(1),
  kind: z.literal("bootstrap-claimed-recovery"),
  stateDirectory: z.string().startsWith("/"),
  request: ClaimedReferenceSchema,
  original: ClaimedReferenceSchema,
  renewal: BootstrapRenewalSchema,
  inspector: BootstrapRunnerSetupSchema.shape.entrypoint,
  selectedLauncherFile: z.string().startsWith("/"),
  // First repair keeps the genuine selected Host snapshot separate from its
  // independently provisioned executor. Ordinary snapshots omit this field.
  provisioning: ClaimedProvisioningContextSchema.optional(),
});

/** A fresh execution snapshot does not edit the installed runner/admission.
 * Callers receive a path, never a dispatch receipt. The launcher separately
 * consumes its durable attempt and the runner must still verify native admission. */
export async function persistClaimedLaunchSetup(
  input: Omit<ClaimedHostInput, "plan"> & {
    request: BootstrapClaimedRecoveryRequest;
  },
): Promise<string> {
  return (await persistClaimedLaunchSnapshot(input)).file;
}

async function persistClaimedLaunchSnapshot(
  input: Omit<ClaimedHostInput, "plan"> & {
    request: BootstrapClaimedRecoveryRequest;
  },
) {
  const request = BootstrapClaimedRecoveryRequestSchema.parse(input.request);
  validateClaimedRecoveryPlan(request.plan);
  if (
    request.status !== "approved" ||
    !request.decisionAt ||
    request.execution ||
    request.planSha256 !== claimedRecoveryPlanDigest(request.plan)
  )
    throw new BootstrapRequestConflict("Exact undispatched recovery approval required");
  const state = request.plan.original.plan.state.directory;
  const journal = new FileClaimedRecoveryReviewJournal(state);
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
    `coordinator-claimed-attempt-${request.id}-${request.revision}.json`,
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
  const setup = await deriveClaimedHostRuntime({
    ...input,
    plan: request.plan,
  });
  // Verify the captured admission digest before using its Docker or inspector
  // paths. A concurrent anchor edit cannot redirect snapshot preparation.
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(setup.renewal!.originalAdmission, [])).toString("utf8"),
    ),
  );
  const snapshot = ClaimedRunnerSetupSchema.parse({
    ...setup,
    version: 1,
    kind: "bootstrap-claimed-recovery",
    // Keep terminal authority verification separate from the exact stalled
    // original, whose fence is verified by the claimed recovery journal.
    renewal: {
      ...setup.renewal,
      request: {
        id: request.plan.original.id,
        revision: request.plan.original.revision,
        planSha256: request.plan.original.planSha256,
      },
    },
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
    `coordinator-claimed-launch-${request.id}-${request.revision}.json`,
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

export async function prepareNativeClaimedLaunch(
  input: Omit<ClaimedHostInput, "plan"> & { request: BootstrapClaimedRecoveryRequest },
): Promise<() => Promise<void>> {
  const request = BootstrapClaimedRecoveryRequestSchema.parse(input.request);
  const { file: setupFile, snapshot } = await persistClaimedLaunchSnapshot({ ...input, request });
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
  const journal = new FileClaimedRecoveryReviewJournal(snapshot.stateDirectory);
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
        "claimed-launch",
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

/** Historical observations only. Missing receipts never establish that a
 * process is absent, and retained birth never establishes current liveness. */
export function readClaimedDispatchObservation(
  stateDirectory: string,
  request: BootstrapClaimedRecoveryRequest,
): BootstrapPreclaimDispatchObservation {
  try {
    const uid = process.getuid?.();
    if (uid === undefined || stateDirectory !== request.plan.original.plan.state.directory)
      throw new BootstrapRequestConflict("Recovery observation state changed");
    return readClaimedDispatchReceipts(stateDirectory, request, uid);
  } catch {
    return { state: "unavailable" };
  }
}

function findClaimedAttempt(stateDirectory: string, requestId: string): string | undefined {
  const files = readdirSync(stateDirectory);
  const attempts = files.filter((name) =>
    name.startsWith(`coordinator-claimed-attempt-${requestId}-`),
  );
  if (
    attempts.length > 1 ||
    (!attempts.length &&
      files.some((name) => name.startsWith(`coordinator-claimed-executor-${requestId}-`)))
  )
    throw new BootstrapRequestConflict("Recovery receipts are ambiguous or incomplete");
  return attempts[0];
}

function readClaimedDispatchReceipts(
  stateDirectory: string,
  request: BootstrapClaimedRecoveryRequest,
  uid: number,
): BootstrapPreclaimDispatchObservation {
  const attemptFile = findClaimedAttempt(stateDirectory, request.id);
  if (!attemptFile) return { state: "no_receipt" };
  const attempt = z
    .strictObject({
      version: z.literal(1),
      request: ClaimedReferenceSchema,
      setup: z.string(),
      launcherPid: z.number().int().positive(),
      attemptId: z.string().uuid(),
    })
    .parse(readPrivateBootstrapConfiguration(path.join(stateDirectory, attemptFile), uid));
  const reference = attempt.request;
  if (
    reference.id !== request.id ||
    reference.planSha256 !== request.planSha256 ||
    attemptFile !== `coordinator-claimed-attempt-${request.id}-${reference.revision}.json` ||
    attempt.setup !==
      path.join(
        stateDirectory,
        `coordinator-claimed-launch-${request.id}-${reference.revision}.json`,
      ) ||
    (request.status === "approved" && !request.execution && request.revision !== reference.revision)
  )
    throw new BootstrapRequestConflict("Recovery attempt differs from its review");
  const observation = { approvedRevision: reference.revision, attemptId: attempt.attemptId };
  const file = path.join(
    stateDirectory,
    `coordinator-claimed-executor-${request.id}-${reference.revision}.json`,
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
      request: ClaimedReferenceSchema,
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

/** Observation has no effect entrypoint and retains the same execution generation. */
export async function launchClaimedObservation(
  stateDirectory: string,
  input: { id: string; revision: string; planSha256: string; generation: string },
): Promise<void> {
  const journal = new FileClaimedRecoveryReviewJournal(stateDirectory);
  const request = journal.readReviews().find((r) => r.id === input.id);
  if (
    !request ||
    request.revision !== input.revision ||
    request.planSha256 !== input.planSha256 ||
    request.status !== "approved" ||
    request.execution?.generation !== input.generation
  )
    throw new BootstrapRequestConflict("Exact retained recovery generation required");
  const observation = readClaimedDispatchObservation(stateDirectory, request);
  if (observation.state !== "birth_retained")
    throw new BootstrapRequestConflict("Retained recovery birth is unavailable");
  const setupFile = path.join(
    stateDirectory,
    `coordinator-claimed-launch-${request.id}-${observation.approvedRevision}.json`,
  );
  const setup = ClaimedRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(setupFile, process.getuid!()),
  );
  if (
    setup.stateDirectory !== stateDirectory ||
    setup.request.id !== input.id ||
    setup.request.revision !== observation.approvedRevision ||
    setup.request.planSha256 !== input.planSha256
  )
    throw new BootstrapRequestConflict("Retained recovery snapshot changed");
  const birth = z
    .strictObject({
      version: z.literal(1),
      request: ClaimedReferenceSchema,
      attemptId: z.string().uuid(),
      setup: BootstrapRunnerSetupSchema.shape.entrypoint,
      executor: AuditedProcessObservationSchema,
    })
    .parse(
      readPrivateBootstrapConfiguration(
        path.join(
          stateDirectory,
          `coordinator-claimed-executor-${request.id}-${observation.approvedRevision}.json`,
        ),
        process.getuid!(),
      ),
    );
  // The retained birth pins the immutable snapshot. Do not execute a helper
  // selected by replacement snapshot bytes, even if they name the same review.
  if (
    birth.setup.path !== setupFile ||
    !isDeepStrictEqual(birth.request, setup.request) ||
    birth.attemptId !== observation.attemptId
  )
    throw new BootstrapRequestConflict("Retained recovery birth changed");
  const pinnedSetup = await readBootstrapPreparedFile(birth.setup, []);
  if (
    !isDeepStrictEqual(
      ClaimedRunnerSetupSchema.parse(JSON.parse(pinnedSetup.toString("utf8"))),
      setup,
    )
  )
    throw new BootstrapRequestConflict("Retained recovery snapshot bytes changed");
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(setup.renewal.originalAdmission, [])).toString("utf8"),
    ),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  await assertBootstrapPathsProtected([stateDirectory], roots);
  await readBootstrapPreparedFile(birth.setup, roots);
  const source = await readBootstrapPreparedFile(setup.ownerLauncher, roots);
  if (
    !isDeepStrictEqual(
      journal.readReviews().find((r) => r.id === request.id),
      request,
    )
  )
    throw new BootstrapRequestConflict("Recovery decision changed before observation");
  const child = spawn(
    "/usr/bin/python3",
    [
      "-I",
      "-B",
      "-c",
      source.toString("utf8"),
      "claimed-observe",
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

/** Only a newly recorded decision starts preparation. Construction and reads
 * never scan approvals for replay. Cancellation remains available throughout
 * preparation; the protected launcher repeats this check before claiming. */
export function createDispatchingClaimedReview(
  reviews: ClaimedRecoveryReviews,
  prepareLaunch: (request: BootstrapClaimedRecoveryRequest) => Promise<() => Promise<void>>,
): ClaimedRecoveryReviewService {
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

/** Readiness reconstructs selected Host authority independently. It neither
 * approves nor launches retained work, including work with a recorded approval. */
export async function createManagedClaimedRecoveryReview(
  setupFile: string | undefined,
  daemonId: string,
  ports?: ClaimedHostInput["ports"],
): Promise<ClaimedRecoveryReviewService | undefined> {
  if (!setupFile) return undefined;
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native Host claimed recovery initialization required");
  const anchor = BootstrapRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(setupFile, uid),
  );
  if (anchor.daemonId !== daemonId || anchor.renewal)
    throw new BootstrapRequestConflict(
      "Claimed recovery requires the installed Host bootstrap anchor",
    );
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(anchor.admissionSetupFile, uid),
  );
  const binding = readBootstrapHostBinding(admission.configurationFile, daemonId);
  const originalJournal = new FileBootstrapRequestJournal(binding.stateDirectory);
  const journal = new FileClaimedRecoveryReviewJournal(binding.stateDirectory);
  const records = originalJournal.read();
  const retained = journal.readReviews();
  // A claimed original can be excluded from terminal reconstruction only with
  // independent unpromoted proof, or its exact separately reviewed durable fence.
  const candidates = records.filter(
    (record) =>
      record.status === "approved" &&
      (record.execution?.stage === "claimed" ||
        (record.execution?.stage === "recovery_required" &&
          retained.some((review) => review.plan.original.id === record.id && review.execution))),
  );
  if (candidates.length > 1)
    throw new BootstrapRequestConflict("Claimed recovery requires an unambiguous retained target");
  const target = candidates[0];
  const verifyTarget = () => {
    if (
      !isDeepStrictEqual(
        anchor,
        BootstrapRunnerSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid)),
      ) ||
      !isDeepStrictEqual(
        admission,
        BootstrapAdmissionSetupSchema.parse(
          readPrivateBootstrapConfiguration(anchor.admissionSetupFile, uid),
        ),
      )
    )
      throw new BootstrapRequestConflict("Claimed recovery anchor changed during initialization");

    if (
      !isDeepStrictEqual(originalJournal.read(), records) ||
      !isDeepStrictEqual(journal.readReviews(), retained)
    )
      throw new BootstrapRequestConflict("Claimed recovery history changed during initialization");
    if (!target) return;
    if (
      target.plan.installationId !== binding.binding.installationId ||
      target.plan.service !== binding.binding.service ||
      target.plan.state.directory !== binding.stateDirectory
    )
      throw new BootstrapRequestConflict("Claimed recovery target belongs to another installation");
    if (target.execution?.stage === "claimed") {
      originalJournal.verifyUnpromotedClaim(target);
      return;
    }
    const reviews = retained.filter(
      (review) =>
        review.plan.original.id === target.id &&
        review.execution &&
        review.execution.stage !== "aborted_before_effects",
    );
    if (reviews.length !== 1)
      throw new BootstrapRequestConflict("Claimed recovery fence is ambiguous or unavailable");
    journal.inspectEffects(reviews[0]!);
  };
  verifyTarget();
  const runtime = await deriveBootstrapRenewal({
    setupFile,
    setup: anchor,
    moduleFile: ports?.moduleFile ?? fileURLToPath(import.meta.url),
    hostPid: ports?.hostProcessId ?? process.pid,
    ports,
    ...(target ? { dispatchedRequest: { id: target.id, planSha256: target.planSha256 } } : {}),
  });
  if (!runtime?.renewal)
    throw new BootstrapRequestConflict(
      "Claimed recovery requires verified selected Host renewal context",
    );
  verifyTarget();
  const configuration = runtime.renewal.configuration;
  const readBinding = () => {
    const current = readBootstrapHostBinding(configuration.path, daemonId);
    if (
      current.stateDirectory !== binding.stateDirectory ||
      current.binding.installationId !== binding.binding.installationId ||
      current.binding.service !== binding.binding.service
    )
      throw new BootstrapRequestConflict("Claimed recovery installation binding changed");
    return current.binding;
  };
  const reviews = new ClaimedRecoveryReviews(journal, readBinding, (plan) =>
    verifyManagedClaimedPreparation({ setupFile, daemonId, plan, ports }),
  );
  reviews.list();
  readBinding();
  const service = createDispatchingClaimedReview(reviews, (request) =>
    prepareNativeClaimedLaunch({ setupFile, daemonId, request, ports }),
  );
  return {
    ...service,
    reconcile: (input) => launchClaimedObservation(binding.stateDirectory, input),
    list: () =>
      service.list().map((request) =>
        Object.assign({}, request, {
          dispatch: readClaimedDispatchObservation(binding.stateDirectory, request),
        }),
      ),
  };
}
