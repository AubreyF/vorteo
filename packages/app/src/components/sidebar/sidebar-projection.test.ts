import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: "project" | "status") {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

describe("buildSidebarProjection", () => {
  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: pinned rows, grouped
      // rows, project headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const entry of projection.pinnedGroups.pinnedChats) {
        renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.pinnedGroups.unpinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });
});

it("keeps shortcuts in Standing section order and excludes collapsed standing work", () => {
  const input = twoProjectInput("project");
  const standing = makeWorkspace("standing");
  standing.entry.standing = true;
  input.workspaceEntriesByKey.set(standing.entry.workspaceKey, standing.entry);
  input.projects[0].workspaces.unshift(standing.placement);
  expect(
    buildSidebarProjection(input).shortcutModel.shortcutTargets.map((w) => w.workspaceId),
  ).toEqual(["first", "standing", "second"]);
  input.collapsedWorkspaceGroupKeys.add("standing:project");
  expect(
    buildSidebarProjection(input).shortcutModel.shortcutTargets.map((w) => w.workspaceId),
  ).toEqual(["first", "second"]);
});

it("keeps Factory shortcuts in rendered order and respects its collapsed section", () => {
  const input = twoProjectInput("project");
  const factory = makeWorkspace("factory");
  factory.entry.standing = true;
  factory.entry.factoryMembership = {
    installationId: "installation",
    serverId: "srv",
    projectId: "project",
    role: "factory",
  };
  const standing = makeWorkspace("standing");
  standing.entry.standing = true;
  for (const item of [standing, factory]) {
    input.workspaceEntriesByKey.set(item.entry.workspaceKey, item.entry);
    input.projects[0].workspaces.unshift(item.placement);
  }
  expect(
    buildSidebarProjection({
      ...input,
      factorySupportedHosts: new Map([["srv", true]]),
    }).shortcutModel.shortcutTargets.map((w) => w.workspaceId),
  ).toEqual(["first", "factory", "standing", "second"]);
  input.collapsedWorkspaceGroupKeys.add("factory:project");
  expect(
    buildSidebarProjection({
      ...input,
      factorySupportedHosts: new Map([["srv", true]]),
    }).shortcutModel.shortcutTargets.map((w) => w.workspaceId),
  ).toEqual(["first", "standing", "second"]);
});

function groupedRowIds(projection: ReturnType<typeof buildSidebarProjection>) {
  return projection.workspaceGroups.flatMap((group) => group.rows.map((row) => row.workspaceId));
}

function projectWorkspaceIds(projection: ReturnType<typeof buildSidebarProjection>) {
  return projection.pinnedGroups.unpinnedProjects.map((project) => [
    project.viewKey,
    project.workspaces.map((workspace) => workspace.workspaceId),
  ]);
}

describe("Vorteo System project", () => {
  function systemWorkspace(id: string, managed: boolean) {
    const { placement, entry } = makeWorkspace(id, "attention", [], "system:srv");
    return {
      placement,
      entry: {
        ...entry,
        // System-managed workspaces arrive standing and protected from the daemon.
        ...(managed ? { standing: true, systemMembership: { role: "optimization-runner" } } : {}),
        projectSystem: { kind: "vorteo-system" },
      } satisfies SidebarWorkspaceEntry,
    };
  }

  /** The System project sits between two ordinary projects, wherever the operator dragged it. */
  function systemInput(groupMode: "project" | "status") {
    const input = twoProjectInput(groupMode);
    const operator = systemWorkspace("notes", false);
    const runner = systemWorkspace("runner", true);
    for (const item of [operator, runner]) {
      input.workspaceEntriesByKey.set(item.entry.workspaceKey, item.entry);
    }
    input.projects.splice(1, 0, makeProject([runner.placement, operator.placement], "system:srv"));
    return input;
  }

  it("keeps the System project and all its workspaces in the normal project order", () => {
    const projection = buildSidebarProjection(systemInput("project"));

    expect(projectWorkspaceIds(projection)).toEqual([
      ["project", ["first"]],
      ["system:srv", ["runner", "notes"]],
      ["other-project", ["second"]],
    ]);
    expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
      "first",
      "notes",
      "runner",
      "second",
    ]);
  });

  it("groups System workspaces with every other workspace in status mode", () => {
    const projection = buildSidebarProjection(systemInput("status"));

    expect(groupedRowIds(projection).sort()).toEqual(["first", "notes", "runner", "second"]);
  });

  it("drops System shortcuts only when its project is collapsed, like any project", () => {
    const input = systemInput("project");
    input.collapsedProjectKeys.add("system:srv");

    expect(
      buildSidebarProjection(input).shortcutModel.shortcutTargets.map(
        (target) => target.workspaceId,
      ),
    ).toEqual(["first", "second"]);
  });
});
