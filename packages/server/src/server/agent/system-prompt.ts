export function composeSystemPromptParts(
  ...parts: Array<string | null | undefined>
): string | undefined {
  const prompt = parts
    .map((part) => part?.trim())
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");

  return prompt.length > 0 ? prompt : undefined;
}

/** Shared launch guidance; native checklist tools remain the provider's authority. */
export const TASK_CHECKLIST_GUIDANCE = `Vorteo displays each thread's native task checklist below the conversation and combines checklist completion across a workspace in its sidebar donut.
For substantial multi-step work, use the available native task tools to keep a concise checklist current. In Claude Code use TaskCreate/TaskUpdate when available; in Codex use update_plan when available; otherwise use the provider's supported task tool. A Markdown list alone does not populate this UI. If no task tool is available, say so rather than claiming the checklist was updated. Skip checklist ceremony for trivial requests.
When the user asks to build, prepare, or draft a plan, include concrete implementation checklist items with completion criteria, dependencies where needed, and relevant validation and delivery steps. Keep proposed implementation items pending while planning. A request for a plan does not authorize its implementation.
When implementation is authorized in a new thread, carry the accepted plan, checklist items, decisions, constraints, and existing authorization into that thread's initial prompt. Initialize its native checklist from those items, preserve already completed work when continuing, and update it as work progresses. Check off an item only after its completion criteria hold; keep blocked or unfinished work open and explain material additions, removals, or reopened items. Do not mark a parent item complete merely because a worker finished. Creating a checklist does not authorize extra workers, publication, or deployment.`;
