import { Worker } from "node:worker_threads";
import { SELF_PROBE_RELEASE, SESSION_HOST_PROTOCOL_VERSION } from "./protocol.js";

/**
 * Runs on its own thread with its own event loop, so it still acts when the host's main thread
 * is blocked: a synchronous call that never returns, a native hang, or a hang inside exit. Timers
 * and signal handlers on the main thread cannot run in that state, but this thread can.
 *
 * Besides the heartbeat, it probes the host the way a worker reaches it: read the token file,
 * connect to the socket and complete a hello. A host that answers no hello cannot be reattached,
 * whatever the cause (a deleted socket file, a replaced token, exhausted connection slots or a
 * stalled main thread), so it is killed and launchd starts a working one. Workers keep
 * reattaching while the host process lives, so a session is never given up beside a live host.
 *
 * Plain CommonJS so it runs unchanged from source and from the built package.
 */
const WATCHDOG_SOURCE = String.raw`
const { workerData } = require("node:worker_threads");
const { appendFileSync, lstatSync, readFileSync } = require("node:fs");
const net = require("node:net");
const shared = new BigInt64Array(workerData.shared);
const HEARTBEAT = 0;
const DEADLINE = 1;
const LISTENING = 2;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
function record(reason, now, detail) {
  try {
    appendFileSync(
      workerData.logPath,
      JSON.stringify({
        level: 60,
        time: now,
        pid: process.pid,
        module: "session-host-watchdog",
        reason,
        ...detail,
        msg: "Session host watchdog is killing the host",
      }) + "\n",
      { mode: 0o600 },
    );
  } catch {}
}
function kill(reason, detail) {
  record(reason, Date.now(), detail);
  process.kill(process.pid, "SIGKILL");
}
setInterval(() => {
  const now = Date.now();
  const deadline = Atomics.load(shared, DEADLINE);
  if (deadline !== 0n && BigInt(now) >= deadline) {
    kill("shutdown_deadline", {});
    return;
  }
  const silentMs = now - Number(Atomics.load(shared, HEARTBEAT));
  if (silentMs > workerData.hangTimeoutMs) kill("hang", { silentMs });
}, workerData.pollMs);

/** Reads the token as a worker does, refusing a file another user could read or replace. */
function readToken(tokenPath) {
  const stats = lstatSync(tokenPath);
  if (!stats.isFile() || stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0)
    throw new Error("token file is not private");
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error("token file is malformed");
  return token;
}

/** Resolves when the host answers a hello; rejects with a short reason otherwise. */
function probeOnce(probe) {
  return new Promise((resolve, reject) => {
    let token;
    try {
      token = readToken(probe.tokenPath);
    } catch (error) {
      reject(new Error("token: " + (error && error.message)));
      return;
    }
    const socket = net.createConnection(probe.socketPath);
    let buffered = "";
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }
    const timer = setTimeout(() => finish(new Error("no hello reply in time")), probe.timeoutMs);
    socket.setEncoding("utf8");
    socket.on("error", (error) => finish(new Error("socket: " + (error.code || error.message))));
    socket.on("close", () => finish(new Error("closed before the hello reply")));
    socket.on("connect", () => {
      // The host's own pid and the probe label mark a self-probe, which the host does not audit.
      socket.write(
        JSON.stringify({
          type: "hello",
          protocolVersion: workerData.protocolVersion,
          token,
          client: { pid: process.pid, release: workerData.probeRelease },
        }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      let reply = null;
      try {
        reply = JSON.parse(buffered.slice(0, newline));
      } catch {}
      if (reply && reply.type === "hello") finish(null);
      else finish(new Error("hello refused: " + (reply && reply.code ? reply.code : "malformed")));
    });
  });
}

if (workerData.probe) {
  const probe = workerData.probe;
  let lastSuccessAt = 0;
  let failures = 0;
  let lastFailure = "";
  async function cycle() {
    // A host that is shutting down stops answering on purpose; the deadline guards it instead.
    if (Atomics.load(shared, DEADLINE) !== 0n) return;
    if (Atomics.load(shared, LISTENING) === 0n) {
      setTimeout(cycle, probe.intervalMs);
      return;
    }
    if (lastSuccessAt === 0) lastSuccessAt = Date.now();
    try {
      await probeOnce(probe);
      lastSuccessAt = Date.now();
      failures = 0;
    } catch (error) {
      failures += 1;
      lastFailure = String(error && error.message);
    }
    if (Atomics.load(shared, DEADLINE) !== 0n) return;
    const failingMs = Date.now() - lastSuccessAt;
    if (failures >= probe.minFailures && failingMs >= probe.failureWindowMs) {
      kill("probe", { failures, failingMs, lastFailure });
      return;
    }
    setTimeout(cycle, probe.intervalMs);
  }
  setTimeout(cycle, probe.intervalMs);
}
`;

export interface SessionHostProbeOptions {
  socketPath: string;
  tokenPath: string;
  intervalMs?: number;
  /** One probe fails when no hello reply arrives within this. */
  timeoutMs?: number;
  /** The host is killed once no probe has succeeded for this long... */
  failureWindowMs?: number;
  /** ...and at least this many probes in a row have failed. */
  minFailures?: number;
}

export interface SessionHostWatchdogOptions {
  /** Receives one JSON line before the watchdog kills the process. */
  logPath: string;
  /** The main thread may go this long without a heartbeat before it is killed. */
  hangTimeoutMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  /** Probes the hello exchange once markListening is called. */
  probe?: SessionHostProbeOptions;
  /** A failed watchdog thread leaves the host unguarded but running; report it. */
  onError?: (error: Error) => void;
}

export interface SessionHostWatchdog {
  /** Kills the process at this time unless it has exited first. Only ever moves earlier. */
  armDeadline(at: number): void;
  /** The host is listening, so probing starts. */
  markListening(): void;
  /** Ends the current watchdog thread the way a crash would. For tests: a new thread starts. */
  stopThreadForTest(): Promise<void>;
}

/** A replacement for a watchdog thread that ended starts after this, doubling while it keeps ending. */
const THREAD_RESTART_INITIAL_MS = 1_000;
const THREAD_RESTART_MAX_MS = 30_000;
/** A thread that ran at least this long before it ended resets the restart backoff. */
const THREAD_RESTART_RESET_MS = 60_000;

export const DEFAULT_HANG_TIMEOUT_MS = 30_000;

/**
 * Much longer than the hang timeout on purpose. Heavy load alone can delay a hello reply, but not
 * a heartbeat for 30 s, and a false kill ends every hosted turn at once. The faults only the probe
 * catches (a deleted socket, a replaced token, exhausted connection slots) can wait this long,
 * because workers keep reattaching while the host process lives.
 */
export const DEFAULT_PROBE_FAILURE_WINDOW_MS = 90_000;

/**
 * Starts the off-thread watchdog. The main thread stores a timestamp about every second; a
 * blocked main thread stops storing it, and the watchdog kills the process so launchd can start
 * a healthy host. Neither the thread nor the heartbeat keeps a finished process alive.
 */
export function startSessionHostWatchdog(options: SessionHostWatchdogOptions): SessionHostWatchdog {
  const hangTimeoutMs = options.hangTimeoutMs ?? DEFAULT_HANG_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatMs ?? 1_000;
  if (heartbeatMs >= hangTimeoutMs)
    throw new Error("The watchdog heartbeat must be shorter than its hang timeout.");
  const probe = options.probe && {
    socketPath: options.probe.socketPath,
    tokenPath: options.probe.tokenPath,
    intervalMs: options.probe.intervalMs ?? 5_000,
    timeoutMs: options.probe.timeoutMs ?? 4_000,
    failureWindowMs: options.probe.failureWindowMs ?? DEFAULT_PROBE_FAILURE_WINDOW_MS,
    minFailures: options.probe.minFailures ?? 3,
  };
  // Slots: last heartbeat, shutdown deadline, listening flag.
  const shared = new SharedArrayBuffer(3 * BigInt64Array.BYTES_PER_ELEMENT);
  const slots = new BigInt64Array(shared);
  const beat = (): void => {
    Atomics.store(slots, 0, BigInt(Date.now()));
  };
  beat();
  let thread: Worker | null = null;
  let restartDelayMs = THREAD_RESTART_INITIAL_MS;
  function startThread(): void {
    const startedAt = Date.now();
    const current = new Worker(WATCHDOG_SOURCE, {
      eval: true,
      // Never inherit loader or module-type flags such as tsx; the source is plain CommonJS.
      execArgv: [],
      workerData: {
        shared,
        logPath: options.logPath,
        hangTimeoutMs,
        pollMs: options.pollMs ?? 500,
        protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
        probeRelease: SELF_PROBE_RELEASE,
        probe,
      },
    });
    // An unhandled worker error event would crash the host and every session in it.
    current.on("error", (error) => options.onError?.(error));
    // Without its watchdog a host that later stalls is never replaced, and every worker waits out
    // its longest reattach window. So a thread that ends for any reason is replaced, backing off
    // while replacements keep ending. Killing the host here would be wrong: it is healthy now.
    current.on("exit", () => {
      if (thread !== current) return;
      if (Date.now() - startedAt >= THREAD_RESTART_RESET_MS)
        restartDelayMs = THREAD_RESTART_INITIAL_MS;
      options.onError?.(new Error("The session host watchdog thread ended; starting another."));
      setTimeout(startThread, restartDelayMs).unref();
      restartDelayMs = Math.min(restartDelayMs * 2, THREAD_RESTART_MAX_MS);
    });
    current.unref();
    thread = current;
  }
  startThread();
  setInterval(beat, heartbeatMs).unref();
  return {
    armDeadline(at) {
      const next = BigInt(Math.floor(at));
      for (;;) {
        const current = Atomics.load(slots, 1);
        if (current !== 0n && next >= current) return;
        if (Atomics.compareExchange(slots, 1, current, next) === current) return;
      }
    },
    markListening() {
      Atomics.store(slots, 2, 1n);
    },
    async stopThreadForTest() {
      await thread?.terminate();
    },
  };
}
