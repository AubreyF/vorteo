import type { TodoEntry } from "@/types/stream";
import type { Agent } from "@/stores/session-store";

export interface ChecklistProgress {
  completed: number;
  total: number;
  active: number;
}

export function checklistProgress(tasks: readonly TodoEntry[]): ChecklistProgress {
  let completed = 0;
  let active = 0;
  for (const task of tasks) {
    if (task.completed || task.status === "completed") completed++;
    else if (task.status === "in_progress") active++;
  }
  return { completed, active, total: tasks.length };
}

/** Sum items, not thread percentages. Task IDs belong to their own thread. */
export function workspaceChecklistProgress(
  agents: Iterable<Pick<Agent, "id" | "workspaceId" | "archivedAt" | "tasks">>,
  workspaceId: string,
  pendingArchive: ReadonlySet<string>,
): ChecklistProgress {
  const progress = { completed: 0, active: 0, total: 0 };
  for (const agent of agents) {
    if (agent.workspaceId !== workspaceId || agent.archivedAt || pendingArchive.has(agent.id)) {
      continue;
    }
    const thread = checklistProgress(agent.tasks ?? []);
    progress.completed += thread.completed;
    progress.total += thread.total;
    progress.active += thread.active;
  }
  return progress;
}
