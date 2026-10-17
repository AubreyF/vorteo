import { z } from "zod";
import { MaintenanceServiceSchema } from "./execution-installation.js";

/** Separate enrollment never interprets an existing operation approval as a grant. */
export const EnrollmentTargetSchema = z.enum([
  ...MaintenanceServiceSchema.options,
  "maintenance-controller",
  "recovery-launcher",
]);
export type EnrollmentTarget = z.infer<typeof EnrollmentTargetSchema>;

export const EnrollmentOperationSchema = z.enum([
  "restart",
  "source-update",
  "source-repair",
  "runtime-adoption",
  "replacement",
  "recovery",
  "rollback",
  "credential-renewal",
]);
export type EnrollmentOperation = z.infer<typeof EnrollmentOperationSchema>;

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const EnrollmentArtifactSchema = z.strictObject({
  sourceCommit: CommitSchema,
  artifactSha256: DigestSchema,
});

export const EnrollmentTargetBindingSchema = z.strictObject({
  target: EnrollmentTargetSchema,
  // Digest of the protected native target descriptor, not a user-supplied label.
  identitySha256: DigestSchema,
  operations: z.array(EnrollmentOperationSchema).min(1).max(8),
});

export const EnrollmentStepSchema = z.strictObject({
  id: z.string().uuid(),
  target: EnrollmentTargetSchema,
  operation: EnrollmentOperationSchema,
  planSha256: DigestSchema,
  candidate: EnrollmentArtifactSchema,
  previous: EnrollmentArtifactSchema.nullable(),
  dependsOn: z.array(z.string().uuid()).max(32),
});
export type EnrollmentStep = z.infer<typeof EnrollmentStepSchema>;

export const InstallationEnrollmentManifestSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("installation-enrollment"),
  installationId: z.string().uuid(),
  revision: z.string().uuid(),
  createdAt: z.string().datetime(),
  targets: z.array(EnrollmentTargetBindingSchema).min(3).max(6),
  trustedRepositories: z.array(z.url().max(2048)).min(1).max(16),
  // Null for setup without the separate Host provisioning admission.
  provisioning: z
    .strictObject({
      admissionSha256: DigestSchema,
      coordinatorStepId: z.string().uuid(),
    })
    .nullable(),
  interruption: z.strictObject({
    finishTurnsSeconds: z.number().int().min(1).max(3600),
    terminateGraceSeconds: z.number().int().min(1).max(300),
  }),
  retryLimit: z.literal(3),
  rollback: z.literal("previous-compatible-runtime"),
  recovery: z.literal("after-login"),
  steps: z.array(EnrollmentStepSchema).min(1).max(32),
});
export type InstallationEnrollmentManifest = z.infer<typeof InstallationEnrollmentManifestSchema>;

export const InstallationEnrollmentApprovalSchema = z.strictObject({
  operation: z.literal("installation-enrollment"),
  requestId: z.string().uuid(),
  reviewRevision: z.string().uuid(),
  manifestSha256: DigestSchema,
  approvedAt: z.string().datetime(),
});
export type InstallationEnrollmentApproval = z.infer<typeof InstallationEnrollmentApprovalSchema>;

export const InstallationStandingGrantSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  approval: InstallationEnrollmentApprovalSchema,
  manifest: InstallationEnrollmentManifestSchema,
  paused: z.boolean(),
  disabledTargets: z.array(EnrollmentTargetSchema).max(6),
  revokedAt: z.string().datetime().nullable(),
});
export type InstallationStandingGrant = z.infer<typeof InstallationStandingGrantSchema>;

export const EnrollmentStepProgressSchema = z.discriminatedUnion("status", [
  z.strictObject({ id: z.string().uuid(), status: z.literal("pending") }),
  z.strictObject({
    id: z.string().uuid(),
    status: z.literal("reserved"),
    generation: z.string().uuid(),
    grantRevision: z.string().uuid(),
    reservedAt: z.string().datetime(),
  }),
  z.strictObject({
    id: z.string().uuid(),
    status: z.enum(["succeeded", "recovery_required"]),
    generation: z.string().uuid(),
    grantRevision: z.string().uuid(),
    reservedAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    // Hash of an independently verified phase/runtime receipt retained privately.
    observationSha256: DigestSchema,
  }),
]);
export type EnrollmentStepProgress = z.infer<typeof EnrollmentStepProgressSchema>;

export const InstallationActivationSchema = z.strictObject({
  id: z.string().uuid(),
  manifestSha256: DigestSchema,
  steps: z.array(EnrollmentStepProgressSchema).min(1).max(32),
  recoveries: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        failed: z.strictObject({
          id: z.string().uuid(),
          status: z.literal("recovery_required"),
          generation: z.string().uuid(),
          grantRevision: z.string().uuid(),
          reservedAt: z.string().datetime(),
          observedAt: z.string().datetime(),
          observationSha256: DigestSchema,
        }),
        observedAt: z.string().datetime(),
        observationSha256: DigestSchema,
      }),
    )
    .max(32),
});
export type InstallationActivation = z.infer<typeof InstallationActivationSchema>;

// A single atomic document prevents a grant surviving without its migration transaction.
export const InstallationEnrollmentStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ version: z.literal(1), status: z.literal("absent") }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("enrolled"),
    grant: InstallationStandingGrantSchema,
    activation: InstallationActivationSchema,
  }),
]);
export type InstallationEnrollmentState = z.infer<typeof InstallationEnrollmentStateSchema>;

export const StandingMaintenanceProposalSchema = z.strictObject({
  id: z.string().uuid(),
  installationId: z.string().uuid(),
  requestedBy: z.enum(["host-agent", "container-agent"]),
  target: EnrollmentTargetSchema,
  identitySha256: DigestSchema,
  operation: EnrollmentOperationSchema,
  planSha256: DigestSchema,
  repository: z.url(),
  sourceCommit: CommitSchema,
  artifactSha256: DigestSchema,
});
export type StandingMaintenanceProposal = z.infer<typeof StandingMaintenanceProposalSchema>;

// Independent controller and coordinator expose the same observation model.
export const InstallationEnrollmentStatusSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.string().uuid(),
  checkedAt: z.string().datetime(),
  validUntil: z.string().datetime().optional(),
  authority: z.enum(["not-enrolled", "active", "paused", "revoked"]),
  grantRevision: z.string().uuid().nullable(),
  activation: z.enum(["not-enrolled", "pending", "unconfirmed", "recovery-required", "verified"]),
  completedSteps: z.number().int().nonnegative(),
  totalSteps: z.number().int().nonnegative(),
  // Overall service health must come from fresh native inspection, never grant presence.
  services: z
    .array(
      z.strictObject({
        target: EnrollmentTargetSchema,
        enabled: z.boolean(),
        readiness: z.enum(["ready", "blocked", "unknown"]),
        reason: z.string().max(2000),
        observedAt: z.string().datetime().nullable(),
        selectedSource: CommitSchema.nullable(),
      }),
    )
    .max(6),
  steps: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        target: EnrollmentTargetSchema,
        status: z.enum(["pending", "unconfirmed", "recovery-required", "verified"]),
        observedAt: z.string().datetime().nullable(),
        sourceCommit: CommitSchema,
      }),
    )
    .max(32),
});
export type InstallationEnrollmentStatus = z.infer<typeof InstallationEnrollmentStatusSchema>;

/** Separate owner HTTP response; existing enrollment and WebSocket shapes stay unchanged. */
export const InstallationRecoveryOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && url.hostname.endsWith(".ts.net");
});
const recoveryAccessStatus = {
  version: z.literal(1),
  installationId: z.string().uuid(),
  checkedAt: z.string().datetime(),
};
export const InstallationRecoveryAccessStatusSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...recoveryAccessStatus,
    status: z.literal("verified"),
    url: InstallationRecoveryOriginSchema,
    validUntil: z.string().datetime(),
  }),
  z.strictObject({
    ...recoveryAccessStatus,
    status: z.literal("unverified"),
    url: z.null(),
    validUntil: z.null(),
  }),
]);
export type InstallationRecoveryAccessStatus = z.infer<
  typeof InstallationRecoveryAccessStatusSchema
>;
