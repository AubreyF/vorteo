import { expect, test } from "vitest";
import { WorkspaceDescriptorPayloadSchema } from "@getpaseo/protocol/messages";
import { createDestinationWorkspace } from "./destination-workspaces";
import type { NewDestinationWorkspace } from "./destination-workspaces";

test("creates a host workspace using the destination project identity and path", async () => {
  const requests: unknown[] = [];
  const workspace = WorkspaceDescriptorPayloadSchema.parse({
    id: "host-workspace",
    projectId: "host-project",
    projectRootPath: "/host/repo",
    projectDisplayName: "Repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "Host task",
    status: "done",
    activityAt: "2026-10-05T00:00:00Z",
    scripts: [],
  });
  const result = await createDestinationWorkspace({
    client: {
      createWorkspace: async (request) => {
        requests.push(request);
        return { workspace, error: null, setupTerminalId: null, requestId: "request" };
      },
    },
    project: {
      projectId: "host-project",
      projectRootPath: "/host/repo",
      projectKind: "git",
      projectDisplayName: "Repo",
      projectKey: "remote:github.com/acme/repo",
    },
    checkout: "directory",
    title: "Host task",
    idempotencyKey: "retry-safe",
  });
  expect(result).toEqual(workspace);
  expect(requests).toEqual([
    {
      source: { kind: "directory", projectId: "host-project", path: "/host/repo" },
      title: "Host task",
      idempotencyKey: "retry-safe",
    },
  ]);
});

test("keeps a creation retry on the selected environment and reports its failure", async () => {
  const requests: unknown[] = [];
  const input: NewDestinationWorkspace = {
    client: {
      createWorkspace: async (request) => {
        requests.push(request);
        return {
          workspace: null,
          error: "Destination directory unavailable",
          setupTerminalId: null,
          requestId: "request",
        };
      },
    },
    project: {
      projectId: "destination",
      projectRootPath: "/destination/repo",
      projectKind: "git",
      projectDisplayName: "Repo",
    },
    checkout: "worktree",
    title: "Task",
    idempotencyKey: "same-request",
  };
  await expect(createDestinationWorkspace(input)).rejects.toThrow(
    "Destination directory unavailable",
  );
  await expect(createDestinationWorkspace(input)).rejects.toThrow(
    "Destination directory unavailable",
  );
  expect(requests).toEqual(
    [0, 1].map(() => ({
      source: {
        kind: "worktree",
        projectId: "destination",
        cwd: "/destination/repo",
        action: "branch-off",
      },
      title: "Task",
      idempotencyKey: "same-request",
    })),
  );
});

test("rejects a worktree for a directory project without creating anything", async () => {
  const input: NewDestinationWorkspace = {
    client: {
      createWorkspace: async () => {
        throw new Error("Unexpected creation");
      },
    },
    project: {
      projectId: "directory",
      projectRootPath: "/destination/notes",
      projectKind: "non_git",
      projectDisplayName: "Notes",
    },
    checkout: "worktree",
    title: "Task",
    idempotencyKey: "request",
  };
  await expect(createDestinationWorkspace(input)).rejects.toThrow("Choose a Git project");
});
