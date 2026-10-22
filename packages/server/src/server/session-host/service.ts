import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino, { type Logger } from "pino";
import { createProviderChildRegistry, type ProviderChildRegistry } from "./provider-children.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { resolvePaseoHome } from "../paseo-home.js";
import {
  createRotatingAppender,
  createSessionHostAuditLog,
  preparePrivateDirectory,
  rotateSessionHostToken,
  sessionHostPaths,
  type SessionHostAuditRecord,
} from "./host-files.js";
import { startSessionHost, type SessionHost, type SessionHostLimits } from "./host.js";
import { SESSION_HOST_PROTOCOL_VERSION } from "./protocol.js";
import { createProviderSessionFactory, type HostedClientFactory } from "./provider-sessions.js";
import { DEFAULT_RELEASE_CHECK_MS, readDurableSessionsSettings } from "./settings.js";
import { DEFAULT_HANG_TIMEOUT_MS, startSessionHostWatchdog } from "./watchdog.js";

/** File in the session host directory that receives the service log as JSON lines. */
export const SESSION_HOST_LOG_FILE_NAME = "host.log";

export const DEFAULT_SHUTDOWN_DEADLINE_MS = 20_000;

/**
 * Lets a test run the entrypoint on a fake provider: a module path whose `createClient` export
 * is a HostedClientFactory. Honored only when NODE_ENV is "test", so an installed host always
 * runs the real Claude client.
 */
export const SESSION_HOST_TEST_CLIENT_MODULE_ENV = "PASEO_SESSION_HOST_TEST_CLIENT_MODULE";

/** Lets the final close reply reach its worker before an idle upgrade exit drops the socket. */
const IDLE_EXIT_GRACE_MS = 200;

export interface SessionHostServiceOptions {
  /** Defaults to PASEO_HOME, resolved the way the daemon resolves it. */
  paseoHome?: string;
  /** Defaults to the Claude client. Tests inject a fake provider here. */
  createClient?: HostedClientFactory;
  /** Defaults to the server package version. */
  release?: string;
  hangTimeoutMs?: number;
  shutdownDeadlineMs?: number;
  limits?: Partial<SessionHostLimits>;
  /** Defaults to process.exit. */
  exit?: (code: number) => void;
  /**
   * The release the installation would start a new host on: the server package version reached
   * through the entrypoint path launchd ran, which goes through the current release link. Defaults
   * to resolving it from process.argv; tests inject it. Undefined means it cannot be told.
   */
  installedRelease?: () => Promise<string | undefined>;
  /** Defaults to the setting file's releaseCheckMs, else one minute. */
  releaseCheckMs?: number;
}

/** The version of the release that process.argv names once links are resolved. */
async function installedReleaseFromArgv(): Promise<string | undefined> {
  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;
  try {
    return resolveDaemonVersion(pathToFileURL(await realpath(entrypoint)).href);
  } catch {
    return undefined;
  }
}

export interface SessionHostService {
  host: SessionHost;
  logger: Logger;
  /** Closes the host and exits. Later calls join the shutdown already in progress. */
  shutdown(reason: string): Promise<void>;
}

/**
 * The service log, capped like the audit log. Writes are synchronous so the last lines before an
 * exit or a watchdog kill survive.
 */
function openPrivateLog(logPath: string): Logger {
  const append = createRotatingAppender({
    path: logPath,
    // launchd keeps stderr in the job's own log, so an unwritable host log is still visible.
    onError: (error) => process.stderr.write(`Session host log write failed: ${String(error)}\n`),
  });
  return pino({ base: { pid: process.pid, module: "session-host" } }, { write: append });
}

/** The word a Codex app-server command line carries; a recorded pid is stopped only while it does. */
export const CODEX_CHILD_MARKER = "app-server";

/**
 * Loaded only when no client is injected, so a test host never loads a provider SDK. Builds the
 * client the worker would have built for the provider named in the open request.
 */
async function loadProviderClientFactory(
  children: ProviderChildRegistry,
): Promise<HostedClientFactory> {
  const [{ ClaudeAgentClient }, { CodexAppServerAgentClient }] = await Promise.all([
    import("../agent/providers/claude/agent.js"),
    import("../agent/providers/codex-app-server-agent.js"),
  ]);
  return ({ provider, logger, runtimeSettings, customProvider }) => {
    if (provider === "codex")
      return new CodexAppServerAgentClient(logger, runtimeSettings, {
        customProvider,
        workspaceGitService: { resolveRepoRoot },
        onChildSpawned: (child, context) => {
          if (child.pid === undefined) return;
          const pid = child.pid;
          // Both the binary that was launched and the app-server word must still be on the command
          // line before a recorded pid is ever signalled, so a reused pid is left alone.
          const markers = [child.spawnfile, CODEX_CHILD_MARKER].filter((m) => m.length > 0);
          void children
            .record({ pid, markers, agentId: context.agentId })
            .catch((error: unknown) =>
              logger.warn({ err: error, pid }, "Could not record a Codex app-server child"),
            );
          child.once("exit", () => {
            void children.forget(pid).catch(() => {});
          });
        },
      });
    return new ClaudeAgentClient({ logger, runtimeSettings });
  };
}

/**
 * The repository root of a working directory, for Codex skills discovery. Rejects outside a
 * repository, which the Codex adapter already treats as "no repository".
 */
async function resolveRepoRoot(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 5_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
      (error, stdout) => {
        const root = String(stdout).trim();
        if (error || !root) reject(error ?? new Error("Not inside a git repository."));
        else resolve(root);
      },
    );
  });
}

/**
 * Runs the session host as its own long-lived process: private files, a rotated token, the
 * off-thread watchdog, graceful shutdown on SIGTERM or SIGINT, and an exit at idle when a worker
 * needs a newer protocol, so launchd restarts the host on the installed release.
 */
export async function startSessionHostService(
  options: SessionHostServiceOptions = {},
): Promise<SessionHostService> {
  // No process-wide umask: Claude and every tool it runs inherit this process's mask, and files
  // they create must stay readable as usual. Host files use explicit modes instead, and the host
  // applies a private mask only while it creates its socket.
  const paseoHome = options.paseoHome ?? resolvePaseoHome(process.env);
  const paths = sessionHostPaths(paseoHome);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const shutdownDeadlineMs = options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
  const release = options.release ?? resolveDaemonVersion(import.meta.url);
  const installedRelease = options.installedRelease ?? installedReleaseFromArgv;
  const releaseCheckMs =
    options.releaseCheckMs ??
    readDurableSessionsSettings(paseoHome).releaseCheckMs ??
    DEFAULT_RELEASE_CHECK_MS;
  await preparePrivateDirectory(paths.directory);
  const children = createProviderChildRegistry(paths.directory);
  // A broken install fails here, before it can rotate the token of anything.
  const createClient = options.createClient ?? (await loadProviderClientFactory(children));
  const logPath = path.join(paths.directory, SESSION_HOST_LOG_FILE_NAME);
  const logger = openPrivateLog(logPath);
  /**
   * Detached provider processes from a host that died keep running; stop them before serving, so
   * no continued agent ever shares a thread with an orphan. This runs only once this host holds
   * the lock: a second host started by mistake must never stop the live host's providers.
   */
  async function reapOrphans(): Promise<void> {
    const reaped = await children.reapOrphans();
    if (reaped.stopped.length || reaped.dropped.length)
      logger.warn(
        {
          stopped: reaped.stopped.map((child) => ({ pid: child.pid, agentId: child.agentId })),
          dropped: reaped.dropped.length,
        },
        "Stopped provider processes left by an earlier session host",
      );
  }
  const watchdog = startSessionHostWatchdog({
    logPath,
    hangTimeoutMs: options.hangTimeoutMs ?? DEFAULT_HANG_TIMEOUT_MS,
    probe: { socketPath: paths.socketPath, tokenPath: paths.tokenPath },
    onError: (error) => logger.error({ err: error }, "Session host watchdog failed"),
  });

  let host: SessionHost | null = null;
  let upgradePending = false;
  let shuttingDown: Promise<void> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let releaseTimer: NodeJS.Timeout | null = null;

  function shutdown(reason: string): Promise<void> {
    shuttingDown ??= (async () => {
      watchdog.armDeadline(Date.now() + shutdownDeadlineMs);
      if (releaseTimer) clearInterval(releaseTimer);
      logger.info({ reason }, "Session host stopping");
      // launchd relaunches the host on the installed release; until it listens, workers must treat
      // the missing socket as a host that is returning, not one that was removed.
      if (reason === "upgrade_at_idle")
        await writeFile(
          paths.restartMarkerPath,
          JSON.stringify({ requestedAt: new Date().toISOString(), reason }),
          { mode: 0o600 },
        ).catch((error: unknown) =>
          logger.warn({ err: error }, "Could not write the restart marker before the upgrade exit"),
        );
      let code = 0;
      try {
        await host?.close();
      } catch (error) {
        code = 1;
        logger.error({ err: error }, "Session host failed to close");
      }
      logger.info({ reason, code }, "Session host stopped");
      exit(code);
    })();
    return shuttingDown;
  }

  /**
   * Marks an upgrade as pending once, so idle sessions get released by their workers and the host
   * exits at zero sessions; the marker file is how workers and the coordinator learn of it.
   */
  function markUpgradePending(why: string, detail: Record<string, unknown>): void {
    if (!upgradePending) {
      logger.info(detail, why);
      void writeFile(
        paths.upgradeMarkerPath,
        JSON.stringify({ ...detail, markedAt: new Date().toISOString() }),
        { mode: 0o600 },
      ).catch((error: unknown) =>
        logger.warn({ err: error }, "Could not write the upgrade pending marker"),
      );
    }
    upgradePending = true;
    exitIfIdle();
  }

  /** A newer release under the current link means this host should give way once idle. */
  async function checkInstalledRelease(): Promise<void> {
    if (upgradePending || shuttingDown) return;
    const installed = await installedRelease();
    if (installed && installed !== release)
      markUpgradePending("A newer release is installed; exiting once no session runs", {
        installed,
        running: release,
      });
  }

  /** Exits for an upgrade only when no session runs, rechecking after the grace period. */
  function exitIfIdle(): void {
    if (!upgradePending || !host || shuttingDown || idleTimer) return;
    if (host.sessionCount() > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (host && host.sessionCount() === 0) void shutdown("upgrade_at_idle");
    }, IDLE_EXIT_GRACE_MS);
  }

  const writeAudit = createSessionHostAuditLog({
    path: paths.auditLogPath,
    onError: (error) => logger.warn({ err: error }, "Session host audit write failed"),
  });
  function audit(record: SessionHostAuditRecord): void {
    writeAudit(record);
    // Only a peer holding the token reaches the version check, so no stranger can cause this. An
    // older worker is no reason to restart: the installed release would refuse it again.
    if (
      record.event === "hello_rejected" &&
      record.reason === "version" &&
      typeof record.protocolVersion === "number" &&
      record.protocolVersion > SESSION_HOST_PROTOCOL_VERSION
    ) {
      markUpgradePending("A worker needs a newer session host; exiting once no session runs", {
        protocolVersion: record.protocolVersion,
      });
    } else if (record.event === "session_closed" || record.event === "open_failed") {
      exitIfIdle();
    }
  }

  const sessionLogger = logger.child({ module: "session-host-provider" });
  host = await startSessionHost({
    socketPath: paths.socketPath,
    // Rotated only once this host holds the lock, so a second host started by mistake fails
    // without invalidating the running host's token.
    token: () => rotateSessionHostToken(paths),
    // Memory only: workers learn it at hello, and a new host run means a new token.
    mcpToken: randomBytes(32).toString("base64url"),
    openSession: createProviderSessionFactory({
      logger: sessionLogger,
      createClient,
    }),
    audit,
    release,
    limits: options.limits,
    afterLock: reapOrphans,
  });
  watchdog.markListening();
  // A tracked restart or an upgrade exit left these for workers; the host that answers again
  // removes them.
  for (const marker of [paths.restartMarkerPath, paths.upgradeMarkerPath])
    await rm(marker, { force: true }).catch((error: unknown) =>
      logger.warn({ err: error, marker }, "Could not remove a session host marker"),
    );
  logger.info({ hostId: host.identity.id, release }, "Session host started");
  // A mismatched hello can arrive before startSessionHost returns.
  exitIfIdle();
  releaseTimer = setInterval(() => void checkInstalledRelease(), releaseCheckMs);
  releaseTimer.unref();

  // once: a second SIGTERM or SIGINT during shutdown takes the default action and kills the host
  // at once. That is intended; launchd itself escalates to SIGKILL after its exit timeout.
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => void shutdown(signal));

  return { host, logger, shutdown };
}

/**
 * Lets a test pretend the installed release differs from the running one. Honored only when
 * NODE_ENV is "test"; an installed host always reads the release through its own entrypoint path.
 */
export const SESSION_HOST_TEST_INSTALLED_RELEASE_ENV = "PASEO_SESSION_HOST_TEST_INSTALLED_RELEASE";

/** Test-only service options from the environment; empty outside tests. */
export function loadTestServiceOptions(
  env: NodeJS.ProcessEnv,
): Pick<SessionHostServiceOptions, "installedRelease"> {
  const installed = env[SESSION_HOST_TEST_INSTALLED_RELEASE_ENV];
  if (!installed || env.NODE_ENV !== "test") return {};
  return { installedRelease: async () => installed };
}

/** The test-only client override for the entrypoint, or undefined to use Claude. */
export async function loadTestClientFactory(
  env: NodeJS.ProcessEnv,
): Promise<HostedClientFactory | undefined> {
  const modulePath = env[SESSION_HOST_TEST_CLIENT_MODULE_ENV];
  if (!modulePath || env.NODE_ENV !== "test") return undefined;
  const loaded = (await import(pathToFileURL(modulePath).href)) as {
    createClient?: HostedClientFactory;
  };
  if (typeof loaded.createClient !== "function")
    throw new Error("The session host test client module must export createClient.");
  return loaded.createClient;
}
