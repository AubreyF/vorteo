import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
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
  const files = [release.node, release.entrypoint, release.configuration, release.launcher];
  const observed = new Map<string, BigIntStats>();
  await assertBootstrapPathsProtected(
    [release.directory, ...files.map((file) => file.path)],
    writableMountRoots,
  );
  if (!containsPath(release.directory, release.entrypoint.path))
    throw new BootstrapRequestConflict("Coordinator entrypoint is outside its prepared release");
  for (const file of files) {
    if ((await realpath(file.path)) !== file.path)
      throw new BootstrapRequestConflict("Prepared file requires a canonical path");
    const stat = await lstat(file.path, { bigint: true });
    observed.set(file.path, stat);
    requireOwned(stat);
    if (!stat.isFile())
      throw new BootstrapRequestConflict("Prepared dependency must be a regular file");
    if ((await digestFile(file.path, stat)) !== file.sha256)
      throw new BootstrapRequestConflict("Prepared dependency digest changed");
    if (file === release.node && (stat.mode & 0o100n) === 0n)
      throw new BootstrapRequestConflict("Prepared Node executable is not executable");
  }
  const receiptPath = path.join(release.directory, ".installation-source.json");
  observed.set(receiptPath, await lstat(receiptPath, { bigint: true }));
  const receiptBytes = await readProtectedDocument(receiptPath);
  const receipt = z
    .object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(JSON.parse(receiptBytes.toString("utf8")));
  if (receipt.sourceCommit !== release.sourceCommit)
    throw new BootstrapRequestConflict("Prepared source does not match its installation receipt");
  if ((await digestBootstrapArtifact(release.directory)) !== release.artifactSha256)
    throw new BootstrapRequestConflict("Prepared release artifact changed");
  for (const [file, stat] of observed) requireUnchanged(stat, await lstat(file, { bigint: true }));
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

async function digestFile(
  file: string,
  expected: BigIntStats,
  verifyLinksInTree = false,
): Promise<string> {
  if (!verifyLinksInTree && expected.nlink !== 1n)
    throw new BootstrapRequestConflict("Prepared artifact contains a hard-linked file");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireUnchanged(expected, await handle.stat({ bigint: true }));
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    requireUnchanged(expected, await handle.stat({ bigint: true }));
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
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
export async function digestBootstrapArtifact(directory: string): Promise<string> {
  const root = await realpath(directory);
  if (root !== directory)
    throw new BootstrapRequestConflict("Prepared artifact requires a canonical directory");
  const hash = createHash("sha256");
  hash.update("vorteo-coordinator-artifact-v1\n");
  const observed = new Map<string, BigIntStats>();

  const hardLinks = new Map<string, { count: bigint; paths: string[] }>();

  async function visit(relative: string): Promise<void> {
    const file = path.join(root, relative);
    const before = await lstat(file, { bigint: true });
    requireOwned(before);
    observed.set(file, before);
    if (before.isDirectory()) {
      hash.update(JSON.stringify(["directory", relative, String(before.mode)]) + "\n");
      const entries = (await readdir(file)).sort();
      for (const entry of entries) await visit(path.join(relative, entry));
    } else if (before.isFile()) {
      if (before.nlink > 1n) {
        const key = `${before.dev}:${before.ino}`;
        const group = hardLinks.get(key) ?? { count: before.nlink, paths: [] };
        if (group.count !== before.nlink)
          throw new BootstrapRequestConflict("Prepared hard-linked artifact changed");
        group.paths.push(relative);
        hardLinks.set(key, group);
      }
      const digest = await digestFile(file, before, true);
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
  for (const [file, before] of observed)
    requireUnchanged(before, await lstat(file, { bigint: true }));
  return hash.digest("hex");
}
