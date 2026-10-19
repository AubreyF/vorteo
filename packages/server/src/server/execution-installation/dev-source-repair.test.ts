import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareDevRepairBundle } from "./dev-source-repair.js";
import { InstallationSourceUpdates } from "./source-updates.js";
import { InstallationConfigSchema } from "./config.js";

test("repair bundles exactly the captured descendant without changing the source repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-repair-bundle-"));
  const repository = path.join(root, "source");
  await mkdir(repository);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@localhost",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@localhost",
      },
    }).trim();
  try {
    git("init", "--initial-branch=integration");
    await writeFile(path.join(repository, "value"), "base");
    git("add", ".");
    git("commit", "-m", "base");
    const baseCommit = git("rev-parse", "HEAD");
    await writeFile(path.join(repository, "value"), "contribution");
    git("commit", "-am", "contribution");
    const contribution = git("rev-parse", "HEAD");
    await writeFile(path.join(repository, "value"), "captured");
    git("commit", "-am", "captured");
    const sourceCommit = git("rev-parse", "HEAD");
    await writeFile(path.join(repository, "value"), "newer");
    git("commit", "-am", "newer");
    const head = git("rev-parse", "HEAD");
    const release = path.join(root, "host-release");
    const devReceipt = path.join(root, "dev.json");
    await mkdir(release);
    await writeFile(
      path.join(release, ".installation-source.json"),
      JSON.stringify({ sourceCommit }),
    );
    await writeFile(devReceipt, JSON.stringify({ sourceCommit: baseCommit }));
    const config = InstallationConfigSchema.parse({
      public: {
        version: 1,
        installationId: "00000000-0000-4000-8000-000000000001",
        origin: "https://example.test",
        environments: [
          { kind: "host", serverId: "host", endpoint: "localhost:1", useTls: false },
          { kind: "container", serverId: "dev", endpoint: "localhost:2", useTls: false },
        ],
      },
      listenPort: 4000,
      webDistDir: root,
      stateDir: root,
      ownerPasswordHash: "$2-fixture",
      hostAgentTokenHash: "a".repeat(64),
      containerAgentTokenHash: "b".repeat(64),
      host: {
        endpoint: "localhost:1",
        password: "fixture",
        launchdService: "gui/501/local.vorteo.fixture",
      },
      container: { endpoint: "localhost:2", password: "fixture" },
      sourceUpdates: {
        sourceRepository: repository,
        releaseRoot: root,
        currentReleaseLink: release,
        webDirectory: root,
        toolingDirectory: root,
        integrationRef: "refs/heads/integration",
      },
      containerSourceUpdates: {
        sourceRepository: repository,
        toolingDirectory: root,
        integrationRef: "refs/heads/integration",
        receiptFile: devReceipt,
        docker: "/fixture/docker",
        containerId: "c".repeat(64),
        user: "fixture",
        node: "/fixture/node",
        home: "/fixture/home",
        releaseRoot: "/fixture/releases",
        currentReleaseLink: "/fixture/current",
      },
    });
    const updates = new InstallationSourceUpdates(config, "container-daemon");
    const capture = updates.captureDevRepair([]);
    expect(capture.sourceCommit).toBe(sourceCommit);
    expect((await updates.prepareDevRepair(capture, [])).sourceCommit).toBe(sourceCommit);
    await writeFile(devReceipt, JSON.stringify({ sourceCommit: contribution }));
    await expect(updates.prepareDevRepair(capture, [])).rejects.toThrow(
      "Dev repair source changed",
    );
    await writeFile(devReceipt, JSON.stringify({ sourceCommit: baseCommit }));
    await writeFile(
      path.join(release, ".installation-source.json"),
      JSON.stringify({ sourceCommit: head }),
    );
    await expect(updates.prepareDevRepair(capture, [])).rejects.toThrow(
      "Dev repair source changed",
    );

    const before = await readFile(path.join(repository, ".git/config"));
    const result = await prepareDevRepairBundle({
      repository,
      directory: root,
      integrationRef: "refs/heads/integration",
      baseCommit,
      sourceCommit,
      contributionCommits: [contribution],
    });
    expect(result.update).toEqual({
      baseCommit,
      sourceCommit,
      bytes: result.bundle.length,
      sha256: createHash("sha256").update(result.bundle).digest("hex"),
    });
    const file = path.join(root, "repair.bundle");
    await writeFile(file, result.bundle);
    expect(git("bundle", "list-heads", file)).toBe(`${sourceCommit} refs/heads/integration`);
    git("bundle", "verify", file);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(repository, ".git/config"))).toEqual(before);
    expect(git("status", "--porcelain")).toBe("");
    await expect(
      prepareDevRepairBundle({
        repository,
        directory: root,
        integrationRef: "refs/heads/integration",
        baseCommit,
        sourceCommit: contribution,
        contributionCommits: [sourceCommit],
      }),
    ).rejects.toThrow("does not preserve every queued contribution");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
