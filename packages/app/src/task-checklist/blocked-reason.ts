import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";

export function blockedTaskReason(task: AgentTaskItem): string {
  const reason = task.description?.trim();
  if (reason) return reason;
  if (task.blockedBy?.length)
    return `Waiting for prerequisite tasks: ${task.blockedBy.join(", ")}. The agent has not recorded a more specific reason.`;
  return "The agent marked this task blocked without recording a reason. Ask it to reassess the task and explain what is preventing progress.";
}
