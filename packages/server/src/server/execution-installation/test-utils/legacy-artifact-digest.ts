// Frozen copy of the sequential artifact digest that shipped through vorteo.689.
// Equivalence tests compare the off-thread scan against these exact semantics.
import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import type { BootstrapArtifactDigestLimits } from "../coordinator-bootstrap-artifact.js";

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

/** Retain every dependency and directory through later locked admission. The
 * collection budget ends on success; caller cancellation still invalidates proof. */
export async function inspectLegacyBootstrapArtifact(
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
