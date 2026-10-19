import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { prepareSourceBatch } from "./source-batches.js";

test.each([
  { damaged: false, ambiguous: true },
  { damaged: true, ambiguous: true },
  { damaged: false, ambiguous: false },
])(
  "later integrated source reconciles history without accepting damaged receipts: %j",
  async ({ damaged, ambiguous }) => {
    const root = await mkdtemp(path.join(tmpdir(), "source-repair-"));
    const repository = path.join(root, "repo");
    const directory = path.join(root, "bundles");
    await mkdir(repository);
    await mkdir(directory);
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
      await writeFile(path.join(repository, "value.txt"), "base\n");
      git("add", ".");
      git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD");
      await writeFile(path.join(repository, "value.txt"), "left\n");
      git("commit", "-am", "left");
      const left = git("rev-parse", "HEAD");
      git("checkout", "--detach", base);
      await writeFile(path.join(repository, "value.txt"), "right\n");
      git("commit", "-am", "right");
      const right = git("rev-parse", "HEAD");
      const accepted = ambiguous
        ? git("commit-tree", `${left}^{tree}`, "-p", left, "-p", right, "-m", "accepted")
        : left;
      const old = ambiguous
        ? git("commit-tree", `${right}^{tree}`, "-p", right, "-p", left, "-m", "old")
        : right;
      expect(git("merge-base", "--all", accepted, old).split("\n")).toHaveLength(ambiguous ? 2 : 1);
      const resolved = git(
        "commit-tree",
        `${right}^{tree}`,
        "-p",
        accepted,
        "-p",
        old,
        "-m",
        "explicit resolution",
      );
      async function contribution(sourceCommit: string) {
        git("update-ref", "refs/heads/integration", sourceCommit);
        const file = path.join(root, `${sourceCommit}.bundle`);
        git("bundle", "create", file, `${base}..refs/heads/integration`);
        const bytes = await readFile(file);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        await writeFile(path.join(directory, `${sha256}.bundle`), bytes);
        return {
          id: randomUUID(),
          update: { sourceCommit, baseCommit: base, bytes: bytes.length, sha256 },
          reason: "Preserve original change",
          requester: "original-task",
          requestedBy: "container-agent" as const,
          createdAt: new Date().toISOString(),
          status: "queued" as const,
          detail: "",
        };
      }
      const original = await contribution(old);
      const repair = await contribution(resolved);
      if (damaged) original.update.bytes++;
      let staged: Buffer | undefined;
      const result = await prepareSourceBatch({
        directory,
        repository,
        integrationRef: "refs/heads/integration",
        baseCommit: accepted,
        webCommit: accepted,
        contributions: [original, repair],
        stage: (_update, bundle) => {
          staged = bundle;
        },
      });
      if (damaged) {
        expect(result.batch.status).toBe("conflict");
        expect(result.batch.contributions[0]?.status).toBe("invalid");
        expect(staged).toBeUndefined();
      } else {
        expect(result.batch.status).toBe("ready");
        expect(result.batch.contributions.map((item) => item.status)).toEqual([
          "included",
          "included",
        ]);
        expect(result.batch.contributions[0]).toMatchObject({
          id: original.id,
          requester: original.requester,
          update: original.update,
        });
        const file = path.join(root, "result.bundle");
        await writeFile(file, staged!);
        git("fetch", file, "refs/heads/integration:refs/heads/result");
        expect(git("show", `${result.update!.sourceCommit}:value.txt`)).toBe("right");
        git("merge-base", "--is-ancestor", old, result.update!.sourceCommit);
        expect(git("log", "-1", "--format=%B", result.update!.sourceCommit)).toContain(original.id);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
