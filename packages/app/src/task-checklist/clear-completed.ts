import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import type { ChecklistMutation } from "@getpaseo/protocol/task-checklist";

export function canClearTask(task: AgentTaskItem): boolean {
  return (
    task.source === "vorteo" && Boolean(task.id) && (task.completed || task.status === "completed")
  );
}

export async function clearCompletedTasks(
  tasks: AgentTaskItem[],
  mutate: (mutation: ChecklistMutation) => Promise<AgentTaskItem[]>,
): Promise<void> {
  const candidates = tasks.filter(canClearTask);
  let current = tasks;
  for (const candidate of candidates) {
    const task = current.find((item) => item.source === "vorteo" && item.id === candidate.id);
    if (!task || !canClearTask(task)) continue;
    // Each deletion removes dependency links. Use its returned snapshot for the next
    // optimistic guard, and stop on conflicts rather than deleting a reopened task.
    current = await mutate({ operation: "delete", id: task.id!, expectedTask: task });
  }
}
