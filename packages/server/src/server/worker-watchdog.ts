import { Worker } from "node:worker_threads";

/**
 * Runs on its own thread with its own event loop. A worker whose main thread is
 * blocked (a synchronous call that never returns, a native hang, or a hang inside
 * process.exit) still dies: timers, signal handlers and the IPC liveness guard on
 * the main thread cannot run in that state, but this thread can.
 * Plain CommonJS so it runs unchanged from source and from the built package.
 */
const WATCHDOG_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const { appendFileSync } = require("node:fs");
const deadline = new BigInt64Array(workerData.deadline);
let step = "running";
parentPort.on("message", (message) => {
  if (typeof message === "string") step = message;
});
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}
function shorten(next) {
  for (;;) {
    const current = Atomics.load(deadline, 0);
    if (current !== 0n && next >= current) return;
    if (Atomics.compareExchange(deadline, 0, current, next) === current) return;
  }
}
function record(reason, now) {
  try {
    appendFileSync(
      workerData.logPath,
      JSON.stringify({
        level: 50,
        time: now,
        pid: process.pid,
        module: "worker-watchdog",
        reason,
        step,
        msg: "Worker watchdog is killing a worker that did not exit in time",
      }) + "\n",
    );
  } catch {}
}
setInterval(() => {
  const now = Date.now();
  const supervisorLost =
    process.ppid !== workerData.supervisorPid || !alive(workerData.supervisorPid);
  if (supervisorLost) shorten(BigInt(now + workerData.supervisorLossGraceMs));
  const armed = Atomics.load(deadline, 0);
  if (armed !== 0n && BigInt(now) >= armed) {
    record(supervisorLost ? "supervisor_lost" : "shutdown_deadline_expired", now);
    process.kill(process.pid, "SIGKILL");
  }
}, workerData.pollMs);
`;

export interface WorkerWatchdog {
  /** Kill the process at this time unless it has exited. Only ever shortens. */
  armDeadline(at: number): void;
  /** Names the shutdown step in progress, recorded if the watchdog fires. */
  step(name: string): void;
}

export interface WorkerWatchdogOptions {
  supervisorPid: number;
  logPath: string;
  /** How long a worker may outlive its supervisor before it is killed. */
  supervisorLossGraceMs: number;
  pollMs?: number;
}

export function startWorkerWatchdog(options: WorkerWatchdogOptions): WorkerWatchdog {
  const shared = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
  const deadline = new BigInt64Array(shared);
  const thread = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    // Never inherit loader or module-type flags; the source is plain CommonJS.
    execArgv: [],
    workerData: {
      deadline: shared,
      supervisorPid: options.supervisorPid,
      logPath: options.logPath,
      supervisorLossGraceMs: options.supervisorLossGraceMs,
      pollMs: options.pollMs ?? 500,
    },
  });
  // The watchdog never keeps a healthy process alive on its own.
  thread.unref();
  return {
    armDeadline(at) {
      const next = BigInt(Math.floor(at));
      for (;;) {
        const current = Atomics.load(deadline, 0);
        if (current !== 0n && next >= current) return;
        if (Atomics.compareExchange(deadline, 0, current, next) === current) return;
      }
    },
    step(name) {
      // Node worker thread, not a browser window: there is no target origin.
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      thread.postMessage(name);
    },
  };
}
