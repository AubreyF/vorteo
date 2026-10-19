import { expect, it } from "vitest";
import { DemoChecklistState, type DemoChecklistSnapshot } from "./checklist-state";
import { createDemoScenario } from "./scenario";

const agentId = "demo-agent-0";
it("restores task edits, preserves generated IDs across reload and resets the catalog", () => {
  let saved: DemoChecklistSnapshot | null = null;
  const persistence = {
    load: () => saved,
    save: (value: DemoChecklistSnapshot) => {
      saved = value;
    },
  };
  const first = new DemoChecklistState(createDemoScenario().agents, persistence);
  const original = first.read(agentId);
  const tasks = first.mutate(agentId, { operation: "create", text: "New simulated task" });
  const created = tasks.at(-1)!;
  first.mutate(agentId, { operation: "update", id: created.id!, status: "review" });
  const restored = new DemoChecklistState(createDemoScenario().agents, persistence);
  expect(restored.read(agentId).at(-1)?.status).toBe("review");
  expect(
    restored.mutate(agentId, { operation: "create", text: "Another task" }).at(-1)?.id,
  ).not.toBe(created.id);
  restored.reset();
  expect(new DemoChecklistState(createDemoScenario().agents, persistence).read(agentId)).toEqual(
    original,
  );
});

it("leaves task state unchanged when storage fails and permits a retry", () => {
  let reject = true;
  const state = new DemoChecklistState(createDemoScenario().agents, {
    load: () => null,
    save: () => {
      if (reject) throw new Error("quota");
    },
  });
  const original = state.read(agentId);
  const mutation = { operation: "create" as const, text: "Retry me" };
  expect(() => state.mutate(agentId, mutation)).toThrow("browser storage");
  expect(state.read(agentId)).toEqual(original);
  reject = false;
  expect(state.mutate(agentId, mutation).at(-1)).toMatchObject({
    id: "demo-task-created-1",
    text: "Retry me",
  });
});

it("rejects unknown agents, duplicate tasks and broken dependencies in stored snapshots", () => {
  const initial = createDemoScenario().agents;
  const task = initial[0].tasks![0];
  for (const agents of [
    [{ id: "real-agent", tasks: [task] }],
    [{ id: agentId, tasks: [task, task] }],
    [{ id: agentId, tasks: [{ ...task, blockedBy: ["missing"] }] }],
    [{ id: agentId, tasks: [{ ...task, blockedBy: [task.id!] }] }],
    [{ id: agentId, tasks: [{ ...task, source: "provider" }] }],
  ]) {
    const state = new DemoChecklistState(initial, {
      load: () => ({ version: 1, sequence: 1, agents }),
      save: () => {},
    });
    expect(state.read(agentId)).toEqual(initial[0].tasks);
  }
});
