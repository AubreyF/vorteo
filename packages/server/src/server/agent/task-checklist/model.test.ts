import { z } from "zod";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import { AgentTaskItemSchema, type WSOutboundMessage } from "@getpaseo/protocol/messages";
import { serializeLegacyChecklistMessage } from "./compatibility.js";
import { describe, expect, test } from "vitest";
import { ChecklistMutationSchema, mutateChecklist } from "./model.js";

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

test("blocked is discretionary, incomplete, and independent of prerequisite edges", () => {
  let tasks = mutateChecklist([], {
    operation: "create",
    id: "a",
    text: "Waiting for review",
    owner: "worker",
    description: "Review accepted",
    metadata: { keep: true },
  });
  for (const status of [
    "in_progress",
    "blocked",
    "pending",
    "blocked",
    "completed",
    "blocked",
  ] as const) {
    tasks = mutateChecklist(
      tasks,
      ChecklistMutationSchema.parse({ operation: "update", id: "a", status }),
    );
    expect(tasks[0]).toMatchObject({
      status,
      completed: status === "completed",
      owner: "worker",
      description: "Review accepted",
      metadata: { keep: true },
    });
    expect(tasks[0].blockedBy).toBeUndefined();
  }
  tasks = mutateChecklist(tasks, {
    operation: "create",
    id: "b",
    text: "Dependent",
    blockedBy: ["a"],
  });
  tasks = mutateChecklist(tasks, { operation: "update", id: "b", status: "blocked" });
  expect(() =>
    mutateChecklist(tasks, { operation: "update", id: "b", status: "in_progress" }),
  ).toThrow("Complete dependency a");
  tasks = mutateChecklist(tasks, { operation: "update", id: "a", status: "completed" });
  expect(tasks[1].status).toBe("blocked");
  tasks = mutateChecklist(tasks, { operation: "update", id: "b", status: "in_progress" });
  expect(tasks[1]).toMatchObject({ status: "in_progress", completed: false, blockedBy: ["a"] });
});

test("legacy serialization downgrades checklist status without touching metadata or source state", () => {
  const arbitrary = { text: "Payload", status: "blocked", completed: false };
  const task: AgentTaskItem = {
    id: "a",
    text: "Waiting",
    status: "blocked",
    completed: false,
    metadata: { arbitrary },
  };
  const message: WSOutboundMessage = {
    type: "session",
    message: {
      type: "agent_stream",
      payload: {
        agentId: "a",
        timestamp: new Date().toISOString(),
        event: { type: "timeline", provider: "codex", item: { type: "todo", items: [task] } },
      },
    },
  };
  const encoded = JSON.parse(serializeLegacyChecklistMessage(message));
  const legacyTask = encoded.message.payload.event.item.items[0];
  expect(legacyTask).toEqual({ ...task, status: "pending" });
  expect(legacyTask.metadata.arbitrary.status).toBe("blocked");
  expect(task.status).toBe("blocked");
  expect(
    AgentTaskItemSchema.extend({
      status: z.enum(["pending", "in_progress", "completed"]).optional(),
    }).safeParse(legacyTask).success,
  ).toBe(true);
});

test("Review stays incomplete, retains dependencies and cannot be edited through a legacy projection", () => {
  let tasks = mutateChecklist([], { operation: "create", id: "approval", text: "Approve" });
  tasks = mutateChecklist(tasks, {
    operation: "create",
    id: "delivery",
    text: "Deliver",
    blockedBy: ["approval"],
  });
  tasks = mutateChecklist(
    tasks,
    ChecklistMutationSchema.parse({ operation: "update", id: "approval", status: "review" }),
  );
  expect(tasks[0]).toMatchObject({ status: "review", completed: false });
  expect(() =>
    mutateChecklist(tasks, { operation: "update", id: "delivery", status: "in_progress" }),
  ).toThrow("Complete dependency");
  const message: WSOutboundMessage = {
    type: "session",
    message: {
      type: "agent.checklist.get.response",
      payload: { agentId: "agent", requestId: "request", tasks, error: null },
    },
  };
  const projected = JSON.parse(
    serializeLegacyChecklistMessage(message, undefined, { blocked: true, review: false }),
  );
  const legacy = projected.message.payload.tasks[0];
  expect(legacy).toMatchObject({ status: "pending", completed: false });
  expect(() =>
    mutateChecklist(tasks, {
      operation: "update",
      id: "approval",
      expectedTask: legacy,
      status: "completed",
    }),
  ).toThrow("changed while");
  expect(
    JSON.parse(serializeLegacyChecklistMessage(message, undefined, { blocked: true, review: true }))
      .message.payload.tasks[0].status,
  ).toBe("review");
  expect(tasks[0].status).toBe("review");
});

describe("checklist progress", () => {
  const created = mutateChecklist([], { operation: "create", id: "a", text: "Ship it" });
  const update = (
    items: AgentTaskItem[],
    fields: Omit<
      Extract<z.infer<typeof ChecklistMutationSchema>, { operation: "update" }>,
      "operation" | "id"
    >,
  ) => mutateChecklist(items, { operation: "update", id: "a", ...fields })[0];

  test("rounds estimates to five points and caps unfinished work at 90", () => {
    expect(update(created, { progress: 42 }).progress).toBe(40);
    expect(update(created, { progress: 43 }).progress).toBe(45);
    expect(update(created, { progress: 100 }).progress).toBe(90);
  });

  test("derives progress from passed checks and ignores a conflicting estimate", () => {
    const task = update(created, {
      progress: 10,
      checks: [
        { text: "Schema accepts progress", done: true },
        { text: "Old clients still parse", done: true },
        { text: "Sidebar shows partial credit", done: false },
      ],
    });
    expect(task.progress).toBe(65);
  });

  test("keeps all-passed checks below done until the item is completed", () => {
    const checks = [{ text: "Only check", done: true }];
    expect(update(created, { checks }).progress).toBe(90);
    expect(update(created, { checks, status: "completed" }).progress).toBe(100);
    expect(update(created, { status: "completed" })).not.toHaveProperty("progress");
  });

  test("completion means 100 and a parked item keeps its partial progress", () => {
    const started = mutateChecklist(created, {
      operation: "update",
      id: "a",
      status: "in_progress",
      progress: 60,
    });
    expect(update(started, { status: "pending" }).progress).toBe(60);
    expect(update(started, { status: "completed" }).progress).toBe(100);
  });

  test("creates with progress settled from the same rules", () => {
    const [task] = mutateChecklist([], {
      operation: "create",
      id: "b",
      text: "Estimate",
      progress: 97,
    });
    expect(task.progress).toBe(90);
  });

  test("older checklist items without progress stay unchanged", () => {
    expect(update(created, { text: "Renamed" })).not.toHaveProperty("progress");
  });

  test("the wire schema accepts progress and checks while older items still parse", () => {
    expect(AgentTaskItemSchema.parse({ text: "Old", completed: false })).toEqual({
      text: "Old",
      completed: false,
    });
    expect(
      AgentTaskItemSchema.parse({
        text: "New",
        completed: false,
        progress: 65,
        checks: [{ text: "Check", done: true }],
      }),
    ).toMatchObject({ progress: 65, checks: [{ text: "Check", done: true }] });
  });
});
