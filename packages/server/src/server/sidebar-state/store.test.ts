import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { SidebarStateStore } from "./store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("devices share ordering and independent expansion changes durably", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidebar-state-"));
  directories.push(directory);
  const file = path.join(directory, "sidebar.json");
  const store = new SidebarStateStore(file);
  expect((await store.read()).state).toBeNull();
  await store.change({ type: "initialize", state: { projectOrder: ["a", "b"] } });
  await store.change({ type: "initialize", state: { projectOrder: ["stale"] } });
  await Promise.all([
    store.change({
      type: "patch",
      patch: { projectOrder: ["b", "a"], workspaceOrderByProject: { a: ["two", "one"] } },
    }),
    store.change({ type: "patch", patch: { collapsedProjects: { a: true } } }),
    store.change({ type: "patch", patch: { collapsedProjects: { b: true } } }),
  ]);
  const saved = await store.read();
  expect(saved.state?.projectOrder).toEqual(["b", "a"]);
  expect(saved.state?.workspaceOrderByProject).toEqual({ a: ["two", "one"] });
  expect(saved.state?.collapsedProjects).toEqual({ a: true, b: true });
  expect(await new SidebarStateStore(file).read()).toEqual(saved);
});

test("folder patches are repaired and malformed folders are rejected with a clear error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidebar-state-"));
  directories.push(directory);
  const store = new SidebarStateStore(path.join(directory, "sidebar.json"));
  const createdAt = "2026-10-22T00:00:00.000Z";
  const root = { kind: "root" } as const;
  await store.change({ type: "initialize", state: { projectOrder: ["a", "b"] } });
  await store.change({
    type: "patch",
    patch: {
      sidebarFolders: {
        outer: { id: "outer", name: "Outer", parentId: null, scope: root, createdAt },
        inner: { id: "inner", name: "Inner", parentId: "outer", scope: root, createdAt },
      },
      itemFolder: { a: "inner", b: "outer" },
      childOrder: { root: ["folder:outer"], "folder:outer": ["folder:inner", "b"] },
    },
  });
  const cyclic = await store.change({
    type: "patch",
    patch: {
      sidebarFolders: {
        outer: { id: "outer", name: "Outer", parentId: "inner", scope: root, createdAt },
      },
    },
  });
  expect(cyclic.state?.sidebarFolders?.outer?.parentId).toBeNull();
  await expect(
    store.change({
      type: "patch",
      patch: {
        sidebarFolders: {
          loop: { id: "loop", name: "Loop", parentId: "loop", scope: root, createdAt },
        },
      },
    }),
  ).rejects.toThrow("Sidebar folder loop cannot be its own parent.");
  const removed = await store.change({ type: "patch", patch: { sidebarFolders: { outer: null } } });
  expect(removed.state?.sidebarFolders?.inner?.parentId).toBeNull();
  expect(removed.state?.itemFolder).toEqual({ a: "inner" });
  expect(removed.state?.childOrder).toEqual({ root: ["folder:inner", "b"] });
  expect(await new SidebarStateStore(path.join(directory, "sidebar.json")).read()).toEqual(removed);
});
