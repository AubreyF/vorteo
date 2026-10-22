import { expect, test } from "vitest";
import { resolveProjectDirectory, resolveTaskDirectory } from "./directory";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";

test("maps the exact worktree through shared roots rather than choosing a project directory", async () => {
  const requests: unknown[] = [];
  const source: Pick<DaemonClient, "browseProjectDirectories" | "getLastServerInfoMessage"> = {
    getLastServerInfoMessage: () => null,
    async browseProjectDirectories() {
      return {
        requestId: "source",
        error: null,
        errorCode: null,
        directory: null,
        roots: [{ id: "dev", label: "Dev", containerPath: "/mnt/dev", hostPath: "/Users/me/dev" }],
      };
    },
  };
  const destination: Pick<DaemonClient, "browseProjectDirectories" | "getLastServerInfoMessage"> = {
    getLastServerInfoMessage: () => null,
    async browseProjectDirectories(request) {
      requests.push(request);
      return {
        requestId: "destination",
        error: null,
        errorCode: null,
        roots: [],
        directory: {
          rootId: "home",
          path: "dev/task-tree",
          parent: "dev",
          containerPath: "/Users/me/dev/task-tree",
          hostPath: "/Users/me/dev/task-tree",
          entries: [],
          nextOffset: null,
        },
      };
    },
  };
  expect(await resolveTaskDirectory({ source, destination, directory: "/mnt/dev/task-tree" })).toBe(
    "/Users/me/dev/task-tree",
  );
  expect(requests).toEqual([{ hostPath: "/Users/me/dev/task-tree" }]);
});

test("does not substitute home when a workspace is not shared", async () => {
  const source: Pick<DaemonClient, "browseProjectDirectories" | "getLastServerInfoMessage"> = {
    getLastServerInfoMessage: () => null,
    async browseProjectDirectories() {
      return {
        requestId: "source",
        error: null,
        errorCode: null,
        directory: null,
        roots: [{ id: "home", label: "Home", containerPath: "/home/guest", hostPath: null }],
      };
    },
  };
  const destination: Pick<DaemonClient, "browseProjectDirectories" | "getLastServerInfoMessage"> = {
    getLastServerInfoMessage: () => null,
    async browseProjectDirectories() {
      throw new Error("Must not guess a destination");
    },
  };
  expect(
    await resolveTaskDirectory({ source, destination, directory: "/home/guest/tree" }),
  ).toBeNull();
});

function projectsFolderClient(projectsRoot: string) {
  return {
    getLastServerInfoMessage: () =>
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: projectsRoot,
        projectsRoot,
        features: { projectsRoot: true },
      }),
    async browseProjectDirectories(): Promise<never> {
      throw new Error("A shared Projects folder needs no mapping");
    },
  };
}

test("uses the identical path when both daemons share the Projects folder", async () => {
  expect(
    await resolveTaskDirectory({
      source: projectsFolderClient("/Users/me/dev/"),
      destination: projectsFolderClient("/Users/me/dev"),
      directory: "/Users/me/dev/.vorteo/worktrees/abc/task",
    }),
  ).toBe("/Users/me/dev/.vorteo/worktrees/abc/task");
});

test("falls back to mapping when the daemons advertise different Projects folders", async () => {
  const source = projectsFolderClient("/Users/me/dev");
  await expect(
    resolveTaskDirectory({
      source,
      destination: projectsFolderClient("/home/guest/dev"),
      directory: "/Users/me/dev/repo",
    }),
  ).rejects.toThrow("A shared Projects folder needs no mapping");
});

test("a project placed only on another daemon gets the identical path without a folder prompt", async () => {
  expect(
    await resolveProjectDirectory({
      placements: [
        { source: projectsFolderClient("/Users/me/dev"), directory: "/Users/me/dev/app" },
      ],
      destination: projectsFolderClient("/Users/me/dev"),
    }),
  ).toBe("/Users/me/dev/app");
});

test("a legacy daemon without a shared folder leaves the folder choice to the owner", async () => {
  const legacy = {
    getLastServerInfoMessage: () => null,
    async browseProjectDirectories() {
      return {
        requestId: "legacy",
        error: null,
        errorCode: null,
        directory: null,
        roots: [{ id: "home", label: "Home", containerPath: "/home/guest", hostPath: null }],
      };
    },
  };
  expect(
    await resolveProjectDirectory({
      placements: [{ source: legacy, directory: "/home/guest/app" }],
      destination: projectsFolderClient("/Users/me/dev"),
    }),
  ).toBeNull();
});
