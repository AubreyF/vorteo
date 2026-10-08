import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  releaseMetadata,
  reconcileReleaseMetadata,
  finalizeReleaseMetadata,
  type InertGit,
} from "./source-release-metadata.js";
import { createHash } from "node:crypto";
import type {
  SourceBatch,
  SourceContribution,
  SourceUpdate,
} from "@getpaseo/protocol/execution-installation";

const execute = promisify(execFile);
interface PreparationInput {
  directory: string;
  repository: string;
  integrationRef: string;
  baseCommit: string;
  webCommit: string;
  contributions: SourceContribution[];
  stage(update: SourceUpdate, bundle: Buffer): void;
}

/** No checkout, imported config, hooks, attributes driver commands, filters or build scripts. */
export async function prepareSourceBatch(
  input: PreparationInput,
): Promise<{ batch: SourceBatch; update?: SourceUpdate }> {
  const active = input.contributions.filter((item) => item.status !== "superseded");
  const sizes = new Map(active.map((item) => [item.update.sha256, item.update.bytes]));
  if ([...sizes.values()].reduce((sum, size) => sum + size, 0) > 128 * 1024 * 1024) {
    return {
      batch: {
        status: "conflict",
        contributions: input.contributions.map((item) =>
          item.status === "superseded"
            ? item
            : {
                ...item,
                status: "invalid",
                detail:
                  "Aggregate source bundles exceed 128 MiB. Split contributions before approval.",
              },
        ),
      },
    };
  }
  const temporary = mkdtempSync(path.join(input.directory, "prepare-"));
  const repository = path.join(temporary, "objects.git");
  // An allowlist matters: inherited GIT_CONFIG_COUNT, GIT_EXEC_PATH, alternates and
  // replacement objects can turn otherwise inert Git commands into code execution.
  const env = {
    NODE_ENV: "production" as const,
    PATH: process.env.PATH,
    HOME: temporary,
    XDG_CONFIG_HOME: temporary,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Vorteo source batch",
    GIT_AUTHOR_EMAIL: "installation@localhost",
    GIT_COMMITTER_NAME: "Vorteo source batch",
    GIT_COMMITTER_EMAIL: "installation@localhost",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const git = async (...args: string[]) =>
    (
      await execute(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.file.allow=always",
          "-c",
          "fetch.fsckObjects=true",
          "-c",
          "transfer.fsckObjects=true",
          "--git-dir",
          repository,
          ...args,
        ],
        { env, cwd: temporary, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      )
    ).stdout.trim();
  const contributions = structuredClone(input.contributions);
  try {
    await execute("git", ["init", "--bare", "--template=", repository], { env, timeout: 15_000 });
    // Uploaded attributes cannot select custom or union merge drivers. Unspecified
    // merge uses Git's normal text/binary detection and reports unresolved conflicts.
    mkdirSync(path.join(repository, "info"), { recursive: true });
    writeFileSync(path.join(repository, "info", "attributes"), "* !merge\n", { mode: 0o600 });
    await git(
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      input.repository,
      `${input.baseCommit}:refs/heads/installed`,
    );
    let head = input.baseCommit;
    const webCommit = input.webCommit;
    if (webCommit !== head) {
      await git(
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        input.repository,
        `${webCommit}:refs/heads/published`,
      );
      // A web-only release normally descends from the runtime. Divergent source
      // requires explicit integration instead of guessing which deployed tree wins.
      await git("merge-base", "--is-ancestor", head, webCommit);
      head = webCommit;
    }
    const hasReleaseMetadata = Boolean(await git("ls-tree", "--name-only", head, "package.json"));
    const replaceFiles = async (commit: string, files: Map<string, string>) => {
      await git("read-tree", commit);
      for (const [file, text] of files) {
        const entry = await git("ls-tree", commit, "--", file);
        if (!entry.startsWith("100644 blob "))
          throw new Error(`Release metadata must be a regular tracked file: ${file}`);
        const content = path.join(temporary, "metadata.json");
        writeFileSync(content, text, { mode: 0o600 });
        const blob = await git("hash-object", "-w", content);
        await git("update-index", "--add", "--cacheinfo", `100644,${blob},${file}`);
      }
      return git("write-tree");
    };
    const parents = new Set([input.baseCommit, webCommit]);
    for (const contribution of contributions) {
      if (contribution.status === "superseded") continue;
      const update = contribution.update;
      try {
        const bundleFile = path.join(input.directory, `${update.sha256}.bundle`);
        const bundle = readFileSync(bundleFile);
        if (
          bundle.length !== update.bytes ||
          createHash("sha256").update(bundle).digest("hex") !== update.sha256
        )
          throw new Error("Stored contribution bundle does not match its receipt");
        const refs = await git("bundle", "list-heads", bundleFile);
        if (!refs.split("\n").includes(`${update.sourceCommit} ${input.integrationRef}`))
          throw new Error("Bundle does not advertise the submitted integration commit");
        await git("bundle", "verify", bundleFile);
        await git(
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          bundleFile,
          `${input.integrationRef}:refs/contributions/${contribution.id}`,
        );
        if ((await git("cat-file", "-t", update.sourceCommit)) !== "commit")
          throw new Error("Source must be a commit");
        await git("merge-base", "--is-ancestor", update.baseCommit, input.baseCommit);
        await git("merge-base", "--is-ancestor", update.baseCommit, update.sourceCommit);
        const relatedHead = await acceptRelatedContribution(
          git,
          head,
          contribution,
          hasReleaseMetadata,
        );
        if (relatedHead) {
          head = relatedHead;
          parents.add(update.sourceCommit);
          continue;
        }
        const commonBase = await contributionMergeBase(git, head, update.sourceCommit);
        const metadata = hasReleaseMetadata
          ? await reconcileReleaseMetadata(git, commonBase, head, update.sourceCommit)
          : null;
        let mergeHead = head;
        let mergeBase = commonBase;
        let tree = await git("rev-parse", `${update.sourceCommit}^{tree}`);
        if (metadata) {
          mergeBase = await git(
            "commit-tree",
            await replaceFiles(commonBase, metadata.base),
            "-m",
            "Normalized release base",
          );
          mergeHead = await git(
            "commit-tree",
            await replaceFiles(head, metadata.left),
            "-p",
            mergeBase,
            "-m",
            "Normalized accepted source",
          );
          tree = await replaceFiles(update.sourceCommit, metadata.right);
        }
        // A synthetic single-parent commit pins the verified common base on Git 2.38+.
        const delta = await git(
          "commit-tree",
          tree,
          "-p",
          mergeBase,
          "-m",
          `Contribution ${contribution.id}`,
        );
        const merge = await mergeContribution(git, mergeHead, delta);
        if (merge.conflict !== null) {
          contribution.status = "conflict";
          contribution.detail = merge.conflict;
          continue;
        }
        let merged = merge.tree;
        if (metadata) {
          const scratch = await git("commit-tree", merged, "-m", "Check merged release metadata");
          const combined = await releaseMetadata(git, scratch);
          merged = await replaceFiles(scratch, combined.files(metadata.version, metadata.notes));
        }
        head = await git(
          "commit-tree",
          merged,
          "-p",
          head,
          "-p",
          update.sourceCommit,
          "-m",
          `Combine source contribution ${contribution.id}`,
        );
        parents.add(update.sourceCommit);
        contribution.status = "included";
        contribution.detail = `Included in ${head}`;
      } catch (error) {
        contribution.status = "invalid";
        contribution.detail =
          error instanceof Error ? error.message.slice(0, 8000) : "Contribution validation failed";
      }
    }
    if (contributions.some((item) => item.status === "conflict" || item.status === "invalid"))
      return { batch: { status: "conflict", contributions } };
    const included = contributions.filter((item) => item.status === "included");
    const provenance = included
      .map(
        (item) =>
          `Contribution: ${item.id}\nSource: ${item.update.sourceCommit}\nBase: ${item.update.baseCommit}\nBundle-SHA256: ${item.update.sha256}\nOrigin: ${item.requestedBy}\nRequester: ${item.requester ?? item.requestedBy}\nReason: ${item.reason}`,
      )
      .join("\n\n");
    let finalTree = await git("rev-parse", `${head}^{tree}`);
    if (hasReleaseMetadata) {
      const latestDate = included
        .map((item) => item.createdAt.slice(0, 10))
        .sort()
        .at(-1)!;
      const parentMetadata = await Promise.all(
        [...parents].map((parent) => releaseMetadata(git, parent)),
      );
      const files = await finalizeReleaseMetadata(
        git,
        head,
        [`Combine ${included.length} source contributions; retain their release notes below`],
        latestDate,
        parentMetadata.map((metadata) => metadata.version),
      );
      finalTree = await replaceFiles(head, files);
    }
    head = await git(
      "commit-tree",
      finalTree,
      ...[...parents].flatMap((parent) => ["-p", parent]),
      "-m",
      `Combine reviewed source contributions\n\n${provenance}`,
    );
    await git("update-ref", input.integrationRef, head);
    const bundleFile = path.join(temporary, "combined.bundle");
    await git("bundle", "create", bundleFile, `${input.baseCommit}..${input.integrationRef}`);
    const bundle = readFileSync(bundleFile);
    if (bundle.length > 128 * 1024 * 1024) {
      for (const item of included) {
        item.status = "invalid";
        item.detail = "Combined bundle exceeds 128 MiB. Split contributions before approval.";
      }
      return { batch: { status: "conflict", contributions, webCommit } };
    }
    const update = {
      sourceCommit: head,
      baseCommit: input.baseCommit,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      bytes: bundle.length,
    };
    input.stage(update, bundle);
    return { batch: { status: "ready", contributions, webCommit }, update };
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function acceptRelatedContribution(
  git: InertGit,
  head: string,
  contribution: SourceContribution,
  hasReleaseMetadata: boolean,
): Promise<string | null> {
  const source = contribution.update.sourceCommit;
  if (await isAncestor(git, source, head)) {
    contribution.status = "included";
    contribution.detail = `Already included in ${head}`;
    return head;
  }
  if (!(await isAncestor(git, head, source))) return null;
  // This commit already integrates the accepted source. Preserve its reviewed
  // tree instead of reconciling release history against an older runtime again.
  if (hasReleaseMetadata) await releaseMetadata(git, source);
  contribution.status = "included";
  contribution.detail = `Included integrated source ${source}`;
  return source;
}

async function mergeContribution(
  git: (...args: string[]) => Promise<string>,
  head: string,
  delta: string,
) {
  try {
    const output = await git("merge-tree", "--write-tree", "--name-only", head, delta);
    return { tree: output.split("\n")[0]!, conflict: null };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === 1 &&
      "stdout" in error &&
      typeof error.stdout === "string"
    )
      return { tree: "", conflict: error.stdout.split("\n").slice(1).join("\n").slice(0, 8000) };
    throw error;
  }
}

async function isAncestor(git: InertGit, ancestor: string, head: string) {
  try {
    await git("merge-base", "--is-ancestor", ancestor, head);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) return false;
    throw error;
  }
}

async function contributionMergeBase(git: InertGit, head: string, incoming: string) {
  // The upload base is a bundle prerequisite, not necessarily the latest shared
  // source. Reapplying already integrated work creates false conflicts.
  const bases = (await git("merge-base", "--all", head, incoming)).split("\n");
  if (bases.length !== 1 || !/^[a-f0-9]{40}$/.test(bases[0]!))
    throw new Error("Source has multiple merge bases; integrate explicitly");
  return bases[0]!;
}
