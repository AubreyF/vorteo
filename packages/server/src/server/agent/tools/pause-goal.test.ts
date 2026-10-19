import { expect, it } from "vitest";
import { z } from "zod";
import { AgentGoalSchema, type AgentGoal } from "@getpaseo/protocol/agent-goals";
import { CodexGoals } from "../providers/codex/goals.js";
import { createPauseGoalTool } from "./pause-goal.js";

const goal: AgentGoal = {
  threadId: "thread-1",
  objective: "Finish the migration",
  status: "active",
  tokenBudget: 10000,
  tokensUsed: 123,
  timeUsedSeconds: 7,
  createdAt: 100,
  updatedAt: 107,
};

function fixture(initial: AgentGoal | null = goal, rejectPause = false) {
  let nativeGoal = initial;
  const mutations: Record<string, unknown>[] = [];
  const callers: string[] = [];
  const goals = new CodexGoals({
    request: async (method, params) => {
      if (method === "thread/goal/get") return { goal: nativeGoal };
      expect(method).toBe("thread/goal/set");
      mutations.push(params);
      if (rejectPause) throw new Error("Native pause rejected");
      nativeGoal = AgentGoalSchema.parse({ ...nativeGoal, ...params });
      return { goal: nativeGoal };
    },
    onChange: () => {},
  });
  goals.bind(goal.threadId);
  const tool = createPauseGoalTool(
    {
      readAgentGoal: async (id) => {
        callers.push(id);
        return goals.read();
      },
      setAgentGoal: async (id, input) => {
        callers.push(id);
        return goals.set(input);
      },
    },
    "caller-agent",
  );
  return { tool, mutations, callers, state: () => goals.state };
}

it("pauses the caller's native goal while preserving its objective, usage, and budget", async () => {
  const f = fixture();
  const result = await f.tool.handler({}, {});
  expect(f.callers).toEqual(["caller-agent", "caller-agent"]);
  expect(f.mutations).toEqual([{ threadId: "thread-1", status: "paused" }]);
  expect(result.structuredContent).toMatchObject({
    state: { status: "ready", goal: { ...goal, status: "paused" } },
  });
});

it("reasserts an existing pause through the manager so queue holds are released", async () => {
  const f = fixture({ ...goal, status: "paused" });
  await f.tool.handler({}, {});
  expect(f.mutations).toEqual([{ threadId: "thread-1", status: "paused" }]);
});

it("turns a blocked goal into a manual pause so recovery cannot resume it", async () => {
  const f = fixture({ ...goal, status: "blocked" });
  const result = await f.tool.handler({}, {});
  expect(f.mutations).toEqual([{ threadId: "thread-1", status: "paused" }]);
  expect(result.structuredContent).toMatchObject({
    state: { status: "ready", goal: { ...goal, status: "paused" } },
  });
});

it.each(["complete", "budgetLimited", "usageLimited"] as const)(
  "preserves a %s goal",
  async (status) => {
    const f = fixture({ ...goal, status });
    const result = await f.tool.handler({}, {});
    expect(f.mutations).toEqual([]);
    expect(result.structuredContent).toMatchObject({ state: { goal: { status } } });
  },
);

it("does not create a goal when none exists", async () => {
  const f = fixture(null);
  const result = await f.tool.handler({}, {});
  expect(f.mutations).toEqual([]);
  expect(result.structuredContent).toMatchObject({ state: { status: "ready", goal: null } });
});

it("reports a rejected native pause instead of claiming success", async () => {
  const f = fixture(goal, true);
  await expect(f.tool.handler({}, {})).rejects.toThrow("Native pause rejected");
  expect(f.state().status).toBe("error");
});

it("rejects an unconfirmed read without mutating the goal", async () => {
  const tool = createPauseGoalTool(
    {
      readAgentGoal: async () => ({ status: "loading", goal }),
      setAgentGoal: async () => {
        throw new Error("Unexpected mutation");
      },
    },
    "caller-agent",
  );
  await expect(tool.handler({}, {})).rejects.toThrow("Could not confirm the current goal");
});

it.each(["active", "blocked"] as const)(
  "rejects a pause response that still reports %s",
  async (status) => {
    const unchanged = { ...goal, status };
    const tool = createPauseGoalTool(
      {
        readAgentGoal: async () => ({ status: "ready", goal: unchanged, observedAt: "now" }),
        setAgentGoal: async () => ({ status: "ready", goal: unchanged, observedAt: "now" }),
      },
      "caller-agent",
    );
    await expect(tool.handler({}, {})).rejects.toThrow("Goal pause could not be confirmed");
  },
);

it("does not accept a different agent or goal mutation through its input schema", () => {
  const { tool } = fixture();
  const schema = z.object({ inputSchema: z.instanceof(z.ZodObject) }).parse(tool).inputSchema;
  expect(schema.safeParse({}).success).toBe(true);
  expect(schema.safeParse({ agentId: "other-agent" }).success).toBe(false);
  expect(schema.safeParse({ status: "active" }).success).toBe(false);
});
