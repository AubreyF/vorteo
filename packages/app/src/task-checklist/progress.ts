import type { TodoEntry } from "@/types/stream";
import type { Agent } from "@/stores/session-store";

export interface ChecklistProgress {
  completed: number;
  total: number;
}

export function checklistProgress(tasks: readonly TodoEntry[]): ChecklistProgress {
  return {
    completed: tasks.filter((task) => task.completed || task.status === "completed").length,
    total: tasks.length,
  };
}

/** Sum items, not thread percentages. Task IDs belong to their own thread. */
export function workspaceChecklistProgress(
  agents: Iterable<Pick<Agent, "id" | "workspaceId" | "archivedAt" | "tasks">>,
  workspaceId: string,
  pendingArchive: ReadonlySet<string>,
): ChecklistProgress {
  const progress = { completed: 0, total: 0 };
  for (const agent of agents) {
    if (agent.workspaceId !== workspaceId || agent.archivedAt || pendingArchive.has(agent.id)) {
      continue;
    }
    const thread = checklistProgress(agent.tasks ?? []);
    progress.completed += thread.completed;
    progress.total += thread.total;
  }
  return progress;
}
