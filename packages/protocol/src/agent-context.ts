import { z } from "zod";

/**
 * What a context breakdown row is. `used` occupies the window, `free` is the remaining window,
 * `buffer` is reserved for compaction and `deferred` is listed for awareness but sits outside the
 * window. A string on the wire so a newer daemon can add kinds; clients treat unknown kinds as
 * `used`.
 */
export const AgentContextCategoryKindSchema = z.string();

export const AgentContextCategorySchema = z.object({
  /** Provider display name, such as "Messages" or "MCP tools (deferred)". */
  name: z.string(),
  tokens: z.number(),
  kind: AgentContextCategoryKindSchema,
});

export const AgentContextItemSchema = z.object({
  name: z.string(),
  /** Secondary label, such as an MCP server or a memory file's source. */
  detail: z.string().optional(),
  tokens: z.number(),
});

export const AgentContextGroupSchema = z.object({
  /** Stable group id: `mcp_tools`, `memory_files`, `agents` or `skills`. */
  id: z.string(),
  items: z.array(AgentContextItemSchema),
});

/** A provider-reported breakdown of an agent's context window. */
export const AgentContextBreakdownSchema = z.object({
  model: z.string().optional(),
  totalTokens: z.number(),
  maxTokens: z.number(),
  categories: z.array(AgentContextCategorySchema),
  groups: z.array(AgentContextGroupSchema),
  overLimit: z.object({ tokensOver: z.number(), kind: z.string() }).optional(),
  observedAt: z.string(),
});

export type AgentContextCategory = z.infer<typeof AgentContextCategorySchema>;
export type AgentContextItem = z.infer<typeof AgentContextItemSchema>;
export type AgentContextGroup = z.infer<typeof AgentContextGroupSchema>;
export type AgentContextBreakdown = z.infer<typeof AgentContextBreakdownSchema>;

export const AgentContextGetBreakdownRequestSchema = z.object({
  type: z.literal("agent.context.get_breakdown.request"),
  agentId: z.string(),
  requestId: z.string(),
});

export const AgentContextGetBreakdownResponseSchema = z.object({
  type: z.literal("agent.context.get_breakdown.response"),
  payload: z.object({
    agentId: z.string(),
    requestId: z.string(),
    /** Null when the agent's provider does not report a breakdown. */
    breakdown: AgentContextBreakdownSchema.nullable(),
    error: z.string().nullable(),
  }),
});
