import { expect, test, vi } from "vitest";
import { clearCompletedTasks } from "./clear-completed";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import { checklistFormMutation, openChecklistForm, updateChecklistForm } from "./form-model";

test("new tasks stay pending and editing carries the original task for conflict detection", () => {
  let form = openChecklistForm(null);
  form = updateChecklistForm(form, { field: "text", value: "  Build API  " });
  form = updateChecklistForm(form, { field: "dependency", value: "design" });
  expect(checklistFormMutation(form)).toEqual({
    operation: "create",
    text: "Build API",
    description: "",
    owner: "",
    activeForm: "",
    blockedBy: ["design"],
  });
  const original = {
    id: "a",
    source: "vorteo" as const,
    text: "API",
    completed: false,
    description: "Acceptance",
    status: "pending" as const,
    blockedBy: ["design"],
  };
  form = openChecklistForm(original);
  form = updateChecklistForm(form, { field: "dependency", value: "design" });
  form = updateChecklistForm(form, { field: "status", value: "completed" });
  expect(checklistFormMutation(form)).toEqual({
    operation: "update",
    id: "a",
    expectedTask: original,
    text: "API",
    description: "Acceptance",
    status: "completed",
    owner: "",
    activeForm: "",
    blockedBy: [],
  });
  expect(original.blockedBy).toEqual(["design"]);
});

const done: AgentTaskItem = { id: "done", text: "Done", source: "vorteo", completed: true };
const dependent: AgentTaskItem = { ...done, id: "dependent", blockedBy: ["done"] };

test("clear completed uses dependency-cleaned snapshots and preserves unfinished/provider tasks", async () => {
  const pending: AgentTaskItem = { ...done, id: "pending", completed: false };
  const provider: AgentTaskItem = { ...done, id: "provider", source: "provider" };
  const updated = { ...dependent, blockedBy: [] };
  const mutate = vi
    .fn()
    .mockResolvedValueOnce([updated, pending, provider])
    .mockResolvedValueOnce([pending, provider]);
  await clearCompletedTasks([done, dependent, pending, provider], mutate);
  expect(mutate.mock.calls).toEqual([
    [{ operation: "delete", id: "done", expectedTask: done }],
    [{ operation: "delete", id: "dependent", expectedTask: updated }],
  ]);
});

test("clear completed skips tasks reopened during cleanup and stops on stale-edit failures", async () => {
  const reopened = { ...dependent, completed: false, status: "in_progress" as const };
  const mutate = vi.fn().mockResolvedValueOnce([reopened]);
  await clearCompletedTasks([done, dependent], mutate);
  expect(mutate).toHaveBeenCalledTimes(1);
  const conflict = vi.fn().mockRejectedValue(new Error("Task changed"));
  await expect(clearCompletedTasks([done, dependent], conflict)).rejects.toThrow("Task changed");
  expect(conflict).toHaveBeenCalledTimes(1);
});
