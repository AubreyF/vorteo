import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { assertProtectedPaths, validateInstallPlan } from "./install-execution-host.mjs";

test("protected paths cannot enter a guest bind, including through a symlink ancestor", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "installation-paths-"));
  try {
    const guest = path.join(root, "shared");
    mkdirSync(guest);
    const alias = path.join(root, "alias");
    symlinkSync(guest, alias);
    expect(() => assertProtectedPaths([path.join(alias, "new", "release")], [guest])).toThrow(
      "writable container bind",
    );
    expect(() => assertProtectedPaths([root], [guest])).toThrow("writable container bind");
    expect(() => assertProtectedPaths([guest], [path.parse(guest).root])).toThrow(
      "writable container bind",
    );
    expect(() =>
      assertProtectedPaths([path.join(root, "private", "release")], [guest]),
    ).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer requires a reviewed commit and distinct ports", () => {
  const plan = {
    root: "/tmp/private-installation",
    revision: "a".repeat(40),
    containerName: "existing-container",
    containerServerId: "guest-id",
    containerDaemonHome: "/tmp/test-container-home",
    containerPasswordFile: "/tmp/test-password",
    containerOrigin: "https://container.example.test",
  };
  expect(validateInstallPlan(plan).httpsPort).toBe(44444);
  expect(() => validateInstallPlan({ ...plan, revision: "main" })).toThrow("reviewed");
  expect(() => validateInstallPlan({ ...plan, hostPort: 6768 })).toThrow("distinct");
});

test("installed agent commands return a public approval link without authorizing a restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "installation-agent-links-"));
  const id = "df99c0d9-7b03-4632-a1e8-1941835be88a";
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, token: req.headers.authorization });
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id, status: "pending", target: "host" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const config = path.join(root, "client.json");
    const reason = path.join(root, "reason.txt");
    writeFileSync(
      config,
      JSON.stringify({
        origin: `http://127.0.0.1:${server.address().port}`,
        publicOrigin: "https://installation.example.test",
        token: "scoped-test-token",
        kind: "host-agent",
      }),
    );
    writeFileSync(reason, "Test link generation only");
    const run = promisify(execFile);
    for (const args of [
      ["request-restart", "--target", "host", "--reason-file", reason],
      ["restart-status", id],
    ]) {
      const { stdout } = await run(process.execPath, [
        path.resolve("scripts/installation-agent.mjs"),
        "--config",
        config,
        ...args,
      ]);
      expect(JSON.parse(stdout)).toEqual({
        id,
        status: "pending",
        target: "host",
        approvalUrl: `https://installation.example.test/settings/general?installation=1&restart=${id}`,
      });
    }
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/api/installation/restart-requests",
        token: "Bearer scoped-test-token",
      },
      {
        method: "GET",
        url: `/api/installation/restart-requests/${id}`,
        token: "Bearer scoped-test-token",
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
