import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentFeature,
  AgentLaunchContext,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { createSessionHostConnector, type SessionHostConnector } from "./connector.js";
import { createHostedAgentClient, HostedSessionConflictError } from "./hosted-agent-client.js";
import { HostedAgentSession, HostedSessionUnavailableError } from "./hosted-agent-session.js";
import { rotateSessionHostToken, sessionHostPaths } from "./host-files.js";
import { startSessionHost, type SessionHost } from "./host.js";
import { createProviderSessionFactory } from "./provider-sessions.js";
import { durableSessionsSettingsPath, readDurableSessionsSettings } from "./settings.js";

const logger = pino({ level: "silent" });
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

/**
 * A provider session whose turn runs until the test ends it, like a long Claude turn. It keeps
 * its state the way the Claude adapter does: updated before each event is emitted.
 */
class ControlledSession implements AgentSession {
  readonly provider = "claude";
  readonly capabilities = CAPABILITIES;
  private sessionId: string | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pending = new Map<
    string,
    { request: AgentPermissionRequest; resolve: (response: AgentPermissionResponse) => void }
  >();
  private turnId: string | null = null;
  private turnOrdinal = 0;
  private mode = "default";
  private fastMode = false;
  readonly calls: string[] = [];
  closed = false;

  constructor(
    readonly config: AgentSessionConfig,
    private readonly history: AgentStreamEvent[] = [],
  ) {}

  get id(): string | null {
    return this.sessionId;
  }

  get features(): AgentFeature[] {
    return [{ type: "toggle", id: "fast_mode", label: "Fast", value: this.fastMode }];
  }

  emit(event: AgentStreamEvent): void {
    const tagged = this.turnId ? { ...event, turnId: this.turnId } : event;
    for (const subscriber of this.subscribers) subscriber(tagged);
  }

  text(text: string): void {
    this.emit({
      type: "timeline",
      provider: "claude",
      item: { type: "assistant_message", text },
    });
  }

  requestPermission(id: string): Promise<AgentPermissionResponse> {
    const request: AgentPermissionRequest = { id, provider: "claude", name: "Bash", kind: "tool" };
    return new Promise((resolve) => {
      this.pending.set(id, { request, resolve });
      this.emit({ type: "permission_requested", provider: "claude", request });
    });
  }

  complete(): void {
    this.emit({ type: "turn_completed", provider: "claude", usage: { outputTokens: 1 } });
    this.turnId = null;
  }

  async run(): Promise<AgentRunResult> {
    throw new Error("Not used");
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.calls.push(`startTurn:${typeof prompt === "string" ? prompt : "blocks"}`);
    if (!this.sessionId) {
      this.sessionId = "claude-session-1";
      this.emit({ type: "thread_started", provider: "claude", sessionId: this.sessionId });
    }
    this.turnId = `turn-${++this.turnOrdinal}`;
    this.emit({ type: "turn_started", provider: "claude" });
    return { turnId: this.turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* this.history.splice(0);
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: "claude", sessionId: this.sessionId, modeId: this.mode };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [{ id: "default", label: "Default" }];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.mode;
  }

  async setMode(modeId: string): Promise<void> {
    this.mode = modeId;
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (featureId === "fast_mode") this.fastMode = value === true;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`No pending permission request with id '${requestId}'`);
    this.pending.delete(requestId);
    entry.resolve(response);
    this.emit({ type: "permission_resolved", provider: "claude", requestId, resolution: response });
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.sessionId
      ? { provider: "claude", sessionId: this.sessionId, nativeHandle: this.sessionId }
      : null;
  }

  async interrupt(): Promise<void> {
    this.calls.push("interrupt");
    if (!this.turnId) return;
    this.emit({ type: "turn_canceled", provider: "claude", reason: "Interrupted" });
    this.turnId = null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Stands in for the local Claude client; it records sessions the worker ran itself. */
function localClient() {
  const local: ControlledSession[] = [];
  const client: AgentClient = {
    provider: "claude",
    capabilities: CAPABILITIES,
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
}

async function hostedFixture(input: { history?: AgentStreamEvent[] } = {}): Promise<HostedFixture> {
  const home = mkdtempSync(join(tmpdir(), "hosted-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = sessionHostPaths(home);
  const token = await rotateSessionHostToken(paths);
  const hosted: ControlledSession[] = [];
  const launchSeen: (AgentLaunchContext | undefined)[] = [];
  const host = await startSessionHost({
    socketPath: paths.socketPath,
    token,
    openSession: createProviderSessionFactory({
      logger,
      createClient: () => ({
        provider: "claude",
        capabilities: CAPABILITIES,
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
  const connector = createSessionHostConnector({ paths, logger, retryAfterMs: 0 });
  cleanups.push(() => connector.close());
  const { client: inner, local } = localClient();
  let enabled = true;
  const client = createHostedAgentClient({
    inner,
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: "/accounts/one" } },
    routing: { connector, isEnabled: () => enabled, logger },
  });
  return {
    home,
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

test("a session the host still runs is never started a second time", async () => {
  const fixture = await hostedFixture();
  await fixture.client.createSession(config, { agentId: "agent-1" });
  await expect(fixture.client.createSession(config, { agentId: "agent-1" })).rejects.toBeInstanceOf(
    HostedSessionConflictError,
  );
  expect(fixture.local).toEqual([]);
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

test("losing the host fails the running turn once and refuses later calls", async () => {
  const fixture = await hostedFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  const events = collect(session);
  await session.startTurn("long task");
  await expect.poll(() => events.length).toBe(2);
  await fixture.host.close();
  await expect
    .poll(() => events.at(-1))
    .toMatchObject({
      type: "turn_failed",
      code: "session_host_lost",
      turnId: "turn-1",
    });
  await expect(session.startTurn("again")).rejects.toBeInstanceOf(HostedSessionUnavailableError);
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
