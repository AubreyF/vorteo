import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  RestartImpact,
  RestartJob,
  ExecutionEnvironmentKind,
} from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "./config.js";
import type { RestartExecutor } from "./restarts.js";

const execFileAsync = promisify(execFile);

// Status includes provider availability probes, which can exceed three seconds.
const DAEMON_RESPONSE_TIMEOUT_MS = 30_000;

export async function connectInstallationDaemon(
  config: InstallationConfig,
  kind: ExecutionEnvironmentKind,
): Promise<DaemonClient> {
  const target = config[kind];
  const descriptor = config.public.environments.find((environment) => environment.kind === kind);
  if (!descriptor) throw new Error("Installation environment is missing");
  const client = new DaemonClient({
    url: `ws://${target.endpoint}/ws`,
    password: target.password,
    expectedServerId: descriptor.serverId,
    clientId: `installation-${randomUUID()}`,
    clientType: "cli",
    connectTimeoutMs: DAEMON_RESPONSE_TIMEOUT_MS,
    reconnect: { enabled: false },
    webSocketFactory: (url, options) => {
      const socket = new WebSocket(url, options?.protocols, { headers: options?.headers });
      return {
        get readyState() {
          return socket.readyState;
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        on: (event, listener) => {
          socket.on(event, listener);
        },
        off: (event, listener) => {
          socket.off(event, listener);
        },
      };
    },
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function validateHostStartup(config: InstallationConfig): Promise<void> {
  const validation = config.host.startupValidation;
  if (!validation) return;
  try {
    await execFileAsync(validation.node, [validation.entrypoint], {
      env: { ...process.env, PASEO_HOME: validation.home, PASEO_VALIDATE_STARTUP: "1" },
      timeout: 15_000,
      maxBuffer: 8192,
    });
  } catch (error) {
    let fields = "";
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
      const match = error.stderr.match(/^Invalid configuration fields: ([a-zA-Z0-9_., -]+)$/);
      if (match) fields = ` Invalid fields: ${match[1]}.`;
    }
    throw new Error(
      `Host startup preflight failed. No restart was dispatched.${fields} Repair configuration or restore a validated backup, then request a new restart.`,
      { cause: error },
    );
  }
}

async function reportRestartTimeout(
  config: InstallationConfig,
  target: RestartJob["target"],
): Promise<never> {
  if (target === "host") {
    await validateHostStartup(config);
    throw new Error(
      "Host replacement was not ready within two minutes. Startup configuration passed validation. Inspect the host service log for a worker crash, missing dependency, port conflict or identity mismatch. Preserve state and restore a validated launcher if needed, then request a new restart. No restart was replayed.",
    );
  }
  throw new Error(
    "Dev container replacement was not ready within two minutes. Inspect the existing supervisor log and verify its identity and credentials. Preserve the container and state, then request a new restart. No restart was replayed.",
  );
}

export function createInstallationRestartExecutor(config: InstallationConfig): RestartExecutor {
  async function restart(target: RestartJob["target"], whenIdle = false): Promise<string | null> {
    const kind = target === "host" ? "host" : "container";
    let previousPid: number | null = null;
    let before: DaemonClient | null = null;
    try {
      before = await connectInstallationDaemon(config, kind);
      previousPid = (await before.getDaemonStatus({ timeout: DAEMON_RESPONSE_TIMEOUT_MS })).pid;
    } catch (error) {
      if (whenIdle) return null;
      if (target !== "host") throw error;
      // The installation owns this launchd service even when its daemon is down.
      // Readiness after recovery still requires the pinned identity and credential.
    } finally {
      await before?.close();
    }
    if (whenIdle) {
      let client: DaemonClient;
      try {
        client = await connectInstallationDaemon(config, kind);
      } catch {
        // No restart RPC was sent; safely keep waiting for the target.
        return null;
      }
      try {
        const result = await client.restartServer("owner_approved_idle_restart", undefined, {
          timeout: 5000,
          idleMode: "restart",
        });
        if (result.accepted === false) return null;
        if (result.accepted !== true)
          throw new Error("Daemon did not confirm the idle restart barrier");
      } finally {
        await client.close();
      }
    } else if (target === "host") {
      await execFileAsync("/bin/launchctl", ["kickstart", "-k", config.host.launchdService], {
        timeout: 15_000,
      });
    } else {
      const client = await connectInstallationDaemon(config, kind);
      try {
        // The container and its supervisor remain in place. Never recreate it.
        await client.restartServer("owner_approved_installation_restart", undefined, {
          timeout: 5000,
        });
      } catch (error) {
        const lostReply =
          error instanceof Error &&
          "code" in error &&
          ["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"].includes(String(error.code));
        if (!lostReply) throw error;
        // The worker may exit before delivering its acknowledgement. Verify the
        // replacement instead of either replaying the restart or claiming failure.
      } finally {
        await client.close();
      }
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await delay(1000);
      let client: DaemonClient | null = null;
      try {
        client = await connectInstallationDaemon(config, kind);
        const status = await client.getDaemonStatus({ timeout: DAEMON_RESPONSE_TIMEOUT_MS });
        if (status.pid !== previousPid)
          return `Replacement worker ${status.pid} is ready; environment identity verified`;
      } catch {
        // Startup can temporarily refuse connections. The deadline bounds recovery.
      } finally {
        await client?.close();
      }
    }
    return reportRestartTimeout(config, target);
  }
  return {
    async inspect(target): Promise<RestartImpact> {
      const client = await connectInstallationDaemon(
        config,
        target === "host" ? "host" : "container",
      );
      try {
        const idleRestartSupported =
          client.getLastServerInfoMessage()?.features?.idleRestart === true;
        if (idleRestartSupported) {
          const response = await client.restartServer(undefined, undefined, {
            idleMode: "inspect",
          });
          if (!response.impact) throw new Error("Daemon did not return restart impact");
          return {
            target,
            checkedAt: new Date().toISOString(),
            ...response.impact,
            idleRestartSupported,
            error: null,
          };
        }
        // COMPAT(idleRestart): added in v0.11.0-beta.3.vorteo.131; retain read-only inventory until the daemon floor supports idle restarts.
        const agents: RestartImpact["agents"] = [];
        let cursor: string | undefined;
        do {
          const page = await client.fetchAgents({
            filter: { includeArchived: true },
            page: { limit: 200, cursor },
          });
          for (const { agent } of page.entries) {
            if (agent.status === "running" || agent.status === "initializing")
              agents.push({
                id: agent.id,
                title: agent.title || agent.id,
                status: agent.status,
              });
          }
          cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
          if (page.pageInfo.hasMore && !cursor) throw new Error("Incomplete agent inventory");
        } while (cursor);
        return {
          target,
          checkedAt: new Date().toISOString(),
          agents,
          pendingStarts: 0,
          idleRestartSupported,
          error: null,
        };
      } finally {
        await client.close();
      }
    },
    async restart(target) {
      if (target === "host") await validateHostStartup(config);
      const detail = await restart(target);
      if (detail === null) throw new Error("Restart was not dispatched");
      return detail;
    },
    async restartWhenIdle(target) {
      if (target === "host") await validateHostStartup(config);
      return restart(target, true);
    },
  };
}
