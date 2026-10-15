import { isDeepStrictEqual } from "node:util";
import type { LifecycleJob } from "../lifecycle-journal.js";
import { maintenanceRecoveryAncestors } from "./service-recovery.js";
import { isMaintenanceService } from "./service-admission.js";
import { randomUUID } from "node:crypto";
import {
  MaintenanceServiceEvidenceRecordSchema,
  MaintenanceServiceJobSchema,
  type MaintenanceServiceJob,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import {
  maintenanceServiceEvidenceDigest,
  type MaintenanceServiceAdmissionEvidence,
  type MaintenanceServiceStandingAuthority,
} from "./service-admission.js";
import type {
  MaintenanceServiceNativeEvidence,
  MaintenanceServiceNativeObservation,
} from "./service-execution.js";

export function serviceInspectionProof(
  job: MaintenanceServiceJob,
  value: MaintenanceServiceNativeEvidence,
): MaintenanceServiceAdmissionEvidence {
  const { assertCurrent, evidenceSha256, ...valueRecord } = value;
  const record = MaintenanceServiceEvidenceRecordSchema.parse(valueRecord);
  if (maintenanceServiceEvidenceDigest(record) !== evidenceSha256)
    throw new BootstrapRequestConflict("Native service evidence digest does not match its record");
  return { expectedRevision: job.revision, record, sha256: evidenceSha256, assertCurrent };
}
function retain(
  job: MaintenanceServiceJob,
  proof: MaintenanceServiceAdmissionEvidence,
): MaintenanceServiceJob {
  if (maintenanceServiceEvidenceDigest(proof.record) !== proof.sha256)
    throw new BootstrapRequestConflict(
      "Native service observation digest does not match its record",
    );
  if (job.evidence.some((item) => item.sha256 === proof.sha256)) return job;
  return { ...job, evidence: [...job.evidence, { sha256: proof.sha256, record: proof.record }] };
}
function clearServiceChecks(job: MaintenanceServiceJob): MaintenanceServiceJob {
  const { reconciliation: _checks, ...request } = job;
  return request;
}
export function approveServiceJob(
  job: MaintenanceServiceJob,
  authority: MaintenanceServiceStandingAuthority,
  proof: MaintenanceServiceAdmissionEvidence,
  now: number,
): MaintenanceServiceJob {
  const revision = randomUUID();
  return MaintenanceServiceJobSchema.parse({
    ...retain(clearServiceChecks(job), proof),
    revision,
    status: "approved",
    detail:
      "Automatically approved. Cancellation remains available for thirty seconds before maintenance.",
    approval: {
      ...authority,
      reviewedRevision: job.revision,
      requestRevision: revision,
      nativeEvidenceSha256: proof.sha256,
      approvedAt: new Date(now).toISOString(),
      dispatchAfter: new Date(now + 30_000).toISOString(),
    },
  });
}
export function reserveServiceJob(
  job: MaintenanceServiceJob,
  proof: MaintenanceServiceAdmissionEvidence,
  now: number,
): MaintenanceServiceJob {
  const approval = job.approval!;
  return MaintenanceServiceJobSchema.parse({
    ...retain(clearServiceChecks(job), proof),
    revision: randomUUID(),
    status: "running",
    detail:
      "Maintenance generation reserved. Native execution will consume one durable intent; uncertain execution will not be repeated.",
    reservation: {
      requestId: job.id,
      requestRevision: approval.requestRevision,
      generation: randomUUID(),
      target: job.target,
      operation: job.operation,
      grantId: approval.grantId,
      grantRevision: approval.grantRevision,
      manifestSha256: approval.manifestSha256,
      proposalSha256: approval.proposalSha256,
      planSha256: job.proposal.planSha256,
      identitySha256: job.proposal.identitySha256,
      sourceCommit: job.proposal.sourceCommit,
      artifactSha256: job.proposal.artifactSha256,
      previous: job.proposal.previous,
      ...(job.proposal.recoveryOf ? { recoveryOf: job.proposal.recoveryOf } : {}),
      nativeEvidenceSha256: proof.sha256,
      reservedAt: new Date(now).toISOString(),
    },
  });
}
export function observeServiceJob(
  job: MaintenanceServiceJob,
  value: MaintenanceServiceNativeObservation,
  now: number,
) {
  const { record, assertCurrent, ...observation } = value;
  const proof: MaintenanceServiceAdmissionEvidence = {
    expectedRevision: job.revision,
    record: MaintenanceServiceEvidenceRecordSchema.parse(record),
    sha256: observation.evidenceSha256,
    assertCurrent,
  };
  let status: MaintenanceServiceJob["status"] = "running";
  let detail = "Native maintenance is unconfirmed. Retained execution will only be observed.";
  if (observation.ready && observation.outcome === "candidate") {
    status = "succeeded";
    detail = "Reviewed candidate and native service readiness verified.";
  }
  if (observation.ready && observation.outcome === "previous") {
    status = "failed";
    detail =
      "Previous reviewed runtime is ready. Candidate maintenance failed and was not reported as success.";
  }
  let next = MaintenanceServiceJobSchema.parse({
    ...retain(job, proof),
    revision: randomUUID(),
    status,
    detail,
    observation,
  });
  if (status === "running") next = failedServiceCheck(next, now);
  return { job: next, proof };
}
export function serviceCheckDue(job: MaintenanceServiceJob, now: number): boolean {
  if (!job.reconciliation) return true;
  return job.reconciliation.attempts < 3 && now >= Date.parse(job.reconciliation.nextCheckAt);
}
export function failedServiceCheck(job: MaintenanceServiceJob, now: number): MaintenanceServiceJob {
  const attempts = Math.min(3, (job.reconciliation?.attempts ?? 0) + 1);
  const delays = [5000, 15_000, 45_000];
  return MaintenanceServiceJobSchema.parse({
    ...job,
    revision: randomUUID(),
    detail:
      attempts === 3
        ? "Native maintenance could not be verified after three checks. Recovery is required; no uncertain effect will be repeated."
        : "Native maintenance is unverified. Waiting before the next bounded check; no uncertain effect will be repeated.",
    reconciliation: { attempts, nextCheckAt: new Date(now + delays[attempts - 1]).toISOString() },
  });
}

/** Build the complete observation write from the fresh, lock-held journal.
 * Historical generations retain their receipts and are never rewritten as success. */
export function retainServiceRecoveryObservation(
  jobs: readonly LifecycleJob[],
  previous: MaintenanceServiceJob,
  observed: MaintenanceServiceJob,
): LifecycleJob[] {
  const current = jobs.find((job) => job.id === previous.id);
  if (!isDeepStrictEqual(current, previous))
    throw new BootstrapRequestConflict("Maintenance journal changed before observation");
  const ancestors = observed.observation?.ready
    ? maintenanceRecoveryAncestors({
        jobs: jobs.filter(isMaintenanceService),
        job: observed,
        retryLimit: 3,
      })
    : [];
  const ids = new Set(ancestors.map((job) => job.id));
  return jobs.map((job) => {
    if (job.id === observed.id) return observed;
    if (!ids.has(job.id)) return job;
    return MaintenanceServiceJobSchema.parse({
      ...job,
      revision: randomUUID(),
      status: "failed",
      detail:
        "A later reviewed recovery verified service readiness. This original attempt remains failed.",
      resolvedBy: {
        requestId: observed.id,
        generation: observed.reservation!.generation,
        planSha256: observed.proposal.planSha256,
        observationSha256: observed.observation!.evidenceSha256,
      },
    });
  });
}
