import {
  type Stats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeOAuthDeliveryError, type ClaudeAccessProjection } from "./claude-oauth-delivery.js";

/**
 * Claude Code 2.1.284 (Linux) keeps OAuth only in `<CLAUDE_CONFIG_DIR>/.credentials.json`, checks
 * the file's mtime before every model request, and guards every read-modify-write of it with a
 * proper-lockfile mkdir lock at `.storage-write.lock` that it treats as stale after 15 seconds.
 * Taking the same lock keeps a concurrent CLI save (for example MCP OAuth) from overwriting a
 * projection. These names come from static analysis of the pinned CLI; recheck them on upgrade.
 */
const CREDENTIALS_FILE = ".credentials.json";
const STORAGE_LOCK = ".storage-write.lock";
const LOCK_STALE_MS = 15_000;
const MAX_CREDENTIALS_BYTES = 1024 * 1024;

interface LockOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

/**
 * A credentials file the coordinator or Dev may trust: a regular file of bounded size, owned by
 * this user and not writable by anyone else. The CLI itself writes it with mode 0600.
 */
export function isTrustedCredentialsFile(stat: Stats): boolean {
  return (
    stat.isFile() &&
    stat.size <= MAX_CREDENTIALS_BYTES &&
    (!process.getuid || stat.uid === process.getuid()) &&
    (process.platform === "win32" || (stat.mode & 0o022) === 0)
  );
}

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

async function acquireStorageLock(home: string, options: LockOptions): Promise<() => void> {
  const lock = join(home, STORAGE_LOCK);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const attempts = options.attempts ?? 20;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      return () => {
        try {
          rmdirSync(lock);
        } catch {
          /* A stale-lock takeover by the CLI already removed it. */
        }
      };
    } catch (error) {
      if (code(error) !== "EEXIST") throw new ClaudeOAuthDeliveryError();
    }
    try {
      const held = lstatSync(lock);
      if (!held.isDirectory()) throw new ClaudeOAuthDeliveryError();
      if (now() - held.mtimeMs > LOCK_STALE_MS) {
        rmdirSync(lock);
        continue;
      }
    } catch (error) {
      if (code(error) === "ENOENT") continue;
      throw new ClaudeOAuthDeliveryError();
    }
    await sleep(Math.min(1000, 100 * 2 ** attempt));
  }
  throw new ClaudeOAuthDeliveryError();
}

/** Existing top-level keys survive. A symbolic link or oversized file is refused. */
function readCredentials(file: string): Record<string, unknown> {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (code(error) === "ENOENT") return {};
    throw new ClaudeOAuthDeliveryError();
  }
  try {
    if (!isTrustedCredentialsFile(fstatSync(descriptor))) throw new ClaudeOAuthDeliveryError();
    try {
      const parsed: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      // The CLI treats unreadable storage as empty and replaces it on its next save.
      return {};
    }
  } finally {
    closeSync(descriptor);
  }
}

function replaceAtomically(home: string, file: string, contents: string): void {
  const staged = join(home, `.credentials.json.vorteo-${randomUUID()}`);
  let pending = true;
  try {
    const descriptor = openSync(staged, "wx", 0o600);
    try {
      writeFileSync(descriptor, contents);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(staged, file);
    pending = false;
    if (process.platform !== "win32") {
      const parent = openSync(home, constants.O_RDONLY);
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
  } catch {
    throw new ClaudeOAuthDeliveryError();
  } finally {
    if (pending) {
      try {
        unlinkSync(staged);
      } catch {
        /* Preserve the original error. */
      }
    }
  }
}

/**
 * Write an access-only projection into the account's CLI storage, or remove it for a withdrawal.
 * The caller has already verified that `home` is the binding's owned account directory.
 */
export async function writeClaudeAccessProjection(
  home: string,
  access: ClaudeAccessProjection | null,
  options: LockOptions = {},
): Promise<void> {
  const release = await acquireStorageLock(home, options);
  try {
    const file = join(home, CREDENTIALS_FILE);
    const next = { ...readCredentials(file) };
    if (access) {
      // Never a refresh token, not even a placeholder: the CLI would try it, get invalid_grant
      // and overwrite this projection with its dead-token marker.
      next.claudeAiOauth = {
        accessToken: access.accessToken,
        expiresAt: access.expiresAt,
        scopes: access.scopes,
        ...(access.subscriptionType ? { subscriptionType: access.subscriptionType } : {}),
        ...(access.rateLimitTier ? { rateLimitTier: access.rateLimitTier } : {}),
      };
    } else {
      delete next.claudeAiOauth;
    }
    replaceAtomically(home, file, JSON.stringify(next));
  } finally {
    release();
  }
}
