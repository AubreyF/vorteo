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
  readdirSync,
  existsSync,
  chmodSync,
  realpathSync,
  statSync,
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
  configureSystemSource,
  configureProjectsFolder,
  repairProjectsFolderWorktreeLinks,
  writeContainerSystemSource,
} from "./install-execution-host.mjs";
import { formatWorktreeLinkReport } from "./lib/worktree-links.mjs";
import {
  mergeProjectsFolderSettings,
  mountsFolderAtIdenticalPath,
} from "./lib/projects-folder.mjs";
import {
  containerCheckoutPath,
  mergeSystemSource,
  writeSystemSource,
} from "./lib/system-source.mjs";

import {
  digest,
  publicationBindingPath,
  readPublicationBinding,
} from "./instance-web-artifact.mjs";
// These tests run the installation client's request commands, which only Vorteo :: Builds may run.
process.env.VORTEO_BUILDS = "1";

test("Dev bootstrap requires the fixed profile client in both supervisor and worker", () => {
  const expected = "/fixture/.local/share/vorteo-installation-client/client.json";
  expect(() =>
    assertContainerProfileLauncher({
      expected,
      supervisor: expected,
      worker: expected,
    }),
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
    calls.push({
      method: req.method,
      url: req.url,
      token: req.headers.authorization,
    });
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
        url: `/api/installation/restart-requests/${id}?sourceBatches=1&requireOwnerApproval=1`,
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
        // Records the heap option the export ran with, as Metro's workers inherit it.
        "#!/usr/bin/env node\nconst fs=require('fs'); const path=require('path'); const out=process.argv[process.argv.indexOf('--output-dir')+1]; fs.mkdirSync(path.join(out,'_expo/static/js/web'),{recursive:true}); fs.writeFileSync(path.join(out,'index.html'),'<html><head></head><body><script src=\"/_expo/static/js/web/entry-abc123.js\" defer></script></body></html>'); fs.writeFileSync(path.join(out,'_expo/static/js/web/entry-abc123.js'),'console.log(1)'); fs.writeFileSync(path.join(out,'node-options.txt'),process.env.NODE_OPTIONS||'');",
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
      // Installs publish the same entry preloads and build metadata as guarded web builds.
      const entry = readFileSync(path.join(prepared.exported, "index.html"), "utf8");
      expect(entry).toContain(
        '<link rel="preload" as="script" href="/_expo/static/js/web/entry-abc123.js">',
      );
      expect(entry).toContain(
        `<meta name="vorteo-build" content="1.0.0 (${sourceCommit.slice(0, 12)})">`,
      );
      expect(readFileSync(path.join(prepared.exported, "node-options.txt"), "utf8")).toMatch(
        /--max-old-space-size=8192$/,
      );
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

// The Dev runtime helper inspects /proc, so this exercises it only where Dev runs.
test.skipIf(process.platform !== "linux")(
  "Dev builds remain inactive until exact-source activation and retain the previous release",
  async () => {
    // The runtime compares the link against the canonical release root; macOS
    // temporary paths under /var resolve to /private/var.
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "installation-dev-build-")));
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
      env: {
        ...process.env,
        PASEO_MANAGED_RELEASE_LINK: link,
        PASEO_MANAGED_RELEASE_ROOT: releases,
      },
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
    const update = {
      sourceCommit: "a".repeat(40),
      baseCommit,
      sha256: "d".repeat(64),
      bytes: 50,
    };
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
        command({
          ...activation,
          update: { ...update, sha256: "e".repeat(64) },
        }),
      ).rejects.toThrow("differs from approval");
      await command(activation);
      expect((await command({ action: "inspect" })).sourceCommit).toBe(update.sourceCommit);
      await command({
        action: "restore",
        previous,
        release: candidate.release,
      });
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
  },
  60000,
);

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
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(
      calls,
    )}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif(process.argv[2] === 'ps') console.log('fixture');\nelse if(process.argv[2] === 'inspect') console.log(JSON.stringify([{Mounts: JSON.parse(fs.readFileSync(${JSON.stringify(
      mounts,
    )}, 'utf8'))}]));\nelse process.exit(91);\n`,
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
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  const plan = path.join(root, "plan.json");
  writeFileSync(plan, JSON.stringify({ configFile, docker, repository }), {
    mode: 0o600,
  });
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

// Each setup creates and fetches real repositories; allow for a loaded Host.
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
}, 60_000);

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
  60_000,
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
    expect(await response.json()).toEqual({
      id: "retained",
      status: "pending",
    });
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
    calls.push({
      method: req.method,
      url: req.url,
      token: req.headers.authorization,
      body,
    });
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
      body: {
        id: requested.id,
        operation: "session-host-install",
        reason: "Phase 1",
      },
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
    capability = {
      available: true,
      ownerApprovalRequired: true,
      restart: true,
    };
    await client("host-agent", "request-session-host", "--restart", "--reason", "New release");
    expect(calls.at(-1).body).toMatchObject({
      operation: "session-host-restart",
      reason: "New release",
    });
    capability = { available: true, ownerApprovalRequired: true };
    expect(JSON.parse((await client("host-agent", "session-host-status")).stdout)).toEqual(status);
    expect(calls.at(-1)).toMatchObject({
      method: "GET",
      url: "/api/installation/session-host",
    });

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

test("System settings keep operator keys and refuse a damaged file", () => {
  const merged = JSON.parse(
    mergeSystemSource(
      JSON.stringify({
        adopt: { runner: "wks_01" },
        source: { repository: "/repo" },
      }),
      { checkout: "/src/vorteo", ref: "abc" },
    ),
  );
  expect(merged).toEqual({
    adopt: { runner: "wks_01" },
    source: { repository: "/repo", checkout: "/src/vorteo", ref: "abc" },
  });
  expect(() => mergeSystemSource("{", { checkout: "/src/vorteo" })).toThrow("not valid JSON");
  expect(() => mergeSystemSource("[]", { checkout: "/src/vorteo" })).toThrow("JSON object");
  expect(() => mergeSystemSource(null, { checkout: "relative" })).toThrow("absolute");
});

test("Host System settings are written privately and only when they change", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vorteo-system-home-"));
  try {
    const first = writeSystemSource({
      paseoHome: home,
      checkout: "/src/vorteo",
    });
    expect(first.changed).toBe(true);
    expect((statSync(first.file).mode & 0o777).toString(8)).toBe("600");
    expect(writeSystemSource({ paseoHome: home, checkout: "/src/vorteo" }).changed).toBe(false);
    expect(JSON.parse(readFileSync(first.file, "utf8"))).toEqual({
      source: { checkout: "/src/vorteo" },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a Host checkout maps into the container through its deepest bind mount", () => {
  const mounts = [
    { Type: "bind", Source: "/Users/me", Destination: "/home/me" },
    { Type: "bind", Source: "/Users/me/dev", Destination: "/Users/guest/dev" },
    { Type: "volume", Source: "/var/lib/docker/x", Destination: "/data" },
  ];
  expect(containerCheckoutPath(mounts, "/Users/me/dev/vorteo")).toBe("/Users/guest/dev/vorteo");
  expect(containerCheckoutPath(mounts, "/Users/me/dev")).toBe("/Users/guest/dev");
  expect(containerCheckoutPath(mounts, "/Users/me-else/vorteo")).toBeNull();
  expect(containerCheckoutPath(mounts, "/opt/vorteo")).toBeNull();
});

test("configure-system-source records the checkout for the Host and the Dev container", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vorteo-system-root-"));
  const previous = {
    inspect: process.env.FAKE_INSPECT,
    node: process.env.REAL_NODE,
  };
  try {
    const checkout = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vorteo-checkout-")));
    mkdirSync(path.join(checkout, ".git"));
    const hostHome = path.join(root, "state/host");
    const devHome = path.join(root, "dev-home");
    mkdirSync(devHome, { recursive: true });
    mkdirSync(path.join(devHome, "system"));
    writeFileSync(
      path.join(devHome, "system/system.json"),
      JSON.stringify({ absorb: { projects: ["prj_0a"] } }),
    );
    // A stand-in Docker: inspect returns the mounts, exec runs the script with this Node.
    const docker = path.join(root, "docker");
    writeFileSync(
      docker,
      '#!/bin/sh\nif [ "$1" = inspect ]; then cat "$FAKE_INSPECT"; exit 0; fi\nshift 5\nexec "$REAL_NODE" "$@"\n',
    );
    chmodSync(docker, 0o755);
    const inspect = path.join(root, "inspect.json");
    writeFileSync(
      inspect,
      JSON.stringify([
        {
          Mounts: [
            {
              Type: "bind",
              Source: path.dirname(checkout),
              Destination: "/Users/guest/tmp",
            },
          ],
        },
      ]),
    );
    process.env.FAKE_INSPECT = inspect;
    process.env.REAL_NODE = process.execPath;
    const configFile = path.join(root, "coordinator.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        containerSourceUpdates: {
          docker,
          containerId: "dev",
          user: "paseo",
          node: "node",
          home: devHome,
        },
      }),
    );
    writeFileSync(path.join(root, "installation.json"), JSON.stringify({ hostHome, configFile }));

    const result = await configureSystemSource(root, checkout);

    const guestCheckout = path.posix.join("/Users/guest/tmp", path.basename(checkout));
    expect(result.dev).toEqual({ written: true, checkout: guestCheckout });
    expect(JSON.parse(readFileSync(path.join(hostHome, "system/system.json"), "utf8"))).toEqual({
      source: { checkout },
    });
    expect(JSON.parse(readFileSync(path.join(devHome, "system/system.json"), "utf8"))).toEqual({
      absorb: { projects: ["prj_0a"] },
      source: { checkout: guestCheckout },
    });

    writeFileSync(inspect, JSON.stringify([{ Mounts: [] }]));
    const unshared = await writeContainerSystemSource(
      JSON.parse(readFileSync(configFile, "utf8")).containerSourceUpdates,
      checkout,
    );
    expect(unshared.written).toBe(false);
    expect(unshared.reason).toContain("cannot see");
    rmSync(checkout, { recursive: true, force: true });
  } finally {
    for (const [key, value] of [
      ["FAKE_INSPECT", previous.inspect],
      ["REAL_NODE", previous.node],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Projects folder settings keep operator keys and earlier locations", () => {
  const merged = JSON.parse(
    mergeProjectsFolderSettings(
      JSON.stringify({
        migrateFrom: ["/Users/guest/dev"],
        aliases: ["/mnt/dev"],
        note: "kept",
      }),
      {
        root: "/Users/owner/dev",
        migrateFrom: ["/Users/guest/dev", "/Users/owner/dev"],
        aliases: ["/Users/guest/dev", "/Users/owner/dev"],
        keepPaths: ["/Users/guest/dev/freed", "/Users/guest/dev/freed"],
      },
    ),
  );
  expect(merged).toEqual({
    note: "kept",
    root: "/Users/owner/dev",
    migrateFrom: ["/Users/guest/dev"],
    aliases: ["/mnt/dev", "/Users/guest/dev"],
    keepPaths: ["/Users/guest/dev/freed"],
  });
  expect(() => mergeProjectsFolderSettings("[]", { root: "/dev" })).toThrow("JSON object");
  expect(() => mergeProjectsFolderSettings(null, { root: "dev" })).toThrow("absolute");
});

test("only an identical-path writable bind mount shares the Projects folder", () => {
  const folder = "/Users/owner/dev";
  expect(
    mountsFolderAtIdenticalPath([{ Type: "bind", Source: folder, Destination: folder }], folder),
  ).toBe(true);
  expect(
    mountsFolderAtIdenticalPath(
      [{ Type: "bind", Source: "/Users/owner", Destination: "/Users/owner" }],
      folder,
    ),
  ).toBe(true);
  expect(
    mountsFolderAtIdenticalPath(
      [{ Type: "bind", Source: folder, Destination: "/Users/guest/dev" }],
      folder,
    ),
  ).toBe(false);
  expect(
    mountsFolderAtIdenticalPath(
      [{ Type: "bind", Source: folder, Destination: folder, RW: false }],
      folder,
    ),
  ).toBe(false);
});

test("configure-projects-folder writes both daemons and trusts the folder in Dev", async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vorteo-projects-root-")));
  const keys = ["FAKE_INSPECT", "REAL_NODE", "FAKE_GIT_LOG", "FAKE_GIT_EXISTING", "FAKE_REALPATHS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const folder = path.join(root, "dev");
    mkdirSync(folder);
    const hostHome = path.join(root, "state/host");
    const devHome = path.join(root, "dev-home");
    mkdirSync(devHome, { recursive: true });
    // A stand-in Docker: inspect returns the mounts, git calls are recorded, and the
    // settings script runs with this Node.
    const docker = path.join(root, "docker");
    writeFileSync(
      docker,
      [
        "#!/bin/sh",
        'if [ "$1" = inspect ]; then cat "$FAKE_INSPECT"; exit 0; fi',
        // The container's real paths, when a test stands in for a symlink inside it.
        'case "$*" in *realpathSync*) if [ -n "$FAKE_REALPATHS" ]; then printf "%s" "$FAKE_REALPATHS"; exit 0; fi;; esac',
        'if [ "$5" = git ]; then echo "$*" >> "$FAKE_GIT_LOG";',
        '  case "$*" in *--get-all*) printf "%s" "$FAKE_GIT_EXISTING";; esac; exit 0; fi',
        "shift 5",
        'exec "$REAL_NODE" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(docker, 0o755);
    const inspect = path.join(root, "inspect.json");
    process.env.FAKE_INSPECT = inspect;
    process.env.REAL_NODE = process.execPath;
    process.env.FAKE_GIT_LOG = path.join(root, "git.log");
    process.env.FAKE_GIT_EXISTING = "/Users/guest/dev/app\n/home/paseo/x\n";
    const configFile = path.join(root, "coordinator.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        containerSourceUpdates: {
          docker,
          containerId: "dev",
          user: "paseo",
          node: "node",
          home: devHome,
        },
      }),
    );
    writeFileSync(
      path.join(root, "installation.json"),
      JSON.stringify({
        hostHome,
        configFile,
        release: path.join(root, "release"),
      }),
    );

    // Without an identical-path mount, only the Host is configured.
    writeFileSync(
      inspect,
      JSON.stringify([
        {
          Mounts: [{ Type: "bind", Source: folder, Destination: "/Users/guest/dev" }],
        },
      ]),
    );
    const unaliased = await configureProjectsFolder(root, {
      folder,
      migrateFrom: ["/Users/guest/dev"],
    });
    expect(unaliased.dev.written).toBe(false);
    expect(unaliased.dev.reason).toContain("no symlink");
    expect(unaliased.dev.commands.root).toBe(
      `mkdir -p '${root}' && test ! -e '${folder}' && ln -s '/Users/guest/dev' '${folder}'`,
    );
    expect(unaliased.dev.commands.verify).toBe(
      `readlink '${folder}' && test "$(cd '${folder}' && pwd -P)" = '/Users/guest/dev'`,
    );
    expect(unaliased.dev.commands.dockerRoot).toContain("exec --user root 'dev' sh -c");
    expect(existsSync(path.join(devHome, "projects-folder.json"))).toBe(false);
    // The Host records the same earlier paths even while Dev is refused.
    expect(JSON.parse(readFileSync(path.join(hostHome, "projects-folder.json"), "utf8"))).toEqual({
      root: folder,
      migrateFrom: ["/Users/guest/dev"],
    });

    // Once the folder's own path leads to the mount inside the container, it is an alias.
    process.env.FAKE_REALPATHS = JSON.stringify(["/Users/guest/dev", "/Users/guest/dev"]);
    const aliased = await configureProjectsFolder(root, {
      folder,
      migrateFrom: ["/Users/guest/dev"],
    });
    expect(aliased.dev).toEqual({
      written: true,
      root: folder,
      aliases: ["/Users/guest/dev"],
      trusted: [`${folder}/*`, `${folder}/app`],
    });
    expect(JSON.parse(readFileSync(path.join(devHome, "projects-folder.json"), "utf8"))).toEqual({
      root: folder,
      migrateFrom: ["/Users/guest/dev"],
      aliases: ["/Users/guest/dev"],
    });
    // The Host gets the alias found in Dev and the kept paths, so shared keys map alike.
    const kept = await configureProjectsFolder(root, {
      folder,
      migrateFrom: ["/Users/guest/dev"],
      keepPaths: ["/Users/guest/dev/freed"],
    });
    expect(kept.host.changed).toBe(true);
    expect(JSON.parse(readFileSync(path.join(hostHome, "projects-folder.json"), "utf8"))).toEqual({
      root: folder,
      migrateFrom: ["/Users/guest/dev"],
      aliases: ["/Users/guest/dev"],
      keepPaths: ["/Users/guest/dev/freed"],
    });
    rmSync(path.join(devHome, "projects-folder.json"));
    rmSync(path.join(hostHome, "projects-folder.json"));
    rmSync(process.env.FAKE_GIT_LOG);
    delete process.env.FAKE_REALPATHS;

    writeFileSync(inspect, JSON.stringify([{ Mounts: [] }]));
    const unmounted = await configureProjectsFolder(root, { folder });
    expect(unmounted.dev.written).toBe(false);
    expect(unmounted.dev.reason).toContain("does not mount");

    writeFileSync(
      inspect,
      JSON.stringify([{ Mounts: [{ Type: "bind", Source: folder, Destination: folder }] }]),
    );
    const result = await configureProjectsFolder(root, {
      folder,
      migrateFrom: ["/Users/guest/dev"],
    });
    expect(result.dev).toEqual({
      written: true,
      root: folder,
      aliases: [],
      trusted: [`${folder}/*`, `${folder}/app`],
    });
    expect(JSON.parse(readFileSync(path.join(devHome, "projects-folder.json"), "utf8"))).toEqual({
      root: folder,
      migrateFrom: ["/Users/guest/dev"],
    });
    expect(readFileSync(process.env.FAKE_GIT_LOG, "utf8")).toContain(
      `--add safe.directory ${folder}/*`,
    );

    // The Host's own files may never sit in the guest-writable folder.
    writeFileSync(
      path.join(root, "installation.json"),
      JSON.stringify({ hostHome: path.join(folder, "host"), configFile }),
    );
    await expect(configureProjectsFolder(root, { folder })).rejects.toThrow("outside");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair-projects-folder-worktree-links rewrites old Dev links once, with backups", async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vorteo-worktree-links-")));
  // The old container path never exists here, like /Users/<old guest user>/dev on the Host.
  const old = path.join(base, "missing-guest/dev");
  const folder = path.join(base, "dev");
  const outside = path.join(base, "outside");
  mkdirSync(folder);
  mkdirSync(outside);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  function repository(name) {
    const directory = path.join(folder, name);
    mkdirSync(directory);
    git(directory, "init", "-q", "-b", "main");
    git(
      directory,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    return directory;
  }
  function worktree(repo, directory) {
    git(repo, "worktree", "add", "-q", "-b", path.basename(directory), directory);
    return {
      admin: path.join(repo, ".git/worktrees", path.basename(directory), "gitdir"),
      link: path.join(directory, ".git"),
    };
  }
  // Writes both links as Dev wrote them before the rewrite: through the old container path.
  function useOldPrefix({ admin, link }) {
    writeFileSync(admin, readFileSync(admin, "utf8").replace(folder, old));
    writeFileSync(link, readFileSync(link, "utf8").replace(folder, old));
  }
  const snapshot = (files) => files.map((file) => readFileSync(file, "utf8"));
  const prunable = (repo) => git(repo, "worktree", "list", "--porcelain").includes("prunable");
  try {
    const app = repository("app");
    const legacy = worktree(app, path.join(folder, "app-feature"));
    useOldPrefix(legacy);
    const logicalTree = worktree(app, path.join(folder, "app-current"));
    const away = worktree(app, path.join(outside, "app-away"));
    const kept = repository("kept");
    const keptLinks = worktree(kept, path.join(folder, "kept-feature"));
    useOldPrefix(keptLinks);
    const files = [legacy, logicalTree, away, keptLinks].flatMap(({ admin, link }) => [
      admin,
      link,
    ]);
    expect(prunable(app)).toBe(true);

    const options = {
      folder,
      from: [old],
      keepPaths: [path.join(old, "kept")],
    };
    const before = snapshot(files);
    const dryRun = repairProjectsFolderWorktreeLinks(options);
    expect(dryRun.written).toBeNull();
    expect(snapshot(files)).toEqual(before);
    expect(readdirSync(path.dirname(legacy.admin)).some((name) => name.includes(".before-"))).toBe(
      false,
    );
    expect(
      dryRun.scan.changes.map(({ file, current, next }) => ({
        file,
        current,
        next,
      })),
    ).toEqual([
      {
        file: legacy.admin,
        current: `${old}/app-feature/.git\n`,
        next: `${folder}/app-feature/.git\n`,
      },
      {
        file: legacy.link,
        current: `gitdir: ${old}/app/.git/worktrees/app-feature\n`,
        next: `gitdir: ${folder}/app/.git/worktrees/app-feature\n`,
      },
    ]);
    expect(dryRun.scan.skipped).toEqual([
      {
        repository: app,
        worktree: "app-away",
        link: `${outside}/app-away/.git`,
        reason: "is outside the Projects folder",
      },
      {
        repository: app,
        worktree: "app-current",
        link: `${folder}/app-current/.git`,
        reason: "already uses the logical path",
      },
      { repository: kept, worktree: "1 worktree(s)", reason: "kept path" },
      {
        repository: path.join(folder, "kept-feature"),
        link: `${old}/kept/.git/worktrees/kept-feature`,
        reason: "kept path",
      },
    ]);
    expect(formatWorktreeLinkReport(dryRun)).toContain("Dry run: nothing was written.");

    const applied = repairProjectsFolderWorktreeLinks({
      ...options,
      apply: true,
    });
    expect(applied.written.map(({ file }) => file)).toEqual([legacy.admin, legacy.link]);
    // Both backups sit in the admin directory, so neither shows up in the worktree's status.
    const adminDirectory = path.dirname(legacy.admin);
    expect(applied.written.map(({ backup }) => path.relative(adminDirectory, backup))).toEqual([
      expect.stringMatching(/^gitdir\.before-worktree-link-rewrite-/u),
      expect.stringMatching(/^worktree-git-file\.before-worktree-link-rewrite-/u),
    ]);
    for (const { file, backup } of applied.written)
      expect(readFileSync(backup, "utf8")).toBe(before[files.indexOf(file)]);
    expect(snapshot([legacy.admin, legacy.link])).toEqual([
      `${folder}/app-feature/.git\n`,
      `gitdir: ${folder}/app/.git/worktrees/app-feature\n`,
    ]);
    expect(snapshot(files.slice(2))).toEqual(before.slice(2));
    expect(prunable(app)).toBe(false);
    expect(git(legacy.link.replace(/\/\.git$/u, ""), "status", "--short")).toBe("");

    const again = repairProjectsFolderWorktreeLinks({
      ...options,
      apply: true,
    });
    expect(again.scan.changes).toEqual([]);
    expect(again.written).toEqual([]);

    // A worktree under an old prefix whose target is gone on the Host is left alone.
    rmSync(path.join(folder, "app-current"), { recursive: true });
    writeFileSync(logicalTree.admin, `${old}/app-current/.git\n`);
    const missing = repairProjectsFolderWorktreeLinks(options);
    expect(missing.scan.changes).toEqual([]);
    expect(missing.scan.skipped).toContainEqual({
      repository: app,
      worktree: "app-current",
      link: `${old}/app-current/.git`,
      reason: "its worktree does not exist under either form",
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
