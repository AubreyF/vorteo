import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import { AgentManager } from "../agent/agent-manager.js";
import type { AgentClient } from "../agent/agent-sdk-types.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createSessionHostConnector } from "./connector.js";
import { createHostedAgentClient } from "./hosted-agent-client.js";
import { HostedAgentSession } from "./hosted-agent-session.js";
import { rotateSessionHostToken, sessionHostPaths } from "./host-files.js";
import { startSessionHost } from "./host.js";
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

/** A worker AgentManager whose Claude client routes through an in-process session host. */
async function hostedManager(input: { enabled: boolean }) {
  const home = scratch("hosted-manager-");
  const paths = sessionHostPaths(home);
  const token = await rotateSessionHostToken(paths);
  let hostedOpens = 0;
  const host = await startSessionHost({
    socketPath: paths.socketPath,
    token,
    mcpToken: "test-mcp-token",
    openSession: createProviderSessionFactory({
      logger,
      createClient: () => {
        hostedOpens += 1;
        return createTestAgentClient("claude");
      },
    }),
  });
  cleanups.push(() => host.close());
  const connector = createSessionHostConnector({ paths, logger, retryAfterMs: 0 });
  cleanups.push(() => connector.close());
  const claude: AgentClient = createHostedAgentClient({
    inner: createTestAgentClient("claude"),
    routing: { connector, isEnabled: () => input.enabled, logger },
  });
  const manager = new AgentManager({ clients: { claude }, logger });
  return { manager, hostedOpens: () => hostedOpens };
}

async function runTurn(manager: AgentManager, agentId: string, prompt: string): Promise<void> {
  for await (const _event of manager.streamAgent(agentId, prompt)) {
    // Draining the stream waits for the turn to finish.
  }
}

test("with the setting on, a Claude agent's turn runs in the session host end to end", async () => {
  const fixture = await hostedManager({ enabled: true });
  const workdir = scratch("hosted-work-");
  const agent = await fixture.manager.createAgent({ provider: "claude", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  try {
    expect(fixture.manager.getAgent(agent.id)?.session).toBeDefined();
    await runTurn(fixture.manager, agent.id, "hello from the worker");
    expect(fixture.hostedOpens()).toBe(1);
    const snapshot = fixture.manager.getAgent(agent.id);
    expect(snapshot?.lifecycle).toBe("idle");
    expect(snapshot?.persistence?.sessionId).toEqual(expect.any(String));
    const timeline = fixture.manager.getTimeline(agent.id);
    expect(timeline).toContainEqual(expect.objectContaining({ type: "assistant_message" }));
    expect(timeline.some((item) => item.type === "error")).toBe(false);
  } finally {
    await fixture.manager.closeAgent(agent.id).catch(() => undefined);
  }
});

test("with the setting off, the same agent runs in the worker as before", async () => {
  const fixture = await hostedManager({ enabled: false });
  const workdir = scratch("local-work-");
  const agent = await fixture.manager.createAgent({ provider: "claude", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  try {
    await runTurn(fixture.manager, agent.id, "hello from the worker");
    expect(fixture.hostedOpens()).toBe(0);
    expect(fixture.manager.getAgent(agent.id)?.session).not.toBeInstanceOf(HostedAgentSession);
    expect(fixture.manager.getTimeline(agent.id)).toContainEqual(
      expect.objectContaining({ type: "assistant_message" }),
    );
  } finally {
    await fixture.manager.closeAgent(agent.id).catch(() => undefined);
  }
});
