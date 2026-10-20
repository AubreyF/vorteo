import { z } from "zod";

/** Agents propose shared agent instructions; the owner approves the exact text before it applies. */
export const INSTRUCTION_REQUEST_MAX_LENGTH = 64 * 1024;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
// Agent-chosen display name: one line, no control characters, so it cannot imitate the owner UI.
const RequesterSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);

export const InstructionRequestEnvironmentSchema = z.enum(["host", "container"]);
export type InstructionRequestEnvironment = z.infer<typeof InstructionRequestEnvironmentSchema>;

export const InstructionRequestSchema = z.strictObject({
  id: z.string().uuid(),
  status: z.enum(["pending", "applied", "rejected", "stale", "cancelled"]),
  environment: InstructionRequestEnvironmentSchema,
  requester: RequesterSchema,
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

// Agent-proposed text is reviewed by eye, so it may not contain characters that render as
// nothing: format characters (zero-width, bidi controls, Unicode tags), private-use characters,
// or control characters other than newline, carriage return and tab.
const HIDDEN_CHARACTERS = /[\p{Cf}\p{Co}]|(?![\n\r\t])\p{Cc}/u;
// The ACP session instruction wrapper is reserved; proposals cannot open or close it.
const RESERVED_TAG = /vorteo-session-instructions/i;

function reviewableText(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((text) => !HIDDEN_CHARACTERS.test(text), {
      message: "Text contains invisible or control characters",
    })
    .refine((text) => !RESERVED_TAG.test(text), {
      message: "Text contains a reserved instruction tag",
    });
}

export const InstructionRequestInputSchema = z.strictObject({
  appendSystemPrompt: reviewableText(INSTRUCTION_REQUEST_MAX_LENGTH),
  baseRevision: z.number().int().nonnegative(),
  reason: reviewableText(4096, 1),
  requester: RequesterSchema,
});

export const InstructionRequestDecisionSchema = z.strictObject({
  id: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  // The owner approves the exact text they reviewed, not whatever the id points to later.
  proposedSha256: Sha256Schema,
});
export type InstructionRequestDecision = z.infer<typeof InstructionRequestDecisionSchema>;

// Clients read tolerantly: a newer coordinator may add fields or statuses.
export const InstructionRequestQuerySchema = z.object({
  revision: z.number().int().nonnegative(),
  appendSystemPrompt: z.string().nullable(),
  requests: z.array(
    InstructionRequestSchema.extend({
      status: z.string(),
      requester: z.string().max(4096),
    }).strip(),
  ),
});
export type InstructionRequestQuery = z.infer<typeof InstructionRequestQuerySchema>;
