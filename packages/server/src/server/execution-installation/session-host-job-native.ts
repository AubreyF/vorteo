import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  connectSessionHost,
  SessionHostClientError,
  type SessionHostClient,
} from "../session-host/client.js";
import {
  preparePrivateDirectory,
  readSessionHostLock,
  readSessionHostToken,
  sessionHostPaths,
} from "../session-host/host-files.js";
import { readDurableSessionsSettings } from "../session-host/settings.js";
import {
  defaultLaunchAgentsDirectory,
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

/** How long a status query waits for the session list once the host has greeted. */
const LIST_TIMEOUT_MS = 5_000;

/**
 * What a failed status query says about the host. Only a missing listener or a greeting that never
 * arrives shows silence. Any other client error, such as a closed connection at the host's limit
 * or a protocol version a newer host speaks, came from a live host.
 */
export function classifyQueryFailure(error: unknown): "refused" | null {
  return error instanceof SessionHostClientError &&
    error.code !== "unavailable" &&
    error.code !== "timeout"
    ? "refused"
    : null;
}

/**
 * Identity and session count; "refused" when a live host would not answer, see
 * classifyQueryFailure; null when it shows no sign of life. Never returns tokens.
 */
async function queryHost(
  paseoHome: string,
  listTimeoutMs: number,
): Promise<SessionHostAnswer | "refused" | null> {
  const paths = sessionHostPaths(paseoHome);
  let client: SessionHostClient;
  try {
    client = await connectSessionHost({
      socketPath: paths.socketPath,
      token: await readSessionHostToken(paths),
      release: SESSION_HOST_STATUS_RELEASE,
      connectTimeoutMs: 5_000,
    });
  } catch (error) {
    return classifyQueryFailure(error);
  }
  // A host that greeted is alive, so anything after that, even a list that never comes, is a
  // refusal rather than silence.
  let timer: NodeJS.Timeout | undefined;
  try {
    const sessions = await Promise.race([
      client.list(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("list timed out")), listTimeoutMs);
      }),
    ]);
    return {
      pid: client.host.pid,
      ...(client.host.release ? { release: client.host.release } : {}),
      sessions: sessions.length,
    };
  } catch {
    return "refused";
  } finally {
    clearTimeout(timer);
    client.close();
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
export function createNativeSessionHostPorts(
  options: { listTimeoutMs?: number } = {},
): SessionHostPorts {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("The session host job requires macOS.");
  return {
    uid,
    launchAgentsDirectory: defaultLaunchAgentsDirectory(),
    readFile: readOptional,
    writePrivateFile: writePrivateFileAtomic,
    removeFile: (file) => rm(file, { force: true }),
    exists: (file) =>
      access(file).then(
        () => true,
        () => false,
      ),
    preparePrivateDirectory,
    queryHost: (paseoHome) => queryHost(paseoHome, options.listTimeoutMs ?? LIST_TIMEOUT_MS),
    hostLock: (paseoHome) => readSessionHostLock(sessionHostPaths(paseoHome).socketPath),
    processCommand,
    kill: (pid, signal) => process.kill(pid, signal),
    settingEnabled: async (paseoHome) => readDurableSessionsSettings(paseoHome).enabled,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
