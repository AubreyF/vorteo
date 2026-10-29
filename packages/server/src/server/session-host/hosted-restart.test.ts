import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { startHostedIdleRelease } from "./idle-release.js";
import {
  rotateSessionHostToken,
  sessionHostPaths,
  type SessionHostAuditRecord,
  type SessionHostPaths,
} from "./host-files.js";
import { startSessionHost, type SessionHost } from "./host.js";
import { createProviderSessionFactory } from "./provider-sessions.js";

const logger = pino({ level: process.env.DEBUG_HOSTED ? "debug" : "silent" });
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
async function startHost(
  paths: SessionHostPaths,
  sessions: ControlledSession[],
  audit: SessionHostAuditRecord[] = [],
) {
  const token = await rotateSessionHostToken(paths);
  const host: SessionHost = await startSessionHost({
    socketPath: paths.socketPath,
    token,
    mcpToken: "host-mcp-token",
    openSession: createProviderSessionFactory({
      logger,
      createClient: () => controlledClient(sessions),
    }),
    audit: (record) => audit.push(record),
  });
  cleanups.push(() => host.close());
  return host;
}

interface Worker {
  manager: AgentManager;
  /** Continuations the fallback queued, by agent. */
  continued: string[];
  storage: AgentStorage;
  applied: AppliedSeqStore;
  routing: Parameters<typeof planHostedStartup>[0]["routing"];
  /** Local sessions: none should exist while the host is running. */
  local: ControlledSession[];
  /** Simulates the worker process dying: its connection drops and it can never reconnect. */
  crash(): void;
  /**
   * While true, the host is alive but this worker cannot reach it, as with a stalled host:
   * connecting fails and the current connection is dropped.
   */
  setUnreachable(unreachable: boolean): void;
}

/** One daemon worker over a shared home, the way consecutive workers share PASEO_HOME. */
function startWorker(
  home: string,
  paths: SessionHostPaths,
  settings: { enabled?: boolean } = {},
): Worker {
  const storage = new AgentStorage(join(home, "agents"), logger);
  const real = createSessionHostConnector({ paths, logger, retryAfterMs: 0 });
  let dead = false;
  let unreachable = false;
  const connector: SessionHostConnector = {
    connect: async (options) => (dead || unreachable ? null : real.connect(options)),
    current: () => (dead || unreachable ? null : real.current()),
    present: () => real.present(),
    hostState: () => real.hostState(),
    upgradePending: () => real.upgradePending!(),
    knownMcpTokens: () => real.knownMcpTokens(),
    close: () => real.close(),
  };
  cleanups.push(() => real.close());
  // A crashed process writes nothing more: its record stays for the next worker to judge.
  const realApplied = createAppliedSeqStore(paths);
  const applied: AppliedSeqStore = {
    read: (agentId) => realApplied.read(agentId),
    list: () => realApplied.list(),
    write: (agentId, record) => (dead ? Promise.resolve() : realApplied.write(agentId, record)),
    remove: (agentId) => (dead ? Promise.resolve() : realApplied.remove(agentId)),
  };
  const routing: Parameters<typeof planHostedStartup>[0]["routing"] = {
    connector,
    isEnabled: () => settings.enabled ?? true,
    logger,
    // A dead worker must not give the turn up while the test runs; its timers never hold exit.
    reattach: { windowMs: 120_000, initialDelayMs: 50, maxDelayMs: 200 },
    applied,
    adoptions: new Map<string, HostedAdoption>(),
  };
  const local: ControlledSession[] = [];
  const claude = createHostedAgentClient({ inner: controlledClient(local), routing });
  const manager = new AgentManager({ clients: { claude }, registry: storage, logger });
  // The parts of the message queue the restart and loss paths use.
  const continued: string[] = [];
  manager.setMessageQueueControl({
    pause: async () => {},
    wake: () => {},
    acceptedHistory: async () => [],
    recordProviderMessageId: async () => {},
    reconcileHistory: async () => {},
    suppressHistoryRestoration: () => {},
    queueRestartContinuation: async () => {},
    queueHostedSessionContinuation: async (agentId) => {
      continued.push(agentId);
    },
  } as unknown as Parameters<AgentManager["setMessageQueueControl"]>[0]);
  routing.onSessionLost = (agentId) => {
    void manager.continueAfterHostedSessionLoss(agentId);
  };
  return {
    manager,
    continued,
    storage,
    applied,
    routing,
    local,
    crash() {
      dead = true;
      real.current()?.close();
    },
    setUnreachable(value) {
      unreachable = value;
      if (value) real.current()?.close();
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

/** How many sessions the host runs, asked over its own socket. */
async function hostedSessionCount(paths: SessionHostPaths): Promise<number> {
  const token = await import("./host-files.js").then((files) => files.readSessionHostToken(paths));
  const probe = await connectSessionHost({ socketPath: paths.socketPath, token });
  try {
    return (await probe.list()).length;
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

test("a turn that finished while no worker was attached is adopted so its last output reaches the timeline", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  const provider = providers[0]!;
  provider.text("first");
  await expect.poll(() => assistantText(first.manager.getTimeline(agent.id))).toBe("first");
  await settled(first, paths, agent.id);
  first.crash();

  // The turn ends during the gap, as under a long Host update: nobody applied these events.
  provider.text("the end");
  provider.complete();

  const second = await restart(home, paths);
  // Idle, yet adopted rather than closed: the unapplied tail is what the agent would otherwise lose.
  await expect.poll(() => second.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  expect(assistantText(second.manager.getTimeline(agent.id))).toBe("firstthe end");
  expect(second.manager.getTimeline(agent.id).filter((item) => item.type === "error")).toEqual([]);
  expect(providers).toHaveLength(1);
  expect(provider.closed).toBe(false);
  expect([...first.local, ...second.local]).toEqual([]);
});

test.each(["turn", "permission"])(
  "stale idle selection preserves a later %s on B while A closes",
  async (busy) => {
    const home = scratch("hosted-stale-idle-");
    const paths = sessionHostPaths(home);
    const providers: ControlledSession[] = [];
    await startHost(paths, providers);
    const worker = startWorker(home, paths);
    const cwd = scratch("hosted-stale-work-");
    const a = await runningAgent(worker, cwd);
    const b = await runningAgent(worker, cwd);
    providers[0]!.complete();
    providers[1]!.complete();
    await expect.poll(() => worker.manager.getAgent(a.id)?.lifecycle).toBe("idle");
    await expect.poll(() => worker.manager.getAgent(b.id)?.lifecycle).toBe("idle");
    const release = startHostedIdleRelease({
      manager: {
        listAgents: () => worker.manager.listAgents(),
        closeAgent: async (id, options) => {
          if (id === a.id) {
            // B was already selected. Change authoritative provider state before closing B.
            if (busy === "turn") await providers[1]!.startTurn("new task");
            else void providers[1]!.requestPermission("blocking-approval");
          }
          await worker.manager.closeAgent(id, options);
        },
      },
      connector: { upgradePending: async () => true },
      logger,
      idleMs: 0,
    });
    cleanups.push(() => release.stop());
    expect(await release.runOnce()).toEqual([a.id]);
    expect(worker.manager.getAgent(b.id)?.id).toBe(b.id);
    expect(providers[1]!.closed).toBe(false);
    if (busy === "permission") {
      await expect
        .poll(() => [...(worker.manager.getAgent(b.id)?.pendingPermissions.keys() ?? [])])
        .toEqual(["blocking-approval"]);
    } else {
      await expect.poll(() => worker.manager.getAgent(b.id)?.activeTurnId).not.toBeNull();
    }
    expect(await hostedSessionCount(paths)).toBe(1);
    // Explicit close retains its existing forceful semantics.
    await worker.manager.closeAgent(b.id);
    expect(providers[1]!.closed).toBe(true);
  },
);

test("while the host waits to upgrade, the worker releases idle hosted sessions and the agent resumes on demand", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const worker = startWorker(home, paths);
  const agent = await runningAgent(worker, workdir);
  providers[0]!.complete();
  await expect.poll(() => worker.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  await settled(worker, paths, agent.id);
  const release = startHostedIdleRelease({
    manager: worker.manager,
    connector: worker.routing.connector,
    logger,
    idleMs: 0,
  });
  cleanups.push(() => release.stop());

  // No upgrade pending: a warm idle session stays hosted.
  expect(await release.runOnce()).toEqual([]);
  expect(await hostedSessionCount(paths)).toBe(1);

  const questions = await worker.manager.mutateQuestions(agent.id, {
    operation: "ask",
    id: "04a035e4-a7f7-4ca7-9329-970a6bedb50a",
    question: "Which follow-up should run next?",
    why: "The completed turn left an asynchronous choice.",
    recommendedDefault: "Keep the current choice.",
  });
  // The host marks an upgrade: the idle session is released and the host has nothing left to run.
  writeFileSync(paths.upgradeMarkerPath, "{}", { mode: 0o600 });
  expect(await release.runOnce()).toEqual([agent.id]);
  expect(providers[0]!.closed).toBe(true);
  expect(await hostedSessionCount(paths)).toBe(0);
  // The agent is unloaded, like an idle agent closed at startup, and waits for a prompt.
  expect(worker.manager.getAgent(agent.id)).toBeNull();
  expect((await worker.storage.get(agent.id))?.questions).toEqual(questions);

  // A prompt resumes the agent on a fresh session, hosted again.
  await ensureAgentLoaded(agent.id, {
    agentManager: worker.manager,
    agentStorage: worker.storage,
    logger,
  });
  expect(worker.manager.getAgent(agent.id)?.questions).toEqual(questions);
  expect(providers).toHaveLength(2);
  expect(worker.local).toEqual([]);
  expect(await hostedSessionCount(paths)).toBe(1);
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

test("a graceful restart leaves the hosted turn running: no wrap-up request, detach, then takeover", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  const audit: SessionHostAuditRecord[] = [];
  await startHost(paths, providers, audit);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  const provider = providers[0]!;
  provider.text("working");
  await expect.poll(() => assistantText(first.manager.getTimeline(agent.id))).toBe("working");

  // The restart drain neither counts nor steers a durably hosted turn.
  expect(first.manager.getRestartImpact().agents).toEqual([]);
  expect(first.manager.beginRestartDrain("restart-1")).toBe(true);
  expect(first.manager.getTimeline(agent.id).some((item) => item.type === "notification")).toBe(
    false,
  );

  // Shutdown detaches instead of closing; the provider keeps running.
  await settled(first, paths, agent.id);
  expect(await first.manager.detachDurableSessions()).toBe(1);
  await first.manager.closeAgent(agent.id);
  expect(provider.closed).toBe(false);
  // The host records the handoff rather than inferring it from the connection ending.
  await expect
    .poll(() => audit.some((entry) => entry.event === "released" && entry.sessionId === agent.id))
    .toBe(true);
  first.crash();

  provider.text(" through the restart");
  const second = await restart(home, paths);
  await expect
    .poll(() => assistantText(second.manager.getTimeline(agent.id)))
    .toBe("working through the restart");
  provider.complete();
  await expect.poll(() => second.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  expect(second.continued).toEqual([]);
  expect(providers).toHaveLength(1);
});

test("loading an agent the host still runs takes it over even without startup planning", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  providers[0]!.text("before");
  await settled(first, paths, agent.id);
  first.crash();

  const second = startWorker(home, paths);
  await ensureAgentLoaded(agent.id, {
    agentManager: second.manager,
    agentStorage: second.storage,
    logger,
  });
  await expect.poll(() => assistantText(second.manager.getTimeline(agent.id))).toBe("before");
  expect(second.manager.getAgent(agent.id)?.lifecycle).toBe("running");
  providers[0]!.complete();
  await expect.poll(() => second.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  expect(providers).toHaveLength(1);
  expect(second.local).toEqual([]);

  // The fenced first worker closing its stale view must not delete the record its successor uses.
  await first.manager.closeAgent(agent.id).catch(() => {});
  expect(await second.applied.read(agent.id)).not.toBeNull();
});

test("with the setting turned off, an agent whose session the host still runs is taken over", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  await settled(first, paths, agent.id);
  first.crash();

  const second = startWorker(home, paths, { enabled: false });
  await ensureAgentLoaded(agent.id, {
    agentManager: second.manager,
    agentStorage: second.storage,
    logger,
  });
  expect(second.local).toEqual([]);
  expect(providers).toHaveLength(1);
  expect(second.manager.getAgent(agent.id)?.lifecycle).toBe("running");
});

test("when the host dies mid-turn the agent continues from a queued continuation", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  const host = await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const worker = startWorker(home, paths);
  worker.routing.reattach = { windowMs: 300, initialDelayMs: 20, maxDelayMs: 50 };
  const agent = await runningAgent(worker, workdir);
  await settled(worker, paths, agent.id);
  await host.close();

  await expect.poll(() => worker.continued, { timeout: 5_000 }).toEqual([agent.id]);
  // The fallback reopened the agent on a fresh session in the worker, since no host answers.
  await expect.poll(() => worker.local.length, { timeout: 5_000 }).toBe(1);
  expect(worker.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  expect(worker.manager.getTimeline(agent.id).some((item) => item.type === "error")).toBe(false);
  // Its record is gone with it, so the next startup does not report the agent lost again.
  expect(await worker.applied.read(agent.id)).toBeNull();
});

test("a host that is gone loses its session at once instead of waiting out the window", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  const host = await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const worker = startWorker(home, paths);
  worker.routing.reattach = {
    windowMs: 60_000,
    aliveWindowMs: 120_000,
    initialDelayMs: 20,
    maxDelayMs: 50,
  };
  const agent = await runningAgent(worker, workdir);
  await settled(worker, paths, agent.id);
  // A closed host releases its lock: no process holds it, so nothing could still run the turn.
  await host.close();

  await expect.poll(() => worker.continued, { timeout: 3_000 }).toEqual([agent.id]);
  expect(providers).toHaveLength(1);
});

test("a session keeps reattaching past its window while the host process lives", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const worker = startWorker(home, paths);
  worker.routing.reattach = {
    windowMs: 100,
    aliveWindowMs: 60_000,
    initialDelayMs: 20,
    maxDelayMs: 50,
  };
  const agent = await runningAgent(worker, workdir);
  const provider = providers[0]!;
  provider.text("before");
  await settled(worker, paths, agent.id);
  worker.setUnreachable(true);
  provider.text(" while unreachable");

  // Well past the reattach window, the host still runs, so the turn is not given up.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(worker.continued).toEqual([]);
  expect(worker.local).toEqual([]);
  expect(worker.manager.getAgent(agent.id)?.lifecycle).toBe("running");

  worker.setUnreachable(false);
  await expect
    .poll(() => assistantText(worker.manager.getTimeline(agent.id)), { timeout: 5_000 })
    .toBe("before while unreachable");
  provider.complete();
  await expect.poll(() => worker.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  expect(worker.continued).toEqual([]);
  expect(providers).toHaveLength(1);
});

test("a permission answer to a live but silent host fails after the window and can be retried", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const worker = startWorker(home, paths);
  worker.routing.reattach = {
    windowMs: 150,
    aliveWindowMs: 60_000,
    initialDelayMs: 20,
    maxDelayMs: 50,
  };
  const agent = await runningAgent(worker, workdir);
  const provider = providers[0]!;
  const answer = provider.requestPermission("perm-1");
  await expect
    .poll(() => [...(worker.manager.getAgent(agent.id)?.pendingPermissions.keys() ?? [])])
    .toEqual(["perm-1"]);
  await settled(worker, paths, agent.id);
  worker.setUnreachable(true);

  // The caller hears back within the window instead of waiting out the longer alive window, and
  // nothing reloads the session: the turn keeps running in the host.
  await expect(
    worker.manager.respondToPermission(agent.id, "perm-1", { behavior: "allow" }),
  ).rejects.toThrow(/not answering yet/);
  expect(worker.local).toEqual([]);
  expect(provider.closed).toBe(false);

  worker.setUnreachable(false);
  await expect
    .poll(
      () =>
        worker.manager
          .respondToPermission(agent.id, "perm-1", { behavior: "allow" })
          .then(() => true)
          .catch(() => false),
      { timeout: 5_000 },
    )
    .toBe(true);
  expect(await answer).toEqual({ behavior: "allow" });
  provider.complete();
  await expect.poll(() => worker.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  expect(worker.continued).toEqual([]);
  expect(providers).toHaveLength(1);
});

test("a host process that stays alive but silent is given up once the longer window ends", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const worker = startWorker(home, paths);
  worker.routing.reattach = {
    windowMs: 100,
    aliveWindowMs: 400,
    initialDelayMs: 20,
    maxDelayMs: 50,
  };
  const agent = await runningAgent(worker, workdir);
  worker.setUnreachable(true);

  await expect.poll(() => worker.continued, { timeout: 5_000 }).toEqual([agent.id]);
});

test("a host that dies during a restart drain queues the continuation without reopening the agent", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  const host = await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const worker = startWorker(home, paths);
  worker.routing.reattach = { windowMs: 300, initialDelayMs: 20, maxDelayMs: 50 };
  const agent = await runningAgent(worker, workdir);
  expect(worker.manager.beginRestartDrain("restart-1")).toBe(true);
  await host.close();

  await expect.poll(() => worker.continued, { timeout: 5_000 }).toEqual([agent.id]);
  // No session may open during the drain; the next worker loads the agent and continues it.
  expect(worker.local).toEqual([]);
  expect(worker.manager.getAgent(agent.id)?.lifecycle).not.toBe("error");
  expect(worker.manager.getTimeline(agent.id).some((item) => item.type === "error")).toBe(false);
});

test("a session that is reattaching when a restart begins is still treated as hosted", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  const provider = providers[0]!;
  provider.text("working");
  await settled(first, paths, agent.id);
  first.setUnreachable(true);
  provider.text(" while reattaching");

  // The provider runs outside this worker either way: no hold, no wrap-up steer, no interrupt.
  expect(first.manager.getRestartImpact().agents).toEqual([]);
  expect(first.manager.beginRestartDrain("restart-1")).toBe(true);
  expect(await first.manager.detachDurableSessions()).toBe(1);
  // A detached session stops reattaching, and reaching the host again neither closes the
  // provider nor takes the session from the next worker.
  first.setUnreachable(false);
  await first.manager.closeAgent(agent.id);
  expect(provider.closed).toBe(false);
  first.crash();

  const second = await restart(home, paths);
  await expect
    .poll(() => assistantText(second.manager.getTimeline(agent.id)))
    .toBe("working while reattaching");
  provider.complete();
  await expect.poll(() => second.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  expect(second.continued).toEqual([]);
  expect(providers).toHaveLength(1);
  expect([...first.local, ...second.local]).toEqual([]);
});

test("with the setting off, a session whose worker died before its first record is still taken over", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  await settled(first, paths, agent.id);
  first.crash();
  // As if the worker had died before its first acknowledgement.
  await first.applied.remove(agent.id);

  const second = startWorker(home, paths, { enabled: false });
  const plan = await planHostedStartup({ routing: second.routing, agents: second.storage, logger });
  expect(plan.adopted).toEqual([agent.id]);
  await loadAdoptedAgents({
    routing: second.routing,
    adopted: plan.adopted,
    loadAgent: (agentId) =>
      ensureAgentLoaded(agentId, {
        agentManager: second.manager,
        agentStorage: second.storage,
        logger,
      }),
    logger,
  });
  expect(second.manager.getAgent(agent.id)?.lifecycle).toBe("running");
  expect(second.local).toEqual([]);
  expect(providers).toHaveLength(1);
});

test("a host that is alive but not answering is waited for, never doubled by a local provider", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  await settled(first, paths, agent.id);
  first.crash();

  const second = startWorker(home, paths, { enabled: false });
  second.setUnreachable(true);
  // Startup does not wait, and does not call sessions of a living host lost.
  const plan = await planHostedStartup({ routing: second.routing, agents: second.storage, logger });
  expect(plan).toMatchObject({ adopted: [], lost: [], hostReachable: false });
  expect(await second.applied.read(agent.id)).not.toBeNull();

  // Loading waits for the host to answer and then takes the session over.
  const loading = ensureAgentLoaded(agent.id, {
    agentManager: second.manager,
    agentStorage: second.storage,
    logger,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(second.local).toEqual([]);
  second.setUnreachable(false);
  await loading;
  expect(second.manager.getAgent(agent.id)?.lifecycle).toBe("running");
  expect(second.local).toEqual([]);
  expect(providers).toHaveLength(1);
});

test("a host that stays silent past the reattach window fails the load instead of doubling the provider", async () => {
  const home = scratch("hosted-restart-");
  const paths = sessionHostPaths(home);
  const providers: ControlledSession[] = [];
  await startHost(paths, providers);
  const workdir = scratch("hosted-restart-work-");

  const first = startWorker(home, paths);
  const agent = await runningAgent(first, workdir);
  await settled(first, paths, agent.id);
  first.crash();

  const second = startWorker(home, paths, { enabled: false });
  second.routing.reattach = { windowMs: 200, initialDelayMs: 20, maxDelayMs: 50 };
  second.setUnreachable(true);
  await expect(
    ensureAgentLoaded(agent.id, {
      agentManager: second.manager,
      agentStorage: second.storage,
      logger,
    }),
  ).rejects.toThrow(/not answering/);
  expect(second.local).toEqual([]);
  expect(providers).toHaveLength(1);
  expect(await second.applied.read(agent.id)).not.toBeNull();
});
