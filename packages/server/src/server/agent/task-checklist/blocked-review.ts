import type { StoredAgentRecord } from "../agent-storage.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

export const BLOCKED_REVIEW_INTERVAL_MS = 60 * 60 * 1000;

/** This is an ordinary thread review, never a second governor or worker scheduler. */
export function hasReviewableBlockedWork(record: StoredAgentRecord): boolean {
  const externallyOwned = record.owner || record.config?.controllerExecutionId;
  // A thread waiting for a usage limit to reset is resumed by UsageLimitResumeService instead.
  const usageLimited = record.config?.usageLimitHold && !record.config.usageLimitHold.releasedAt;
  const held =
    record.archivedAt ||
    record.internal ||
    record.queueGoalHold ||
    record.config?.quotaPausedAt ||
    usageLimited;
  const delegated = record.labels[PARENT_AGENT_ID_LABEL];
  if (externallyOwned || held || delegated || !record.persistence?.sessionId) return false;
  return (
    record.blockedGoalReviewNeeded === true ||
    (record.tasks ?? []).some((task) => !task.completed && task.status === "blocked")
  );
}

export function blockedReviewDue(record: StoredAgentRecord, now: number): boolean {
  if (!hasReviewableBlockedWork(record)) return false;
  const timestamps = [record.createdAt, record.lastActivityAt, record.lastBlockedReviewAt];
  const parsed = timestamps.filter((value): value is string => value !== undefined).map(Date.parse);
  if (!parsed.every(Number.isFinite)) return false;
  return now - Math.max(...parsed) >= BLOCKED_REVIEW_INTERVAL_MS;
}

export const BLOCKED_REVIEW_PROMPT =
  "Periodic blocked-work review. Read your current checklist, goal and recent conversation, then recheck the concrete " +
  "conditions that blocked your work. Use current evidence. If a blocker has cleared, update the " +
  "task and continue the owner's authorized work; edit or resume your own blocked goal when appropriate. " +
  "If it remains, record a concise reason and the next condition to check, then end this turn. " +
  "Do not repeat requests already awaiting the owner, create workers, override an owner pause, " +
  "raise budgets, or bypass queue, restart, account or permission holds. This review grants no new authority.";
