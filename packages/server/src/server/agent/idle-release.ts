import type { Logger } from "pino";
import type { IdleSessionObservation, ManagedAgent } from "./agent-manager.js";

/**
 * How long a loaded agent stays idle before its provider process (a Codex app-server, a Claude
 * CLI) is released. Reads such as timeline fetches load an agent without giving it work, so
 * without a release every agent a client ever opened would keep a process until the next restart.
 */
export const DEFAULT_IDLE_SESSION_RELEASE_MS = 30 * 60_000;
const DEFAULT_IDLE_SESSION_CHECK_MS = 60_000;

export type IdleCandidate = Pick<ManagedAgent, "id" | "lifecycle" | "updatedAt" | "session">;

export interface IdleSessionReleaseManager {
  listAgents(): IdleCandidate[];
  releaseIdleSession(agentId: string, expected: IdleSessionObservation): Promise<boolean>;
}

export interface IdleSessionReleaseOptions {
  manager: IdleSessionReleaseManager;
  logger: Logger;
  idleMs?: number;
  intervalMs?: number;
  now?: () => number;
}

export interface IdleSessionRelease {
  /** One pass: the ids whose sessions were released. */
  runOnce(): Promise<string[]>;
  stop(): void;
}

interface IdleObservation {
  since: number;
  updatedAt: number;
  session: unknown;
}

/**
 * Releases the provider sessions of agents that have stayed idle and unchanged for idleMs. The
 * idle period starts at the later of the agent's last update and the first pass that saw it
 * idle, so an agent resumed only to be read counts from when it was loaded, not from its last
 * turn weeks ago. The manager makes the final decision and keeps anything a live session serves.
 */
export function startIdleSessionRelease(options: IdleSessionReleaseOptions): IdleSessionRelease {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_SESSION_RELEASE_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_IDLE_SESSION_CHECK_MS;
  const now = options.now ?? Date.now;
  const observations = new Map<string, IdleObservation>();
  let running: Promise<string[]> | null = null;

  function dueAgents(at: number): Array<{ id: string; expected: IdleSessionObservation }> {
    const due: Array<{ id: string; expected: IdleSessionObservation }> = [];
    const loaded = new Set<string>();
    for (const agent of options.manager.listAgents()) {
      loaded.add(agent.id);
      const updatedAt = agent.updatedAt.getTime();
      const seen = observations.get(agent.id);
      if (agent.lifecycle !== "idle") {
        observations.delete(agent.id);
      } else if (!seen || seen.updatedAt !== updatedAt || seen.session !== agent.session) {
        observations.set(agent.id, { since: at, updatedAt, session: agent.session });
      } else if (at - Math.max(seen.since, updatedAt) >= idleMs) {
        // The manager refuses if the agent changed after this sample, for example while an
        // earlier release in the same pass was still closing.
        due.push({ id: agent.id, expected: { updatedAt, session: agent.session } });
      }
    }
    for (const id of observations.keys()) if (!loaded.has(id)) observations.delete(id);
    return due;
  }

  async function runOnce(): Promise<string[]> {
    const released: string[] = [];
    for (const { id: agentId, expected } of dueAgents(now())) {
      try {
        if (!(await options.manager.releaseIdleSession(agentId, expected))) continue;
        observations.delete(agentId);
        released.push(agentId);
      } catch (error) {
        options.logger.warn({ err: error, agentId }, "Could not release an idle agent session");
      }
    }
    if (released.length)
      options.logger.info(
        { count: released.length, agentIds: released },
        "Released idle agent sessions; they reopen on demand",
      );
    return released;
  }

  const timer =
    intervalMs > 0
      ? setInterval(() => {
          if (running) return;
          running = runOnce()
            .catch((error: unknown) => {
              options.logger.warn({ err: error }, "Idle agent session release failed");
              return [];
            })
            .finally(() => {
              running = null;
            });
        }, intervalMs)
      : null;
  timer?.unref();

  return {
    runOnce,
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
