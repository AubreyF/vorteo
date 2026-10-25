import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { setReleaseImmutable } from "./coordinator-bootstrap-release-seal.js";
import { pruneHostReleases } from "./host-release-retention.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

/** Job folders 0 (oldest) to count-1 (newest), each with a release tree, plus unrelated folders. */
function fixture(count: number) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "host-retention-")));
  roots.push(base);
  const root = path.join(base, "reviewed-updates");
  mkdirSync(path.join(root, ".release-dependency-cache"), { recursive: true });
  mkdirSync(path.join(root, "source-updates"), { recursive: true });
  const release = (index: number) => path.join(root, id(index), "build-x");
  for (let index = 0; index < count; index += 1) {
    mkdirSync(path.join(release(index), "node_modules"), { recursive: true });
    writeFileSync(path.join(root, id(index), "admission.json"), "{}");
    const time = new Date(Date.UTC(2026, 9, 23, 0, index));
    utimesSync(path.join(root, id(index)), time, time);
  }
  const current = path.join(base, "current");
  symlinkSync(release(count - 1), current);
  return { base, root, release, current };
}

test("retention keeps referenced and newest releases and removes the rest", async () => {
  const f = fixture(8);
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current, f.release(2), path.join(f.root, id(1)), "/elsewhere/release"],
    keepNewest: 2,
  });
  expect(removed.sort()).toEqual([id(0), id(3), id(4), id(5)]);
  for (const kept of [1, 2, 6, 7]) expect(existsSync(f.release(kept))).toBe(true);
  // Folders that are not job folders are never touched, even when unreferenced.
  expect(existsSync(path.join(f.root, ".release-dependency-cache"))).toBe(true);
  expect(existsSync(path.join(f.root, "source-updates"))).toBe(true);
});

test("one release that cannot be removed is reported and the rest continue", async () => {
  const f = fixture(5);
  const failed: string[] = [];
  const removed = await pruneHostReleases({
    releaseRoot: f.root,
    referenced: [f.current],
    keepNewest: 1,
    removeRelease: async (directory) => {
      if (directory.includes(id(1))) throw new Error("Operation not permitted");
      await rm(directory, { recursive: true, force: true });
    },
    onError: (folder) => failed.push(path.basename(folder)),
  });
  expect(failed).toEqual([id(1)]);
  expect(removed.sort()).toEqual([id(0), id(2), id(3)]);
  expect(existsSync(f.release(1))).toBe(true);
});

test("off macOS, release trees are removed without immutable-flag tooling", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    // chflags would fail on a missing path, so resolving proves it was not called.
    await expect(setReleaseImmutable(["/nonexistent/release"], false)).resolves.toBeUndefined();
    const f = fixture(4);
    const failed: string[] = [];
    const removed = await pruneHostReleases({
      releaseRoot: f.root,
      referenced: [f.current],
      keepNewest: 1,
      onError: (folder) => failed.push(path.basename(folder)),
    });
    expect(failed).toEqual([]);
    expect(removed.sort()).toEqual([id(0), id(1), id(2)]);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
