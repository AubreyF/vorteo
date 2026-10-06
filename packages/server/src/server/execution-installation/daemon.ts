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
    throw new Error(
      "Replacement was not confirmed within two minutes. Inspect the target before requesting another restart.",
    );
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
      const detail = await restart(target);
      if (detail === null) throw new Error("Restart was not dispatched");
      return detail;
    },
    restartWhenIdle: (target) => restart(target, true),
  };
}
