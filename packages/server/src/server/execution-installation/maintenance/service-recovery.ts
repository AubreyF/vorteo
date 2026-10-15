import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MaintenanceServiceJob } from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";

interface RecoveryChainInput {
  jobs: readonly MaintenanceServiceJob[];
  job: MaintenanceServiceJob;
  retryLimit: number;
}

/** Immediate ancestors, newest first. Native executor exit and current custody
 * remain separate prerequisites; this function grants no execution authority. */
export function maintenanceRecoveryAncestors(input: RecoveryChainInput): MaintenanceServiceJob[] {
  const ancestors: MaintenanceServiceJob[] = [];
  const seen = new Set([input.job.id]);
  let child = input.job;
  while (child.proposal.recoveryOf) {
    const link = child.proposal.recoveryOf;
    if (seen.has(link.requestId))
      throw new BootstrapRequestConflict("Maintenance recovery history contains a cycle");
    seen.add(link.requestId);
    const parent = input.jobs.find((job) => job.id === link.requestId);
    if (!parent) throw new BootstrapRequestConflict("Recovery predecessor is not retained");
    assertRecoveryEdge(child, parent);
    ancestors.push(parent);
    if (ancestors.length > input.retryLimit)
      throw new BootstrapRequestConflict("Maintenance recovery retry budget is exhausted");
    child = parent;
  }
  if (!ancestors.length) {
    if (input.job.operation !== "replacement")
      throw new BootstrapRequestConflict("Recovery requires an immediate predecessor");
    return ancestors;
  }
  if (child.operation !== "replacement")
    throw new BootstrapRequestConflict("Recovery history has no original replacement");
  for (const successor of [input.job, ...ancestors.slice(0, -1)])
    assertOriginalSlots(successor, child);
  return ancestors;
}

function assertRecoveryEdge(child: MaintenanceServiceJob, parent: MaintenanceServiceJob): void {
  const link = child.proposal.recoveryOf!;
  const reservation = parent.reservation;
  const intent = parent.effectIntent;
  const observation = parent.observation;
  if (
    child.operation === "replacement" ||
    parent.resolvedBy ||
    !["running", "failed"].includes(parent.status) ||
    child.target !== parent.target ||
    child.proposal.installationId !== parent.proposal.installationId ||
    child.proposal.identitySha256 !== parent.proposal.identitySha256 ||
    !reservation ||
    !intent ||
    !observation ||
    observation.ready
  )
    throw new BootstrapRequestConflict(
      "Recovery link differs from its consumed uncertain predecessor",
    );
  assertConsumedRecoveryGeneration(parent, child);
  assertRecoveryObservationRecord(parent, link.observationSha256);
}

function assertConsumedRecoveryGeneration(
  parent: MaintenanceServiceJob,
  child: MaintenanceServiceJob,
): void {
  const reservation = parent.reservation!,
    intent = parent.effectIntent!,
    observation = parent.observation!,
    link = child.proposal.recoveryOf!;
  if (
    reservation.requestId !== parent.id ||
    reservation.requestRevision !== parent.approval?.requestRevision ||
    intent.generation !== reservation.generation ||
    intent.requestRevision !== reservation.requestRevision ||
    link.generation !== reservation.generation ||
    link.planSha256 !== reservation.planSha256 ||
    reservation.planSha256 !== parent.proposal.planSha256 ||
    observation.requestId !== parent.id ||
    observation.requestRevision !== reservation.requestRevision ||
    observation.generation !== reservation.generation ||
    observation.planSha256 !== reservation.planSha256 ||
    observation.identitySha256 !== reservation.identitySha256 ||
    link.observationSha256 !== observation.evidenceSha256 ||
    Date.parse(observation.observedAt) < Date.parse(intent.consumedAt)
  )
    throw new BootstrapRequestConflict(
      "Recovery link differs from its consumed uncertain predecessor",
    );
}
function assertRecoveryObservationRecord(
  parent: MaintenanceServiceJob,
  observationSha256: string,
): void {
  const reservation = parent.reservation!,
    observation = parent.observation!;
  const matches = parent.evidence.filter((item) => item.sha256 === observationSha256);
  const record = matches[0]?.record;
  if (
    matches.length !== 1 ||
    !record ||
    createHash("sha256").update(JSON.stringify(record)).digest("hex") !== observationSha256 ||
    record.requestId !== parent.id ||
    record.requestRevision !== reservation.requestRevision ||
    record.planSha256 !== reservation.planSha256 ||
    record.identitySha256 !== reservation.identitySha256 ||
    record.observedAt !== observation.observedAt ||
    record.sourceCommit !== observation.sourceCommit ||
    record.artifactSha256 !== observation.artifactSha256
  )
    throw new BootstrapRequestConflict(
      "Recovery predecessor lacks exact addressed native evidence",
    );
}

function assertOriginalSlots(job: MaintenanceServiceJob, original: MaintenanceServiceJob): void {
  const candidate = {
    sourceCommit: original.proposal.sourceCommit,
    artifactSha256: original.proposal.artifactSha256,
  };
  const desired = job.operation === "rollback" ? original.proposal.previous : candidate;
  const previous = job.operation === "rollback" ? candidate : original.proposal.previous;
  if (
    !desired ||
    job.proposal.sourceCommit !== desired.sourceCommit ||
    job.proposal.artifactSha256 !== desired.artifactSha256 ||
    !isDeepStrictEqual(job.proposal.previous, previous)
  )
    throw new BootstrapRequestConflict("Recovery proposal selected an unreviewed original runtime");
}

/** A pending successor does not waive exclusion for another active branch. */
export function assertMaintenanceRecoveryExclusion(input: RecoveryChainInput): void {
  const ancestors = new Set(maintenanceRecoveryAncestors(input).map((job) => job.id));
  if (
    input.jobs.some(
      (job) =>
        job.id !== input.job.id &&
        (job.status === "approved" || job.status === "running") &&
        !ancestors.has(job.id),
    )
  )
    throw new BootstrapRequestConflict("Another maintenance generation owns recovery admission");
}

/** Prefer the exact admitted recovery leaf over its uncertain ancestors. Pending
 * successors get inspected, but still require locked admission before any effect. */
export function selectMaintenanceServiceWork(
  jobs: readonly MaintenanceServiceJob[],
  eligible: (job: MaintenanceServiceJob) => boolean = () => true,
): MaintenanceServiceJob | undefined {
  const active = jobs.filter((job) => job.status === "approved" || job.status === "running");
  const pending = jobs.filter((job) => job.status === "pending");
  for (const job of [...pending.filter((item) => item.proposal.recoveryOf), ...active]) {
    if (!eligible(job)) continue;
    try {
      assertMaintenanceRecoveryExclusion({ jobs, job, retryLimit: 3 });
      return job;
    } catch {
      // A stale link or competing branch cannot take over the active generation.
    }
  }
  if (!active.length)
    return pending.find((job) => job.operation === "replacement" && eligible(job));
  return undefined;
}
