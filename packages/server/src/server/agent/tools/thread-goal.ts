import { z } from "zod";
import { AgentGoalStateSchema } from "@getpaseo/protocol/agent-goals";
import type { AgentManager } from "../agent-manager.js";
import { ThreadGoalEditSchema } from "../agent-goal.js";
import type { PaseoToolDefinition } from "./types.js";

export function createThreadGoalTools(
  manager: Pick<AgentManager, "readAgentGoal" | "editOwnGoal">,
  callerAgentId: string,
): PaseoToolDefinition[] {
  return [
    {
      name: "get_thread_goal",
      title: "Read your thread goal",
      description:
        "Read this thread's existing goal before editing it. Returns the native objective, status, usage, budget, edit revision and restart or queue hold. Does not create or replace a goal.",
      inputSchema: z.object({}).strict(),
      outputSchema: { state: AgentGoalStateSchema },
      handler: async () => ({
        content: [],
        structuredContent: { state: await manager.readAgentGoal(callerAgentId) },
      }),
    },
    {
      name: "update_thread_goal",
      title: "Update your thread goal",
      description:
        "Edit this thread's existing objective or status while preserving usage and budget. First read get_thread_goal; copy its threadId, objective, status, createdAt, updatedAt and tokenBudget into expectedGoal, and copy state.editRevision into expectedRevision when present. The edit revision tolerates usage accounting while rejecting goal mutations. Revise objectives only within the user's authorized task. Resume with status active when a blocker is resolved or the user requests continuation; never undo an explicit user pause without permission to resume. Mark complete only when achieved. Cannot edit another thread, raise a budget, bypass a usage limit or restart hold, or revive completed goals. On a conflict, read again and reconcile rather than retrying blindly.",
      inputSchema: ThreadGoalEditSchema,
      outputSchema: { state: AgentGoalStateSchema },
      handler: async (input) => ({
        content: [],
        structuredContent: {
          state: await manager.editOwnGoal(callerAgentId, ThreadGoalEditSchema.parse(input)),
        },
      }),
    },
  ];
}
