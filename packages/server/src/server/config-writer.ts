import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory } from "./private-files.js";

export class ConfigWriterError extends Error {
  constructor(
    public readonly code: "busy" | "ownership_lost" | "stale_input" | "uncertain",
    public readonly writeAttempted: boolean,
    options?: ErrorOptions,
  ) {
    super(`Configuration writer ${code}; do not replay an uncertain write.`, options);
    this.name = "ConfigWriterError";
  }
}

export interface ConfigWriterOwnership {
  assertCurrent(): void;
}

/** Synchronous only. A crashed writer leaves a hold, never an automatically stolen lock. */
export function withConfigWriter<T>(
  home: string,
  operation: (ownership: ConfigWriterOwnership) => T,
): T {
  ensurePrivateDirectory(home);
  const lockPath = path.join(realpathSync(home), ".config-writer.lock");
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (cause) {
    throw new ConfigWriterError("busy", false, { cause });
  }
  const identity = fstatSync(fd);
  const nonce = randomUUID();
  let active = true;
  function assertCurrent(): void {
    if (!active) throw new ConfigWriterError("ownership_lost", false);
    try {
      const current = lstatSync(lockPath);
      const held = fstatSync(fd);
      if (
        !current.isFile() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        held.dev !== identity.dev ||
        held.ino !== identity.ino ||
        current.nlink !== 1 ||
        readFileSync(lockPath, "utf8") !== nonce
      ) {
        throw new Error("Configuration writer identity changed");
      }
    } catch (cause) {
      throw new ConfigWriterError("ownership_lost", false, { cause });
    }
  }
  const operationFailures: unknown[] = [];
  function release(): void {
    const failures: unknown[] = [];
    // Never remove a replacement owner's lock. Ownership loss leaves a reconciliation hold.
    try {
      assertCurrent();
      unlinkSync(lockPath);
    } catch (cause) {
      failures.push(cause);
    }
    active = false;
    try {
      closeSync(fd);
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length > 0) {
      throw new ConfigWriterError("ownership_lost", false, {
        cause: new AggregateError(
          [...operationFailures, ...failures],
          "Configuration writer release failed",
        ),
      });
    }
  }
  try {
    writeFileSync(fd, nonce, "utf8");
    const result = operation({ assertCurrent });
    if (result && typeof result === "object" && "then" in result) {
      throw new Error("Configuration writers must not await while holding ownership");
    }
    assertCurrent();
    return result;
  } catch (cause) {
    operationFailures.push(cause);
    throw cause;
  } finally {
    release();
  }
}
