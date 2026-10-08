import { workspaceChecklistProgress, checklistProgress } from "@/task-checklist/progress";
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
    expect(workspaceChecklistProgress(agents, "w", new Set(["pending"]))).toEqual({
      completed: 1,
      total: 4,
    });
  });
  it("counts status-only completion and preserves an empty checklist", () => {
    expect(checklistProgress([{ text: "Done", completed: false, status: "completed" }])).toEqual({
      completed: 1,
      total: 1,
    });
    expect(checklistProgress([])).toEqual({ completed: 0, total: 0 });
    expect(workspaceChecklistProgress([{ id: "new", workspaceId: "w" }], "w", new Set())).toEqual({
      completed: 0,
      total: 0,
    });
  });
});
