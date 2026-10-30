import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { promises as fs, type PathLike } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage, parseStoredAgentRecord } from "./agent-storage.js";
import { buildConfigOverrides, buildSessionConfig } from "../persistence-hooks.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "activeForegroundTurnId"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  activeForegroundTurnId?: string | null;
  runtimeInfo?: ManagedAgent["runtimeInfo"];
  attention?: ManagedAgent["attention"];
};

function buildManagedAgentConfig(
  provider: AgentProvider,
  cwd: string,
  configOverrides: Partial<AgentSessionConfig>,
): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider,
    cwd,
    title: configOverrides.title,
    modeId: configOverrides.modeId ?? "plan",
    model: configOverrides.model ?? "gpt-5.1",
    thinkingOptionId: configOverrides.thinkingOptionId,
    providerOptions: configOverrides.providerOptions,
    toolPolicy: configOverrides.toolPolicy,
    systemPrompt: configOverrides.systemPrompt,
    mcpServers: configOverrides.mcpServers,
  };
  if (Object.prototype.hasOwnProperty.call(configOverrides, "featureValues")) {
    config.featureValues = configOverrides.featureValues;
  }
  return config;
}

function buildDefaultCapabilities() {
  return {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  };
}

function buildDefaultRuntimeInfo(params: {
  provider: AgentProvider;
  config: AgentSessionConfig;
  sessionId: string;
}) {
  return {
    provider: params.provider,
    sessionId: params.sessionId,
    model: params.config.model ?? null,
    modeId: params.config.modeId ?? null,
  };
}

interface ManagedAgentCore {
  provider: AgentProvider;
  cwd: string;
  lifecycle: ManagedAgent["lifecycle"];
  config: AgentSessionConfig;
  session: AgentSession | null;
  activeForegroundTurnId: string | null;
  now: Date;
}

function resolveManagedAgentCore(overrides: ManagedAgentOverrides): ManagedAgentCore {
  const now = overrides.updatedAt ?? new Date("2025-01-01T00:00:00.000Z");
  const provider = overrides.provider ?? "claude";
  const cwd = overrides.cwd ?? "/tmp/project";
  const lifecycle = overrides.lifecycle ?? "idle";
  const config = buildManagedAgentConfig(provider, cwd, overrides.config ?? {});
  const session = lifecycle === "closed" ? null : (overrides.session ?? ({} as AgentSession));
  const activeForegroundTurnId =
    overrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  return { provider, cwd, lifecycle, config, session, activeForegroundTurnId, now };
}

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const core = resolveManagedAgentCore(overrides);
  return {
    id: overrides.id ?? "agent-test",
    provider: core.provider,
    cwd: core.cwd,
    workspaceId: overrides.workspaceId,
    session: core.session,
    capabilities: overrides.capabilities ?? buildDefaultCapabilities(),
    config: core.config,
    lifecycle: core.lifecycle,
    createdAt: overrides.createdAt ?? core.now,
    updatedAt: overrides.updatedAt ?? core.now,
    availableModes: overrides.availableModes ?? [],
    currentModeId: overrides.currentModeId ?? core.config.modeId ?? null,
    pendingPermissions: overrides.pendingPermissions ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: core.activeForegroundTurnId,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: overrides.timeline ?? [],
    attention: overrides.attention ?? { requiresAttention: false },
    runtimeInfo:
      overrides.runtimeInfo ??
      buildDefaultRuntimeInfo({
        provider: core.provider,
        config: core.config,
        sessionId: overrides.sessionId ?? "session-123",
      }),
    persistence: overrides.persistence ?? null,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? core.now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
  };
}

describe("AgentStorage", () => {
  let tmpDir: string;
  let storagePath: string;
  let storage: AgentStorage;
  const logger = createTestLogger();

  test("blocked review claims survive stale snapshots and restart without replay", async () => {
    const agent = createManagedAgent({
      id: "blocked-review",
      persistence: { provider: "claude", sessionId: "retained" },
    });
    agent.labels = {};
    await storage.applySnapshot(agent);
    await storage.mutateChecklist(agent.id, { operation: "create", id: "task", text: "Review" });
    await storage.mutateChecklist(agent.id, { operation: "update", id: "task", status: "blocked" });
    const now = Date.now() + 3_600_001;
    expect(await storage.claimBlockedReview(agent.id, now)).toBe(true);
    await storage.applySnapshot(agent);
    const reopened = new AgentStorage(storagePath, logger);
    expect(await reopened.claimBlockedReview(agent.id, now + 1)).toBe(false);
    expect(await reopened.claimBlockedReview(agent.id, now + 3_600_000)).toBe(true);
    await reopened.mutateChecklist(agent.id, {
      operation: "update",
      id: "task",
      status: "pending",
    });
    expect(await reopened.claimBlockedReview(agent.id, now + 7_200_000)).toBe(false);
  });

  test("blocked goal discovery survives reload and stale snapshots without resetting activity", async () => {
    const agent = createManagedAgent({
      id: "blocked-goal-review",
      persistence: { provider: "codex", sessionId: "retained" },
    });
    agent.labels = {};
    await storage.applySnapshot(agent);
    const original = await storage.get(agent.id);
    await storage.updateBlockedGoalReview(agent.id, true);
    await storage.applySnapshot(agent);
    const reopened = new AgentStorage(storagePath, logger);
    expect(await reopened.get(agent.id)).toMatchObject({
      blockedGoalReviewNeeded: true,
      lastActivityAt: original!.lastActivityAt,
      updatedAt: original!.updatedAt,
    });
    const now = Date.now() + 3_600_001;
    expect(await reopened.claimBlockedReview(agent.id, now)).toBe(true);
    expect(await reopened.claimBlockedReview(agent.id, now + 1)).toBe(false);
    await reopened.updateBlockedGoalReview(agent.id, false);
    agent.blockedGoalReviewNeeded = true;
    await reopened.applySnapshot(agent);
    expect((await reopened.get(agent.id))?.blockedGoalReviewNeeded).toBe(false);
    expect(await reopened.claimBlockedReview(agent.id, now + 7_200_000)).toBe(false);
  });

  test("journal appends preserve order, survive stale snapshots and retry without duplication", async () => {
    const agent = createManagedAgent({ id: "journal" });
    await storage.applySnapshot(agent);
    const first = {
      entryId: "11111111-1111-4111-8111-111111111111",
      text: "Chose the durable store.",
      machineContext: "commit=abc123; task=11111111-1111-4111-8111-111111111111\nRecovery notes.",
    };
    const second = { entryId: "22222222-2222-4222-8222-222222222222", text: "Verified recovery." };
    const entries = await Promise.all([
      storage.appendJournal(agent.id, first),
      storage.appendJournal(agent.id, second),
    ]);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.text)).toEqual([first.text, second.text]);
    expect(entries.map((entry) => entry.machineContext)).toEqual([first.machineContext, undefined]);
    expect(entries.every((entry) => Number.isFinite(Date.parse(entry.timestamp)))).toBe(true);
    await storage.applySnapshot(agent);
    expect(await storage.appendJournal(agent.id, first)).toEqual(entries[0]);
    await expect(
      storage.appendJournal(agent.id, { ...first, text: "Rewrite history" }),
    ).rejects.toThrow("already used");
    await expect(
      storage.appendJournal(agent.id, { ...first, machineContext: "Different recovery notes" }),
    ).rejects.toThrow("already used");
    await expect(
      storage.appendJournal(agent.id, { entryId: first.entryId, text: first.text }),
    ).rejects.toThrow("already used");
    await expect(
      storage.appendJournal(agent.id, { ...second, machineContext: "Added after append" }),
    ).rejects.toThrow("already used");
    const reopened = new AgentStorage(storagePath, logger);
    expect((await reopened.get(agent.id))?.journal).toEqual(entries);
    await expect(storage.appendJournal("missing", first)).rejects.toThrow("active thread");
  });

  test("journal sequence follows append order when the clock moves backward", async () => {
    const agent = createManagedAgent({ id: "journal-clock" });
    await storage.applySnapshot(agent);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
      const first = await storage.appendJournal(agent.id, {
        entryId: "11111111-1111-4111-8111-111111111111",
        text: "First",
      });
      vi.setSystemTime(new Date("2026-10-09T11:00:00Z"));
      const second = await storage.appendJournal(agent.id, {
        entryId: "22222222-2222-4222-8222-222222222222",
        text: "Second",
      });
      expect(first.timestamp > second.timestamp).toBe(true);
      expect((await storage.get(agent.id))?.journal).toEqual([first, second]);
      expect(second.sequence).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("failed journal writes do not become visible and can be retried", async () => {
    const agent = createManagedAgent({ id: "journal-write-failure" });
    await storage.applySnapshot(agent);
    const input = { entryId: "11111111-1111-4111-8111-111111111111", text: "Verified progress" };
    await fs.rename(storagePath, `${storagePath}-backup`);
    await fs.writeFile(storagePath, "not a directory");
    try {
      await expect(storage.appendJournal(agent.id, input)).rejects.toThrow();
      expect((await storage.get(agent.id))?.journal).toBeUndefined();
    } finally {
      await fs.unlink(storagePath);
      await fs.rename(`${storagePath}-backup`, storagePath);
    }
    const entry = await storage.appendJournal(agent.id, input);
    expect(entry.sequence).toBe(1);
    expect((await new AgentStorage(storagePath, logger).get(agent.id))?.journal).toEqual([entry]);
  });

  describe("journal sidecar", () => {
    const idAndSequence = (item: { id: string; sequence: number }) => [item.id, item.sequence];
    const entryText = (item: { text: string }) => item.text;
    const isPreservedCorruptJournal = (name: string) =>
      name.startsWith("sidecar-corrupt.json.unreadable-");
    const journalFile = (agentId: string) =>
      path.join(tmpDir, "agent-journals", `${encodeURIComponent(agentId)}.json`);
    const recordFile = (agentId: string) =>
      path.join(storagePath, "tmp-project", `${agentId}.json`);
    const readJson = async (filePath: string) => JSON.parse(await fs.readFile(filePath, "utf8"));
    const entry = (n: number) => ({
      id: `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`,
      sequence: n,
      timestamp: `2026-10-0${n}T00:00:00.000Z`,
      text: `Entry ${n}`,
    });

    test("keeps the journal out of record writes and reloads it from the sidecar", async () => {
      const agent = createManagedAgent({ id: "sidecar" });
      await storage.applySnapshot(agent);
      const first = await storage.appendJournal(agent.id, {
        entryId: "11111111-1111-4111-8111-111111111111",
        text: "First",
      });
      await storage.applySnapshot(agent);
      expect(await readJson(recordFile(agent.id))).not.toHaveProperty("journal");
      expect(await readJson(journalFile(agent.id))).toEqual([first]);
      expect((await storage.get(agent.id))?.journal).toEqual([first]);
      expect((await new AgentStorage(storagePath, logger).get(agent.id))?.journal).toEqual([first]);
    });

    test("ordinary writes do not rewrite an unchanged journal", async () => {
      const agent = createManagedAgent({ id: "sidecar-unchanged" });
      await storage.applySnapshot(agent);
      await storage.appendJournal(agent.id, {
        entryId: "11111111-1111-4111-8111-111111111111",
        text: "First",
      });
      const past = new Date("2020-01-01T00:00:00Z");
      await fs.utimes(journalFile(agent.id), past, past);
      await storage.applySnapshot(agent);
      const record = await storage.get(agent.id);
      await storage.upsert({ ...record!, title: "Renamed" });
      expect((await fs.stat(journalFile(agent.id))).mtimeMs).toBe(past.getTime());
    });

    test("migrates a legacy inline journal on the next write", async () => {
      const agent = createManagedAgent({ id: "sidecar-legacy" });
      await storage.applySnapshot(agent);
      const legacy = { ...(await readJson(recordFile(agent.id))), journal: [entry(1), entry(2)] };
      await fs.writeFile(recordFile(agent.id), JSON.stringify(legacy));
      const reopened = new AgentStorage(storagePath, logger);
      expect((await reopened.get(agent.id))?.journal).toEqual([entry(1), entry(2)]);
      await reopened.applySnapshot(agent);
      expect(await readJson(recordFile(agent.id))).not.toHaveProperty("journal");
      expect(await readJson(journalFile(agent.id))).toEqual([entry(1), entry(2)]);
      expect((await new AgentStorage(storagePath, logger).get(agent.id))?.journal).toEqual([
        entry(1),
        entry(2),
      ]);
    });

    test("merges a newer sidecar and inline-only entries without duplicates", async () => {
      const agent = createManagedAgent({ id: "sidecar-merge" });
      await storage.applySnapshot(agent);
      const base = await readJson(recordFile(agent.id));
      await fs.mkdir(path.dirname(journalFile(agent.id)), { recursive: true });
      await fs.writeFile(journalFile(agent.id), JSON.stringify([entry(1), entry(2)]));
      await fs.writeFile(recordFile(agent.id), JSON.stringify({ ...base, journal: [entry(1)] }));
      expect((await new AgentStorage(storagePath, logger).get(agent.id))?.journal).toEqual([
        entry(1),
        entry(2),
      ]);

      await fs.writeFile(
        recordFile(agent.id),
        JSON.stringify({ ...base, journal: [entry(1), entry(3)] }),
      );
      const reopened = new AgentStorage(storagePath, logger);
      expect((await reopened.get(agent.id))?.journal).toEqual([entry(1), entry(2), entry(3)]);
      await reopened.applySnapshot(agent);
      expect(await readJson(journalFile(agent.id))).toEqual([entry(1), entry(2), entry(3)]);
    });

    test("renumbers entries an older daemon appended inline after a rollback", async () => {
      const agent = createManagedAgent({ id: "sidecar-rollback" });
      await storage.applySnapshot(agent);
      const base = await readJson(recordFile(agent.id));
      await fs.mkdir(path.dirname(journalFile(agent.id)), { recursive: true });
      await fs.writeFile(journalFile(agent.id), JSON.stringify([entry(1), entry(2)]));
      const rolledBack = { ...entry(3), sequence: 1 };
      await fs.writeFile(recordFile(agent.id), JSON.stringify({ ...base, journal: [rolledBack] }));
      const journal = (await new AgentStorage(storagePath, logger).get(agent.id))?.journal;
      expect(journal?.map(idAndSequence)).toEqual([
        [entry(1).id, 1],
        [entry(2).id, 2],
        [entry(3).id, 3],
      ]);
    });

    const appendSecond = (target: AgentStorage, agentId: string) =>
      target.appendJournal(agentId, {
        entryId: "99999999-9999-4999-8999-999999999999",
        text: "Second",
      });

    // Simulates a racing writer that takes the preservation name first.
    const realLink = fs.link.bind(fs);
    const occupiedDestination = { path: "" };
    const occupyThenLink = async (source: PathLike, destination: PathLike) => {
      occupiedDestination.path = String(destination);
      await fs.writeFile(occupiedDestination.path, "someone else's bytes");
      return realLink(source, destination);
    };

    // Writes a record with an inline journal and a corrupt journal file beside it.
    const seedCorruptJournal = async (agentId: string) => {
      const agent = createManagedAgent({ id: agentId });
      await storage.applySnapshot(agent);
      const base = await readJson(recordFile(agent.id));
      await fs.writeFile(recordFile(agent.id), JSON.stringify({ ...base, journal: [entry(1)] }));
      await fs.mkdir(path.dirname(journalFile(agent.id)), { recursive: true });
      await fs.writeFile(journalFile(agent.id), "{not json");
      return agent;
    };

    test("leaves a corrupt journal in place and refuses appends when preserving it fails", async () => {
      const agent = await seedCorruptJournal("sidecar-preserve-fails");
      const link = vi
        .spyOn(fs, "link")
        .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
      try {
        const reopened = new AgentStorage(storagePath, logger);
        await reopened.applySnapshot(agent);
        await expect(appendSecond(reopened, agent.id)).rejects.toMatchObject({
          code: "unavailable",
        });
        await reopened.applySnapshot(agent);
      } finally {
        link.mockRestore();
      }
      expect(await fs.readFile(journalFile(agent.id), "utf8")).toBe("{not json");
      expect((await readJson(recordFile(agent.id))).journal).toEqual([entry(1)]);
    });

    test("never replaces an existing file when preserving a corrupt journal", async () => {
      const agent = await seedCorruptJournal("sidecar-preserve-collides");
      const link = vi.spyOn(fs, "link").mockImplementationOnce(occupyThenLink);
      try {
        const reopened = new AgentStorage(storagePath, logger);
        await reopened.applySnapshot(agent);
        await expect(appendSecond(reopened, agent.id)).rejects.toMatchObject({
          code: "unavailable",
        });
      } finally {
        link.mockRestore();
      }
      expect(await fs.readFile(occupiedDestination.path, "utf8")).toBe("someone else's bytes");
      expect(await fs.readFile(journalFile(agent.id), "utf8")).toBe("{not json");
      expect((await readJson(recordFile(agent.id))).journal).toEqual([entry(1)]);
    });

    test("keeps the journal when a record file survives deletion", async () => {
      const agent = createManagedAgent({ id: "sidecar-delete-fails" });
      await storage.applySnapshot(agent);
      await storage.appendJournal(agent.id, {
        entryId: "11111111-1111-4111-8111-111111111111",
        text: "First",
      });
      const saved = await fs.readFile(journalFile(agent.id), "utf8");
      const unlink = vi
        .spyOn(fs, "unlink")
        .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
      try {
        await expect(storage.remove(agent.id)).rejects.toThrow("could not all be removed");
      } finally {
        unlink.mockRestore();
      }
      expect(await fs.readFile(journalFile(agent.id), "utf8")).toBe(saved);
      const reloaded = await new AgentStorage(storagePath, logger).get(agent.id);
      expect(reloaded?.journal?.map(entryText)).toEqual(["First"]);
    });

    test("keeps both copies and refuses appends when an inline entry reuses an ID with different content", async () => {
      const agent = createManagedAgent({ id: "sidecar-rollback-conflict" });
      await storage.applySnapshot(agent);
      const base = await readJson(recordFile(agent.id));
      await fs.mkdir(path.dirname(journalFile(agent.id)), { recursive: true });
      const sidecar = JSON.stringify([entry(1), entry(2)]);
      await fs.writeFile(journalFile(agent.id), sidecar);
      const inline = [{ ...entry(2), sequence: 1, text: "Accepted by an older daemon" }];
      await fs.writeFile(recordFile(agent.id), JSON.stringify({ ...base, journal: inline }));

      const reopened = new AgentStorage(storagePath, logger);
      await expect(appendSecond(reopened, agent.id)).rejects.toMatchObject({
        code: "unavailable",
      });
      await reopened.applySnapshot(agent);
      expect(await fs.readFile(journalFile(agent.id), "utf8")).toBe(sidecar);
      expect((await readJson(recordFile(agent.id))).journal).toEqual(inline);
    });

    test("deduplicates an identical retry even when its sequence and timestamp differ", async () => {
      const agent = createManagedAgent({ id: "sidecar-rollback-retry" });
      await storage.applySnapshot(agent);
      const base = await readJson(recordFile(agent.id));
      await fs.mkdir(path.dirname(journalFile(agent.id)), { recursive: true });
      await fs.writeFile(journalFile(agent.id), JSON.stringify([entry(1), entry(2)]));
      const retried = { ...entry(2), sequence: 1, timestamp: "2026-10-09T00:00:00.000Z" };
      await fs.writeFile(recordFile(agent.id), JSON.stringify({ ...base, journal: [retried] }));

      const reopened = new AgentStorage(storagePath, logger);
      expect((await reopened.get(agent.id))?.journal).toEqual([entry(1), entry(2)]);
      await expect(appendSecond(reopened, agent.id)).resolves.toMatchObject({ sequence: 3 });
    });

    test("treats conflicting duplicate IDs within the inline journal as a conflict", async () => {
      const agent = createManagedAgent({ id: "sidecar-inline-duplicates" });
      await storage.applySnapshot(agent);
      const base = await readJson(recordFile(agent.id));
      await fs.mkdir(path.dirname(journalFile(agent.id)), { recursive: true });
      await fs.writeFile(journalFile(agent.id), JSON.stringify([entry(1)]));
      const inline = [entry(3), { ...entry(3), text: "Different" }];
      await fs.writeFile(recordFile(agent.id), JSON.stringify({ ...base, journal: inline }));

      const reopened = new AgentStorage(storagePath, logger);
      await expect(appendSecond(reopened, agent.id)).rejects.toMatchObject({
        code: "unavailable",
      });
      await reopened.applySnapshot(agent);
      expect((await readJson(recordFile(agent.id))).journal).toEqual(inline);
    });

    test("falls back to the inline journal when the sidecar is corrupt", async () => {
      const agent = createManagedAgent({ id: "sidecar-corrupt" });
      await storage.applySnapshot(agent);
      const base = await readJson(recordFile(agent.id));
      await fs.writeFile(recordFile(agent.id), JSON.stringify({ ...base, journal: [entry(1)] }));
      await fs.mkdir(path.dirname(journalFile(agent.id)), { recursive: true });
      await fs.writeFile(journalFile(agent.id), "{not json");
      const reopened = new AgentStorage(storagePath, logger);
      expect((await reopened.get(agent.id))?.journal).toEqual([entry(1)]);
      const names = await fs.readdir(path.dirname(journalFile(agent.id)));
      expect(names.filter(isPreservedCorruptJournal)).toHaveLength(1);
      await reopened.applySnapshot(agent);
      expect(await readJson(journalFile(agent.id))).toEqual([entry(1)]);
    });

    test("remove deletes the sidecar", async () => {
      const agent = createManagedAgent({ id: "sidecar-remove" });
      await storage.applySnapshot(agent);
      await storage.appendJournal(agent.id, {
        entryId: "11111111-1111-4111-8111-111111111111",
        text: "First",
      });
      await storage.remove(agent.id);
      await expect(fs.access(journalFile(agent.id))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("checklist commits survive stale snapshots, deletion, and fresh storage instances", async () => {
    const agent = createManagedAgent({ id: "checklist" });
    await storage.applySnapshot(agent);
    await Promise.all([
      storage.mutateChecklist(agent.id, { operation: "create", id: "a", text: "A" }),
      storage.mutateChecklist(agent.id, { operation: "create", id: "b", text: "B" }),
    ]);
    await storage.applySnapshot(agent);
    const saved = await storage.get(agent.id);
    expect(saved?.tasks?.map((task) => task.id)).toEqual(["a", "b"]);
    await storage.mutateChecklist(agent.id, { operation: "delete", id: "a" });
    await storage.applySnapshot(createManagedAgent({ id: agent.id, tasks: saved?.tasks }));
    const reopened = new AgentStorage(storagePath, logger);
    expect((await reopened.get(agent.id))?.tasks?.map((task) => task.id)).toEqual(["b"]);
  });

  test("a failed checklist write leaves the saved checklist unchanged and can be retried", async () => {
    const agent = createManagedAgent({ id: "failed-checklist" });
    await storage.applySnapshot(agent);
    const original = await storage.mutateChecklist(agent.id, {
      operation: "create",
      id: "a",
      text: "A",
    });
    await fs.rename(storagePath, `${storagePath}-backup`);
    await fs.writeFile(storagePath, "not a directory");
    try {
      await expect(
        storage.mutateChecklist(agent.id, { operation: "update", id: "a", status: "completed" }),
      ).rejects.toThrow();
      expect((await storage.get(agent.id))?.tasks).toEqual(original);
    } finally {
      await fs.unlink(storagePath);
      await fs.rename(`${storagePath}-backup`, storagePath);
    }
    await storage.mutateChecklist(agent.id, { operation: "update", id: "a", status: "completed" });
    expect((await new AgentStorage(storagePath, logger).get(agent.id))?.tasks?.[0].completed).toBe(
      true,
    );
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-registry-"));
    storagePath = path.join(tmpDir, "agents");
    storage = new AgentStorage(storagePath, logger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("applySnapshot persists configs and snapshot metadata", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-1",
        cwd: "/tmp/project",
        currentModeId: "coding",
        lifecycle: "idle",
        config: {
          title: "Initial title",
          modeId: "coding",
          model: "gpt-5.1",
          systemPrompt: "Be terse and explicit.",
          providerOptions: { allowedTools: ["Read"] },
          mcpServers: {
            paseo: {
              type: "stdio",
              command: "node",
              args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
            },
          },
        },
      }),
    );

    const records = await storage.list();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.provider).toBe("claude");
    expect(record.config?.modeId).toBe("coding");
    expect(record.config?.model).toBe("gpt-5.1");
    expect(record.config?.systemPrompt).toBe("Be terse and explicit.");
    expect(record.config?.mcpServers).toEqual({
      paseo: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
      },
    });
    expect(record.lastModeId).toBe("coding");
    expect(record.lastStatus).toBe("idle");

    const reloaded = new AgentStorage(storagePath, logger);
    const [persisted] = await reloaded.list();
    expect(persisted.cwd).toBe("/tmp/project");
    expect(persisted.config?.providerOptions).toEqual({ allowedTools: ["Read"] });
  });

  test("applySnapshot stores and reloads featureValues when present", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-feature-values",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-feature-values");
    expect(record?.config?.featureValues).toEqual({ fast_mode: true });

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-feature-values");
    expect(persisted?.config?.featureValues).toEqual({ fast_mode: true });
    expect(buildSessionConfig(persisted!).featureValues).toEqual({ fast_mode: true });
  });

  test("applySnapshot keeps featureValues absent when they were never set", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-no-feature-values",
      }),
    );

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-no-feature-values");
    expect(persisted?.config?.featureValues).toBeUndefined();
    expect(buildSessionConfig(persisted!).featureValues).toBeUndefined();
  });

  test("buildConfigOverrides includes featureValues when present in stored config", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-resume-overrides",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-resume-overrides");
    expect(record).not.toBeNull();
    expect(buildConfigOverrides(record!)).toMatchObject({
      cwd: "/tmp/project",
      featureValues: {
        fast_mode: true,
      },
    });
  });

  test("applySnapshot preserves original createdAt timestamp", async () => {
    const agentId = "agent-created-at";
    const firstTimestamp = new Date("2025-01-01T00:00:00.000Z");
    await storage.applySnapshot(createManagedAgent({ id: agentId, createdAt: firstTimestamp }));

    const initialRecord = await storage.get(agentId);
    expect(initialRecord?.createdAt).toBe(firstTimestamp.toISOString());

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        createdAt: new Date("2025-02-01T00:00:00.000Z"),
        updatedAt: new Date("2025-02-01T00:00:00.000Z"),
        lifecycle: "running",
      }),
    );

    const updatedRecord = await storage.get(agentId);
    expect(updatedRecord?.createdAt).toBe(firstTimestamp.toISOString());
    expect(updatedRecord?.lastStatus).toBe("running");
  });

  test("retained archive recovery preserves every other persisted field", async () => {
    await storage.applySnapshot(createManagedAgent({ id: "retained", lifecycle: "closed" }));
    const record = (await storage.get("retained"))!;
    await storage.upsert({ ...record, archivedAt: "2026-10-07T00:00:00Z" });
    const expected = structuredClone((await storage.get("retained"))!);
    const restored = await storage.clearRetainedArchive(expected, () => {});
    expect(restored).toEqual({ ...expected, archivedAt: null, updatedAt: expect.any(String) });
    expect(expected.archivedAt).toBe("2026-10-07T00:00:00Z");
    const reloaded = new AgentStorage(storagePath, logger);
    expect(await reloaded.get("retained")).toEqual(
      parseStoredAgentRecord(JSON.parse(JSON.stringify(restored))),
    );
  });

  test("retained archive recovery rejects a queued full-record change", async () => {
    await storage.applySnapshot(createManagedAgent({ id: "retained", lifecycle: "closed" }));
    const record = (await storage.get("retained"))!;
    await storage.upsert({ ...record, archivedAt: "2026-10-07T00:00:00Z" });
    const expected = structuredClone((await storage.get("retained"))!);
    const updated = { ...expected, title: "Changed by another writer" };
    const write = storage.upsert(updated);
    const rejected = expect(storage.clearRetainedArchive(expected, () => {})).rejects.toThrow(
      "changed",
    );
    await write;
    await rejected;
    expect(await storage.get("retained")).toEqual(updated);
  });

  test("retained archive recovery refuses action drift, deletion and revoked custody", async () => {
    await storage.applySnapshot(createManagedAgent({ id: "retained", lifecycle: "closed" }));
    const active = structuredClone((await storage.get("retained"))!);
    await expect(storage.clearRetainedArchive(active, () => {})).rejects.toThrow("changed");
    await storage.upsert({ ...active, archivedAt: "2026-10-07T00:00:00Z" });
    const archived = structuredClone((await storage.get("retained"))!);
    await expect(
      storage.clearRetainedArchive(archived, () => {
        throw new Error("Custody revoked");
      }),
    ).rejects.toThrow("Custody revoked");
    expect(await storage.get("retained")).toEqual(archived);
    storage.beginDelete("retained");
    await expect(storage.clearRetainedArchive(archived, () => {})).rejects.toThrow("being deleted");
    expect(await storage.get("retained")).toEqual(archived);
  });

  test("applySnapshot preserves archivedAt (soft-delete) status", async () => {
    const agentId = "agent-archived";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
      }),
    );

    const archivedAt = "2025-01-03T00:00:00.000Z";
    const recordBeforeArchive = await storage.get(agentId);
    expect(recordBeforeArchive).not.toBeNull();
    await storage.upsert({ ...recordBeforeArchive!, archivedAt });

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      }),
    );

    const recordAfterSnapshot = await storage.get(agentId);
    expect(recordAfterSnapshot?.archivedAt).toBe(archivedAt);
  });

  test("stores titles independently of snapshots", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-2",
        provider: "codex",
        cwd: "/tmp/second",
      }),
    );
    await storage.setTitle("agent-2", "Fix Login Bug");

    const current = await storage.get("agent-2");
    expect(current?.title).toBe("Fix Login Bug");

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-2");
    expect(persisted?.title).toBe("Fix Login Bug");
  });

  test("setTitle throws when the agent record does not exist", async () => {
    await expect(storage.setTitle("missing-agent", "Impossible")).rejects.toThrow(
      "Agent missing-agent not found",
    );
  });

  test("applySnapshot accepts explicit title overrides", async () => {
    const agentId = "agent-override";
    await storage.applySnapshot(createManagedAgent({ id: agentId }), { title: "Provided Title" });

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Provided Title");
  });

  test("applySnapshot preserves custom titles while updating metadata", async () => {
    const agentId = "agent-3";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
        currentModeId: "plan",
      }),
    );
    await storage.setTitle(agentId, "Important Bug Fix");

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        currentModeId: "build",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Important Bug Fix");
    expect(record?.lastModeId).toBe("build");
    expect(record?.lastStatus).toBe("running");
  });

  test("applySnapshot projects metadata after in-flight archival writes", async () => {
    const agentId = "agent-pending-write";
    await storage.applySnapshot(createManagedAgent({ id: agentId }));
    const initialRecord = await storage.get(agentId);
    expect(initialRecord).not.toBeNull();

    let releasePendingWrite: (() => void) | null = null;
    const pendingWrite = new Promise<void>((resolve) => {
      releasePendingWrite = resolve;
    });

    const storageInternals = storage as unknown as {
      pendingWrites: Map<string, Promise<void>>;
      cache: Map<string, unknown>;
    };
    storageInternals.pendingWrites.set(agentId, pendingWrite);

    const applySnapshotPromise = storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    storageInternals.cache.set(agentId, {
      ...initialRecord!,
      title: "Generated title",
      archivedAt: "2025-01-03T00:00:00.000Z",
    });
    releasePendingWrite?.();

    await applySnapshotPromise;
    const record = await storage.get(agentId);
    expect(record?.title).toBe("Generated title");
    expect(record?.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  });

  test("list returns all agents including internal ones", async () => {
    // Create a normal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "normal-agent",
        cwd: "/tmp/project",
      }),
    );

    // Create an internal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Registry should return all agents - filtering is done at the manager level
    const records = await storage.list();
    expect(records).toHaveLength(2);
  });

  test("get returns internal agents by ID", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    const record = await storage.get("internal-agent");
    expect(record).not.toBeNull();
    expect(record?.internal).toBe(true);
  });

  test("queries agents by provider session and native handle", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "matching-session",
        provider: "codex",
        persistence: {
          provider: "codex",
          sessionId: "session-1",
          nativeHandle: "thread-1",
        },
      }),
    );
    await storage.applySnapshot(
      createManagedAgent({
        id: "other-session",
        provider: "codex",
        persistence: { provider: "codex", sessionId: "session-2" },
      }),
    );

    await expect(storage.listByProviderSession("codex", "session-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
    await expect(storage.listByProviderSession("codex", "thread-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
  });

  test("queries agents by workspace", async () => {
    await storage.applySnapshot(
      createManagedAgent({ id: "workspace-agent", workspaceId: "workspace-1" }),
    );
    await storage.applySnapshot(
      createManagedAgent({ id: "other-workspace-agent", workspaceId: "workspace-2" }),
    );

    await expect(storage.listByWorkspace("workspace-1")).resolves.toMatchObject([
      { id: "workspace-agent" },
    ]);
  });

  test("internal flag is persisted and reloaded", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Reload the registry from disk
    const reloaded = new AgentStorage(storagePath, logger);
    const record = await reloaded.get("internal-agent");
    expect(record?.internal).toBe(true);

    // Registry returns all agents - filtering happens at manager level
    const records = await reloaded.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.internal).toBe(true);
  });

  test("Windows drive-letter paths produce valid directory names", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "win-agent",
        cwd: "D:\\Users\\dev\\MyProject",
      }),
    );

    const record = await storage.get("win-agent");
    expect(record).not.toBeNull();

    // The persisted directory must not contain a colon (invalid on Windows)
    const dirs = readdirSync(storagePath);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toContain(":");
    expect(dirs[0]).toBe("D-Users-dev-MyProject");
  });

  test("remove deletes all duplicate record files across project directories", async () => {
    const agentId = "agent-duplicate";

    // Create a valid record file in two different project directories to simulate
    // storage migrations/duplication. Only one copy will be referenced in-memory,
    // but deletion should remove *all* copies on disk.
    const recordA = await (async () => {
      await storage.applySnapshot(
        createManagedAgent({
          id: agentId,
          cwd: "/tmp/project-a",
          provider: "codex",
        }),
      );
      const record = await storage.get(agentId);
      expect(record).not.toBeNull();
      return record!;
    })();

    const projectDirB = path.join(storagePath, "tmp-project-b");
    await fs.mkdir(projectDirB, { recursive: true });
    const duplicatePathB = path.join(projectDirB, `${agentId}.json`);
    await fs.writeFile(
      duplicatePathB,
      JSON.stringify({ ...recordA, cwd: "/tmp/project-b" }, null, 2),
      "utf8",
    );

    // Force a reload so the registry has to discover from disk (and may choose either copy).
    const reloaded = new AgentStorage(storagePath, logger);
    const before = await reloaded.list();
    expect(before.map((r) => r.id)).toContain(agentId);

    await reloaded.remove(agentId);

    const hasAnyRecordFile = async () => {
      const projects = await fs
        .readdir(storagePath, { withFileTypes: true })
        .catch(() => [] as Awaited<ReturnType<typeof fs.readdir>>);
      const exists = await Promise.all(
        projects
          .filter((project) => project.isDirectory())
          .map(async (project) => {
            const candidate = path.join(storagePath, project.name, `${agentId}.json`);
            try {
              await fs.access(candidate);
              return true;
            } catch {
              return false;
            }
          }),
      );
      return exists.some((present) => present);
    };

    expect(await hasAnyRecordFile()).toBe(false);

    const afterReload = new AgentStorage(storagePath, logger);
    const after = await afterReload.list();
    expect(after.some((r) => r.id === agentId)).toBe(false);
  });
});
