import { z } from "zod";

export const AgentGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export const AgentGoalSchema = z.object({
  threadId: z.string(),
  objective: z.string(),
  status: AgentGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().nonnegative(),
  timeUsedSeconds: z.number().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// Null is a confirmed absence. Loading/error retain the last observation without
// claiming that a cached goal still describes the provider's current state.
export const AgentGoalStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("loading"), goal: AgentGoalSchema.nullable() }),
  z.object({
    status: z.literal("ready"),
    goal: AgentGoalSchema.nullable(),
    observedAt: z.string(),
    // Changes with goal mutations, independently of native usage timestamps.
    editRevision: z.string().optional(),
    // Native continuation is paused while the durable queue drains, then resumes.
    queueContinuationHeld: z.boolean().optional(),
    restartContinuationHeld: z.boolean().optional(),
  }),
  z.object({
    status: z.literal("error"),
    goal: AgentGoalSchema.nullable(),
    message: z.string(),
  }),
]);

export const AgentGoalSetInputSchema = z.object({
  objective: z.string().min(1).max(4000).optional(),
  status: AgentGoalStatusSchema.optional(),
  // Omission preserves the budget; null explicitly removes it.
  tokenBudget: z.number().int().positive().nullable().optional(),
});

export type AgentGoal = z.infer<typeof AgentGoalSchema>;
export type AgentGoalState = z.infer<typeof AgentGoalStateSchema>;
export type AgentGoalSetInput = z.infer<typeof AgentGoalSetInputSchema>;

export const AgentGoalGetRequestSchema = z.object({
  type: z.literal("agent.goal.get.request"),
  agentId: z.string(),
  requestId: z.string(),
});
export const AgentGoalSetRequestSchema = z.object({
  type: z.literal("agent.goal.set.request"),
  agentId: z.string(),
  input: AgentGoalSetInputSchema,
  requestId: z.string(),
});
export const AgentGoalClearRequestSchema = z.object({
  type: z.literal("agent.goal.clear.request"),
  agentId: z.string(),
  requestId: z.string(),
});

const GoalResultSchema = z.object({
  agentId: z.string(),
  requestId: z.string(),
  state: AgentGoalStateSchema.nullable(),
  error: z.string().nullable(),
});
export const AgentGoalGetResponseSchema = z.object({
  type: z.literal("agent.goal.get.response"),
  payload: GoalResultSchema,
});
export const AgentGoalSetResponseSchema = z.object({
  type: z.literal("agent.goal.set.response"),
  payload: GoalResultSchema,
});
export const AgentGoalClearResponseSchema = z.object({
  type: z.literal("agent.goal.clear.response"),
  payload: GoalResultSchema,
});
