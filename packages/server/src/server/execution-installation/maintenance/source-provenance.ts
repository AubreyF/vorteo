import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  constants,
  type BigIntStats,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { SourceUpdate } from "@getpaseo/protocol/execution-installation";
import { assertBootstrapPathsProtected } from "../coordinator-bootstrap-artifact.js";

const execute = promisify(execFile);
const gitEnvironment = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function fileIdentity(file: string): string {
  const stat = lstatSync(file, { bigint: true });
  if (
    realpathSync(file) !== file ||
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o022n) !== 0n
  )
    throw new Error("Source evidence requires protected canonical Host custody");
  return statIdentity(stat);
}

function statIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.uid,
    stat.gid,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function readSourceFile(file: string, maxBytes: number) {
  const before = fileIdentity(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (statIdentity(stat) !== before) throw new Error("Source evidence changed before opening");
    if (stat.size > BigInt(maxBytes)) throw new Error("Source evidence exceeds its size limit");
    const bytes = readFileSync(fd);
    if (
      bytes.length > maxBytes ||
      statIdentity(fstatSync(fd, { bigint: true })) !== before ||
      fileIdentity(file) !== before
    )
      throw new Error("Source evidence changed during reading");
    return {
      bytes,
      assertCurrent: () => {
        if (fileIdentity(file) !== before)
          throw new Error("Source evidence changed after validation");
      },
    };
  } finally {
    closeSync(fd);
  }
}

/** The protected Host batch already validates the inert contribution graph. This
 * binds its exact staged bytes and repository origin to native path custody. */
export async function inspectStandingSourceProvenance(input: {
  repository: string;
  bundleFile: string;
  update: SourceUpdate;
  writableMountRoots: readonly string[];
}) {
  await assertBootstrapPathsProtected(
    [input.repository, input.bundleFile],
    input.writableMountRoots,
  );
  const bundle = readSourceFile(input.bundleFile, 128 * 1024 * 1024);
  if (
    bundle.bytes.length !== input.update.bytes ||
    createHash("sha256").update(bundle.bytes).digest("hex") !== input.update.sha256
  )
    throw new Error("Staged source bytes differ from the exact request");
  const origin = await inspectRepositoryOrigin(input.repository, input.writableMountRoots);
  const assertBundleCurrent = bundle.assertCurrent;
  return {
    repository: origin.repository,
    assertCurrent: () => {
      assertBundleCurrent();
      origin.assertCurrent();
    },
  };
}

async function inspectRepositoryOrigin(repository: string, writableMountRoots: readonly string[]) {
  const retained: Array<() => void> = [];
  const seen = new Set<string>();
  let locator = repository;
  for (let depth = 0; depth < 4; depth++) {
    const current = realpathSync(locator);
    if (seen.has(current)) throw new Error("Source repository origin is circular");
    seen.add(current);
    const originalLocator = locator;
    retained.push(() => {
      if (realpathSync(originalLocator) !== current)
        throw new Error("Source repository selection changed");
    });
    await assertBootstrapPathsProtected([current], writableMountRoots);
    const common = (
      await execute("git", ["-C", current, "rev-parse", "--git-common-dir"], {
        env: gitEnvironment,
        timeout: 10_000,
        maxBuffer: 8192,
      })
    ).stdout.trim();
    const file = path.resolve(current, common, "config");
    await assertBootstrapPathsProtected([file], writableMountRoots);
    const config = readSourceFile(file, 1024 * 1024);
    retained.push(config.assertCurrent);
    const origin = (
      await execute(
        "git",
        ["config", "--no-includes", "--file", file, "--get", "remote.origin.url"],
        {
          env: gitEnvironment,
          timeout: 10_000,
          maxBuffer: 8192,
        },
      )
    ).stdout.trim();
    config.assertCurrent();
    if (path.isAbsolute(origin)) {
      locator = origin;
      continue;
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("Standing source repository origin is invalid");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("Standing source requires a credential-free HTTPS repository origin");
    return {
      repository: url.href,
      assertCurrent: () => {
        for (const check of retained) check();
      },
    };
  }
  throw new Error("Source repository origin chain exceeds its bound");
}
