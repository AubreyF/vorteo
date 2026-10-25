import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

test("matches the executed script on this platform", () => {
  const scriptPath = path.resolve("scripts", "github-release.mjs");
  assert.equal(isMainModule(pathToFileURL(scriptPath).href, scriptPath), true);
});

test("does not match when another module is the entry point", () => {
  const scriptPath = path.resolve("scripts", "github-release.mjs");
  const otherPath = path.resolve("scripts", "stamp-rollout.mjs");
  assert.equal(isMainModule(pathToFileURL(scriptPath).href, otherPath), false);
});

test("returns false without an argv entry", () => {
  assert.equal(
    isMainModule(pathToFileURL(path.resolve("scripts", "x.mjs")).href, undefined),
    false,
  );
});

test("the naive string comparison that broke Windows is not used", () => {
  const scriptPath = path.resolve("scripts", "github-release.mjs");
  const url = pathToFileURL(scriptPath).href;
  // On Windows this naive form is `file://D:\\...` and never equals the module URL.
  assert.notEqual(
    `file://${"D:\\a\\paseo\\scripts\\github-release.mjs"}`,
    "file:///D:/a/paseo/scripts/github-release.mjs",
  );
  assert.equal(isMainModule(url, scriptPath), true);
});

test("matches a script run through a symlinked directory", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "is-main-module-"));
  try {
    // Like an installation's `current` symlink to its release directory.
    const release = path.join(base, "release");
    const current = path.join(base, "current");
    mkdirSync(release);
    const script = path.join(release, "tool.mjs");
    writeFileSync(script, "");
    symlinkSync(release, current, "dir");
    assert.equal(isMainModule(pathToFileURL(script).href, path.join(current, "tool.mjs")), true);
    assert.equal(isMainModule(pathToFileURL(script).href, path.join(current, "other.mjs")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
