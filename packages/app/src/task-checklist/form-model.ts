import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import type { ChecklistMutation } from "@getpaseo/protocol/task-checklist";

export interface ChecklistForm {
  original: AgentTaskItem | null;
  text: string;
  description: string;
  owner: string;
  activeForm: string;
  status: "pending" | "in_progress" | "blocked" | "completed";
  blockedBy: string[];
}

export type ChecklistFormAction =
  | { field: "text" | "description" | "owner" | "activeForm"; value: string }
  | { field: "status"; value: ChecklistForm["status"] }
  | { field: "dependency"; value: string };

export function openChecklistForm(task: AgentTaskItem | null): ChecklistForm {
  const inferredStatus = task?.completed ? "completed" : "pending";
  return {
    original: task,
    text: task?.text ?? "",
    description: task?.description ?? "",
    owner: task?.owner ?? "",
    activeForm: task?.activeForm ?? "",
    status: task?.status ?? inferredStatus,
    blockedBy: task?.blockedBy ?? [],
  };
}

export function updateChecklistForm(
  state: ChecklistForm,
  action: ChecklistFormAction,
): ChecklistForm {
  if (action.field !== "dependency") return { ...state, [action.field]: action.value };
  const blockedBy = state.blockedBy.includes(action.value)
    ? state.blockedBy.filter((id) => id !== action.value)
    : [...state.blockedBy, action.value];
  return { ...state, blockedBy };
}

export function checklistFormMutation(form: ChecklistForm): ChecklistMutation {
  const fields = {
    text: form.text.trim(),
    description: form.description,
    owner: form.owner,
    activeForm: form.activeForm,
    blockedBy: form.blockedBy,
  };
  if (!form.original?.id) return { operation: "create", ...fields };
  return {
    operation: "update",
    id: form.original.id,
    expectedTask: form.original,
    status: form.status,
    ...fields,
  };
}
