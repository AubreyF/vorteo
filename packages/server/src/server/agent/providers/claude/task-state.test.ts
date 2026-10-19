import { describe, expect, test } from "vitest";
import { ClaudeTaskState } from "./task-state.js";

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}

function toolResult(id: string, result: Record<string, unknown>) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    toolUseResult: result,
  };
}

describe("ClaudeTaskState", () => {
  test("reconciles inverse dependencies and missing tasks from TaskGet", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("list", "TaskList", {}));
    state.observe(
      toolResult("list", {
        tasks: [
          { id: "1", subject: "A", status: "pending", blockedBy: [] },
          { id: "2", subject: "B", status: "pending", blockedBy: [] },
          { id: "3", subject: "C", status: "pending", blockedBy: ["1"] },
        ],
      }),
    );
    state.observe(toolUse("get", "TaskGet", { taskId: "1" }));
    const refreshed = state.observe(
      toolResult("get", {
        task: {
          id: "1",
          subject: "A",
          status: "pending",
          description: "Criteria",
          blockedBy: [],
          blocks: ["2"],
        },
      }),
    );
    expect(refreshed?.items.map((task) => task.blockedBy)).toEqual([[], ["1"], []]);
    state.observe(toolUse("missing", "TaskGet", { taskId: "1" }));
    const removed = state.observe(toolResult("missing", { task: null }));
    expect(removed?.items.map((task) => ({ id: task.id, blockedBy: task.blockedBy }))).toEqual([
      { id: "2", blockedBy: [] },
      { id: "3", blockedBy: [] },
    ]);
  });

  test("preserves details through list summaries and applies dependency and metadata edits", () => {
    const state = new ClaudeTaskState();
    state.observe(
      toolUse("a", "TaskCreate", {
        subject: "A",
        description: "Accept A",
        metadata: { keep: true, remove: 1 },
      }),
    );
    state.observe(toolResult("a", { task: { id: "1", subject: "A" } }));
    state.observe(toolUse("b", "TaskCreate", { subject: "B", description: "Accept B" }));
    state.observe(toolResult("b", { task: { id: "2", subject: "B" } }));
    state.observe(
      toolUse("edit", "TaskUpdate", {
        taskId: "1",
        addBlocks: ["2"],
        owner: "worker",
        metadata: { remove: null, added: 2 },
      }),
    );
    expect(state.observe(toolResult("edit", { success: true, taskId: "1" }))).toEqual({
      type: "todo",
      items: [
        {
          id: "1",
          text: "A",
          description: "Accept A",
          metadata: { keep: true, added: 2 },
          owner: "worker",
          status: "pending",
          completed: false,
        },
        {
          id: "2",
          text: "B",
          description: "Accept B",
          blockedBy: ["1"],
          status: "pending",
          completed: false,
        },
      ],
    });
    state.observe(toolUse("list", "TaskList", {}));
    const listed = state.observe(
      toolResult("list", {
        tasks: [
          { id: "1", subject: "A", status: "pending", owner: "worker", blockedBy: [] },
          { id: "2", subject: "B", status: "pending", blockedBy: ["1"] },
        ],
      }),
    );
    expect(listed?.items[0].description).toBe("Accept A");
    expect(listed?.items[0].metadata).toEqual({ keep: true, added: 2 });
    state.observe(toolUse("get", "TaskGet", { taskId: "2" }));
    expect(
      state.observe(
        toolResult("get", {
          task: {
            id: "2",
            subject: "B",
            description: "New criteria",
            status: "completed",
            blockedBy: ["1"],
            blocks: [],
          },
        }),
      )?.items[1],
    ).toEqual({
      id: "2",
      text: "B",
      description: "New criteria",
      blockedBy: ["1"],
      status: "completed",
      completed: true,
    });
  });

  test("does not apply a failed tool result", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create", "TaskCreate", { subject: "Keep open" }));
    state.observe(toolResult("create", { task: { id: "1", subject: "Keep open" } }));
    state.observe(toolUse("fail", "TaskUpdate", { taskId: "1", status: "completed" }));
    expect(
      state.observe({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "fail", is_error: true, content: "Denied" },
          ],
        },
      }),
    ).toBeNull();
    state.observe(toolUse("read", "TaskList", {}));
    expect(
      state.observe(
        toolResult("read", { tasks: [{ id: "1", subject: "Keep open", status: "pending" }] }),
      )?.items[0].completed,
    ).toBe(false);
  });

  test("does not publish a failed legacy checklist or retain a cleared owner", () => {
    const state = new ClaudeTaskState();
    state.observe(
      toolUse("legacy", "TodoWrite", {
        todos: [{ content: "Not completed", status: "completed" }],
      }),
    );
    expect(
      state.observe({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "legacy", is_error: true }] },
      }),
    ).toBeNull();
    state.observe(toolUse("create", "TaskCreate", { subject: "A" }));
    state.observe(toolResult("create", { task: { id: "1", subject: "A" } }));
    state.observe(toolUse("assign", "TaskUpdate", { taskId: "1", owner: "worker" }));
    state.observe(toolResult("assign", { success: true, taskId: "1" }));
    state.observe(toolUse("list", "TaskList", {}));
    expect(
      state.observe(
        toolResult("list", {
          tasks: [{ id: "1", subject: "A", status: "pending", blockedBy: [] }],
        }),
      )?.items,
    ).toEqual([{ id: "1", text: "A", status: "pending", completed: false, blockedBy: [] }]);
  });
  test("accumulates TaskCreate and TaskUpdate mutations by task id", () => {
    const state = new ClaudeTaskState();
    state.observe(
      toolUse("create-1", "TaskCreate", { subject: "Alpha", activeForm: "Doing alpha" }),
    );
    expect(state.observe(toolResult("create-1", { task: { id: "1", subject: "Alpha" } }))).toEqual({
      type: "todo",
      items: [
        { id: "1", text: "Alpha", activeForm: "Doing alpha", status: "pending", completed: false },
      ],
    });

    state.observe(toolUse("update-1", "TaskUpdate", { taskId: "1", status: "in_progress" }));
    expect(state.observe(toolResult("update-1", { success: true, taskId: "1" }))).toEqual({
      type: "todo",
      items: [
        {
          id: "1",
          text: "Alpha",
          activeForm: "Doing alpha",
          status: "in_progress",
          completed: false,
        },
      ],
    });
  });

  test("removes deleted tasks and ignores replayed results", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create", "TaskCreate", { subject: "Disposable" }));
    state.observe(toolResult("create", { task: { id: "1", subject: "Disposable" } }));
    state.observe(toolUse("delete", "TaskUpdate", { taskId: "1", status: "deleted" }));
    const result = toolResult("delete", { success: true, taskId: "1" });
    expect(state.observe(result)).toEqual({ type: "todo", items: [] });
    expect(state.observe(result)).toBeNull();
  });

  test("preserves status when TaskUpdate changes only descriptive fields", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create", "TaskCreate", { subject: "Original" }));
    state.observe(toolResult("create", { task: { id: "1", subject: "Original" } }));
    state.observe(toolUse("complete", "TaskUpdate", { taskId: "1", status: "completed" }));
    state.observe(toolResult("complete", { success: true, taskId: "1" }));
    state.observe(toolUse("rename", "TaskUpdate", { taskId: "1", subject: "Renamed" }));

    expect(state.observe(toolResult("rename", { success: true, taskId: "1" }))).toEqual({
      type: "todo",
      items: [{ id: "1", text: "Renamed", status: "completed", completed: true }],
    });
  });

  test("replaces state from TodoWrite and TaskList snapshots", () => {
    const state = new ClaudeTaskState();
    expect(
      state.observe(
        toolUse("legacy", "TodoWrite", {
          todos: [{ content: "Legacy", status: "in_progress", activeForm: "Working" }],
        }),
      ),
    ).toBeNull();
    expect(state.observe(toolResult("legacy", {}))).toEqual({
      type: "todo",
      items: [
        {
          id: "legacy:0",
          text: "Legacy",
          activeForm: "Working",
          status: "in_progress",
          completed: false,
        },
      ],
    });
    state.observe(toolUse("list", "TaskList", {}));
    expect(
      state.observe(
        toolResult("list", {
          tasks: [{ id: "7", subject: "Current", status: "completed", activeForm: "Finishing" }],
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        { id: "7", text: "Current", activeForm: "Finishing", status: "completed", completed: true },
      ],
    });
  });

  test("keeps synthetic TodoWrite task ids stable across snapshots", () => {
    const state = new ClaudeTaskState();
    state.observe(
      toolUse("first", "TodoWrite", {
        todos: [{ content: "Stable", status: "pending" }],
      }),
    );
    state.observe(toolResult("first", {}));

    state.observe(
      toolUse("second", "TodoWrite", {
        todos: [{ content: "Stable", status: "completed" }],
      }),
    );
    expect(state.observe(toolResult("second", {}))).toEqual({
      type: "todo",
      items: [{ id: "legacy:0", text: "Stable", status: "completed", completed: true }],
    });
  });

  test("does not confuse Claude's subagent Task tool with task tracking", () => {
    const state = new ClaudeTaskState();
    expect(state.observe(toolUse("subagent", "Task", { description: "delegate" }))).toBeNull();
  });
});
