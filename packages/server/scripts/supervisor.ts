import {
  createSupervisorWorkerLaunch,
  type SupervisorWorkerLaunchOptions,
  type SupervisorWorkerLaunchState,
} from "./supervisor-worker-launch.js";
import { fork, spawn, type ChildProcess, type StdioOptions } from "child_process";
import { fstatSync } from "node:fs";
import path from "node:path";
import {
  createStream as createRotatingFileStream,
  type RotatingFileStream,
} from "rotating-file-stream";
import { signalProcessTree } from "../src/utils/tree-kill.js";

const WORKER_HEARTBEAT_INTERVAL_MS = 1_000;
const WORKER_TERMINATION_GRACE_MS = 10_000;

interface SupervisorLogFileOptions {
  path: string;
  rotate: {
    maxSize: string;
    maxFiles: number;
  };
}

type WorkerLifecycleMessage =
  | {
      type: "paseo:shutdown";
      reason?: string;
    }
  | {
      type: "paseo:ready";
      listen: string;
      serverId: string;
    }
  | {
      type: "paseo:restart";
      reason?: string;
    }
  | {
      type: "paseo:maintenance-restart";
      requestId: string;
      generation: string;
      workerPid: number;
      terminateAt: number;
    };

interface SupervisorHeartbeatMessage {
  type: "paseo:supervisor-heartbeat";
  maintenanceRestartProtocol: 1;
}

interface SupervisorGracefulShutdownMessage {
  type: "paseo:graceful-shutdown";
  reason: string;
  terminateAt?: number;
}

interface SupervisorOptions {
  name: string;
  startupMessage: string;
  resolveWorkerEntry: () => string;
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  workerExecArgv?: string[];
  /** Startup-only lifetime ownership, shared with every trusted controller writer.
   * Native worker custody and settlement remain separate requirements.
   */
  controllerLifetimeFd?: number;
  /** Injection only. The installed entrypoint never supplies this option. */
  workerLaunch?: SupervisorWorkerLaunchOptions;
  resolveWorkerSpawnSpec?: (workerEntry: string) => {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  } | null;
  onWorkerReady?: (message: { listen: string; serverId: string }) => Promise<void> | void;
  onWorkerExit?: () => Promise<void> | void;
  restartOnCrash?: boolean;
  onSupervisorExit?: () => Promise<void> | void;
  logFile?: SupervisorLogFileOptions;
}

export interface SupervisorController {
  requestShutdown(reason: string): void;
  reopenWorkerLaunch?(): Promise<void>;
  workerLaunchState?(): SupervisorWorkerLaunchState;
}

export function parseControllerLifetimeFd(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const fd = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(fd) || fd < 3)
    throw new Error("Controller lifetime descriptor must be an integer at least 3.");
  const info = fstatSync(fd);
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    info.nlink !== 1
  )
    throw new Error("Controller lifetime descriptor requires an owner-controlled mode 0600 file.");
  return fd;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
}

function parseLifecycleMessage(msg: unknown): WorkerLifecycleMessage | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  const type = (msg as { type?: unknown }).type;
  if (type === "paseo:shutdown") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:shutdown",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  if (type === "paseo:ready") {
    const { listen, serverId } = msg as { listen?: unknown; serverId?: unknown };
    if (typeof listen !== "string" || listen.trim().length === 0) {
      return null;
    }
    if (typeof serverId !== "string" || serverId.trim().length === 0) {
      return null;
    }
    return { type: "paseo:ready", listen, serverId };
  }
  if (type === "paseo:maintenance-restart")
    return parseMaintenanceRestart(msg as Record<string, unknown>);
  if (type === "paseo:restart") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:restart",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  return null;
}

function parseMaintenanceRestart(
  msg: Record<string, unknown>,
): Extract<WorkerLifecycleMessage, { type: "paseo:maintenance-restart" }> | null {
  const input = msg;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    typeof input.requestId !== "string" ||
    !uuid.test(input.requestId) ||
    typeof input.generation !== "string" ||
    !uuid.test(input.generation) ||
    typeof input.workerPid !== "number" ||
    !Number.isSafeInteger(input.workerPid) ||
    input.workerPid <= 0 ||
    typeof input.terminateAt !== "number" ||
    !Number.isSafeInteger(input.terminateAt)
  )
    return null;
  return {
    type: "paseo:maintenance-restart",
    requestId: input.requestId,
    generation: input.generation,
    workerPid: input.workerPid,
    terminateAt: input.terminateAt,
  };
}

function toRotatingFileStreamSize(size: string): string {
  const trimmed = size.trim();
  const match = trimmed.match(/^(\d+)\s*([bBkKmMgG])?$/);
  if (!match) {
    return trimmed;
  }

  const value = match[1];
  const unit = (match[2] ?? "M").toUpperCase();
  return `${value}${unit}`;
}

// daemon.log is best effort: a full disk or a replaced log path must not take the
// supervisor, and with it the worker, down. A failed stream is dropped and a new one
// is opened on the next write, so logging resumes once the file is writable again.
function createDurableLog(
  options: SupervisorLogFileOptions | undefined,
  reportFailure: (message: string) => void,
) {
  let stream: RotatingFileStream | null = null;
  let failing = false;

  const open = (logFile: SupervisorLogFileOptions): RotatingFileStream => {
    const next = createRotatingFileStream(path.basename(logFile.path), {
      path: path.dirname(logFile.path),
      size: toRotatingFileStreamSize(logFile.rotate.maxSize),
      maxFiles: logFile.rotate.maxFiles,
    });
    next.on("error", (error) => {
      if (stream === next) {
        stream = null;
      }
      if (!failing) {
        failing = true;
        reportFailure(
          `Cannot write ${logFile.path}, will retry on the next log line: ${error.message}`,
        );
      }
    });
    return next;
  };

  return {
    write(chunk: string | Buffer): void {
      if (!options) {
        return;
      }
      stream ??= open(options);
      stream.write(chunk, (error) => {
        if (!error) {
          failing = false;
        }
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        if (!stream) {
          resolve();
          return;
        }
        stream.end(() => resolve());
      });
    },
  };
}

export function runSupervisor(options: SupervisorOptions): SupervisorController {
  const controllerLifetimeFd = parseControllerLifetimeFd(
    options.controllerLifetimeFd === undefined ? undefined : String(options.controllerLifetimeFd),
  );
  if (options.workerLaunch) return runInjectedWorkerSupervisor(options, controllerLifetimeFd);
  const restartOnCrash = options.restartOnCrash ?? false;
  const workerArgs = options.workerArgs ?? process.argv.slice(2);
  const workerEnv = options.workerEnv ?? process.env;
  const workerExecArgv = options.workerExecArgv ?? ["--import", "tsx"];
  const resolveWorkerSpawnSpec = options.resolveWorkerSpawnSpec;

  let child: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  let exiting = false;
  let lifecycleFailed = false;
  let publication = Promise.resolve();
  let forceKillTimer: NodeJS.Timeout | null = null;
  let maintenanceRestart: Extract<
    WorkerLifecycleMessage,
    { type: "paseo:maintenance-restart" }
  > | null = null;
  const durableLog = createDurableLog(options.logFile, (message) => {
    process.stderr.write(`[${options.name}] ${message}\n`);
  });

  const writeDurableChunk = (chunk: string | Buffer): void => {
    durableLog.write(chunk);
  };

  const writeLifecycleLog = (message: string, fields: Record<string, unknown> = {}): void => {
    writeDurableChunk(
      `${JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        pid: process.pid,
        name: options.name,
        msg: message,
        ...fields,
      })}\n`,
    );
  };

  const log = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
    writeLifecycleLog(message);
  };

  const closeLogStream = (): Promise<void> => durableLog.close();

  const exitSupervisor = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    Promise.resolve(options.onSupervisorExit?.())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`Supervisor exit cleanup failed: ${message}`);
      })
      .then(closeLogStream)
      .finally(() => {
        process.exit(code);
      });
  };

  const clearForceKillTimer = (): void => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const scheduleForceKill = (reason: string, terminateAt?: number): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    clearForceKillTimer();
    forceKillTimer = setTimeout(
      () => {
        forceKillTimer = null;
        if (child !== currentChild) {
          return;
        }
        writeLifecycleLog(
          "Worker did not exit after graceful shutdown request; forcing process tree kill",
          {
            reason,
            supervisorPid: process.pid,
            workerPid: currentChild.pid ?? null,
          },
        );
        void signalProcessTree(currentChild, "SIGKILL").catch((error) => {
          writeLifecycleLog("Failed to force-kill worker process tree", {
            error: error instanceof Error ? error.message : String(error),
            supervisorPid: process.pid,
            workerPid: currentChild.pid ?? null,
          });
        });
      },
      terminateAt === undefined
        ? WORKER_TERMINATION_GRACE_MS
        : Math.max(0, terminateAt - Date.now()),
    );
    // Keep the supervisor alive until this fires or the worker exits (which clears it).
    // An unreferenced timer let a drained supervisor exit first and orphan the worker.
  };

  const spawnWorker = () => {
    let workerEntry: string;
    try {
      // Resolve at spawn time so restarts pick up current filesystem state.
      workerEntry = options.resolveWorkerEntry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Failed to resolve worker entry: ${message}`);
      exitSupervisor(1);
      return;
    }

    const spawnSpec = resolveWorkerSpawnSpec?.(workerEntry) ?? null;
    const stdio: StdioOptions = ["inherit", "pipe", "pipe", "ipc"];
    const environment = { ...(spawnSpec?.env ?? workerEnv) };
    // Both trusted processes retain the same open-file description until exit.
    // Never unlock it here; ordinary descendants do not inherit extra stdio.
    if (controllerLifetimeFd !== undefined) {
      stdio.push(controllerLifetimeFd);
      environment.PASEO_CONTROLLER_LIFETIME_FD = "4";
    } else {
      delete environment.PASEO_CONTROLLER_LIFETIME_FD;
    }
    writeLifecycleLog("Spawning worker", { workerEntry });
    if (spawnSpec) {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio,
        env: environment,
      });
    } else {
      child = fork(workerEntry, workerArgs, {
        stdio,
        env: environment,
        execArgv: workerExecArgv,
      });
    }

    const currentChild = child;
    maintenanceRestart = null;
    let workerStreamsClosed = false;
    const closed = new Promise<void>((resolve) => {
      currentChild.once("close", () => {
        workerStreamsClosed = true;
        resolve();
      });
    });
    const verifyMaintenanceStreamClosure = async (): Promise<void> => {
      const retained = maintenanceRestart;
      if (!retained || workerStreamsClosed) return;
      let timer: ReturnType<typeof setTimeout>;
      try {
        const expired = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("Maintenance worker streams did not close before the retained deadline"),
              ),
            Math.max(0, retained.terminateAt - Date.now()),
          );
        });
        // Exit alone does not close pipes inherited by provider descendants.
        // Failure stays uncertainty; never start a replacement behind them.
        // Closed streams are only a necessary check, not full native exit proof.
        await Promise.race([closed, expired]);
      } finally {
        clearTimeout(timer!);
      }
    };
    let reachedReady = false;
    // Serialize endpoint writes with exit/clear before allowing another worker to spawn.
    const heartbeat = setInterval(() => {
      const message: SupervisorHeartbeatMessage = {
        type: "paseo:supervisor-heartbeat",
        maintenanceRestartProtocol: 1,
      };
      if (currentChild.connected) {
        currentChild.send?.(message, (error) => {
          if (error) {
            writeLifecycleLog("Worker heartbeat IPC send failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } else {
        writeLifecycleLog("Worker heartbeat skipped because IPC channel is disconnected");
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    child.on("disconnect", () => {
      writeLifecycleLog("Worker IPC channel disconnected");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      writeDurableChunk(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      writeDurableChunk(chunk);
    });

    child.on("message", (msg: unknown) => {
      const lifecycleMessage = parseLifecycleMessage(msg);
      if (!lifecycleMessage || child !== currentChild) {
        return;
      }

      if (lifecycleMessage.type === "paseo:ready") {
        reachedReady = true;
        writeLifecycleLog("Worker ready", { listen: lifecycleMessage.listen });
        publication = publication
          .then(() =>
            options.onWorkerReady?.({
              listen: lifecycleMessage.listen,
              serverId: lifecycleMessage.serverId,
            }),
          )
          .catch((error) => {
            lifecycleFailed = true;
            const message = error instanceof Error ? error.message : String(error);
            log(`Worker ready callback failed: ${message}`);
            requestShutdown("endpoint_publication_failed");
          });
        return;
      }

      if (lifecycleMessage.type === "paseo:shutdown") {
        const reason = lifecycleMessage.reason ?? "worker_requested_shutdown";
        writeLifecycleLog("Worker requested shutdown", { reason });
        requestShutdown(reason);
        return;
      }

      if (lifecycleMessage.type === "paseo:maintenance-restart") {
        requestMaintenanceRestart(currentChild, lifecycleMessage);
        return;
      }

      const reason = lifecycleMessage.reason ?? "worker_requested_restart";
      writeLifecycleLog("Worker requested restart", { reason });
      requestRestart(reason);
    });

    child.on("error", (error) => {
      lifecycleFailed = true;
      log(`Worker spawn failed: ${error.message}`);
      exitSupervisor(1);
    });

    child.on("exit", (code, signal) => {
      clearInterval(heartbeat);
      clearForceKillTimer();
      child = null;
      publication = publication
        .then(() => options.onWorkerExit?.())
        .then(verifyMaintenanceStreamClosure)
        .catch((error) => {
          lifecycleFailed = true;
          log(`Worker exit verification failed: ${String(error)}`);
        });
      void publication.then(() => {
        const exitDescriptor = describeExit(code, signal);
        writeLifecycleLog("Worker exited", { code, signal, exit: exitDescriptor });

        if (lifecycleFailed || (!reachedReady && !shuttingDown)) {
          log(`Worker exited before successful readiness (${exitDescriptor}). Supervisor exiting.`);
          exitSupervisor(1);
          return;
        }

        if (shuttingDown) {
          log(`Worker exited (${exitDescriptor}). Supervisor shutting down.`);
          exitSupervisor(0);
          return;
        }

        const crashed =
          restartOnCrash &&
          ((code !== 0 && code !== null) || (signal !== null && signal !== "SIGTERM"));

        if (restarting || crashed) {
          restarting = false;
          log(
            crashed
              ? `Worker crashed (${exitDescriptor}). Restarting worker...`
              : `Worker exited (${exitDescriptor}). Restarting worker...`,
          );
          spawnWorker();
          return;
        }

        log(`Worker exited (${exitDescriptor}). Supervisor exiting.`);
        exitSupervisor(typeof code === "number" ? code : 1);
        return;
      });
    });
  };

  const requestWorkerShutdown = (reason: string, terminateAt?: number): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    const message: SupervisorGracefulShutdownMessage = {
      type: "paseo:graceful-shutdown",
      reason,
      ...(terminateAt === undefined ? {} : { terminateAt }),
    };
    writeLifecycleLog("Supervisor requesting graceful worker shutdown", {
      reason,
      supervisorPid: process.pid,
      workerPid: currentChild.pid ?? null,
    });
    if (!currentChild.connected) {
      writeLifecycleLog("Graceful worker shutdown IPC unavailable", {
        reason,
        supervisorPid: process.pid,
        workerPid: currentChild.pid ?? null,
      });
      return;
    }
    currentChild.send?.(message, (error) => {
      if (error) {
        writeLifecycleLog("Graceful worker shutdown IPC send failed", {
          error: error instanceof Error ? error.message : String(error),
          reason,
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        });
      }
    });
  };

  const requestMaintenanceRestart = (
    sender: ChildProcess,
    intent: Extract<WorkerLifecycleMessage, { type: "paseo:maintenance-restart" }>,
  ): void => {
    const duplicate =
      maintenanceRestart !== null && JSON.stringify(maintenanceRestart) === JSON.stringify(intent);
    const remaining = intent.terminateAt - Date.now();
    const accepted =
      child === sender &&
      sender.pid === intent.workerPid &&
      (duplicate || (!shuttingDown && !restarting && remaining > 0 && remaining <= 300_000));
    if (accepted && !duplicate) {
      // The coordinator's durable generation reservation precedes this IPC.
      // A lost acceptance is uncertainty, never permission to send another effect.
      maintenanceRestart = intent;
      restarting = true;
      writeLifecycleLog("Maintenance restart accepted", { ...intent, supervisorPid: process.pid });
    }
    if (sender.connected)
      sender.send?.(
        {
          type: "paseo:maintenance-restart-accepted",
          accepted,
          requestId: intent.requestId,
          generation: intent.generation,
          workerPid: intent.workerPid,
          terminateAt: intent.terminateAt,
        },
        (error) => {
          if (error)
            writeLifecycleLog("Maintenance restart acceptance delivery failed", {
              error: String(error),
            });
        },
      );
    if (!accepted || duplicate) return;
    requestWorkerShutdown("approved_maintenance_interruption", intent.terminateAt);
    scheduleForceKill("approved_maintenance_interruption", intent.terminateAt);
  };

  const requestRestart = (reason: string) => {
    if (!child || restarting || shuttingDown) {
      return;
    }
    restarting = true;
    writeLifecycleLog("Restart requested", { reason });
    log(`${reason}. Stopping worker for restart...`);
    requestWorkerShutdown(reason);
    scheduleForceKill(reason);
  };

  const requestShutdown = (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    restarting = false;
    writeLifecycleLog("Supervisor shutdown requested", { reason });
    log(`${reason}. Stopping worker...`);
    if (!child) {
      void publication.then(() => {
        exitSupervisor(lifecycleFailed ? 1 : 0);
        return;
      });
      return;
    }
    // A later stop request may not extend a maintenance termination budget.
    requestWorkerShutdown(reason, maintenanceRestart?.terminateAt);
    scheduleForceKill(reason, maintenanceRestart?.terminateAt);
  };

  const forwardSignal = (signal: NodeJS.Signals) => {
    requestShutdown(`supervisor_received_${signal}`);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  process.stdout.write(`[${options.name}] ${options.startupMessage}\n`);
  writeLifecycleLog(options.startupMessage);
  spawnWorker();

  return { requestShutdown };
}

function runInjectedWorkerSupervisor(
  options: SupervisorOptions,
  controllerLifetimeFd: number | undefined,
): SupervisorController {
  const launch = options.workerLaunch;
  if (!launch || launch.supervisor.pid !== process.pid)
    throw new Error("Injected custody must bind the actual NodeSupervisor PID");
  const durableLog = createDurableLog(options.logFile, (message) =>
    process.stderr.write(`[${options.name}] ${message}\n`),
  );
  const report = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
    durableLog.write(
      `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, name: options.name, msg: message })}\n`,
    );
  };
  let heartbeat: NodeJS.Timeout | null = null;
  const onInterrupt = (): void => adapter.shutdown("supervisor_received_SIGINT");
  const onTerminate = (): void => adapter.shutdown("supervisor_received_SIGTERM");
  const adapter = createSupervisorWorkerLaunch(launch, {
    controllerLifetimeFd,
    restartOnCrash: options.restartOnCrash ?? false,
    onReady: (message) => options.onWorkerReady?.(message),
    onWorkerExit: () => options.onWorkerExit?.(),
    report,
    onExit: async (code) => {
      if (heartbeat) clearInterval(heartbeat);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      try {
        await options.onSupervisorExit?.();
      } finally {
        await durableLog.close();
      }
      process.exit(code);
    },
  });
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.stdout.write(`[${options.name}] ${options.startupMessage}\n`);
  // Reuse the supervisor heartbeat cadence for read-only reconciliation. Only
  // exact native settlement can cause a fresh request through the lifecycle owner.
  heartbeat = setInterval(() => {
    adapter.heartbeat();
    void adapter.reopen().catch((error) => report(String(error)));
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  void adapter.reopen().catch((error) => report(String(error)));
  return {
    requestShutdown: adapter.shutdown,
    reopenWorkerLaunch: adapter.reopen,
    workerLaunchState: adapter.snapshot,
  };
}
