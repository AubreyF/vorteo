import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class FakeSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();

  constructor(
    readonly provider: AgentProvider,
    private readonly history: AgentTimelineItem[],
  ) {}

  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn() {
    return { turnId: randomUUID() };
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const item of this.history) yield { type: "timeline", provider: this.provider, item };
  }

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class FakeClient implements AgentClient {
  readonly capabilities = CAPABILITIES;
  readonly created: AgentSessionConfig[] = [];
  readonly resumed: AgentPersistenceHandle[] = [];
  history: AgentTimelineItem[] = [];

  constructor(readonly provider: AgentProvider) {}

  async isAvailable() {
    return true;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.created.push(config);
    return new FakeSession(this.provider, []);
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    this.resumed.push(handle);
    return new FakeSession(this.provider, this.history);
  }
}

async function fixture() {
  const workdir = mkdtempSync(join(tmpdir(), "profile-switch-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  await storage.initialize();
  const codex = new FakeClient("codex");
  const claude = new FakeClient("claude");
  const manager = new AgentManager({ clients: { codex, claude }, registry: storage, logger });
  return {
    workdir,
    storage,
    codex,
    claude,
    manager,
    cleanup: () => rmSync(workdir, { recursive: true, force: true }),
  };
}

test("a switch keeps the thread, carries recorded context and replays every segment", async () => {
  const { workdir, storage, codex, claude, manager, cleanup } = await fixture();
  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, quotaPausedAt: "2026-10-22T00:00:00.000Z" },
      undefined,
      { workspaceId: undefined },
    );
    await manager.appendTimelineItem(agent.id, { type: "user_message", text: "fix the parser" });
    await manager.appendTimelineItem(agent.id, {
      type: "assistant_message",
      text: "parser fixed on codex",
    });

    const context = await manager.readSwitchContext(agent.id);
    expect(context).toBe(
      "user_message:\nfix the parser\n\nassistant_message:\nparser fixed on codex",
    );
    const switched = await manager.switchAgentProfile(agent.id, {
      config: { provider: "claude", cwd: workdir, systemPrompt: `carried: ${context}` },
      reason: "quota",
      carriedContextChars: context.length,
    });

    expect(switched.id).toBe(agent.id);
    expect(switched.provider).toBe("claude");
    expect(switched.config.quotaPausedAt).toBeUndefined();
    expect(claude.created.at(-1)?.systemPrompt).toContain("parser fixed on codex");
    const marker = (await manager.getTimelineRows(agent.id)).at(-1)?.item;
    expect(marker).toMatchObject({
      type: "profile_switch",
      reason: "quota",
      from: { provider: "codex" },
      to: { provider: "claude" },
      carriedContextChars: context.length,
    });
    await manager.flush();
    const record = await storage.get(agent.id);
    expect(record?.provider).toBe("claude");
    expect(record?.persistence?.provider).toBe("claude");
    expect(record?.profileSwitches?.map((entry) => entry.marker)).toEqual([marker]);

    // A reload replays retained history first, then only the new account's session.
    claude.history = [
      { type: "user_message", text: "continue" },
      { type: "assistant_message", text: "continued on claude" },
    ];
    await manager.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
    await manager.hydrateTimelineFromProvider(agent.id);
    expect(claude.resumed.at(-1)?.provider).toBe("claude");
    expect(codex.resumed).toEqual([]);
    expect((await manager.getTimelineRows(agent.id)).map((row) => row.item)).toEqual([
      { type: "user_message", text: "fix the parser" },
      { type: "assistant_message", text: "parser fixed on codex" },
      marker,
      { type: "user_message", text: "continue" },
      { type: "assistant_message", text: "continued on claude" },
    ]);
  } finally {
    await manager.flush();
    cleanup();
  }
});

test("a switch refuses while permission requests are pending", async () => {
  const { workdir, manager, cleanup } = await fixture();
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    manager.getAgent(agent.id)?.pendingPermissions.set("permission", {
      id: "permission",
      provider: "codex",
      name: "Bash",
      kind: "tool",
    });
    await expect(
      manager.switchAgentProfile(agent.id, {
        config: { provider: "claude", cwd: workdir },
        reason: "manual",
        carriedContextChars: 0,
      }),
    ).rejects.toThrow("Wait for the current turn");
  } finally {
    await manager.flush();
    cleanup();
  }
});

test("a thread whose retained history is missing still loads with its switch marker", async () => {
  const { workdir, claude, manager, cleanup } = await fixture();
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.appendTimelineItem(agent.id, { type: "user_message", text: "earlier" });
    await manager.switchAgentProfile(agent.id, {
      config: { provider: "claude", cwd: workdir },
      reason: "manual",
      carriedContextChars: 0,
    });
    const marker = (await manager.getTimelineRows(agent.id)).at(-1)?.item;
    await manager.flush();
    rmSync(join(workdir, "agent-switch-history"), { recursive: true, force: true });

    claude.history = [{ type: "assistant_message", text: "later" }];
    await manager.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
    await manager.hydrateTimelineFromProvider(agent.id);
    expect((await manager.getTimelineRows(agent.id)).map((row) => row.item)).toEqual([
      marker,
      { type: "assistant_message", text: "later" },
    ]);
  } finally {
    await manager.flush();
    cleanup();
  }
});
