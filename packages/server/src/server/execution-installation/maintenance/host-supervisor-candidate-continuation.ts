import { createHash } from "node:crypto";
import { existsSync, readlinkSync, constants, openSync, closeSync, fsyncSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  FileEnrollmentJournal,
  consumeHostContinuation,
  hostContinuationReservationDigest,
  observeHostContinuation,
  withHostContinuationAdmission,
  type HostContinuationConsumption,
} from "./authorization.js";
import { BootstrapRequestConflict } from "../coordinator-bootstrap-errors.js";
import {
  retainMaintenancePublishedFile,
  retainMaintenancePublishedLink,
  selectMaintenanceFiles,
  selectMaintenanceReleaseLink,
} from "../coordinator-bootstrap-maintenance-file-selection.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { verifyRetainedProcessExited } from "../coordinator-bootstrap-service.js";
import {
  InitialHostSupervisorPreconditionSchema,
  inspectInitialHostSupervisorMigrationPlan,
} from "./host-supervisor-contract.js";
import {
  writeInitialHostArtifact,
  verifyInitialHostMigrationLaunchers,
} from "./host-supervisor-migration.js";
import {
  HostContinuationPhaseSchema,
  HostRestorationLaunchIntentSchema,
  HostRestorationClaimSchema,
  boundedRead,
  hostContinuationPaths,
  hostRestorationPaths,
  hostContinuationPublicationRecords,
  readCaptured,
  restorationService,
  retainBinding,
  retainProof,
  type HostRestorationPrepared,
  type HostRestorationAbsence,
} from "./host-supervisor-continuation.js";
import type { EnrollmentDaemonObservation } from "./native-daemon-inspection.js";

import {
  attemptHostContinuationCommand,
  HostContinuationCommandQueueAttemptSchema,
  type HostContinuationCommandOwner,
} from "./host-supervisor-command-admission.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => sha(JSON.stringify(value));
function requireMatch(value: unknown, detail: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(`Host candidate continuation: ${detail}`);
}
const capturedFile = z.strictObject({
  path: absolute,
  sha256: digest,
  bytesBase64: z.string().max(1_400_000),
});
/** Data, never proof. The native owner must retain these exact observed files
 * before reservation; a timestamp or reconstructed expected image is insufficient. */
export const HostCandidateLateImageSchema = z.strictObject({
  original: z.strictObject({ plan: capturedFile, intent: capturedFile, claim: capturedFile }),
  restoration: z.strictObject({
    intent: capturedFile,
    claim: capturedFile,
    phase: capturedFile,
    launcherAttempt: capturedFile,
    selectorAttempt: capturedFile,
    bootstrapAttempt: capturedFile,
    result: capturedFile,
  }),
  launcher: capturedFile,
  selector: z.strictObject({ path: absolute, text: absolute, resolvedTarget: absolute }),
});
export const HostCandidateLatePreconditionSchema = InitialHostSupervisorPreconditionSchema.omit({
  purpose: true,
  provenance: true,
}).extend({
  purpose: z.literal("host-candidate-continuation"),
  provenance: z.literal("sealed-fallback-and-native-custody"),
  observedAt: z.iso.datetime(),
});
/** A pre-reservation native-owner pin, not constructor election. There is no
 * preparation producer/writer here. It can be read before reservation and held
 * by the caller's existing reserveHostCandidateContinuation custody callback. */
export const HostCandidatePreparationSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("host-candidate-preparation"),
  id: z.uuid(),
  installationId: z.uuid(),
  grantId: z.uuid(),
  grantRevision: z.uuid(),
  manifestSha256: digest,
  stepId: z.uuid(),
  planSha256: digest,
  originalClaimSha256: digest,
  restorationGeneration: z.uuid(),
  restorationObservationSha256: digest,
  restorationChildExitSha256: digest,
  image: HostCandidateLateImageSchema,
  precondition: HostCandidateLatePreconditionSchema,
});
export const HostCandidateLaunchIntentSchema = HostRestorationLaunchIntentSchema.extend({
  role: z.literal("candidate"),
  preparationId: z.uuid(),
  preparationSha256: digest,
  restorationGeneration: z.uuid(),
  restorationObservationSha256: digest,
  restorationChildExitSha256: digest,
  preconditionSha256: digest,
});
export const HostCandidateClaimSchema = HostRestorationClaimSchema.extend({
  role: z.literal("candidate"),
  preparationSha256: digest,
  publicationSnapshotSha256: digest,
  preconditionSha256: digest,
  restorationGeneration: z.uuid(),
  restorationObservationSha256: digest,
  restorationChildExitSha256: digest,
});
export interface HostCandidateInput {
  journal: FileEnrollmentJournal;
  stepId: string;
  generation: string;
  plan: unknown;
}
type Plan = ReturnType<typeof inspectInitialHostSupervisorMigrationPlan>["plan"];
type Preparation = z.infer<typeof HostCandidatePreparationSchema>;
export interface HostCandidateContext {
  plan: Plan;
  intent: z.infer<typeof HostCandidateLaunchIntentSchema>;
  intentSha256: string;
  preparation: Preparation;
  preparationSha256: string;
  claim: z.infer<typeof HostCandidateClaimSchema>;
  claimSha256: string;
}
function preparationPath(directory: string, step: string, id: string) {
  // Reuse canonical directory/UUID checks; all metadata stays in the existing root.
  hostContinuationPaths(directory, step, "candidate", id);
  return path.join(directory, `host-continuation-${step}-candidate-preparation-${id}.json`);
}
function fileBytes(file: z.infer<typeof capturedFile>) {
  const bytes = Buffer.from(file.bytesBase64, "base64");
  requireMatch(
    bytes.toString("base64") === file.bytesBase64 && sha(bytes) === file.sha256,
    "captured file digest differs",
  );
  return bytes;
}
function parseFile<T>(file: z.infer<typeof capturedFile>, parse: (value: unknown) => T) {
  return parse(JSON.parse(fileBytes(file).toString("utf8")));
}
function retainFile(file: z.infer<typeof capturedFile>) {
  const lifetime = retainServiceFiles([file.path]);
  const contents = retainMaintenancePublishedFile(file.path, fileBytes(file));
  return () => {
    lifetime();
    contents();
    lifetime();
  };
}
function parsePreparation(input: {
  journal: FileEnrollmentJournal;
  stepId: string;
  plan: unknown;
  preparationId: string;
}) {
  const { plan, planSha256 } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const pin = readCaptured(
    preparationPath(input.journal.stateDirectory, input.stepId, input.preparationId),
    (value) => HostCandidatePreparationSchema.parse(value),
  );
  const p = pin.record,
    state = input.journal.readPolicySnapshot();
  requireMatch(state.status === "enrolled", "enrollment absent");
  const lineage = state.activation.hostContinuations?.find((row) => row.stepId === input.stepId);
  requireMatch(
    lineage?.restoration.observation?.outcome === "legacy-restored",
    "restoration is not verified",
  );
  const r = lineage.restoration,
    result = r.observation!;
  requireMatch(
    [
      p.id === input.preparationId,
      p.stepId === input.stepId,
      p.installationId === plan.installationId,
      p.grantId === state.grant.id,
      p.grantRevision === (lineage.candidate?.grantRevision ?? state.grant.revision),
      p.manifestSha256 === state.activation.manifestSha256,
      p.planSha256 === planSha256,
      p.originalClaimSha256 === lineage.original.claimSha256,
      p.restorationGeneration === r.generation,
      p.restorationObservationSha256 === result.observationSha256,
      p.restorationChildExitSha256 === result.childExitSha256,
    ].every(Boolean),
    "preparation differs from retained restoration",
  );
  const i = p.image,
    predecessor = p.precondition;
  const restorePaths = hostRestorationPaths(
    input.journal.stateDirectory,
    input.stepId,
    r.generation,
  );
  requireMatch(
    [
      i.original.plan.path ===
        path.join(
          plan.precondition.identity.installationRoot,
          "initial-host-migrations",
          "plans",
          `${planSha256}.json`,
        ),
      i.original.intent.path ===
        path.join(
          input.journal.stateDirectory,
          `initial-host-${input.stepId}-${lineage.original.failed.generation}.json`,
        ),
      i.original.claim.path ===
        path.join(
          input.journal.stateDirectory,
          `initial-host-claim-${input.stepId}-${lineage.original.failed.generation}.json`,
        ),
      i.original.intent.sha256 === lineage.original.intentSha256,
      i.original.claim.sha256 === lineage.original.claimSha256,
    ].every(Boolean),
    "original history image differs",
  );
  requireMatch(
    inspectInitialHostSupervisorMigrationPlan(parseFile(i.original.plan, (value) => value))
      .planSha256 === planSha256,
    "captured plan changed",
  );
  for (const key of Object.keys(i.restoration) as Array<keyof typeof i.restoration>)
    requireMatch(i.restoration[key].path === restorePaths[key], "restoration namespace differs");
  const restoreIntent = parseFile(i.restoration.intent, (value) =>
    HostRestorationLaunchIntentSchema.parse(value),
  );
  const restoreClaim = parseFile(i.restoration.claim, (value) =>
    HostRestorationClaimSchema.parse(value),
  );
  requireMatch(
    i.restoration.intent.sha256 === r.claim?.intentSha256 &&
      i.restoration.claim.sha256 === r.claim.claimSha256 &&
      hash(restoreClaim.executor) === r.claim.executorSha256 &&
      restoreClaim.intentSha256 === i.restoration.intent.sha256 &&
      restoreIntent.generation === r.generation &&
      restoreClaim.generation === r.generation,
    "restoration claim differs from ledger",
  );
  const restorePhase = parseFile(i.restoration.phase, (value) =>
    HostContinuationPhaseSchema.parse(value),
  );
  requireMatch(
    [
      restorePhase.role === "restoration",
      restorePhase.stepId === input.stepId,
      restorePhase.generation === r.generation,
      restorePhase.intentSha256 === i.restoration.intent.sha256,
      restorePhase.claimSha256 === i.restoration.claim.sha256,
      restorePhase.reservationSha256 === restoreClaim.reservationSha256,
      restorePhase.planSha256 === planSha256,
      restorePhase.originalClaimSha256 === lineage.original.claimSha256,
      restorePhase.publicationSnapshotSha256 === r.evidence.publicationSnapshotSha256,
    ].every(Boolean),
    "restoration phase mixes unrelated claims",
  );
  const launcherAttempt = parseFile(i.restoration.launcherAttempt, (value) =>
    z
      .object({ files: z.array(z.object({ previousSha256: digest.nullable() })).min(1) })
      .passthrough()
      .parse(value),
  );
  const selectorAttempt = parseFile(i.restoration.selectorAttempt, (value) =>
    z.object({ previous: absolute }).passthrough().parse(value),
  );
  const priorLauncher = launcherAttempt.files[0].previousSha256;
  requireMatch(
    priorLauncher &&
      [plan.precondition.launcher.sha256, plan.candidate.launcher.sha256].includes(priorLauncher) &&
      [plan.precondition.selectedRelease, plan.candidate.directory].includes(
        selectorAttempt.previous,
      ),
    "unreviewed restoration baseline",
  );
  const canonicalRestoration = hostContinuationPublicationRecords({
    plan,
    directory: input.journal.stateDirectory,
    phase: restorePhase,
    previousLauncherSha256: priorLauncher,
    previousSelector: selectorAttempt.previous,
  });
  requireMatch(
    [
      fileBytes(i.restoration.phase).equals(
        Buffer.from(JSON.stringify(canonicalRestoration.phase)),
      ),
      fileBytes(i.restoration.launcherAttempt).equals(
        Buffer.from(JSON.stringify(canonicalRestoration.launcherAttempt)),
      ),
      fileBytes(i.restoration.selectorAttempt).equals(
        Buffer.from(JSON.stringify(canonicalRestoration.selectorAttempt)),
      ),
      fileBytes(i.restoration.bootstrapAttempt).equals(
        Buffer.from(
          JSON.stringify({
            ...canonicalRestoration.phase,
            operation: "bootstrap",
            service: restorationService(plan),
          }),
        ),
      ),
    ].every(Boolean),
    "noncanonical restoration publication",
  );
  const restored = parseFile(i.restoration.result, (value) =>
    z.record(z.string(), z.unknown()).parse(value),
  );
  requireMatch(
    [
      i.restoration.result.sha256 === result.observationSha256,
      restored.generation === r.generation,
      restored.claimSha256 === i.restoration.claim.sha256,
      restored.selectedRelease === plan.fallback.directory,
      restored.sourceCommit === plan.fallback.sourceCommit,
      isDeepStrictEqual(restored.supervisor, predecessor.supervisor),
      isDeepStrictEqual(restored.worker, predecessor.worker),
    ].every(Boolean),
    "late predecessor is not the retained restored lifetime",
  );
  requireMatch(
    [
      isDeepStrictEqual(predecessor.identity, plan.precondition.identity),
      isDeepStrictEqual(predecessor.configuration, plan.precondition.configuration),
      isDeepStrictEqual(predecessor.clientConfiguration, plan.precondition.clientConfiguration),
      isDeepStrictEqual(predecessor.node, plan.fallback.node),
      isDeepStrictEqual(predecessor.registration, plan.precondition.registration),
      predecessor.supervisorEntrypoint.sha256 === plan.fallback.entrypoint.sha256,
      predecessor.workerEntrypoint.sha256 === plan.precondition.workerEntrypoint.sha256,
      predecessor.sourceReceipt.sha256 === plan.precondition.sourceReceipt.sha256,
      predecessor.serverId === plan.precondition.serverId,
      predecessor.selectedRelease === plan.fallback.directory,
      predecessor.sourceCommit === plan.fallback.sourceCommit,
      predecessor.launcher.path === plan.precondition.launcher.path,
      predecessor.launcher.sha256 === plan.fallback.launcher.sha256,
      predecessor.worker.parentPid === predecessor.supervisor.pid,
      !isDeepStrictEqual(predecessor.supervisor, plan.precondition.supervisor),
      !isDeepStrictEqual(predecessor.worker, plan.precondition.worker),
      hash(predecessor) !== plan.preconditionSha256,
    ].every(Boolean),
    "late predecessor changed sealed fallback, configuration or native lifetimes",
  );
  requireMatch(
    [
      i.launcher.path === predecessor.launcher.path,
      i.launcher.sha256 === predecessor.launcher.sha256,
      i.selector.path === plan.precondition.identity.selectionPath,
      i.selector.text === plan.fallback.directory,
      i.selector.resolvedTarget === plan.fallback.directory,
    ].every(Boolean),
    "late publication is not exact restored image",
  );
  for (const file of [...Object.values(i.original), ...Object.values(i.restoration), i.launcher])
    fileBytes(file);
  return {
    plan,
    pin,
    lineage,
    preparation: p,
    evidence: {
      restorationGeneration: r.generation,
      restorationObservationSha256: result.observationSha256,
      restorationChildExitSha256: result.childExitSha256,
      publicationSnapshotSha256: hash(i),
      preconditionSha256: hash(predecessor),
    },
  };
}
/** Read and retain the actual protected pin BEFORE reservation. Expected values
 * only select data. Native source, pre-reservation custody and runtime proofs
 * must be supplied independently through existing reservation admission. */
export function readHostCandidatePreparation(input: Parameters<typeof parsePreparation>[0]) {
  const retained = parsePreparation(input);
  const binding = retainBinding({
    plan: retained.plan,
    preparation: retained.preparation,
    evidence: retained.evidence,
  });
  const controls = [
    ...Object.values(retained.preparation.image.original),
    ...Object.values(retained.preparation.image.restoration),
  ].map(retainFile);
  const launcher = retainFile(retained.preparation.image.launcher);
  const selector = retainMaintenancePublishedLink(
    retained.preparation.image.selector.path,
    retained.plan.fallback.directory,
  );
  const assertControls = () => {
    binding.check();
    retained.pin.assertCurrent();
    for (const proof of controls) proof();
    retained.pin.assertCurrent();
    binding.check();
  };
  const assertCurrent = () => {
    assertControls();
    launcher();
    selector();
    requireMatch(
      readlinkSync(retained.preparation.image.selector.path) === retained.plan.fallback.directory,
      "late selector changed",
    );
    assertControls();
  };
  assertCurrent();
  return { ...retained, assertControls, assertCurrent };
}
function readContext(input: HostCandidateInput) {
  const paths = hostContinuationPaths(
    input.journal.stateDirectory,
    input.stepId,
    "candidate",
    input.generation,
  );
  const intent = readCaptured(paths.intent, (value) =>
    HostCandidateLaunchIntentSchema.parse(value),
  );
  const retained = parsePreparation({ ...input, preparationId: intent.record.preparationId });
  const { lineage, preparation: p, evidence } = retained;
  const c = lineage.candidate;
  requireMatch(
    c &&
      c.generation === input.generation &&
      c.grantRevision === intent.record.grantRevision &&
      p.grantRevision === c.grantRevision &&
      isDeepStrictEqual(c.evidence, evidence) &&
      intent.record.stepId === input.stepId &&
      intent.record.generation === input.generation &&
      intent.record.planSha256 === p.planSha256 &&
      intent.record.installationId === p.installationId &&
      intent.record.grantId === p.grantId &&
      intent.record.manifestSha256 === p.manifestSha256 &&
      intent.record.preparationSha256 === retained.pin.sha256 &&
      intent.record.reservationSha256 === hostContinuationReservationDigest(lineage, "candidate") &&
      intent.record.publicationSnapshotSha256 === evidence.publicationSnapshotSha256 &&
      intent.record.preconditionSha256 === evidence.preconditionSha256 &&
      intent.record.restorationGeneration === evidence.restorationGeneration &&
      intent.record.restorationObservationSha256 === evidence.restorationObservationSha256 &&
      intent.record.restorationChildExitSha256 === evidence.restorationChildExitSha256 &&
      intent.record.originalClaimSha256 === lineage.original.claimSha256,
    "intent is not the exact active candidate and retained preparation",
  );
  return { ...retained, paths, intent, child: c };
}
function records(input: HostCandidateInput, context: HostCandidateContext) {
  const i = context.intent,
    p = context.preparation;
  return hostContinuationPublicationRecords({
    plan: context.plan,
    directory: input.journal.stateDirectory,
    phase: {
      version: 1,
      role: "candidate",
      slot: "candidate",
      stepId: i.stepId,
      generation: i.generation,
      intentSha256: context.intentSha256,
      claimSha256: context.claimSha256,
      reservationSha256: i.reservationSha256,
      planSha256: i.planSha256,
      originalClaimSha256: i.originalClaimSha256,
      publicationSnapshotSha256: i.publicationSnapshotSha256,
      restorationGeneration: i.restorationGeneration,
      restorationObservationSha256: i.restorationObservationSha256,
      restorationChildExitSha256: i.restorationChildExitSha256,
      restorationClaimSha256: p.image.restoration.claim.sha256,
      preconditionSha256: i.preconditionSha256,
    },
    previousLauncherSha256: p.image.launcher.sha256,
    previousSelector: p.image.selector.resolvedTarget,
  });
}
export interface HostCandidateCustody {
  /** Independently verified constructor arrangement, immutable actual child and
   * the pin held by the existing reservation owner BEFORE allocation. */
  assertCurrent(context: HostCandidateContext): void;
  assertExclusive: HostContinuationConsumption["assertExclusive"];
}
function consumption(
  input: HostCandidateInput,
  context: HostCandidateContext,
  ports: HostCandidateCustody,
  assertCurrent: () => void,
): HostContinuationConsumption {
  return {
    grantRevision: context.intent.grantRevision,
    stepId: input.stepId,
    generation: input.generation,
    role: "candidate",
    plan: context.plan,
    reservationSha256: context.intent.reservationSha256,
    intentSha256: context.intentSha256,
    claimSha256: context.claimSha256,
    executor: context.claim.executor,
    publication: null,
    assertExclusive: ports.assertExclusive,
    assertCurrent,
  };
}
/** A local gate returned after durable claim consumption. Command composition
 * is separate below and still requires independently verified native owners. */
function candidateAttemptPresent(paths: ReturnType<typeof hostContinuationPaths>) {
  const prefix = paths.intent.slice(0, -"-intent.json".length);
  return [
    paths.phase,
    paths.launcherAttempt,
    paths.selectorAttempt,
    paths.result,
    ...(["interruption", "retirement", "bootstrap"] as const).flatMap((operation) => [
      `${prefix}-${operation}-attempt.json`,
      `${prefix}-${operation}-queue-attempt.json`,
    ]),
  ].some(existsSync);
}
export interface HostCandidateClaimHandle {
  readonly status: "consumed";
  readonly claimSha256: string;
  /** Local one-use control flow, never native authority or a retained grant. */
  publish(ports: HostCandidatePublicationPorts): { status: "published"; bootstrap: "unavailable" };
  /** Read-only retained image custody. Carries no lifecycle authority. */
  assertPublicationCurrent(): void;
}
export function consumeHostCandidateChild(
  input: HostCandidateInput,
  executorValue: unknown,
  supplied: HostCandidateCustody,
): HostCandidateClaimHandle {
  const ports = retainBinding(supplied),
    read = readContext(input);
  requireMatch(
    !read.child.claim && !existsSync(read.paths.claim) && !candidateAttemptPresent(read.paths),
    "candidate consumed or uncertain; observe only",
  );
  const executor = BootstrapProcessIdentitySchema.parse(executorValue);
  requireMatch(
    executor.pid === process.pid &&
      executor.parentPid === process.ppid &&
      executor.uid === process.getuid?.() &&
      executor.executable === read.intent.record.runtime.node.path,
    "actual executor differs",
  );
  requireMatch(
    executor.bootId === read.preparation.precondition.supervisor.bootId &&
      birth(executor.startIdentity) >= BigInt(Date.parse(read.intent.record.createdAt)) * 1000n &&
      birth(executor.startIdentity) <= BigInt(Date.now()) * 1000n,
    "born executor predates its pinned launch intent",
  );
  const claim = HostCandidateClaimSchema.parse({
    version: 1,
    operation: "host-continuation-claim",
    role: "candidate",
    intentSha256: read.intent.sha256,
    reservationSha256: read.intent.record.reservationSha256,
    stepId: input.stepId,
    generation: input.generation,
    planSha256: read.intent.record.planSha256,
    executor,
    consumedAt: new Date().toISOString(),
    preparationSha256: read.pin.sha256,
    ...read.evidence,
  });
  const context: HostCandidateContext = {
    plan: read.plan,
    preparation: read.preparation,
    preparationSha256: read.pin.sha256,
    intent: read.intent.record,
    intentSha256: read.intent.sha256,
    claim,
    claimSha256: hash(claim),
  };
  const binding = retainBinding(context),
    image = readHostCandidatePreparation({
      ...input,
      preparationId: read.intent.record.preparationId,
    });
  let nativeClaim:
    | ReturnType<typeof readCaptured<z.infer<typeof HostCandidateClaimSchema>>>
    | undefined;
  const assertCurrent = () => {
    binding.check();
    ports.check();
    read.intent.assertCurrent();
    image.assertCurrent();
    requireMatch(
      ports.snapshot.assertCurrent(context) === undefined,
      "native custody must be synchronous",
    );
    binding.check();
    ports.check();
    const age = Date.now() - Date.parse(context.preparation.precondition.observedAt);
    requireMatch(age >= 0 && age < 30_000, "late predecessor custody expired");
    image.assertCurrent();
    read.intent.assertCurrent();
    nativeClaim?.assertCurrent();
  };
  const effect = consumption(input, context, ports.snapshot, () => {
    assertCurrent();
    if (!nativeClaim) {
      writeInitialHostArtifact(input.journal.stateDirectory, read.paths.claim, claim);
      nativeClaim = readCaptured(read.paths.claim, (value) =>
        HostCandidateClaimSchema.parse(value),
      );
      requireMatch(nativeClaim.sha256 === context.claimSha256, "claim bytes disagree");
    }
    assertCurrent();
  });
  consumeHostContinuation(input.journal, effect);
  const retainedInput = {
    journal: input.journal,
    stepId: context.intent.stepId,
    generation: context.intent.generation,
    plan: structuredClone(context.plan),
  };
  let attempted = false;
  let publicationProof: (() => void) | undefined;
  return {
    status: "consumed",
    claimSha256: context.claimSha256,
    publish(publicationPorts) {
      requireMatch(!attempted, "publication attempted or uncertain; observe only");
      attempted = true;
      // This callback exists only after durable consume returned successfully.
      // A lost response/reopened claim can never reconstruct it.
      // The late predecessor is historical after interruption/retirement. Do
      // not demand its old live observation remains fresh or shorten grace.
      // New publication proofs independently establish current self/closure/
      // absence/inventories under fresh lifecycle admission.
      binding.check();
      ports.check();
      read.intent.assertCurrent();
      image.assertControls();
      requireMatch(nativeClaim, "native claim missing");
      nativeClaim.assertCurrent();
      return publishCandidate(retainedInput, publicationPorts, context.claimSha256, (proof) => {
        publicationProof = proof;
      });
    },
    assertPublicationCurrent() {
      requireMatch(publicationProof, "publication is not retained");
      publicationProof();
    },
  };
}
function consumed(input: HostCandidateInput, allowObserved = false) {
  const read = readContext(input),
    claim = readCaptured(read.paths.claim, (value) => HostCandidateClaimSchema.parse(value));
  const c = read.child.claim;
  requireMatch(
    c &&
      (allowObserved || !read.child.observation) &&
      c.claimSha256 === claim.sha256 &&
      c.intentSha256 === read.intent.sha256 &&
      c.executorSha256 === hash(claim.record.executor) &&
      claim.record.intentSha256 === read.intent.sha256 &&
      claim.record.preparationSha256 === read.pin.sha256 &&
      claim.record.reservationSha256 === read.intent.record.reservationSha256 &&
      claim.record.stepId === input.stepId &&
      claim.record.generation === input.generation &&
      claim.record.planSha256 === read.intent.record.planSha256 &&
      Object.entries(read.evidence).every(
        ([key, value]) => Reflect.get(claim.record, key) === value,
      ),
    "claim and ledger disagree",
  );
  const context: HostCandidateContext = {
    plan: read.plan,
    preparation: read.preparation,
    preparationSha256: read.pin.sha256,
    intent: read.intent.record,
    intentSha256: read.intent.sha256,
    claim: claim.record,
    claimSha256: claim.sha256,
  };
  const binding = retainBinding(context);
  return {
    ...read,
    claim,
    context,
    check: () => {
      binding.check();
      read.pin.assertCurrent();
      read.intent.assertCurrent();
      claim.assertCurrent();
    },
  };
}
export interface HostCandidatePublicationPorts extends HostCandidateCustody {
  prepared: HostRestorationPrepared;
  absence: HostRestorationAbsence;
  /** Independent exhaustive workload closure; an interruption acknowledgment
   * never supplies this proof. It must remain retained through publication. */
  closure: {
    claimSha256: string;
    preconditionSha256: string;
    evidenceSha256: string;
    assertCurrent(): void;
  };
}
export function publishHostCandidateContinuation(
  handle: HostCandidateClaimHandle,
  ports: HostCandidatePublicationPorts,
) {
  return handle.publish(ports);
}
function publishCandidate(
  input: HostCandidateInput,
  supplied: HostCandidatePublicationPorts,
  expectedClaimSha256: string,
  retainPublished: (proof: () => void) => void,
) {
  const ports = retainBinding(supplied),
    read = consumed(input),
    context = read.context;
  requireMatch(context.claimSha256 === expectedClaimSha256, "local claim lifetime changed");
  const prepared = retainProof(supplied.prepared),
    absence = retainProof(supplied.absence),
    closure = retainProof(supplied.closure);
  const canonical = records(input, context),
    p = context.preparation;
  requireMatch(
    ![
      canonical.paths.phase,
      canonical.paths.launcherAttempt,
      canonical.paths.selectorAttempt,
      canonical.paths.bootstrapAttempt,
    ].some(existsSync),
    "publication attempted; observe only",
  );
  const image = readHostCandidatePreparation({
    ...input,
    preparationId: context.intent.preparationId,
  });
  let target = image.assertCurrent;
  let launcherPhaseProof: (() => void) | undefined;
  const fresh = () => {
    const a = absence.data,
      age = Date.now() - Date.parse(a.observedAt);
    requireMatch(
      age >= 0 &&
        age < 30_000 &&
        a.absent === true &&
        a.identitySha256 === read.plan.identitySha256 &&
        a.bootId === context.claim.executor.bootId &&
        a.service === restorationService(read.plan) &&
        isDeepStrictEqual(
          [...a.runtimeDirectories].sort(),
          [
            ...new Set([
              read.plan.precondition.selectedRelease,
              read.plan.candidate.directory,
              read.plan.fallback.directory,
            ]),
          ].sort(),
        ),
      "fresh exact service/all-slot absence required",
    );
  };
  const check = () => {
    requireMatch(
      context.claim.executor.pid === process.pid &&
        context.claim.executor.parentPid === process.ppid &&
        context.claim.executor.uid === process.getuid?.() &&
        context.claim.executor.executable === context.intent.runtime.node.path,
      "publication is not owned by the actual immutable child",
    );
    ports.check();
    read.check();
    image.assertControls();
    target();
    prepared.check();
    absence.check();
    closure.check();
    fresh();
    requireMatch(
      prepared.data.planSha256 === context.intent.planSha256 &&
        sha(prepared.data.launcher) === read.plan.candidate.launcher.sha256 &&
        closure.data.claimSha256 === context.claimSha256 &&
        closure.data.preconditionSha256 === context.intent.preconditionSha256,
      "prepared candidate or closure differs",
    );
    digest.parse(closure.data.evidenceSha256);
    verifyInitialHostMigrationLaunchers({ plan: read.plan, ...prepared.data.launchers });
    for (const proof of [prepared, closure, absence]) {
      proof.assertCurrent();
      ports.check();
      read.check();
      image.assertControls();
      target();
      prepared.check();
      absence.check();
      closure.check();
      fresh();
    }
    requireMatch(
      ports.snapshot.assertCurrent(context) === undefined,
      "native custody must be synchronous",
    );
    ports.check();
    read.check();
    image.assertControls();
    target();
    prepared.check();
    absence.check();
    closure.check();
    fresh();
  };
  const effect = consumption(input, context, ports.snapshot, check);
  withHostContinuationAdmission(input.journal, effect, (_custody, reassert) => {
    reassert();
    const result = selectMaintenanceFiles({
      attemptFile: canonical.paths.launcherAttempt,
      reservationSha256: context.claimSha256,
      launcher: {
        path: p.image.launcher.path,
        previousSha256: p.image.launcher.sha256,
        bytes: Buffer.from(prepared.data.launcher),
      },
      selection: {
        path: canonical.paths.phase,
        previousSha256: null,
        bytes: Buffer.from(JSON.stringify(canonical.phase)),
      },
      assertCurrent: reassert,
    });
    requireMatch(isDeepStrictEqual(result, canonical.launcherAttempt), "launcher records differ");
    const proofs = [
      retainMaintenancePublishedFile(
        canonical.paths.launcherAttempt,
        Buffer.from(JSON.stringify(canonical.launcherAttempt)),
      ),
      retainMaintenancePublishedFile(
        canonical.paths.phase,
        Buffer.from(JSON.stringify(canonical.phase)),
      ),
      retainMaintenancePublishedFile(p.image.launcher.path, Buffer.from(prepared.data.launcher)),
    ];
    const selector = retainMaintenancePublishedLink(
      p.image.selector.path,
      p.image.selector.resolvedTarget,
    );
    launcherPhaseProof = () => {
      for (const proof of proofs) proof();
    };
    target = () => {
      launcherPhaseProof!();
      selector();
      requireMatch(
        readlinkSync(p.image.selector.path) === p.image.selector.text,
        "untouched selector changed",
      );
    };
    reassert();
  });
  requireMatch(launcherPhaseProof, "new launcher custody missing");
  const retainedLauncher = launcherPhaseProof;
  withHostContinuationAdmission(input.journal, effect, (_custody, reassert) => {
    reassert();
    const result = selectMaintenanceReleaseLink({
      attemptFile: canonical.paths.selectorAttempt,
      reservationSha256: context.claimSha256,
      link: p.image.selector.path,
      previous: p.image.selector.resolvedTarget,
      candidate: read.plan.candidate.directory,
      assertCurrent: reassert,
    });
    requireMatch(isDeepStrictEqual(result, canonical.selectorAttempt), "selector record differs");
    const attempt = retainMaintenancePublishedFile(
      canonical.paths.selectorAttempt,
      Buffer.from(JSON.stringify(canonical.selectorAttempt)),
    );
    const selector = retainMaintenancePublishedLink(
      p.image.selector.path,
      read.plan.candidate.directory,
    );
    // Keep the first publication's exact retained lifetimes. Never recapture.
    target = () => {
      retainedLauncher();
      attempt();
      selector();
      requireMatch(
        readlinkSync(p.image.selector.path) === read.plan.candidate.directory,
        "candidate selector text changed",
      );
    };
    reassert();
  });
  // File publication runs no command; the separate caller uses queue admission.
  check();
  retainPublished(() => {
    ports.check();
    read.check();
    image.assertControls();
    target();
  });
  return { status: "published" as const, bootstrap: "unavailable" as const };
}

export interface HostCandidateObservationPorts {
  reader: Parameters<typeof verifyRetainedProcessExited>[0];
  assertControlCurrent(context: HostCandidateContext): void;
  collectPrepared(
    context: HostCandidateContext,
    signal: AbortSignal,
  ): Promise<HostRestorationPrepared>;
  /** Ordinary strict candidate proof; never the legacy restoration collector. */
  collectCandidate(
    context: HostCandidateContext,
    signal: AbortSignal,
  ): Promise<EnrollmentDaemonObservation>;
}
function birth(value: string) {
  const match = /^(\d+):(\d{1,6})$/.exec(value);
  requireMatch(match, "native birth invalid");
  return BigInt(match[1]) * 1_000_000n + BigInt(match[2]);
}
export async function observeHostCandidateContinuation(
  input: HostCandidateInput,
  supplied: HostCandidateObservationPorts,
) {
  try {
    return await observeCandidate(input, supplied);
  } catch {
    return { status: "unresolved" as const };
  }
}
async function observeCandidate(
  input: HostCandidateInput,
  supplied: HostCandidateObservationPorts,
) {
  const ports = retainBinding(supplied),
    read = consumed(input, true),
    context = read.context;
  const control = () => {
    ports.check();
    read.check();
    requireMatch(
      ports.snapshot.assertControlCurrent(context) === undefined,
      "control custody must be synchronous",
    );
    ports.check();
    read.check();
  };
  control();
  await boundedRead(
    () => verifyRetainedProcessExited(ports.snapshot.reader, context.claim.executor),
    "Candidate child exit unresolved",
  );
  control();
  // Target artifacts/readiness are unreachable until the exact child exit gate.
  const controls = [
    ...Object.values(context.preparation.image.original),
    ...Object.values(context.preparation.image.restoration),
  ].map(retainFile);
  const canonical = records(input, context);
  const bootstrapFence = readCaptured(canonical.paths.bootstrapAttempt, (value) =>
    z.record(z.string(), z.unknown()).parse(value),
  );
  requireMatch(
    bootstrapFence.sha256 ===
      hash({
        ...canonical.phase,
        operation: "bootstrap",
        service: restorationService(read.plan),
      }),
    "bootstrap command fence differs",
  );
  const queueAttempt = readCaptured(
    canonical.paths.bootstrapAttempt.replace(/-attempt\.json$/, "-queue-attempt.json"),
    (value) => HostContinuationCommandQueueAttemptSchema.parse(value),
  );
  const queued = queueAttempt.record;
  requireMatch(
    queued.command === "bootstrap" &&
      queued.role === "candidate" &&
      queued.stepId === input.stepId &&
      queued.generation === input.generation &&
      queued.reservationSha256 === context.intent.reservationSha256 &&
      queued.intentSha256 === context.intentSha256 &&
      queued.claimSha256 === context.claimSha256 &&
      isDeepStrictEqual(queued.executor, context.claim.executor) &&
      isDeepStrictEqual(queued.scope, {
        identitySha256: read.plan.identitySha256,
        artifactSha256: read.plan.candidate.artifactSha256,
        preconditionSha256: context.intent.preconditionSha256,
      }) &&
      queued.fenceSha256 === bootstrapFence.sha256,
    "bootstrap queue attempt differs",
  );
  // The protected bytes retain command/channel hashes. They establish only an
  // attempted queue call, never delivery, a reconstructed channel or settlement.
  const bootstrapControls = [bootstrapFence.assertCurrent, queueAttempt.assertCurrent];
  for (const assert of bootstrapControls) assert();
  const prepared = retainProof(
    await boundedRead(
      (signal) => ports.snapshot.collectPrepared(context, signal),
      "Candidate preparation unresolved",
    ),
  );
  requireMatch(
    prepared.data.planSha256 === context.intent.planSha256 &&
      sha(prepared.data.launcher) === read.plan.candidate.launcher.sha256,
    "candidate inventory differs",
  );
  verifyInitialHostMigrationLaunchers({ plan: read.plan, ...prepared.data.launchers });
  const image = [
    retainMaintenancePublishedFile(
      canonical.paths.phase,
      Buffer.from(JSON.stringify(canonical.phase)),
    ),
    retainMaintenancePublishedFile(
      canonical.paths.launcherAttempt,
      Buffer.from(JSON.stringify(canonical.launcherAttempt)),
    ),
    retainMaintenancePublishedFile(
      canonical.paths.selectorAttempt,
      Buffer.from(JSON.stringify(canonical.selectorAttempt)),
    ),
    retainMaintenancePublishedFile(
      read.plan.precondition.launcher.path,
      Buffer.from(prepared.data.launcher),
    ),
    retainMaintenancePublishedLink(
      read.plan.precondition.identity.selectionPath!,
      read.plan.candidate.directory,
    ),
  ];
  const observed = retainProof(
    await boundedRead(
      (signal) => ports.snapshot.collectCandidate(context, signal),
      "Candidate readiness unresolved",
    ),
  );
  let record = {
    version: 1,
    role: "candidate",
    stepId: input.stepId,
    generation: input.generation,
    planSha256: context.intent.planSha256,
    claimSha256: context.claimSha256,
    preparationSha256: context.preparationSha256,
    preconditionSha256: context.intent.preconditionSha256,
    outcome: "candidate-ready",
    serverId: observed.data.serverId,
    sourceCommit: observed.data.sourceCommit,
    selectedRelease: observed.data.selectedRelease,
    supervisor: structuredClone(observed.data.supervisor),
    worker: structuredClone(observed.data.worker),
    observedAt: observed.data.observedAt,
  };
  const check = () => {
    ports.check();
    read.check();
    prepared.check();
    observed.check();
    for (const proof of [...controls, ...image, ...bootstrapControls]) proof();
    const o = observed.data,
      previous = context.preparation.precondition,
      age = Date.now() - Date.parse(o.observedAt);
    requireMatch(
      age >= 0 &&
        age < 30_000 &&
        o.identitySha256 === read.plan.identitySha256 &&
        isDeepStrictEqual(o.descriptor, read.plan.precondition.identity) &&
        o.serverId === previous.serverId &&
        o.sourceCommit === read.plan.candidate.sourceCommit &&
        o.selectedRelease === read.plan.candidate.directory &&
        o.worker.parentPid === o.supervisor.pid &&
        readlinkSync(previous.identity.selectionPath!) === read.plan.candidate.directory,
      "not ordinary exact candidate readiness",
    );
    for (const process of [o.supervisor, o.worker])
      requireMatch(
        process.bootId === context.claim.executor.bootId &&
          process.uid === previous.identity.custodyOwnerUid &&
          birth(process.startIdentity) >= BigInt(Date.parse(context.claim.consumedAt)) * 1000n &&
          birth(process.startIdentity) <= BigInt(Date.now()) * 1000n &&
          ![
            previous.supervisor,
            previous.worker,
            read.plan.precondition.supervisor,
            read.plan.precondition.worker,
            context.claim.executor,
          ].some((old) => isDeepStrictEqual(process, old)),
        "candidate lifetime reused predecessor",
      );
  };
  const assertCurrent = () => {
    check();
    for (const proof of [prepared, observed]) {
      proof.assertCurrent();
      check();
    }
    control();
    check();
  };
  assertCurrent();
  if (existsSync(canonical.paths.result)) {
    const existing = readCaptured(canonical.paths.result, (value) =>
      z.record(z.string(), z.unknown()).parse(value),
    );
    requireMatch(
      typeof existing.record.observedAt === "string" &&
        Date.parse(existing.record.observedAt) <= Date.parse(record.observedAt) &&
        isDeepStrictEqual({ ...existing.record, observedAt: record.observedAt }, record),
      "retained result differs",
    );
    record = { ...record, observedAt: existing.record.observedAt };
    existing.assertCurrent();
    for (const file of [canonical.paths.result, path.dirname(canonical.paths.result)]) {
      const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    existing.assertCurrent();
  } else writeInitialHostArtifact(input.journal.stateDirectory, canonical.paths.result, record);
  const result = retainMaintenancePublishedFile(
    canonical.paths.result,
    Buffer.from(JSON.stringify(record)),
  );
  observeHostContinuation(input.journal, {
    stepId: input.stepId,
    generation: input.generation,
    role: "candidate",
    claimSha256: context.claimSha256,
    executor: context.claim.executor,
    outcome: "candidate-ready",
    observationSha256: hash(record),
    childExitSha256: hash({
      claimSha256: context.claimSha256,
      executor: context.claim.executor,
      exited: true,
    }),
    assertCurrent() {
      assertCurrent();
      result();
    },
  });
  return { status: "candidate-ready" as const, observationSha256: hash(record) };
}

export type HostCandidateCommandOperation = HostContinuationCommandOwner["operation"];
type PublicationEvidence = Pick<HostCandidatePublicationPorts, "prepared" | "absence" | "closure">;
export type HostCandidateRetirement =
  | {
      status: "present";
      preconditionSha256: string;
      precondition: z.infer<typeof HostCandidateLatePreconditionSchema>;
      observedAt: string;
      assertCurrent(): void;
    }
  | { status: "absent"; evidence: PublicationEvidence };
export interface HostCandidateExecutionPorts extends HostCandidateCustody {
  executor: unknown;
  /** Mandatory independently verified native owner. It must use the ACTUAL
   * fixed command data/channel and bind reviewed operation/service/limits to
   * that handle. Expected fields, this callback name and helper return values
   * provide no native authority. There is no default producer here. */
  commandOwner(
    operation: HostCandidateCommandOperation,
    context: HostCandidateContext,
    fence: { file: string; bytes: Uint8Array },
  ): HostContinuationCommandOwner;
  /** Completion/acknowledgment only. Never descendant closure or target absence. */
  observeCompletion(
    operation: HostCandidateCommandOperation,
    context: HostCandidateContext,
    signal: AbortSignal,
  ): Promise<void>;
  collectRetirement(
    context: HostCandidateContext,
    signal: AbortSignal,
  ): Promise<HostCandidateRetirement>;
  collectPublicationEvidence(
    context: HostCandidateContext,
    signal: AbortSignal,
  ): Promise<PublicationEvidence>;
}
/** Invoked by the already-born immutable native child. No election, native
 * owner factory or default command implementation is supplied. All failures
 * retain consumed claims/fences and future calls can only observe. A return
 * records a queue ATTEMPT, never native delivery or candidate readiness. */
export async function executeHostCandidateContinuation(
  input: HostCandidateInput,
  supplied: HostCandidateExecutionPorts,
) {
  try {
    return await executeCandidate(input, supplied);
  } catch {
    return { status: "unresolved" as const };
  }
}
async function executeCandidate(input: HostCandidateInput, supplied: HostCandidateExecutionPorts) {
  const ports = retainBinding(supplied),
    initial = readContext(input);
  if (
    initial.child.claim ||
    existsSync(initial.paths.claim) ||
    candidateAttemptPresent(initial.paths)
  )
    return { status: "observe-only" as const };
  const custody: HostCandidateCustody = {
    assertCurrent(context) {
      ports.check();
      requireMatch(
        ports.snapshot.assertCurrent(context) === undefined,
        "native child custody must be synchronous",
      );
      ports.check();
    },
    assertExclusive(context) {
      ports.check();
      requireMatch(
        ports.snapshot.assertExclusive(context) === undefined,
        "global exclusion must be synchronous",
      );
      ports.check();
    },
  };
  const handle = consumeHostCandidateChild(input, ports.snapshot.executor, custody);
  const read = consumed(input),
    context = read.context,
    canonical = records(input, context);
  const before = readHostCandidatePreparation({
    ...input,
    preparationId: context.intent.preparationId,
  });
  let target = before.assertCurrent;
  let stageProof: () => void = () => undefined;
  const control = () => {
    ports.check();
    read.check();
    before.assertControls();
    target();
    stageProof();
    requireMatch(
      ports.snapshot.assertCurrent(context) === undefined,
      "native child custody must be synchronous",
    );
    ports.check();
    read.check();
    before.assertControls();
    target();
    stageProof();
  };
  const effect = consumption(input, context, custody, control);
  const fences: Array<() => void> = [];
  const check = () => {
    control();
    for (const proof of fences) proof();
    control();
  };
  effect.assertCurrent = check;
  const service = restorationService(read.plan);
  const attempt = async (operation: HostCandidateCommandOperation) => {
    const prefix = path.join(
      input.journal.stateDirectory,
      `host-continuation-${input.stepId}-candidate-${input.generation}`,
    );
    const file = `${prefix}-${operation}-attempt.json`;
    const record = {
      ...canonical.phase,
      operation,
      service,
      ...(operation === "interruption" ? { interruption: read.plan.interruption } : {}),
    };
    const bytes = Buffer.from(JSON.stringify(record));
    // PRIOR durable fence. Any uncertainty here prevents the queue helper call.
    withHostContinuationAdmission(input.journal, effect, (_state, reassert) => {
      reassert();
      writeInitialHostArtifact(input.journal.stateDirectory, file, record);
      fences.push(retainMaintenancePublishedFile(file, bytes));
      reassert();
    });
    check();
    const owner = ports.snapshot.commandOwner(operation, context, { file, bytes });
    ports.check();
    read.check();
    check();
    requireMatch(
      owner.operation === operation && isDeepStrictEqual(owner.executor, context.claim.executor),
      "native command owner differs",
    );
    // These select semantics of the ACTUAL command object. Only the independent
    // native owner's assertion can bind those data to its real channel.
    requireMatch(
      Reflect.get(owner.command, "operation") === operation &&
        Reflect.get(owner.command, "service") === service &&
        (operation !== "interruption" ||
          isDeepStrictEqual(Reflect.get(owner.command, "interruption"), read.plan.interruption)),
      "actual fixed command differs from reviewed operation/service/limits",
    );
    attemptHostContinuationCommand(input.journal, effect, owner);
    // Native wait/RPC completion is outside every lifecycle lock, and supplies
    // neither closure nor absence. Subsequent effects need new admission.
    await boundedRead(
      (signal) => ports.snapshot.observeCompletion(operation, context, signal),
      `${operation} completion remains unresolved`,
    );
    ports.check();
    read.check();
  };
  await attempt("interruption");
  const retirement = await boundedRead(
    (signal) => ports.snapshot.collectRetirement(context, signal),
    "Fresh predecessor retirement remains unresolved",
  );
  ports.check();
  read.check();
  if (retirement.status === "present") {
    const present = retainProof(retirement);
    stageProof = () => {
      const fresh = () => {
        present.check();
        const age = Date.now() - Date.parse(present.data.observedAt);
        requireMatch(
          age >= 0 &&
            age < 30_000 &&
            present.data.preconditionSha256 === context.intent.preconditionSha256 &&
            isDeepStrictEqual(present.data.precondition, context.preparation.precondition),
          "retirement does not name exact fresh legacy predecessor",
        );
      };
      fresh();
      present.assertCurrent();
      fresh();
    };
    check();
    await attempt("retirement");
    // The old live-predecessor proof is now historical, not continuing evidence.
    stageProof = () => {
      present.check();
    };
  } else {
    requireMatch(retirement.status === "absent", "retirement is inconclusive");
    stageProof = retainPublicationEvidence(retirement.evidence, context);
    stageProof();
  }
  const evidence = await boundedRead(
    (signal) => ports.snapshot.collectPublicationEvidence(context, signal),
    "Independent closure/absence remains unresolved",
  );
  ports.check();
  read.check();
  stageProof = retainPublicationEvidence(evidence, context);
  check();
  handle.publish({
    ...custody,
    prepared: evidence.prepared,
    absence: evidence.absence,
    closure: evidence.closure,
  });
  target = handle.assertPublicationCurrent;
  check();
  await attempt("bootstrap");
  return { status: "bootstrap-attempted" as const };
}
function retainPublicationEvidence(evidence: PublicationEvidence, context: HostCandidateContext) {
  const prepared = retainProof(evidence.prepared),
    absence = retainProof(evidence.absence),
    closure = retainProof(evidence.closure);
  const passive = () => {
    prepared.check();
    absence.check();
    closure.check();
    const a = absence.data,
      age = Date.now() - Date.parse(a.observedAt);
    requireMatch(
      age >= 0 &&
        age < 30_000 &&
        a.absent === true &&
        a.identitySha256 === context.plan.identitySha256 &&
        a.bootId === context.claim.executor.bootId &&
        a.service === restorationService(context.plan) &&
        isDeepStrictEqual(
          [...a.runtimeDirectories].sort(),
          [
            ...new Set([
              context.plan.precondition.selectedRelease,
              context.plan.candidate.directory,
              context.plan.fallback.directory,
            ]),
          ].sort(),
        ) &&
        closure.data.claimSha256 === context.claimSha256 &&
        closure.data.preconditionSha256 === context.intent.preconditionSha256 &&
        prepared.data.planSha256 === context.intent.planSha256 &&
        sha(prepared.data.launcher) === context.plan.candidate.launcher.sha256,
      "independent full closure/all-slot absence/prepared evidence differs",
    );
    digest.parse(closure.data.evidenceSha256);
    digest.parse(a.evidenceSha256);
  };
  return () => {
    passive();
    for (const proof of [prepared, closure, absence]) {
      proof.assertCurrent();
      passive();
    }
  };
}
