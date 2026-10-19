import { petalFills, taskPetals } from "@/task-checklist/flower";
import {
  checklistPercent,
  checklistProgress,
  workspaceChecklistProgress,
} from "@/task-checklist/progress";
import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { aggregateProjectTasks } from "./project-task-summary";

function entry(
  key: string,
  projectViewKey: string,
  diffStat: SidebarWorkspaceEntry["diffStat"],
): SidebarWorkspaceEntry {
  return {
    workspaceKey: key,
    projectViewKey,
    serverId: "server",
    workspaceId: key,
    projectName: projectViewKey,
    projectKind: "git",
    workspaceKind: "worktree",
    name: key,
    workspaceDirectory: "/repo",
    workspaceDirectoryLabel: "/repo",
    title: null,
    currentBranch: null,
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

describe("project task totals", () => {
  it("counts all open tasks including done, pinned and tasks without git changes", () => {
    const tasks = [
      entry("one", "a", { additions: 154, deletions: 44 }),
      { ...entry("two", "a", { additions: 154, deletions: 44 }), pinnedAt: "2026-09-10" },
      entry("three", "a", null),
      entry("other", "b", { additions: 999, deletions: 999 }),
    ];
    expect(
      aggregateProjectTasks("a", new Map(tasks.map((task) => [task.workspaceKey, task]))),
    ).toEqual({ count: 3, additions: 154, deletions: 44 });
  });
  it("counts eight tasks sharing a checkout without multiplying their diff", () => {
    const tasks = Array.from({ length: 8 }, (_, index) =>
      entry(String(index), "a", { additions: 1700, deletions: 222 }),
    );
    expect(
      aggregateProjectTasks("a", new Map(tasks.map((task) => [task.workspaceKey, task]))),
    ).toEqual({ count: 8, additions: 1700, deletions: 222 });
  });
  it("sums distinct directories and hosts even when their diff numbers match", () => {
    const tasks = [
      entry("one", "a", { additions: 10, deletions: 2 }),
      {
        ...entry("two", "a", { additions: 10, deletions: 2 }),
        workspaceDirectory: "/other-worktree",
      },
      { ...entry("three", "a", { additions: 10, deletions: 2 }), serverId: "other-host" },
    ];
    expect(
      aggregateProjectTasks("a", new Map(tasks.map((task) => [task.workspaceKey, task]))),
    ).toEqual({ count: 3, additions: 30, deletions: 6 });
  });
  it("uses a loaded diff when another task has none and normalizes trailing separators", () => {
    const tasks = [
      entry("loading", "a", null),
      entry("loaded", "a", { additions: 10, deletions: 2 }),
      { ...entry("alias", "a", { additions: 10, deletions: 2 }), workspaceDirectory: "/repo/" },
    ];
    expect(
      aggregateProjectTasks("a", new Map(tasks.map((task) => [task.workspaceKey, task]))),
    ).toEqual({ count: 3, additions: 10, deletions: 2 });
  });
  it("shows zero totals for an empty project", () => {
    expect(aggregateProjectTasks("empty", new Map())).toEqual({
      count: 0,
      additions: 0,
      deletions: 0,
    });
  });
});

describe("workspace checklist completion", () => {
  it("sums checklist entities across threads rather than averaging percentages", () => {
    const agents = [
      { id: "one", workspaceId: "w", tasks: [{ id: "1", text: "Done", completed: true }] },
      {
        id: "two",
        workspaceId: "w",
        tasks: Array.from({ length: 3 }, (_, index) => ({
          id: String(index + 1),
          text: "Open",
          completed: false,
        })),
      },
      { id: "other", workspaceId: "other", tasks: [{ text: "Excluded", completed: true }] },
      {
        id: "archived",
        workspaceId: "w",
        archivedAt: new Date(),
        tasks: [{ text: "Excluded", completed: true }],
      },
      { id: "pending", workspaceId: "w", tasks: [{ text: "Excluded", completed: true }] },
    ];
    expect(workspaceChecklistProgress(agents, "w", new Set(["pending"]))).toMatchObject({
      active: 0,
      completed: 1,
      total: 4,
    });
  });
  it("counts status-only completion and preserves an empty checklist", () => {
    expect(
      checklistProgress([{ text: "Done", completed: false, status: "completed" }]),
    ).toMatchObject({
      active: 0,
      completed: 1,
      total: 1,
    });
    expect(checklistProgress([{ text: "Waiting", completed: false, status: "blocked" }])).toEqual({
      completed: 0,
      active: 0,
      blocked: 1,
      credit: 0,
      total: 1,
    });
    expect(
      checklistProgress([{ text: "Approval", completed: false, status: "review" }]),
    ).toMatchObject({
      completed: 0,
      active: 0,
      total: 1,
    });
    expect(checklistProgress([])).toEqual({
      completed: 0,
      active: 0,
      blocked: 0,
      credit: 0,
      total: 0,
    });
    expect(
      workspaceChecklistProgress([{ id: "new", workspaceId: "w" }], "w", new Set()),
    ).toMatchObject({
      active: 0,
      completed: 0,
      total: 0,
    });
  });
});

describe("task flower progress", () => {
  it("counts active provider and managed tasks without counting completed tasks twice", () => {
    const progress = checklistProgress([
      { text: "Provider active", completed: false, status: "in_progress" },
      { text: "Managed active", completed: false, status: "in_progress" },
      { text: "Done", completed: true, status: "in_progress" },
      { text: "Pending", completed: false },
    ]);
    expect(progress).toEqual({ completed: 1, active: 2, blocked: 0, credit: 1, total: 4 });
    expect(taskPetals(progress)).toEqual(["completed", "active", "active", "pending"]);
  });
  it("renders no empty petals and one petal for a single task", () => {
    expect(taskPetals({ completed: 0, active: 0, total: 0 })).toEqual([]);
    expect(taskPetals({ completed: 0, active: 1, total: 1 })).toEqual(["active"]);
    expect(taskPetals({ completed: 1, active: 0, total: 2 })).toEqual(["completed", "pending"]);
  });
  it("keeps individual active counts through twelve tasks", () => {
    expect(taskPetals({ completed: 8, active: 3, total: 12 })).toEqual([
      ...Array(8).fill("completed"),
      ...Array(3).fill("active"),
      "pending",
    ]);
  });
  it("summarizes 33 and 300 tasks with twelve petals and one activity signal", () => {
    for (const progress of [
      { completed: 22, active: 4, total: 33 },
      { completed: 200, active: 50, total: 300 },
    ]) {
      expect(taskPetals(progress)).toEqual([
        ...Array(8).fill("completed"),
        "active",
        ...Array(3).fill("pending"),
      ]);
    }
  });
  it("never looks complete before the final task finishes", () => {
    for (const total of [13, 33, 300]) {
      expect(taskPetals({ completed: total - 1, active: 0, total })).toEqual([
        ...Array(11).fill("completed"),
        "pending",
      ]);
      expect(taskPetals({ completed: total, active: 0, total })).toEqual(
        Array(12).fill("completed"),
      );
    }
  });
});

describe("partial task progress", () => {
  it("adds partial credit from unfinished items and keeps blocked work counted", () => {
    const progress = checklistProgress([
      { text: "Done", completed: true, status: "completed" },
      { text: "Halfway", completed: false, status: "in_progress", progress: 50 },
      { text: "Stalled", completed: false, status: "blocked", progress: 40 },
      { text: "Not started", completed: false },
    ]);
    expect(progress).toEqual({ completed: 1, active: 1, blocked: 1, credit: 1.9, total: 4 });
    expect(checklistPercent(progress)).toBe(48);
  });

  it("sums items across threads rather than averaging thread percentages", () => {
    const agents = [
      {
        id: "a",
        workspaceId: "w",
        tasks: Array.from({ length: 5 }, (_, index) => ({
          text: `A${index}`,
          completed: index < 3,
          ...(index === 3 ? { progress: 60 } : {}),
        })),
      },
      {
        id: "b",
        workspaceId: "w",
        tasks: [
          { text: "B done", completed: true },
          { text: "B blocked", completed: false, status: "blocked" as const, progress: 40 },
          { text: "B pending", completed: false },
        ],
      },
    ];
    const progress = workspaceChecklistProgress(agents, "w", new Set());
    expect(progress.credit).toBeCloseTo(5);
    expect(checklistPercent(progress)).toBe(63);
  });

  it("fills petals partway up to the credit", () => {
    expect(petalFills({ credit: 1.5, total: 3 })).toEqual([1, 0.5, 0]);
    expect(petalFills({ credit: 12, total: 24 })).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  });
});
