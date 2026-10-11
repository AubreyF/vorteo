import { expect, test } from "vitest";
import {
  applySidebarStatePatch,
  emptySidebarState,
  type SidebarStatePatch,
  type SidebarStateSnapshot,
} from "@getpaseo/protocol/sidebar-state";
import { SidebarSync, type SidebarSyncStatus } from "./sync";

test("reconnect adopts remote state without uploading stale cache and retains offline edits", async () => {
  let remote: SidebarStateSnapshot = {
    revision: 4,
    state: { ...emptySidebarState(), projectOrder: ["b", "a"], collapsedProjects: { b: true } },
  };
  let local = { ...emptySidebarState(), projectOrder: ["stale"] };
  let online = true;
  let saved: SidebarStatePatch[] = [];
  let status: SidebarSyncStatus = "loading";
  const writes: SidebarStatePatch[] = [];
  const sync = new SidebarSync({
    read: async () => {
      if (!online) throw new Error("offline");
      return remote;
    },
    change: async (change) => {
      if (!online) throw new Error("offline");
      if (change.type !== "patch") throw new Error("must not initialize existing state");
      writes.push(change.patch);
      remote = {
        revision: remote.revision + 1,
        state: applySidebarStatePatch(remote.state!, change.patch),
      };
      return remote;
    },
    readLocal: () => local,
    applyLocal: (state) => {
      local = state;
    },
    loadPending: async () => [],
    savePending: async (patches) => {
      saved = patches;
    },
    status: (value) => {
      status = value;
    },
  });
  await sync.refresh();
  expect(local.projectOrder).toEqual(["b", "a"]);
  expect(writes).toEqual([]);
  online = false;
  sync.record({ collapsedProjects: { a: true } });
  await sync.refresh();
  expect(status).toBe("pending");
  expect(saved).toEqual([{ collapsedProjects: { a: true } }]);
  remote = { revision: 5, state: { ...remote.state!, projectOrder: ["a", "b"] } };
  online = true;
  await sync.refresh();
  expect(local.projectOrder).toEqual(["a", "b"]);
  expect(local.collapsedProjects).toEqual({ a: true, b: true });
  expect(saved).toEqual([]);
  expect(status).toBe("synced");
});

test("reload restores queued edits and a failed local save can be retried", async () => {
  let local = emptySidebarState();
  let failSave = true;
  let remote = { ...emptySidebarState(), projectOrder: ["second", "first"] };
  let stored: SidebarStatePatch[] = [{ collapsedProjects: { first: true } }];
  const statuses: SidebarSyncStatus[] = [];
  const sync = new SidebarSync({
    read: async () => ({ revision: 1, state: remote }),
    change: async (change) => {
      if (change.type !== "patch") throw new Error("Unexpected initialize");
      remote = applySidebarStatePatch(remote, change.patch);
      return { revision: 2, state: remote };
    },
    readLocal: () => local,
    applyLocal: (state) => {
      local = state;
    },
    loadPending: async () => stored,
    savePending: async (patches) => {
      if (failSave) throw new Error("Storage full");
      stored = patches;
    },
    status: (status) => {
      statuses.push(status);
    },
  });
  sync.record({ collapsedProjects: { second: true } });
  await sync.refresh();
  expect(statuses.at(-1)).toBe("pending");
  expect(stored).toEqual([{ collapsedProjects: { first: true } }]);
  failSave = false;
  await sync.refresh();
  expect(local.collapsedProjects).toEqual({ first: true, second: true });
  expect(local.projectOrder).toEqual(["second", "first"]);
  expect(stored).toEqual([]);
  expect(statuses.at(-1)).toBe("synced");
});
