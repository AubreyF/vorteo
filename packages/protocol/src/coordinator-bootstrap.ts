import { PreviewMonitorConfigurationSchema } from "./preview-monitor-maintenance.js";
import { NativeHelperConfigurationSchema } from "./native-helper-maintenance.js";
import { FactoryRuntimeAdoptionConfigurationSchema } from "./execution-installation.js";
import { z } from "zod";
import { StandingMaintenanceProposalSchema } from "./installation-enrollment.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const AbsolutePathSchema = z.string().startsWith("/").min(2).max(4096);
const FileIdentitySchema = z.strictObject({ path: AbsolutePathSchema, sha256: DigestSchema });
export const CoordinatorMaintenanceProvisionRequestSchema = z.strictObject({
  type: z.literal("installation.maintenance.provision.request"),
  admissionSha256: DigestSchema,
  ownerPassword: z.string().min(1).max(4096),
});
export const CoordinatorMaintenanceEnrollmentRequestSchema = z.strictObject({
  type: z.literal("installation.maintenance.enroll.request"),
  id: z.string().uuid(),
  revision: z.string().uuid(),
  manifestSha256: DigestSchema,
  ownerPassword: z.string().min(1).max(4096).optional(),
});
// Separate HTTP operation: old controls must refuse consent-only requests,
// never interpret them as the existing effectful enrollment action.
export const CoordinatorMaintenanceSaveConsentRequestSchema =
  CoordinatorMaintenanceEnrollmentRequestSchema.extend({
    type: z.literal("installation.maintenance.enrollment.save_consent.request"),
  });
export const CoordinatorMaintenanceObserveRequestSchema = z.strictObject({
  type: z.literal("installation.maintenance.observe.request"),
  id: z.string().uuid(),
  revision: z.string().uuid(),
  manifestSha256: DigestSchema,
});
export const CoordinatorMaintenanceStatusSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.string().uuid(),
  available: z.boolean(),
  phase: z.enum(["unprovisioned", "validating", "ready", "unavailable"]),
  requests: z.number().int().nonnegative(),
  provisioning: z.strictObject({
    admissionSha256: DigestSchema,
    sourceCommit: CommitSchema,
    artifactSha256: DigestSchema,
    requestId: z.string().uuid(),
  }),
});
const ReleaseIdentitySchema = z.strictObject({
  sourceCommit: CommitSchema,
  directory: AbsolutePathSchema,
  artifactSha256: DigestSchema,
  node: FileIdentitySchema,
  entrypoint: FileIdentitySchema,
  configuration: FileIdentitySchema,
  launcher: FileIdentitySchema,
});

// This describes inert prepared bytes. Parsing it never authorizes service control.
export const CoordinatorBootstrapPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("coordinator-bootstrap"),
  installationId: z.string().uuid(),
  service: z.string().regex(/^gui\/\d+\/local\.vorteo\.[a-zA-Z0-9.-]+\.installation$/),
  expectedProcess: z.strictObject({
    pid: z.number().int().positive(),
    bootId: z.string().min(1).max(128),
    startIdentity: z.string().min(1).max(128),
    argumentsSha256: DigestSchema,
  }),
  previous: ReleaseIdentitySchema,
  candidate: ReleaseIdentitySchema,
  state: z.strictObject({
    directory: AbsolutePathSchema,
    restartJournal: AbsolutePathSchema,
    ownerSessions: AbsolutePathSchema,
  }),
  hostRequestsAfter: z.string().datetime().nullable(),
  recoveredFrom: z
    .strictObject({
      id: z.string().uuid(),
      revision: z.string().uuid(),
      generation: z.string().uuid(),
      planSha256: DigestSchema,
    })
    .optional(),
  // Manual restoration is not terminal migration evidence. A new exact owner
  // review retains the canceled proposal and the failed predecessor separately.
  supervisionRecovery: z
    .strictObject({
      canceledRequest: z.strictObject({
        id: z.string().uuid(),
        revision: z.string().uuid(),
        planSha256: DigestSchema,
      }),
      terminateFrozen: z.literal("SIGKILL"),
    })
    .optional(),
  // Exact reviewed startup configuration for the independent recovery service.
  bootRecovery: z
    .strictObject({
      requestId: z.string().uuid(),
      service: z
        .string()
        .regex(/^gui\/\d+\/local\.vorteo\.[a-zA-Z0-9.-]+\.installation-recovery-[a-f0-9-]{36}$/),
      launcher: FileIdentitySchema,
      installedLauncher: AbsolutePathSchema,
      setup: FileIdentitySchema,
      ownerLauncher: FileIdentitySchema,
      node: FileIdentitySchema,
      entrypoint: FileIdentitySchema,
    })
    .optional(),
  automaticRecovery: z.enum(["restore-previous", "restore-compatible"]).optional(),
  compatibleRecovery: ReleaseIdentitySchema.optional(),
  // COMPAT(sourceUpdateTooling): optional exact candidate/scripts selection; retain until 2027-04-11.
  sourceUpdateTooling: z.literal(true).optional(),
  nativeHelperConfiguration: NativeHelperConfigurationSchema.nullable().optional(),
  previewMonitorConfiguration: PreviewMonitorConfigurationSchema.nullable().optional(),
  // COMPAT(factoryRuntimeAdoption): added in v0.11.0-beta.3.vorteo.285.
  factoryRuntimeAdoptionConfiguration:
    FactoryRuntimeAdoptionConfigurationSchema.nullable().optional(),
});
export type CoordinatorBootstrapPlan = z.infer<typeof CoordinatorBootstrapPlanSchema>;

export const CoordinatorBootstrapStageSchema = z.enum([
  "claimed",
  "freeze_pending",
  "frozen",
  "unload_pending",
  "unloaded",
  "selection_pending",
  "selected",
  "start_pending",
  "started",
  "verifying",
  "succeeded",
  "resume_pending",
  "resumed",
  "recovery_required",
  "rollback_pending",
  "rolled_back",
]);
export type CoordinatorBootstrapStage = z.infer<typeof CoordinatorBootstrapStageSchema>;

export const CoordinatorAutomaticAuthoritySchema = z.strictObject({
  credentialBinding: DigestSchema,
  policyActivatedAt: z.string().datetime(),
});
export type CoordinatorAutomaticAuthority = z.infer<typeof CoordinatorAutomaticAuthoritySchema>;

export const CoordinatorAutomaticCheckSchema = z.strictObject({
  phase: z.enum(["approval", "dispatch"]),
  attempt: z.number().int().min(1).max(3),
  startedAt: z.string().datetime(),
  retryAfter: z.string().datetime(),
  outcome: z.enum(["running", "unconfirmed"]),
});

export const CoordinatorEnrollmentAuthoritySchema = z.strictObject({
  grantId: z.string().uuid(),
  grantRevision: z.string().uuid(),
  manifestSha256: DigestSchema,
  reviewId: z.string().uuid(),
  reviewRevision: z.string().uuid(),
  admissionSha256: DigestSchema,
  stepId: z.string().uuid(),
  generation: z.string().uuid(),
});

export const BootstrapProcessIdentitySchema = z.strictObject({
  pid: z.number().int().positive(),
  parentPid: z.number().int().positive(),
  uid: z.number().int().nonnegative(),
  bootId: z.string().uuid(),
  startIdentity: z.string().regex(/^\d+:\d+$/),
  argumentsSha256: DigestSchema,
  executable: z.string().startsWith("/"),
});

export const CoordinatorBootstrapRequestSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  requestedBy: z.literal("host-agent"),
  reason: z.string().min(1).max(4000),
  createdAt: z.string().datetime(),
  plan: CoordinatorBootstrapPlanSchema,
  planSha256: DigestSchema,
  status: z.enum(["pending", "approved", "canceled"]),
  decisionAt: z.string().datetime().optional(),
  standingAuthority: z
    .strictObject({
      grantId: z.uuid(),
      grantRevision: z.uuid(),
      manifestSha256: DigestSchema,
      proposal: StandingMaintenanceProposalSchema,
      nativeEvidenceSha256: DigestSchema,
      decidedAt: z.string().datetime(),
      dispatchAfter: z.string().datetime(),
    })
    .optional(),
  standingDispatch: z
    .strictObject({
      approvedRevision: z.uuid(),
      requestedAt: z.string().datetime(),
      nativeEvidenceSha256: DigestSchema,
    })
    .optional(),
  supervisionDispatch: z
    .strictObject({
      approvedRevision: z.string().uuid(),
      requestedAt: z.string().datetime(),
      setup: FileIdentitySchema,
      parent: BootstrapProcessIdentitySchema,
    })
    .optional(),
  // Separate standing consent; never inferred from legacy approval or policy flags.
  enrollment: CoordinatorEnrollmentAuthoritySchema.optional(),
  enrollmentDispatch: z
    .strictObject({
      approvedRevision: z.string().uuid(),
      requestedAt: z.string().datetime(),
    })
    .optional(),
  automaticCheck: CoordinatorAutomaticCheckSchema.optional(),
  // Protected provenance is minted by scoped Host admission, never by plan input.
  automaticSubmission: CoordinatorAutomaticAuthoritySchema.extend({
    submittedAt: z.string().datetime(),
  }).optional(),
  automaticApproval: CoordinatorAutomaticAuthoritySchema.extend({
    requestRevision: z.string().uuid(),
    dispatchAfter: z.string().datetime(),
  }).optional(),
  automaticDispatch: z
    .strictObject({
      approvedRevision: z.string().uuid(),
      requestedAt: z.string().datetime(),
    })
    .optional(),
  execution: z
    .strictObject({
      generation: z.string().uuid(),
      stage: CoordinatorBootstrapStageSchema,
      updatedAt: z.string().datetime(),
      rollbackAttemptedAt: z.string().datetime().optional(),
    })
    .optional(),
});
export type CoordinatorBootstrapRequest = z.infer<typeof CoordinatorBootstrapRequestSchema>;

export const CoordinatorAutomaticStatusSchema = z.strictObject({
  authorization: z.enum(["host-policy", "owner"]),
  state: z.enum([
    "waiting",
    "checking",
    "retry-wait",
    "review-required",
    "cancellation-window",
    "dispatch-ready",
    "launch-unconfirmed",
    "owner-approved",
    "execution",
    "canceled",
  ]),
  observedAt: z.string().datetime(),
  attempt: z.number().int().min(1).max(3).optional(),
  nextCheckAt: z.string().datetime().optional(),
  dispatchAfter: z.string().datetime().optional(),
});
export type CoordinatorAutomaticStatus = z.infer<typeof CoordinatorAutomaticStatusSchema>;
export const CoordinatorBootstrapRequestViewSchema = CoordinatorBootstrapRequestSchema.extend({
  automaticStatus: CoordinatorAutomaticStatusSchema.optional(),
});
export type CoordinatorBootstrapRequestView = z.infer<typeof CoordinatorBootstrapRequestViewSchema>;

// Independent recovery HTTP only. The browser never supplies a plan or runtime path.
export const RecoveryApplicationDiagnosticsRequestSchema = z.strictObject({
  type: z.literal("installation.maintenance.application_diagnostics.request"),
  requestId: z.string().min(1).max(128),
});
export const RecoveryApplicationDiagnosticsSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.string().uuid(),
  applicationOrigin: z.url(),
  checkedAt: z.string().datetime(),
  scope: z.literal("recovery-host"),
  browserUsability: z.literal("unverified"),
  checks: z
    .array(
      z.strictObject({
        id: z.enum(["health", "owner-api", "document", "scripts"]),
        state: z.enum(["reached", "failed", "unverified"]),
        detail: z.string().max(500),
        httpStatus: z.number().int().min(100).max(599).nullable(),
      }),
    )
    .length(4),
});
export type RecoveryApplicationDiagnostics = z.infer<typeof RecoveryApplicationDiagnosticsSchema>;
export const RecoveryApplicationDiagnosticsResponseSchema = z.strictObject({
  type: z.literal("installation.maintenance.application_diagnostics.response"),
  payload: z.strictObject({
    requestId: z.string(),
    report: RecoveryApplicationDiagnosticsSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const CoordinatorMaintenanceRollbackPrepareRequestSchema = z.strictObject({
  type: z.literal("installation.maintenance.rollback.prepare.request"),
  requestId: z.string().min(1).max(128),
});
export const CoordinatorMaintenanceRollbackPrepareResponseSchema = z.strictObject({
  type: z.literal("installation.maintenance.rollback.prepare.response"),
  payload: z.strictObject({
    requestId: z.string(),
    requests: z.array(CoordinatorBootstrapRequestViewSchema).nullable(),
    error: z.string().nullable(),
  }),
});

export const CoordinatorBootstrapPreparationSchema = z.strictObject({
  id: z.string().uuid(),
  reason: z.string().min(1).max(4000),
  plan: CoordinatorBootstrapPlanSchema,
});
export const CoordinatorBootstrapDecisionSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: DigestSchema,
  decision: z.enum(["approve", "cancel"]),
});
export type CoordinatorBootstrapPreparation = z.infer<typeof CoordinatorBootstrapPreparationSchema>;
export type CoordinatorBootstrapDecision = z.infer<typeof CoordinatorBootstrapDecisionSchema>;

export const CoordinatorBootstrapListRequestSchema = z.strictObject({
  type: z.literal("installation.bootstrap.list_requests.request"),
  requestId: z.string(),
  factoryRuntimeAdoption: z.literal(true).optional(),
  compatibleRecovery: z.literal(true).optional(),
  previewMonitor: z.literal(true).optional(),
  sourceUpdateTooling: z.literal(true).optional(),
  bootRecovery: z.literal(true).optional(),
  automaticStatus: z.literal(true).optional(),
});
export const CoordinatorSubmissionProofSchema = z.strictObject({
  policyActivatedAt: z.string().datetime(),
  signature: DigestSchema,
});
export type CoordinatorSubmissionProof = z.infer<typeof CoordinatorSubmissionProofSchema>;
export const CoordinatorBootstrapPrepareRequestSchema = z.strictObject({
  type: z.literal("installation.bootstrap.prepare.request"),
  requestId: z.string(),
  factoryRuntimeAdoption: z.literal(true).optional(),
  compatibleRecovery: z.literal(true).optional(),
  previewMonitor: z.literal(true).optional(),
  sourceUpdateTooling: z.literal(true).optional(),
  bootRecovery: z.literal(true).optional(),
  automaticStatus: z.literal(true).optional(),
  input: CoordinatorBootstrapPreparationSchema,
  submissionProof: CoordinatorSubmissionProofSchema.optional(),
});
export const CoordinatorBootstrapDecideRequestSchema = z.strictObject({
  type: z.literal("installation.bootstrap.decide.request"),
  requestId: z.string(),
  factoryRuntimeAdoption: z.literal(true).optional(),
  compatibleRecovery: z.literal(true).optional(),
  previewMonitor: z.literal(true).optional(),
  sourceUpdateTooling: z.literal(true).optional(),
  bootRecovery: z.literal(true).optional(),
  automaticStatus: z.literal(true).optional(),
  input: CoordinatorBootstrapDecisionSchema,
  // Transient owner proof. Never persist it with the request or decision.
  ownerPassword: z.string().min(1).max(1024),
});
// Only observes or advances an already authenticated protected submission.
// No caller-supplied authority or owner proof is accepted here.
export const CoordinatorBootstrapReconcileAutomaticRequestSchema =
  CoordinatorBootstrapListRequestSchema.extend({
    type: z.literal("installation.bootstrap.reconcile_automatic.request"),
    id: z.string().uuid(),
  });
const BootstrapResultSchema = z.strictObject({
  requestId: z.string(),
  requests: z.array(CoordinatorBootstrapRequestViewSchema).nullable(),
  error: z.string().nullable(),
});
export const CoordinatorBootstrapListResponseSchema = z.strictObject({
  type: z.literal("installation.bootstrap.list_requests.response"),
  payload: BootstrapResultSchema,
});
export const CoordinatorBootstrapPrepareResponseSchema = z.strictObject({
  type: z.literal("installation.bootstrap.prepare.response"),
  payload: BootstrapResultSchema,
});
export const CoordinatorBootstrapDecideResponseSchema = z.strictObject({
  type: z.literal("installation.bootstrap.decide.response"),
  payload: BootstrapResultSchema,
});

export const CoordinatorBootstrapReconcileAutomaticResponseSchema = z.strictObject({
  type: z.literal("installation.bootstrap.reconcile_automatic.response"),
  payload: BootstrapResultSchema,
});

export type CoordinatorBootstrapInbound = z.infer<
  | typeof CoordinatorBootstrapListRequestSchema
  | typeof CoordinatorBootstrapPrepareRequestSchema
  | typeof CoordinatorBootstrapDecideRequestSchema
  | typeof CoordinatorBootstrapReconcileAutomaticRequestSchema
>;
export type CoordinatorBootstrapOutbound = z.infer<
  | typeof CoordinatorBootstrapListResponseSchema
  | typeof CoordinatorBootstrapPrepareResponseSchema
  | typeof CoordinatorBootstrapDecideResponseSchema
  | typeof CoordinatorBootstrapReconcileAutomaticResponseSchema
>;

// Separate recovery records leave historical bootstrap requests readable by old hosts.
export const BootstrapAuditedProcessSchema = z.strictObject({
  identity: BootstrapProcessIdentitySchema,
  auditToken: z.array(z.number().int().min(0).max(0xffffffff)).length(8),
});
export const BootstrapPreclaimRecoveryPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("bootstrap-preclaim-recovery"),
  original: CoordinatorBootstrapRequestSchema,
  canceled: CoordinatorBootstrapRequestSchema,
  ownerCancellation: CoordinatorBootstrapRequestSchema.optional(),
  originalApproval: FileIdentitySchema.optional(),
  executor: BootstrapAuditedProcessSchema,
  hostProcess: BootstrapProcessIdentitySchema,
  coordinatorProcess: BootstrapProcessIdentitySchema,
  retainedObservation: FileIdentitySchema.optional(),
  setup: FileIdentitySchema,
  ownerLauncher: FileIdentitySchema,
  runner: ReleaseIdentitySchema,
  executorEntrypoint: FileIdentitySchema,
  selectedLauncher: FileIdentitySchema,
  selectedConfiguration: FileIdentitySchema,
  executionLock: z.strictObject({
    path: AbsolutePathSchema,
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
  }),
  signalPolicy: z.strictObject({
    terminate: z.literal("SIGTERM"),
    escalation: z.enum(["none", "SIGKILL"]),
    graceSeconds: z.number().int().min(1).max(60),
  }),
});
export type BootstrapPreclaimRecoveryPlan = z.infer<typeof BootstrapPreclaimRecoveryPlanSchema>;
// Claimed recovery has different authority from legacy preclaim cancellation.
// Its distinct discriminator prevents old review controls accepting hidden scope.
export const BootstrapClaimedRecoveryPlanSchema = BootstrapPreclaimRecoveryPlanSchema.omit({
  canceled: true,
  ownerCancellation: true,
  originalApproval: true,
}).extend({
  operation: z.literal("bootstrap-claimed-recovery"),
  dispatchApprovalRevision: z.string().uuid(),
  retainedObservation: FileIdentitySchema,
});
export type BootstrapClaimedRecoveryPlan = z.infer<typeof BootstrapClaimedRecoveryPlanSchema>;

export const BootstrapPreclaimRecoveryRequestSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  requestedBy: z.literal("host-agent"),
  reason: z.string().min(1).max(4000),
  createdAt: z.string().datetime(),
  plan: BootstrapPreclaimRecoveryPlanSchema,
  planSha256: DigestSchema,
  status: z.enum(["pending", "approved", "canceled"]),
  decisionAt: z.string().datetime().optional(),
  execution: z
    .strictObject({
      generation: z.string().uuid(),
      stage: z.enum([
        "claimed",
        "cancellation_fenced",
        "effect_pending",
        "verifying",
        "succeeded",
        "recovery_required",
        "aborted_before_effects",
      ]),
      updatedAt: z.string().datetime(),
    })
    .optional(),
});
export const BootstrapClaimedRecoveryRequestSchema = BootstrapPreclaimRecoveryRequestSchema.extend({
  plan: BootstrapClaimedRecoveryPlanSchema,
  execution: z
    .strictObject({
      generation: z.string().uuid(),
      stage: z.enum([
        "claimed",
        "claim_fenced",
        "effect_pending",
        "verifying",
        "succeeded",
        "recovery_required",
        "aborted_before_effects",
      ]),
      updatedAt: z.string().datetime(),
    })
    .optional(),
});
export type BootstrapClaimedRecoveryRequest = z.infer<typeof BootstrapClaimedRecoveryRequestSchema>;

export type BootstrapPreclaimRecoveryRequest = z.infer<
  typeof BootstrapPreclaimRecoveryRequestSchema
>;

// Read-only receipt observations never become part of the persisted approval.
const PreclaimDispatchReferenceSchema = z.strictObject({
  approvedRevision: z.string().uuid(),
  attemptId: z.string().uuid(),
});
export const BootstrapPreclaimDispatchObservationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("no_receipt") }),
  z.strictObject({ state: z.literal("unavailable") }),
  PreclaimDispatchReferenceSchema.extend({ state: z.literal("attempt_retained") }),
  PreclaimDispatchReferenceSchema.extend({
    state: z.literal("birth_retained"),
    executor: BootstrapProcessIdentitySchema,
  }),
]);
export type BootstrapPreclaimDispatchObservation = z.infer<
  typeof BootstrapPreclaimDispatchObservationSchema
>;
export const BootstrapPreclaimRecoveryRequestViewSchema =
  BootstrapPreclaimRecoveryRequestSchema.extend({
    dispatch: BootstrapPreclaimDispatchObservationSchema.optional(),
  });
export type BootstrapPreclaimRecoveryRequestView = z.infer<
  typeof BootstrapPreclaimRecoveryRequestViewSchema
>;

export const BootstrapPreclaimRecoveryPreparationSchema = z.strictObject({
  id: z.string().uuid(),
  reason: z.string().min(1).max(4000),
  plan: BootstrapPreclaimRecoveryPlanSchema,
});
export type BootstrapPreclaimRecoveryPreparation = z.infer<
  typeof BootstrapPreclaimRecoveryPreparationSchema
>;
export const BootstrapPreclaimObservationSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().uuid(),
});
export type BootstrapPreclaimObservation = z.infer<typeof BootstrapPreclaimObservationSchema>;

export const BootstrapPreclaimRecoveryListRequestSchema = z.strictObject({
  type: z.literal("installation.bootstrap_recovery.list_requests.request"),
  requestId: z.string(),
  recoveryBootPlan: z.literal(true).optional(),
  ownerCanceledOriginal: z.literal(true).optional(),
  reconcile: BootstrapPreclaimObservationSchema.optional(),
});
export const BootstrapPreclaimRecoveryPrepareRequestSchema = z.strictObject({
  type: z.literal("installation.bootstrap_recovery.prepare.request"),
  requestId: z.string(),
  recoveryBootPlan: z.literal(true).optional(),
  ownerCanceledOriginal: z.literal(true).optional(),
  input: BootstrapPreclaimRecoveryPreparationSchema,
});
export const BootstrapPreclaimRecoveryDecideRequestSchema = z.strictObject({
  type: z.literal("installation.bootstrap_recovery.decide.request"),
  requestId: z.string(),
  recoveryBootPlan: z.literal(true).optional(),
  ownerCanceledOriginal: z.literal(true).optional(),
  input: CoordinatorBootstrapDecisionSchema,
  preclaimRecovery: z.literal(true).optional(),
  ownerPassword: z.string().min(1).max(1024),
});
const PreclaimRecoveryResultSchema = z.strictObject({
  requestId: z.string(),
  requests: z.array(BootstrapPreclaimRecoveryRequestViewSchema).nullable(),
  error: z.string().nullable(),
});
export const BootstrapPreclaimRecoveryListResponseSchema = z.strictObject({
  type: z.literal("installation.bootstrap_recovery.list_requests.response"),
  payload: PreclaimRecoveryResultSchema,
});
export const BootstrapPreclaimRecoveryPrepareResponseSchema = z.strictObject({
  type: z.literal("installation.bootstrap_recovery.prepare.response"),
  payload: PreclaimRecoveryResultSchema,
});
export const BootstrapPreclaimRecoveryDecideResponseSchema = z.strictObject({
  type: z.literal("installation.bootstrap_recovery.decide.response"),
  payload: PreclaimRecoveryResultSchema,
});
export type BootstrapPreclaimRecoveryInbound = z.infer<
  | typeof BootstrapPreclaimRecoveryListRequestSchema
  | typeof BootstrapPreclaimRecoveryPrepareRequestSchema
  | typeof BootstrapPreclaimRecoveryDecideRequestSchema
>;
export type BootstrapPreclaimRecoveryOutbound = z.infer<
  | typeof BootstrapPreclaimRecoveryListResponseSchema
  | typeof BootstrapPreclaimRecoveryPrepareResponseSchema
  | typeof BootstrapPreclaimRecoveryDecideResponseSchema
>;

export const BootstrapClaimedRecoveryRequestViewSchema =
  BootstrapClaimedRecoveryRequestSchema.extend({
    dispatch: BootstrapPreclaimDispatchObservationSchema.optional(),
  });
export type BootstrapClaimedRecoveryRequestView = z.infer<
  typeof BootstrapClaimedRecoveryRequestViewSchema
>;
export const BootstrapClaimedRecoveryPreparationSchema = z.strictObject({
  id: z.string().uuid(),
  reason: z.string().min(1).max(4000),
  plan: BootstrapClaimedRecoveryPlanSchema,
});
export type BootstrapClaimedRecoveryPreparation = z.infer<
  typeof BootstrapClaimedRecoveryPreparationSchema
>;
export const BootstrapClaimedObservationSchema = BootstrapPreclaimObservationSchema;
export type BootstrapClaimedObservation = z.infer<typeof BootstrapClaimedObservationSchema>;

/** Independently provisioned repair transport, separate from Host capabilities. */
export const BootstrapClaimedRepairStatusSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.string().uuid(),
  available: z.boolean(),
  requests: z.number().int().nonnegative(),
  provisioning: z
    .strictObject({
      admissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
      artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
      originalId: z.string().uuid(),
    })
    .optional(),
});

export const BootstrapClaimedRepairProvisionRequestSchema = z.strictObject({
  type: z.literal("installation.claimed_repair.provision.request"),
  admissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  ownerPassword: z.string().min(1).max(4096),
});

export const BootstrapClaimedRecoveryListRequestSchema = z.strictObject({
  type: z.literal("installation.claimed_recovery.list_requests.request"),
  requestId: z.string(),
  recoveryBootPlan: z.literal(true).optional(),
  reconcile: BootstrapClaimedObservationSchema.optional(),
});
export const BootstrapClaimedRecoveryPrepareRequestSchema = z.strictObject({
  type: z.literal("installation.claimed_recovery.prepare.request"),
  requestId: z.string(),
  recoveryBootPlan: z.literal(true).optional(),
  input: BootstrapClaimedRecoveryPreparationSchema,
});
export const BootstrapClaimedRecoveryDecideRequestSchema = z.strictObject({
  type: z.literal("installation.claimed_recovery.decide.request"),
  requestId: z.string(),
  recoveryBootPlan: z.literal(true).optional(),
  input: CoordinatorBootstrapDecisionSchema,
  claimedRecovery: z.literal(true).optional(),
  ownerPassword: z.string().min(1).max(1024),
});
const ClaimedRecoveryResultSchema = z.strictObject({
  requestId: z.string(),
  requests: z.array(BootstrapClaimedRecoveryRequestViewSchema).nullable(),
  error: z.string().nullable(),
});
export const BootstrapClaimedRecoveryListResponseSchema = z.strictObject({
  type: z.literal("installation.claimed_recovery.list_requests.response"),
  payload: ClaimedRecoveryResultSchema,
});
export const BootstrapClaimedRecoveryPrepareResponseSchema = z.strictObject({
  type: z.literal("installation.claimed_recovery.prepare.response"),
  payload: ClaimedRecoveryResultSchema,
});
export const BootstrapClaimedRecoveryDecideResponseSchema = z.strictObject({
  type: z.literal("installation.claimed_recovery.decide.response"),
  payload: ClaimedRecoveryResultSchema,
});
export type BootstrapClaimedRecoveryInbound = z.infer<
  | typeof BootstrapClaimedRecoveryListRequestSchema
  | typeof BootstrapClaimedRecoveryPrepareRequestSchema
  | typeof BootstrapClaimedRecoveryDecideRequestSchema
>;
export type BootstrapClaimedRecoveryOutbound = z.infer<
  | typeof BootstrapClaimedRecoveryListResponseSchema
  | typeof BootstrapClaimedRecoveryPrepareResponseSchema
  | typeof BootstrapClaimedRecoveryDecideResponseSchema
>;
