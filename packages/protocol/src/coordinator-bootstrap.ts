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
});
export type CoordinatorBootstrapPlan = z.infer<typeof CoordinatorBootstrapPlanSchema>;

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
