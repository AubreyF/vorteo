import { isGoalContinuationEnabled, goalStatusLabel } from "./goal-presentation";
import { describe, expect, it } from "vitest";
import type { AgentGoalState } from "@getpaseo/protocol/agent-goals";
import { goalElapsedAt, formatGoalElapsed, goalQueryConfirmed } from "./goal-presentation";

const state: AgentGoalState = {
  status: "ready",
  observedAt: new Date(12000).toISOString(),
  goal: {
    threadId: "thread",
    objective: "Work",
    status: "active",
    tokenBudget: null,
    tokensUsed: 100,
    timeUsedSeconds: 5,
    createdAt: 1,
    updatedAt: 10,
  },
};

describe("goal elapsed time", () => {
  it("includes native uncheckpointed time and local monotonic time", () => {
    expect(goalElapsedAt(state, true, 3)).toBe(10);
    expect(goalElapsedAt({ ...state, observedAt: new Date(15000).toISOString() }, true, 0)).toBe(
      10,
    );
  });
  it("stops interpolating disconnected, paused and unconfirmed goals", () => {
    expect(goalElapsedAt(state, false, 300)).toBe(5);
    expect(goalElapsedAt({ ...state, goal: { ...state.goal!, status: "paused" } }, true, 300)).toBe(
      5,
    );
    expect(goalElapsedAt({ status: "loading", goal: state.goal }, true, 300)).toBe(5);
  });
  it("does not turn budget consumption into completion progress", () => {
    expect(formatGoalElapsed(3661)).toBe("1h 1m");
    expect(goalElapsedAt({ ...state, goal: null }, true, 10)).toBe(0);
  });
});

it("requires a confirmed read after reconnect before enabling goal mutations", () => {
  expect(goalQueryConfirmed(false, true, null)).toBe(false);
  expect(goalQueryConfirmed(false, false, new Error("disconnected"))).toBe(false);
  expect(goalQueryConfirmed(false, false, null)).toBe(true);
  expect(goalQueryConfirmed(true, false, null)).toBe(true);
});

it("offers Pause for a queue-held goal and Resume for a manual pause", () => {
  const paused = {
    ...state,
    goal: { ...state.goal!, status: "paused" as const },
    queueContinuationHeld: true,
  };
  expect(goalStatusLabel(paused)).toBe("Goal waiting for queue");
  expect(isGoalContinuationEnabled(paused)).toBe(true);
  expect(goalStatusLabel({ ...paused, restartContinuationHeld: true })).toBe(
    "Goal paused for restart",
  );
  const manual = { ...paused, queueContinuationHeld: false };
  expect(goalStatusLabel(manual)).toBe("Goal paused");
  expect(isGoalContinuationEnabled(manual)).toBe(false);
});
