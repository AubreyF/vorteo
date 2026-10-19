import { expect, test } from "vitest";
import { WorkspaceDescriptorPayloadSchema } from "@getpaseo/protocol/messages";
import { createDestinationWorkspace } from "./destination-workspaces";
import type { NewDestinationWorkspace } from "./destination-workspaces";

test("creates a host workspace in the original project using the destination directory", async () => {
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
    project: { key: "source-project", name: "Repo" },
    directory: "/host/repo",
    title: "Host task",
    idempotencyKey: "retry-safe",
  });
  expect(result).toEqual(workspace);
  expect(requests).toEqual([
    {
      source: { kind: "directory", path: "/host/repo" },
      projectMembership: { key: "source-project", name: "Repo" },
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
    project: { key: "source-project", name: "Repo" },
    directory: "/destination/repo",
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
        kind: "directory",
        path: "/destination/repo",
      },
      projectMembership: { key: "source-project", name: "Repo" },
      title: "Task",
      idempotencyKey: "same-request",
    })),
  );
});
