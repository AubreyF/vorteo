import { describe, expect, it } from "vitest";
import {
  getProjectRemoveReadiness,
  removeProjectFromHosts,
  type ProjectRemoveProject,
} from "./project-remove";

const project: ProjectRemoveProject = {
  hosts: [
    { serverId: "host-a", projectId: "prj_host_a" },
    { serverId: "host-b", projectId: "prj_host_b" },
  ],
};

function createProjectRemoveClient() {
  const removedProjectKeys: string[] = [];
  const archivedWorkspaceIds: string[] = [];
  return {
    removedProjectKeys,
    archivedWorkspaceIds,
    client: {
      async archiveWorkspace(workspaceId: string) {
        archivedWorkspaceIds.push(workspaceId);
        return {
          workspaceId,
          requestId: "archive",
          archivedAt: "2026-10-05T00:00:00Z",
          error: null,
        };
      },
      async removeProject(projectKey: string): Promise<{ removedWorkspaceIds: string[] }> {
        removedProjectKeys.push(projectKey);
        return { removedWorkspaceIds: [] };
      },
    },
  };
}

describe("project remove policy", () => {
  it("archives members in environments with no local project registration", async () => {
    const host = createProjectRemoveClient();
    const outcome = await removeProjectFromHosts({
      targets: [],
      workspaces: [{ serverId: "host", workspaceId: "moved-work" }],
      getClient: () => host.client,
    });
    expect(outcome.kind).toBe("removed");
    expect(host.archivedWorkspaceIds).toEqual(["moved-work"]);
    expect(host.removedProjectKeys).toEqual([]);
  });

  it("requires every host to support project removal", () => {
    const readiness = getProjectRemoveReadiness({
      project,
      supportsProjectRemove: (serverId) => serverId === "host-a",
    });

    expect(readiness).toEqual({
      kind: "needs_host_update",
      serverIds: ["host-b"],
    });
  });

  it("removes the project from every participating host", async () => {
    const hostA = createProjectRemoveClient();
    const hostB = createProjectRemoveClient();
    const readiness = getProjectRemoveReadiness({
      project,
      supportsProjectRemove: () => true,
    });

    expect(readiness).toEqual({
      kind: "ready",
      targets: [
        { serverId: "host-a", projectId: "prj_host_a" },
        { serverId: "host-b", projectId: "prj_host_b" },
      ],
    });

    const outcome = await removeProjectFromHosts({
      targets: readiness.kind === "ready" ? readiness.targets : [],
      getClient: (serverId) => {
        if (serverId === "host-a") return hostA.client;
        if (serverId === "host-b") return hostB.client;
        return null;
      },
    });

    expect(outcome).toEqual({ kind: "removed", serverIds: ["host-a", "host-b"] });
    expect(hostA.removedProjectKeys).toEqual(["prj_host_a"]);
    expect(hostB.removedProjectKeys).toEqual(["prj_host_b"]);
  });

  it("reports disconnected hosts before sending any remove request", async () => {
    const hostA = createProjectRemoveClient();

    const outcome = await removeProjectFromHosts({
      targets: [
        { serverId: "host-a", projectId: "prj_host_a" },
        { serverId: "host-b", projectId: "prj_host_b" },
      ],
      getClient: (serverId) => (serverId === "host-a" ? hostA.client : null),
    });

    expect(outcome).toEqual({ kind: "host_disconnected", serverIds: ["host-b"] });
    expect(hostA.removedProjectKeys).toEqual([]);
  });
});
