import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";

function containsPath(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Mount roots must come from Host Docker inspection, never from the request. */
export async function assertBootstrapPathsProtected(
  files: readonly string[],
  writableMountRoots: readonly string[],
): Promise<void> {
  const roots = await Promise.all(writableMountRoots.map((root) => realpath(root)));
  for (const file of files) {
    const resolved = await realpath(file);
    if (roots.some((root) => containsPath(root, resolved) || containsPath(resolved, root)))
      throw new BootstrapRequestConflict(
        "Prepared bootstrap path overlaps a writable container mount",
      );
  }
}

/** Verifies prepared bytes only. Loaded service identity and configuration semantics
 * are separate admission checks, and must be repeated before lifecycle dispatch. */
export async function verifyBootstrapReleaseArtifacts(
  release: CoordinatorBootstrapPlan["candidate"],
  writableMountRoots: readonly string[],
): Promise<void> {
  await inspectBootstrapReleaseArtifacts(release, writableMountRoots);
}

/** Retain reviewed release declarations and every byte supplier before reading.
 * Runtime compatibility and current writable-mount evidence remain caller checks. */
export async function inspectBootstrapReleaseArtifacts(
  value: CoordinatorBootstrapPlan["candidate"],
  writableMountRoots: readonly string[],
  limits: BootstrapArtifactDigestLimits = {},
) {
  const release = structuredClone(value);
  const { signal, timeoutMs, maxFiles, maxBytes } = limits;
  const startedAt = Date.now();
  const checkBudget = () => {
    signal?.throwIfAborted();
    if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs)
      throw new BootstrapRequestConflict("Release verification deadline exceeded");
  };
  checkBudget();
  const files = [release.node, release.entrypoint, release.configuration, release.launcher];
  const receiptPath = path.join(release.directory, ".installation-source.json");
  const observed = new Map<string, BigIntStats>();
  for (const file of [...files.map((item) => item.path), receiptPath])
    observed.set(file, await lstat(file, { bigint: true }));
  await assertBootstrapPathsProtected(
    [release.directory, ...files.map((file) => file.path)],
    writableMountRoots,
  );
  if (!containsPath(release.directory, release.entrypoint.path))
    throw new BootstrapRequestConflict("Coordinator entrypoint is outside its prepared release");
  for (const file of files) {
    if ((await realpath(file.path)) !== file.path)
      throw new BootstrapRequestConflict("Prepared file requires a canonical path");
    const stat = observed.get(file.path)!;
    checkBudget();
    requireOwned(stat);
    if (!stat.isFile())
      throw new BootstrapRequestConflict("Prepared dependency must be a regular file");
    if ((await digestFile(file.path, stat, { checkBudget })) !== file.sha256)
      throw new BootstrapRequestConflict("Prepared dependency digest changed");
    if (file === release.node && (stat.mode & 0o100n) === 0n)
      throw new BootstrapRequestConflict("Prepared Node executable is not executable");
  }
  checkBudget();
  const receiptBytes = await readProtectedDocument(receiptPath);
  const receipt = z
    .object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(JSON.parse(receiptBytes.toString("utf8")));
  if (receipt.sourceCommit !== release.sourceCommit)
    throw new BootstrapRequestConflict("Prepared source does not match its installation receipt");
  checkBudget();
  const artifact = await inspectBootstrapArtifact(release.directory, {
    signal,
    timeoutMs: timeoutMs === undefined ? undefined : timeoutMs - (Date.now() - startedAt),
    maxFiles,
    maxBytes,
  });
  if (artifact.sha256 !== release.artifactSha256)
    throw new BootstrapRequestConflict("Prepared release artifact changed");
  const assertCurrent = () => {
    signal?.throwIfAborted();
    artifact.assertCurrent();
    for (const [file, stat] of observed) {
      if (realpathSync(file) !== file)
        throw new BootstrapRequestConflict("Prepared dependency canonical path changed");
      requireUnchanged(stat, lstatSync(file, { bigint: true }));
    }
    signal?.throwIfAborted();
  };
  checkBudget();
  assertCurrent();
  checkBudget();
  return { assertCurrent };
}

function identity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function requireUnchanged(before: BigIntStats, after: BigIntStats): void {
  if (identity(before) !== identity(after))
    throw new BootstrapRequestConflict("Prepared artifact changed during verification");
}

function requireOwned(stat: BigIntStats): void {
  if (!process.getuid || stat.uid !== BigInt(process.getuid()))
    throw new BootstrapRequestConflict("Prepared artifact must be owned by the Host account");
  // Symlink modes are not meaningful on macOS. Their targets are checked separately.
  if (!stat.isSymbolicLink() && (stat.mode & 0o022n) !== 0n)
    throw new BootstrapRequestConflict("Prepared artifact is writable by another account");
}

interface FileDigestOptions {
  verifyLinksInTree?: boolean;
  buffer?: Buffer;
  checkBudget?: () => void;
  maxBytes?: number;
  deadline?: number;
}

async function digestFile(
  file: string,
  expected: BigIntStats,
  {
    verifyLinksInTree = false,
    buffer = Buffer.alloc(64 * 1024),
    checkBudget,
    maxBytes,
    deadline,
  }: FileDigestOptions = {},
): Promise<string> {
  if (!verifyLinksInTree && expected.nlink !== 1n)
    throw new BootstrapRequestConflict("Prepared artifact contains a hard-linked file");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireUnchanged(expected, await handle.stat({ bigint: true }));
    const hash = createHash("sha256");
    let totalBytes = 0;
    for (;;) {
      checkBudget?.();
      if (deadline !== undefined && Date.now() >= deadline)
        throw new BootstrapRequestConflict("Prepared dependency verification timed out");
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      totalBytes += bytesRead;
      if (maxBytes !== undefined && totalBytes > maxBytes)
        throw new BootstrapRequestConflict("Prepared dependency exceeds byte limit");
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (deadline !== undefined && Date.now() >= deadline)
      throw new BootstrapRequestConflict("Prepared dependency verification timed out");
    requireUnchanged(expected, await handle.stat({ bigint: true }));
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Executables are streamed separately from small configuration documents.
 * Retain the same custody checks and bound both file growth and scan duration. */
export async function verifyBootstrapPreparedDependency(
  file: CoordinatorBootstrapPlan["candidate"]["node"],
  writableMountRoots: readonly string[],
  custody: "host" | "host-or-root" = "host",
): Promise<void> {
  await verifyPreparedDependency({ ...file }, writableMountRoots, custody);
}

/** Source-copy inventory may contain npm's internal executable hard links. Every
 * physical name must be canonical, protected, inside the source root and bound
 * to the same inode; ordinary external dependencies still require one link. */
export async function verifyBootstrapPreparedCopySource(
  file: CoordinatorBootstrapPlan["candidate"]["node"],
  sourceRoot: string,
  aliases: readonly string[],
  writableMountRoots: readonly string[],
): Promise<void> {
  await verifyPreparedDependency({ ...file }, writableMountRoots, "host", {
    root: sourceRoot,
    aliases: [...aliases],
  });
}

async function verifyPreparedDependency(
  file: CoordinatorBootstrapPlan["candidate"]["node"],
  writableMountRoots: readonly string[],
  custody: "host" | "host-or-root",
  copy?: { root: string; aliases: string[] },
): Promise<void> {
  const deadline = Date.now() + 30_000;
  const maxBytes = 256 * 1024 * 1024;
  await assertBootstrapPathsProtected([file.path], writableMountRoots);
  if ((await realpath(file.path)) !== file.path)
    throw new BootstrapRequestConflict("Prepared file requires a canonical path");
  const before = await lstat(file.path, { bigint: true });
  if (custody === "host-or-root" && before.uid === 0n) {
    if ((before.mode & 0o022n) !== 0n)
      throw new BootstrapRequestConflict("Native dependency is writable by another account");
  } else requireOwned(before);
  if (!before.isFile() || (!copy && before.nlink !== 1n) || before.size > BigInt(maxBytes))
    throw new BootstrapRequestConflict("Prepared dependency must be a bounded regular file");
  const aliasStats = copy
    ? await inspectCopyAliases(file.path, before, copy, writableMountRoots)
    : [];
  const digest = await digestFile(file.path, before, {
    maxBytes,
    deadline,
    verifyLinksInTree: !!copy,
  });
  for (const [alias, stat] of aliasStats) {
    requireUnchanged(stat, await lstat(alias, { bigint: true }));
    if ((await realpath(alias)) !== alias)
      throw new BootstrapRequestConflict("Prepared copy source custody changed");
  }
  requireUnchanged(before, await lstat(file.path, { bigint: true }));
  if (digest !== file.sha256)
    throw new BootstrapRequestConflict("Prepared dependency digest changed");
  if (Date.now() >= deadline)
    throw new BootstrapRequestConflict("Prepared dependency verification timed out");
}

async function inspectCopyAliases(
  file: string,
  before: BigIntStats,
  copy: { root: string; aliases: string[] },
  roots: readonly string[],
): Promise<Array<[string, BigIntStats]>> {
  const unique = new Set(copy.aliases);
  const complete = unique.size === copy.aliases.length && BigInt(unique.size) === before.nlink;
  if (
    !complete ||
    unique.size > 100_000 ||
    !unique.has(file) ||
    (await realpath(copy.root)) !== copy.root
  )
    throw new BootstrapRequestConflict("Prepared copy source hard links are incomplete");
  await assertBootstrapPathsProtected(copy.aliases, roots);
  const rootStat = await lstat(copy.root, { bigint: true });
  requireOwned(rootStat);
  if (!rootStat.isDirectory())
    throw new BootstrapRequestConflict("Prepared copy source root changed");
  const result: Array<[string, BigIntStats]> = [[copy.root, rootStat]];
  for (const alias of copy.aliases) {
    const stat = await lstat(alias, { bigint: true });
    requireOwned(stat);
    const sameFile =
      stat.isFile() &&
      stat.dev === before.dev &&
      stat.ino === before.ino &&
      stat.nlink === before.nlink;
    if (!sameFile || !containsPath(copy.root, alias) || (await realpath(alias)) !== alias)
      throw new BootstrapRequestConflict("Prepared copy source hard links escape their inventory");
    result.push([alias, stat]);
  }
  return result;
}

/** Return the reviewed buffer so parsers never reopen a substitutable pathname. */
export async function readBootstrapPreparedFile(
  file: CoordinatorBootstrapPlan["candidate"]["launcher"],
  writableMountRoots: readonly string[],
): Promise<Buffer> {
  await assertBootstrapPathsProtected([file.path], writableMountRoots);
  const bytes = await readProtectedDocument(file.path);
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new BootstrapRequestConflict("Prepared document digest changed");
  return bytes;
}

export async function readProtectedDocument(file: string): Promise<Buffer> {
  if ((await realpath(file)) !== file)
    throw new BootstrapRequestConflict("Prepared file requires a canonical path");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    requireOwned(before);
    if (!before.isFile() || before.nlink !== 1n || before.size > 1024n * 1024n)
      throw new BootstrapRequestConflict("Prepared document must be a bounded regular file");
    const bytes = await handle.readFile();
    requireUnchanged(before, await handle.stat({ bigint: true }));
    requireUnchanged(before, await lstat(file, { bigint: true }));
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Hash all runtime dependencies, not just the entrypoint. This does not establish
 * that the directory is outside Docker mounts; Host admission must verify that too. */
export interface BootstrapArtifactDigestLimits {
  signal?: AbortSignal;
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export async function digestBootstrapArtifact(
  directory: string,
  limits: BootstrapArtifactDigestLimits = {},
): Promise<string> {
  return (await inspectBootstrapArtifact(directory, limits)).sha256;
}

/** Retain every dependency and directory through later locked admission. The
 * collection budget ends on success; caller cancellation still invalidates proof. */
export async function inspectBootstrapArtifact(
  directory: string,
  limits: BootstrapArtifactDigestLimits = {},
) {
  const { signal, maxFiles = Infinity, maxBytes = Infinity, timeoutMs } = limits;
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  let files = 0;
  let bytes = 0;
  const checkBudget = () => {
    if (signal?.aborted) throw new BootstrapRequestConflict("Artifact verification cancelled");
    if (Date.now() >= deadline)
      throw new BootstrapRequestConflict("Artifact verification deadline exceeded");
    if (files > maxFiles || bytes > maxBytes)
      throw new BootstrapRequestConflict("Artifact verification limit exceeded");
  };
  checkBudget();
  const root = await realpath(directory);
  if (root !== directory)
    throw new BootstrapRequestConflict("Prepared artifact requires a canonical directory");
  const hash = createHash("sha256");
  hash.update("vorteo-coordinator-artifact-v1\n");
  const observed = new Map<string, BigIntStats>();

  const hardLinks = new Map<string, { count: bigint; paths: string[] }>();
  // Visits are sequential. Keep one scratch buffer per scan, never shared
  // across concurrent verifications or retained as a cache of file contents.
  const buffer = Buffer.alloc(64 * 1024);

  async function visit(relative: string): Promise<void> {
    files++;
    checkBudget();
    const file = path.join(root, relative);
    const before = await lstat(file, { bigint: true });
    requireOwned(before);
    observed.set(file, before);
    if (before.isDirectory()) {
      hash.update(JSON.stringify(["directory", relative, String(before.mode)]) + "\n");
      const entries = (await readdir(file)).sort();
      for (const entry of entries) await visit(path.join(relative, entry));
    } else if (before.isFile()) {
      bytes += Number(before.size);
      checkBudget();
      if (before.nlink > 1n) {
        const key = `${before.dev}:${before.ino}`;
        const group = hardLinks.get(key) ?? { count: before.nlink, paths: [] };
        if (group.count !== before.nlink)
          throw new BootstrapRequestConflict("Prepared hard-linked artifact changed");
        group.paths.push(relative);
        hardLinks.set(key, group);
      }
      const digest = await digestFile(file, before, {
        verifyLinksInTree: true,
        buffer,
        checkBudget,
      });
      hash.update(JSON.stringify(["file", relative, String(before.mode), digest]) + "\n");
    } else if (before.isSymbolicLink()) {
      const target = await readlink(file);
      const resolved = await realpath(file);
      if (resolved !== root && !resolved.startsWith(root + path.sep))
        throw new BootstrapRequestConflict("Prepared artifact links outside its release");
      hash.update(JSON.stringify(["link", relative, target]) + "\n");
    } else {
      throw new BootstrapRequestConflict("Prepared artifact contains a non-runtime file type");
    }
    requireUnchanged(before, await lstat(file, { bigint: true }));
  }

  if (!(await lstat(root)).isDirectory())
    throw new BootstrapRequestConflict("Prepared artifact must be a directory");
  await visit("");
  // npm links some executable packages within the release. Count every physical
  // name, without following symlinks, so an alias outside this tree is refused.
  for (const group of hardLinks.values()) {
    if (BigInt(group.paths.length) !== group.count)
      throw new BootstrapRequestConflict("Prepared hard-linked file escapes its release");
    hash.update(JSON.stringify(["hard-links", group.paths.sort()]) + "\n");
  }
  // A dependency visited earlier may change while another subtree is read.
  for (const [file, before] of observed) {
    checkBudget();
    requireUnchanged(before, await lstat(file, { bigint: true }));
  }
  checkBudget();
  const sha256 = hash.digest("hex");
  return {
    sha256,
    assertCurrent(): void {
      signal?.throwIfAborted();
      if (realpathSync(directory) !== directory)
        throw new BootstrapRequestConflict("Retained artifact requires its canonical directory");
      for (const [file, before] of observed)
        requireUnchanged(before, lstatSync(file, { bigint: true }));
      signal?.throwIfAborted();
    },
  };
}
