import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { AgentManager } from "../agent/agent-manager.js";
import type { AgentClient, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { AgentStorage } from "../agent/agent-storage.js";
import {
  CONTROLLED_SESSION_CAPABILITIES,
  ControlledSession,
} from "../test-utils/controlled-provider-session.js";
import { createAppliedSeqStore, type AppliedSeqStore } from "./applied-store.js";
import { loadAdoptedAgents, planHostedStartup } from "./boot-attach.js";
import { connectSessionHost } from "./client.js";
import { createSessionHostConnector, type SessionHostConnector } from "./connector.js";
import { createHostedAgentClient, type HostedAdoption } from "./hosted-agent-client.js";
import { rotateSessionHostToken, sessionHostPaths, type SessionHostPaths } from "./host-files.js";
import { startSessionHost, type SessionHost } from "./host.js";
import { createProviderSessionFactory } from "./provider-sessions.js";

const logger = pino({ level: "silent" });
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function controlledClient(sessions: ControlledSession[]): AgentClient {
  return {
    provider: "claude",
    capabilities: CONTROLLED_SESSION_CAPABILITIES,
    async createSession(config) {
      const session = new ControlledSession(config);
      sessions.push(session);
      return session;
    },
    async resumeSession(_handle, overrides) {
      const session = new ControlledSession({ provider: "claude", cwd: "/", ...overrides });
      sessions.push(session);
      return session;
    },
    async fetchCatalog() {
      return { models: [], modes: [] };
    },
    async isAvailable() {
      return true;
    },
  };
}

/** The session host, independent of any worker, as it runs under launchd. */
async function startHost(paths: SessionHostPaths, sessions: ControlledSession[]) {
  const token = await rotateSessionHostToken(paths);
  const host: SessionHost = await startSessionHost({
    socketPath: paths.socketPath,
    token,
    mcpToken: "host-mcp-token",
    openSession: createProviderSessionFactory({
      logger,
      createClient: () => controlledClient(sessions),
    }),
  });
  cleanups.push(() => host.close());
  return host;
}

interface Worker {
  manager: AgentManager;
  storage: AgentStorage;
  applied: AppliedSeqStore;
  routing: Parameters<typeof planHostedStartup>[0]["routing"];
  /** Local sessions: none should exist while the host is running. */
  local: ControlledSession[];
  /** Simulates the worker process dying: its connection drops and it can never reconnect. */
  crash(): void;
}

/** One daemon worker over a shared home, the way consecutive workers share PASEO_HOME. */
function startWorker(home: string, paths: SessionHostPaths): Worker {
  const storage = new AgentStorage(join(home, "agents"), logger);
  const real = createSessionHostConnector({ paths, logger, retryAfterMs: 0 });
  let dead = false;
  const connector: SessionHostConnector = {
    connect: async (options) => (dead ? null : real.connect(options)),
    current: () => (dead ? null : real.current()),
    knownMcpTokens: () => real.knownMcpTokens(),
    close: () => real.close(),
  };
  cleanups.push(() => real.close());
  const applied = createAppliedSeqStore(paths);
  const routing = {
    connector,
    isEnabled: () => true,
    logger,
    // A dead worker must not give the turn up while the test runs; its timers never hold exit.
    reattach: { windowMs: 120_000, initialDelayMs: 50, maxDelayMs: 200 },
    applied,
    adoptions: new Map<string, HostedAdoption>(),
  };
  const local: ControlledSession[] = [];
  const claude = createHostedAgentClient({ inner: controlledClient(local), routing });
  const manager = new AgentManager({ clients: { claude }, registry: storage, logger });
  return {
    manager,
    storage,
    applied,
    routing,
    local,
    crash() {
      dead = true;
      real.current()?.close();
    },
  };
}

/**
 * All assistant text in order. Adjacent chunks merge into one row by design, so the joined text
 * is the precise check: a replayed duplicate would repeat a chunk.
 */
function assistantText(timeline: AgentTimelineItem[]): string {
  return timeline
    .flatMap((item) => (item.type === "assistant_message" ? [item.text] : []))
    .join("");
}

async function restart(home: string, paths: SessionHostPaths): Promise<Worker> {
  const next = startWorker(home, paths);
  const plan = await planHostedStartup({ routing: next.routing, agents: next.storage, logger });
  await loadAdoptedAgents({
    routing: next.routing,
    adopted: plan.adopted,
    loadAgent: (agentId) =>
      ensureAgentLoaded(agentId, {
        agentManager: next.manager,
        agentStorage: next.storage,
        logger,
      }),
    logger,
  });
  return next;
}

async function hostedLastSeq(paths: SessionHostPaths, agentId: string): Promise<number> {
  const token = await import("./host-files.js").then((files) => files.readSessionHostToken(paths));
  const probe = await connectSessionHost({ socketPath: paths.socketPath, token });
  try {
    return (await probe.list()).find((session) => session.sessionId === agentId)?.lastSeq ?? -1;
  } finally {
    probe.close();
  }
}

async function runningAgent(worker: Worker, cwd: string) {
  const agent = await worker.manager.createAgent(
    { provider: "claude", cwd, model: "claude-haiku" },
    undefined,
    { workspaceId: undefined },
  );
  void (async () => {
    for await (const _event of worker.manager.streamAgent(agent.id, "long task")) {
      // The first worker never sees this turn end.
    }
  })().catch(() => {});
  await expect.poll(() => worker.manager.getAgent(agent.id)?.lifecycle).toBe("running");
  return agent;
}

/** Waits until the worker has durably recorded every event the host has logged so far. */
async function settled(worker: Worker, paths: SessionHostPaths, agentId: string): Promise<void> {
  await expect
    .poll(async () => (await worker.applied.read(agentId))?.lastAppliedSeq, { timeout: 5_000 })
    .toBe(await hostedLastSeq(paths, agentId));
  await worker.storage.flush();
}

test("a worker that dies mid-turn is replaced and the new worker finishes the turn with the same timeline", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  const provider = providers[0]!;
  provider.text("first");
  provider.text("second");
  await expect.poll(() => assistantText(first.manager.getTimeline(agent.id))).toBe("firstsecond");
  await settled(first, paths, agent.id);

  first.crash();
  provider.text("while no worker is attached");

  const second = await restart(home, paths);
  await expect
    .poll(() => assistantText(second.manager.getTimeline(agent.id)))
    .toBe("firstsecondwhile no worker is attached");
  expect(second.manager.getAgent(agent.id)?.lifecycle).toBe("running");

  provider.text("after the restart");
  provider.complete();
  await expect.poll(() => second.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  const timeline = second.manager.getTimeline(agent.id);
  expect(assistantText(timeline)).toBe("firstsecondwhile no worker is attachedafter the restart");
  expect(timeline.filter((item) => item.type === "error")).toEqual([]);
  expect(providers).toHaveLength(1);
  expect([...first.local, ...second.local]).toEqual([]);
  await expect
    .poll(async () => (await second.applied.read(agent.id))?.lastAppliedSeq)
    .toBe(await hostedLastSeq(paths, agent.id));
});

test("a permission asked before the restart is shown once and answered by the new worker", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  const provider = providers[0]!;
  const answer = provider.requestPermission("perm-1");
  await expect
    .poll(() => [...(first.manager.getAgent(agent.id)?.pendingPermissions.keys() ?? [])])
    .toEqual(["perm-1"]);
  await settled(first, paths, agent.id);
  first.crash();

  const second = await restart(home, paths);
  await expect
    .poll(() => [...(second.manager.getAgent(agent.id)?.pendingPermissions.keys() ?? [])])
    .toEqual(["perm-1"]);
  await second.manager.respondToPermission(agent.id, "perm-1", { behavior: "allow" });
  expect(await answer).toEqual({ behavior: "allow" });
  provider.complete();
  await expect.poll(() => second.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  expect(second.manager.getAgent(agent.id)?.pendingPermissions.size).toBe(0);
});

test("an idle hosted session is closed at startup and its agent resumes on demand", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  providers[0]!.complete();
  await expect.poll(() => first.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  await settled(first, paths, agent.id);
  first.crash();

  const second = startWorker(home, paths);
  const plan = await planHostedStartup({ routing: second.routing, agents: second.storage, logger });
  expect(plan).toMatchObject({ adopted: [], closed: [agent.id], lost: [] });
  expect(providers[0]!.closed).toBe(true);
  expect(await second.applied.read(agent.id)).toBeNull();

  await ensureAgentLoaded(agent.id, {
    agentManager: second.manager,
    agentStorage: second.storage,
    logger,
  });
  expect(providers).toHaveLength(2);
});

test("sessions of a host that restarted are reported lost so the fallback can resume them", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  const host = await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  providers[0]!.text("before the host stopped");
  await settled(first, paths, agent.id);
  first.crash();
  await host.close();
  await startHost(paths, providers);

  const second = startWorker(home, paths);
  const plan = await planHostedStartup({ routing: second.routing, agents: second.storage, logger });
  expect(plan).toMatchObject({ adopted: [], lost: [agent.id], hostReachable: true });
  expect(await second.applied.read(agent.id)).toBeNull();
});
