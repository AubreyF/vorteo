import { z } from "zod";
import {
  AgentGoalSchema,
  type AgentGoal,
  type AgentGoalState,
  type AgentGoalSetInput,
} from "@getpaseo/protocol/agent-goals";

export const QueueGoalHoldSchema = z.object({
  phase: z.enum(["pausing", "held", "resuming"]),
  reason: z.literal("restart").optional(),
  restartRequestId: z.string().min(1).optional(),
  goal: AgentGoalSchema,
});
export type QueueGoalHold = z.infer<typeof QueueGoalHoldSchema>;

/** A repeated Play press must not activate native continuation ahead of the queue. */
export async function setGoalWithQueueOwnership(
  input: AgentGoalSetInput,
  port: Pick<QueueGoalPort, "read" | "hold" | "persist">,
  set: (input: AgentGoalSetInput) => Promise<AgentGoalState>,
): Promise<AgentGoalState> {
  if (
    input.status === "active" &&
    input.objective === undefined &&
    input.tokenBudget === undefined
  ) {
    const state = projectQueueGoalState(await port.read(), port.hold());
    if (state.status === "ready" && state.queueContinuationHeld) return state;
  }
  // Explicit edits and pauses take ownership from the queue. Ambiguous or stale
  // holds must also go through the provider, never appear as a successful resume.
  await port.persist(undefined);
  return set(input);
}

export interface QueueGoalPort {
  hold(): QueueGoalHold | undefined;
  persist(hold: QueueGoalHold | undefined): Promise<void>;
  read(): Promise<AgentGoalState>;
  set(status: "blocked" | "paused" | "active"): Promise<AgentGoalState>;
  mayResume(): Promise<boolean>;
  prepareResume?(): Promise<void>;
  mayRemainActive(): Promise<boolean>;
  canPause(): boolean;
}

function sameGoal(left: AgentGoal, right: AgentGoal): boolean {
  return (
    left.threadId === right.threadId &&
    left.createdAt === right.createdAt &&
    left.objective === right.objective &&
    left.tokenBudget === right.tokenBudget
  );
}

/** Caller serializes this with explicit goal edits. Persist intent first so a
 * crash in the provider RPC leaves a reviewable pause, never a guessed resume. */
export async function pauseGoalForQueue(
  port: QueueGoalPort,
  reason?: "restart",
  restartRequestId?: string,
): Promise<void> {
  if (!port.canPause()) return;
  const state = await port.read();
  if (state.status !== "ready")
    throw new Error("The goal state must be confirmed before queue delivery.");
  if (!state.goal || state.goal.status !== "active") return;
  const original = state.goal;
  if (!port.canPause()) return;
  await port.persist({ phase: "pausing", goal: original, reason, restartRequestId });
  const paused = await port.set("blocked");
  if (!port.canPause() || port.hold()?.phase !== "pausing") {
    await port.persist(undefined);
    return;
  }
  if (
    paused.status !== "ready" ||
    !paused.goal ||
    paused.goal.status !== "blocked" ||
    !sameGoal(original, paused.goal)
  )
    throw new Error("The goal block could not be confirmed. Review the goal before continuing.");
  await port.persist({ phase: "held", goal: paused.goal, reason, restartRequestId });
}

export async function resumeGoalAfterQueue(port: QueueGoalPort): Promise<void> {
  const hold = port.hold();
  if (!hold || hold.phase !== "held" || !(await port.mayResume())) return;
  const current = await port.read();
  if (current.status !== "ready") return;
  const goal = current.goal;
  if (
    !goal ||
    !isOwnedHoldStatus(goal, hold) ||
    !sameGoal(hold.goal, goal) ||
    goal.updatedAt !== hold.goal.updatedAt ||
    (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget)
  ) {
    // A new objective, explicit pause or provider-side change owns its state.
    await port.persist(undefined);
    return;
  }
  // Quota preflight can fail without contacting the provider. Keep the confirmed
  // hold retryable rather than recording an ambiguous native resume intent.
  await port.prepareResume?.();
  if (!(await port.mayResume())) return;
  await port.persist({ ...hold, phase: "resuming" });
  if (!(await port.mayResume())) {
    await port.persist(hold);
    return;
  }
  const resumed = await port.set("active");
  if (
    resumed.status !== "ready" ||
    !resumed.goal ||
    !sameGoal(hold.goal, resumed.goal) ||
    resumed.goal.status !== "active"
  )
    throw new Error("The goal resume could not be confirmed. Review the goal before continuing.");
  // A stop or new queued work can arrive during the provider RPC.
  if (!(await port.mayRemainActive())) return pauseResumedGoal(port, hold);
  await port.persist(undefined);
}

async function pauseResumedGoal(port: QueueGoalPort, hold: QueueGoalHold): Promise<void> {
  const paused = await port.set("blocked");
  if (
    paused.status !== "ready" ||
    !paused.goal ||
    !sameGoal(hold.goal, paused.goal) ||
    paused.goal.status !== "blocked"
  )
    throw new Error("The goal stop could not be confirmed. Review the goal before continuing.");
  // New queued work still owns continuation; task Stop revokes that ownership.
  await port.persist(port.canPause() ? { ...hold, phase: "held", goal: paused.goal } : undefined);
}

function isOwnedHoldStatus(goal: AgentGoal, hold: QueueGoalHold): boolean {
  // COMPAT(queuePausedHold): receipts written before automatic waits used
  // blocked may still own a paused goal. Never adopt a pause without its receipt.
  return (
    goal.status === hold.goal.status && (goal.status === "blocked" || goal.status === "paused")
  );
}

/** Preserve native status while exposing who owns a confirmed temporary block. */
export function projectQueueGoalState(
  state: AgentGoalState,
  hold: QueueGoalHold | undefined,
): AgentGoalState {
  if (state.status !== "ready") return state;
  const goal = state.goal;
  return {
    ...state,
    restartContinuationHeld: Boolean(
      hold?.reason === "restart" &&
      hold.phase === "held" &&
      goal &&
      isOwnedHoldStatus(goal, hold) &&
      sameGoal(hold.goal, goal) &&
      hold.goal.updatedAt === goal.updatedAt,
    ),
    queueContinuationHeld: Boolean(
      hold?.phase === "held" &&
      goal &&
      isOwnedHoldStatus(goal, hold) &&
      sameGoal(hold.goal, goal) &&
      hold.goal.updatedAt === goal.updatedAt,
    ),
  };
}
