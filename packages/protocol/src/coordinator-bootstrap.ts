import { NativeHelperConfigurationSchema } from "./native-helper-maintenance.js";
import { FactoryRuntimeAdoptionConfigurationSchema } from "./execution-installation.js";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const AbsolutePathSchema = z.string().startsWith("/").min(2).max(4096);
const FileIdentitySchema = z.strictObject({ path: AbsolutePathSchema, sha256: DigestSchema });
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
  automaticRecovery: z.enum(["restore-previous", "restore-compatible"]).optional(),
  compatibleRecovery: ReleaseIdentitySchema.optional(),
  nativeHelperConfiguration: NativeHelperConfigurationSchema.nullable().optional(),
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
});
export const CoordinatorBootstrapPrepareRequestSchema = z.strictObject({
  type: z.literal("installation.bootstrap.prepare.request"),
  requestId: z.string(),
  factoryRuntimeAdoption: z.literal(true).optional(),
  compatibleRecovery: z.literal(true).optional(),
  input: CoordinatorBootstrapPreparationSchema,
});
export const CoordinatorBootstrapDecideRequestSchema = z.strictObject({
  type: z.literal("installation.bootstrap.decide.request"),
  requestId: z.string(),
  factoryRuntimeAdoption: z.literal(true).optional(),
  compatibleRecovery: z.literal(true).optional(),
  input: CoordinatorBootstrapDecisionSchema,
  // Transient owner proof. Never persist it with the request or decision.
  ownerPassword: z.string().min(1).max(1024),
});
const BootstrapResultSchema = z.strictObject({
  requestId: z.string(),
  requests: z.array(CoordinatorBootstrapRequestSchema).nullable(),
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

export type CoordinatorBootstrapInbound = z.infer<
  | typeof CoordinatorBootstrapListRequestSchema
  | typeof CoordinatorBootstrapPrepareRequestSchema
  | typeof CoordinatorBootstrapDecideRequestSchema
>;
export type CoordinatorBootstrapOutbound = z.infer<
  | typeof CoordinatorBootstrapListResponseSchema
  | typeof CoordinatorBootstrapPrepareResponseSchema
  | typeof CoordinatorBootstrapDecideResponseSchema
>;
