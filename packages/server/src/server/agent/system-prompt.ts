export function composeSystemPromptParts(
  ...parts: Array<string | null | undefined>
): string | undefined {
  const prompt = parts
    .map((part) => part?.trim())
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");

  return prompt.length > 0 ? prompt : undefined;
}

/** Shared launch guidance for persistent thread checklists. */
export const TASK_CHECKLIST_GUIDANCE = `Vorteo displays each thread's native task checklist below the conversation and combines checklist completion across a workspace in its sidebar donut.
For substantial multi-step work, read get_checklist first and use update_checklist to keep a concise persistent checklist current. These tools belong to the current thread. Create pending items with completion criteria in description; use returned IDs to update status, dependencies, ownership, or details. Do not duplicate existing native provider tasks: use their native tools to update those items. If Vorteo checklist tools are unavailable, use Claude TaskCreate/TaskUpdate, Codex update_plan, or the provider's supported task tool when available. A Markdown list alone does not populate this UI. If no task tool is available, say so rather than claiming the checklist was updated. Skip checklist ceremony for trivial requests.
When the user asks to build, prepare, or draft a plan, include concrete implementation checklist items with completion criteria, dependencies where needed, and relevant validation and delivery steps. Keep proposed implementation items pending while planning. A request for a plan does not authorize its implementation.
When implementation is authorized in a new thread, carry the accepted plan, checklist items, decisions, constraints, and existing authorization into that thread's initial prompt. Initialize its checklist from those items, preserve already completed work when continuing, and update it as work progresses. Check off an item only after its completion criteria hold; keep blocked or unfinished work open and explain material additions, removals, or reopened items. Do not mark a parent item complete merely because a worker finished. Creating a checklist does not authorize extra workers, publication, or deployment.`;
