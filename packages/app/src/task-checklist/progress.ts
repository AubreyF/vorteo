import type { TodoEntry } from "@/types/stream";
import type { Agent } from "@/stores/session-store";

export interface ChecklistProgress {
  completed: number;
  total: number;
  active: number;
  /** Blocked items stay incomplete; the count keeps stalled work visible in summaries. */
  blocked: number;
  /**
   * Completed items plus the partial progress of unfinished ones, in item units. Equals
   * `completed` when no item reports progress.
   */
  credit: number;
}

function isCompleted(task: TodoEntry): boolean {
  return task.completed || task.status === "completed";
}

/** Partial credit for one unfinished item, from the progress the daemon already settled. */
function partialCredit(task: TodoEntry): number {
  const progress = task.progress;
  if (progress === undefined || !Number.isFinite(progress)) return 0;
  return Math.min(1, Math.max(0, progress / 100));
}

export function checklistProgress(tasks: readonly TodoEntry[]): ChecklistProgress {
  let completed = 0;
  let active = 0;
  let blocked = 0;
  let partial = 0;
  for (const task of tasks) {
    if (isCompleted(task)) {
      completed++;
      continue;
    }
    if (task.status === "in_progress") active++;
    else if (task.status === "blocked") blocked++;
    partial += partialCredit(task);
  }
  return { completed, active, blocked, total: tasks.length, credit: completed + partial };
}

/** Whole-number percentage of the checklist's credit. */
export function checklistPercent({ credit, total }: ChecklistProgress): number {
  return total === 0 ? 0 : Math.round((credit / total) * 100);
}

/** Sum items, not thread percentages. Task IDs belong to their own thread. */
export function workspaceChecklistProgress(
  agents: Iterable<Pick<Agent, "id" | "workspaceId" | "archivedAt" | "tasks">>,
  workspaceId: string,
  pendingArchive: ReadonlySet<string>,
): ChecklistProgress {
  const progress = { completed: 0, active: 0, blocked: 0, total: 0, credit: 0 };
  for (const agent of agents) {
    if (agent.workspaceId !== workspaceId || agent.archivedAt || pendingArchive.has(agent.id)) {
      continue;
    }
    const thread = checklistProgress(agent.tasks ?? []);
    progress.completed += thread.completed;
    progress.total += thread.total;
    progress.active += thread.active;
    progress.blocked += thread.blocked;
    progress.credit += thread.credit;
  }
  return progress;
}
