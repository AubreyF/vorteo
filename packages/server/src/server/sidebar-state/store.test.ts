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
