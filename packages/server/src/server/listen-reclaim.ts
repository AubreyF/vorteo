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
}

export interface ListenReclaimPorts {
  probe(host: string, port: number): Promise<"free" | "in-use">;
  listeners(port: number): Promise<ListenerProcess[]>;
  /** SIGTERM, then SIGKILL if it is still alive after the grace period. */
  terminate(pid: number): Promise<void>;
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
        await ports.terminate(holder.pid);
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
      try {
        const { stdout } = await execFileAsync("ps", ["-o", "uid=,command=", "-p", String(pid)], {
          timeout: 5000,
        });
        const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
        if (match) described.push({ pid, uid: Number(match[1]), command: match[2]!.trim() });
      } catch {
        // The process exited between lsof and ps.
      }
    }
    return described;
  },
  async terminate(pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    if (await waitForExit(pid, 5000)) return;
    // A frozen worker never runs its JavaScript SIGTERM handler.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
    await waitForExit(pid, 3000);
  },
  sleep: (ms) => delay(ms),
};
