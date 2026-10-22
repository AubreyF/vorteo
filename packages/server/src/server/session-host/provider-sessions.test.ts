import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import { ControlledSession } from "../test-utils/controlled-provider-session.js";
import { createProviderSessionFactory, type HostedClientFactory } from "./provider-sessions.js";
import { isToolRelayServer } from "./tool-relay-config.js";
import { createToolRelay, toolRelaySocketPath } from "./tool-relay.js";

const logger = pino({ level: "silent" });
const DIRECT = {
  type: "http" as const,
  url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
  headers: { Authorization: "Bearer host-token" },
};
const OTHER = { type: "stdio" as const, command: "npx", args: ["other-server"] };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanups.splice(0).toReversed()) await step();
});

/** A provider client that records the config and handle each session was opened with. */
function recordingClient(): { client: AgentClient; opened: unknown[] } {
  const opened: unknown[] = [];
  const client = {
    provider: "claude",
    capabilities: {},
    async createSession(config: AgentSessionConfig) {
      opened.push({ config });
      return new ControlledSession(config, [], { provider: "claude" });
    },
    async resumeSession(handle: AgentPersistenceHandle, overrides?: Partial<AgentSessionConfig>) {
      opened.push({ handle, overrides });
      return new ControlledSession(
        { ...(handle.metadata as AgentSessionConfig), ...overrides },
        [],
        { provider: "claude" },
      );
    },
  } as unknown as AgentClient;
  return { client, opened };
}

function factoryWith(createClient: HostedClientFactory, directory: string) {
  const toolRelay = createToolRelay({ directory, token: "host-token", logger });
  cleanups.push(() => toolRelay.closeAll());
  return {
    toolRelay,
    open: createProviderSessionFactory({ logger, createClient, toolRelay }),
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "provider-sessions-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("a created session gets the relay in place of the direct server, and closing it ends the relay", async () => {
  const directory = tempDirectory();
  const { client, opened } = recordingClient();
  const { toolRelay, open } = factoryWith(() => client, directory);
  const port = await open({
    sessionId: "session-1",
    provider: "claude",
    config: {
      kind: "create",
      agentId: "agent-1",
      config: { provider: "claude", cwd: "/tmp/work", mcpServers: { paseo: DIRECT, other: OTHER } },
    },
  });
  const [first] = opened as { config: AgentSessionConfig }[];
  const paseo = first!.config.mcpServers!.paseo!;
  expect(isToolRelayServer(paseo)).toBe(true);
  expect(paseo.type === "stdio" && paseo.args?.[2]).toBe(
    toolRelaySocketPath(directory, "session-1"),
  );
  expect(first!.config.mcpServers!.other).toEqual(OTHER);
  expect(toolRelay.sessionCount()).toBe(1);
  expect(existsSync(toolRelaySocketPath(directory, "session-1"))).toBe(true);
  await port.close();
  expect(toolRelay.sessionCount()).toBe(0);
  expect(existsSync(toolRelaySocketPath(directory, "session-1"))).toBe(false);
});

test("a resumed session gets the relay in its overrides, and a stale relay in the handle is dropped", async () => {
  const directory = tempDirectory();
  const { client, opened } = recordingClient();
  const { open } = factoryWith(() => client, directory);
  const stale = {
    type: "stdio" as const,
    command: "/old/node",
    args: ["/old/dist/scripts/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/old/tools/x.sock"],
  };
  await open({
    sessionId: "session-2",
    provider: "claude",
    config: {
      kind: "resume",
      agentId: "agent-2",
      config: { provider: "claude", cwd: "/tmp/work" },
      handle: {
        provider: "claude",
        sessionId: "claude-session",
        metadata: { cwd: "/tmp/work", mcpServers: { paseo: stale, other: OTHER } },
      },
      overrides: { mcpServers: { paseo: DIRECT, other: OTHER } },
    },
  });
  const [resumed] = opened as {
    handle: AgentPersistenceHandle;
    overrides: Partial<AgentSessionConfig>;
  }[];
  expect((resumed!.handle.metadata as AgentSessionConfig).mcpServers).toEqual({ other: OTHER });
  expect(isToolRelayServer(resumed!.overrides.mcpServers!.paseo!)).toBe(true);
  expect(resumed!.overrides.mcpServers!.other).toEqual(OTHER);
});

test("without the direct server nothing is relayed, and a failed open leaves no relay behind", async () => {
  const directory = tempDirectory();
  const { client, opened } = recordingClient();
  const { toolRelay, open } = factoryWith(() => client, directory);
  await open({
    sessionId: "session-3",
    provider: "claude",
    config: {
      kind: "create",
      agentId: "agent-3",
      config: { provider: "claude", cwd: "/tmp/work", mcpServers: { other: OTHER } },
    },
  });
  expect((opened[0] as { config: AgentSessionConfig }).config.mcpServers).toEqual({ other: OTHER });
  expect(toolRelay.sessionCount()).toBe(0);

  const failing = createProviderSessionFactory({
    logger,
    createClient: () =>
      ({
        async createSession() {
          throw new Error("provider down");
        },
      }) as unknown as AgentClient,
    toolRelay,
  });
  await expect(
    failing({
      sessionId: "session-4",
      provider: "claude",
      config: {
        kind: "create",
        agentId: "agent-4",
        config: { provider: "claude", cwd: "/tmp/work", mcpServers: { paseo: DIRECT } },
      },
    }),
  ).rejects.toThrow("provider down");
  expect(toolRelay.sessionCount()).toBe(0);
  expect(existsSync(toolRelaySocketPath(directory, "session-4"))).toBe(false);
});
