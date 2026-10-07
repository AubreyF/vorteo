import { expect, test } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
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

test("Dev update command uploads committed incremental source and preparation preserves the live interface", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "installation-source-test-"));
  const run = promisify(execFile);
  const repository = path.join(root, "repository");
  mkdirSync(repository);
  const git = async (...args) => (await run("git", args, { cwd: repository })).stdout.trim();
  const put = (file, value) => {
    const target = path.join(repository, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  let server;
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "fixture@example.test");
    await git("config", "user.name", "Fixture");
    put(
      "package.json",
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        private: true,
        workspaces: ["packages/*"],
        scripts: {
          postinstall: "node build.cjs",
          "build:server": "node build.cjs",
          "build:app-deps": "node build.cjs",
        },
      }),
    );
    put("build.cjs", "require('fs').writeFileSync('built', 'yes')");
    put("packages/app/package.json", JSON.stringify({ name: "fixture-app", version: "1.0.0" }));
    put(
      "packages/expo/package.json",
      JSON.stringify({
        name: "expo",
        version: "1.0.0",
        bin: { expo: "cli.cjs" },
        scripts: {
          install:
            "node -e \"require('fs').writeFileSync('native-built', process.platform + '/' + process.arch)\"",
        },
      }),
    );
    put(
      "packages/expo/cli.cjs",
      "#!/usr/bin/env node\nconst fs=require('fs'); const path=require('path'); const out=process.argv[process.argv.indexOf('--output-dir')+1]; fs.mkdirSync(out,{recursive:true}); fs.writeFileSync(path.join(out,'index.html'),'<script src=\"/app.js\"></script>'); fs.writeFileSync(path.join(out,'app.js'),'console.log(1)');",
    );
    await run(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: repository },
    );
    await git("add", ".");
    await git("-c", "core.hooksPath=/dev/null", "commit", "-m", "base");
    const baseCommit = await git("rev-parse", "HEAD");
    const hostRepository = path.join(root, "host.git");
    await run("git", ["clone", "--bare", repository, hostRepository]);
    put("change.txt", "reviewed change");
    await git("add", ".");
    await git("-c", "core.hooksPath=/dev/null", "commit", "-m", "change");
    const sourceCommit = await git("rev-parse", "HEAD");
    let uploaded;
    let metadata;
    server = createServer(async (req, res) => {
      if (req.url === "/api/installation/update-source") {
        res.end(
          JSON.stringify({
            baseCommit,
            integrationRef: "refs/heads/main",
            maxBytes: 128 * 1024 * 1024,
          }),
        );
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      uploaded = Buffer.concat(chunks);
      metadata = JSON.parse(Buffer.from(req.headers["x-vorteo-update"], "base64").toString("utf8"));
      res.end(JSON.stringify({ id: "a430b160-00a2-4d3e-bd91-d2eef4db7493" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const clientConfig = path.join(root, "client.json");
    writeFileSync(
      clientConfig,
      JSON.stringify({
        origin: `http://127.0.0.1:${server.address().port}`,
        token: "request-only",
        kind: "container-agent",
      }),
    );
    const reason = path.join(root, "reason");
    writeFileSync(reason, "Install reviewed source");
    const command = [
      path.resolve("scripts/installation-agent.mjs"),
      "--config",
      clientConfig,
      "request-restart",
      "--target",
      "host",
      "--reason-file",
      reason,
      "--update",
      "--repository",
      repository,
    ];
    await run(process.execPath, command);
    expect(metadata.update.sourceCommit).toBe(sourceCommit);
    expect(metadata.update.sha256).toBe(createHash("sha256").update(uploaded).digest("hex"));
    expect(existsSync(path.join(repository, "built"))).toBe(false);
    const bundle = path.join(root, "source.bundle");
    writeFileSync(bundle, uploaded);
    const web = path.join(root, "web");
    mkdirSync(web);
    const html = "old interface";
    writeFileSync(path.join(web, "index.html"), html);
    writeFileSync(
      path.join(web, "release.json"),
      JSON.stringify({
        sourceCommit: baseCommit,
        integrationRef: "refs/heads/main",
        sha256: createHash("sha256").update(html).digest("hex"),
      }),
    );
    const work = path.join(root, "work");
    mkdirSync(work);
    const resultFile = path.join(work, "prepared.json");
    const request = path.join(root, "request.json");
    writeFileSync(
      request,
      JSON.stringify({
        update: metadata.update,
        work,
        bundle,
        sourceRepository: hostRepository,
        integrationRef: "refs/heads/main",
        webDirectory: web,
        resultFile,
      }),
    );
    await run(
      process.execPath,
      [path.resolve("scripts/prepare-installation-update.mjs"), request],
      { timeout: 60_000 },
    );
    const prepared = JSON.parse(readFileSync(resultFile, "utf8"));
    expect(
      JSON.parse(readFileSync(path.join(prepared.release, ".installation-source.json"), "utf8"))
        .sourceCommit,
    ).toBe(sourceCommit);
    expect(
      JSON.parse(readFileSync(path.join(prepared.exported, ".build-manifest.json"), "utf8"))
        .deployment.expectedRelease,
    ).toEqual(expect.any(String));
    expect(readFileSync(path.join(prepared.release, "packages/expo/native-built"), "utf8")).toBe(
      `${process.platform}/${process.arch}`,
    );
    expect(readFileSync(path.join(web, "index.html"), "utf8")).toBe(html);
    put("dirty.txt", "uncommitted");
    await expect(run(process.execPath, command)).rejects.toThrow("clean integration checkout");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
