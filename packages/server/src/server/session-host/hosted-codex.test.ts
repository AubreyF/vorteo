import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type {
  AgentClient,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import {
  CONTROLLED_SESSION_CAPABILITIES,
  ControlledSession,
} from "../test-utils/controlled-provider-session.js";
import { createSessionHostConnector } from "./connector.js";
import { createHostedAgentClient } from "./hosted-agent-client.js";
import { HostedAgentSession } from "./hosted-agent-session.js";
import { rotateSessionHostToken, sessionHostPaths } from "./host-files.js";
import { startSessionHost } from "./host.js";
import { createProviderSessionFactory, type HostedClientFactory } from "./provider-sessions.js";

const logger = pino({ level: "silent" });
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const CUSTOM_PROVIDER = { id: "codex-account-1", label: "Codex 1", extends: "codex" };
const config: AgentSessionConfig = { provider: "codex", cwd: "/work", model: "gpt-5.4" };

/**
 * A host whose client factory builds Codex-shaped sessions (goals on, /goal and /compact handled)
 * and records what the worker asked it to build.
 */
async function codexFixture() {
  const home = mkdtempSync(join(tmpdir(), "hosted-codex-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = sessionHostPaths(home);
  const token = await rotateSessionHostToken(paths);
  const hosted: ControlledSession[] = [];
  const factoryInputs: Parameters<HostedClientFactory>[0][] = [];
  const host = await startSessionHost({
    socketPath: paths.socketPath,
    token,
    mcpToken: "test-mcp-token",
    openSession: createProviderSessionFactory({
      logger,
      createClient: (input) => {
        factoryInputs.push(input);
        return {
          provider: "codex",
          capabilities: CONTROLLED_SESSION_CAPABILITIES,
          async createSession(sessionConfig) {
            const session = new ControlledSession(sessionConfig, [], {
              provider: "codex",
              goals: true,
            });
            hosted.push(session);
            return session;
          },
          async resumeSession(_handle, overrides) {
            const session = new ControlledSession(
              { provider: "codex", cwd: "/", ...overrides },
              [],
              {
                provider: "codex",
                goals: true,
              },
            );
            hosted.push(session);
            return session;
          },
          async fetchCatalog() {
            return { models: [], modes: [] };
          },
          async isAvailable() {
            return true;
          },
        };
      },
    }),
  });
  cleanups.push(() => host.close());
  const connector = createSessionHostConnector({ paths, logger, retryAfterMs: 0 });
  cleanups.push(() => connector.close());
  const local: ControlledSession[] = [];
  const inner: AgentClient = {
    provider: "codex",
    capabilities: CONTROLLED_SESSION_CAPABILITIES,
    async createSession(sessionConfig) {
      const session = new ControlledSession(sessionConfig, [], { provider: "codex" });
      local.push(session);
      return session;
    },
    async resumeSession(_handle, overrides) {
      const session = new ControlledSession({ provider: "codex", cwd: "/", ...overrides }, [], {
        provider: "codex",
      });
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
  const client = createHostedAgentClient({
    inner,
    runtimeSettings: { env: { CODEX_HOME: "/accounts/codex-1" } },
    customProvider: CUSTOM_PROVIDER,
    routing: { connector, isEnabled: () => true, logger },
  });
  return { client, hosted, local, factoryInputs };
}

test("a Codex session is hosted with its account descriptor and reports its own capabilities", async () => {
  const fixture = await codexFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  expect(session).toBeInstanceOf(HostedAgentSession);
  expect(fixture.local).toEqual([]);
  // The host built the same derived client the worker would have, from the open request alone.
  expect(fixture.factoryInputs).toEqual([
    expect.objectContaining({
      provider: "codex",
      customProvider: CUSTOM_PROVIDER,
      runtimeSettings: { env: { CODEX_HOME: "/accounts/codex-1" } },
    }),
  ]);
  // Goal support is a per-session fact the client cannot know; the snapshot carries it.
  expect(session.capabilities.supportsGoals).toBe(true);
  expect(session.goals).toBeDefined();

  // A resume reopens on the same account: the descriptor travels with the resume request too.
  const resumed = await fixture.client.resumeSession(
    {
      provider: "codex",
      sessionId: "thread-1",
      nativeHandle: "thread-1",
      metadata: { cwd: "/work" },
    },
    {},
    { agentId: "agent-2" },
  );
  expect(resumed).toBeInstanceOf(HostedAgentSession);
  expect(fixture.factoryInputs[1]).toEqual(
    expect.objectContaining({ provider: "codex", customProvider: CUSTOM_PROVIDER }),
  );
});

test("goal state and goal writes cross to the hosted provider and the mirror follows", async () => {
  const fixture = await codexFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  expect(session.goals!.state).toMatchObject({ status: "ready", goal: null });

  const set = await session.goals!.set({ objective: "ship durable sessions" } as never);
  expect(set).toMatchObject({ goal: { objective: "ship durable sessions", status: "active" } });
  expect(session.goals!.state).toEqual(set);
  await expect.poll(() => events.some((event) => event.type === "goal_changed")).toBe(true);

  expect(await session.goals!.read()).toEqual(set);
  const cleared = await session.goals!.clear();
  expect(cleared).toMatchObject({ goal: null });
  expect(session.goals!.state).toEqual(cleared);
  // The provider holds the truth.
  expect(fixture.hosted[0]!.goals!.state).toEqual(cleared);
});

test("Codex commands run out of band in the host and their events come back to the worker", async () => {
  const fixture = await codexFixture();
  const session = await fixture.client.createSession(config, { agentId: "agent-1" });
  const provider = fixture.hosted[0]!;

  // Recognition is local and synchronous, as the manager requires.
  expect(session.tryHandleOutOfBand!("plain prompt")).toBeNull();
  expect(session.tryHandleOutOfBand!("/unknown thing")).toBeNull();
  const setGoal = session.tryHandleOutOfBand!("/goal finish the migration");
  expect(setGoal?.intent).toBe("goal");
  expect(session.tryHandleOutOfBand!("/goal pause")?.intent).toBeUndefined();

  const emitted: AgentStreamEvent[] = [];
  await setGoal!.run({ emit: (event) => emitted.push(event) });
  expect(emitted).toEqual([
    expect.objectContaining({
      type: "timeline",
      item: { type: "assistant_message", text: "goal handled" },
    }),
  ]);
  expect(provider.commands).toEqual(["/goal finish the migration"]);
  expect(session.goals!.state).toMatchObject({ goal: { objective: "finish the migration" } });

  const compact = session.tryHandleOutOfBand!("/compact");
  expect(compact).not.toBeNull();
  await compact!.run({ emit: (event) => emitted.push(event) });
  expect(provider.commands).toEqual(["/goal finish the migration", "/compact"]);
  // The turn itself was never started for a command.
  expect(provider.calls).toEqual([]);
});

test("without goal support the hosted session exposes no goals and refuses /goal", async () => {
  const home = mkdtempSync(join(tmpdir(), "hosted-codex-plain-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = sessionHostPaths(home);
  const token = await rotateSessionHostToken(paths);
  const host = await startSessionHost({
    socketPath: paths.socketPath,
    token,
    mcpToken: "test-mcp-token",
    openSession: createProviderSessionFactory({
      logger,
      createClient: () => ({
        provider: "codex",
        capabilities: CONTROLLED_SESSION_CAPABILITIES,
        async createSession(sessionConfig) {
          return new ControlledSession(sessionConfig, [], { provider: "codex" });
        },
        async resumeSession(_handle, overrides) {
          return new ControlledSession({ provider: "codex", cwd: "/", ...overrides }, [], {
            provider: "codex",
          });
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
  const client = createHostedAgentClient({
    inner: {
      provider: "codex",
      capabilities: CONTROLLED_SESSION_CAPABILITIES,
      async createSession(sessionConfig) {
        return new ControlledSession(sessionConfig, [], { provider: "codex" });
      },
      async resumeSession(_handle, overrides) {
        return new ControlledSession({ provider: "codex", cwd: "/", ...overrides });
      },
      async fetchCatalog() {
        return { models: [], modes: [] };
      },
      async isAvailable() {
        return true;
      },
    },
    routing: { connector, isEnabled: () => true, logger },
  });
  const session = await client.createSession(config, { agentId: "agent-1" });
  expect(session).toBeInstanceOf(HostedAgentSession);
  expect(session.goals).toBeUndefined();
  expect(session.capabilities.supportsGoals).toBe(false);
  expect(session.tryHandleOutOfBand!("/goal anything")).toBeNull();
  expect(session.tryHandleOutOfBand!("/compact")).not.toBeNull();
});
