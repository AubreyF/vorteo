import { expect, test } from "vitest";
import {
  applySidebarStatePatch,
  emptySidebarState,
  type SidebarStateChange,
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
    pendingKey: "existing-sync-tests",
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
    pendingKey: "existing-sync-tests",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a stopped instance's late acknowledgement cannot erase remounted offline edits", async () => {
  const acknowledgement = deferred<SidebarStateSnapshot>();
  const sent = deferred<void>();
  const oldPatch = { projectOrder: ["old"] };
  const newPatch = { projectOrder: ["new"] };
  let saved: SidebarStatePatch[] = [];
  let remote = emptySidebarState();
  let online = true;
  const ports = {
    pendingKey: "late-acknowledgement",
    read: async () => {
      if (!online) throw new Error("offline");
      return { revision: 1, state: remote };
    },
    change: async (change: SidebarStateChange) => {
      if (change.type !== "patch") throw new Error("Unexpected initialize");
      if (remote.projectOrder.length > 0) {
        remote = applySidebarStatePatch(remote, change.patch);
        return { revision: 3, state: remote };
      }
      // The request was sent. Stopping the client does not cancel the server's write.
      remote = applySidebarStatePatch(remote, oldPatch);
      sent.resolve();
      return acknowledgement.promise;
    },
    readLocal: emptySidebarState,
    applyLocal: () => {},
    loadPending: async () => saved,
    savePending: async (patches: SidebarStatePatch[]) => {
      saved = patches;
    },
    status: () => {},
  };
  const old = new SidebarSync(ports);
  old.record(oldPatch);
  const oldRefresh = old.refresh();
  await sent.promise;
  old.stop();
  online = false;
  const replacement = new SidebarSync(ports);
  replacement.record(newPatch);
  await replacement.refresh();
  expect(saved).toEqual([oldPatch, newPatch]);
  acknowledgement.resolve({ revision: 2, state: remote });
  await oldRefresh;
  expect(remote.projectOrder).toEqual(["old"]);
  expect(saved).toEqual([oldPatch, newPatch]);
  replacement.stop();
  const reloaded = new SidebarSync(ports);
  reloaded.record({ collapsedPinned: true });
  await reloaded.refresh();
  expect(saved).toEqual([oldPatch, newPatch, { collapsedPinned: true }]);
  online = true;
  await reloaded.refresh();
  expect(remote.projectOrder).toEqual(["new"]);
  expect(remote.collapsedPinned).toBe(true);
  expect(saved).toEqual([]);
  reloaded.stop();
});

test("remount loads after both in-flight and queued saves from the stopped instance", async () => {
  const saving = deferred<void>();
  const releaseSave = deferred<void>();
  let saved: SidebarStatePatch[] = [];
  let writes = 0;
  let loads = 0;
  const oldPatch = { projectOrder: ["old"] };
  const queuedPatch = { collapsedPinned: true };
  const newPatch = { projectOrder: ["new"] };
  const ports = {
    pendingKey: "pending-save-remount",
    read: async () => {
      throw new Error("offline");
    },
    change: async () => {
      throw new Error("offline");
    },
    readLocal: emptySidebarState,
    applyLocal: () => {},
    loadPending: async () => {
      loads++;
      return saved;
    },
    savePending: async (patches: SidebarStatePatch[]) => {
      if (++writes === 1) {
        saving.resolve();
        await releaseSave.promise;
      }
      saved = patches;
    },
    status: () => {},
  };
  const old = new SidebarSync(ports);
  old.record(oldPatch);
  await saving.promise;
  old.record(queuedPatch);
  const oldRefresh = old.refresh();
  old.stop();
  const replacement = new SidebarSync(ports);
  replacement.record(newPatch);
  const replacementRefresh = replacement.refresh();
  await Promise.resolve();
  expect(loads).toBe(1);
  releaseSave.resolve();
  await Promise.all([oldRefresh, replacementRefresh]);
  expect(saved).toEqual([oldPatch, queuedPatch, newPatch]);
  old.record({ projectOrder: ["stopped"] });
  await old.refresh();
  expect(saved).toEqual([oldPatch, queuedPatch, newPatch]);
  replacement.stop();
});

test("edits recorded before hydration survive stop and load into the next instance", async () => {
  const hydration = deferred<SidebarStatePatch[]>();
  const retained = { collapsedPinned: true };
  const early = { projectOrder: ["early"] };
  const later = { projectOrder: ["later"] };
  let saved: SidebarStatePatch[] = [retained];
  let loads = 0;
  const ports = {
    pendingKey: "stop-before-hydration",
    read: async () => {
      throw new Error("offline");
    },
    change: async () => {
      throw new Error("offline");
    },
    readLocal: emptySidebarState,
    applyLocal: () => {},
    loadPending: async () => (++loads === 1 ? hydration.promise : saved),
    savePending: async (patches: SidebarStatePatch[]) => {
      saved = patches;
    },
    status: () => {},
  };
  const old = new SidebarSync(ports);
  old.record(early);
  old.stop();
  const replacement = new SidebarSync(ports);
  replacement.record(later);
  hydration.resolve([retained]);
  await replacement.refresh();
  expect(saved).toEqual([retained, early, later]);
  replacement.stop();
});
