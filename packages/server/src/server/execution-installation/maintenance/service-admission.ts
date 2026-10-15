import { maintenanceRecoveryAncestors } from "./service-recovery.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  MaintenanceServiceEvidenceRecordSchema,
  MaintenanceServiceJobSchema,
  MaintenanceServiceProposalSchema,
  type MaintenanceServiceEvidenceRecord,
  type MaintenanceServiceJob,
} from "@getpaseo/protocol/maintenance-service";
import type { InstallationEnrollmentState } from "@getpaseo/protocol/installation-enrollment";
import type { LifecycleJob } from "../lifecycle-journal.js";
import { BootstrapRequestConflict, coordinatorLifecycleWork } from "../coordinator-bootstrap.js";
import { enrollmentManifestDigest, evaluateStandingProposal } from "./authorization.js";

export interface MaintenanceServiceAdmissionEvidence {
  /** Current journal CAS, separate from the permanently approved revision. */
  expectedRevision: string;
  record: MaintenanceServiceEvidenceRecord;
  sha256: string;
  assertCurrent(): void;
}
interface ServiceAdmission {
  previous: readonly LifecycleJob[];
  next: readonly LifecycleJob[];
  state: InstallationEnrollmentState;
  evidence?: MaintenanceServiceAdmissionEvidence;
  now: number;
}

export function maintenanceServiceProposalDigest(value: unknown): string {
  return sha(MaintenanceServiceProposalSchema.parse(value));
}
export function maintenanceServiceEvidenceDigest(value: unknown): string {
  return sha(MaintenanceServiceEvidenceRecordSchema.parse(value));
}
function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function isMaintenanceService(job: LifecycleJob): job is MaintenanceServiceJob {
  return job.target === "maintenance-controller" || job.target === "recovery-launcher";
}
export function unresolvedMaintenanceService(job: MaintenanceServiceJob): boolean {
  return job.status === "approved" || job.status === "running";
}

/** Only call inside the installation's shared lifecycle lock. The supplied
 * evidence comes from the trusted native adapter, never a request body. */
export function assertMaintenanceServiceAdmission(input: ServiceAdmission): void {
  const previous = new Map(input.previous.filter(isMaintenanceService).map((job) => [job.id, job]));
  const next = new Map(input.next.filter(isMaintenanceService).map((job) => [job.id, job]));
  const active = [...previous.values()].find(unresolvedMaintenanceService);
  if (active) {
    const retained = new Map(input.previous.map((job) => [job.id, job]));
    if (
      coordinatorLifecycleWork(input.next).some(
        (job) =>
          job.id !== active.id &&
          !isDeepStrictEqual(retained.get(job.id), job) &&
          !(
            isMaintenanceService(job) &&
            maintenanceRecoveryAncestors({
              jobs: [...previous.values()],
              job,
              retryLimit: 3,
            }).some((ancestor) => ancestor.id === active.id)
          ),
      )
    )
      throw new BootstrapRequestConflict(
        "Service maintenance owns installation lifecycle admission",
      );
  }
  for (const retained of previous.values())
    if (!next.has(retained.id))
      throw new BootstrapRequestConflict("Service maintenance history cannot be discarded");
  for (const proposed of next.values()) {
    const job = MaintenanceServiceJobSchema.parse(proposed);
    const prior = previous.get(job.id);
    assertServiceBindings(prior, job);
    if (!prior && job.proposal.recoveryOf)
      maintenanceRecoveryAncestors({ jobs: [...previous.values()], job, retryLimit: 3 });
    const phase = servicePhase(prior, job);
    if (!phase) continue;
    if (!prior)
      throw new BootstrapRequestConflict("Service effects require a retained pending request");
    if (phase === "resolution") {
      assertServiceRecoveryResolution(input, prior, job);
      continue;
    }
    assertServiceEvidence(input, prior, job, phase);
    if (phase === "observation") {
      assertServiceObservation(job);
      if (job.observation!.ready) assertResolvedAncestors(input, job);
      continue;
    }
    assertServiceAuthority(input, job);
    if (phase === "approval") assertServiceApproval(prior, job, input.now);
    if (phase === "reservation") assertServiceReservation(prior, job, input.now);
    if (phase === "intent") assertServiceIntent(prior, job, input.now);
    assertServiceExclusion(input.previous, job);
    assertServiceExclusion(input.next, job);
  }
}

type ServicePhase = "approval" | "reservation" | "intent" | "observation" | "resolution";
function servicePhase(
  previous: MaintenanceServiceJob | undefined,
  next: MaintenanceServiceJob,
): ServicePhase | null {
  const phases: ServicePhase[] = [];
  if (next.approval && !previous?.approval) phases.push("approval");
  if (next.reservation && !previous?.reservation) phases.push("reservation");
  if (next.effectIntent && !previous?.effectIntent) phases.push("intent");
  if (next.resolvedBy && !previous?.resolvedBy) phases.push("resolution");
  if (!isDeepStrictEqual(previous?.observation, next.observation)) phases.push("observation");
  if (phases.length > 1)
    throw new BootstrapRequestConflict(
      "Service effect receipts require separate durable transitions",
    );
  return phases[0] ?? null;
}
function assertServiceBindings(
  previous: MaintenanceServiceJob | undefined,
  next: MaintenanceServiceJob,
): void {
  assertServiceProposal(next);
  if (!previous) {
    assertInitialService(next);
    return;
  }
  const immutable = (job: MaintenanceServiceJob) => ({
    id: job.id,
    target: job.target,
    operation: job.operation,
    proposal: job.proposal,
    reason: job.reason,
    requester: job.requester,
    createdAt: job.createdAt,
  });
  if (!isDeepStrictEqual(immutable(previous), immutable(next)))
    throw new BootstrapRequestConflict("Retained service proposal cannot change");
  for (const field of ["approval", "reservation", "effectIntent", "resolvedBy"] as const)
    if (previous[field] && !isDeepStrictEqual(previous[field], next[field]))
      throw new BootstrapRequestConflict("Retained service authority or generation changed");
  if (!isDeepStrictEqual(previous.evidence, next.evidence.slice(0, previous.evidence.length)))
    throw new BootstrapRequestConflict("Service native evidence history cannot change");
  assertTerminalServiceUnchanged(previous, next);
  const phase = servicePhase(previous, next);
  if (
    !phase &&
    previous.status !== next.status &&
    !(previous.status === "pending" || previous.status === "approved")
  )
    throw new BootstrapRequestConflict("Service result requires native observation");
  if (!phase && previous.status !== next.status && next.status !== "rejected")
    throw new BootstrapRequestConflict("Service transition requires its exact authority receipt");
  if (next.status === "rejected" && (previous.reservation || next.reservation))
    throw new BootstrapRequestConflict("Dispatched service maintenance cannot be cancelled");
}
function assertTerminalServiceUnchanged(
  previous: MaintenanceServiceJob,
  next: MaintenanceServiceJob,
): void {
  if (
    ["succeeded", "failed", "rejected"].includes(previous.status) &&
    !isDeepStrictEqual(previous, next) &&
    !(next.resolvedBy && !previous.resolvedBy)
  )
    throw new BootstrapRequestConflict("Terminal service generations cannot be replayed");
}
function assertServiceProposal(next: MaintenanceServiceJob): void {
  if (
    next.proposal.id !== next.id ||
    next.proposal.target !== next.target ||
    next.proposal.operation !== next.operation
  )
    throw new BootstrapRequestConflict("Service request differs from its exact proposal");
  if ((next.operation === "replacement") === Boolean(next.proposal.recoveryOf))
    throw new BootstrapRequestConflict("Service operation requires its exact predecessor linkage");
}
function assertInitialService(next: MaintenanceServiceJob): void {
  if (
    next.status !== "pending" ||
    next.approval ||
    next.reservation ||
    next.effectIntent ||
    next.observation ||
    next.resolvedBy ||
    next.evidence.length
  )
    throw new BootstrapRequestConflict("Service request must begin pending without authority");
}
function assertServiceAuthority(input: ServiceAdmission, job: MaintenanceServiceJob): void {
  const approval = job.approval;
  if (!approval) throw new BootstrapRequestConflict("Service standing authority is absent");
  const authority = evaluateMaintenanceServiceAuthority(input.state, job);
  if (
    !authority ||
    approval.grantId !== authority.grantId ||
    approval.grantRevision !== authority.grantRevision ||
    approval.manifestSha256 !== authority.manifestSha256 ||
    approval.proposalSha256 !== authority.proposalSha256
  )
    throw new BootstrapRequestConflict("Service standing authority changed");
}
export function evaluateMaintenanceServiceAuthority(
  state: InstallationEnrollmentState,
  job: MaintenanceServiceJob,
) {
  if (state.status !== "enrolled") return null;
  const decision = evaluateStandingProposal({
    state,
    grantRevision: state.grant.revision,
    proposal: {
      id: job.proposal.id,
      installationId: job.proposal.installationId,
      requestedBy: job.proposal.requestedBy,
      target: job.proposal.target,
      identitySha256: job.proposal.identitySha256,
      operation: job.proposal.operation,
      planSha256: job.proposal.planSha256,
      repository: job.proposal.repository,
      sourceCommit: job.proposal.sourceCommit,
      artifactSha256: job.proposal.artifactSha256,
    },
  });
  if (Date.parse(job.createdAt) < Date.parse(state.grant.approval.approvedAt))
    throw new BootstrapRequestConflict("Service standing authority changed");
  return {
    grantId: decision.grantId,
    grantRevision: decision.grantRevision,
    manifestSha256: enrollmentManifestDigest(state.grant.manifest),
    proposalSha256: maintenanceServiceProposalDigest(job.proposal),
  };
}
export type MaintenanceServiceStandingAuthority = NonNullable<
  ReturnType<typeof evaluateMaintenanceServiceAuthority>
>;
function assertServiceApproval(
  previous: MaintenanceServiceJob,
  next: MaintenanceServiceJob,
  now: number,
): void {
  const approval = next.approval!;
  const approvedAt = Date.parse(approval.approvedAt);
  if (
    previous.status !== "pending" ||
    next.status !== "approved" ||
    next.revision === previous.revision ||
    approval.reviewedRevision !== previous.revision ||
    approval.requestRevision !== next.revision ||
    approvedAt > now ||
    approvedAt < Date.parse(previous.createdAt) ||
    Date.parse(approval.dispatchAfter) < approvedAt + 30_000
  )
    throw new BootstrapRequestConflict(
      "Service approval requires an exact pending revision and cancellation interval",
    );
}
function assertServiceReservation(
  previous: MaintenanceServiceJob,
  next: MaintenanceServiceJob,
  now: number,
): void {
  assertServiceReservationBinding(next);
  const approval = next.approval!,
    reservation = next.reservation!;
  if (
    previous.status !== "approved" ||
    next.status !== "running" ||
    next.revision === previous.revision ||
    now < Date.parse(approval.dispatchAfter) ||
    Date.parse(reservation.reservedAt) > now
  )
    throw new BootstrapRequestConflict(
      "Service reservation differs from its approved revision and plan",
    );
}
export function assertServiceReservationBinding(next: MaintenanceServiceJob): void {
  const approval = next.approval,
    reservation = next.reservation;
  if (!approval || !reservation)
    throw new BootstrapRequestConflict("Service reservation is absent");
  if (
    reservation.requestId !== next.id ||
    reservation.requestRevision !== approval.requestRevision ||
    reservation.target !== next.target ||
    reservation.operation !== next.operation ||
    reservation.grantId !== approval.grantId ||
    reservation.grantRevision !== approval.grantRevision ||
    reservation.manifestSha256 !== approval.manifestSha256 ||
    reservation.proposalSha256 !== approval.proposalSha256 ||
    reservation.planSha256 !== next.proposal.planSha256 ||
    reservation.identitySha256 !== next.proposal.identitySha256 ||
    reservation.sourceCommit !== next.proposal.sourceCommit ||
    reservation.artifactSha256 !== next.proposal.artifactSha256 ||
    !isDeepStrictEqual(reservation.previous, next.proposal.previous) ||
    !isDeepStrictEqual(reservation.recoveryOf, next.proposal.recoveryOf)
  )
    throw new BootstrapRequestConflict(
      "Service reservation differs from its approved revision and plan",
    );
}
function assertServiceIntent(
  previous: MaintenanceServiceJob,
  next: MaintenanceServiceJob,
  now: number,
): void {
  const reservation = previous.reservation,
    intent = next.effectIntent!;
  if (
    previous.status !== "running" ||
    next.status !== "running" ||
    !reservation ||
    previous.effectIntent ||
    next.revision === previous.revision ||
    intent.generation !== reservation.generation ||
    intent.requestRevision !== reservation.requestRevision ||
    Date.parse(intent.consumedAt) < Date.parse(reservation.reservedAt) ||
    Date.parse(intent.consumedAt) > now ||
    Date.parse(intent.consumedAt) <
      Date.parse(
        next.evidence.find((item) => item.sha256 === intent.nativeEvidenceSha256)!.record
          .observedAt,
      )
  )
    throw new BootstrapRequestConflict(
      "Native service effect requires one exact retained reservation",
    );
}
function assertServiceEvidence(
  input: ServiceAdmission,
  previous: MaintenanceServiceJob,
  next: MaintenanceServiceJob,
  phase: ServicePhase,
): void {
  const supplied = input.evidence;
  if (!supplied || typeof supplied.assertCurrent !== "function")
    throw new BootstrapRequestConflict("Service transition requires independent native evidence");
  if (supplied.expectedRevision !== previous.revision || next.revision === previous.revision)
    throw new BootstrapRequestConflict("Service journal revision changed before transition");
  const record = MaintenanceServiceEvidenceRecordSchema.parse(supplied.record);
  const age = input.now - Date.parse(record.observedAt);
  const expectedRevision =
    phase === "observation" ? previous.reservation?.requestRevision : previous.revision;
  const receipt = next.evidence.find((item) => item.sha256 === supplied.sha256);
  if (
    !receipt ||
    !isDeepStrictEqual(receipt.record, record) ||
    maintenanceServiceEvidenceDigest(record) !== supplied.sha256 ||
    record.requestId !== next.id ||
    record.requestRevision !== expectedRevision ||
    record.planSha256 !== next.proposal.planSha256 ||
    record.identitySha256 !== next.proposal.identitySha256 ||
    !Number.isFinite(age) ||
    age < 0 ||
    age >= 30_000
  )
    throw new BootstrapRequestConflict(
      "Retained native evidence differs from the service transition",
    );
  const referenced = serviceEvidenceReference(next, phase);
  if (referenced !== supplied.sha256)
    throw new BootstrapRequestConflict("Service transition does not address its retained evidence");
  assertEffectEvidence(input, previous, next, record, phase);
  const result: unknown = supplied.assertCurrent();
  if (result !== undefined)
    throw new BootstrapRequestConflict("Service custody recheck must be synchronous");
}
function assertEffectEvidence(
  input: ServiceAdmission,
  previous: MaintenanceServiceJob,
  next: MaintenanceServiceJob,
  record: MaintenanceServiceEvidenceRecord,
  phase: ServicePhase,
): void {
  if (phase === "observation") return;
  if (next.operation === "replacement") assertNativeCandidateEvidence(record, next);
  else assertRecoveryCandidateEvidence(input, next, record);
  assertServiceExecutorEvidence(input.state, previous, record, phase);
}
function assertServiceExecutorEvidence(
  state: InstallationEnrollmentState,
  previous: MaintenanceServiceJob,
  record: MaintenanceServiceEvidenceRecord,
  phase: ServicePhase,
): void {
  const executor = record.executor;
  if (!executor || state.status !== "enrolled")
    throw new BootstrapRequestConflict("Service effects require selected executor evidence");
  if (
    executor.target === "recovery-launcher" &&
    (previous.operation === "replacement" || !previous.proposal.recoveryOf)
  )
    throw new BootstrapRequestConflict(
      "Recovery launcher execution requires a linked recovery or rollback",
    );
  const binding = state.grant.manifest.targets.find((target) => target.target === executor.target);
  if (
    !binding ||
    executor.identitySha256 !== binding.identitySha256 ||
    executor.native.process.bootId !== executor.native.bootId ||
    executor.native.bootId !== record.native.bootId ||
    executor.native.selection.sourceCommit !== executor.sourceCommit ||
    executor.native.selection.artifactSha256 !== executor.artifactSha256
  )
    throw new BootstrapRequestConflict("Selected executor evidence differs from enrolled custody");
  if (phase === "intent") {
    const reserved = previous.evidence.find(
      (item) => item.sha256 === previous.reservation!.nativeEvidenceSha256,
    );
    if (!reserved?.record.executor || !isDeepStrictEqual(reserved.record.executor, executor))
      throw new BootstrapRequestConflict("Selected executor changed after service reservation");
  }
}

function serviceEvidenceReference(job: MaintenanceServiceJob, phase: ServicePhase): string {
  switch (phase) {
    case "approval":
      return job.approval!.nativeEvidenceSha256;
    case "reservation":
      return job.reservation!.nativeEvidenceSha256;
    case "intent":
      return job.effectIntent!.nativeEvidenceSha256;
    case "observation":
      return job.observation!.evidenceSha256;
    case "resolution":
      throw new BootstrapRequestConflict("Resolution uses the descendant native observation");
  }
}
function assertNativeCandidateEvidence(
  record: MaintenanceServiceEvidenceRecord,
  next: MaintenanceServiceJob,
): void {
  if (
    record.sourceCommit !== next.proposal.sourceCommit ||
    record.artifactSha256 !== next.proposal.artifactSha256 ||
    !record.native.process ||
    record.native.process.bootId !== record.native.bootId ||
    !record.native.service.registered ||
    !record.native.service.launcherSha256 ||
    !record.native.service.registrationSha256 ||
    !record.native.selection.receiptSha256 ||
    !next.proposal.previous ||
    record.native.selection.sourceCommit !== next.proposal.previous.sourceCommit ||
    record.native.selection.artifactSha256 !== next.proposal.previous.artifactSha256
  )
    throw new BootstrapRequestConflict(
      "Service candidate or previous native selection is unverified",
    );
}
function assertServiceObservation(job: MaintenanceServiceJob): void {
  const reservation = job.reservation,
    observation = job.observation!;
  if (
    !reservation ||
    observation.requestId !== job.id ||
    observation.requestRevision !== reservation.requestRevision ||
    observation.generation !== reservation.generation ||
    observation.planSha256 !== reservation.planSha256 ||
    observation.identitySha256 !== reservation.identitySha256
  )
    throw new BootstrapRequestConflict("Service observation differs from the retained generation");
  const evidence = job.evidence.find((item) => item.sha256 === observation.evidenceSha256)!.record;
  if (
    observation.sourceCommit !== evidence.sourceCommit ||
    observation.artifactSha256 !== evidence.artifactSha256 ||
    observation.observedAt !== evidence.observedAt
  )
    throw new BootstrapRequestConflict("Service observation differs from its native receipt");
  if (observation.outcome === "unknown") {
    if (observation.ready || job.status !== "running")
      throw new BootstrapRequestConflict("Unknown service readiness cannot complete maintenance");
    return;
  }
  if (observation.outcome === "candidate") assertCandidateChronology(job);
  assertObservationSelection(job, evidence);
}
function assertCandidateChronology(job: MaintenanceServiceJob): void {
  if (!job.effectIntent)
    throw new BootstrapRequestConflict("Candidate observation requires its consumed native intent");
  if (Date.parse(job.observation!.observedAt) < Date.parse(job.effectIntent.consumedAt))
    throw new BootstrapRequestConflict("Candidate evidence predates native effect consumption");
}
function assertObservationSelection(
  job: MaintenanceServiceJob,
  evidence: MaintenanceServiceEvidenceRecord,
): void {
  const reservation = job.reservation!,
    observation = job.observation!;
  const selected = observation.outcome === "candidate" ? reservation : reservation.previous;
  if (
    !selected ||
    observation.sourceCommit !== selected.sourceCommit ||
    observation.artifactSha256 !== selected.artifactSha256 ||
    evidence.native.selection.sourceCommit !== selected.sourceCommit ||
    evidence.native.selection.artifactSha256 !== selected.artifactSha256
  )
    throw new BootstrapRequestConflict("Native service observation selected an unreviewed runtime");
  let expectedStatus: MaintenanceServiceJob["status"] = "running";
  if (observation.ready)
    expectedStatus = observation.outcome === "candidate" ? "succeeded" : "failed";
  if (job.status !== expectedStatus || (observation.ready && !nativeReadinessProven(evidence)))
    throw new BootstrapRequestConflict(
      "Service result differs from verified candidate or rollback readiness",
    );
}
function nativeReadinessProven(evidence: MaintenanceServiceEvidenceRecord): boolean {
  return Boolean(
    evidence.native.process &&
    evidence.native.process.bootId === evidence.native.bootId &&
    evidence.native.service.registered &&
    evidence.native.service.launcherSha256 &&
    evidence.native.service.registrationSha256 &&
    evidence.native.selection.receiptSha256,
  );
}
function assertServiceExclusion(
  previous: readonly LifecycleJob[],
  job: MaintenanceServiceJob,
): void {
  const ancestors = new Set(
    maintenanceRecoveryAncestors({
      jobs: previous.filter(isMaintenanceService),
      job,
      retryLimit: 3,
    }).map((ancestor) => ancestor.id),
  );
  if (
    coordinatorLifecycleWork(previous).some((item) => item.id !== job.id && !ancestors.has(item.id))
  )
    throw new BootstrapRequestConflict("Another installation operation owns lifecycle admission");
}

function assertRecoveryCandidateEvidence(
  input: ServiceAdmission,
  job: MaintenanceServiceJob,
  record: MaintenanceServiceEvidenceRecord,
): void {
  maintenanceRecoveryAncestors({
    jobs: input.previous.filter(isMaintenanceService),
    job,
    retryLimit: 3,
  });
  if (
    record.sourceCommit !== job.proposal.sourceCommit ||
    record.artifactSha256 !== job.proposal.artifactSha256 ||
    (record.native.process && record.native.process.bootId !== record.native.bootId)
  )
    throw new BootstrapRequestConflict(
      "Recovery candidate differs from its retained reviewed runtime",
    );
  // Target absence or a partial selector is useful recovery evidence only when
  // the native adapter's synchronous custody assertion proves that exact state.
}

function resolutionLink(job: MaintenanceServiceJob) {
  return {
    requestId: job.id,
    generation: job.reservation!.generation,
    planSha256: job.reservation!.planSha256,
    observationSha256: job.observation!.evidenceSha256,
  };
}
function assertResolvedAncestors(input: ServiceAdmission, job: MaintenanceServiceJob): void {
  const ancestors = maintenanceRecoveryAncestors({
    jobs: input.previous.filter(isMaintenanceService),
    job,
    retryLimit: 3,
  });
  for (const ancestor of ancestors) {
    const resolved = input.next.find((item) => item.id === ancestor.id);
    if (
      !resolved ||
      !isMaintenanceService(resolved) ||
      resolved.status !== "failed" ||
      !isDeepStrictEqual(resolved.resolvedBy, resolutionLink(job))
    )
      throw new BootstrapRequestConflict(
        "Verified recovery must atomically resolve its retained ancestors",
      );
  }
}
function assertServiceRecoveryResolution(
  input: ServiceAdmission,
  previous: MaintenanceServiceJob,
  job: MaintenanceServiceJob,
): void {
  const leaf = input.next.find((item) => item.id === job.resolvedBy!.requestId);
  const priorLeaf = input.previous.find((item) => item.id === leaf?.id);
  if (
    !leaf ||
    !isMaintenanceService(leaf) ||
    !priorLeaf ||
    !isMaintenanceService(priorLeaf) ||
    servicePhase(priorLeaf, leaf) !== "observation" ||
    !leaf.observation?.ready ||
    !isDeepStrictEqual(job.resolvedBy, resolutionLink(leaf)) ||
    job.status !== "failed" ||
    previous.revision === job.revision
  )
    throw new BootstrapRequestConflict(
      "Recovery resolution requires a new verified descendant observation",
    );
  const history = ({
    revision: _revision,
    status: _status,
    detail: _detail,
    resolvedBy: _resolved,
    ...retained
  }: MaintenanceServiceJob) => retained;
  if (
    !isDeepStrictEqual(history(previous), history(job)) ||
    !maintenanceRecoveryAncestors({
      jobs: input.previous.filter(isMaintenanceService),
      job: leaf,
      retryLimit: 3,
    }).some((ancestor) => ancestor.id === previous.id)
  )
    throw new BootstrapRequestConflict("Recovery resolution cannot rewrite original history");
  // The leaf's observation branch independently verifies the single supplied
  // native receipt and custody. Both updates are checked before one durable write.
}
