import { z } from "zod";
import { BootstrapProcessIdentitySchema } from "./coordinator-bootstrap.js";
import {
  EnrollmentArtifactSchema,
  StandingMaintenanceProposalSchema,
} from "./installation-enrollment.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const physicalPath = z.string().startsWith("/").max(4096);
export const MaintenanceServiceTargetSchema = z.enum([
  "maintenance-controller",
  "recovery-launcher",
]);
export const MaintenanceServiceOperationSchema = z.enum(["replacement", "recovery", "rollback"]);
export const MaintenanceServiceRecoveryLinkSchema = z.strictObject({
  requestId: z.uuid(),
  generation: z.uuid(),
  planSha256: digest,
  observationSha256: digest,
});

export const MaintenanceServiceProposalSchema = StandingMaintenanceProposalSchema.extend({
  target: MaintenanceServiceTargetSchema,
  operation: MaintenanceServiceOperationSchema,
  repository: z.url().max(4096),
  previous: EnrollmentArtifactSchema.nullable(),
  recoveryOf: MaintenanceServiceRecoveryLinkSchema.optional(),
});

export const MaintenanceServiceNativeEvidenceSchema = z.strictObject({
  bootId: z.uuid(),
  process: BootstrapProcessIdentitySchema.nullable(),
  service: z.strictObject({
    domain: z.string().regex(/^gui\/\d+$/),
    label: z.string().regex(/^local\.vorteo\.[a-zA-Z0-9.-]+$/),
    registered: z.boolean(),
    launcherPath: physicalPath,
    launcherSha256: digest.nullable(),
    registrationSha256: digest.nullable(),
  }),
  selection: z.strictObject({
    path: physicalPath,
    receiptSha256: digest.nullable(),
    sourceCommit: commit.nullable(),
    artifactSha256: digest.nullable(),
  }),
});

/** The selected controller is separate from the service being replaced. */
export const MaintenanceServiceExecutorEvidenceSchema = z.strictObject({
  target: MaintenanceServiceTargetSchema,
  identitySha256: digest,
  planSha256: digest,
  sourceCommit: commit,
  artifactSha256: digest,
  runtimeDirectory: physicalPath,
  setup: z.strictObject({ path: physicalPath, sha256: digest }),
  node: z.strictObject({ path: physicalPath, sha256: digest }),
  entrypoint: z.strictObject({ path: physicalPath, sha256: digest }),
  native: MaintenanceServiceNativeEvidenceSchema.extend({
    process: BootstrapProcessIdentitySchema,
    service: MaintenanceServiceNativeEvidenceSchema.shape.service.extend({
      registered: z.literal(true),
      launcherSha256: digest,
      registrationSha256: digest,
    }),
    selection: MaintenanceServiceNativeEvidenceSchema.shape.selection.extend({
      receiptSha256: digest,
      sourceCommit: commit,
      artifactSha256: digest,
    }),
  }),
});
export type MaintenanceServiceExecutorEvidence = z.infer<
  typeof MaintenanceServiceExecutorEvidenceSchema
>;

/** Retained evidence is distinct from a current native authorization check. */
export const MaintenanceServiceEvidenceRecordSchema = z.strictObject({
  requestId: z.uuid(),
  requestRevision: z.uuid(),
  planSha256: digest,
  identitySha256: digest,
  sourceCommit: commit.nullable(),
  artifactSha256: digest.nullable(),
  observedAt: z.string().datetime(),
  native: MaintenanceServiceNativeEvidenceSchema,
  /** Absent only on legacy receipts retained for observation. New effect
   * admission requires the independently verified selected executor. */
  executor: MaintenanceServiceExecutorEvidenceSchema.optional(),
});
export type MaintenanceServiceEvidenceRecord = z.infer<
  typeof MaintenanceServiceEvidenceRecordSchema
>;

export const MaintenanceServiceReservationSchema = z.strictObject({
  requestId: z.uuid(),
  /** Permanently the approved revision. Current journal CAS is separate. */
  requestRevision: z.uuid(),
  generation: z.uuid(),
  target: MaintenanceServiceTargetSchema,
  operation: MaintenanceServiceOperationSchema,
  grantId: z.uuid(),
  grantRevision: z.uuid(),
  manifestSha256: digest,
  proposalSha256: digest,
  planSha256: digest,
  identitySha256: digest,
  sourceCommit: commit,
  artifactSha256: digest,
  previous: EnrollmentArtifactSchema.nullable(),
  recoveryOf: MaintenanceServiceRecoveryLinkSchema.optional(),
  nativeEvidenceSha256: digest,
  reservedAt: z.string().datetime(),
});
export type MaintenanceServiceReservation = z.infer<typeof MaintenanceServiceReservationSchema>;

export const MaintenanceServiceObservationSchema = z.strictObject({
  requestId: z.uuid(),
  /** Echoes the reservation's approved revision, never a later journal revision. */
  requestRevision: z.uuid(),
  generation: z.uuid(),
  planSha256: digest,
  identitySha256: digest,
  outcome: z.enum(["candidate", "previous", "unknown"]),
  sourceCommit: commit.nullable(),
  artifactSha256: digest.nullable(),
  ready: z.boolean(),
  evidenceSha256: digest,
  observedAt: z.string().datetime(),
});
export type MaintenanceServiceObservation = z.infer<typeof MaintenanceServiceObservationSchema>;

export const MaintenanceServiceJobSchema = z.strictObject({
  id: z.uuid(),
  revision: z.uuid(),
  target: MaintenanceServiceTargetSchema,
  operation: MaintenanceServiceOperationSchema,
  proposal: MaintenanceServiceProposalSchema,
  reason: z.string().min(1).max(4096),
  requester: z.string().min(1).max(256).optional(),
  createdAt: z.string().datetime(),
  status: z.enum(["pending", "approved", "running", "succeeded", "failed", "rejected"]),
  detail: z.string().max(4096),
  approval: z
    .strictObject({
      grantId: z.uuid(),
      grantRevision: z.uuid(),
      manifestSha256: digest,
      proposalSha256: digest,
      reviewedRevision: z.uuid(),
      requestRevision: z.uuid(),
      nativeEvidenceSha256: digest,
      approvedAt: z.string().datetime(),
      dispatchAfter: z.string().datetime(),
    })
    .optional(),
  reservation: MaintenanceServiceReservationSchema.optional(),
  /** Factory consumes this exact intent before any native effect. Retained
   * intent permits observation only, even when the executor never replied. */
  effectIntent: z
    .strictObject({
      id: z.uuid(),
      generation: z.uuid(),
      requestRevision: z.uuid(),
      nativeEvidenceSha256: digest,
      executor: BootstrapProcessIdentitySchema,
      consumedAt: z.string().datetime(),
    })
    .optional(),
  observation: MaintenanceServiceObservationSchema.optional(),
  /** Verified descendant readiness resolves uncertainty, never rewrites the
   * original attempt's outcome or grants permission to replay it. */
  resolvedBy: MaintenanceServiceRecoveryLinkSchema.optional(),
  reconciliation: z
    .strictObject({
      attempts: z.number().int().min(0).max(3),
      nextCheckAt: z.string().datetime(),
    })
    .optional(),
  evidence: z
    .array(
      z.strictObject({
        sha256: digest,
        record: MaintenanceServiceEvidenceRecordSchema,
      }),
    )
    .max(8),
});
export type MaintenanceServiceJob = z.infer<typeof MaintenanceServiceJobSchema>;
