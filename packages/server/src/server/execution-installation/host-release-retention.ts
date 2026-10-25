import { writeFileSync } from "node:fs";
import { readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { removeBootstrapRelease } from "./coordinator-bootstrap-release-seal.js";

/** Host source update jobs build into a folder named by their lifecycle job ID. */
const JOB_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Newest job folders kept beyond everything that is referenced. */
const KEEP_NEWEST = 3;

export interface HostReleaseRetention {
  /** The configured `sourceUpdates.releaseRoot`; only its direct job folders are pruned. */
  releaseRoot: string;
  /** Paths that must stay, such as the selected and previous releases and every
   * release a coordinator plan or unfinished job names. Paths outside the root are ignored. */
  referenced: readonly string[];
  keepNewest?: number;
  /** Removal of one release tree; defaults to removeReleaseTree. */
  removeRelease?: (directory: string) => Promise<void>;
  onError?: (directory: string, error: unknown) => void;
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")
  );
}

/**
 * Remove one release tree. Plain deletion first: releases are not sealed today, and
 * the seal-aware path walks the whole tree with chflags before deleting it, about half
 * a minute for a 150k-file release. Only a tree that refuses plain deletion, because
 * immutable flags remain, falls back to the seal-aware removal.
 */
export async function removeReleaseTree(
  directory: string,
  sealAware: (directory: string) => Promise<void> = removeBootstrapRelease,
): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await sealAware(directory);
  }
}

/** The job folder under the root that contains `target`, or null when it is elsewhere. */
async function jobFolder(root: string, target: string): Promise<string | null> {
  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch {
    return null; // Already gone; nothing to keep.
  }
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved.slice(root.length + 1).split(path.sep)[0] ?? null;
}

/**
 * Remove old Host release job folders after a verified install. Keeps every referenced
 * folder and the newest few; removes the rest, sealed or not. One failure is reported
 * and skipped. Returns the job folder names removed.
 */
export async function pruneHostReleases(input: HostReleaseRetention): Promise<string[]> {
  const root = await realpath(input.releaseRoot);
  const removeRelease = input.removeRelease ?? removeReleaseTree;
  const keep = new Set<string>();
  for (const target of input.referenced) {
    const folder = await jobFolder(root, target);
    if (folder) keep.add(folder);
  }
  const entries = await readdir(root, { withFileTypes: true });
  const folders: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    // Only job folders are candidates; anything else sharing the root is never touched.
    if (!entry.isDirectory() || !JOB_FOLDER.test(entry.name)) continue;
    folders.push({ name: entry.name, mtimeMs: (await stat(path.join(root, entry.name))).mtimeMs });
  }
  folders.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { name } of folders.slice(0, input.keepNewest ?? KEEP_NEWEST)) keep.add(name);
  const removed: string[] = [];
  for (const { name } of folders) {
    if (keep.has(name)) continue;
    const folder = path.join(root, name);
    try {
      // Release trees may carry immutable flags; removeReleaseTree falls back for those.
      for (const child of await readdir(folder, { withFileTypes: true }))
        if (child.isDirectory()) await removeRelease(path.join(folder, child.name));
      await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(name);
    } catch (error) {
      input.onError?.(folder, error);
    }
  }
  return removed;
}

let running: Promise<void> | null = null;

function writeRetentionReceipt(file: string, receipt: Record<string, unknown>): void {
  try {
    writeFileSync(file, JSON.stringify({ version: 1, ...receipt }) + "\n", { mode: 0o600 });
  } catch {
    // The receipt is diagnostic only; a missing one never affects an install.
  }
}

/**
 * Start one release cleanup after an install has already reported its result, so its
 * duration never counts against the install's readiness deadline. A cleanup that is
 * still running makes this a no-op. The outcome is written to `receiptFile`.
 * Returns whether a cleanup started.
 */
export function startHostReleaseRetention(
  prune: () => Promise<string>,
  receiptFile: string,
  now: () => Date = () => new Date(),
): boolean {
  if (running) {
    writeRetentionReceipt(receiptFile, {
      status: "skipped",
      reason: "An earlier cleanup is still running",
      at: now().toISOString(),
    });
    return false;
  }
  const startedAt = now().toISOString();
  writeRetentionReceipt(receiptFile, { status: "running", startedAt });
  running = (async () => {
    try {
      const note = (await prune()).trim();
      writeRetentionReceipt(receiptFile, {
        status: "finished",
        startedAt,
        finishedAt: now().toISOString(),
        note,
      });
    } catch (error) {
      writeRetentionReceipt(receiptFile, {
        status: "failed",
        startedAt,
        finishedAt: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })().finally(() => {
    running = null;
  });
  return true;
}

/** Resolves when no cleanup is running. */
export async function hostReleaseRetentionIdle(): Promise<void> {
  await running;
}
