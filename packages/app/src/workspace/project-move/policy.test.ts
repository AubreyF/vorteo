import { describe, expect, test } from "vitest";
import { placementForProjectMove, projectMoveBlockedReason } from "./policy";
test("protected moves explain the existing action; ordinary moves remain available", () => {
  expect(projectMoveBlockedReason({ protected: true })).toContain(
    "Turn off protection in Workspace actions",
  );
  expect(projectMoveBlockedReason({ protected: false })).toBeNull();
});

test("system-managed workspaces explain that Vorteo System owns their placement", () => {
  expect(projectMoveBlockedReason({ protected: true }, true)).toContain("Managed by Vorteo System");
  expect(projectMoveBlockedReason({ protected: false }, false)).toBeNull();
});

describe("moving the local project with the group", () => {
  const vorteo = {
    viewKey: "remote:github.com/acme/vorteo",
    projectKey: "remote:github.com/acme/vorteo",
    projectName: "Vorteo",
    projectKind: "non_git" as const,
    iconWorkingDir: "/work/vorteo",
    hosts: [
      {
        serverId: "host",
        projectId: "prj-vorteo",
        iconWorkingDir: "/work/vorteo",
        worktreeSupport: "unsupported" as const,
      },
    ],
    workspaceKeys: [],
  };

  test("moves a folder workspace into the group's single local project", () => {
    expect(
      placementForProjectMove({
        workspace: { projectId: "prj-dev", workspaceKind: "directory" },
        target: vorteo,
        serverId: "host",
      }),
    ).toBe("prj-vorteo");
  });

  test("leaves worktrees, same-project moves and hosts without one placement alone", () => {
    expect(
      placementForProjectMove({
        workspace: { projectId: "prj-dev", workspaceKind: "worktree" },
        target: vorteo,
        serverId: "host",
      }),
    ).toBeUndefined();
    expect(
      placementForProjectMove({
        workspace: { projectId: "prj-dev", workspaceKind: "local_checkout" },
        target: vorteo,
        serverId: "host",
      }),
    ).toBeUndefined();
    expect(
      placementForProjectMove({
        workspace: { projectId: "prj-vorteo", workspaceKind: "directory" },
        target: vorteo,
        serverId: "host",
      }),
    ).toBeUndefined();
    expect(
      placementForProjectMove({
        workspace: { projectId: "prj-dev", workspaceKind: "directory" },
        target: vorteo,
        serverId: "other-mac",
      }),
    ).toBeUndefined();
  });
});
