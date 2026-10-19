import { initializePackagedClaudeCli } from "./agent/providers/claude/packaged-cli.js";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { resolveManagedInstallationClient } from "./execution-installation/managed-client.js";
import { createPaseoDaemon, formatListenTarget, parseListenString } from "./bootstrap.js";
import { reclaimListenAddress, systemListenReclaimPorts } from "./listen-reclaim.js";
import { loadConfig } from "./config.js";
import { resolvePaseoHome } from "./paseo-home.js";
import { createRootLogger } from "./logger.js";
import type { DaemonLifecycleIntent } from "./bootstrap.js";
import { getProcessDiagnostics } from "./process-diagnostics.js";
import { loadGovernedScheduleRuntimeFactory } from "./schedule/governed-runtime.js";
import { createWorkerShutdown } from "./worker-shutdown.js";
import { startWorkerWatchdog, type WorkerWatchdog } from "./worker-watchdog.js";

/** Graceful shutdown budget, then this much more before the watchdog kills the worker. */
const DEFAULT_SHUTDOWN_BUDGET_MS = 10_000;
const HARD_EXIT_MARGIN_MS = 5_000;
/** A worker whose supervisor is gone is killed within this, even with a blocked event loop. */
const SUPERVISOR_LOSS_GRACE_MS = 15_000;
import { createMaintenanceRestartChannel } from "./maintenance-restart-channel.js";

// Managed updates and Host renewal verify the entrypoint through OS arguments.
// Changing the title overwrites that evidence on macOS.
const managedWorker = process.env.PASEO_MANAGED_WORKER === "1";
delete process.env.PASEO_MANAGED_WORKER;
initializePackagedClaudeCli(managedWorker);
if (
  !managedWorker &&
  !process.env.VORTEO_INSTALLATION_CLIENT_CONFIG &&
  !process.env.VORTEO_COORDINATOR_BOOTSTRAP_SETUP
)
  process.title = "Paseo Daemon";

type SupervisorLifecycleMessage =
  | {
      type: "paseo:shutdown";
      reason: string;
    }
  | {
      type: "paseo:ready";
      listen: string;
      serverId: string;
    }
  | {
      type: "paseo:restart";
      reason?: string;
    };

interface BootstrapResult {
  paseoHome: string;
  logger: ReturnType<typeof createRootLogger>;
  config: ReturnType<typeof loadConfig>;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function writeWorkerLifecycleLog(
  paseoHome: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    const logPath = path.join(paseoHome, "daemon.log");
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify({
        level: "warn",
        time: new Date().toISOString(),
        pid: process.pid,
        name: "DaemonWorker",
        msg: message,
        ...fields,
      })}\n`,
      "utf8",
    );
  } catch {
    // Exit-reason logging must never prevent the worker from exiting.
  }
}

function bootstrapFromEnvironment(): BootstrapResult {
  try {
    const paseoHome = resolvePaseoHome();
    const config = loadConfig(paseoHome);
    const installationClient = resolveManagedInstallationClient({
      configuredPath: process.env.VORTEO_INSTALLATION_CLIENT_CONFIG,
      managedWorker,
      environment: config.sharedProviderPreferences?.installation?.environment,
      platform: process.platform,
      homeDir: homedir(),
      uid: process.getuid?.(),
    });
    if (installationClient) process.env.VORTEO_INSTALLATION_CLIENT_CONFIG = installationClient;
    const logger = createRootLogger({ log: config.log }, { paseoHome, file: false });
    return { paseoHome, logger, config };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function applyCliFlagOverrides(config: ReturnType<typeof loadConfig>): void {
  const configReload = config.configReload;
  if (!configReload) throw new Error("Loaded daemon config is missing reload metadata");
  const cli = (configReload.cli ??= {});
  const override = (configPath: string) => {
    if (!configReload.overrideControlledPaths.includes(configPath)) {
      configReload.overrideControlledPaths.push(configPath);
    }
  };
  if (process.argv.includes("--relay")) {
    config.relayEnabled = true;
    config.relayEnabledMutable = false;
    cli.relayEnabled = true;
    override("daemon.relay.enabled");
  }
  if (process.argv.includes("--no-relay")) {
    config.relayEnabled = false;
    config.relayEnabledMutable = false;
    cli.relayEnabled = false;
    override("daemon.relay.enabled");
  }
  if (process.argv.includes("--relay-use-tls")) {
    config.relayUseTls = true;
    cli.relayUseTls = true;
    override("daemon.relay.useTls");
  }
  if (process.argv.includes("--no-mcp")) {
    config.mcpEnabled = false;
    cli.mcpEnabled = false;
    override("daemon.mcp.enabled");
  }
  if (process.argv.includes("--no-inject-mcp")) {
    config.mcpInjectIntoAgents = false;
    cli.mcpInjectIntoAgents = false;
    override("daemon.mcp.injectIntoAgents");
  }
  if (process.argv.includes("--web-ui")) {
    config.webUi = { ...(config.webUi ?? { distDir: null }), enabled: true };
    cli.webUiEnabled = true;
    override("features.webUi.enabled");
  }
  if (process.argv.includes("--no-web-ui")) {
    config.webUi = { ...(config.webUi ?? { distDir: null }), enabled: false };
    cli.webUiEnabled = false;
    override("features.webUi.enabled");
  }
}

async function main() {
  const { paseoHome, logger, config } = bootstrapFromEnvironment();
  let daemon: Awaited<ReturnType<typeof createPaseoDaemon>> | null = null;
  let shutdownPromise: Promise<number> | null = null;
  let exitHookInstalled = false;

  applyCliFlagOverrides(config);
  // Only a supervised worker has a supervisor to outlive.
  const watchdog: WorkerWatchdog | null =
    typeof process.send === "function"
      ? startWorkerWatchdog({
          supervisorPid: process.ppid,
          logPath: path.join(paseoHome, "daemon.log"),
          supervisorLossGraceMs: SUPERVISOR_LOSS_GRACE_MS,
        })
      : null;
  const armHardExit = (at: number) => watchdog?.armDeadline(at);

  const maintenanceRestart = createMaintenanceRestartChannel({
    workerPid: process.pid,
    parentPid: process.ppid,
    currentParentPid: () => process.ppid,
    connected: () => process.connected === true,
    now: Date.now,
    send: (message) => {
      if (typeof process.send !== "function") throw new Error("Supervisor IPC is unavailable");
      process.send(message);
    },
  });

  const workerShutdown = createWorkerShutdown({
    now: Date.now,
    stop: async () => {
      if (!daemon) throw new Error("Shutdown requested before daemon initialization completed");
      await daemon.stop({
        onStep: (step) => {
          watchdog?.step(step);
          logger.info({ step }, "Worker shutdown step");
        },
      });
    },
    forceExit: () => {
      logger.warn(
        getProcessDiagnostics(),
        "Worker shutdown deadline expired; cleanup is incomplete",
      );
      // process.exit can itself hang in native teardown; the watchdog is the backstop.
      armHardExit(Date.now() + HARD_EXIT_MARGIN_MS);
      process.exit(1);
    },
  });

  const installExitHook = () => {
    if (exitHookInstalled || !shutdownPromise) {
      return;
    }
    exitHookInstalled = true;
    void shutdownPromise.then((exitCode) => {
      armHardExit(Date.now() + HARD_EXIT_MARGIN_MS);
      process.exit(exitCode);
    });
  };

  const beginShutdown = (
    signal: string,
    options?: {
      reason?: string;
      successExitCode?: number;
      terminateAt?: number;
    },
  ) => {
    const reason = options?.reason ?? `worker_received_${signal}`;
    // Whatever holds, captures or turns remain, the process ends shortly after its budget.
    armHardExit(
      (options?.terminateAt ?? Date.now() + DEFAULT_SHUTDOWN_BUDGET_MS) + HARD_EXIT_MARGIN_MS,
    );
    if (!shutdownPromise) {
      logger.info(
        { signal, reason, ...getProcessDiagnostics() },
        `${signal} received, shutting down gracefully...`,
      );

      shutdownPromise = (async () => {
        try {
          await workerShutdown.begin(options?.terminateAt);
          logger.info("Server closed");
          return options?.successExitCode ?? 0;
        } catch (err) {
          logger.error({ err }, "Shutdown failed");
          return 1;
        }
      })();
    } else {
      // Duplicate shutdown requests may shorten the budget, never extend it.
      void workerShutdown.begin(options?.terminateAt).catch((err: unknown) => {
        logger.error({ err }, "Shutdown deadline update failed");
      });
      logger.info(
        { signal, reason, ...getProcessDiagnostics() },
        `${signal} received while shutdown is already in progress`,
      );
    }

    installExitHook();
  };

  const sendSupervisorLifecycleMessage = (message: SupervisorLifecycleMessage): boolean => {
    if (typeof process.send !== "function") {
      return false;
    }
    try {
      process.send(message);
      return true;
    } catch (err) {
      logger.error({ err, message }, "Failed to send lifecycle IPC message to supervisor");
      return false;
    }
  };

  const handleLifecycleIntent = (intent: DaemonLifecycleIntent) => {
    if (intent.type === "shutdown") {
      logger.warn(
        { clientId: intent.clientId, requestId: intent.requestId, reason: intent.reason },
        "Shutdown requested via websocket",
      );
      if (sendSupervisorLifecycleMessage({ type: "paseo:shutdown", reason: intent.reason })) {
        return;
      }
      beginShutdown("shutdown lifecycle intent", { reason: intent.reason });
      return;
    }

    logger.warn(
      { clientId: intent.clientId, requestId: intent.requestId, reason: intent.reason },
      "Restart requested via websocket",
    );
    if (
      sendSupervisorLifecycleMessage({
        type: "paseo:restart",
        ...(intent.reason ? { reason: intent.reason } : {}),
      })
    ) {
      return;
    }
    beginShutdown("restart lifecycle intent", {
      reason: intent.reason,
      successExitCode: 0,
    });
  };

  const installSupervisorLivenessGuard = () => {
    if (typeof process.send !== "function") {
      return;
    }

    const supervisorPid = process.ppid;
    let lastSupervisorHeartbeatAt = Date.now();
    let supervisorExitRequested = false;
    const exitAfterSupervisorLoss = (reason: string) => {
      if (supervisorExitRequested) {
        return;
      }
      supervisorExitRequested = true;

      writeWorkerLifecycleLog(paseoHome, "Supervisor liveness lost; worker exiting", {
        reason,
        ...getProcessDiagnostics(),
        supervisorPid,
        currentParentPid: process.ppid,
        ipcConnected: typeof process.connected === "boolean" ? process.connected : null,
        heartbeatAgeMs: Date.now() - lastSupervisorHeartbeatAt,
      });

      // The supervisor owns the worker's stdout/stderr pipes. Once it is gone,
      // logging during graceful shutdown can block on the broken pipe and leave
      // the daemon orphaned, so supervisor loss is a hard process boundary.
      armHardExit(Date.now() + HARD_EXIT_MARGIN_MS);
      process.exit(0);
    };

    process.on("message", (message: unknown) => {
      maintenanceRestart.observe(message);
      if (typeof message !== "object" || message === null || !("type" in message)) {
        return;
      }
      const type = (message as { type?: unknown }).type;
      if (type === "paseo:supervisor-heartbeat") {
        lastSupervisorHeartbeatAt = Date.now();
        return;
      }
      if (type === "paseo:graceful-shutdown") {
        const reason = (message as { reason?: unknown }).reason;
        const terminateAt = (message as { terminateAt?: unknown }).terminateAt;
        if (
          terminateAt !== undefined &&
          (typeof terminateAt !== "number" ||
            !Number.isSafeInteger(terminateAt) ||
            terminateAt > Date.now() + 300_000)
        ) {
          logger.error("Supervisor supplied an invalid shutdown deadline");
          return;
        }
        beginShutdown("Supervisor shutdown request", {
          reason: typeof reason === "string" ? reason : "supervisor_requested_shutdown",
          ...(typeof terminateAt === "number" ? { terminateAt } : {}),
        });
      }
    });
    process.on("disconnect", () => exitAfterSupervisorLoss("ipc_disconnect_event"));

    const timer = setInterval(() => {
      const ipcConnected = typeof process.connected === "boolean" ? process.connected : true;
      const heartbeatExpired = Date.now() - lastSupervisorHeartbeatAt > 3500;
      const supervisorChanged = process.ppid !== supervisorPid;

      if (ipcConnected === false) {
        exitAfterSupervisorLoss("ipc_disconnected");
        return;
      }
      if (supervisorChanged) {
        exitAfterSupervisorLoss("supervisor_parent_pid_changed");
        return;
      }
      if (heartbeatExpired && !isPidAlive(supervisorPid)) {
        exitAfterSupervisorLoss("supervisor_pid_dead");
      }
    }, 1000);
    timer.unref();
  };

  installSupervisorLivenessGuard();

  try {
    const createGovernedScheduleRuntime = await loadGovernedScheduleRuntimeFactory(
      process.env.PASEO_GOVERNED_RUNTIME_MODULE,
    );
    daemon = await createPaseoDaemon(
      {
        ...config,
        onLifecycleIntent: handleLifecycleIntent,
        maintenanceRestart,
      },
      logger,
      { createGovernedScheduleRuntime },
    );
  } catch (err) {
    logger.fatal({ err }, "Daemon bootstrap failed");
    throw err;
  }

  const requestedTarget = parseListenString(config.listen);
  if (requestedTarget.type === "tcp" && process.platform !== "win32") {
    // A frozen predecessor must not turn every restart into a crash loop.
    await reclaimListenAddress({
      host: requestedTarget.host,
      port: requestedTarget.port,
      self: {
        pid: process.pid,
        uid: process.getuid?.() ?? -1,
        workerScript: process.argv[1] ?? "",
      },
      logger,
      ports: systemListenReclaimPorts,
    });
  }

  try {
    await daemon.start();
    const listenTarget = daemon.getListenTarget();
    const listen = formatListenTarget(listenTarget);
    if (!listen) {
      throw new Error("Daemon did not expose a listen target after startup");
    }
    sendSupervisorLifecycleMessage({
      type: "paseo:ready",
      listen,
      serverId: daemon.getServerId(),
    });
  } catch (err) {
    logger.fatal({ err }, "Daemon failed to start listening");
    throw err;
  }

  process.on("SIGTERM", () => beginShutdown("SIGTERM"));
  process.on("SIGINT", () => beginShutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — daemon crashing");
    exitAfterPinoFlush();
  });

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled promise rejection — daemon crashing");
    exitAfterPinoFlush();
  });
}

// Give pino async streams a moment to flush the fatal log entry to daemon.log
// before the process exits. Without this, the last few entries that explain
// why the daemon crashed can be lost.
function exitAfterPinoFlush(): void {
  setTimeout(() => process.exit(1), 200);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  exitAfterPinoFlush();
});
