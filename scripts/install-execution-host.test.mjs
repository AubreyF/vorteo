import { expect, test, vi } from "vitest";
import { postCoordinatorRequest } from "./installation-agent.mjs";
import fs from "node:fs/promises";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createServer } from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import {
  assertContainerProfileLauncher,
  assertProtectedPaths,
  assertSessionHostJobRemoved,
  validateInstallPlan,
  configureWebSource,
} from "./install-execution-host.mjs";

import {
  digest,
  publicationBindingPath,
  readPublicationBinding,
} from "./instance-web-artifact.mjs";

test("Dev bootstrap requires the fixed profile client in both supervisor and worker", () => {
  const expected = "/fixture/.local/share/vorteo-installation-client/client.json";
  expect(() =>
    assertContainerProfileLauncher({ expected, supervisor: expected, worker: expected }),
  ).not.toThrow();
  for (const [supervisor, worker] of [
    [null, null],
    [expected, null],
    [null, expected],
    ["/other/client.json", expected],
    [expected, "/other/client.json"],
  ]) {
    expect(() => assertContainerProfileLauncher({ expected, supervisor, worker })).toThrow(
      "VORTEO_INSTALLATION_CLIENT_CONFIG",
    );
  }
});

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
        url: "/api/installation/restart-requests?requireOwnerApproval=1",
        token: "Bearer scoped-test-token",
      },
      {
        method: "GET",
        url: `/api/installation/restart-requests/${id}?requireOwnerApproval=1`,
        token: "Bearer scoped-test-token",
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["host", "container-daemon"])(
  "Dev command uploads source for %s without changing the live interface",
  async (target) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "installation-source-test-"));
    const run = promisify(execFile);
    const repository = path.join(root, "repository");
    mkdirSync(repository);
    const git = async (...args) => (await run("git", args, { cwd: repository })).stdout.trim();
    const put = (file, value) => {
      const destination = path.join(repository, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, value);
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
        if (new URL(req.url, "http://localhost").pathname === "/api/installation/update-source") {
          res.end(
            JSON.stringify({
              target,
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
        metadata = JSON.parse(
          Buffer.from(req.headers["x-vorteo-update"], "base64").toString("utf8"),
        );
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
        target,
        "--reason-file",
        reason,
        "--update",
        "--repository",
        repository,
      ];
      await run(process.execPath, command);
      expect(metadata.request.target).toBe(target);
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
      // Installation should acquire only the approved commit, not unrelated source branches.
      writeFileSync(path.join(hostRepository, "refs/heads/unrelated"), baseCommit + "\n");
      await run(
        process.execPath,
        [path.resolve("scripts/prepare-installation-update.mjs"), request],
        { timeout: 60_000 },
      );
      const candidateRepository = path.join(work, "repository");
      const candidateRefs = await run("git", ["for-each-ref", "--format=%(refname)"], {
        cwd: candidateRepository,
      });
      expect(candidateRefs.stdout.trim()).toBe("refs/heads/main");
      expect(existsSync(path.join(candidateRepository, ".git/objects/info/alternates"))).toBe(
        false,
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
  },
  90_000,
);

test("Dev builds remain inactive until exact-source activation and retain the previous release", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "installation-dev-build-"));
  const releases = path.join(root, "releases");
  const previous = path.join(releases, "previous");
  const home = path.join(root, "home");
  const link = path.join(releases, "current");
  mkdirSync(previous, { recursive: true });
  mkdirSync(home);
  symlinkSync(previous, link);
  const baseCommit = "b".repeat(40);
  writeFileSync(
    path.join(previous, ".installation-source.json"),
    JSON.stringify({ sourceCommit: baseCommit }),
  );
  const supervisor = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    env: { ...process.env, PASEO_MANAGED_RELEASE_LINK: link, PASEO_MANAGED_RELEASE_ROOT: releases },
    stdio: "ignore",
  });
  writeFileSync(
    path.join(home, "managed-supervisor.json"),
    JSON.stringify({ version: 1, pid: supervisor.pid, root: releases, link }),
  );
  const source = path.join(root, "source");
  mkdirSync(source);
  writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "dev-update-fixture",
      version: "1.0.0",
      scripts: {
        postinstall: "node build.cjs",
        "build:server": "node build.cjs",
      },
    }),
  );
  const buildFile = path.join(source, "build.cjs");
  writeFileSync(buildFile, "throw new Error('expected build failure');");
  const run = promisify(execFile);
  const helper = readFileSync(
    new URL("./installation-container-runtime.mjs", import.meta.url),
    "utf8",
  );
  const settings = {
    releaseRoot: releases,
    currentReleaseLink: link,
    home,
    node: process.execPath,
  };
  const update = { sourceCommit: "a".repeat(40), baseCommit, sha256: "d".repeat(64), bytes: 50 };
  const command = (operation, archive) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ["--input-type=module", "--eval", helper, JSON.stringify({ settings, ...operation })],
        { timeout: 30000 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(JSON.parse(stdout));
        },
      );
      child.stdin.end(archive);
    });
  const archiveFile = path.join(root, "source.tar");
  const prepare = async (jobId) => {
    await run("tar", ["-cf", archiveFile, "-C", source, "."]);
    const archive = readFileSync(archiveFile);
    return command(
      {
        action: "prepare",
        previous,
        jobId,
        update,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
      },
      archive,
    );
  };
  try {
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
      { cwd: source },
    );
    await expect(prepare("a430b160-00a2-4d3e-bd91-d2eef4db7493")).rejects.toThrow(
      "Dev build failed before activation",
    );
    expect((await command({ action: "inspect" })).release).toBe(previous);
    writeFileSync(
      buildFile,
      "const fs=require('fs'); for(const file of ['packages/server/dist/server/server/daemon-worker.js','packages/server/dist/scripts/supervisor-entrypoint.js']){fs.mkdirSync(require('path').dirname(file),{recursive:true});fs.writeFileSync(file,'process.exit(0)');}",
    );
    const candidate = await prepare("a430b160-00a2-4d3e-bd91-d2eef4db7494");
    expect((await command({ action: "inspect" })).release).toBe(previous);
    expect(candidate.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    const activation = {
      action: "activate",
      previous,
      release: candidate.release,
      update,
      artifactSha256: candidate.artifactSha256,
    };
    expect((await command({ ...activation, action: "verify-candidate" })).artifactSha256).toBe(
      candidate.artifactSha256,
    );
    const workerFile = path.join(
      candidate.release,
      "packages/server/dist/server/server/daemon-worker.js",
    );
    writeFileSync(workerFile, "throw new Error('changed candidate');");
    await expect(command({ ...activation, action: "verify-candidate" })).rejects.toThrow(
      "content changed",
    );
    await expect(command(activation)).rejects.toThrow("content changed");
    expect((await command({ action: "inspect" })).release).toBe(previous);
    writeFileSync(workerFile, "process.exit(0)");
    await expect(
      command({ ...activation, update: { ...update, sha256: "e".repeat(64) } }),
    ).rejects.toThrow("differs from approval");
    await command(activation);
    expect((await command({ action: "inspect" })).sourceCommit).toBe(update.sourceCommit);
    await command({ action: "restore", previous, release: candidate.release });
    expect((await command({ action: "inspect" })).sourceCommit).toBe(baseCommit);
    expect(existsSync(candidate.release)).toBe(true);
    await expect(
      command({ action: "restore", previous, release: candidate.release }),
    ).rejects.toThrow("selection changed");
  } finally {
    const closed = new Promise((resolve) => supervisor.once("close", resolve));
    supervisor.kill("SIGTERM");
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

async function webSourceFixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "web-source-setup-")));
  const repository = path.join(root, "publishing");
  const protectedRepository = path.join(root, "protected");
  const destination = path.join(root, "served");
  mkdirSync(repository);
  mkdirSync(destination);
  function git(directory, ...args) {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  git(repository, "init", "-b", "integration");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "Test");
  writeFileSync(path.join(repository, "source.txt"), "installed source");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "Installed");
  git(root, "clone", "--no-hardlinks", repository, protectedRepository);
  writeFileSync(path.join(repository, "source.txt"), "current interface source");
  git(repository, "commit", "-qam", "Interface");
  const sourceCommit = git(repository, "rev-parse", "HEAD");
  const html = "verified interface";
  writeFileSync(path.join(destination, "index.html"), html);
  writeFileSync(
    path.join(destination, "release.json"),
    JSON.stringify({
      sha256: digest(html),
      sourceCommit,
      integrationRef: "refs/heads/integration",
    }),
  );
  const calls = path.join(root, "docker-calls.jsonl");
  const mounts = path.join(root, "mounts.json");
  writeFileSync(mounts, "[]");
  const docker = path.join(root, "docker-fixture");
  writeFileSync(
    docker,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif(process.argv[2] === 'ps') console.log('fixture');\nelse if(process.argv[2] === 'inspect') console.log(JSON.stringify([{Mounts: JSON.parse(fs.readFileSync(${JSON.stringify(mounts)}, 'utf8'))}]));\nelse process.exit(91);\n`,
    { mode: 0o700 },
  );
  const config = {
    sourceUpdates: {
      sourceRepository: protectedRepository,
      webDirectory: destination,
      integrationRef: "refs/heads/integration",
    },
    webDistDir: destination,
    fixtureUnrelated: "preserve config verbatim",
  };
  const configFile = path.join(root, "coordinator.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  const plan = path.join(root, "plan.json");
  writeFileSync(plan, JSON.stringify({ configFile, docker, repository }), { mode: 0o600 });
  return {
    root,
    repository,
    protectedRepository,
    destination,
    sourceCommit,
    configFile,
    plan,
    mounts,
    calls,
    config,
    git,
    docker,
  };
}

test("web source setup reads actual config, seeds live history and preserves config and selection", async () => {
  const f = await webSourceFixture();
  try {
    const original = readFileSync(f.configFile);
    const index = readFileSync(path.join(f.destination, "index.html"));
    const receipt = readFileSync(path.join(f.destination, "release.json"));
    const head = f.git(f.protectedRepository, "rev-parse", "HEAD");
    const refs = f.git(f.protectedRepository, "show-ref");
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.resolve("scripts/install-execution-host.mjs"),
      "configure-web-source",
      "--plan",
      f.plan,
    ]);
    const result = JSON.parse(stdout);
    expect(result.sourceCommit).toBe(f.sourceCommit);
    expect(result.bindingFile).toBe(publicationBindingPath(f.destination));
    expect(await readPublicationBinding(f.destination)).toMatchObject({
      sourceRepository: f.protectedRepository,
      webDirectory: f.destination,
    });
    const binding = readFileSync(result.bindingFile);
    await configureWebSource(f.plan);
    expect(readFileSync(result.bindingFile)).toEqual(binding);
    expect(readFileSync(f.configFile)).toEqual(original);
    expect(readFileSync(path.join(f.destination, "index.html"))).toEqual(index);
    expect(readFileSync(path.join(f.destination, "release.json"))).toEqual(receipt);
    expect(existsSync(path.join(f.destination, ".current"))).toBe(false);
    expect(f.git(f.protectedRepository, "rev-parse", "HEAD")).toBe(head);
    expect(f.git(f.protectedRepository, "show-ref")).toBe(
      `${refs}\n${f.sourceCommit} refs/vorteo-publications/${f.sourceCommit}`,
    );
    expect(readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse)).toEqual([
      ["ps", "-aq"],
      ["inspect", "fixture"],
      ["ps", "-aq"],
      ["inspect", "fixture"],
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.each(["new binding", "matching retry"])(
  "web source setup retains %s after directory sync failure and reconciles on retry",
  async (mode) => {
    const f = await webSourceFixture();
    try {
      if (mode === "matching retry") await configureWebSource(f.plan);
      const bindingFile = publicationBindingPath(f.destination);
      const beforeBinding = existsSync(bindingFile) ? readFileSync(bindingFile) : null;
      const original = readFileSync(f.configFile);
      const index = readFileSync(path.join(f.destination, "index.html"));
      const receipt = readFileSync(path.join(f.destination, "release.json"));
      const open = fs.open.bind(fs);
      const syncs = [];
      const closes = [];
      vi.spyOn(fs, "open").mockImplementation(async (file, ...args) => {
        const handle = await open(file, ...args);
        if (file === f.root && args[0] === "r") {
          const sync = vi.spyOn(handle, "sync");
          if (syncs.length === 0)
            sync.mockRejectedValueOnce(new Error("injected directory sync failure"));
          syncs.push(sync);
          closes.push(vi.spyOn(handle, "close"));
        }
        return handle;
      });
      await expect(configureWebSource(f.plan)).rejects.toThrow("directory sync failure");
      expect(syncs).toHaveLength(1);
      expect(syncs[0]).toHaveBeenCalledOnce();
      expect(closes[0]).toHaveBeenCalledOnce();
      const binding = readFileSync(bindingFile);
      if (beforeBinding) expect(binding).toEqual(beforeBinding);
      const inode = (await fs.stat(bindingFile)).ino;
      expect(await readPublicationBinding(f.destination)).toMatchObject({
        sourceRepository: f.protectedRepository,
        webDirectory: f.destination,
      });
      expect((await fs.readdir(f.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(existsSync(path.join(f.destination, ".publish-lock"))).toBe(false);
      const refs = f.git(f.protectedRepository, "show-ref");
      expect(await configureWebSource(f.plan)).toEqual({
        bindingFile,
        sourceCommit: f.sourceCommit,
      });
      expect(syncs).toHaveLength(2);
      expect(syncs[1]).toHaveBeenCalledOnce();
      expect(closes[1]).toHaveBeenCalledOnce();
      expect(readFileSync(bindingFile)).toEqual(binding);
      expect((await fs.stat(bindingFile)).ino).toBe(inode);
      expect(f.git(f.protectedRepository, "show-ref")).toBe(refs);
      expect(readFileSync(f.configFile)).toEqual(original);
      expect(readFileSync(path.join(f.destination, "index.html"))).toEqual(index);
      expect(readFileSync(path.join(f.destination, "release.json"))).toEqual(receipt);
      expect(existsSync(path.join(f.destination, ".current"))).toBe(false);
      expect(existsSync(path.join(f.destination, ".publish-lock"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.each(["repository", "config", "binding-parent", "writable-parent"])(
  "web source setup rejects unsafe protection: %s",
  async (mode) => {
    const f = await webSourceFixture();
    try {
      let source = f.protectedRepository;
      if (mode === "config") source = f.configFile;
      if (mode === "binding-parent") {
        source = path.join(f.root, "guest-descendant");
        mkdirSync(source);
      }
      if (mode === "writable-parent") chmodSync(f.root, 0o777);
      else writeFileSync(f.mounts, JSON.stringify([{ Type: "bind", RW: true, Source: source }]));
      await expect(configureWebSource(f.plan)).rejects.toThrow(
        /writable container bind|protected and Host-owned/,
      );
      expect(existsSync(publicationBindingPath(f.destination))).toBe(false);
      expect(existsSync(path.join(f.destination, ".publish-lock"))).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.each(["lineage", "conflict", "config-mismatch", "config-race", "missing-graph"])(
  "web source setup refuses invalid setup: %s",
  async (mode) => {
    const f = await webSourceFixture();
    try {
      const beforeConfig = readFileSync(f.configFile);
      if (mode === "lineage")
        writeFileSync(
          path.join(f.destination, "release.json"),
          JSON.stringify({ sha256: digest("verified interface") }),
        );
      else if (mode === "conflict") {
        await configureWebSource(f.plan);
        const another = path.join(f.root, "another-protected");
        f.git(f.root, "clone", "--no-hardlinks", f.protectedRepository, another);
        f.config.sourceUpdates.sourceRepository = another;
        writeFileSync(f.configFile, JSON.stringify(f.config));
      } else if (mode === "config-mismatch") {
        f.config.webDistDir = f.repository;
        writeFileSync(f.configFile, JSON.stringify(f.config));
      } else if (mode === "config-race") {
        writeFileSync(
          f.docker,
          readFileSync(f.docker, "utf8") +
            `\nfs.appendFileSync(${JSON.stringify(f.configFile)}, '\\n');\n`,
        );
      } else {
        const blob = f.git(f.repository, "rev-parse", `${f.sourceCommit}:source.txt`);
        rmSync(path.join(f.repository, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
      }
      const expectedConfig = readFileSync(f.configFile);
      await expect(configureWebSource(f.plan)).rejects.toThrow();
      if (mode === "config-race")
        expect(readFileSync(f.configFile, "utf8")).toBe(expectedConfig.toString() + "\n\n");
      else expect(readFileSync(f.configFile)).toEqual(expectedConfig);
      if (mode !== "conflict")
        expect(existsSync(publicationBindingPath(f.destination))).toBe(false);
      expect(existsSync(path.join(f.destination, ".publish-lock"))).toBe(false);
      if (mode === "lineage" || mode === "missing-graph")
        expect(expectedConfig).toEqual(beforeConfig);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test("coordinator transport retains a sixteen-minute deadline and cleans up after completion", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, body });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "retained", status: "pending" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const scheduled = [];
  const cleared = [];
  const token = Symbol("deadline");
  try {
    const response = await postCoordinatorRequest(
      new URL(`http://127.0.0.1:${server.address().port}/prepare`),
      {
        headers: { "Content-Type": "application/json" },
        body: '{"id":"retained"}',
      },
      {
        setTimeout(_callback, milliseconds) {
          scheduled.push(milliseconds);
          return token;
        },
        clearTimeout(timer) {
          cleared.push(timer);
        },
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "retained", status: "pending" });
    expect(requests).toEqual([{ method: "POST", body: '{"id":"retained"}' }]);
    expect(scheduled).toEqual([16 * 60_000]);
    expect(cleared).toEqual([token]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test.each(["headers", "body"])(
  "coordinator transport bounds stalled %s by the original deadline without retry",
  async (phase) => {
    const arrived = Promise.withResolvers();
    const disconnected = Promise.withResolvers();
    let requests = 0;
    const server = createServer((req, res) => {
      requests += 1;
      req.socket.once("close", () => disconnected.resolve());
      req.resume();
      if (phase === "body") {
        res.writeHead(201);
        res.write('{"id":');
      }
      arrived.resolve();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const scheduled = [];
    const cleared = [];
    let expire;
    const token = Symbol("deadline");
    try {
      const pending = postCoordinatorRequest(
        new URL(`http://127.0.0.1:${server.address().port}/prepare`),
        { headers: {}, body: "{}" },
        {
          setTimeout(callback, milliseconds) {
            expire = callback;
            scheduled.push(milliseconds);
            return token;
          },
          clearTimeout(timer) {
            cleared.push(timer);
          },
        },
      );
      const rejection = expect(pending).rejects.toThrow();
      await arrived.promise;
      expect(scheduled).toEqual([16 * 60_000]);
      expire();
      await rejection;
      await disconnected.promise;
      expect(requests).toBe(1);
      expect(cleared).toEqual([token]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test("coordinator transport cleans up connection failure without retry", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    res.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cleared = [];
  const token = Symbol("deadline");
  try {
    await expect(
      postCoordinatorRequest(
        new URL(`http://127.0.0.1:${server.address().port}/prepare`),
        { headers: {}, body: "{}" },
        {
          setTimeout() {
            return token;
          },
          clearTimeout(timer) {
            cleared.push(timer);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(requests).toBe(1);
    expect(cleared).toEqual([token]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("coordinator transport rejects redirects without forwarding or retrying preparation", async () => {
  const urls = [];
  const server = createServer((req, res) => {
    urls.push(req.url);
    req.resume();
    res.writeHead(302, { Location: "/unexpected" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await expect(
      postCoordinatorRequest(new URL(`http://127.0.0.1:${server.address().port}/prepare`), {
        headers: {},
        body: "{}",
      }),
    ).rejects.toThrow("redirected");
    expect(urls).toEqual(["/prepare"]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("standalone copied coordinator CLI submits once without package dependencies and exits after receipt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "installation-coordinator-standalone-"));
  const id = "6eb00d50-5af8-4333-89cb-40c98be430d7";
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    calls.push({ method: req.method, url: req.url, body: text });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.method === "GET"
          ? {
              coordinatorMaintenance: {
                available: true,
                automaticAvailable: true,
                ownerApprovalRequired: false,
              },
            }
          : { id, status: "pending" },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const script = path.join(root, "installation-agent.mjs");
    writeFileSync(script, readFileSync(path.resolve("scripts/installation-agent.mjs")));
    const config = path.join(root, "client.json");
    writeFileSync(
      config,
      JSON.stringify({
        kind: "host-agent",
        origin: `http://127.0.0.1:${server.address().port}`,
        publicOrigin: "https://installation.example.test",
        token: "inert-fixture",
      }),
    );
    const preparation = path.join(root, "preparation.json");
    writeFileSync(preparation, JSON.stringify({ id }));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [script, "--config", config, "request-coordinator", "--request-file", preparation],
      { timeout: 10_000 },
    );
    expect(JSON.parse(stdout)).toEqual({
      id,
      status: "pending",
      approvalUrl: `https://installation.example.test/settings/general?installation=1&bootstrap=${id}`,
    });
    expect(calls).toEqual([
      { method: "GET", url: "/api/installation/capabilities", body: "" },
      {
        method: "POST",
        url: "/api/installation/coordinator-requests",
        body: JSON.stringify({ preparation: { id } }),
      },
    ]);
    expect(existsSync(path.join(root, "node_modules"))).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("session host commands need the advertised capability and send only the operation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "installation-agent-session-host-"));
  const status = { supported: true, installed: false };
  const calls = [];
  let capability = { available: true, ownerApprovalRequired: true };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    calls.push({ method: req.method, url: req.url, token: req.headers.authorization, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/installation/capabilities") {
      res.end(JSON.stringify(capability === undefined ? {} : { sessionHostJob: capability }));
      return;
    }
    if (req.url === "/api/installation/session-host") {
      res.end(JSON.stringify(status));
      return;
    }
    res.statusCode = 201;
    res.end(
      JSON.stringify({
        target: "session-host",
        id: body.id,
        operation: body.operation,
        status: "pending",
        stage: "prepared",
        planSha256: "a".repeat(64),
        plan: { label: "local.vorteo.fixture.session-host" },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const run = promisify(execFile);
  const client = (kind, ...args) => {
    const config = path.join(root, `${kind}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        origin: `http://127.0.0.1:${server.address().port}`,
        publicOrigin: "https://installation.example.test",
        token: "scoped-test-token",
        kind,
      }),
    );
    return run(process.execPath, [
      path.resolve("scripts/installation-agent.mjs"),
      "--config",
      config,
      ...args,
    ]);
  };
  try {
    const requested = JSON.parse(
      (await client("host-agent", "request-session-host", "--install", "--reason", "Phase 1"))
        .stdout,
    );
    expect(requested).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      operation: "session-host-install",
      status: "pending",
      stage: "prepared",
      planSha256: "a".repeat(64),
      approvalUrl: `https://installation.example.test/settings/general?installation=1&sessionHost=${requested.id}`,
    });
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET /api/installation/capabilities",
      "POST /api/installation/session-host-requests",
    ]);
    expect(calls[1]).toMatchObject({
      token: "Bearer scoped-test-token",
      body: { id: requested.id, operation: "session-host-install", reason: "Phase 1" },
    });
    expect(Object.keys(calls[1].body).toSorted()).toEqual(["id", "operation", "reason"]);

    await client("host-agent", "request-session-host", "--remove");
    expect(calls.at(-1).body).toMatchObject({
      operation: "session-host-remove",
      reason: "Requested by a Host agent through the installation client.",
    });
    // A restart is sent only to a coordinator that advertises it; older ones would reject it.
    const before = calls.length;
    await expect(client("host-agent", "request-session-host", "--restart")).rejects.toThrow(
      "does not support session host restarts",
    );
    expect(calls.slice(before).map(({ url }) => url)).toEqual(["/api/installation/capabilities"]);
    capability = { available: true, ownerApprovalRequired: true, restart: true };
    await client("host-agent", "request-session-host", "--restart", "--reason", "New release");
    expect(calls.at(-1).body).toMatchObject({
      operation: "session-host-restart",
      reason: "New release",
    });
    capability = { available: true, ownerApprovalRequired: true };
    expect(JSON.parse((await client("host-agent", "session-host-status")).stdout)).toEqual(status);
    expect(calls.at(-1)).toMatchObject({ method: "GET", url: "/api/installation/session-host" });

    // Refusals happen before any request: ambiguous operation, Dev client, missing capability.
    calls.length = 0;
    await expect(
      client("host-agent", "request-session-host", "--install", "--remove"),
    ).rejects.toThrow("exactly one of --install, --remove or --restart");
    await expect(client("container-agent", "request-session-host", "--install")).rejects.toThrow(
      "trusted Host client",
    );
    expect(calls).toEqual([]);
    // Unavailable to this token, an older coordinator without the field, or another shape.
    for (const refused of [{ available: false, ownerApprovalRequired: true }, undefined, true]) {
      capability = refused;
      await expect(client("host-agent", "request-session-host", "--install")).rejects.toThrow(
        "does not advertise session host jobs",
      );
      await expect(client("host-agent", "session-host-status")).rejects.toThrow(
        "does not advertise session host jobs",
      );
    }
    expect(calls.map(({ url }) => url)).toEqual(
      Array.from({ length: 6 }, () => "/api/installation/capabilities"),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("installation removal waits until the session host job is removed", async () => {
  const record = { installationId: "00000000-0000-4000-8000-000000000001" };
  const label = `local.vorteo.${record.installationId}.session-host`;
  const calls = [];
  const ports = ({ loaded, plist }) => ({
    uid: 501,
    launchAgents: "/fixture/LaunchAgents",
    exists: (file) => plist && file === `/fixture/LaunchAgents/${label}.plist`,
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (!loaded) throw new Error("Could not find service");
      return "";
    },
  });
  for (const state of [
    { loaded: true, plist: false },
    { loaded: false, plist: true },
  ])
    await expect(assertSessionHostJobRemoved(record, ports(state))).rejects.toThrow(
      `Remove the session host job (${label}) from Installation controls`,
    );
  await expect(
    assertSessionHostJobRemoved(record, ports({ loaded: false, plist: false })),
  ).resolves.toBeUndefined();
  // Inspection only: the installer never stops the session host job itself.
  expect(calls).toEqual(Array(3).fill(["/bin/launchctl", "print", `gui/501/${label}`]));
});
