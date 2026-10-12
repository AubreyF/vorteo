import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";

export function blockedTaskReason(task: AgentTaskItem): string {
  const reason = task.description?.trim();
  if (reason) return reason;
  if (task.blockedBy?.length) {
    const prerequisites =
      task.blockedBy.length === 1
        ? "1 prerequisite task"
        : `${task.blockedBy.length} prerequisite tasks`;
    return `Waiting for ${prerequisites} to finish. The agent has not recorded a more specific reason.`;
  }
  return "The agent marked this task blocked without recording a reason. Ask it to reassess the task and explain what is preventing progress.";
}
