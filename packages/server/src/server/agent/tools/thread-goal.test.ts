import { expect, it } from "vitest";
import type { AgentGoalState } from "@getpaseo/protocol/agent-goals";
import { createThreadGoalTools } from "./thread-goal.js";

it("binds reads and edits to the calling thread and rejects foreign identifiers", async () => {
  const calls: string[] = [];
  const goal = {
    threadId: "native-thread",
    objective: "Work",
    status: "blocked" as const,
    createdAt: 1,
    updatedAt: 2,
    tokenBudget: null,
    tokensUsed: 100,
    timeUsedSeconds: 5,
  };
  const state: AgentGoalState = {
    status: "ready",
    goal,
    observedAt: "now",
    editRevision: "read-revision",
  };
  const tools = createThreadGoalTools(
    {
      readAgentGoal: async (id) => {
        calls.push(id);
        return state;
      },
      editOwnGoal: async (id, change) => {
        expect(change.expectedRevision).toBe("read-revision");
        calls.push(id);
        return state;
      },
    },
    "calling-agent",
  );
  const read = tools.find((tool) => tool.name === "get_thread_goal")!;
  const edit = tools.find((tool) => tool.name === "update_thread_goal")!;
  const result = await read.handler({}, {});
  expect(result.structuredContent).toMatchObject({ state: { editRevision: "read-revision" } });
  const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = goal;
  const input = {
    expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
    expectedRevision: "read-revision",
    status: "active",
  };
  await edit.handler(input, {});
  await expect(edit.handler({ ...input, agentId: "other-agent" }, {})).rejects.toThrow();
  expect(calls).toEqual(["calling-agent", "calling-agent"]);
});
