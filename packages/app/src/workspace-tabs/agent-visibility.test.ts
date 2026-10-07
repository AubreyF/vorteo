import { describe, expect, it, vi } from "vitest";
import { getAgentPresentationIndex } from "@/subagents/policies";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import {
  buildWorkspaceTabSnapshot,
  deriveEnvironmentWorkspaceAgentVisibility,
  deriveWorkspaceAgentVisibility,
  shouldPruneWorkspaceAgentTab,
  workspaceAgentVisibilityEqual,
} from "@/workspace-tabs/agent-visibility";

function makeAgent(input: {
  id: string;
  cwd: string;
  workspaceId?: string;
  parentAgentId?: string | null;
  archivedAt?: Date | null;
  createdAt?: Date;
  lastActivityAt?: Date;
}): Agent {
  const createdAt = input.createdAt ?? new Date("2026-03-04T00:00:00.000Z");
  const lastActivityAt = input.lastActivityAt ?? createdAt;
  return {
    serverId: "srv",
    id: input.id,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt,
    updatedAt: createdAt,
    lastUserMessageAt: null,
    lastActivityAt,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    model: null,
    thinkingOptionId: null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
  };
}

const WORKSPACE_ID = "ws-1";

describe("workspace agent visibility", () => {
  it("keeps subagents active while excluding them from auto-open", () => {
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([
        [parent.id, parent],
        [child.id, child],
      ]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["parent-agent", "child-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["parent-agent"]));
  });

  it("excludes archived subagents from active and auto-open", () => {
    const archivedChild = makeAgent({
      id: "archived-child",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([[archivedChild.id, archivedChild]]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
    expect(result.autoOpenAgentIds).toEqual(new Set<string>());
  });

  it("excludes a child from auto-open even when its snapshot arrives before the parent", () => {
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
    });
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([
        [child.id, child],
        [parent.id, parent],
      ]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["child-agent", "parent-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["parent-agent"]));
  });

  it("presents an isolated worker beneath its parent without changing execution identity", () => {
    const parent = makeAgent({ id: "parent", cwd: "/repo", workspaceId: "parent-workspace" });
    const child = makeAgent({
      id: "worker",
      cwd: "/isolated/worktree",
      workspaceId: "worker-workspace",
      parentAgentId: parent.id,
    });
    const sessionAgents = new Map([
      [parent.id, parent],
      [child.id, child],
    ]);
    const parentView = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: parent.workspaceId,
    });
    expect(parentView.activeAgentIds).toEqual(new Set(["parent", "worker"]));
    expect(parentView.autoOpenAgentIds).toEqual(new Set(["parent"]));
    expect(
      deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: child.workspaceId })
        .activeAgentIds,
    ).toEqual(new Set());
    expect(child.workspaceId).toBe("worker-workspace");
    expect(child.cwd).toBe("/isolated/worktree");
  });

  it("excludes archived agents from the active directory", () => {
    const visible = makeAgent({
      id: "visible-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    const archived = makeAgent({
      id: "archived-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
      createdAt: new Date("2026-03-04T00:01:00.000Z"),
    });
    const otherWorkspace = makeAgent({
      id: "other-workspace-agent",
      cwd: "/repo/other",
      workspaceId: "ws-other",
    });

    const sessionAgents = new Map<string, Agent>([
      [visible.id, visible],
      [archived.id, archived],
      [otherWorkspace.id, otherWorkspace],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["visible-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["visible-agent"]));
  });

  it("does not make historical details active", () => {
    const active = makeAgent({
      id: "active-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });
    const historicalDetail = makeAgent({
      id: "historical-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map([[active.id, active]]),
      agentDetails: new Map([[historicalDetail.id, historicalDetail]]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["active-agent"]));
  });

  it("prunes archived agent tabs so archiving on one client closes tabs on all clients", () => {
    const activeAgentIds = new Set<string>();

    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "archived-agent",
        agentsHydrated: true,
        activeAgentIds,
      }),
    ).toBe(true);
  });

  it("prunes pinned archived agent tabs because archive state is authoritative", () => {
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "archived-agent",
        agentsHydrated: true,
        activeAgentIds: new Set<string>(),
      }),
    ).toBe(true);
  });

  it("does not prune active agent tabs", () => {
    const activeAgentIds = new Set(["active-agent"]);

    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "active-agent",
        agentsHydrated: true,
        activeAgentIds,
      }),
    ).toBe(false);
  });

  it("prunes agent tabs once agents are hydrated and the agent is missing from activeAgentIds", () => {
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "missing-agent",
        agentsHydrated: true,
        activeAgentIds: new Set<string>(),
      }),
    ).toBe(true);
  });

  it("matches agents by workspaceId regardless of cwd", () => {
    const sessionAgents = new Map<string, Agent>([
      [
        "stamped-agent",
        makeAgent({
          id: "stamped-agent",
          cwd: "/repo/subdir",
          workspaceId: "ws-1",
        }),
      ],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set(["stamped-agent"]));
  });

  it("excludes a stamped agent whose workspaceId belongs to another workspace sharing the cwd", () => {
    const sessionAgents = new Map<string, Agent>([
      [
        "other-ws-agent",
        makeAgent({
          id: "other-ws-agent",
          cwd: "/repo/worktree",
          workspaceId: "ws-2",
        }),
      ],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
  });

  it("excludes agents without a workspaceId", () => {
    const sessionAgents = new Map<string, Agent>([
      ["ownerless-agent", makeAgent({ id: "ownerless-agent", cwd: "/repo/worktree" })],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
  });

  it("builds the tab reconciliation snapshot without callers unpacking agent visibility", () => {
    const agentVisibility = {
      activeAgentIds: new Set(["active-agent"]),
      autoOpenAgentIds: new Set(["root-agent"]),
    };

    expect(
      buildWorkspaceTabSnapshot({
        agentVisibility,
        agentsHydrated: true,
        terminalsHydrated: true,
        knownTerminalIds: ["terminal-1", "script-terminal"],
        standaloneTerminalIds: ["terminal-1"],
        hasActivePendingTerminalCreate: false,
        hasActivePendingDraftCreate: false,
      }),
    ).toEqual({
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: agentVisibility.activeAgentIds,
      autoOpenAgentIds: agentVisibility.autoOpenAgentIds,
      knownTerminalIds: ["terminal-1", "script-terminal"],
      standaloneTerminalIds: ["terminal-1"],
      hasActivePendingTerminalCreate: false,
      hasActivePendingDraftCreate: false,
    });
  });

  describe("workspaceAgentVisibilityEqual", () => {
    it("returns true for identical sets", () => {
      const a = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
      };
      const b = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(true);
    });

    it("returns false when activeAgentIds differ", () => {
      const a = {
        activeAgentIds: new Set(["a"]),
        autoOpenAgentIds: new Set(["a"]),
      };
      const b = {
        activeAgentIds: new Set(["b"]),
        autoOpenAgentIds: new Set(["a"]),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns false when autoOpenAgentIds differ", () => {
      const a = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
      };
      const b = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["b"]),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns true for empty sets", () => {
      const a = {
        activeAgentIds: new Set<string>(),
        autoOpenAgentIds: new Set<string>(),
      };
      const b = {
        activeAgentIds: new Set<string>(),
        autoOpenAgentIds: new Set<string>(),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(true);
    });
  });
});

describe("managed worker presentation", () => {
  it("keeps nested descendants in the originating task with independent tasks alongside them", () => {
    const parent = makeAgent({ id: "parent", workspaceId: "origin", cwd: "/repo" });
    const child = makeAgent({
      id: "child",
      workspaceId: "worktree-one",
      cwd: "/worktrees/one",
      parentAgentId: "parent",
    });
    const grandchild = makeAgent({
      id: "grandchild",
      workspaceId: "worktree-two",
      cwd: "/worktrees/two",
      parentAgentId: "child",
    });
    const independent = makeAgent({
      id: "independent",
      workspaceId: "worktree-one",
      cwd: "/worktrees/one",
    });
    const sessionAgents = new Map(
      [parent, child, grandchild, independent].map((entry) => [entry.id, entry]),
    );
    const origin = deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: "origin" });
    expect(origin.activeAgentIds).toEqual(new Set(["parent", "child", "grandchild"]));
    expect(origin.autoOpenAgentIds).toEqual(new Set(["parent"]));
    const worktree = deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: "worktree-one" });
    expect(worktree.activeAgentIds).toEqual(new Set(["independent"]));
    expect(worktree.autoOpenAgentIds).toEqual(new Set(["independent"]));
    expect(grandchild.cwd).toBe("/worktrees/two");
    expect(grandchild.workspaceId).toBe("worktree-two");
  });
  it.each(["missing", "archived"])("keeps a worker visible when its parent is %s", (state) => {
    const child = makeAgent({
      id: "child",
      workspaceId: "worktree",
      cwd: "/worktree",
      parentAgentId: "parent",
    });
    const sessionAgents = new Map([[child.id, child]]);
    if (state === "archived")
      sessionAgents.set(
        "parent",
        makeAgent({ id: "parent", workspaceId: "origin", cwd: "/repo", archivedAt: new Date(1) }),
      );
    const result = deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: "worktree" });
    expect(result.activeAgentIds).toEqual(new Set(["child"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["child"]));
  });
  it("keeps descendants with the nearest live ancestor when the originating parent is absent", () => {
    const child = makeAgent({
      id: "child",
      workspaceId: "worktree",
      cwd: "/worktree",
      parentAgentId: "absent",
    });
    const grandchild = makeAgent({
      id: "grandchild",
      workspaceId: "nested",
      cwd: "/nested",
      parentAgentId: "child",
    });
    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map([
        [child.id, child],
        [grandchild.id, grandchild],
      ]),
      workspaceId: "worktree",
    });
    expect(result.activeAgentIds).toEqual(new Set(["child", "grandchild"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["child"]));
  });
  it("does not hide workers whose parent metadata contains a cycle", () => {
    const one = makeAgent({
      id: "one",
      workspaceId: "one-workspace",
      cwd: "/one",
      parentAgentId: "two",
    });
    const two = makeAgent({
      id: "two",
      workspaceId: "two-workspace",
      cwd: "/two",
      parentAgentId: "one",
    });
    const sessionAgents = new Map([
      [one.id, one],
      [two.id, two],
    ]);
    expect(
      deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: one.workspaceId })
        .autoOpenAgentIds,
    ).toEqual(new Set(["one"]));
    expect(
      deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: two.workspaceId })
        .autoOpenAgentIds,
    ).toEqual(new Set(["two"]));
  });
});

it("keeps a worker accessible if its parent workspace is no longer in the active directory", () => {
  const parent = makeAgent({ id: "parent", workspaceId: "gone", cwd: "/repo" });
  const child = makeAgent({
    id: "child",
    workspaceId: "execution",
    cwd: "/worktree",
    parentAgentId: "parent",
  });
  const sessionAgents = new Map([
    [parent.id, parent],
    [child.id, child],
  ]);
  const result = deriveWorkspaceAgentVisibility({
    sessionAgents,
    workspaceId: "execution",
    workspaces: new Map(),
  });
  expect(result.activeAgentIds).toEqual(new Set(["child"]));
  expect(result.autoOpenAgentIds).toEqual(new Set(["child"]));
});
it("reuses ancestry indexes without rescanning unchanged metadata and separates workspace availability contexts", () => {
  const parent = makeAgent({ id: "parent", workspaceId: "origin", cwd: "/repo" });
  const child = makeAgent({
    id: "child",
    workspaceId: "execution",
    cwd: "/worktree",
    parentAgentId: "parent",
  });
  const agents = new Map([
    [parent.id, parent],
    [child.id, child],
  ]);
  const withoutDirectory = getAgentPresentationIndex(agents);
  const unavailableWorkspaces = new Map<string, WorkspaceDescriptor>();
  const withDirectory = getAgentPresentationIndex(agents, unavailableWorkspaces);
  expect(withoutDirectory.get("child")?.workspaceId).toBe("origin");
  expect(withDirectory.get("child")?.workspaceId).toBe("execution");
  const scanning = vi.spyOn(agents, "values").mockImplementation(() => {
    throw new Error("Unexpected ancestry rescan");
  });
  try {
    expect(getAgentPresentationIndex(agents)).toBe(withoutDirectory);
    expect(getAgentPresentationIndex(agents, unavailableWorkspaces)).toBe(withDirectory);
  } finally {
    scanning.mockRestore();
  }
  const archived = new Map(agents);
  archived.set(parent.id, { ...parent, archivedAt: new Date(1) });
  expect(getAgentPresentationIndex(archived).get("child")?.workspaceId).toBe("execution");
});

it("keeps execution-workspace recovery when the parent workspace remains available", () => {
  const parent = makeAgent({ id: "parent", workspaceId: "origin", cwd: "/repo" });
  const child = makeAgent({
    id: "child",
    workspaceId: "execution",
    cwd: "/worktree",
    parentAgentId: "parent",
  });
  const origin: WorkspaceDescriptor = {
    id: "origin",
    projectId: "project",
    projectDisplayName: "project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "origin",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
  const sessionAgents = new Map([
    [parent.id, parent],
    [child.id, child],
  ]);
  const result = deriveWorkspaceAgentVisibility({
    sessionAgents,
    workspaceId: "execution",
    workspaces: new Map([[origin.id, origin]]),
  });
  expect(result.activeAgentIds).toEqual(new Set(["child"]));
  expect(result.autoOpenAgentIds).toEqual(new Set(["child"]));
});

it("does not prune saved destination tabs before the owning workspace hydrates", () => {
  const visibility = deriveEnvironmentWorkspaceAgentVisibility({
    serverId: "host",
    workspaceId: "source",
    sessions: {
      container: {
        agents: new Map(),
        agentDetails: new Map(),
        workspaces: new Map(),
        hasHydratedAgents: true,
        hasHydratedWorkspaces: true,
      },
    },
  });
  expect(visibility.hydratedEnvironmentIds).toEqual(new Set());
});
