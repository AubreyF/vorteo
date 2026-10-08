import { describe, expect, test } from "vitest";
import { mutateChecklist } from "./model.js";

describe("thread checklist mutations", () => {
  test("rejects stale editor updates and deletion without losing the agent's changes", () => {
    const original = mutateChecklist([], { operation: "create", id: "a", text: "Original" });
    const updated = mutateChecklist(original, {
      operation: "update",
      id: "a",
      text: "Agent revision",
    });
    expect(() =>
      mutateChecklist(updated, {
        operation: "update",
        id: "a",
        text: "Old draft",
        expectedTask: original[0],
      }),
    ).toThrow("changed while you were editing");
    expect(() =>
      mutateChecklist(updated, { operation: "delete", id: "a", expectedTask: original[0] }),
    ).toThrow("changed while you were editing");
    expect(
      mutateChecklist(updated, {
        operation: "update",
        id: "a",
        status: "completed",
        expectedTask: updated[0],
      })[0].text,
    ).toBe("Agent revision");
  });
  test("provider IDs cannot redirect managed edits or satisfy managed dependencies", () => {
    let tasks = mutateChecklist([], { operation: "create", id: "1", text: "Managed" });
    tasks = mutateChecklist(tasks, {
      operation: "create",
      id: "2",
      text: "Dependent",
      blockedBy: ["1"],
    });
    const provider = { id: "1", text: "Native", completed: true };
    tasks = [provider, ...tasks];
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "2", status: "completed" }),
    ).toThrow("Complete dependency 1");
    tasks = mutateChecklist(tasks, { operation: "update", id: "1", text: "Managed edit" });
    expect(tasks[0]).toEqual(provider);
    expect(tasks[1].text).toBe("Managed edit");
  });
  test("merges metadata and dependency additions with Claude task semantics", () => {
    let tasks = mutateChecklist([], {
      operation: "create",
      id: "a",
      text: "A",
      metadata: { keep: true, remove: 1 },
    });
    tasks = mutateChecklist(tasks, { operation: "create", id: "b", text: "B" });
    tasks = mutateChecklist(tasks, {
      operation: "update",
      id: "a",
      metadata: { remove: null, added: "yes" },
      addBlocks: ["b"],
    });
    expect(tasks[0].metadata).toEqual({ keep: true, added: "yes" });
    expect(tasks[1].blockedBy).toEqual(["a"]);
    tasks = mutateChecklist(tasks, { operation: "update", id: "b", addBlockedBy: ["a", "a"] });
    expect(tasks[1].blockedBy).toEqual(["a"]);
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "b", addBlocks: ["missing"] }),
    ).toThrow("does not exist");
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "b", addBlocks: ["a"] }),
    ).toThrow("cycle");
  });
  test("creates a pending task with stable identity and keeps provider tasks", () => {
    const provider = { id: "1", text: "Native plan", completed: false };
    const result = mutateChecklist([provider], {
      operation: "create",
      id: "build",
      text: "Build the API",
      description: "Acceptance: clients can create tasks",
    });
    expect(result).toEqual([
      provider,
      {
        id: "build",
        source: "vorteo",
        text: "Build the API",
        description: "Acceptance: clients can create tasks",
        status: "pending",
        completed: false,
      },
    ]);
  });

  test("dependencies block execution, completion unlocks it, and reopening preserves details", () => {
    let tasks = mutateChecklist([], { operation: "create", id: "api", text: "API" });
    tasks = mutateChecklist(tasks, {
      operation: "create",
      id: "ui",
      text: "UI",
      blockedBy: ["api"],
      owner: "worker",
      metadata: { milestone: 1 },
    });
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "ui", status: "in_progress" }),
    ).toThrow("Complete dependency api");
    tasks = mutateChecklist(tasks, { operation: "update", id: "api", status: "completed" });
    tasks = mutateChecklist(tasks, { operation: "update", id: "ui", status: "completed" });
    tasks = mutateChecklist(tasks, {
      operation: "update",
      id: "ui",
      status: "pending",
      text: "UI regression",
    });
    expect(tasks[1]).toEqual({
      id: "ui",
      source: "vorteo",
      text: "UI regression",
      blockedBy: ["api"],
      owner: "worker",
      metadata: { milestone: 1 },
      status: "pending",
      completed: false,
    });
  });

  test("rejects cycles and missing dependencies without modifying the input", () => {
    const first = mutateChecklist([], { operation: "create", id: "a", text: "A" });
    const tasks = mutateChecklist(first, {
      operation: "create",
      id: "b",
      text: "B",
      blockedBy: ["a"],
    });
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "a", blockedBy: ["b"] }),
    ).toThrow("must not form a cycle");
    expect(() =>
      mutateChecklist(tasks, { operation: "update", id: "b", blockedBy: ["missing"] }),
    ).toThrow("does not exist");
    expect(tasks[0]).toEqual(first[0]);
    expect(tasks[1].blockedBy).toEqual(["a"]);
  });

  test("deletes dependency edges and reorders without dropping provider tasks", () => {
    const provider = { id: "native", text: "Native plan", completed: true };
    let tasks = mutateChecklist([provider], { operation: "create", id: "a", text: "A" });
    tasks = mutateChecklist(tasks, { operation: "create", id: "b", text: "B", blockedBy: ["a"] });
    tasks = mutateChecklist(tasks, { operation: "reorder", ids: ["b", "a"] });
    expect(tasks.map((task) => task.id)).toEqual(["native", "b", "a"]);
    tasks = mutateChecklist(tasks, { operation: "delete", id: "a" });
    expect(tasks).toEqual([
      provider,
      { id: "b", text: "B", source: "vorteo", status: "pending", completed: false, blockedBy: [] },
    ]);
    expect(() => mutateChecklist(tasks, { operation: "delete", id: "native" })).toThrow(
      "native provider task tool",
    );
    expect(() => mutateChecklist(tasks, { operation: "reorder", ids: ["b", "b"] })).toThrow(
      "exactly once",
    );
    expect(() =>
      mutateChecklist(tasks, { operation: "create", id: "b", text: "Duplicate" }),
    ).toThrow("already exists");
  });
});
