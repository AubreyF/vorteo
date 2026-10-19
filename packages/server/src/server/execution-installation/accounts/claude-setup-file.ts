import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ClaudeSetupDeliveryError } from "./claude-setup-delivery.js";

function checkDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)
  )
    throw new ClaudeSetupDeliveryError();
}

/** Dedicated owned state only. Never follows native credential-store links. */
export function readClaudeSetupFile(file: string): unknown | null {
  try {
    checkDirectory(dirname(file));
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 4 * 1024 * 1024 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)
      )
        throw new ClaudeSetupDeliveryError();
      return JSON.parse(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new ClaudeSetupDeliveryError();
  }
}

/** Sync both replacement and its directory before acknowledging a generation. */
export function writeClaudeSetupFile(file: string, value: unknown): void {
  const directory = dirname(file);
  let staged: string | null = null;
  try {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    checkDirectory(directory);
    readClaudeSetupFile(file);
    staged = join(directory, `.staged-${randomUUID()}`);
    const descriptor = openSync(staged, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(value));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(staged, file);
    staged = null;
    if (process.platform !== "win32") {
      const parent = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
  } catch {
    throw new ClaudeSetupDeliveryError();
  } finally {
    if (staged) {
      try {
        unlinkSync(staged);
      } catch {
        /* Preserve the original error. */
      }
    }
  }
}
