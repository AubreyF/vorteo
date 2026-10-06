import { readInstallationSettings } from "../../execution-installation/settings/projection.js";
import { readInstallationProviders } from "../../execution-installation/settings/providers.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { createAgentCommand } from "./create.js";
import { QuotaReservePolling } from "../quota-reserve/polling.js";
import { ProviderUsageService } from "../../../services/quota-fetcher/service.js";
import type { ManagedAgent } from "../agent-manager.js";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";

const logger = createTestLogger();

function createRealAgentManager(storage: AgentStorage): AgentManager {
  return new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
}

async function removeRealAgentManagerWorkdir({
  agentManager,
  storage,
  workdir,
}: {
  agentManager: AgentManager;
  storage: AgentStorage;
  workdir: string;
}): Promise<void> {
  agentManager.prepareForShutdown();
  await Promise.all(agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)));
  await agentManager.flushForShutdown();
  await storage.flush();
  rmSync(workdir, { recursive: true, force: true });
}

// Creates a worktree directory under repoRoot and reports it back as a fresh
// workspace so the command can stamp the agent with it (mirrors the production
// worktree service).
function fakeWorktreeCreator(args: { repoRoot: string; createdWorkspaceId: string }) {
  const worktreePath = join(args.repoRoot, "worktree");
  const workspaceCwd = join(worktreePath, "packages", "app");
  mkdirSync(workspaceCwd, { recursive: true });
  return async (): Promise<CreatePaseoWorktreeWorkflowResult> =>
    ({
      worktree: { worktreePath },
      intent: {},
      workspace: { workspaceId: args.createdWorkspaceId, cwd: workspaceCwd },
      repoRoot: args.repoRoot,
      created: true,
      setupContinuation: { kind: "agent" as const, startAfterAgentCreate: () => {} },
    }) as unknown as CreatePaseoWorktreeWorkflowResult;
}

test("session create forwards clientMessageId to the initial prompt run options", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const streamAgent = vi.fn(() => (async function* noop() {})());
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      streamAgent,
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    workspaceId: "ws-create-test",
    initialPrompt: "hello from create",
    clientMessageId: "msg-create-1",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(streamAgent).toHaveBeenCalledWith("agent-1", "hello from create", {
    clientMessageId: "msg-create-1",
  });
});

test("session create validates the requested mode against the provider's modes", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockRejectedValue(
    new Error("Invalid mode 'plan' for provider 'opencode'. Available modes: build, myplan"),
  );
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "plan" },
      workspaceId: "ws-create-test",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    }),
  ).rejects.toThrow("Invalid mode 'plan'");

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "opencode",
      cwd: "/tmp/paseo-create-test",
      requestedMode: "plan",
    }),
  );
  expect(createAgent).not.toHaveBeenCalled();
});

test("session create applies the resolved mode from the provider create config", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockResolvedValue({
    modeId: "build",
    featureValues: { auto_accept: true },
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "build" },
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      modeId: "build",
      featureValues: { auto_accept: true },
    }),
    undefined,
    expect.anything(),
  );
});

test("mcp create accepts provider-only internal input and leaves model undefined", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async (input) => {
        expect(input.provider).toBe("claude");
        return {};
      }),
    } as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    workspaceId: "ws-create-test",
    title: "provider default",
    initialPrompt: "hello",
    background: true,
    notifyOnFinish: false,
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude",
      model: undefined,
    }),
    undefined,
    expect.objectContaining({
      workspaceId: "ws-create-test",
    }),
  );
});

test("session create stamps the requested workspaceId when no worktree setup runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-source");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create stamps the new worktree's workspaceId when a setup continuation runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({
          sessionConfig: config,
          setupContinuation: { kind: "agent", startAfterAgentCreate: () => {} },
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-new-worktree");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create stamps the new worktree's workspaceId, not the parent's", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const { snapshot: child } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager,
        createPaseoWorktree: fakeWorktreeCreator({
          repoRoot: workdir,
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "child",
        initialPrompt: "do the thing",
        background: true,
        notifyOnFinish: false,
        callerAgentId: parent.id,
        worktree: { worktreeName: "feature", baseBranch: "main" },
      },
    );

    const storedChild = await storage.get(child.id);
    expect(storedChild?.workspaceId).toBe("ws-new-worktree");
    expect(child.cwd).toBe(join(workdir, "worktree", "packages", "app"));
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create exposes the created worktree before dispatching the initial prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-worktree-callback-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const createdWorktree = await fakeWorktreeCreator({
    repoRoot: workdir,
    createdWorkspaceId: "ws-created-worktree",
  })();
  let observed:
    | {
        createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
        lifecycle: ManagedAgent["lifecycle"] | null;
      }
    | undefined;

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return {};
          },
        },
        createPaseoWorktree: async () => createdWorktree,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        title: "worktree callback",
        initialPrompt: "Say done.",
        background: true,
        notifyOnFinish: false,
        worktree: { worktreeName: "feature", baseBranch: "main" },
        onCreated: ({ agentId, createdWorktree: callbackWorktree }) => {
          observed = {
            createdWorktree: callbackWorktree,
            lifecycle: agentManager.getAgent(agentId)?.lifecycle ?? null,
          };
        },
      },
    );

    expect(observed).toEqual({ createdWorktree, lifecycle: "idle" });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("failed asynchronous owner evidence persistence prevents initial prompt dispatch", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-owner-evidence-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const starts: unknown[] = [];
  const agentManager = new AgentManager({
    clients: createTestAgentClients({
      onStartTurn: (prompt) => {
        starts.push(prompt);
      },
    }),
    registry: storage,
    logger,
  });
  try {
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        },
        {
          kind: "session",
          config: { provider: "codex", cwd: workdir },
          workspaceId: "workspace-evidence",
          initialPrompt: "Implement the approved change",
          labels: {},
          firstAgentContext: { attachments: [] },
          buildSessionConfig: async (config) => ({ sessionConfig: config }),
          onCreated: async () => {
            await Promise.resolve();
            throw new Error("Owner evidence persistence failed");
          },
        },
      ),
    ).rejects.toThrow("Owner evidence persistence failed");
    expect(starts).toEqual([]);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps the prompt title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Implement auth retries with backoff";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-title-source",
        initialPrompt: `${title}\n\ninclude tests`,
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps an explicit title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-explicit-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Explicit override";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir, title },
        workspaceId: "ws-explicit-title-source",
        initialPrompt: "Implement auth retries with backoff",
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

async function reserveLaunchHarness(remaining: (read: number) => number | null) {
  const workdir = mkdtempSync(join(tmpdir(), "reserve-launch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const starts: unknown[] = [];
  const agentManager = new AgentManager({
    clients: createTestAgentClients({
      onStartTurn: (prompt) => {
        starts.push(prompt);
      },
    }),
    registry: storage,
    logger,
  });
  let reads = 0;
  const usageService = new ProviderUsageService({
    logger,
    fetchers: [
      {
        providerId: "codex",
        displayName: "Codex",
        fetchUsage: async () => {
          reads += 1;
          return {
            providerId: "codex",
            displayName: "Codex",
            status: "available",
            planLabel: null,
            windows: [{ id: "weekly", label: "Weekly", remainingPct: remaining(reads) }],
            reserveWindowIds: ["weekly"],
          };
        },
      },
    ],
  });
  const polling = new QuotaReservePolling({ agentManager, usageService, logger });
  agentManager.setQuotaReserveObservationReader((provider) => polling.readForAdmission(provider));
  const created: string[] = [];
  const launch = () =>
    createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: {
          provider: "codex",
          cwd: workdir,
          quotaReservePolicy: { kind: "protected", cruisePct: 15, redlinePct: 10 },
        },
        workspaceId: "reserve-workspace",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        initialPrompt: "First protected prompt",
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
        onCreated: ({ agentId }) => {
          created.push(agentId);
        },
      },
    );
  return {
    launch,
    starts,
    created,
    storage,
    agentManager,
    reads: () => reads,
    close: async () => {
      await polling.stop();
      await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
    },
  };
}

test("reserve launch checks quota before creation and durably refreshes before the first prompt", async () => {
  const harness = await reserveLaunchHarness(() => 50);
  try {
    const result = await harness.launch();
    expect(result.initialPromptStarted).toBe(true);
    expect(harness.reads()).toBe(2);
    expect(harness.starts).toEqual(["First protected prompt"]);
    expect(harness.created).toEqual([result.snapshot.id]);
    expect((await harness.storage.get(result.snapshot.id))?.config?.quotaReserve?.state.kind).toBe(
      "ready",
    );
  } finally {
    await harness.close();
  }
});

test.each([
  { remaining: 14, message: "Cruise Reserve" },
  { remaining: 15, message: "Cruise Reserve" },
  { remaining: 10, message: "Redline" },
  { remaining: null, message: "unavailable" },
])(
  "reserve launch at $remaining blocks before creating an agent",
  async ({ remaining, message }) => {
    const harness = await reserveLaunchHarness(() => remaining);
    try {
      await expect(harness.launch()).rejects.toThrow(message);
      expect(harness.reads()).toBe(1);
      expect(harness.starts).toEqual([]);
      expect(harness.created).toEqual([]);
      expect(harness.agentManager.listAgents()).toEqual([]);
      expect(await harness.storage.list()).toEqual([]);
    } finally {
      await harness.close();
    }
  },
);

test("a quota drop during creation reports the created agent for cleanup and never sends its prompt", async () => {
  const harness = await reserveLaunchHarness((read) => (read === 1 ? 50 : 14));
  try {
    await expect(harness.launch()).rejects.toThrow("Cruise Reserve");
    expect(harness.starts).toEqual([]);
    expect(harness.created).toHaveLength(1);
    const stored = await harness.storage.get(harness.created[0]!);
    expect(stored?.config?.quotaReserve?.state).toMatchObject({ kind: "held", reason: "cruise" });
  } finally {
    await harness.close();
  }
});

test("a shared supervisor retains frozen worker values after inspecting installation context", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "shared-worker-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;
  try {
    const worker = {
      id: "shared-workflow/codex/worker",
      name: "Worker",
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: "medium",
    };
    const parent = await agentManager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
        profileLaunch: {
          configurationRevision: 8,
          profile: { id: "team", name: "Team", provider: "codex", workerProfileId: worker.id },
          worker,
        },
      },
      undefined,
      { workspaceId: "ws-shared-worker", owner: { kind: "user" } },
    );
    const getSharedProviderConfig = vi.fn(() => {
      return MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: false },
        agentProfiles: [{ ...worker, model: "changed-model" }],
      });
    });
    const validateSharedConfiguration = vi
      .fn()
      .mockRejectedValue(new Error("Frozen worker model is unavailable"));
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager,
          getSharedProviderConfig,
          validateSharedConfiguration,
        },
        {
          kind: "mcp",
          provider: "codex/gpt-5.4",
          profileId: worker.id,
          callerAgentId: parent.id,
          title: "Worker",
          background: true,
          notifyOnFinish: false,
        },
      ),
    ).rejects.toThrow("Frozen worker model is unavailable");
    expect(getSharedProviderConfig).toHaveBeenCalledTimes(1);
    expect(validateSharedConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        thinkingOptionId: "medium",
        profileLaunch: expect.objectContaining({ configurationRevision: 8 }),
      }),
    );
    expect(agentManager.listAgents()).toHaveLength(1);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("new managed worker dispatch checks current installation exclusions and fails closed offline", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "installation-worker-admission-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  try {
    const worker = {
      id: "shared-workflow/codex/worker",
      name: "Worker",
      provider: "codex",
      model: "gpt-5.4",
    };
    const parent = await agentManager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
        profileLaunch: {
          profile: { id: "team", name: "Team", provider: "codex", workerProfileId: worker.id },
          worker,
        },
      },
      undefined,
      { workspaceId: "worker-admission-workspace", owner: { kind: "user" } },
    );
    const cached = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      sharedProviderPreferences: {
        version: 1,
        revision: 1,
        legacyProfiles: {},
        providers: {},
        installation: {
          installationId: "00000000-0000-4000-8000-000000000001",
          environment: "host",
          serverId: "host",
          revision: 1,
        },
      },
    });
    const canonical = MutableDaemonConfigSchema.parse({
      ...cached,
      sharedProviderPreferences: {
        ...cached.sharedProviderPreferences,
        version: 1,
        revision: 2,
        legacyProfiles: {},
        providers: {
          codex: {
            defaults: {},
            preferredModels: [],
            preferredThinkingOptions: [],
            defaultWorkflowId: null,
            workflows: [{ ...worker, id: "worker", excludedEnvironments: ["host"] }],
          },
        },
      },
    }).sharedProviderPreferences;
    if (!canonical) throw new Error("missing canonical profiles");
    let offline = false;
    let reads = 0;
    const dependencies: Parameters<typeof createAgentCommand>[0] = {
      agentManager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: {
        resolveCreateConfig: async () => {
          throw new Error("Unexpected provider preparation");
        },
      },
      getSharedProviderConfig: () => cached,
      installationProfileReader: {
        read: async () => {
          reads++;
          if (offline) throw new Error("coordinator offline");
          return canonical;
        },
      },
    };
    const input: Parameters<typeof createAgentCommand>[1] = {
      kind: "mcp",
      provider: "codex/gpt-5.4",
      profileId: worker.id,
      callerAgentId: parent.id,
      title: "Worker",
      background: true,
      notifyOnFinish: false,
    };
    await expect(createAgentCommand(dependencies, input)).rejects.toThrow("excluded from the host");
    offline = true;
    await expect(createAgentCommand(dependencies, input)).rejects.toThrow("coordinator offline");
    expect(reads).toBe(2);
    expect(agentManager.listAgents().map((agent) => agent.id)).toEqual([parent.id]);
    expect(agentManager.getAgent(parent.id)?.config.profileLaunch?.worker).toEqual(worker);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("profileless installation tasks require fresh settings authority before registration", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "shared-skills-launch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const binding = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  let reads = 0;
  try {
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          getSharedProviderConfig: () => settings,
          installationSettingsReader: {
            async read(received) {
              expect(received).toEqual(binding);
              reads++;
              throw new Error("Coordinator offline");
            },
          },
        },
        {
          kind: "session",
          config: { provider: "codex", cwd: workdir },
          workspaceId: "shared-skills",
          initialPrompt: "Do not start",
          labels: {},
          provisionalTitle: null,
          firstAgentContext: { attachments: [] },
          buildSessionConfig: async (config) => ({ sessionConfig: config }),
        },
      ),
    ).rejects.toThrow("Coordinator offline");
    expect(reads).toBe(1);
    expect(agentManager.listAgents()).toEqual([]);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("direct task creation cannot bypass an excluded provider using stale enabled local settings", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "shared-provider-launch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const binding = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: { codex: { enabled: true } },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const definitions = readInstallationProviders("host", settings.providers);
  try {
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          getSharedProviderConfig: () => settings,
          installationSettingsReader: {
            async read() {
              return {
                ...binding,
                revision: 2,
                installationInstructions: "",
                settings: {
                  ...readInstallationSettings(settings),
                  skillLibrary: [],
                  providerDefinitions: definitions,
                  resourceExclusions: {
                    host: {
                      terminalProfileIds: [],
                      metadataProviderIds: [],
                      providerIds: [definitions[0].id],
                    },
                  },
                },
              };
            },
          },
        },
        {
          kind: "session",
          config: { provider: "codex", cwd: workdir },
          workspaceId: "shared-provider",
          initialPrompt: "Do not start",
          labels: {},
          provisionalTitle: null,
          firstAgentContext: { attachments: [] },
          buildSessionConfig: async (config) => ({ sessionConfig: config }),
        },
      ),
    ).rejects.toThrow("excluded from this environment");
    expect(agentManager.listAgents()).toEqual([]);
    expect(settings.providers.codex.enabled).toBe(true);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("account rebinding during authority lookup rejects the task before registration", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "shared-provider-launch-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const binding = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  let settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: { codex: { enabled: true } },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const definitions = readInstallationProviders("host", settings.providers);
  try {
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          getSharedProviderConfig: () => settings,
          installationSettingsReader: {
            async read() {
              settings = MutableDaemonConfigSchema.parse({
                ...settings,
                providers: {
                  ...settings.providers,
                  codex: { ...settings.providers.codex, env: { CODEX_HOME: "/different-account" } },
                },
              });
              return {
                ...binding,
                revision: 2,
                installationInstructions: "",
                settings: {
                  ...readInstallationSettings(settings),
                  skillLibrary: [],
                  providerDefinitions: definitions,
                },
              };
            },
          },
        },
        {
          kind: "session",
          config: { provider: "codex", cwd: workdir },
          workspaceId: "shared-provider",
          initialPrompt: "Do not start",
          labels: {},
          provisionalTitle: null,
          firstAgentContext: { attachments: [] },
          buildSessionConfig: async (config) => ({ sessionConfig: config }),
        },
      ),
    ).rejects.toThrow("changed during launch");
    expect(agentManager.listAgents()).toEqual([]);
    expect(settings.providers.codex.env).toEqual({ CODEX_HOME: "/different-account" });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});
