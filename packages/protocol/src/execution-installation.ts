import { z } from "zod";
import { StandingInterruptionSchema } from "./maintenance-interruption.js";
import {
  ProviderPreferencesSchema,
  SharedProviderPreferencesSchema,
} from "./provider-preferences.js";

export const ExecutionEnvironmentKindSchema = z.enum(["container", "host"]);
export type ExecutionEnvironmentKind = z.infer<typeof ExecutionEnvironmentKindSchema>;

export const FactoryRuntimeAdoptionConfigurationSchema = z.strictObject({
  node: z.string().startsWith("/"),
  script: z.string().startsWith("/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const InstallationEnvironmentSchema = z.strictObject({
  kind: ExecutionEnvironmentKindSchema,
  serverId: z.string().min(1),
  endpoint: z.string().min(1),
  useTls: z.boolean(),
});
export type InstallationEnvironment = z.infer<typeof InstallationEnvironmentSchema>;

// This descriptor comes from the installed UI origin, never from an agent daemon.
// Credentials are exchanged only after owner authentication, not in the HTML.
export const ExecutionInstallationSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.string().uuid(),
  profileSharing: z.boolean().optional(),
  idleRestarts: z.boolean().optional(),
  gracefulRestarts: z.boolean().optional(),
  origin: z.url(),
  environments: z.array(InstallationEnvironmentSchema).length(2),
});
export type ExecutionInstallation = z.infer<typeof ExecutionInstallationSchema>;

export const InstallationConnectionSchema = InstallationEnvironmentSchema.extend({
  password: z.string().min(1),
});
export const InstallationUnlockSchema = z.strictObject({
  installationId: z.string().uuid(),
  connections: z.array(InstallationConnectionSchema).length(2),
});
export type InstallationUnlock = z.infer<typeof InstallationUnlockSchema>;

export const RestartTargetSchema = z.enum(["host", "container-daemon"]);
/** Send only to coordinators advertising workerLaunch.available.
 * Hints are never retained authority or an executable launch specification. */
export const WorkerLaunchCauseHintSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("predecessor"), generation: z.string().uuid() }),
  z.strictObject({ kind: z.literal("startup"), registrationGeneration: z.string().uuid() }),
]);
export const WorkerLaunchCauseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("predecessor"),
    generation: z.string().uuid(),
    settlementSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("startup"),
    registrationGeneration: z.string().uuid(),
    registrationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export const WorkerLaunchRequestSchema = z.strictObject({
  profileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  supervisorPid: z.number().int().positive(),
  cause: WorkerLaunchCauseHintSchema,
});
export type WorkerLaunchRequest = z.infer<typeof WorkerLaunchRequestSchema>;

export const WorkerLaunchNativeIdentitySchema = z.strictObject({
  pid: z.number().int().positive(),
  parentPid: z.number().int().nonnegative(),
  uid: z.number().int().nonnegative(),
  bootId: z.string().min(1).max(200),
  // Linux start ticks. Mac birth timestamps require a different native verifier.
  startTicks: z.string().regex(/^[0-9]+$/),
});
export const WorkerLaunchBindingSchema = z.strictObject({
  requestId: z.string().uuid(),
  approvalRevision: z.string().uuid(),
  generation: z.string().uuid(),
  grantId: z.string().uuid(),
  grantRevision: z.string().uuid(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  profileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  targetIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  publicationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cause: WorkerLaunchCauseSchema,
  supervisor: WorkerLaunchNativeIdentitySchema,
});
export const WorkerLaunchVerifiedCauseSchema = WorkerLaunchBindingSchema.pick({
  supervisor: true,
  cause: true,
  profileSha256: true,
  targetIdentitySha256: true,
});
export type WorkerLaunchVerifiedCause = z.infer<typeof WorkerLaunchVerifiedCauseSchema>;
const workerLaunchRecord = {
  binding: WorkerLaunchBindingSchema,
  reservedAt: z.string().datetime(),
};
/** Controller-owned suboperation, never accepted as a requester payload. */
export const WorkerLaunchSchema = z.discriminatedUnion("phase", [
  z.strictObject({ ...workerLaunchRecord, phase: z.literal("reserved") }),
  z.strictObject({
    ...workerLaunchRecord,
    phase: z.literal("consumed"),
    consumedAt: z.string().datetime(),
  }),
  z.strictObject({
    ...workerLaunchRecord,
    phase: z.literal("uncertain"),
    consumedAt: z.string().datetime(),
  }),
  z.strictObject({
    ...workerLaunchRecord,
    phase: z.literal("settled"),
    consumedAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    observationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export type WorkerLaunch = z.infer<typeof WorkerLaunchSchema>;
export type WorkerLaunchBinding = z.infer<typeof WorkerLaunchBindingSchema>;

export const RestartRequestSchema = z.strictObject({
  // COMPAT(requireOwnerApproval): optional in v311; project out for clients until 2027-04-11.
  requireOwnerApproval: z.boolean().optional(),
  workerLaunchRequest: WorkerLaunchRequestSchema.optional(),
  factoryRuntimeRecoveryOf: z.string().uuid().optional(),
  // COMPAT(factoryRuntimeAdoption): optional in v285; remove legacy projection after 2027-04-10.
  factoryRuntimePlanSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  // COMPAT(supervisorMaintenance): optional exact-plan binding; old approvals cannot authorize it.
  supervisorPlanSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  target: RestartTargetSchema,
  reason: z.string().trim().min(1).max(2000),
  requester: z.string().trim().min(1).max(200).optional(),
});
export type RestartRequest = z.infer<typeof RestartRequestSchema>;

export const RestartSummarySchema = z.object({
  serviceMaintenance: z
    .object({
      requested: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative(),
      unverified: z.number().int().nonnegative(),
      attention: z.number().int().nonnegative(),
    })
    .optional(),
  // COMPAT(previewMonitorMaintenance): older clients ignore distinct monitor counts.
  previewMonitor: z
    .object({
      requested: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      recovery: z.number().int().nonnegative(),
    })
    .optional(),
  // COMPAT(nativeHelperMaintenance): older clients ignore helper-only counts.
  nativeHelper: z
    .object({
      requested: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      recovery: z.number().int().nonnegative(),
    })
    .optional(),
  requested: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
});
export type RestartSummary = z.infer<typeof RestartSummarySchema>;

export const RestartImpactSchema = z.object({
  target: RestartTargetSchema,
  checkedAt: z.string().datetime(),
  agents: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
  pendingStarts: z.number().int().nonnegative(),
  idleRestartSupported: z.boolean(),
  gracefulRestartSupported: z.boolean().optional(),
  restartDrainObservationSupported: z.boolean().optional(),
  restartDrainId: z.string().uuid().nullable().optional(),
  workerInstanceId: z.string().uuid().optional(),
  workerPid: z.number().int().positive().optional(),
  heldIdleRestartSupported: z.boolean().optional(),
  error: z.string().nullable(),
});
export type RestartImpact = z.infer<typeof RestartImpactSchema>;

export const SourceUpdateSchema = z.strictObject({
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .positive()
    .max(128 * 1024 * 1024),
});
export type SourceUpdate = z.infer<typeof SourceUpdateSchema>;

// COMPAT(sourceBatches): opt-in metadata; old strict clients receive legacy job fields only.
export const SourceContributionSchema = z.strictObject({
  requireOwnerApproval: z.boolean().optional(),
  id: z.string().uuid(),
  update: SourceUpdateSchema,
  reason: z.string(),
  requester: z.string().optional(),
  requestedBy: z.enum(["owner", "host-agent", "container-agent"]),
  createdAt: z.string().datetime(),
  replaces: z.string().uuid().optional(),
  supersededBy: z.string().uuid().optional(),
  status: z.enum(["queued", "included", "conflict", "invalid", "superseded"]),
  detail: z.string(),
});
export type SourceContribution = z.infer<typeof SourceContributionSchema>;
export const SourceBatchSchema = z.strictObject({
  webCommit: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  status: z.enum(["preparing", "waiting", "ready", "conflict"]),
  contributions: z.array(SourceContributionSchema),
});
export type SourceBatch = z.infer<typeof SourceBatchSchema>;

// COMPAT(hostAutomaticRestarts): v224; returned only to clients opting into this receipt.
export const AutomaticRestartApprovalSchema = z.strictObject({
  policyActivatedAt: z.string().datetime(),
  requestRevision: z.string().uuid(),
  sourceSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

// COMPAT(devSourceRepair): retained privately; legacy replies omit repair captures.
export const DevRepairCaptureSchema = z.strictObject({
  hostReleaseDirectory: z.string().startsWith("/"),
  baseCommit: SourceUpdateSchema.shape.baseCommit,
  sourceCommit: SourceUpdateSchema.shape.sourceCommit,
  integrationRef: z.string().startsWith("refs/heads/"),
  contributionCommits: z.array(SourceUpdateSchema.shape.sourceCommit).max(100),
});
export type DevRepairCapture = z.infer<typeof DevRepairCaptureSchema>;
export const DevRepairAttemptSchema = z.strictObject({
  id: z.string().uuid(),
  capturedRevision: z.string().uuid(),
  createdAt: z.string().datetime(),
  capture: DevRepairCaptureSchema,
  status: z.enum(["preparing", "prepared", "failed"]),
  detail: z.string(),
});

// Protected standing decisions are exposed only through negotiated maintenance views.
export const StandingRestartDecisionSchema = z.strictObject({
  activationStep: z
    .strictObject({
      stepId: z.string().uuid(),
      generation: z.string().uuid(),
      candidateArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  grantId: z.string().uuid(),
  grantRevision: z.string().uuid(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  targetIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  authoritySha256: z.string().regex(/^[a-f0-9]{64}$/),
  policyActivatedAt: z.string().datetime(),
  requestRevision: z.string().uuid(),
});
export type StandingRestartDecision = z.infer<typeof StandingRestartDecisionSchema>;
export const StandingRestartHoldSchema = z.strictObject({
  generation: z.string().uuid(),
  grantRevision: z.string().uuid(),
  decisionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reservedAt: z.string().datetime(),
  observedAt: z.string().datetime().optional(),
  /** Only the reserved initial migration may use an acknowledged legacy drain.
   * It remains bound to one independently inspected daemon lifetime. */
  initialDaemonInstanceSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  acknowledgedAt: z.string().datetime().optional(),
  releaseRequestedAt: z.string().datetime().optional(),
});

export const RestartJobSchema = RestartRequestSchema.extend({
  workerLaunch: WorkerLaunchSchema.optional(),
  standingDecision: StandingRestartDecisionSchema.optional(),
  standingHold: StandingRestartHoldSchema.optional(),
  standingInterruption: StandingInterruptionSchema.optional(),
  interruptionChecks: z
    .strictObject({
      attempts: z.number().int().min(0).max(3),
      checkedAt: z.string().datetime(),
      nextCheckAt: z.string().datetime(),
    })
    .optional(),
  standingManualApprovals: z
    .array(
      z.strictObject({
        previousRevision: z.string().uuid(),
        revision: z.string().uuid(),
        approvedAt: z.string().datetime(),
        decision: z.enum(["approve", "finish-current-turns"]),
      }),
    )
    .max(16)
    .optional(),
  updatePreparation: z.enum(["preparing", "prepared"]).optional(),
  // Protected ledger metadata; legacy HTTP receipts omit it.
  supervisorRecoveredBy: z.string().uuid().optional(),
  // Protected ledger metadata; projected out of legacy HTTP receipts.
  automaticAuthority: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  automaticDispatchAfter: z.string().datetime().optional(),
  devRepairs: z.array(DevRepairAttemptSchema).max(100).optional(),
  factoryRuntimeRecoveryRequired: z.boolean().optional(),
  factoryRuntimeRecoveredBy: z.string().uuid().optional(),
  automaticApproval: AutomaticRestartApprovalSchema.optional(),
  update: SourceUpdateSchema.optional(),
  sourceBatch: SourceBatchSchema.optional(),
  id: z.string().uuid(),
  revision: z.string().uuid(),
  requestedBy: z.enum(["owner", "host-agent", "container-agent"]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  status: z.enum(["pending", "approved", "running", "succeeded", "failed", "rejected"]),
  detail: z.string(),
  whenIdle: z.boolean().optional(),
  finishCurrentTurns: z.boolean().optional(),
  holdReleased: z.boolean().optional(),
  approvedAt: z.string().datetime().optional(),
  impact: RestartImpactSchema.optional(),
});
export type RestartJob = z.infer<typeof RestartJobSchema>;

export const RestartDecisionSchema = z.strictObject({
  factoryRuntimePlanSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  supervisorPlanSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  updateSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  revision: z.string().uuid(),
  decision: z.enum([
    "approve",
    "reject",
    "approve-when-idle",
    "finish-current-turns",
    "request-again",
    "cancel",
  ]),
});

export type RestartDecision = z.infer<typeof RestartDecisionSchema>["decision"];

export const EXECUTION_ENVIRONMENT_LABELS: Record<ExecutionEnvironmentKind, string> = {
  container: "Dev container",
  host: "Host: full account access",
};

export function validateExecutionInstallation(input: unknown): ExecutionInstallation {
  const installation = ExecutionInstallationSchema.parse(input);
  const origin = new URL(installation.origin);
  if (origin.origin !== installation.origin)
    throw new Error("Installation origin must be an origin");
  const isLoopback = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLoopback)) {
    throw new Error("Remote installation connections require HTTPS");
  }
  const kinds = new Set(installation.environments.map((environment) => environment.kind));
  const ids = new Set(installation.environments.map((environment) => environment.serverId));
  const endpoints = new Set(installation.environments.map((environment) => environment.endpoint));
  if (kinds.size !== 2 || ids.size !== 2 || endpoints.size !== 2) {
    throw new Error("Installation requires distinct host and container identities and endpoints");
  }
  for (const environment of installation.environments) {
    const endpoint = new URL(`https://${environment.endpoint}`);
    if (endpoint.host !== environment.endpoint || endpoint.username || endpoint.password) {
      throw new Error("Environment endpoint must contain only a host and optional port");
    }
    const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
    if (!environment.useTls && !local)
      throw new Error("Remote environment connections require TLS");
  }
  return installation;
}

export const ProfileSharingStatusSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().positive(),
  sources: z.record(
    z.string(),
    z.object({
      error: z.string().nullable(),
      conflicts: z.array(z.string()),
      conflictValues: z.array(
        z.object({
          field: z.string(),
          sharedValue: z.string(),
          environmentValue: z.string(),
        }),
      ),
    }),
  ),
});
export type ProfileSharingStatus = z.infer<typeof ProfileSharingStatusSchema>;

export const InstallationProfilesSnapshotSchema = ProfileSharingStatusSchema.extend({
  workerAccounts: z.boolean().optional(),
  uncappedManagedWorkers: z.boolean().optional(),
  providers: z.record(z.string(), ProviderPreferencesSchema),
});
export type InstallationProfilesSnapshot = z.infer<typeof InstallationProfilesSnapshotSchema>;

export const InstallationProfilesPatchSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  providers: z.record(z.string(), ProviderPreferencesSchema),
});
export type InstallationProfilesPatch = z.infer<typeof InstallationProfilesPatchSchema>;

export const InstallationProfilesAdmissionSchema = z.strictObject({
  installationId: z.string().uuid(),
  environment: ExecutionEnvironmentKindSchema,
  serverId: z.string().min(1),
  preferences: SharedProviderPreferencesSchema,
});
export type InstallationProfilesAdmission = z.infer<typeof InstallationProfilesAdmissionSchema>;

export const MaintenanceServiceSchema = z.enum([
  "host",
  "container-daemon",
  "coordinator",
  "supervisor",
]);
export type MaintenanceService = z.infer<typeof MaintenanceServiceSchema>;
export const MaintenanceServicePermissionsSchema = z.object({
  host: z.string().datetime().nullable(),
  "container-daemon": z.string().datetime().nullable(),
  coordinator: z.string().datetime().nullable(),
  supervisor: z.string().datetime().nullable(),
});

// Owner-authenticated HTTP preference; old coordinators return 404 without changing policy.
export const DaemonAutomationPreferenceSchema = z.strictObject({
  revision: z.string().uuid().nullable(),
  enabled: z.boolean(),
  enabledAfter: z.string().datetime().nullable(),
  legacyHostOnly: z.boolean(),
  services: MaintenanceServicePermissionsSchema.optional(),
});
export type DaemonAutomationPreference = z.infer<typeof DaemonAutomationPreferenceSchema>;
export const DaemonAutomationChangeSchema = z.strictObject({
  expectedRevision: z.string().uuid().nullable(),
  enabled: z.boolean(),
  service: MaintenanceServiceSchema.optional(),
});

// COMPAT(maintenanceStatus): separate versioned route; older coordinators return 404.
export const InstallationMaintenanceStatusSchema = z.object({
  version: z.literal(1),
  checkedAt: z.string().datetime(),
  preference: DaemonAutomationPreferenceSchema,
  services: z
    .array(
      z.object({
        service: MaintenanceServiceSchema,
        readiness: z.enum(["ready", "blocked"]),
        reason: z.string(),
      }),
    )
    .optional(),
  paths: z.array(
    z.object({
      requester: z.enum(["host-agent", "container-agent"]),
      target: RestartTargetSchema,
      operation: z.enum(["restart", "source-update"]),
      authorization: z.enum(["automatic", "manual"]),
      readiness: z.enum(["ready", "blocked"]),
      reason: z.string(),
      selectedSource: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .nullable(),
    }),
  ),
});
export type InstallationMaintenanceStatus = z.infer<typeof InstallationMaintenanceStatusSchema>;
