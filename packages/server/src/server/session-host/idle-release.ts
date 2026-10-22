import type { Logger } from "pino";
import type { SessionHostConnector } from "./connector.js";
import { DEFAULT_IDLE_RELEASE_MS } from "./settings.js";

/** The slice of a managed agent the release decision reads. */
export interface ReleasableAgent {
  id: string;
  lifecycle: string;
  activeTurnId: string | null;
  pendingPermissions: { size: number };
  updatedAt: Date;
  session: { isDurablyHosted?(): boolean } | null;
}

export interface IdleReleaseManager {
  listAgents(): ReleasableAgent[];
  /** Closes the agent's session; the agent resumes on demand, in the host again when possible. */
  closeAgent(agentId: string): Promise<void>;
}

export interface IdleReleaseOptions {
  manager: IdleReleaseManager;
  connector: Pick<SessionHostConnector, "upgradePending">;
  logger: Logger;
  /** How long an agent must have been quiet before its hosted session is released. */
  idleMs?: number;
  /** How often to look. */
  intervalMs?: number;
  now?: () => number;
}

export interface IdleRelease {
  /** One pass: the ids whose sessions were released. Empty when no upgrade is pending. */
  runOnce(): Promise<string[]>;
  stop(): void;
}

/**
 * Picks the hosted agents a pending host upgrade may release: idle, with no turn, no pending
 * permission, and quiet for at least idleMs. A running turn or an unanswered permission is never
 * cut; the host waits for them as it always has.
 */
export function selectIdleHostedAgents(
  agents: readonly ReleasableAgent[],
  now: number,
  idleMs: number,
): ReleasableAgent[] {
  return agents.filter(
    (agent) =>
      agent.session?.isDurablyHosted?.() === true &&
      agent.lifecycle === "idle" &&
      agent.activeTurnId === null &&
      agent.pendingPermissions.size === 0 &&
      now - agent.updatedAt.getTime() >= idleMs,
  );
}

/**
 * While the session host reports a pending upgrade, releases idle hosted sessions so the host
 * reaches zero sessions and exits for launchd to relaunch it on the installed release. Each
 * released agent closes like an idle agent at startup does and reopens on demand, in the new host.
 * Nothing happens while no upgrade is pending, so warm sessions stay warm.
 */
export function startHostedIdleRelease(options: IdleReleaseOptions): IdleRelease {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_RELEASE_MS;
  const now = options.now ?? Date.now;
  let running: Promise<string[]> | null = null;

  async function runOnce(): Promise<string[]> {
    if (!(await options.connector.upgradePending?.())) return [];
    const released: string[] = [];
    for (const agent of selectIdleHostedAgents(options.manager.listAgents(), now(), idleMs)) {
      try {
        await options.manager.closeAgent(agent.id);
        released.push(agent.id);
      } catch (error) {
        options.logger.warn(
          { err: error, agentId: agent.id },
          "Could not release an idle hosted session for the host upgrade",
        );
      }
    }
    if (released.length)
      options.logger.info(
        { count: released.length },
        "Released idle hosted sessions so the session host can exit for its upgrade",
      );
    return released;
  }

  const timer =
    options.intervalMs === undefined || options.intervalMs <= 0
      ? null
      : setInterval(() => {
          if (running) return;
          running = runOnce()
            .catch((error: unknown) => {
              options.logger.warn({ err: error }, "Idle hosted session release failed");
              return [];
            })
            .finally(() => {
              running = null;
            });
        }, options.intervalMs);
  timer?.unref();

  return {
    runOnce,
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
