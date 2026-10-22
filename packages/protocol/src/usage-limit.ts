import { z } from "zod";

/**
 * A thread that stopped at a provider usage limit and waits for the limit to reset.
 *
 * The daemon continues the thread once the reset has passed and the account has room again,
 * unless the owner chose Don't resume, the account's switch is off or attempts ran out.
 */
export const UsageLimitHoldSchema = z.object({
  /** When the turn stopped at the limit. */
  stoppedAt: z.string(),
  /** When the rejected window resets, if the provider or usage reader reported it. */
  resetsAt: z.string().optional(),
  /** The provider's name for the rejected window, such as `five_hour` or `seven_day`. */
  window: z.string().optional(),
  /** Automatic continuations already sent for this stop. */
  attempts: z.number().int().nonnegative(),
  /** When a continuation was queued; the hold clears when a later turn completes. */
  releasedAt: z.string().optional(),
  /** The owner chose Don't resume for this thread. */
  optOut: z.boolean().optional(),
  /** Automatic resume stopped after repeated limits; the owner decides what happens next. */
  gaveUp: z.boolean().optional(),
});

export type UsageLimitHold = z.infer<typeof UsageLimitHoldSchema>;

export const AgentUsageLimitResumeActionSchema = z.enum(["resume_now", "dont_resume"]);
export type AgentUsageLimitResumeAction = z.infer<typeof AgentUsageLimitResumeActionSchema>;

// COMPAT(usageLimitResume): added 2026-10-22; gate on the usageLimitResume feature.
export const AgentUsageLimitSetResumeRequestSchema = z.object({
  type: z.literal("agent.usage_limit.set_resume.request"),
  agentId: z.string(),
  action: AgentUsageLimitResumeActionSchema,
  requestId: z.string(),
});

export const AgentUsageLimitSetResumeResponseSchema = z.object({
  type: z.literal("agent.usage_limit.set_resume.response"),
  payload: z.object({
    agentId: z.string(),
    requestId: z.string(),
    /** The hold after the change, or null when the thread was not held. */
    hold: UsageLimitHoldSchema.nullable(),
    error: z.string().nullable(),
  }),
});
