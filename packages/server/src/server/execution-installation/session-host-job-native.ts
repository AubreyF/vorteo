import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectSessionHost, SessionHostClientError } from "../session-host/client.js";
import {
  preparePrivateDirectory,
  readSessionHostLock,
  readSessionHostToken,
  sessionHostPaths,
} from "../session-host/host-files.js";
import { readDurableSessionsSettings } from "../session-host/settings.js";
import {
  SESSION_HOST_STATUS_RELEASE,
  type SessionHostAnswer,
  type SessionHostPorts,
} from "./session-host-job.js";

const PRIVATE_FILE_MODE = 0o600;

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Writes beside the target, then renames over it, so launchd never reads a partial plist. */
async function writePrivateFileAtomic(file: string, data: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}`);
  try {
    await writeFile(temporary, data, { mode: PRIVATE_FILE_MODE, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Identity and session count; "refused" when the host closed the connection before greeting, as
 * it does at its connection limit or while closing; null when it does not answer. Never returns
 * tokens.
 */
async function queryHost(paseoHome: string): Promise<SessionHostAnswer | "refused" | null> {
  const paths = sessionHostPaths(paseoHome);
  try {
    const client = await connectSessionHost({
      socketPath: paths.socketPath,
      token: await readSessionHostToken(paths),
      release: SESSION_HOST_STATUS_RELEASE,
      connectTimeoutMs: 5_000,
    });
    try {
      const sessions = await client.list();
      return {
        pid: client.host.pid,
        ...(client.host.release ? { release: client.host.release } : {}),
        sessions: sessions.length,
      };
    } finally {
      client.close();
    }
  } catch (error) {
    return error instanceof SessionHostClientError && error.code === "disconnected"
      ? "refused"
      : null;
  }
}

function processCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "command=", "-p", String(pid)],
      { timeout: 5_000 },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    );
  });
}

/** The real effects, used only by the installed coordinator. Tests use their own ports. */
export function createNativeSessionHostPorts(): SessionHostPorts {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("The session host job requires macOS.");
  return {
    uid,
    launchAgentsDirectory: path.join(os.homedir(), "Library", "LaunchAgents"),
    readFile: readOptional,
    writePrivateFile: writePrivateFileAtomic,
    removeFile: (file) => rm(file, { force: true }),
    exists: (file) =>
      access(file).then(
        () => true,
        () => false,
      ),
    preparePrivateDirectory,
    queryHost,
    hostLock: (paseoHome) => readSessionHostLock(sessionHostPaths(paseoHome).socketPath),
    processCommand,
    kill: (pid, signal) => process.kill(pid, signal),
    settingEnabled: async (paseoHome) => readDurableSessionsSettings(paseoHome).enabled,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
