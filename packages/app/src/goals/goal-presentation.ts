import type { QueueSnapshot } from "@getpaseo/protocol/message-queue";
import { isQueueGoalError, queueGoalRecoveryMessage } from "@/message-queue/goal-error";
import type { AgentGoal, AgentGoalState } from "@getpaseo/protocol/agent-goals";

export const GOAL_STATUS_LABELS: Record<AgentGoal["status"], string> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usageLimited: "Usage limit reached",
  budgetLimited: "Goal budget reached",
  complete: "Goal complete",
};

export function formatGoalElapsed(seconds: number): string {
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function goalElapsedAt(
  state: import("@getpaseo/protocol/agent-goals").AgentGoalState | undefined,
  ticking: boolean,
  secondsSinceObservation: number,
): number {
  const goal = state?.goal;
  if (!goal) return 0;
  if (!ticking || state.status !== "ready" || goal.status !== "active") return goal.timeUsedSeconds;
  // Use the daemon's observation clock, not the phone's wall clock. Native usage
  // is checkpointed, so repeated reads must not restart the visible elapsed time.
  const observed = Date.parse(state.observedAt) / 1000;
  const pending = Number.isFinite(observed) ? Math.max(0, observed - goal.updatedAt) : 0;
  return goal.timeUsedSeconds + pending + Math.max(0, secondsSinceObservation);
}

// Reconnecting does not make a cached goal authoritative again. The native read
// must finish before destructive controls become available.
export function goalQueryConfirmed(isDraft: boolean, fetching: boolean, error: unknown): boolean {
  return isDraft || (!fetching && !error);
}

export function isGoalContinuationEnabled(state: AgentGoalState | undefined): boolean {
  return (
    state?.goal?.status === "active" ||
    (state?.status === "ready" && state.queueContinuationHeld === true)
  );
}

export function goalStatusLabel(state: AgentGoalState | undefined): string {
  if (state?.status !== "ready") return "Goal state unconfirmed";
  if (state.restartContinuationHeld) return "Goal paused for restart";
  if (state.queueContinuationHeld) return "Goal (waiting for messages)";
  return state.goal ? GOAL_STATUS_LABELS[state.goal.status] : "No goal";
}

export interface GoalQueueNotice {
  status: "waiting for messages" | "needs attention";
  message: string;
  action?: "goal" | "messages";
}

export function goalQueueNotice(
  state: AgentGoalState | undefined,
  queue: QueueSnapshot | null | undefined,
  readError?: string | null,
): GoalQueueNotice | null {
  if (queue?.deliveryError && isQueueGoalError(queue.deliveryError)) {
    return {
      status: "needs attention",
      message: queueGoalRecoveryMessage(queue.deliveryError),
      action: "goal",
    };
  }
  if (state?.status !== "ready" || state.restartContinuationHeld || !state.queueContinuationHeld)
    return null;
  if (readError) {
    return {
      status: "needs attention",
      message: `Queued messages could not be synchronized: ${readError}`,
      action: "messages",
    };
  }
  // Only the head message controls delivery. A later failed item is not yet
  // the reason this goal is waiting.
  const delivery = queue?.items[0]?.delivery;
  if (delivery?.status === "uncertain") {
    return {
      status: "needs attention",
      message: `Message delivery could not be confirmed: ${delivery.reason}. Review the queued message before retrying; it may already have been sent.`,
      action: "messages",
    };
  }
  if (delivery?.status === "failed") {
    return {
      status: "needs attention",
      message: `Message delivery failed: ${delivery.reason}`,
      action: "messages",
    };
  }
  if (queue?.deliveryError) {
    return {
      status: "needs attention",
      message: `Message delivery stopped: ${queue.deliveryError}`,
      action: "messages",
    };
  }
  return {
    status: "waiting for messages",
    message: "Queued messages take priority. The goal will continue automatically afterward.",
  };
}
