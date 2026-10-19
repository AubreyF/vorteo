import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import {
  CONTROLLED_SESSION_CAPABILITIES,
  ControlledSession,
} from "../test-utils/controlled-provider-session.js";
import { createSessionHostConnector, type SessionHostConnector } from "./connector.js";
import { StaleProviderSessionError } from "../agent/stale-provider-session-error.js";
import { createHostedAgentClient } from "./hosted-agent-client.js";
import { HostedAgentSession, HostedSessionUnavailableError } from "./hosted-agent-session.js";
import { rotateSessionHostToken, sessionHostPaths } from "./host-files.js";
import { startSessionHost, type SessionHost, type SessionHostLimits } from "./host.js";
import { connectSessionHost } from "./client.js";
import { createProviderSessionFactory } from "./provider-sessions.js";
import { durableSessionsSettingsPath, readDurableSessionsSettings } from "./settings.js";

const logger = pino({ level: "silent" });
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Stands in for the local Claude client; it records sessions the worker ran itself. */
function localClient() {
  const local: ControlledSession[] = [];
  const client: AgentClient = {
    provider: "claude",
    capabilities: CONTROLLED_SESSION_CAPABILITIES,
    async createSession(config) {
      const session = new ControlledSession(config);
      local.push(session);
      return session;
    },
    async resumeSession(_handle, overrides) {
      const session = new ControlledSession({ provider: "claude", cwd: "/", ...overrides });
      local.push(session);
      return session;
    },
    async fetchCatalog() {
      return { models: [], modes: [] };
    },
    async isAvailable() {
      return true;
    },
  };
  return { client, local };
}

interface HostedFixture {
  home: string;
  host: SessionHost;
  hosted: ControlledSession[];
  connector: SessionHostConnector;
  client: AgentClient;
  local: ControlledSession[];
  launchSeen: (AgentLaunchContext | undefined)[];
  setEnabled(enabled: boolean): void;
  /** Agents whose hosted session ended with its host. */
  lost: string[];
  /** The next n connection attempts return null, as when the host is slow to answer. */
  failConnects(count: number): void;
  socketPath: string;
  token: string;
}

async function hostedFixture(
  input: { history?: AgentStreamEvent[]; limits?: Partial<SessionHostLimits> } = {},
): Promise<HostedFixture> {
  const home = mkdtempSync(join(tmpdir(), "hosted-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = sessionHostPaths(home);
  const token = await rotateSessionHostToken(paths);
  const hosted: ControlledSession[] = [];
  const launchSeen: (AgentLaunchContext | undefined)[] = [];
  const host = await startSessionHost({
    socketPath: paths.socketPath,
    token,
    mcpToken: "test-mcp-token",
    limits: input.limits,
    openSession: createProviderSessionFactory({
      logger,
      createClient: () => ({
        provider: "claude",
        capabilities: CONTROLLED_SESSION_CAPABILITIES,
        async createSession(config, launchContext) {
          launchSeen.push(launchContext);
          const session = new ControlledSession(config);
          hosted.push(session);
          return session;
        },
        async resumeSession(handle, overrides, launchContext) {
          launchSeen.push(launchContext);
          const session = new ControlledSession({ provider: "claude", cwd: "/", ...overrides }, [
            ...(input.history ?? []),
          ]);
          hosted.push(session);
          return session;
        },
        async fetchCatalog() {
          return { models: [], modes: [] };
        },
        async isAvailable() {
          return true;
        },
      }),
    }),
  });
  cleanups.push(() => host.close());
  const real = createSessionHostConnector({ paths, logger, retryAfterMs: 0 });
  cleanups.push(() => real.close());
  let failing = 0;
  const connector: SessionHostConnector = {
    async connect(options) {
      if (failing > 0) {
        failing -= 1;
        return null;
      }
      return real.connect(options);
    },
    current: () => real.current(),
    close: () => real.close(),
  };
  const { client: inner, local } = localClient();
  const lost: string[] = [];
  let enabled = true;
  const client = createHostedAgentClient({
    inner,
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: "/accounts/one" } },
    routing: {
      connector,
      isEnabled: () => enabled,
      logger,
      reattach: { windowMs: 1_500, initialDelayMs: 20, maxDelayMs: 200 },
      onSessionLost: (agentId) => lost.push(agentId),
    },
  });
  return {
    home,
    lost,
    socketPath: paths.socketPath,
    token,
    failConnects(count) {
      failing = count;
    },
    host,
    hosted,
    connector,
    client,
    local,
    launchSeen,
    setEnabled(value) {
      enabled = value;
    },
  };
}

const config: AgentSessionConfig = { provider: "claude", cwd: "/work", model: "claude-haiku" };

function collect(session: AgentSession): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

test("an eligible Claude session runs in the host and mirrors the provider's state", async () => {
  const fixture = await hostedFixture();
  const session = await fixture.client.createSession(config, {
    agentId: "agent-1",
    env: { PASEO_AGENT_ID: "agent-1" },
  });
  expect(session).toBeInstanceOf(HostedAgentSession);
  expect(fixture.local).toEqual([]);
  expect(fixture.launchSeen).toEqual([{ agentId: "agent-1", env: { PASEO_AGENT_ID: "agent-1" } }]);
  const provider = fixture.hosted[0]!;
  const events = collect(session);

  expect(await session.startTurn("long task")).toEqual({ turnId: "turn-1" });
  await expect
    .poll(() => events.map((event) => event.type))
    .toEqual(["thread_started", "turn_started"]);
  expect(session.id).toBe("claude-session-1");
  expect(session.describePersistence()).toMatchObject({ sessionId: "claude-session-1" });
  expect(events[1]).toMatchObject({ type: "turn_started", turnId: "turn-1" });

  const answer = provider.requestPermission("perm-1");
  await expect.poll(() => events.at(-1)?.type).toBe("permission_requested");
  // The worker read during the event already sees the request, as it would in process.
  expect(session.getPendingPermissions().map((request) => request.id)).toEqual(["perm-1"]);
  await session.respondToPermission("perm-1", { behavior: "allow" });
  expect(await answer).toEqual({ behavior: "allow" });
  expect(session.getPendingPermissions()).toEqual([]);

  await session.setMode("plan");
  expect(await session.getCurrentMode()).toBe("plan");
  await session.setFeature?.("fast_mode", true);
  expect(session.features).toEqual([
    { type: "toggle", id: "fast_mode", label: "Fast", value: true },
  ]);

  provider.text("done");
  provider.complete();
  await expect.poll(() => events.at(-1)?.type).toBe("turn_completed");
  expect(provider.calls).toEqual(["startTurn:long task"]);
});

test("sessions the host should not run stay in the worker", async () => {
  const fixture = await hostedFixture();
  // Command discovery opens a throwaway session without an agent.
  await fixture.client.createSession(config);
  await fixture.client.createSession(config, { agentId: "agent-2" }, { persistSession: false });
  await fixture.client.createSession({ ...config, internal: true }, { agentId: "agent-3" });
  await fixture.client.resumeSession(
    { provider: "claude", sessionId: "s", metadata: { cwd: "/work" } },
    undefined,
    { agentId: "agent-4" },
    { purpose: "history" },
  );
  fixture.setEnabled(false);
  await fixture.client.createSession(config, { agentId: "agent-5" });
  expect(fixture.hosted).toEqual([]);
  expect(fixture.local).toHaveLength(5);
});

test("an unavailable host leaves the session in the worker", async () => {
  const fixture = await hostedFixture();
  await fixture.host.close();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  expect(session).not.toBeInstanceOf(HostedAgentSession);
  expect(fixture.local).toHaveLength(1);
});

test("opening a session the host still runs takes it over instead of starting another", async () => {
  const fixture = await hostedFixture();
  const first = await fixture.client.createSession(config, { agentId: "agent-1" });
  // A second worker, as after a restart, on its own connection to the same host.
  const otherConnector = createSessionHostConnector({
    paths: sessionHostPaths(fixture.home),
    logger,
    retryAfterMs: 0,
  });
  cleanups.push(() => otherConnector.close());
  const otherWorker = createHostedAgentClient({
    inner: localClient().client,
    routing: { connector: otherConnector, isEnabled: () => true, logger },
  });
  const second = await otherWorker.createSession(config, { agentId: "agent-1" });
  expect(second).toBeInstanceOf(HostedAgentSession);
  expect(fixture.hosted).toHaveLength(1);
  expect(fixture.local).toEqual([]);
  await expect.poll(() => (first as HostedAgentSession).hostedStatus).toBe("fenced");
  expect((second as HostedAgentSession).isDurablyHosted()).toBe(true);
});

test("a dropped connection reattaches and the turn keeps going without a failure", async () => {
  const fixture = await hostedFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  const provider = fixture.hosted[0]!;
  const events = collect(session);
  await session.startTurn("long task");
  provider.text("before");
  await expect.poll(() => events.length).toBe(3);

  fixture.connector.current()?.close();
  provider.text("while reconnecting");
  provider.text("after");
  await expect.poll(() => events.length).toBe(5);
  provider.complete();
  await expect.poll(() => events.at(-1)?.type).toBe("turn_completed");
  expect(events.map((event) => event.type)).not.toContain("turn_failed");
  expect(
    events.flatMap((event) =>
      event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
    ),
  ).toEqual(["before", "while reconnecting", "after"]);
});

test("losing the host cancels the turn once, hands off to the fallback and goes stale", async () => {
  const fixture = await hostedFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  const events = collect(session);
  await session.startTurn("long task");
  await expect.poll(() => events.length).toBe(2);
  await fixture.host.close();
  // The worker keeps trying for its reattach window before it gives the turn up.
  await expect
    .poll(() => events.at(-1), { timeout: 5_000 })
    .toMatchObject({ type: "turn_canceled", turnId: "turn-1" });
  expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(1);
  expect(events.map((event) => event.type)).not.toContain("turn_failed");
  expect(fixture.lost).toEqual(["agent-1"]);
  // A stale session makes the prompt path reopen the agent on a fresh session.
  await expect(session.startTurn("again")).rejects.toBeInstanceOf(StaleProviderSessionError);
  expect(session.isDurablyHosted?.()).toBe(false);
  await session.interrupt();
  await session.close();
});

test("a resumed session pages its saved history once", async () => {
  const history: AgentStreamEvent[] = Array.from({ length: 30 }, (_, index) => ({
    type: "timeline",
    provider: "claude",
    item: { type: "assistant_message", text: `${index}:${"h".repeat(200 * 1024)}` },
  }));
  const fixture = await hostedFixture({ history });
  const session = await fixture.client.resumeSession(
    { provider: "claude", sessionId: "claude-session-1", metadata: { cwd: "/work" } },
    { model: "claude-haiku" },
    { agentId: "agent-1" },
  );
  const seen: string[] = [];
  for await (const event of session.streamHistory())
    if (event.type === "timeline" && event.item.type === "assistant_message")
      seen.push(event.item.text.split(":")[0]!);
  expect(seen).toEqual(history.map((_, index) => String(index)));
  const again: AgentStreamEvent[] = [];
  for await (const event of session.streamHistory()) again.push(event);
  expect(again).toEqual([]);
});

test("usage plugins get a worker-built environment and closed sessions report none", async () => {
  const fixture = await hostedFixture();
  const session = await fixture.client.createSession(config, {
    agentId: "agent-1",
    env: { PASEO_AGENT_ID: "agent-1" },
  });
  const usage = session.usageSession?.();
  expect(usage).toMatchObject({ provider: "claude", model: "claude-haiku" });
  expect(usage?.env.CLAUDE_CONFIG_DIR).toBe("/accounts/one");
  expect(usage?.env.PASEO_AGENT_ID).toBe("agent-1");
  // Surfaces that need trusted in-process callbacks are absent rather than half-supported.
  expect(session.goals).toBeUndefined();
  expect(session.setQuotaAdmissionGuard).toBeUndefined();
  expect(session.tryHandleOutOfBand).toBeUndefined();
  await session.close();
  expect(session.usageSession?.()).toBeNull();
  expect(fixture.hosted[0]!.closed).toBe(true);
});

test("the durable sessions setting is off unless its file enables it", () => {
  const home = mkdtempSync(join(tmpdir(), "settings-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  expect(readDurableSessionsSettings(home)).toEqual({ enabled: false });
  writeFileSync(durableSessionsSettingsPath(home), '{"enabled": true}');
  expect(readDurableSessionsSettings(home)).toEqual({ enabled: true });
  writeFileSync(durableSessionsSettingsPath(home), '{"enabled": "yes"}');
  expect(readDurableSessionsSettings(home)).toMatchObject({ enabled: false });
  writeFileSync(durableSessionsSettingsPath(home), "{not json");
  expect(readDurableSessionsSettings(home)).toMatchObject({ enabled: false });
});

test("a reconnect that fails at first keeps trying and the turn still completes", async () => {
  const fixture = await hostedFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  const provider = fixture.hosted[0]!;
  const events = collect(session);
  await session.startTurn("long task");
  provider.text("before");
  await expect.poll(() => events.length).toBe(3);

  // The host is slow to answer twice, as under heavy load, then accepts the reattach.
  fixture.failConnects(2);
  fixture.connector.current()?.close();
  provider.text("during the outage");
  provider.complete();
  await expect.poll(() => events.at(-1)?.type).toBe("turn_completed");
  expect(events.map((event) => event.type)).not.toContain("turn_failed");
  expect(
    events.flatMap((event) =>
      event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
    ),
  ).toEqual(["before", "during the outage"]);
});

test("a fenced session settles its turn without touching the provider", async () => {
  const fixture = await hostedFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  const provider = fixture.hosted[0]!;
  const events = collect(session);
  await session.startTurn("long task");
  await expect.poll(() => events.length).toBe(2);

  const newer = await connectSessionHost({ socketPath: fixture.socketPath, token: fixture.token });
  cleanups.push(() => newer.close());
  await newer.attach({ sessionId: "agent-1", afterSeq: null });
  await expect
    .poll(() => events.at(-1))
    .toMatchObject({
      type: "turn_canceled",
      reason: "Another worker took over this session.",
      turnId: "turn-1",
    });
  await expect(session.startTurn("again")).rejects.toBeInstanceOf(HostedSessionUnavailableError);
  expect(provider.calls).toEqual(["startTurn:long task"]);
});

test("events the host could not deliver produce one notice per attachment", async () => {
  const fixture = await hostedFixture({ limits: { maxFrameBytes: 16 * 1024 } });
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  const provider = fixture.hosted[0]!;
  const events = collect(session);
  await session.startTurn("long task");
  provider.text("x".repeat(32 * 1024));
  provider.text("y".repeat(32 * 1024));
  provider.text("after");
  await expect.poll(() => events.at(-1)).toMatchObject({ item: { text: "after" } });
  const notices = events.filter(
    (event) => event.type === "timeline" && event.item.type === "notification",
  );
  expect(notices).toHaveLength(1);
});

test("a hosted provider calls the agent tool endpoint with the host's token", async () => {
  const fixture = await hostedFixture();
  await fixture.client.createSession(
    {
      ...config,
      mcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:7777/mcp/agents?callerAgentId=agent-1",
          headers: { Authorization: "Bearer worker-run-token" },
        },
      },
    },
    { agentId: "agent-1" },
  );
  expect(fixture.hosted[0]!.config.mcpServers?.paseo).toMatchObject({
    headers: { Authorization: "Bearer test-mcp-token" },
  });
});
