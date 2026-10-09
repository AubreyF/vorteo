import { expect, it } from "vitest";
import type { AgentGoal, AgentGoalSetInput, AgentGoalState } from "@getpaseo/protocol/agent-goals";
import { editThreadGoal, ThreadGoalEditSchema, setAgentGoalWithContext } from "./agent-goal.js";

function fixture() {
  let goal: AgentGoal | null = {
    threadId: "thread",
    objective: "Work",
    status: "paused",
    tokenBudget: 1000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const writes: AgentGoalSetInput[] = [];
  const state = (): AgentGoalState => ({
    status: "ready",
    goal,
    observedAt: new Date().toISOString(),
  });
  const manager = {
    readAgentGoal: async () => state(),
    setAgentGoal: async (_id: string, input: AgentGoalSetInput) => {
      writes.push(input);
      if (goal) goal = { ...goal, ...input };
      return state();
    },
  };
  return {
    manager,
    writes,
    state,
    change: (next: AgentGoal | null) => {
      goal = next;
    },
  };
}

it("delivers context while paused before enabling native continuation", async () => {
  const f = fixture();
  await setAgentGoalWithContext({
    manager: f.manager,
    agentId: "agent",
    goal: { objective: "Work" },
    sendContext: async () => {
      expect(f.state().goal?.status).toBe("paused");
    },
  });
  expect(f.writes).toEqual([{ objective: "Work", status: "paused" }, { status: "active" }]);
});

it("does not reactivate a goal completed during the context turn", async () => {
  const f = fixture();
  const result = await setAgentGoalWithContext({
    manager: f.manager,
    agentId: "agent",
    goal: { objective: "Work" },
    sendContext: async () => {
      f.change({ ...f.state().goal!, status: "complete" });
    },
  });
  expect(result.goal?.status).toBe("complete");
  expect(f.writes).toHaveLength(1);
});

it("does not resume a replacement or cleared goal", async () => {
  const f = fixture();
  await expect(
    setAgentGoalWithContext({
      manager: f.manager,
      agentId: "agent",
      goal: { objective: "Work" },
      sendContext: async () => {
        f.change(null);
      },
    }),
  ).rejects.toThrow("goal changed");
  expect(f.writes).toHaveLength(1);
});

it("leaves continuation paused if context delivery fails", async () => {
  const f = fixture();
  await expect(
    setAgentGoalWithContext({
      manager: f.manager,
      agentId: "agent",
      goal: { objective: "Work" },
      sendContext: async () => {
        throw new Error("attachment rejected");
      },
    }),
  ).rejects.toThrow("attachment rejected");
  expect(f.state().goal?.status).toBe("paused");
});

it("edits an existing objective without resuming a paused goal or resetting usage", async () => {
  const f = fixture();
  const goal = f.state().goal!;
  const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = goal;
  const edited = await editThreadGoal({
    edit: {
      expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
      objective: "Finish accepted migration",
    },
    read: async () => f.state(),
    set: (input) => f.manager.setAgentGoal("agent", input),
  });
  expect(edited.goal).toEqual({ ...goal, objective: "Finish accepted migration" });
  expect(f.writes).toEqual([{ objective: "Finish accepted migration", status: "paused" }]);
});

it("resumes a blocked goal without replacing it", async () => {
  const f = fixture();
  f.change({ ...f.state().goal!, status: "blocked", tokensUsed: 800 });
  const goal = f.state().goal!;
  const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = goal;
  const edited = await editThreadGoal({
    edit: {
      expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
      status: "active",
    },
    read: async () => f.state(),
    set: (input) => f.manager.setAgentGoal("agent", input),
  });
  expect(edited.goal).toEqual({ ...goal, status: "active" });
});

it("rejects a stale goal edit after an owner pause", async () => {
  const f = fixture();
  const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = f.state().goal!;
  f.change({ ...f.state().goal!, updatedAt: updatedAt + 1 });
  await expect(
    editThreadGoal({
      edit: {
        expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
        status: "active",
      },
      read: async () => f.state(),
      set: (input) => f.manager.setAgentGoal("agent", input),
    }),
  ).rejects.toThrow("goal changed");
  expect(f.writes).toEqual([]);
});

it.each(["budgetLimited", "usageLimited", "complete"] as const)(
  "does not resume %s goals",
  async (status) => {
    const f = fixture();
    f.change({ ...f.state().goal!, status });
    const { threadId, objective, createdAt, updatedAt, tokenBudget } = f.state().goal!;
    await expect(
      editThreadGoal({
        edit: {
          expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
          status: "active",
        },
        read: async () => f.state(),
        set: (input) => f.manager.setAgentGoal("agent", input),
      }),
    ).rejects.toThrow("cannot be resumed");
    expect(f.writes).toEqual([]);
  },
);

it.each(["queueContinuationHeld", "restartContinuationHeld"] as const)(
  "preserves %s ownership",
  async (held) => {
    const f = fixture();
    const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = f.state().goal!;
    await expect(
      editThreadGoal({
        edit: {
          expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
          objective: "Changed",
        },
        read: async () => ({ ...f.state(), [held]: true }),
        set: (input) => f.manager.setAgentGoal("agent", input),
      }),
    ).rejects.toThrow("held");
    expect(f.writes).toEqual([]);
  },
);

it("does not accept agent selection or budget changes through goal editing", () => {
  const f = fixture();
  const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = f.state().goal!;
  const input = {
    expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
    objective: "Changed",
  };
  expect(ThreadGoalEditSchema.safeParse(input).success).toBe(true);
  expect(ThreadGoalEditSchema.safeParse({ ...input, agentId: "other" }).success).toBe(false);
  expect(ThreadGoalEditSchema.safeParse({ ...input, tokenBudget: null }).success).toBe(false);
});

it("cannot clear a budget limit indirectly through paused status", async () => {
  const f = fixture();
  f.change({ ...f.state().goal!, status: "budgetLimited" });
  const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = f.state().goal!;
  await expect(
    editThreadGoal({
      edit: {
        expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
        status: "paused",
      },
      read: async () => f.state(),
      set: (input) => f.manager.setAgentGoal("agent", input),
    }),
  ).rejects.toThrow("cannot be resumed");
  expect(f.writes).toEqual([]);
});

it.each(["queueContinuationHeld", "restartContinuationHeld"] as const)(
  "retains %s with a matching edit revision",
  async (hold) => {
    const f = fixture();
    const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = f.state().goal!;
    await expect(
      editThreadGoal({
        edit: {
          expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
          expectedRevision: "revision",
          status: "active",
        },
        read: async () => ({
          ...f.state(),
          status: "ready",
          observedAt: new Date().toISOString(),
          editRevision: "revision",
          [hold]: true,
        }),
        set: (change) => f.manager.setAgentGoal("agent", change),
      }),
    ).rejects.toThrow("held");
    expect(f.writes).toEqual([]);
  },
);

it("still compares goal content when a revision is supplied", async () => {
  const f = fixture();
  const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = f.state().goal!;
  f.change({ ...f.state().goal!, objective: "Owner changed this" });
  await expect(
    editThreadGoal({
      edit: {
        expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
        expectedRevision: "revision",
        status: "active",
      },
      read: async () => ({
        ...f.state(),
        status: "ready",
        observedAt: new Date().toISOString(),
        editRevision: "revision",
      }),
      set: (change) => f.manager.setAgentGoal("agent", change),
    }),
  ).rejects.toThrow("goal changed");
  expect(f.writes).toEqual([]);
});
