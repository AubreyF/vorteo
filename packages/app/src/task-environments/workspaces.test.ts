import { expect, test } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { workspaceEnvironmentMembers } from "./workspaces";
import { buildWorkspaceStructureProjects } from "@/projects/workspace-structure";

function workspace(
  id: string,
  owner?: { serverId: string; workspaceId: string },
): WorkspaceDescriptor {
  return {
    id,
    projectId: "project",
    projectDisplayName: "Repo",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "Task",
    status: "done",
    statusEnteredAt: null,
    diffStat: null,
    archivingAt: null,
    scripts: [],
    projectMembership: {
      key: "project",
      name: "Project",
      ...(owner ? { environmentOwner: owner } : {}),
    },
  };
}

test("groups only explicitly associated workspaces and leaves unrelated tasks alone", () => {
  const owner = { serverId: "host", workspaceId: "original" };
  const original = workspace("original");
  const companion = workspace("companion", owner);
  const unrelated = workspace("unrelated");
  const sessions = {
    host: { workspaces: new Map([[original.id, original]]) },
    container: {
      workspaces: new Map([
        [companion.id, companion],
        [unrelated.id, unrelated],
      ]),
    },
  };
  expect(workspaceEnvironmentMembers(sessions, owner)).toEqual([
    owner,
    { serverId: "container", workspaceId: "companion" },
  ]);
  const projects = buildWorkspaceStructureProjects({
    sessions: Object.entries(sessions).map(([serverId, session]) => ({
      serverId,
      projects: [],
      workspaces: session.workspaces.values(),
    })),
  });
  expect(projects[0]?.workspaceKeys.sort()).toEqual(["container:unrelated", "host:original"]);
});

test("keeps a companion accessible when its original workspace no longer exists", () => {
  const companion = workspace("companion", { serverId: "host", workspaceId: "missing" });
  const reference = { serverId: "container", workspaceId: "companion" };
  const sessions = { container: { workspaces: new Map([[companion.id, companion]]) } };
  expect(workspaceEnvironmentMembers(sessions, reference)).toEqual([reference]);
  const projects = buildWorkspaceStructureProjects({
    sessions: [{ serverId: "container", projects: [], workspaces: [companion] }],
  });
  expect(projects[0]?.workspaceKeys).toEqual(["container:companion"]);
});
