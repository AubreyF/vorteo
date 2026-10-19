import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { SourceUpdateSchema } from "@getpaseo/protocol/execution-installation";

const execute = promisify(execFile);
const commit = SourceUpdateSchema.shape.sourceCommit;
export const DevRepairSourceSchema = z.strictObject({
  baseCommit: commit,
  sourceCommit: commit,
  integrationRef: z.string().startsWith("refs/heads/"),
  contributionCommits: z.array(commit).max(100),
});
export type DevRepairSource = z.infer<typeof DevRepairSourceSchema>;
interface PreparationInput extends DevRepairSource {
  repository: string;
  directory: string;
}
export class DevSourceRepairError extends Error {}

/** Prepare only committed objects. The caller persists the capture and rechecks
 * its request revision and selection before adding this owner contribution.
 * No source checkout, build script, selection or lifecycle action runs here. */
export async function prepareDevRepairBundle(input: PreparationInput) {
  const snapshot = DevRepairSourceSchema.parse({
    baseCommit: input.baseCommit,
    sourceCommit: input.sourceCommit,
    integrationRef: input.integrationRef,
    contributionCommits: input.contributionCommits,
  });
  const temporary = await mkdtemp(path.join(input.directory, "dev-repair-"));
  const repository = path.join(temporary, "objects.git");
  const env = {
    NODE_ENV: "production" as const,
    PATH: process.env.PATH,
    HOME: temporary,
    XDG_CONFIG_HOME: temporary,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  async function git(...args: string[]) {
    const result = await execute(
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
        "--git-dir",
        repository,
        ...args,
      ],
      { env, cwd: temporary, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return result.stdout.trim();
  }
  try {
    await execute("git", ["init", "--bare", "--template=", repository], { env, timeout: 15_000 });
    await git("check-ref-format", snapshot.integrationRef);
    await git(
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      input.repository,
      `${snapshot.baseCommit}:refs/repair/base`,
      `${snapshot.sourceCommit}:${snapshot.integrationRef}`,
    );
    await git("merge-base", "--is-ancestor", snapshot.baseCommit, snapshot.sourceCommit);
    for (const source of snapshot.contributionCommits) {
      try {
        await git("merge-base", "--is-ancestor", source, snapshot.sourceCommit);
      } catch (error) {
        throw new DevSourceRepairError(
          "Installed Host source does not preserve every queued contribution. Integrate the missing source before repair.",
          { cause: error },
        );
      }
    }
    if (snapshot.baseCommit === snapshot.sourceCommit)
      throw new DevSourceRepairError(
        "Dev already selects this source; source delivery cannot repair its runtime failure.",
      );
    const file = path.join(temporary, "repair.bundle");
    await git("bundle", "create", file, `${snapshot.baseCommit}..${snapshot.integrationRef}`);
    const bundle = await readFile(file);
    const update = SourceUpdateSchema.parse({
      baseCommit: snapshot.baseCommit,
      sourceCommit: snapshot.sourceCommit,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      bytes: bundle.length,
    });
    return { update, bundle };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
