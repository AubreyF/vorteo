import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";

export interface TaskProgressSummary {
  percent: number;
  /** Checks are evidence; an estimate is the agent's judgment and is labeled as one. */
  source: "checks" | "estimate";
  passed: number;
  checks: number;
}

/** Progress worth showing for an unfinished item, or null when it has none to report. */
export function taskProgressSummary(task: AgentTaskItem): TaskProgressSummary | null {
  if (task.completed || task.status === "completed") return null;
  const checks = task.checks ?? [];
  const passed = checks.filter((check) => check.done).length;
  const percent = task.progress ?? 0;
  if (checks.length === 0 && percent <= 0) return null;
  return {
    percent,
    source: checks.length > 0 ? "checks" : "estimate",
    passed,
    checks: checks.length,
  };
}

/** Short row label: "65%" when checks decide it, "50% est." for an estimate. */
export function taskProgressLabel(summary: TaskProgressSummary): string {
  return summary.source === "checks" ? `${summary.percent}%` : `${summary.percent}% est.`;
}

/** Longer description for tooltips and the details sheet. */
export function taskProgressDescription(summary: TaskProgressSummary): string {
  return summary.source === "checks"
    ? `${summary.passed} of ${summary.checks} checks passed · ${summary.percent}%`
    : `${summary.percent}% estimated`;
}

/**
 * Stable keys for a check list. Texts may repeat, so repeats are numbered by occurrence; the key
 * still follows the text when checks are reordered.
 */
export function checkKeys(checks: readonly { text: string }[]): string[] {
  const seen = new Map<string, number>();
  return checks.map(({ text }) => {
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return count === 0 ? text : `${text}#${count + 1}`;
  });
}
