import { z } from "zod";
import type { AgentManager } from "../agent-manager.js";
import type { PaseoToolDefinition, PaseoToolResult } from "../tools/types.js";
import { ChecklistMutationSchema, ChecklistError } from "./model.js";

const ReadChecklistSchema = z
  .object({ id: z.string().optional(), source: z.enum(["vorteo", "provider"]).optional() })
  .strict();
const UpdateChecklistSchema = z.object({ mutation: ChecklistMutationSchema }).strict();

function result(value: unknown): PaseoToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function createChecklistTools(
  manager: Pick<AgentManager, "readChecklist" | "mutateChecklist">,
  callerAgentId: string,
): PaseoToolDefinition[] {
  return [
    {
      name: "get_checklist",
      title: "Read your thread checklist",
      description:
        "Read this thread's persistent checklist, including native provider tasks. Omit id to list all tasks; supply id for full task details. A matching Vorteo ID takes precedence; supply source=provider to inspect a native task with the same ID. Completed tasks remain visible. blockedBy lists prerequisite IDs; owner is an assignment label, not permission to launch or message another agent.",
      inputSchema: ReadChecklistSchema,
      handler: async (input) => {
        const { id, source } = ReadChecklistSchema.parse(input);
        const tasks = manager
          .readChecklist(callerAgentId)
          .filter((item) => source === undefined || (item.source ?? "provider") === source);
        if (id === undefined) return result({ tasks });
        const task =
          tasks.find((item) => item.id === id && item.source === "vorteo") ??
          tasks.find((item) => item.id === id);
        if (!task) throw new ChecklistError("not_found", `Task ${id} does not exist.`);
        const blocks = tasks
          .filter(
            (item) =>
              (item.source ?? "provider") === (task.source ?? "provider") &&
              item.blockedBy?.includes(id),
          )
          .map((item) => item.id);
        return result({ task, blocks });
      },
    },
    {
      name: "update_checklist",
      title: "Update your thread checklist",
      description:
        "Create, update, delete, or reorder persistent Vorteo tasks in this thread. These updates populate the bottom checklist card and workspace completion donut. Create pending tasks with text and description containing completion criteria. Set status=in_progress before starting authorized work and completed only after its acceptance checks pass. Keep future work pending. Agents may set or clear status=blocked at their discretion, with or without blockedBy dependencies. Record the concrete blocker and the condition that would clear it in description; the blocked badge displays that explanation. Reassess blocked tasks on continuation and when dependencies change; return to pending or in_progress when ready. Never override an explicit owner pause or a restart hold. Blocked is incomplete. If switching away from actionable work, set pending. Reconcile stale states when resuming; normally keep one active item per agent. Use update to set pending/in_progress/blocked/completed, reopen a task, or change its blockedBy, owner, metadata, or text. blockedBy replaces prerequisites; addBlockedBy and addBlocks add dependency edges. Metadata merges by key; a null value deletes a key. Complete prerequisites before starting dependent tasks. Empty owner clears assignment. Delete removes the task and dependency references; reorder requires every Vorteo task ID exactly once. Initially list tasks in planned execution order. Keep completed items first in completion order, then in_progress items, then pending and blocked items in intended execution order. Reorder at status changes. Provider-owned tasks must be edited through their native tool. Read before retries after an error. Checklist updates do not authorize implementation, delegation, deployment, or restarts.",
      inputSchema: UpdateChecklistSchema,
      handler: async (input) => {
        const { mutation } = UpdateChecklistSchema.parse(input);
        const tasks = await manager.mutateChecklist(callerAgentId, mutation);
        return result({ tasks });
      },
    },
  ];
}
