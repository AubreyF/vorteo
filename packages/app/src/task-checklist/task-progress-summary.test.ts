import { describe, expect, it } from "vitest";
import {
  checkKeys,
  taskProgressDescription,
  taskProgressLabel,
  taskProgressSummary,
} from "./task-progress-summary";

describe("task progress summary", () => {
  it("labels check-derived progress as evidence and estimates as estimates", () => {
    const checked = taskProgressSummary({
      text: "Ship",
      completed: false,
      progress: 65,
      checks: [
        { text: "A", done: true },
        { text: "B", done: true },
        { text: "C", done: false },
      ],
    })!;
    expect(taskProgressLabel(checked)).toBe("65%");
    expect(taskProgressDescription(checked)).toBe("2 of 3 checks passed · 65%");

    const estimated = taskProgressSummary({ text: "Ship", completed: false, progress: 50 })!;
    expect(taskProgressLabel(estimated)).toBe("50% est.");
    expect(taskProgressDescription(estimated)).toBe("50% estimated");
  });

  it("shows nothing for finished items or items without progress", () => {
    expect(taskProgressSummary({ text: "Done", completed: true, progress: 100 })).toBeNull();
    expect(taskProgressSummary({ text: "Fresh", completed: false })).toBeNull();
    expect(taskProgressSummary({ text: "Zero", completed: false, progress: 0 })).toBeNull();
  });

  it("still lists checks before any pass", () => {
    expect(
      taskProgressSummary({ text: "New", completed: false, checks: [{ text: "A", done: false }] }),
    ).toEqual({ percent: 0, source: "checks", passed: 0, checks: 1 });
  });
});

describe("check keys", () => {
  it("keeps repeated check texts distinct", () => {
    expect(checkKeys([{ text: "Tests pass" }, { text: "Docs" }, { text: "Tests pass" }])).toEqual([
      "Tests pass",
      "Docs",
      "Tests pass#2",
    ]);
  });
});
