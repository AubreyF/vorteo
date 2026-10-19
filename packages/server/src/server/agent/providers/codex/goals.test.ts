import { describe, expect, it } from "vitest";
import { editThreadGoal } from "../../agent-goal.js";
import { CodexGoals } from "./goals.js";

const goal = {
  threadId: "thread-1",
  objective: "Finish the migration",
  status: "active" as const,
  tokenBudget: 10000,
  tokensUsed: 123,
  timeUsedSeconds: 7,
  createdAt: 100,
  updatedAt: 107,
};

describe("Codex goal observations", () => {
  it("waits for an in-flight mutation before reading", async () => {
    let finishSet: (value: unknown) => void = () => {};
    const calls: string[] = [];
    const paused = { ...goal, status: "paused" };
    const goals = new CodexGoals({
      request: (method) => {
        calls.push(method);
        if (method === "thread/goal/set")
          return new Promise((resolve) => {
            finishSet = resolve;
          });
        return Promise.resolve({ goal: paused });
      },
      onChange: () => {},
    });
    goals.bind("thread-1");
    const setting = goals.set({ status: "paused" });
    const reading = goals.read();
    await Promise.resolve();
    expect(calls).toEqual(["thread/goal/set"]);
    finishSet({ goal: paused });
    await setting;
    await reading;
    expect(calls).toEqual(["thread/goal/set", "thread/goal/get"]);
    expect(goals.state.goal?.status).toBe("paused");
  });

  it("retains a newer tool notification when a write response arrives late", async () => {
    let finishSet: (value: unknown) => void = () => {};
    const goals = new CodexGoals({
      request: (method) =>
        method === "thread/goal/get"
          ? Promise.resolve({ goal: { ...goal, status: "complete" } })
          : new Promise((resolve) => {
              finishSet = resolve;
            }),
      onChange: () => {},
    });
    goals.bind("thread-1");
    const setting = goals.set({ objective: goal.objective });
    await Promise.resolve();
    goals.handleNotification("thread/goal/updated", {
      threadId: "thread-1",
      goal: { ...goal, status: "complete" },
    });
    finishSet({ goal });
    await setting;
    expect(goals.state.goal?.status).toBe("complete");
  });

  it("does not restore a goal when an older read finishes after a clear notification", async () => {
    let finishRead: (value: unknown) => void = () => {};
    const goals = new CodexGoals({
      request: () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      onChange: () => {},
    });
    goals.bind("thread-1");
    const reading = goals.read();
    await Promise.resolve();
    goals.handleNotification("thread/goal/cleared", { threadId: "thread-1" });
    finishRead({ goal });
    await reading;
    expect(goals.state).toMatchObject({ status: "ready", goal: null });
  });

  it("ignores child-thread goals and accepts tool-driven updates for the root", () => {
    const goals = new CodexGoals({ request: async () => ({}), onChange: () => {} });
    goals.bind("thread-1");
    goals.handleNotification("thread/goal/updated", {
      threadId: "child",
      goal: { ...goal, threadId: "child" },
    });
    expect(goals.state).toEqual({ status: "loading", goal: null });
    goals.handleNotification("thread/goal/updated", { threadId: "thread-1", goal });
    expect(goals.state).toMatchObject({ status: "ready", goal });
    goals.handleNotification("thread/goal/updated", {
      threadId: "thread-1",
      goal: { ...goal, status: "complete" },
    });
    expect(goals.state.goal?.status).toBe("complete");
  });

  it("preserves omitted budget and sends explicit null when removing a budget", async () => {
    const calls: Record<string, unknown>[] = [];
    const goals = new CodexGoals({
      request: async (_method, params) => {
        calls.push(params);
        return { goal };
      },
      onChange: () => {},
    });
    goals.bind("thread-1");
    await goals.set({ status: "paused" });
    await goals.set({ tokenBudget: null });
    expect(calls).toEqual([
      { threadId: "thread-1", status: "paused" },
      { threadId: "thread-1", tokenBudget: null },
    ]);
  });

  it("retains the last goal as unconfirmed after failure, and lets a refresh recover", async () => {
    const goals = new CodexGoals({
      request: async (method) => {
        if (method === "thread/goal/set") throw new Error("transport closed");
        return { goal };
      },
      onChange: () => {},
    });
    goals.bind("thread-1");
    await goals.read();
    await expect(goals.set({ status: "paused" })).rejects.toThrow("transport closed");
    expect(goals.state).toMatchObject({ status: "error", goal });
    await goals.read();
    expect(goals.state).toMatchObject({ status: "ready", goal });
  });

  it("discards a read from a replaced provider thread", async () => {
    let finishRead: (value: unknown) => void = () => {};
    const goals = new CodexGoals({
      request: () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      onChange: () => {},
    });
    goals.bind("thread-1");
    const reading = goals.read();
    await Promise.resolve();
    goals.bind("thread-2");
    finishRead({ goal });
    await reading;
    expect(goals.state).toEqual({ status: "loading", goal: null });
  });
});

it("confirms a pause when a usage notification overtakes its response", async () => {
  let finishSet: (value: unknown) => void = () => {};
  const calls: string[] = [];
  const paused = { ...goal, status: "paused", timeUsedSeconds: 8 };
  const goals = new CodexGoals({
    request: (method) => {
      calls.push(method);
      if (method === "thread/goal/get") return Promise.resolve({ goal: paused });
      return new Promise((resolve) => {
        finishSet = resolve;
      });
    },
    onChange: () => {},
  });
  goals.bind("thread-1");
  const setting = goals.set({ status: "paused" });
  await Promise.resolve();
  goals.handleNotification("thread/goal/updated", {
    threadId: "thread-1",
    goal: { ...goal, timeUsedSeconds: 8 },
  });
  finishSet({ goal: paused });
  await expect(setting).resolves.toMatchObject({ status: "ready", goal: paused });
  expect(calls).toEqual(["thread/goal/set", "thread/goal/get"]);
});

it("reports an unconfirmed mutation when its follow-up read fails", async () => {
  let finishSet: (value: unknown) => void = () => {};
  const goals = new CodexGoals({
    request: (method) => {
      if (method === "thread/goal/get")
        return Promise.reject(new Error("confirmation disconnected"));
      return new Promise((resolve) => {
        finishSet = resolve;
      });
    },
    onChange: () => {},
  });
  goals.bind("thread-1");
  const setting = goals.set({ status: "paused" });
  await Promise.resolve();
  goals.handleNotification("thread/goal/updated", { threadId: "thread-1", goal });
  finishSet({ goal: { ...goal, status: "paused" } });
  await expect(setting).rejects.toThrow("confirmation disconnected");
  expect(goals.state).toMatchObject({
    status: "error",
    goal,
    message: "confirmation disconnected",
  });
});

describe("goal edit revisions", () => {
  function fixture() {
    let current = { ...goal };
    const goals = new CodexGoals({
      request: async (method, input) => {
        if (method === "thread/goal/set") current = { ...current, ...input };
        return { goal: current };
      },
      onChange: () => {},
    });
    goals.bind(goal.threadId);
    return {
      goals,
      notify: (change: Partial<typeof goal>) => {
        current = { ...current, ...change };
        goals.handleNotification("thread/goal/updated", { threadId: goal.threadId, goal: current });
      },
    };
  }

  it("allows editing after usage advances without resetting accounting", async () => {
    const f = fixture();
    const before = await f.goals.read();
    if (before.status !== "ready" || !before.goal) throw Error("Missing goal");
    expect(before.editRevision).toEqual(expect.any(String));
    const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = before.goal;
    f.notify({ tokensUsed: 456, timeUsedSeconds: 19, updatedAt: 119 });
    const after = await editThreadGoal({
      edit: {
        expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
        expectedRevision: before.editRevision,
        objective: "Finish reviewed migration",
      },
      read: () => f.goals.read(),
      set: (change) => f.goals.set(change),
    });
    expect(after.goal).toMatchObject({
      objective: "Finish reviewed migration",
      tokensUsed: 456,
      timeUsedSeconds: 19,
      tokenBudget: 10000,
    });
  });

  it("rejects pause and resume back to the same values even within one timestamp", async () => {
    const f = fixture();
    const before = await f.goals.read();
    if (before.status !== "ready" || !before.goal) throw Error("Missing goal");
    const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = before.goal;
    await f.goals.set({ status: "paused" });
    await f.goals.set({ status: "active" });
    await expect(
      editThreadGoal({
        edit: {
          expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
          expectedRevision: before.editRevision,
          objective: "Stale edit",
        },
        read: () => f.goals.read(),
        set: (change) => f.goals.set(change),
      }),
    ).rejects.toThrow("goal changed");
  });

  it("invalidates observations on same-value owner writes and provider invalidation", async () => {
    const f = fixture();
    const before = await f.goals.read();
    if (before.status !== "ready") throw Error("Missing goal");
    const written = await f.goals.set({ status: "active" });
    if (written.status !== "ready") throw Error("Missing goal");
    expect(written.editRevision).not.toBe(before.editRevision);
    f.goals.invalidate("Disconnected");
    const recovered = await f.goals.read();
    if (recovered.status !== "ready") throw Error("Missing goal");
    expect(recovered.editRevision).not.toBe(written.editRevision);
  });
});
