import { z } from "zod";
import type { JsonValue } from "./agent-types.js";

// Values already crossed JSON transport; avoid recursive AOT JSON code generation.
const JsonWireValueSchema = z.unknown() as z.ZodType<JsonValue>;

export const AgentTaskItemSchema = z.object({
  text: z.string(),
  completed: z.boolean(),
  id: z.string().optional(),
  status: z.enum(["pending", "in_progress", "blocked", "completed"]).optional(),
  activeForm: z.string().optional(),
  description: z.string().optional(),
  owner: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
  metadata: z.record(z.string(), JsonWireValueSchema).optional(),
  source: z.enum(["vorteo", "provider"]).optional(),
});

const TaskFields = {
  text: z.string().min(1).max(1000),
  description: z.string().max(20000).optional(),
  activeForm: z.string().max(1000).optional(),
  owner: z.string().max(200).optional(),
  blockedBy: z.array(z.string().min(1)).max(500).optional(),
  metadata: z.record(z.string(), JsonWireValueSchema).optional(),
};

export const ChecklistMutationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      id: z.string().min(1).max(200).optional(),
      ...TaskFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("update"),
      expectedTask: AgentTaskItemSchema.optional(),
      id: z.string().min(1),
      ...TaskFields,
      text: TaskFields.text.optional(),
      status: z.enum(["pending", "in_progress", "blocked", "completed"]).optional(),
      addBlocks: z.array(z.string().min(1)).max(500).optional(),
      addBlockedBy: z.array(z.string().min(1)).max(500).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      id: z.string().min(1),
      expectedTask: AgentTaskItemSchema.optional(),
    })
    .strict(),
  z.object({ operation: z.literal("reorder"), ids: z.array(z.string()).max(500) }).strict(),
]);

export type ChecklistMutation = z.infer<typeof ChecklistMutationSchema>;

export const ChecklistGetRequestSchema = z.object({
  type: z.literal("agent.checklist.get.request"),
  agentId: z.string(),
  requestId: z.string(),
});
export const ChecklistMutateRequestSchema = z.object({
  type: z.literal("agent.checklist.mutate.request"),
  agentId: z.string(),
  requestId: z.string(),
  mutation: ChecklistMutationSchema,
});
const ChecklistResultSchema = z.object({
  agentId: z.string(),
  requestId: z.string(),
  tasks: z.array(AgentTaskItemSchema).nullable(),
  error: z.string().nullable(),
});
export const ChecklistGetResponseSchema = z.object({
  type: z.literal("agent.checklist.get.response"),
  payload: ChecklistResultSchema,
});
export const ChecklistMutateResponseSchema = z.object({
  type: z.literal("agent.checklist.mutate.response"),
  payload: ChecklistResultSchema,
});
