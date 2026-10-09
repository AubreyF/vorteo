import { z } from "zod";
import { AgentGoalSchema } from "@getpaseo/protocol/agent-goals";
import type { AgentGoal, AgentGoalSetInput, AgentGoalState } from "@getpaseo/protocol/agent-goals";
import type { AgentManager } from "./agent-manager.js";

/** Native goal RPCs accept text only. Deliver attachments through the normal
 * prompt path while continuation is paused, then reconcile before activating. */
export async function setAgentGoalWithContext(input: {
  manager: Pick<AgentManager, "setAgentGoal" | "readAgentGoal">;
  agentId: string;
  goal: AgentGoalSetInput;
  clientMessageId?: string;
  sendContext?: () => Promise<void>;
}): Promise<AgentGoalState> {
  const { manager, agentId, goal, sendContext, clientMessageId } = input;
  if (!sendContext) return manager.setAgentGoal(agentId, goal, { clientMessageId });
  if (!goal.objective?.trim()) throw new Error("Goal attachments require an objective");
  const accepted = await manager.setAgentGoal(
    agentId,
    { ...goal, status: "paused" },
    { recordSubmission: false },
  );
  await sendContext();
  const current = await manager.readAgentGoal(agentId);
  if (
    !current.goal ||
    current.goal.objective !== accepted.goal?.objective ||
    current.goal.createdAt !== accepted.goal.createdAt
  ) {
    throw new Error(
      "The goal changed while its context was being sent. Review the current goal before continuing.",
    );
  }
  // A quick turn may already have completed or blocked the goal. Do not resume
  // it merely because the attachment submission has now been acknowledged.
  if (current.goal.status !== "paused") return current;
  return manager.setAgentGoal(agentId, { status: goal.status ?? "active" });
}

export const ThreadGoalEditSchema = z
  .object({
    expectedGoal: AgentGoalSchema.pick({
      threadId: true,
      objective: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      tokenBudget: true,
    }).strict(),
    expectedRevision: z.string().optional(),
    objective: z.string().trim().min(1).max(4000).optional(),
    status: z.enum(["active", "paused", "blocked", "complete"]).optional(),
  })
  .strict()
  .refine(
    (input) => input.objective !== undefined || input.status !== undefined,
    "Supply an objective or status to update",
  );
export type ThreadGoalEdit = z.infer<typeof ThreadGoalEditSchema>;

/** The manager serializes this read/compare/write with owner and queue edits. */
export async function editThreadGoal(input: {
  edit: ThreadGoalEdit;
  read: () => Promise<AgentGoalState>;
  set: (change: AgentGoalSetInput) => Promise<AgentGoalState>;
}): Promise<AgentGoalState> {
  const edit = ThreadGoalEditSchema.parse(input.edit);
  const current = await input.read();
  if (current.status !== "ready" || !current.goal)
    throw new Error("Read the current goal before editing it");
  const goal = current.goal;
  if (edit.expectedRevision !== undefined && edit.expectedRevision !== current.editRevision)
    throw new Error("The goal changed. Read it again before editing");
  for (const key of [
    "threadId",
    "objective",
    "status",
    "createdAt",
    "updatedAt",
    "tokenBudget",
  ] as const) {
    // COMPAT(goalEditRevision): older tools retain strict native timestamp checking.
    if (key === "updatedAt" && edit.expectedRevision !== undefined) continue;
    if (goal[key] !== edit.expectedGoal[key])
      throw new Error("The goal changed. Read it again before editing");
  }
  if (current.queueContinuationHeld || current.restartContinuationHeld)
    throw new Error("Goal editing is held until queued work or the installation restart finishes");
  if (
    edit.status !== undefined &&
    edit.status !== goal.status &&
    (goal.status === "budgetLimited" ||
      goal.status === "usageLimited" ||
      goal.status === "complete")
  )
    throw new Error(
      "This goal cannot be resumed by the thread. Review its completion or limits in goal controls",
    );
  const status = edit.status ?? goal.status;
  const next = await input.set({
    ...(edit.objective !== undefined ? { objective: edit.objective } : {}),
    status,
  });
  confirmGoalEdit(goal, edit, next, status);
  return next;
}

function confirmGoalEdit(
  goal: AgentGoal,
  edit: ThreadGoalEdit,
  next: AgentGoalState,
  status: AgentGoal["status"],
): void {
  if (
    next.status !== "ready" ||
    !next.goal ||
    next.goal.status !== status ||
    next.goal.objective !== (edit.objective ?? goal.objective) ||
    next.goal.threadId !== goal.threadId ||
    next.goal.createdAt !== goal.createdAt ||
    next.goal.tokenBudget !== goal.tokenBudget ||
    next.goal.tokensUsed < goal.tokensUsed
  )
    throw new Error("Goal edit could not be confirmed. Read the goal before retrying");
}
