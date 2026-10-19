import type { Logger } from "pino";
import type { AppliedSeqStore } from "./applied-store.js";
import { SessionHostClientError, type HostedSession, type SessionHostClient } from "./client.js";
import type { HostedAdoption, HostedSessionRouting } from "./hosted-agent-client.js";
import type { HostedAgentSession } from "./hosted-agent-session.js";
import { HostedSessionSnapshotSchema } from "./session-contract.js";

/** The part of agent storage startup needs: whether an agent still exists and is active. */
export interface StoredAgentLookup {
  get(agentId: string): Promise<{ archivedAt?: string | null } | null>;
}

export interface HostedStartupPlan {
  /** Running hosted sessions attached and registered for adoption. */
  adopted: string[];
  /** Idle or orphaned hosted sessions closed; their agents resume on demand as usual. */
  closed: string[];
  /** Agents this worker's predecessor hosted whose sessions no longer exist. */
  lost: string[];
  /** False when no host answered, so nothing could be decided. */
  hostReachable: boolean;
}

interface StartupRouting extends HostedSessionRouting {
  applied: AppliedSeqStore;
  adoptions: Map<string, HostedAdoption>;
}

async function closeHosted(client: SessionHostClient, sessionId: string): Promise<void> {
  const channel = await client.attach({ sessionId, afterSeq: null });
  await channel.call({ method: "close" });
}

/** Attaches after the last applied event; a stale or missing record rebuilds from what is left. */
async function attachRunning(
  client: SessionHostClient,
  sessionId: string,
  afterSeq: number,
): Promise<{ channel: HostedSession; throughSeq: number; lossy: boolean }> {
  try {
    const channel = await client.attach({ sessionId, afterSeq });
    return { channel, throughSeq: afterSeq, lossy: false };
  } catch (error) {
    if (!(error instanceof SessionHostClientError) || error.code !== "replay_unavailable")
      throw error;
  }
  const channel = await client.attach({ sessionId, afterSeq: null });
  return { channel, throughSeq: channel.attach.lastSeq, lossy: true };
}

/**
 * First half of startup, before the worker accepts clients: attach every hosted session that is
 * still running a turn or waiting on a permission and register it for adoption, so whoever loads
 * the agent first adopts it rather than starting a second provider. Idle sessions are closed and
 * resume on demand like any other agent, which also keeps the host from accumulating them.
 */
export async function planHostedStartup(input: {
  routing: StartupRouting;
  agents: StoredAgentLookup;
  logger: Logger;
}): Promise<HostedStartupPlan> {
  const { routing, logger } = input;
  const records = await routing.applied.list();
  const plan: HostedStartupPlan = { adopted: [], closed: [], lost: [], hostReachable: false };
  if (records.size === 0 && !routing.isEnabled()) return plan;
  const client = await routing.connector.connect({ force: true });
  if (!client) {
    plan.lost = [...records.keys()];
    return plan;
  }
  plan.hostReachable = true;
  const listed = new Set<string>();
  for (const summary of await client.list()) {
    const agentId = summary.sessionId;
    listed.add(agentId);
    try {
      const stored = await input.agents.get(agentId);
      const snapshot = HostedSessionSnapshotSchema.safeParse(summary.snapshot);
      const running =
        !snapshot.success ||
        snapshot.data.activeTurnId !== null ||
        snapshot.data.pendingPermissions.length > 0;
      if (!stored || stored.archivedAt || !running) {
        await closeHosted(client, agentId);
        await routing.applied.remove(agentId);
        plan.closed.push(agentId);
        continue;
      }
      const record = records.get(agentId);
      const afterSeq = record && record.hostId === client.host.id ? record.lastAppliedSeq : 0;
      const attached = await attachRunning(client, agentId, afterSeq);
      routing.adoptions.set(agentId, { ...attached, hostId: client.host.id });
      plan.adopted.push(agentId);
    } catch (error) {
      logger.warn({ err: error, agentId }, "Could not take over a hosted session at startup");
    }
  }
  for (const agentId of records.keys()) {
    if (listed.has(agentId)) continue;
    await routing.applied.remove(agentId);
    plan.lost.push(agentId);
  }
  return plan;
}

/** The agent no longer exists or names a provider this worker cannot run. */
function isDefinitiveLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /^Agent not found:|references unavailable provider|^Agent is archived:/.test(message);
}

/**
 * Second half, once the worker accepts clients: load each adopted agent, which rebuilds its
 * timeline from the host and then lets its held live events through. Loading also happens on
 * demand if a client gets there first.
 */
export async function loadAdoptedAgents(input: {
  routing: StartupRouting;
  adopted: readonly string[];
  loadAgent(agentId: string): Promise<unknown>;
  logger: Logger;
}): Promise<{ attached: number; total: number }> {
  let attached = 0;
  for (const agentId of input.adopted) {
    let adoptedSession: HostedAgentSession | null = null;
    const adoption = input.routing.adoptions.get(agentId);
    if (adoption) {
      const previous = adoption.onAdopted;
      adoption.onAdopted = (session) => {
        adoptedSession = session;
        previous?.(session);
      };
    }
    let failure: unknown = null;
    try {
      await input.loadAgent(agentId);
      attached += 1;
    } catch (error) {
      failure = error;
      input.logger.warn({ err: error, agentId }, "Could not load an adopted hosted agent");
    } finally {
      // Loading normally releases held events after the rebuilt history; never leave them held.
      (adoptedSession as HostedAgentSession | null)?.releaseLive();
      const unused = input.routing.adoptions.get(agentId);
      if (unused) {
        input.routing.adoptions.delete(agentId);
        if (failure !== null && isDefinitiveLoadFailure(failure)) {
          // Nobody can ever drive this session again, so stop its provider.
          await unused.channel.call({ method: "close" }).catch(() => {});
          await input.routing.applied.remove(agentId).catch(() => {});
        } else {
          // A transient failure: keep the turn running. A later load takes the session over.
          unused.channel.release();
          input.logger.warn({ agentId }, "Left a hosted session running for a later load");
        }
      }
    }
  }
  return { attached, total: input.adopted.length };
}
