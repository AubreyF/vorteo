import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertBuildsCoordinator, isBuildsCoordinator } from "./lib/builds-guard.mjs";
import { pushesMain } from "./guard-main-push.mjs";

const run = promisify(execFile);
const withoutBuilds = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "VORTEO_BUILDS"),
);

test("only the builds coordinator passes the guard", () => {
  assert.equal(isBuildsCoordinator({ VORTEO_BUILDS: "1" }), true);
  assert.equal(isBuildsCoordinator({}), false);
  assert.equal(isBuildsCoordinator({ VORTEO_BUILDS: "true" }), false);
  assert.doesNotThrow(() => assertBuildsCoordinator("Publishing", { VORTEO_BUILDS: "1" }));
  assert.throws(() => assertBuildsCoordinator("Publishing", {}), /reserved for the Vorteo :: Builds thread/);
});

test("the pre-push guard recognizes pushes to main only", () => {
  assert.equal(pushesMain("refs/heads/x abc refs/heads/main def\n"), true);
  assert.equal(pushesMain("refs/heads/x abc refs/heads/feat/x def\n"), false);
  assert.equal(pushesMain(""), false);
});

test("the installation client refuses request commands outside Builds before reading config", async () => {
  const client = path.resolve("scripts/installation-agent.mjs");
  await assert.rejects(
    run(process.execPath, [client, "--config", "/nonexistent/config.json", "request-restart"], { env: withoutBuilds }),
    (error) => /reserved for the Vorteo :: Builds thread/.test(String(error.stderr)),
  );
});

test("the pre-push hook refuses main outside Builds and allows task branches", async () => {
  const hook = path.resolve("scripts/guard-main-push.mjs");
  const push = (line, env) => {
    const child = execFile(process.execPath, [hook], { env });
    child.stdin.end(line);
    return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  };
  assert.equal(await push("refs/heads/a 1 refs/heads/main 2\n", withoutBuilds), 1);
  assert.equal(await push("refs/heads/a 1 refs/heads/feat/a 2\n", withoutBuilds), 0);
  assert.equal(await push("refs/heads/a 1 refs/heads/main 2\n", { ...withoutBuilds, VORTEO_BUILDS: "1" }), 0);
});

test("a client copied alone still refuses request commands outside Builds", async () => {
  // The installer copies installation-agent.mjs by itself into Dev, so it must not import siblings.
  const dir = mkdtempSync(path.join(os.tmpdir(), "builds-guard-client-"));
  try {
    const client = path.join(dir, "installation-agent.mjs");
    copyFileSync(path.resolve("scripts/installation-agent.mjs"), client);
    await assert.rejects(
      run(process.execPath, [client, "--config", "/nonexistent/config.json", "request-coordinator"], { env: withoutBuilds }),
      (error) => /reserved for the Vorteo :: Builds thread/.test(String(error.stderr)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the coordinator's publication tooling stays unguarded and self-contained", () => {
  // The coordinator runs publish-instance-web.mjs from the release during Host installs.
  const source = readFileSync(path.resolve("scripts/publish-instance-web.mjs"), "utf8");
  assert.doesNotMatch(source, /builds-guard|assertBuildsCoordinator/);
});
