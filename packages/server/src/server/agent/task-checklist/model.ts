import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import type { ChecklistMutation } from "@getpaseo/protocol/task-checklist";
import { mutateChecklist as mutateSharedChecklist } from "@getpaseo/protocol/checklist-model";

export * from "@getpaseo/protocol/checklist-model";

/** Keep native ID generation and equality semantics for persisted server tasks. */
export function mutateChecklist(
  items: readonly AgentTaskItem[],
  mutation: ChecklistMutation,
): AgentTaskItem[] {
  return mutateSharedChecklist(items, mutation, { createId: randomUUID, equal: isDeepStrictEqual });
}
