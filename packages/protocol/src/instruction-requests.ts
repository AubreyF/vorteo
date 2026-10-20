import { z } from "zod";

/** Agents propose shared agent instructions; the owner approves the exact text before it applies. */
export const INSTRUCTION_REQUEST_MAX_LENGTH = 64 * 1024;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const InstructionRequestEnvironmentSchema = z.enum(["host", "container"]);
export type InstructionRequestEnvironment = z.infer<typeof InstructionRequestEnvironmentSchema>;

export const InstructionRequestSchema = z.strictObject({
  id: z.string().uuid(),
  status: z.enum(["pending", "applied", "rejected", "stale", "cancelled"]),
  environment: InstructionRequestEnvironmentSchema,
  requester: z.string().min(1).max(256),
  reason: z.string().min(1).max(4096),
  baseRevision: z.number().int().nonnegative(),
  baseSha256: Sha256Schema,
  appendSystemPrompt: z.string().max(INSTRUCTION_REQUEST_MAX_LENGTH),
  proposedSha256: Sha256Schema,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  appliedRevision: z.number().int().nonnegative().nullable(),
  detail: z.string().max(1024).nullable(),
});
export type InstructionRequest = z.infer<typeof InstructionRequestSchema>;

export const InstructionRequestInputSchema = z.strictObject({
  appendSystemPrompt: z.string().max(INSTRUCTION_REQUEST_MAX_LENGTH),
  baseRevision: z.number().int().nonnegative(),
  reason: z.string().min(1).max(4096),
  requester: z.string().min(1).max(256),
});

export const InstructionRequestDecisionSchema = z.strictObject({
  id: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  // The owner approves the exact text they reviewed, not whatever the id points to later.
  proposedSha256: Sha256Schema,
});
export type InstructionRequestDecision = z.infer<typeof InstructionRequestDecisionSchema>;

export const InstructionRequestQuerySchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  appendSystemPrompt: z.string().nullable(),
  requests: z.array(InstructionRequestSchema),
});
export type InstructionRequestQuery = z.infer<typeof InstructionRequestQuerySchema>;
