import { expect, test } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { claudeProjectDirSync } from "../providers/claude/project-dir.js";
import { switchAgentProfileCommand } from "./command.js";
import { MessageQueueService } from "../../message-queue/service.js";
import { MessageQueueStore } from "../../message-queue/store.js";
import { QueueAttachmentStore } from "../../message-queue/attachments.js";
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
  createError: Error | null = null;

  constructor(readonly provider: AgentProvider) {}

  async isAvailable() {
    return true;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    if (this.createError) throw this.createError;
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

test("an unloaded thread switches without the previous provider and retains its history", async () => {
  const { workdir, storage, manager, claude, cleanup } = await fixture();
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: "original-workspace",
      labels: { purpose: "recovery" },
    });
    await manager.closeAgent(agent.id);
    const record = await storage.get(agent.id);
    if (!record) throw new Error("Missing source record");
    const reader = new AgentManager({
      clients: { claude },
      registry: storage,
      logger: createTestLogger(),
    });
    const rows = [
      {
        seq: 1,
        timestamp: record.createdAt,
        item: { type: "user_message" as const, text: "Keep the existing plan" },
      },
    ];
    const switched = await reader.switchAgentProfile(agent.id, {
      config: { provider: "claude", cwd: workdir },
      reason: "manual",
      carriedContextChars: 22,
      storedSource: { record, rows },
    });
    expect(switched).toMatchObject({
      id: agent.id,
      provider: "claude",
      workspaceId: "original-workspace",
      labels: { purpose: "recovery" },
    });
    expect((await reader.getTimelineRows(agent.id)).map((row) => row.item)).toEqual([
      rows[0].item,
      expect.objectContaining({
        type: "profile_switch",
        from: expect.objectContaining({ provider: "codex" }),
      }),
    ]);
    await reader.flush();
    await reader.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
    await reader.hydrateTimelineFromProvider(agent.id);
    expect((await reader.getTimelineRows(agent.id))[0]?.item).toEqual(rows[0].item);
    await reader.closeAgent(agent.id);
  } finally {
    await manager.flush();
    cleanup();
  }
});

test.each([false, true])(
  "recovery reads a disabled Claude account transcript (removed: %s)",
  async (removed) => {
    const { workdir, storage, codex, cleanup, manager } = await fixture();
    const configDir = join(workdir, "old-claude-account");
    const transcriptDir = claudeProjectDirSync(workdir, { configDir });
    mkdirSync(transcriptDir, { recursive: true });
    const sessionId = randomUUID();
    const userMessageId = randomUUID();
    writeFileSync(
      join(transcriptDir, `${sessionId}.jsonl`),
      [
        {
          type: "user",
          uuid: userMessageId,
          sessionId,
          cwd: workdir,
          message: { role: "user", content: "Preserve my approved plan" },
        },
        {
          type: "assistant",
          uuid: randomUUID(),
          sessionId,
          cwd: workdir,
          message: { role: "assistant", content: "The next step is validation" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const provider = "claude-retired";
    const snapshots = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        [provider]: {
          extends: "claude",
          label: "Retired account",
          enabled: false,
          removed,
          env: { CLAUDE_CONFIG_DIR: configDir },
        },
      },
      extraClients: { codex },
    });
    const reader = new AgentManager({
      clients: { codex },
      registry: storage,
      logger: createTestLogger(),
    });
    try {
      expect(snapshots.listRegisteredProviderIds({ enabledOnly: true })).not.toContain(provider);
      const id = randomUUID();
      const now = new Date().toISOString();
      await storage.upsert({
        id,
        provider,
        cwd: workdir,
        workspaceId: "retained-workspace",
        title: "Original task",
        labels: {},
        createdAt: now,
        updatedAt: now,
        lastStatus: "closed",
        config: null,
        persistence: { provider, sessionId, metadata: { cwd: workdir } },
        tasks: [
          { id: "task", text: "Validate", completed: false, source: "vorteo", status: "pending" },
        ],
        journal: [{ id: randomUUID(), sequence: 1, timestamp: now, text: "Approved scope" }],
      });
      const queueRoot = join(workdir, "queue");
      const queueStore = new MessageQueueStore(queueRoot);
      await queueStore.mutate(id, {
        kind: "enqueue",
        operationId: "enqueue",
        messageId: "pending",
        text: "Preserve my approved plan",
        attachments: [],
      });
      await queueStore.claim(id);
      await queueStore.recordProviderMessageId({
        agentId: id,
        messageId: "pending",
        providerMessageId: userMessageId,
      });
      const queue = new MessageQueueService(queueStore, new QueueAttachmentStore(queueRoot));
      // Cover both an uninitialized delivery and a recovered uncertain delivery.
      if (removed) await queue.read(id);
      let queueChanges = 0;
      queue.subscribe(id, () => queueChanges++);
      reader.setMessageQueueControl(queue);
      const queueBefore = await queueStore.read(id);
      const queueFilesBefore = readdirSync(queueRoot).map((file) =>
        readFileSync(join(queueRoot, file), "utf8"),
      );
      const before = await storage.get(id);
      if (!before?.persistence) throw new Error("Missing saved thread");
      const loadHistory = () =>
        reader.readStoredSwitchHistory(
          before,
          snapshots.readSessionHistory(before.persistence!, { provider, cwd: workdir }),
        );
      const tail = await reader.fetchSavedTimeline(id, { limit: 1 }, loadHistory);
      expect(tail.rows.map((row) => row.item)).toMatchObject([
        { type: "assistant_message", text: "The next step is validation" },
      ]);
      const older = await reader.fetchSavedTimeline(
        id,
        {
          direction: "before",
          cursor: { epoch: tail.epoch, seq: tail.startSeq! },
          limit: 1,
        },
        loadHistory,
      );
      expect(older.epoch).toBe(tail.epoch);
      expect(older.staleCursor).toBe(false);
      expect(older.rows.map((row) => row.item)).toMatchObject([
        { type: "user_message", text: "Preserve my approved plan" },
      ]);
      expect(reader.getAgent(id)).toBeNull();
      expect(await storage.get(id)).toEqual(before);
      expect(codex.created).toHaveLength(0);
      expect(codex.resumed).toHaveLength(0);
      expect(queueChanges).toBe(0);
      expect(await queueStore.read(id)).toEqual(queueBefore);
      expect(
        readdirSync(queueRoot).map((file) => readFileSync(join(queueRoot, file), "utf8")),
      ).toEqual(queueFilesBefore);
      appendFileSync(
        join(transcriptDir, `${sessionId}.jsonl`),
        "\n" +
          JSON.stringify({
            type: "assistant",
            uuid: randomUUID(),
            sessionId,
            cwd: workdir,
            message: { role: "assistant", content: "New saved result" },
          }),
      );
      const changed = await reader.fetchSavedTimeline(
        id,
        {
          direction: "before",
          cursor: { epoch: tail.epoch, seq: tail.startSeq! },
          limit: 1,
        },
        loadHistory,
      );
      expect(changed.epoch).not.toBe(tail.epoch);
      expect(changed.staleCursor).toBe(true);
      expect(changed.reset).toBe(true);
      expect(changed.rows.map((row) => row.item)).toMatchObject([
        { type: "assistant_message", text: "New saved result" },
      ]);
      expect(queueChanges).toBe(0);
      expect(await queueStore.read(id)).toEqual(queueBefore);
      // Positive control: these same rows really can reconcile the uncertain message.
      await queue.read(id);
      const reconciliation = await queueStore.reconcileHistory(
        id,
        (await loadHistory()).map((row) => ({
          type: "timeline",
          provider,
          item: row.item,
          timestamp: row.timestamp,
        })),
      );
      expect(reconciliation.changed).toBe(true);
      codex.createError = new Error("Replacement failed");
      await expect(
        switchAgentProfileCommand(
          {
            agentManager: reader,
            agentStorage: storage,
            providerSnapshotManager: snapshots,
            logger: createTestLogger(),
          },
          { agentId: id, provider: "codex" },
        ),
      ).rejects.toThrow("Replacement failed");
      expect(await storage.get(id)).toEqual(before);
      codex.createError = null;
      await switchAgentProfileCommand(
        {
          agentManager: reader,
          agentStorage: storage,
          providerSnapshotManager: snapshots,
          logger: createTestLogger(),
        },
        { agentId: id, provider: "codex" },
      );
      expect(codex.created.at(-1)?.systemPrompt).toContain("Preserve my approved plan");
      expect(codex.created.at(-1)?.systemPrompt).toContain("The next step is validation");
      expect(reader.getAgent(id)).toMatchObject({
        workspaceId: "retained-workspace",
        tasks: before?.tasks,
        journal: before?.journal,
      });
      expect(await storage.get(id)).toMatchObject({
        title: "Original task",
        provider: "codex",
        tasks: before?.tasks,
        journal: before?.journal,
      });
      expect(
        (await snapshots.listProviders()).find((entry) => entry.provider === provider)?.enabled,
      ).not.toBe(true);
      await reader.closeAgent(id);
    } finally {
      await snapshots.shutdown();
      await manager.flush();
      cleanup();
    }
  },
);

test("recovery refuses a stale source and unreadable transcript without changing the thread", async () => {
  const { workdir, storage, manager, claude, cleanup } = await fixture();
  const reader = new AgentManager({
    clients: { claude },
    registry: storage,
    logger: createTestLogger(),
  });
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.closeAgent(agent.id);
    const record = await storage.get(agent.id);
    if (!record) throw new Error("Missing record");
    await expect(reader.readStoredSwitchHistory(record, (async function* () {})())).rejects.toThrow(
      "transcript could not be read",
    );
    await storage.setTitle(agent.id, "Changed while selecting");
    await expect(
      reader.switchAgentProfile(agent.id, {
        config: { provider: "claude", cwd: workdir },
        reason: "manual",
        carriedContextChars: 0,
        storedSource: { record, rows: [] },
      }),
    ).rejects.toThrow("thread changed");
    expect(claude.created).toHaveLength(0);
    expect((await storage.get(agent.id))?.provider).toBe("codex");
  } finally {
    await manager.flush();
    cleanup();
  }
});

test.each(["opencode", "opencode-retired"])(
  "refuses unsafe native history for %s before creating a client",
  async (provider) => {
    const snapshots = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "opencode-retired": {
          extends: "opencode",
          label: "Retired OpenCode",
          enabled: false,
          removed: true,
        },
      },
    });
    try {
      const history = snapshots.readSessionHistory(
        { provider, sessionId: "must-not-resume" },
        { provider, cwd: "/nonexistent-history-reader" },
      );
      await expect(history.next()).rejects.toThrow("Saved OpenCode history cannot be read safely");
    } finally {
      await snapshots.shutdown();
    }
  },
);
