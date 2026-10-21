import { execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Logger } from "pino";

const execFileAsync = promisify(execFile);
const RECLAIM_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 60_000;

export interface ListenerProcess {
  pid: number;
  uid: number;
  command: string;
  /** Process start time from ps lstart; with the pid it pins identity against PID reuse. */
  startedAt: string;
}

export type TerminateResult = "exited" | "identity_changed" | "still_running";

export interface ListenReclaimPorts {
  probe(host: string, port: number): Promise<"free" | "in-use">;
  listeners(port: number): Promise<ListenerProcess[]>;
  /** SIGTERM, then SIGKILL if it is still alive after the grace period. Each signal is
   * sent only after the process is re-verified as the one discovered. */
  terminate(holder: ListenerProcess): Promise<TerminateResult>;
  sleep(ms: number): Promise<void>;
}

/**
 * Releases are siblings under a ".../releases/" directory, so any release of this
 * installation shares that prefix. Unreleased checkouts use their own package root.
 */
export function installationRoot(workerScript: string): string {
  const marker = `${path.sep}releases${path.sep}`;
  const index = workerScript.indexOf(marker);
  if (index !== -1) return workerScript.slice(0, index + marker.length);
  const packageMarker = `${path.sep}packages${path.sep}server${path.sep}`;
  const packageIndex = workerScript.indexOf(packageMarker);
  return packageIndex === -1
    ? path.dirname(workerScript)
    : workerScript.slice(0, packageIndex + packageMarker.length);
}

/** Only a daemon worker of this installation, run by this user, is ever reclaimed. */
export function isPreviousWorker(
  listener: ListenerProcess,
  self: { pid: number; uid: number; workerScript: string },
): boolean {
  return (
    listener.pid !== self.pid &&
    listener.uid === self.uid &&
    /daemon-worker\.(?:js|ts)\b/.test(listener.command) &&
    listener.command.includes(installationRoot(self.workerScript))
  );
}

/**
 * Waits until the listen address is free. A previous worker of this installation
 * that still holds it is terminated; any other owner is reported and retried with
 * exponential backoff, so the supervisor is never restarted in a tight loop.
 */
export async function reclaimListenAddress(input: {
  host: string;
  port: number;
  self: { pid: number; uid: number; workerScript: string };
  logger: Pick<Logger, "info" | "warn" | "error">;
  ports: ListenReclaimPorts;
}): Promise<void> {
  const { host, port, self, logger, ports } = input;
  let backoff = 1000;
  let reclaims = 0;
  for (;;) {
    if ((await ports.probe(host, port)) === "free") return;
    const holders = await ports.listeners(port);
    const stale = holders.filter((holder) => isPreviousWorker(holder, self));
    if (stale.length && reclaims < RECLAIM_ATTEMPTS) {
      reclaims += 1;
      for (const holder of stale) {
        logger.warn(
          { port, stalePid: holder.pid, command: holder.command },
          "Listen address is held by a previous daemon worker of this installation; terminating it",
        );
        if ((await ports.terminate(holder)) === "identity_changed")
          logger.warn(
            { port, stalePid: holder.pid },
            "Listen address holder changed before it was signalled; leaving it alone",
          );
      }
      continue;
    }
    logger.error(
      {
        host,
        port,
        holders: holders.map(({ pid, command }) => ({ pid, command })),
        retryInMs: backoff,
      },
      stale.length
        ? "A previous daemon worker still holds the listen address after termination; retrying"
        : "Listen address is in use by another process; retrying",
    );
    await ports.sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function sameProcess(a: ListenerProcess, b: ListenerProcess): boolean {
  return (
    a.pid === b.pid && a.uid === b.uid && a.startedAt === b.startedAt && a.command === b.command
  );
}

export interface TerminateIo {
  describe(pid: number): Promise<ListenerProcess | null>;
  kill(pid: number, signal: NodeJS.Signals): void;
  waitForExit(pid: number, ms: number): Promise<boolean>;
}

/**
 * Signals only the exact process discovered: pid, uid, start time and argv are
 * re-read immediately before SIGTERM and again before SIGKILL, and any change
 * (including a reused pid) stops termination.
 */
export async function terminateVerified(
  expected: ListenerProcess,
  io: TerminateIo,
): Promise<TerminateResult> {
  const steps = [
    ["SIGTERM", 5000],
    // A frozen worker never runs its JavaScript SIGTERM handler.
    ["SIGKILL", 3000],
  ] as const;
  for (const [signal, graceMs] of steps) {
    const current = await io.describe(expected.pid);
    if (!current) return "exited";
    if (!sameProcess(current, expected)) return "identity_changed";
    try {
      io.kill(expected.pid, signal);
    } catch {
      return alive(expected.pid) ? "still_running" : "exited";
    }
    if (await io.waitForExit(expected.pid, graceMs)) return "exited";
  }
  return "still_running";
}

async function describeProcess(pid: number): Promise<ListenerProcess | null> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "uid=,lstart=,command=", "-p", String(pid)],
      {
        timeout: 5000,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      },
    );
    const match = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/s.exec(
      stdout.trim(),
    );
    return match
      ? { pid, uid: Number(match[1]), startedAt: match[2]!, command: match[3]!.trim() }
      : null;
  } catch {
    // ps exits non-zero when the process is gone.
    return null;
  }
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await delay(200);
  }
  return !alive(pid);
}

export const systemListenReclaimPorts: ListenReclaimPorts = {
  probe: (host, port) =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve("in-use");
        else reject(error);
      });
      server.listen(port, host, () => server.close(() => resolve("free")));
    }),
  async listeners(port) {
    let pids: number[];
    try {
      const { stdout } = await execFileAsync(
        "lsof",
        ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
        { timeout: 5000 },
      );
      pids = stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
    } catch {
      // lsof exits non-zero when nothing matches; an unknown owner is retried with backoff.
      return [];
    }
    const described: ListenerProcess[] = [];
    for (const pid of new Set(pids)) {
      // A process that exited between lsof and ps is skipped.
      const listener = await describeProcess(pid);
      if (listener) described.push(listener);
    }
    return described;
  },
  terminate: (holder) =>
    terminateVerified(holder, {
      describe: describeProcess,
      kill: (pid, signal) => process.kill(pid, signal),
      waitForExit,
    }),
  sleep: (ms) => delay(ms),
};
