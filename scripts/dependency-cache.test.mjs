import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  dependencyKey,
  installDependencies,
  installModes,
  pruneDependencyCache,
} from "./lib/dependency-cache.mjs";

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-cache-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function checkout(parent, name, lock = "1") {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, "packages/a"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"workspaces":["packages/a"]}');
  fs.writeFileSync(path.join(root, "packages/a/package.json"), '{"name":"@getpaseo/a"}');
  fs.writeFileSync(
    path.join(root, "packages/a/index.js"),
    `module.exports = ${JSON.stringify(name)};`,
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      revision: lock,
      packages: {
        "": {},
        "packages/a": {},
        "node_modules/@getpaseo/a": { link: true, resolved: "packages/a" },
      },
    }),
  );
  return root;
}

/** Writes the tree npm would: hoisted packages, a workspace link and a nested install. */
function fakeNpm(calls) {
  return (command, args, cwd) => {
    calls.push([command, ...args]);
    if (args[0] !== "ci") return;
    fs.mkdirSync(path.join(cwd, "node_modules/@getpaseo"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "node_modules/left-pad.js"), "module.exports = 1;");
    fs.symlinkSync("../../packages/a", path.join(cwd, "node_modules/@getpaseo/a"));
    fs.mkdirSync(path.join(cwd, "packages/a/node_modules/nested"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "packages/a/node_modules/nested/index.js"), "");
    fs.writeFileSync(path.join(cwd, "node_modules/.package-lock.json"), "{}");
  };
}

const copy = (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
const options = { supported: true, npmVersion: "11.0.0", clone: copy, log: () => {} };

test("unsupported platforms run a plain install", (t) => {
  const parent = temporary(t);
  const root = checkout(parent, "one");
  const calls = [];
  const result = installDependencies({
    ...options,
    root,
    mode: "build",
    cache: path.join(parent, "cache"),
    run: fakeNpm(calls),
    supported: false,
  });
  assert.deepEqual(result, { source: "install" });
  assert.deepEqual(calls, [["npm", ...installModes.build]]);
  assert.equal(fs.existsSync(path.join(parent, "cache")), false);
});

test("a second checkout clones the cached install and keeps its own workspace links", (t) => {
  const parent = temporary(t);
  const cache = path.join(parent, "cache");
  const first = checkout(parent, "one");
  const second = checkout(parent, "two");
  const calls = [];
  const run = fakeNpm(calls);
  assert.equal(
    installDependencies({ ...options, root: first, mode: "build", cache, run }).source,
    "install",
  );
  // Stale dependencies are replaced, as npm ci would.
  fs.mkdirSync(path.join(second, "node_modules/stale"), { recursive: true });
  const result = installDependencies({ ...options, root: second, mode: "build", cache, run });
  assert.equal(result.source, "clone");
  assert.deepEqual(calls, [["npm", ...installModes.build]]);
  assert.equal(fs.existsSync(path.join(second, "node_modules/stale")), false);
  assert.ok(fs.existsSync(path.join(second, "packages/a/node_modules/nested/index.js")));
  const linked = fs.realpathSync(path.join(second, "node_modules/@getpaseo/a"));
  assert.equal(linked, fs.realpathSync(path.join(second, "packages/a")));
  // Changing the clone never reaches the cache or the first checkout.
  fs.writeFileSync(path.join(second, "node_modules/left-pad.js"), "changed");
  assert.equal(
    fs.readFileSync(path.join(first, "node_modules/left-pad.js"), "utf8"),
    "module.exports = 1;",
  );
});

test("worktree clones run the prepare hook that a full install would have run", (t) => {
  const parent = temporary(t);
  const cache = path.join(parent, "cache");
  const calls = [];
  const run = fakeNpm(calls);
  installDependencies({ ...options, root: checkout(parent, "one"), mode: "worktree", cache, run });
  installDependencies({ ...options, root: checkout(parent, "two"), mode: "worktree", cache, run });
  assert.deepEqual(calls, [
    ["npm", ...installModes.worktree],
    ["npm", "run", "prepare", "--if-present"],
  ]);
});

test("lockfile, mode and toolchain changes select another install", (t) => {
  const parent = temporary(t);
  const one = checkout(parent, "one", "1");
  const two = checkout(parent, "two", "2");
  const base = dependencyKey(one, "build", { npmVersion: "11.0.0" });
  assert.notEqual(base, dependencyKey(two, "build", { npmVersion: "11.0.0" }));
  assert.notEqual(base, dependencyKey(one, "worktree", { npmVersion: "11.0.0" }));
  assert.notEqual(base, dependencyKey(one, "build", { npmVersion: "11.1.0" }));
  fs.writeFileSync(path.join(one, "packages/a/package.json"), '{"name":"@getpaseo/a","x":1}');
  assert.notEqual(base, dependencyKey(one, "build", { npmVersion: "11.0.0" }));
});

test("our own version bumps keep the same install", (t) => {
  const parent = temporary(t);
  const root = checkout(parent, "one");
  const write = (relative, value) =>
    fs.writeFileSync(path.join(root, relative), JSON.stringify(value));
  // What the version hook rewrites: workspace versions and internal pins.
  const release = (version, extra = {}) => {
    const dependencies = { "@getpaseo/a": version, ...extra };
    write("packages/a/package.json", { name: "@getpaseo/a", version });
    write("package.json", { workspaces: ["packages/a"], version, dependencies });
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    lock.version = version;
    lock.packages[""] = { version, dependencies };
    lock.packages["packages/a"] = { version };
    write("package-lock.json", lock);
    return dependencyKey(root, "build", { npmVersion: "11.0.0" });
  };
  const base = release("1.0.0");
  assert.equal(release("2.0.0"), base);
  assert.notEqual(release("2.0.0", { "left-pad": "1.0.0" }), base);
});

test("a failed clone falls back to a clean install", (t) => {
  const parent = temporary(t);
  const cache = path.join(parent, "cache");
  const calls = [];
  const run = fakeNpm(calls);
  installDependencies({ ...options, root: checkout(parent, "one"), mode: "build", cache, run });
  const second = checkout(parent, "two");
  const result = installDependencies({
    ...options,
    root: second,
    mode: "build",
    cache,
    run,
    clone: () => {
      throw new Error("clone refused");
    },
  });
  assert.equal(result.source, "install");
  assert.equal(calls.length, 2);
  assert.ok(fs.existsSync(path.join(second, "node_modules/.package-lock.json")));
});

test("pruning keeps recent installs and removes old ones and abandoned staging", (t) => {
  const cache = temporary(t);
  const now = Date.now();
  const day = 24 * 60 * 60_000;
  for (const [name, age] of [
    ["a", 0],
    ["b", day],
    ["c", 2 * day],
    ["d", 3 * day],
    ["e", 4 * day],
    ["f", 30 * 60_000], // beyond the newest four by order, but used in the last hour
  ]) {
    fs.mkdirSync(path.join(cache, name));
    const manifest = path.join(cache, name, "manifest.json");
    fs.writeFileSync(manifest, "{}");
    const time = new Date(now - age);
    fs.utimesSync(manifest, time, time);
  }
  fs.mkdirSync(path.join(cache, ".staging-old"));
  fs.utimesSync(path.join(cache, ".staging-old"), new Date(now - 2 * day), new Date(now - 2 * day));
  fs.mkdirSync(path.join(cache, ".staging-new"));
  const removed = pruneDependencyCache(cache, { now, keep: 4 });
  assert.deepEqual(removed.sort(), [".staging-old", "d", "e"]);
});

test(
  "macOS clones share storage with the cached install",
  { skip: process.platform !== "darwin" },
  (t) => {
    const parent = temporary(t);
    const cache = path.join(parent, "cache");
    const run = fakeNpm([]);
    const { clone: _ignored, ...native } = options;
    installDependencies({ ...native, root: checkout(parent, "one"), mode: "build", cache, run });
    const second = checkout(parent, "two");
    assert.equal(
      installDependencies({ ...native, root: second, mode: "build", cache, run }).source,
      "clone",
    );
    assert.equal(
      fs.realpathSync(path.join(second, "node_modules/@getpaseo/a")),
      fs.realpathSync(path.join(second, "packages/a")),
    );
  },
);
