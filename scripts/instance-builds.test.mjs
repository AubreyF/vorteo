import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  claimBuild,
  ownerFile,
  pruneInstanceBuilds,
  trimSealedBuild,
} from "./lib/instance-builds.mjs";

const HOUR = 60 * 60_000;

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "instance-builds-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A build directory as build-instance-web.mjs leaves it at each stage. */
async function build(builds, name, { owner, sealed = false, trimmed = false, age = 0, now }) {
  const root = path.join(builds, name);
  await fs.mkdir(path.join(root, "node_modules/dep"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), "{}");
  await fs.writeFile(path.join(root, ".build-source-commit"), "abc\n");
  if (owner) await claimBuild(root, { pid: owner });
  if (sealed) {
    await fs.mkdir(path.join(root, "web-export"));
    await fs.writeFile(path.join(root, "web-export/index.html"), "<html>");
    await fs.writeFile(path.join(root, "web-export/.build-manifest.json"), "{}");
  }
  if (trimmed) await trimSealedBuild(root);
  const time = new Date(now - age);
  await fs.utimes(root, time, time);
  return root;
}

test("trimming a sealed build keeps only the export and its provenance", async (t) => {
  const builds = await temporary(t);
  const root = await build(builds, "build-a", { owner: 1, sealed: true, now: Date.now() });
  await fs.mkdir(path.join(root, "packages/app"), { recursive: true });
  await trimSealedBuild(root);
  assert.deepEqual((await fs.readdir(root)).sort(), [
    ".build-owner.json",
    ".build-source-commit",
    "web-export",
  ]);
  assert.deepEqual((await fs.readdir(path.join(root, "web-export"))).sort(), [
    ".build-manifest.json",
    "index.html",
  ]);
});

test("pruning removes abandoned builds but never a running or current one", async (t) => {
  const builds = await temporary(t);
  const now = Date.now();
  const live = 101;
  const dead = 202;
  const isAlive = (pid) => pid === live;
  const make = (name, options) => build(builds, name, { now, ...options });
  const current = await make("build-current", { owner: dead, age: 10 * HOUR });
  await make("build-running", { owner: live, age: 10 * HOUR });
  await make("build-failed-old", { owner: dead, age: 2 * HOUR });
  await make("build-failed-recent", { owner: dead, age: HOUR / 2 });
  await make("build-legacy-old", { sealed: true, age: 7 * HOUR });
  await make("build-legacy-recent", { age: 2 * HOUR });
  await fs.mkdir(path.join(builds, "unrelated"));
  const removed = await pruneInstanceBuilds(builds, { current, now, isAlive });
  assert.deepEqual(removed.sort(), ["build-failed-old", "build-legacy-old"]);
  assert.deepEqual((await fs.readdir(builds)).sort(), [
    "build-current",
    "build-failed-recent",
    "build-legacy-recent",
    "build-running",
    "unrelated",
  ]);
});

test("pruning keeps the five newest recent exports", async (t) => {
  const builds = await temporary(t);
  const now = Date.now();
  const day = 24 * HOUR;
  const ages = [0, 1, 2, 3, 4, 5].map((hours) => hours * HOUR);
  for (const [index, age] of ages.entries())
    await build(builds, `build-export-${index}`, {
      owner: 1,
      sealed: true,
      trimmed: true,
      age,
      now,
    });
  await build(builds, "build-export-week", {
    owner: 1,
    sealed: true,
    trimmed: true,
    age: 8 * day,
    now,
  });
  const removed = await pruneInstanceBuilds(builds, { now, isAlive: () => false });
  assert.deepEqual(removed.sort(), ["build-export-5", "build-export-week"]);
});

test("the owner file is claimed exclusively", async (t) => {
  const root = await temporary(t);
  await claimBuild(root, { pid: 1 });
  await assert.rejects(claimBuild(root, { pid: 2 }), { code: "EEXIST" });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ownerFile), "utf8")).pid, 1);
});
