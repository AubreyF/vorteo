import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  RestartJobSchema,
  SupervisorEffectSchema,
  SupervisorEffectBindingSchema,
  SupervisorEffectObservationSchema,
  SupervisorEffectExecutorSchema,
  SupervisorEffectChildSchema,
  type RestartJob,
  type SupervisorEffect,
  type SupervisorEffectBinding,
  type SupervisorEffectExecutor,
  type SupervisorEffectChild,
  type SupervisorEffectObservation,
} from "@getpaseo/protocol/execution-installation";
import { isSupervisorEffectSettled, type LifecycleJob } from "../lifecycle-journal.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import {
  inspectLifecycleActivationChild,
  type LifecycleActivationChild,
} from "../coordinator-bootstrap-maintenance-child.js";
import { FileEnrollmentJournal } from "./authorization.js";
import { evaluateStandingRestart, standingRestartPlanDigest } from "./restart-admission.js";
import { InstallationConfigSchema } from "../config.js";
import {
  DevRegistrationReceiptSchema,
  prepareDevRegistrationPublication,
  publishDevRegistration,
  captureC1RegistrationDocuments,
  retainC1RegistrationDocuments,
  c1RegistrationPublicationAttempt,
} from "./dev-registration.js";
import {
  verifyRetainedDevRegistrationProvisioner,
  assertDevRegistrationDockerPin,
  devRegistrationC1Receipt,
  type PreparedDevRegistrationProvisioner,
} from "./dev-registration-provisioner.js";
import { DaemonMaintenanceProcessSchema } from "@getpaseo/protocol/maintenance-interruption";

type PublicationInput = Parameters<typeof prepareDevRegistrationPublication>[0];
export interface DevRegistrationExecutionCandidate {
  operation: "replace" | "rollback";
  provisioner: PreparedDevRegistrationProvisioner;
  publication: Omit<PublicationInput, "readiness">;
  publicationAttemptFile: string;
}
export interface DevRegistrationExecutionPreflight {
  /** New format requires this pin from the independently verified actual Host
   * release/admission, retained by assertCurrent. Candidate bytes are not proof. */
  selectedConfiguration?: { path: string; sha256: string };
  /** Actual retained executor arrangement, never a PID chosen for a later fork. */
  controller: SupervisorEffectExecutor;
  nativeIdentitySha256: string;
  preconditionSha256: string;
  /** Independently proven predecessor closure or the exact admitted idle transition. */
  settlementSha256: string;
  assertCurrent(): void;
}
export interface DevRegistrationExecutionObservation {
  controller: SupervisorEffectExecutor;
  child: SupervisorEffectChild | null;
  record: SupervisorEffectObservation;
  /** Independently read protected outcome. A returned script acknowledgement alone is insufficient. */
  nativeResult: {
    claimSha256: string;
    planSha256: string;
    jobId: string;
    scriptSha256: string;
    operation: "replace" | "rollback";
    phase: "started-unverified";
    rootExecutor: z.infer<typeof DaemonMaintenanceProcessSchema>;
  } | null;
  readiness: unknown | null;
  /** Verifies retained executor lifetime/artifacts, native result, Host attempt,
   * readiness and claimed child/root-executor/workload settlement, without effects.
   * New-format observation also retains the actual selected C1 Host runtime and
   * admission, not a C0 descriptor substituted as runtime authority. */
  assertCurrent(): void;
}
export interface DevRegistrationExecutionChildProof {
  claim: SupervisorEffectChild;
  assertCurrent(): void;
}
export interface DevRegistrationExecutionPorts {
  preflight(
    job: RestartJob,
    candidate: DevRegistrationExecutionCandidate,
  ): Promise<DevRegistrationExecutionPreflight>;
  /** Creates one gated child after durable reservation. It must not release
   * root effects; only exact child consumption can authorize that release. */
  launch(
    reservation: SupervisorEffect,
    proof: DevRegistrationExecutionPreflight,
  ): Promise<DevRegistrationExecutionChildProof>;
  /** Synchronous one-use gate release under fresh locked admission after durable
   * child consumption. No arbitrary command or default resolver is supplied. */
  invoke(effect: SupervisorEffect, proof: DevRegistrationExecutionChildProof): void;
  observe(
    effect: SupervisorEffect,
    candidate: DevRegistrationExecutionCandidate,
  ): Promise<DevRegistrationExecutionObservation>;
}
interface ExecutionInput {
  directory: string;
  requestId: string;
  originalRequestId?: string;
  candidate: DevRegistrationExecutionCandidate;
  credentialBindingSha256: string;
  ports: DevRegistrationExecutionPorts;
  now(): string;
}
export interface DevRegistrationExecutionResult {
  effect: SupervisorEffect;
  /** False means protected journal admission refused progress; retained consumption still fences replay. */
  recorded: boolean;
}
function conflict(message: string): never {
  throw new BootstrapRequestConflict(message);
}
function requireMatch(ok: boolean, message: string): asserts ok {
  if (!ok) conflict(message);
}
function sha(value: unknown): string {
  const bytes = Buffer.isBuffer(value) ? value : JSON.stringify(value);
  requireMatch(bytes !== undefined, "Registration binding is not serializable");
  return createHash("sha256").update(bytes).digest("hex");
}
function sync(check: () => void): void {
  const result: unknown = check();
  requireMatch(result === undefined, "Dev registration proof must complete synchronously");
}
function restart(job: LifecycleJob): job is RestartJob {
  return job.target === "host" || job.target === "container-daemon";
}
function request(jobs: readonly LifecycleJob[], id: string): RestartJob {
  const job = jobs.find((item) => item.id === id);
  requireMatch(Boolean(job && restart(job)), "Dev registration request is absent");
  if (!job || !restart(job)) conflict("Dev registration request is absent");
  return RestartJobSchema.parse(job);
}
function passiveChange(before: LifecycleJob | undefined, after: LifecycleJob): boolean {
  if (!before) return after.status === "pending" || after.status === "rejected";
  return (
    isDeepStrictEqual({ ...before, status: after.status, detail: after.detail }, after) &&
    (before.status === after.status || ["failed", "succeeded", "rejected"].includes(after.status))
  );
}

interface EffectAdmission {
  previous: readonly LifecycleJob[];
  next: readonly LifecycleJob[];
  assertReserve?(job: RestartJob): void;
  assertConsume?(job: RestartJob): void;
  assertObservation?(job: RestartJob): void;
}
function effectJobs(jobs: readonly LifecycleJob[]) {
  return jobs.filter(
    (job): job is RestartJob & { supervisorEffect: SupervisorEffect } =>
      restart(job) && Boolean(job.supervisorEffect),
  );
}
export function devRegistrationReservationDigest(effect: SupervisorEffect): string {
  return sha({ binding: effect.binding, reservedAt: effect.reservedAt });
}
export function devRegistrationAuthority(effect: SupervisorEffect) {
  requireMatch(
    effect.phase !== "reserved" && Boolean(effect.consumedAt) && Boolean(effect.child),
    "Registration has no consumed child authority",
  );
  if (!effect.consumedAt || !effect.child) conflict("Registration has no consumed child authority");
  return {
    binding: effect.binding,
    reservedAt: effect.reservedAt,
    consumedAt: effect.consumedAt,
    child: effect.child,
  };
}
export function devRegistrationAuthorityDigest(effect: SupervisorEffect): string {
  return sha(devRegistrationAuthority(effect));
}
function assertBoundRequest(job: RestartJob, effect: SupervisorEffect): void {
  const bound = SupervisorEffectSchema.parse(effect).binding;
  requireMatch(
    job.id === bound.requestId &&
      job.revision === bound.requestRevision &&
      job.supervisorPlanSha256 === bound.supervisorPlanSha256 &&
      job.target === "container-daemon" &&
      job.approvedAt === bound.approvedAt &&
      sha(job.standingDecision) === bound.decisionSha256 &&
      standingRestartPlanDigest(job) === bound.requestPlanSha256,
    "Retained supervisor effect request binding changed",
  );
  if (effect.phase !== "reserved" && effect.child)
    requireMatch(
      effect.child.reservationSha256 === devRegistrationReservationDigest(effect),
      "Consumed child reservation changed",
    );
}
function assertTransition(
  input: EffectAdmission,
  prior: LifecycleJob | undefined,
  job: RestartJob & { supervisorEffect: SupervisorEffect },
): void {
  const old = prior && restart(prior) ? prior.supervisorEffect : undefined;
  const effect = job.supervisorEffect;
  if (!old) {
    requireMatch(
      Boolean(
        prior &&
        prior.status === "running" &&
        job.status === "running" &&
        effect.phase === "reserved",
      ),
      "Supervisor dispatch requires its current running job",
    );
    requireMatch(
      Boolean(input.assertReserve),
      "Supervisor reservation needs current native admission",
    );
    sync(() => input.assertReserve!(job));
    return;
  }
  requireMatch(
    isDeepStrictEqual(old.binding, effect.binding) &&
      old.reservedAt === effect.reservedAt &&
      !["pending", "approved"].includes(job.status),
    "Reserved supervisor effect is observation-only",
  );
  if (isDeepStrictEqual(old, effect)) return;
  if (old.phase === "reserved" && effect.phase === "consumed") {
    requireMatch(
      job.status === "running" && Boolean(input.assertConsume),
      "Child consumption needs current native admission",
    );
    sync(() => input.assertConsume!(job));
    return;
  }
  requireMatch(
    effect.phase === "observed" || (old.phase === "consumed" && effect.phase === "uncertain"),
    "Supervisor effect cannot be reset",
  );
  requireMatch(
    effect.consumedAt === (old.phase === "reserved" ? null : old.consumedAt),
    "Observation cannot create or replace consumption",
  );
  if (old.phase !== "reserved" && old.child)
    requireMatch(
      isDeepStrictEqual(old.child, effect.child),
      "Consumed effect child cannot be replaced",
    );
  requireMatch(
    Boolean(input.assertObservation),
    "Supervisor observation needs independent evidence",
  );
  sync(() => input.assertObservation!(job));
}
/** Mandatory hook for every lifecycle writer, including failed parents. */
export function assertDevRegistrationEffectAdmission(input: EffectAdmission): void {
  const before = new Map(input.previous.map((job) => [job.id, job]));
  const after = new Map(input.next.map((job) => [job.id, job]));
  const generations = new Map<string, string>();
  for (const job of effectJobs([...input.previous, ...input.next])) {
    assertBoundRequest(job, job.supervisorEffect);
    const generation = job.supervisorEffect.binding.generation,
      owner = generations.get(generation);
    requireMatch(
      owner === undefined || owner === job.id,
      "Supervisor generation was already reserved",
    );
    generations.set(generation, job.id);
  }
  for (const job of effectJobs(input.previous)) {
    const next = after.get(job.id);
    requireMatch(
      Boolean(next && restart(next) && next.supervisorEffect),
      "Supervisor reservation cannot be discarded",
    );
  }
  for (const job of effectJobs(input.next)) assertTransition(input, before.get(job.id), job);
  const fenced = effectJobs([...input.previous, ...input.next]).filter(
    (job) => !isSupervisorEffectSettled(job.supervisorEffect),
  );
  for (const holder of fenced)
    for (const job of input.next) {
      if (job.id === holder.id) continue;
      requireMatch(
        passiveChange(before.get(job.id), job) && job.status !== "running",
        "Unsettled supervisor executor fences competing lifecycle effects",
      );
    }
}

const candidateCustody = new WeakMap<object, () => void>();
function assertCandidateCurrent(candidate: DevRegistrationExecutionCandidate) {
  candidateCustody.get(candidate)?.();
}
function captureCandidate(value: DevRegistrationExecutionCandidate) {
  assertCandidateCurrent(value);
  const inheritedCustody = candidateCustody.get(value);
  const candidate = structuredClone(value);
  candidate.publication.configurationBytes = Buffer.from(value.publication.configurationBytes);
  const { provisioner, publication } = candidate;
  const plan = provisioner.plan;
  verifyRetainedDevRegistrationProvisioner(provisioner);
  publication.config = InstallationConfigSchema.parse(publication.config);
  publication.receipt = DevRegistrationReceiptSchema.parse(publication.receipt);
  requireMatch(
    sha(plan) === provisioner.planSha256 &&
      createHash("sha256").update(provisioner.script).digest("hex") === provisioner.sha256,
    "Prepared registration script or plan changed",
  );
  requireMatch(
    publication.configurationFile === plan.configurationFile &&
      publication.receiptFile === plan.hostReceiptFile &&
      publication.protectedSourceCommit === plan.linuxArtifact.sourceCommit &&
      sha(publication.configurationBytes) === publication.configurationSha256 &&
      isDeepStrictEqual(
        JSON.parse(publication.configurationBytes.toString("utf8")),
        publication.config,
      ),
    "Registration publication descriptor differs from the prepared plan",
  );
  const receipt = DevRegistrationReceiptSchema.parse(publication.receipt);
  captureC1Candidate(candidate, value);
  const retainedCustody = candidateCustody.get(candidate);
  if (inheritedCustody)
    candidateCustody.set(candidate, () => {
      inheritedCustody();
      retainedCustody?.();
    });
  requireMatch(
    receipt.supervisorPlanSha256 === provisioner.sha256 &&
      receipt.installationId === plan.installationId &&
      receipt.containerId === plan.docker.containerId &&
      isDeepStrictEqual(receipt.startup, plan.startup) &&
      isDeepStrictEqual(receipt.account, plan.account) &&
      receipt.files.node.path === plan.protectedNode &&
      receipt.files.node.sha256 === plan.node.sha256 &&
      receipt.selectionPath === plan.selectionPath &&
      receipt.releaseRoot === plan.releaseRoot,
    "Registration receipt differs from the bound candidate",
  );
  requireMatch(
    path.isAbsolute(candidate.publicationAttemptFile) &&
      path.normalize(candidate.publicationAttemptFile) === candidate.publicationAttemptFile &&
      candidate.publicationAttemptFile !== plan.hostAttemptFile,
    "Publication attempt must be a separate declared canonical path",
  );
  return candidate;
}
function captureC1Candidate(
  candidate: DevRegistrationExecutionCandidate,
  value: DevRegistrationExecutionCandidate,
) {
  const { publication, provisioner } = candidate;
  const plan = provisioner.plan;
  const receipt = DevRegistrationReceiptSchema.parse(publication.receipt);
  if (plan.c1First) {
    const documents = publication.documents;
    requireMatch(
      Boolean(documents) && publication.registrationPlanSha256 === provisioner.planSha256,
      "C1 registration documents are absent or plan differs",
    );
    if (!documents) conflict("C1 registration documents are absent");
    publication.documents = captureC1RegistrationDocuments(documents);
    for (const name of ["original", "replacement", "rollback", "selected"] as const) {
      requireMatch(
        publication.documents[name].path === plan.c1First.configurationFiles[name],
        "C1 document path differs from static plan",
      );
      InstallationConfigSchema.parse(publication.documents[name].parsed);
    }
    requireMatch(
      publication.documents.preparedReceipt.path === plan.c1First.preparedReceiptFile &&
        isDeepStrictEqual(receipt, devRegistrationC1Receipt(provisioner)) &&
        isDeepStrictEqual(publication.documents.preparedReceipt.parsed, receipt) &&
        publication.documents.replacement.bytes.equals(publication.configurationBytes) &&
        isDeepStrictEqual(publication.documents.replacement.parsed, publication.config) &&
        publication.documents.selected.parsed.container.persistentRegistration?.receiptFile ===
          plan.hostReceiptFile &&
        candidate.publicationAttemptFile ===
          plan.hostReceiptFile + ".publication-attempt-" + plan.preparationNonce + ".json",
      "C1 publication differs from static plan",
    );
    const refs = publication.documents;
    requireMatch(
      refs.replacement.parsed.container.supervisorMaintenance?.script ===
        plan.c1First.scripts.replacement &&
        refs.rollback.parsed.container.supervisorMaintenance?.script ===
          plan.c1First.scripts.rollback &&
        refs.replacement.parsed.container.supervisorMaintenance?.node ===
          plan.c1First.scripts.node &&
        refs.rollback.parsed.container.supervisorMaintenance?.sha256 ===
          provisioner.rollback.sha256,
      "C1 configured operation reference differs",
    );
    const assertFiles = retainC1RegistrationDocuments(refs, [
      { path: plan.c1First.scripts.replacement, bytes: Buffer.from(provisioner.script) },
      { path: plan.c1First.scripts.rollback, bytes: Buffer.from(provisioner.rollback.script) },
    ]);
    const original = captureC1RegistrationDocuments(value.publication.documents!);
    candidateCustody.set(candidate, () => {
      requireMatch(
        isDeepStrictEqual(captureC1RegistrationDocuments(value.publication.documents!), original),
        "C1 caller document snapshot changed",
      );
      assertFiles();
    });
  } else
    requireMatch(!publication.documents, "Historical registration cannot acquire C1 authority");
}
function child(job: RestartJob): LifecycleActivationChild {
  const decision = job.standingDecision;
  requireMatch(
    Boolean(decision?.activationStep),
    "Registration requires its exact activation child",
  );
  if (!decision?.activationStep) conflict("Registration requires its exact activation child");
  return {
    grantId: decision.grantId,
    grantRevision: decision.grantRevision,
    manifestSha256: decision.manifestSha256,
    stepId: decision.activationStep.stepId,
    generation: decision.activationStep.generation,
    requestId: job.id,
    requestRevision: job.revision,
    planSha256: decision.planSha256,
    target: "supervisor",
  };
}
function originalLink(
  candidate: DevRegistrationExecutionCandidate,
  jobs: readonly LifecycleJob[],
  id?: string,
) {
  if (candidate.operation === "replace") {
    requireMatch(id === undefined, "Replacement cannot select rollback authority");
    return null;
  }
  requireMatch(Boolean(id), "Rollback requires its exact original request selector");
  if (!id) conflict("Rollback requires its exact original request selector");
  const original = request(jobs, id),
    effect = original.supervisorEffect;
  requireMatch(
    Boolean(
      original.status === "failed" &&
      effect &&
      effect.phase !== "reserved" &&
      effect.child &&
      effect.binding.operation === "replace" &&
      effect.binding.preparationNonce === candidate.provisioner.plan.preparationNonce &&
      effect.binding.registrationPlanSha256 === candidate.provisioner.planSha256,
    ),
    "Rollback original consumed registration differs",
  );
  if (!effect) conflict("Rollback original consumed registration differs");
  if (candidate.provisioner.plan.c1First)
    requireMatch(
      effect.binding.supervisorPlanSha256 ===
        candidate.publication.documents?.replacement.parsed.container.supervisorMaintenance
          ?.sha256 &&
        effect.binding.candidateSha256 === sha({ ...candidate, operation: "replace" }),
      "Rollback original immutable document tuple differs",
    );
  return { requestId: original.id, claimSha256: devRegistrationAuthorityDigest(effect) };
}
function makeBinding(
  job: RestartJob,
  candidate: DevRegistrationExecutionCandidate,
  proof: DevRegistrationExecutionPreflight,
  jobs: readonly LifecycleJob[],
  originalRequestId?: string,
): SupervisorEffectBinding {
  const decision = job.standingDecision;
  const activation = child(job);
  requireMatch(Boolean(decision && job.approvedAt), "Registration has no exact approval");
  if (!decision || !job.approvedAt) conflict("Registration has no exact approval");
  requireMatch(
    job.supervisorPlanSha256 ===
      (candidate.operation === "replace"
        ? candidate.provisioner.sha256
        : candidate.provisioner.rollback.sha256),
    "Registration script belongs to another tracked job",
  );
  return SupervisorEffectBindingSchema.parse({
    requestId: job.id,
    requestRevision: job.revision,
    approvedAt: job.approvedAt,
    decisionSha256: sha(decision),
    requestPlanSha256: standingRestartPlanDigest(job),
    supervisorPlanSha256: job.supervisorPlanSha256,
    registrationPlanSha256: candidate.provisioner.planSha256,
    operation: candidate.operation,
    preparationNonce: candidate.provisioner.plan.preparationNonce,
    original: originalLink(candidate, jobs, originalRequestId),
    generation: activation.generation,
    candidateSha256: sha(candidate),
    grantId: decision.grantId,
    grantRevision: decision.grantRevision,
    manifestSha256: decision.manifestSha256,
    stepId: activation.stepId,
    activationGeneration: activation.generation,
    sourceCommit: candidate.provisioner.plan.linuxArtifact.sourceCommit,
    artifactSha256: candidate.provisioner.plan.linuxArtifact.artifactSha256,
    nativeIdentitySha256: proof.nativeIdentitySha256,
    preconditionSha256: proof.preconditionSha256,
    settlementSha256: proof.settlementSha256,
    controller: proof.controller,
  });
}

const preflightIdentity = new WeakMap<object, () => void>();
function capturePreflight(
  value: DevRegistrationExecutionPreflight,
): DevRegistrationExecutionPreflight {
  const { assertCurrent, ...data } = value;
  const snapshot = structuredClone(data);
  const assertIdentity = () => {
    const { assertCurrent: currentCallback, ...currentData } = value;
    const { assertCurrent: wrappedCallback, ...wrappedData } = proof;
    requireMatch(
      currentCallback === assertCurrent &&
        isDeepStrictEqual(currentData, snapshot) &&
        wrappedCallback === retainedCallback &&
        isDeepStrictEqual(wrappedData, snapshot),
      "Registration preflight snapshot or callback changed",
    );
  };
  const proof = {
    ...snapshot,
    assertCurrent() {
      assertIdentity();
      sync(assertCurrent);
      assertIdentity();
    },
  };
  const retainedCallback = proof.assertCurrent;
  preflightIdentity.set(proof, assertIdentity);
  return proof;
}
function assertSelectedConfiguration(
  proof: DevRegistrationExecutionPreflight,
  candidate: DevRegistrationExecutionCandidate,
) {
  preflightIdentity.get(proof)?.();
  if (candidate.provisioner.plan.c1First) {
    const selected = candidate.publication.documents?.selected;
    requireMatch(
      Boolean(selected) &&
        isDeepStrictEqual(proof.selectedConfiguration, {
          path: selected?.path,
          sha256: selected?.sha256,
        }),
      "C1 actual Host configuration proof differs",
    );
  }
}
function assertCurrentAdmission(
  input: ExecutionInput,
  job: RestartJob,
  proof: DevRegistrationExecutionPreflight,
  jobs: readonly LifecycleJob[],
  candidate: DevRegistrationExecutionCandidate,
  assertNativeCurrent: () => void = proof.assertCurrent,
): void {
  assertCandidateCurrent(candidate);
  assertSelectedConfiguration(proof, candidate);
  sync(assertNativeCurrent);
  assertCandidateCurrent(candidate);
  assertSelectedConfiguration(proof, candidate);
  const state = new FileEnrollmentJournal(input.directory).readUnderLifecycleLock();
  const decision = evaluateStandingRestart({
    state,
    job,
    installationId: candidate.provisioner.plan.installationId,
    nativeIdentitySha256: proof.nativeIdentitySha256,
    repository: null,
    credentialBindingSha256: input.credentialBindingSha256,
  });
  requireMatch(
    Boolean(decision && job.standingDecision && job.approvedAt && job.status === "running"),
    "Current registration grant or approval changed",
  );
  requireMatch(
    isDeepStrictEqual({ ...decision, requestRevision: job.revision }, job.standingDecision),
    "Registration decision differs from current admission",
  );
  const hold = job.standingHold;
  requireMatch(
    Boolean(
      hold &&
      !hold.releaseRequestedAt &&
      hold.grantRevision === decision?.grantRevision &&
      hold.decisionSha256 === sha(job.standingDecision) &&
      (hold.observedAt || (hold.acknowledgedAt && hold.initialDaemonInstanceSha256)),
    ),
    "Registration lacks its exact admitted hold",
  );
  inspectLifecycleActivationChild(child(job), state, jobs);
  const effect = job.supervisorEffect;
  if (effect)
    requireMatch(
      isDeepStrictEqual(
        effect.binding,
        makeBinding(job, candidate, proof, jobs, input.originalRequestId),
      ),
      "Registration claim differs from retained proof",
    );
}

function observationData(proof: DevRegistrationExecutionObservation) {
  return {
    controller: proof.controller,
    child: proof.child,
    record: proof.record,
    nativeResult: proof.nativeResult,
    readiness: proof.readiness,
  };
}

/** Callbacks retain their original objects; admission uses a detached snapshot. */
function captureObservation(
  proof: DevRegistrationExecutionObservation,
): DevRegistrationExecutionObservation {
  const snapshot = structuredClone(observationData(proof));
  const assertCurrent = proof.assertCurrent;
  return {
    ...snapshot,
    assertCurrent() {
      sync(assertCurrent);
      requireMatch(
        isDeepStrictEqual(observationData(proof), snapshot),
        "Registration observation changed during custody assertion",
      );
    },
  };
}

function assertChildProof(
  proof: DevRegistrationExecutionChildProof,
  expectedChild: SupervisorEffectChild,
): void {
  sync(proof.assertCurrent);
  requireMatch(
    isDeepStrictEqual(proof.claim, expectedChild),
    "Gated child claim changed during custody assertion",
  );
}

function observeResult(
  effect: SupervisorEffect,
  proof: DevRegistrationExecutionObservation,
  candidate: DevRegistrationExecutionCandidate,
) {
  assertCandidateCurrent(candidate);
  sync(proof.assertCurrent);
  assertCandidateCurrent(candidate);
  requireMatch(
    isDeepStrictEqual(
      SupervisorEffectExecutorSchema.parse(proof.controller),
      effect.binding.controller,
    ),
    "Observed controller differs from reservation",
  );
  const knownChild = effect.phase === "reserved" ? null : effect.child;
  if (knownChild)
    requireMatch(
      isDeepStrictEqual(knownChild, proof.child),
      "Observed effect child differs from consumption",
    );
  if (proof.child)
    requireMatch(
      SupervisorEffectChildSchema.parse(proof.child).reservationSha256 ===
        devRegistrationReservationDigest(effect),
      "Observed child belongs to another reservation",
    );
  const record = SupervisorEffectObservationSchema.parse(proof.record);
  requireMatch(
    record.outcome === "published" || record.publication === null,
    "Unpublished registration cannot claim selected files",
  );
  if (record.outcome === "unresolved")
    requireMatch(!record.settled, "Unresolved native evidence cannot release execution custody");
  let publication: ReturnType<typeof prepareDevRegistrationPublication> | null = null;
  if (record.outcome === "published" || record.outcome === "candidate-ready-unpublished") {
    const rootExecutor = DaemonMaintenanceProcessSchema.parse(proof.nativeResult?.rootExecutor);
    requireMatch(
      rootExecutor.uid === 0 &&
        rootExecutor.gid === 0 &&
        rootExecutor.executable === candidate.provisioner.plan.systemPython.path &&
        rootExecutor.bootId === candidate.provisioner.plan.parent.bootId,
      "Observed root executor differs",
    );
    requireMatch(
      isDeepStrictEqual(proof.nativeResult, {
        claimSha256: devRegistrationAuthorityDigest(effect),
        planSha256: effect.binding.registrationPlanSha256,
        jobId: effect.binding.requestId,
        scriptSha256: effect.binding.supervisorPlanSha256,
        operation: "replace",
        phase: "started-unverified",
        rootExecutor,
      }),
      "Protected native registration outcome differs",
    );
    requireMatch(
      effect.binding.operation === "replace",
      "Rollback cannot publish a candidate registration",
    );
    requireMatch(
      proof.readiness !== null,
      "Native and authenticated registration readiness are required",
    );
    publication = prepareDevRegistrationPublication({
      ...candidate.publication,
      readiness: proof.readiness,
    });
    const captured = {
      ...candidate.publication.config,
      container: { ...candidate.publication.config.container },
    };
    delete captured.container.supervisorMaintenance;
    assertExactRegistrationFile(
      candidate.provisioner.plan.hostAttemptFile,
      Buffer.from(
        JSON.stringify({
          ...(candidate.provisioner.plan.c1First ? { version: 2 } : {}),
          planSha256: candidate.provisioner.planSha256,
          claimSha256: devRegistrationAuthorityDigest(effect),
          jobId: effect.binding.requestId,
          scriptSha256: effect.binding.supervisorPlanSha256,
          configurationSha256: sha(captured),
          ...(candidate.publication.documents
            ? {
                documents: Object.fromEntries(
                  Object.entries(candidate.publication.documents).map(([name, item]) => [
                    name,
                    { path: item.path, sha256: item.sha256 },
                  ]),
                ),
              }
            : {}),
          receiptAbsent: true,
        }),
      ),
    );
  }
  if (record.outcome === "published") {
    if (!publication) conflict("Published registration lacks verified readiness");
    requireMatch(
      isDeepStrictEqual(record.publication, {
        receiptSha256: publication.reference.sha256,
        configurationSha256: publication.configurationSha256,
      }),
      "Published registration hashes differ",
    );
    assertPublished(candidate, effect, publication);
  }
  return { record, publication };
}

/** Exact existing addressed transaction only. Reopening reads and rechecks it;
 * it never repairs partial publication or infers success from missing files. */
function assertPublished(
  candidate: DevRegistrationExecutionCandidate,
  effect: SupervisorEffect,
  prepared: ReturnType<typeof prepareDevRegistrationPublication>,
): void {
  const attempt = prepared.documents
    ? c1RegistrationPublicationAttempt(
        prepared,
        candidate.publicationAttemptFile,
        devRegistrationAuthorityDigest(effect),
      )
    : {
        version: 1,
        reservationSha256: devRegistrationAuthorityDigest(effect),
        files: [
          { path: prepared.receiptFile, previousSha256: null, sha256: prepared.reference.sha256 },
          {
            path: prepared.configurationFile,
            previousSha256: prepared.previousConfigurationSha256,
            sha256: prepared.configurationSha256,
          },
        ],
      };
  for (const [file, bytes] of [
    [prepared.receiptFile, prepared.receiptBytes],
    [prepared.configurationFile, prepared.configurationBytes],
    [candidate.publicationAttemptFile, Buffer.from(JSON.stringify(attempt))],
  ] as const) {
    assertExactRegistrationFile(file, bytes);
  }
}
function assertExactRegistrationFile(file: string, bytes: Buffer): void {
  const identity = (stat: BigIntStats) =>
    [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.uid,
      stat.gid,
      stat.nlink,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(":");
  for (let current = file; ; current = path.dirname(current)) {
    const stat = lstatSync(current);
    requireMatch(
      realpathSync(current) === current &&
        (stat.uid === 0 || stat.uid === process.getuid!()) &&
        (stat.mode & 0o022) === 0,
      "Published registration custody differs",
    );
    if (path.dirname(current) === current) break;
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    requireMatch(
      stat.isFile() && stat.nlink === 1n && stat.size <= 1048576n,
      "Published registration file is unsafe",
    );
    requireMatch(
      readFileSync(fd).equals(bytes) &&
        identity(stat) === identity(fstatSync(fd, { bigint: true })) &&
        identity(stat) === identity(lstatSync(file, { bigint: true })),
      "Published registration bytes or identity changed",
    );
  } finally {
    closeSync(fd);
  }
}

/** Reopen is strictly read-only outside observational ledger progress. Grant
 * revocation cannot authorize publication, redispatch, status reset or rollback. */
export async function observeDevRegistrationExecution(
  input: ExecutionInput,
): Promise<DevRegistrationExecutionResult> {
  const candidate = captureCandidate(input.candidate);
  const journal = new FileBootstrapRequestJournal(input.directory);
  const job = request(journal.readLifecycle(), input.requestId);
  const effect = job.supervisorEffect;
  requireMatch(Boolean(effect), "Registration has no durable consumed effect to observe");
  if (!effect) conflict("Registration has no durable consumed effect to observe");
  requireMatch(
    effect.binding.candidateSha256 === sha(candidate),
    "Reopened candidate differs from consumption",
  );
  const proof = captureObservation(
    await input.ports.observe(structuredClone(effect), structuredClone(candidate)),
  );
  assertCandidateCurrent(candidate);
  const captured = observeResult(effect, proof, candidate);
  const { record } = captured;
  const next: SupervisorEffect = {
    binding: effect.binding,
    reservedAt: effect.reservedAt,
    child: proof.child,
    phase: "observed",
    consumedAt: effect.phase === "reserved" ? null : effect.consumedAt,
    observation: record,
  };
  try {
    journal.mutateLifecycle(
      (previous) =>
        previous.map((item) => {
          if (item.id !== job.id) return item;
          requireMatch(
            restart(item) && isDeepStrictEqual(item.supervisorEffect, effect),
            "Registration observation raced with retained progress",
          );
          return { ...item, supervisorEffect: next };
        }),
      (previous, after) => {
        assertDevRegistrationEffectAdmission({
          previous,
          next: after,
          assertObservation: () => {
            requireMatch(
              isDeepStrictEqual(observeResult(effect, proof, candidate), captured),
              "Registration observation result changed before persistence",
            );
          },
        });
        return undefined;
      },
    );
    return { effect: next, recorded: true };
  } catch (error) {
    if (!(error instanceof BootstrapRequestConflict)) throw error;
    // A reserved/revoked activation can refuse even observational persistence.
    // Return facts without pretending the durable execution fence was released.
    return { effect: next, recorded: false };
  }
}

/** No default native ports. Production needs a real gated child arrangement,
 * the shared-writer guard integration and accepted native proof factories. */
export async function executeDevRegistration(
  input: ExecutionInput,
): Promise<DevRegistrationExecutionResult> {
  const candidate = captureCandidate(input.candidate),
    journal = new FileBootstrapRequestJournal(input.directory);
  const initial = request(journal.readLifecycle(), input.requestId);
  if (initial.supervisorEffect) return observeDevRegistrationExecution({ ...input, candidate });
  // Every retained effect, including unresolved reservations, is observation-only.
  // A historical verifier cannot make a pinless replacement or rollback fresh.
  assertDevRegistrationDockerPin(candidate.provisioner.plan.docker);
  requireMatch(
    Boolean(candidate.provisioner.plan.c1First),
    "Historical registration preparation is observation-only",
  );
  const proof = capturePreflight(
    await input.ports.preflight(structuredClone(initial), structuredClone(candidate)),
  );
  assertCandidateCurrent(candidate);
  assertSelectedConfiguration(proof, candidate);
  const reserved: SupervisorEffect = {
    binding: makeBinding(
      initial,
      candidate,
      proof,
      journal.readLifecycle(),
      input.originalRequestId,
    ),
    reservedAt: input.now(),
    phase: "reserved",
  };
  journal.mutateLifecycle(
    (previous) =>
      previous.map((item) => {
        if (item.id !== initial.id) return item;
        requireMatch(
          isDeepStrictEqual(item, initial),
          "Registration request changed before reservation",
        );
        return { ...item, supervisorEffect: reserved };
      }),
    (previous, next) => {
      assertDevRegistrationEffectAdmission({
        previous,
        next,
        assertReserve: (job) => assertCurrentAdmission(input, job, proof, next, candidate),
      });
      return undefined;
    },
    child(initial),
  );
  let childProof: DevRegistrationExecutionChildProof;
  try {
    // Reservation is durable before the one permitted gated launch attempt.
    // A missing acknowledgement can only reopen observation, never this call.
    childProof = await input.ports.launch(structuredClone(reserved), proof);
  } catch {
    return observeDevRegistrationExecution({ ...input, candidate });
  }
  const childClaim = SupervisorEffectChildSchema.parse(childProof.claim);
  requireMatch(
    childClaim.reservationSha256 === devRegistrationReservationDigest(reserved) &&
      childClaim.executor.pid !== reserved.binding.controller.pid &&
      childClaim.executor.parentPid === reserved.binding.controller.pid,
    "Gated child does not belong to the reserved controller",
  );
  const expectedScript =
    candidate.operation === "replace"
      ? candidate.provisioner.sha256
      : candidate.provisioner.rollback.sha256;
  requireMatch(
    childClaim.executor.entrypoint.sha256 === expectedScript &&
      childClaim.executor.entrypoint.path ===
        candidate.publication.config.container.supervisorMaintenance?.script,
    "Gated child script artifact differs",
  );
  const consumed: SupervisorEffect = {
    binding: reserved.binding,
    reservedAt: reserved.reservedAt,
    phase: "consumed",
    consumedAt: input.now(),
    child: childClaim,
  };
  try {
    journal.mutateLifecycle(
      (previous) =>
        previous.map((item) => {
          if (item.id !== initial.id) return item;
          requireMatch(
            restart(item) && isDeepStrictEqual(item.supervisorEffect, reserved),
            "Registration reservation changed before child consumption",
          );
          return { ...item, supervisorEffect: consumed };
        }),
      (previous, next) => {
        assertDevRegistrationEffectAdmission({
          previous,
          next,
          assertConsume: (job) => {
            assertCurrentAdmission(input, job, proof, next, candidate);
            assertChildProof(childProof, childClaim);
            assertCandidateCurrent(candidate);
          },
        });
        return undefined;
      },
      child(initial),
    );
  } catch {
    return observeDevRegistrationExecution({ ...input, candidate });
  }
  try {
    journal.mutateLifecycle(
      (previous) => [...previous],
      (previous, next) => {
        const job = request(previous, initial.id);
        requireMatch(
          isDeepStrictEqual(job.supervisorEffect, consumed),
          "Child claim changed before invocation",
        );
        assertCurrentAdmission(input, job, proof, next, candidate);
        assertChildProof(childProof, childClaim);
        assertCandidateCurrent(candidate);
        assertDevRegistrationEffectAdmission({ previous, next });
        // This port only releases the verified one-use gate. It must not block or
        // perform copying/native collection inside the lifecycle admission hook.
        sync(() => input.ports.invoke(structuredClone(consumed), childProof));
        return undefined;
      },
    );
  } catch {
    return observeDevRegistrationExecution({ ...input, candidate });
  }
  if (candidate.operation !== "replace")
    return observeDevRegistrationExecution({ ...input, candidate });
  const observed = captureObservation(
    await input.ports.observe(structuredClone(consumed), structuredClone(candidate)),
  );
  const ready = observeResult(consumed, observed, candidate);
  if (
    ready.record.outcome !== "candidate-ready-unpublished" ||
    !ready.publication ||
    !ready.record.settled
  )
    return observeDevRegistrationExecution({ ...input, candidate });
  const prepared = ready.publication;
  try {
    journal.mutateLifecycle(
      (previous) => [...previous],
      (previous, next) => {
        const job = request(previous, initial.id);
        requireMatch(
          isDeepStrictEqual(job.supervisorEffect, consumed),
          "Child claim changed before publication",
        );
        const assertCurrent = () => {
          assertCurrentAdmission(input, job, proof, next, candidate, observed.assertCurrent);
          const current = observeResult(consumed, observed, candidate);
          requireMatch(
            current.record.settled && isDeepStrictEqual(current, ready),
            "Registration readiness or publication changed before publication",
          );
        };
        assertCurrent();
        publishDevRegistration({
          prepared,
          attemptFile: candidate.publicationAttemptFile,
          reservationSha256: devRegistrationAuthorityDigest(consumed),
          assertCurrent,
        });
        return undefined;
      },
    );
  } catch {
    return observeDevRegistrationExecution({ ...input, candidate });
  }
  return observeDevRegistrationExecution({ ...input, candidate });
}
