import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { AgentTaskItem, AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export { ChecklistMutationSchema, type ChecklistMutation } from "@getpaseo/protocol/task-checklist";
import type { ChecklistMutation } from "@getpaseo/protocol/task-checklist";

export function mergeTaskMetadata(
  current: AgentTaskItem["metadata"],
  patch: NonNullable<AgentTaskItem["metadata"]>,
): NonNullable<AgentTaskItem["metadata"]> {
  const merged = { ...current, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
  }
  return merged;
}

function addDependents(items: AgentTaskItem[], id: string, dependents: string[]): AgentTaskItem[] {
  const next = [...items];
  for (const dependent of new Set(dependents)) {
    const index = next.findIndex((item) => item.id === dependent && item.source === "vorteo");
    if (index < 0)
      throw new ChecklistError("dependency", `Vorteo dependency ${dependent} does not exist.`);
    const task = next[index];
    next[index] = { ...task, blockedBy: [...new Set([...(task.blockedBy ?? []), id])] };
  }
  return next;
}

export function mergeProviderChecklist(
  provider: readonly AgentTaskItem[],
  current: readonly AgentTaskItem[],
): AgentTaskItem[] {
  return [
    ...provider.filter((item) => item.source !== "vorteo"),
    ...current.filter((item) => item.source === "vorteo"),
  ];
}

export class ChecklistError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "invalid"
      | "not_found"
      | "provider_owned"
      | "duplicate"
      | "dependency"
      | "limit"
      | "order",
    message: string,
  ) {
    super(message);
    this.name = "ChecklistError";
  }
}

function validateDependencies(items: readonly AgentTaskItem[]): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id))
      throw new ChecklistError("dependency", "Task dependencies must not form a cycle.");
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new ChecklistError("dependency", `Dependency ${id} does not exist.`);
    visiting.add(id);
    for (const dependency of task.blockedBy ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of items) {
    if (task.id) visit(task.id);
  }
}

/** Provider snapshots are read-only here; their provider remains their sole writer. */
export function mutateChecklist(
  items: readonly AgentTaskItem[],
  mutation: ChecklistMutation,
): AgentTaskItem[] {
  if ("text" in mutation && mutation.text !== undefined) {
    const text = mutation.text.trim();
    if (!text) throw new ChecklistError("invalid", "Task text must not be blank.");
    mutation = { ...mutation, text };
  }
  if (mutation.operation === "create") {
    const { operation: _operation, id = randomUUID(), ...fields } = mutation;
    if (items.some((item) => item.id === id)) {
      throw new ChecklistError("duplicate", `Task ${id} already exists. Read it before retrying.`);
    }
    if (items.length >= 500)
      throw new ChecklistError("limit", "A checklist can contain at most 500 tasks.");
    const next: AgentTaskItem[] = [
      ...items,
      {
        ...fields,
        id,
        source: "vorteo",
        status: "pending",
        completed: false,
      },
    ];
    validateDependencies(next.filter((item) => item.source === "vorteo"));
    return next;
  }
  if (mutation.operation === "reorder") {
    const managed = items.filter((item) => item.source === "vorteo");
    const byId = new Map(managed.map((item) => [item.id, item]));
    const unique = new Set(mutation.ids);
    const completeOrder = unique.size === managed.length && mutation.ids.length === managed.length;
    if (!completeOrder)
      throw new ChecklistError("order", "Supply every Vorteo task ID exactly once.");
    const ordered = mutation.ids.map((id) => {
      const item = byId.get(id);
      if (!item) throw new ChecklistError("order", `Unknown Vorteo task ${id}.`);
      return item;
    });
    return [...items.filter((item) => item.source !== "vorteo"), ...ordered];
  }
  const current =
    items.find((item) => item.id === mutation.id && item.source === "vorteo") ??
    items.find((item) => item.id === mutation.id);
  if (!current) throw new ChecklistError("not_found", `Task ${mutation.id} does not exist.`);
  if (current.source !== "vorteo") {
    throw new ChecklistError(
      "provider_owned",
      "Use the native provider task tool to edit this provider-owned task.",
    );
  }
  if (mutation.expectedTask && !isDeepStrictEqual(mutation.expectedTask, current)) {
    throw new ChecklistError(
      "conflict",
      "This task changed while you were editing it. Close and reopen to review the current task.",
    );
  }
  if (mutation.operation === "delete") {
    return items
      .filter((item) => item !== current)
      .map((item) => {
        if (item.source !== "vorteo" || !item.blockedBy?.includes(mutation.id)) return item;
        return Object.assign({}, item, {
          blockedBy: item.blockedBy.filter((id) => id !== mutation.id),
        });
      });
  }
  return updateTask(items, current, mutation);
}

function updateTask(
  items: readonly AgentTaskItem[],
  current: AgentTaskItem,
  mutation: Extract<ChecklistMutation, { operation: "update" }>,
): AgentTaskItem[] {
  const {
    operation: _operation,
    id,
    expectedTask: _expectedTask,
    addBlocks,
    addBlockedBy,
    ...fields
  } = mutation;
  const status = fields.status ?? current.status ?? "pending";
  const updated = { ...current, ...fields, status, completed: status === "completed" };
  if (fields.metadata !== undefined)
    updated.metadata = mergeTaskMetadata(current.metadata, fields.metadata);
  if (addBlockedBy !== undefined)
    updated.blockedBy = [...new Set([...(updated.blockedBy ?? []), ...addBlockedBy])];
  const replaced = items.map((item) => (item === current ? updated : item));
  const next = addDependents(replaced, id, addBlocks ?? []);
  validateDependencies(next.filter((item) => item.source === "vorteo"));
  const startingOrCompleting = fields.status === "in_progress" || fields.status === "completed";
  const incompleteDependency = updated.blockedBy?.find(
    (dependency) =>
      !next.find((item) => item.id === dependency && item.source === "vorteo")?.completed,
  );
  if (startingOrCompleting && incompleteDependency) {
    throw new ChecklistError(
      "dependency",
      `Complete dependency ${incompleteDependency} before starting or completing this task.`,
    );
  }
  return next;
}

export function managedChecklist(items: readonly AgentTaskItem[] = []): AgentTaskItem[] {
  return items.filter((item) => item.source === "vorteo");
}

export function mergeProviderChecklistEvent(
  item: AgentTimelineItem,
  current: readonly AgentTaskItem[] = [],
): AgentTimelineItem {
  if (item.type !== "todo") return item;
  return { type: "todo", items: mergeProviderChecklist(item.items, current) };
}
