import { expect, test } from "vitest";
import { resolveTaskDirectory } from "./directory";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

test("maps the exact worktree through shared roots rather than choosing a project directory", async () => {
  const requests: unknown[] = [];
  const source: Pick<DaemonClient, "browseProjectDirectories"> = {
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
  const destination: Pick<DaemonClient, "browseProjectDirectories"> = {
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
  const source: Pick<DaemonClient, "browseProjectDirectories"> = {
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
  const destination: Pick<DaemonClient, "browseProjectDirectories"> = {
    async browseProjectDirectories() {
      throw new Error("Must not guess a destination");
    },
  };
  expect(
    await resolveTaskDirectory({ source, destination, directory: "/home/guest/tree" }),
  ).toBeNull();
});
