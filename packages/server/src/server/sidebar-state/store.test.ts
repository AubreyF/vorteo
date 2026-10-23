import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("project keys under a Projects folder alias move to the logical root once, after a backup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidebar-state-"));
  directories.push(directory);
  const file = path.join(directory, "sidebar.json");
  const OLD = "/Users/guest/dev";
  const ROOT = "/Users/owner/dev";
  const old = (suffix = "") => `host:srv_dev:${OLD}${suffix}`;
  const now = (suffix = "") => `host:srv_dev:${ROOT}${suffix}`;
  const createdAt = "2026-10-22T00:00:00.000Z";
  const saved = {
    revision: 7,
    state: {
      projectOrder: [old("/vorton"), "remote:github.com/a/b", now("/vorton"), old(), old("/freed")],
      pinnedWorkspaceOrder: ["srv_dev:wks_1"],
      workspaceOrderByProject: {
        [old("/vorton")]: ["srv_dev:wks_old"],
        [now("/vorton")]: ["srv_dev:wks_new"],
        [old()]: ["srv_dev:wks_root"],
      },
      collapsedProjects: { [old()]: true, [`${OLD}/bare`]: true },
      collapsedWorkspaceGroups: { [`standing:${old("/vorton")}`]: true, system: true },
      collapsedPinned: false,
      groupMode: "project",
      hostFilters: ["srv_dev"],
      projectFilters: [old("/vorton")],
      labelFilters: [],
      sidebarFolders: {
        f1: {
          id: "f1",
          name: "In project",
          parentId: null,
          scope: { kind: "project", projectKey: old("/vorton") },
          createdAt,
        },
      },
      itemFolder: { "srv_dev:wks_old": "f1" },
      childOrder: {
        root: [old("/vorton"), old("/freed")],
        [`project:${old("/vorton")}`]: ["folder:f1", "srv_dev:wks_old"],
      },
    },
  };
  await writeFile(file, JSON.stringify(saved));
  const open = () =>
    new SidebarStateStore(file, {
      projectsFolder: { root: ROOT, aliases: [OLD], keepPaths: [`${OLD}/freed`] },
      now: () => new Date(createdAt),
    });

  const migrated = await open().read();
  expect(migrated.revision).toBe(8);
  expect(migrated.state).toMatchObject({
    // The new key keeps its place and value; the old duplicate is dropped. Kept paths stay.
    projectOrder: ["remote:github.com/a/b", now("/vorton"), now(), old("/freed")],
    pinnedWorkspaceOrder: ["srv_dev:wks_1"],
    workspaceOrderByProject: {
      [now("/vorton")]: ["srv_dev:wks_new"],
      [now()]: ["srv_dev:wks_root"],
    },
    collapsedProjects: { [now()]: true, [`${ROOT}/bare`]: true },
    collapsedWorkspaceGroups: { [`standing:${now("/vorton")}`]: true, system: true },
    hostFilters: ["srv_dev"],
    projectFilters: [now("/vorton")],
    itemFolder: { "srv_dev:wks_old": "f1" },
    childOrder: {
      root: [now("/vorton"), old("/freed")],
      [`project:${now("/vorton")}`]: ["folder:f1", "srv_dev:wks_old"],
    },
  });
  expect(migrated.state?.sidebarFolders?.f1?.scope).toEqual({
    kind: "project",
    projectKey: now("/vorton"),
  });
  const backups = (await readdir(directory)).filter((name) => name.includes("before-projects"));
  expect(backups).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(directory, backups[0]!), "utf8"))).toEqual(saved);

  // Opening again changes nothing and writes no second backup.
  expect(await open().read()).toEqual(migrated);
  expect((await readdir(directory)).filter((name) => name.includes("before-projects"))).toEqual(
    backups,
  );
});

test("a store without Projects folder aliases leaves saved keys alone", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidebar-state-"));
  directories.push(directory);
  const file = path.join(directory, "sidebar.json");
  const store = new SidebarStateStore(file, {
    projectsFolder: { root: "/Users/owner/dev", aliases: [] },
  });
  await store.change({ type: "initialize", state: { projectOrder: ["/Users/guest/dev/a"] } });
  expect((await new SidebarStateStore(file).read()).state?.projectOrder).toEqual([
    "/Users/guest/dev/a",
  ]);
});
