import type { DestinationWorkspaceClient } from "@/agent-profiles/internal/destination-workspaces";
import { expect, test } from "vitest";
import { WorkspaceDescriptorPayloadSchema } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { openTaskEnvironment } from "./model";

function fixture() {
  const owner = { serverId: "host", workspaceId: "source" };
  const workspace = WorkspaceDescriptorPayloadSchema.parse({
    id: "destination",
    projectId: "repo",
    projectRootPath: "/mnt/tree",
    workspaceDirectory: "/mnt/tree",
    projectDisplayName: "Repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "Work",
    status: "done",
    activityAt: null,
  });
  let entries: (typeof workspace)[] = [];
  let creationCount = 0;
  let online = true;
  let approved = true;
  let supported = true;
  let failMembership = false;
  let membership: typeof workspace.projectMembership;
  const client: DestinationWorkspaceClient &
    Pick<DaemonClient, "browseProjectDirectories" | "createWorkspace"> = {
    async fetchWorkspaces() {
      return {
        requestId: "fetch",
        emptyProjects: [],
        entries,
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      };
    },
    async browseProjectDirectories() {
      return { requestId: "browse", roots: [], directory: null, error: null, errorCode: null };
    },
    async createWorkspace(input) {
      creationCount++;
      if (failMembership) throw new Error("Connection lost while associating workspace");
      membership = input.projectMembership;
      entries = [{ ...workspace, projectMembership: membership }];
      return { requestId: "create", workspace: entries[0], error: null, setupTerminalId: null };
    },
  };
  const model = openTaskEnvironment({
    owner,
    directory: "/host/tree",
    name: "Work",
    project: { key: "repo", name: "Repo" },
    getClient() {
      if (!online) throw new Error("Environment offline");
      return { client, supportsBindings: supported };
    },
    approveHost: async () => approved,
    save() {},
  });
  return {
    model,
    owner,
    workspace,
    client,
    creations: () => creationCount,
    membership: () => membership,
    setEntries(value: typeof entries) {
      entries = value;
    },
    setApproved(value: boolean) {
      approved = value;
    },
    setOnline(value: boolean) {
      online = value;
    },
    setSupported(value: boolean) {
      supported = value;
    },
    failMembership(value: boolean) {
      failMembership = value;
    },
  };
}

test("changing environments prepares a draft without creating a workspace, and start records the exact owner", async () => {
  const f = fixture();
  await f.model.select("container");
  expect(f.model.getState().status).toBe("folder");
  expect(f.creations()).toBe(0);
  await expect(f.model.prepare()).rejects.toThrow("Choose this workspace's folder");
  f.model.chooseDirectory("/mnt/tree");
  expect(await f.model.prepare()).toEqual({ serverId: "container", workspaceId: "destination" });
  expect(f.membership()).toEqual({ key: "repo", name: "Repo", environmentOwner: f.owner });
  expect(f.creations()).toBe(1);
  expect(await f.model.prepare()).toEqual({ serverId: "container", workspaceId: "destination" });
  expect(f.creations()).toBe(1);
});

test("a subsequent draft reuses only the workspace's explicit binding", async () => {
  const f = fixture();
  f.setEntries([
    { ...f.workspace, projectMembership: { key: "repo", name: "Repo", environmentOwner: f.owner } },
  ]);
  await f.model.select("container");
  expect(f.model.getState()).toMatchObject({
    status: "ready",
    directory: "/mnt/tree",
    workspaceId: "destination",
  });
  await f.model.prepare();
  expect(f.creations()).toBe(0);
});

test("an unrelated workspace in the same project is never a directory fallback", async () => {
  const f = fixture();
  f.setEntries([{ ...f.workspace, projectMembership: { key: "repo", name: "Repo" } }]);
  await f.model.select("container");
  expect(f.model.getState()).toMatchObject({ status: "folder", directory: "", workspaceId: null });
});

test("offline selection reports an error and retries without creating anything", async () => {
  const f = fixture();
  f.setOnline(false);
  await f.model.select("container");
  expect(f.model.getState()).toMatchObject({ status: "error", error: "Environment offline" });
  f.setOnline(true);
  await f.model.select("container");
  expect(f.model.getState().status).toBe("folder");
  expect(f.creations()).toBe(0);
});

test("an older destination cannot silently drop workspace ownership", async () => {
  const f = fixture();
  f.setSupported(false);
  await f.model.select("container");
  expect(f.model.getState()).toMatchObject({
    status: "error",
    error: "Update this environment to create tasks in a shared workspace.",
  });
  expect(f.creations()).toBe(0);
});

test("a failed association keeps the chosen directory and can be retried", async () => {
  const f = fixture();
  await f.model.select("container");
  f.model.chooseDirectory("/mnt/tree");
  f.failMembership(true);
  await expect(f.model.prepare()).rejects.toThrow("Connection lost");
  expect(f.model.getState()).toMatchObject({
    serverId: "container",
    directory: "/mnt/tree",
    workspaceId: null,
  });
  f.failMembership(false);
  expect(await f.model.prepare()).toEqual({ serverId: "container", workspaceId: "destination" });
});

test("declining another environment does not strand a folder lookup already in progress", async () => {
  const f = fixture();
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = f.client.fetchWorkspaces;
  f.client.fetchWorkspaces = async (options) => {
    await pending;
    return fetch(options);
  };
  const selecting = f.model.select("container");
  await Promise.resolve();
  f.setApproved(false);
  await f.model.select("another-host");
  release();
  await selecting;
  expect(f.model.getState()).toMatchObject({ serverId: "container", status: "folder" });
  expect(f.creations()).toBe(0);
});
