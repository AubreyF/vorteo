import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
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

async function digestFile(file: string, expected: BigIntStats): Promise<string> {
  if (expected.nlink !== 1n)
    throw new BootstrapRequestConflict("Prepared artifact contains a hard-linked file");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
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

/** Hash all runtime dependencies, not just the entrypoint. This does not establish
 * that the directory is outside Docker mounts; Host admission must verify that too. */
export async function digestBootstrapArtifact(directory: string): Promise<string> {
  const root = await realpath(directory);
  if (root !== directory)
    throw new BootstrapRequestConflict("Prepared artifact requires a canonical directory");
  const hash = createHash("sha256");
  hash.update("vorteo-coordinator-artifact-v1\n");
  const observed = new Map<string, BigIntStats>();

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
      const digest = await digestFile(file, before);
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
  // A dependency visited earlier may change while another subtree is read.
  for (const [file, before] of observed)
    requireUnchanged(before, await lstat(file, { bigint: true }));
  return hash.digest("hex");
}
