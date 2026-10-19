import { queryClient } from "@/data/query-client";
import type { Agent } from "@/stores/session-store";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { removeProjectFromHosts } from "@/projects/project-remove";
import { seedSessionHosts } from "@/test/seed-session";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWorkspaceArchivePending,
  isWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  archiveWorkspaceOptimistically,
  archiveWorkspacesOptimistically,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";

import { selectFactoryMembership } from "@/workspace/lifecycle/factory-membership";

const SERVER_ID = "workspace-archive-test";
const SECOND_SERVER_ID = "workspace-archive-test-2";

type ArchiveWorkspacePayload = Awaited<ReturnType<DaemonClient["archiveWorkspace"]>>;

function archivePayload(input: {
  workspaceId: string;
  error?: string | null;
}): ArchiveWorkspacePayload {
  return {
    requestId: "request",
    workspaceId: input.workspaceId,
    archivedAt: null,
    error: input.error ?? null,
  };
}

function workspace(input?: Partial<WorkspaceDescriptor>): WorkspaceDescriptor {
  return {
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: "/repo/project/workspace-1",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "workspace-1",
    status: "done",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
    ...input,
  };
}

function target(input?: Partial<WorkspaceArchiveTarget>): WorkspaceArchiveTarget {
  const base = workspace();
  return {
    serverId: SERVER_ID,
    workspaceId: base.id,
    ...input,
  };
}

function createClient(
  archiveWorkspace: DaemonClient["archiveWorkspace"],
  schedules: ScheduleSummary[] = [],
): Pick<DaemonClient, "archiveWorkspace" | "scheduleList"> {
  return {
    archiveWorkspace,
    scheduleList: async () => ({ schedules, error: null, requestId: "schedule-list" }),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function storedWorkspaceOn(serverId: string, id: string): WorkspaceDescriptor | undefined {
  return useSessionStore.getState().sessions[serverId]?.workspaces.get(id);
}

function storedWorkspace(id: string): WorkspaceDescriptor | undefined {
  return storedWorkspaceOn(SERVER_ID, id);
}

beforeEach(() => {
  queryClient.clear();
  seedSessionHosts([SERVER_ID, SECOND_SERVER_ID]);
  useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
});

afterEach(() => {
  queryClient.clear();
  seedSessionHosts([]);
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "workspace-1" });
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "workspace-2" });
  clearWorkspaceArchivePending({ serverId: SECOND_SERVER_ID, workspaceId: "workspace-1" });
  clearWorkspaceArchivePending({ serverId: SECOND_SERVER_ID, workspaceId: "workspace-2" });
  useSessionStore.setState((state) => ({ ...state, sessions: {} }));
});

describe("archiveWorkspaceOptimistically", () => {
  it.each([{ protected: true }, { standing: true, protected: true }])(
    "keeps a locked workspace visible without sending an archive request: %j",
    async (lifecycle) => {
      const locked = workspace(lifecycle);
      getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [locked]);
      const calls: string[] = [];
      const client = createClient(async (workspaceId) => {
        calls.push(workspaceId);
        return archivePayload({ workspaceId });
      });
      await expect(archiveWorkspaceOptimistically({ client, workspace: target() })).rejects.toThrow(
        "Unprotect to archive",
      );
      expect(calls).toEqual([]);
      expect(storedWorkspace(locked.id)).toEqual(locked);
      expect(isWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: locked.id })).toBe(
        false,
      );
    },
  );
  it("does not turn a legacy Standing flag into explicit archive protection", async () => {
    const ordinary = workspace({ standing: true, protected: false });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [ordinary]);
    const calls: string[] = [];
    const client = createClient(async (workspaceId) => {
      calls.push(workspaceId);
      return archivePayload({ workspaceId });
    });
    await archiveWorkspaceOptimistically({ client, workspace: target() });
    expect(calls).toEqual([ordinary.id]);
    expect(storedWorkspace(ordinary.id)).toBeUndefined();
  });
  it("hides the workspace and marks the archive pending while the daemon call runs", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const releaseArchive = deferred<ArchiveWorkspacePayload>();
    const client = createClient(vi.fn(async () => releaseArchive.promise));

    const archive = archiveWorkspaceOptimistically({
      client,
      workspace: target(),
    });

    await vi.waitFor(() => expect(storedWorkspace(archived.id)).toBeUndefined());
    expect(
      isWorkspaceArchivePending({
        serverId: SERVER_ID,
        workspaceId: archived.id,
      }),
    ).toBe(true);

    releaseArchive.resolve(archivePayload({ workspaceId: archived.id }));
    await archive;

    expect(storedWorkspace(archived.id)).toBeUndefined();
  });

  it("restores the workspace and clears pending state when the daemon rejects the archive", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const client = createClient(
      vi.fn(async () => archivePayload({ workspaceId: archived.id, error: "nope" })),
    );

    await expect(
      archiveWorkspaceOptimistically({
        client,
        workspace: target(),
      }),
    ).rejects.toThrow("nope");

    expect(storedWorkspace(archived.id)).toEqual(archived);
    expect(
      isWorkspaceArchivePending({
        serverId: SERVER_ID,
        workspaceId: archived.id,
      }),
    ).toBe(false);
  });
});

it.each([true, false])(
  "preflights project protection before archiving ordinary members (visible: %s)",
  async (visible) => {
    const protectedWorkspace = workspace({ protected: true });
    const ordinary = workspace({ id: "workspace-2" });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [protectedWorkspace, ordinary]);
    const archiveWorkspace = vi.fn(async (workspaceId: string) => archivePayload({ workspaceId }));
    const removeProject = vi.fn(async () => ({ removedWorkspaceIds: [] }));
    await expect(
      removeProjectFromHosts({
        targets: [{ serverId: SERVER_ID, projectId: "project-1" }],
        workspaces: visible
          ? [target({ workspaceId: ordinary.id }), target()]
          : [target({ workspaceId: ordinary.id })],
        getClient: () => ({ archiveWorkspace, removeProject }),
      }),
    ).rejects.toThrow("protected workspace");
    expect(archiveWorkspace).not.toHaveBeenCalled();
    expect(removeProject).not.toHaveBeenCalled();
  },
);

describe("archiveWorkspacesOptimistically", () => {
  it("keeps protected workspaces visible and skips their daemon calls in a bulk archive", async () => {
    const protectedWorkspace = workspace({ protected: true });
    const ordinary = workspace({ id: "workspace-2" });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [protectedWorkspace, ordinary]);
    const archive = vi.fn(async (workspaceId: string) => archivePayload({ workspaceId }));
    const failures = await archiveWorkspacesOptimistically({
      getClient: () => createClient(archive),
      workspaces: [target(), target({ workspaceId: ordinary.id })],
    });
    expect(archive).toHaveBeenCalledExactlyOnceWith(ordinary.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.workspaceId).toBe(protectedWorkspace.id);
    expect(storedWorkspace(protectedWorkspace.id)).toEqual(protectedWorkspace);
    expect(isWorkspaceArchivePending(target())).toBe(false);
    expect(storedWorkspace(ordinary.id)).toBeUndefined();
  });

  it("returns failures and restores only the workspaces whose archive failed", async () => {
    const first = workspace({ id: "workspace-1" });
    const second = workspace({
      id: "workspace-2",
      workspaceDirectory: "/repo/project/workspace-2",
      name: "workspace-2",
    });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [first, second]);
    const client = createClient(
      vi.fn(async (workspaceId) =>
        archivePayload({
          workspaceId,
          error: workspaceId === second.id ? "failed" : null,
        }),
      ),
    );

    const failures = await archiveWorkspacesOptimistically({
      getClient: () => client,
      workspaces: [target({ workspaceId: first.id }), target({ workspaceId: second.id })],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.workspaceId).toBe(second.id);
    expect(storedWorkspace(first.id)).toBeUndefined();
    expect(storedWorkspace(second.id)).toEqual(second);
  });

  it("archives each workspace through its own server client", async () => {
    const first = workspace({ id: "workspace-1" });
    const second = workspace({
      id: "workspace-2",
      workspaceDirectory: "/repo/project/workspace-2",
      name: "workspace-2",
    });
    useSessionStore.getState().initializeSession(SECOND_SERVER_ID, {} as DaemonClient);
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [first]);
    getHostRuntimeStore().acceptWorkspaceSnapshots(SECOND_SERVER_ID, [second]);

    const archivedByServer = new Map<string, string[]>();
    const clientFor = (serverId: string) =>
      createClient(async (workspaceId) => {
        archivedByServer.set(serverId, [...(archivedByServer.get(serverId) ?? []), workspaceId]);
        return archivePayload({ workspaceId });
      });

    const failures = await archiveWorkspacesOptimistically({
      getClient: (serverId) => clientFor(serverId),
      workspaces: [
        target({
          serverId: SERVER_ID,
          workspaceId: first.id,
        }),
        target({
          serverId: SECOND_SERVER_ID,
          workspaceId: second.id,
        }),
      ],
    });

    expect(failures).toEqual([]);
    expect(archivedByServer).toEqual(
      new Map([
        [SERVER_ID, [first.id]],
        [SECOND_SERVER_ID, [second.id]],
      ]),
    );
    expect(storedWorkspaceOn(SERVER_ID, first.id)).toBeUndefined();
    expect(storedWorkspaceOn(SECOND_SERVER_ID, second.id)).toBeUndefined();
  });
});

it("archives explicitly bound environments before the visible workspace", async () => {
  const original = workspace();
  const companion = workspace({
    id: "workspace-2",
    workspaceKind: "directory",
    projectMembership: { key: "project-1", name: "Project", environmentOwner: target() },
  });
  getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [original]);
  useSessionStore.getState().initializeSession(SECOND_SERVER_ID, {} as DaemonClient);
  getHostRuntimeStore().acceptWorkspaceSnapshots(SECOND_SERVER_ID, [companion]);
  const calls: string[] = [];
  const secondary = createClient(async (id) => {
    calls.push(id);
    return archivePayload({ workspaceId: id });
  });
  const getClient = vi
    .spyOn(getHostRuntimeStore(), "getClient")
    .mockReturnValue(secondary as DaemonClient);
  try {
    await archiveWorkspaceOptimistically({
      workspace: target(),
      client: createClient(async (id) => {
        calls.push(id);
        return archivePayload({ workspaceId: id });
      }),
    });
    expect(calls).toEqual(["workspace-2", "workspace-1"]);
    expect(storedWorkspaceOn(SECOND_SERVER_ID, companion.id)).toBeUndefined();
  } finally {
    getClient.mockRestore();
  }
});

it("keeps the visible workspace when its other environment cannot be archived", async () => {
  const original = workspace();
  getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [original]);
  useSessionStore.getState().initializeSession(SECOND_SERVER_ID, {} as DaemonClient);
  getHostRuntimeStore().acceptWorkspaceSnapshots(SECOND_SERVER_ID, [
    workspace({
      id: "workspace-2",
      projectMembership: { key: "project-1", name: "Project", environmentOwner: target() },
    }),
  ]);
  const archive = vi.fn(async (id: string) => archivePayload({ workspaceId: id }));
  const getClient = vi.spyOn(getHostRuntimeStore(), "getClient").mockReturnValue(null);
  try {
    await expect(
      archiveWorkspaceOptimistically({ workspace: target(), client: createClient(archive) }),
    ).rejects.toThrow("Reconnect all workspace environments");
    expect(archive).not.toHaveBeenCalled();
    expect(storedWorkspace(original.id)).toEqual(original);
  } finally {
    getClient.mockRestore();
  }
});

it("preflights protected companion workspaces before any archive call", async () => {
  const original = workspace();
  getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [original]);
  useSessionStore.getState().initializeSession(SECOND_SERVER_ID, {} as DaemonClient);
  const membership = { key: "project-1", name: "Project", environmentOwner: target() };
  getHostRuntimeStore().acceptWorkspaceSnapshots(SECOND_SERVER_ID, [
    workspace({ id: "workspace-2", projectMembership: membership }),
    workspace({ id: "workspace-protected", projectMembership: membership, protected: true }),
  ]);
  const archive = vi.fn(async (id: string) => archivePayload({ workspaceId: id }));
  const getClient = vi
    .spyOn(getHostRuntimeStore(), "getClient")
    .mockReturnValue(createClient(archive) as DaemonClient);
  try {
    await expect(
      archiveWorkspaceOptimistically({ workspace: target(), client: createClient(archive) }),
    ).rejects.toThrow("Unprotect to archive");
    expect(archive).not.toHaveBeenCalled();
    expect(storedWorkspace(original.id)).toEqual(original);
    expect(storedWorkspaceOn(SECOND_SERVER_ID, "workspace-2")).toBeDefined();
  } finally {
    getClient.mockRestore();
  }
});

it("refreshes a stale scheduled companion before archiving any environment", async () => {
  const original = workspace();
  const membership = { key: "project-1", name: "Project", environmentOwner: target() };
  const ordinary = workspace({ id: "workspace-2", projectMembership: membership });
  const scheduled = workspace({ id: "workspace-scheduled", projectMembership: membership });
  getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [original]);
  useSessionStore.getState().initializeSession(SECOND_SERVER_ID, null);
  getHostRuntimeStore().acceptWorkspaceSnapshots(SECOND_SERVER_ID, [ordinary, scheduled]);
  const timestamp = new Date("2026-10-07T00:00:00Z");
  const agent: Agent = {
    id: "schedule-target",
    serverId: SECOND_SERVER_ID,
    workspaceId: scheduled.id,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUserMessageAt: null,
    lastActivityAt: timestamp,
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
    title: null,
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
  };
  useSessionStore.getState().setAgents(SECOND_SERVER_ID, new Map([[agent.id, agent]]));
  queryClient.setQueryData(["schedules", "workspace-indicators", SECOND_SERVER_ID], []);
  const schedule: ScheduleSummary = {
    id: "new-schedule",
    name: null,
    prompt: "Review",
    cadence: { type: "every", everyMs: 60_000 },
    target: { type: "agent", agentId: agent.id },
    status: "paused",
    createdAt: timestamp.toISOString(),
    updatedAt: timestamp.toISOString(),
    nextRunAt: null,
    lastRunAt: null,
    pausedAt: timestamp.toISOString(),
    expiresAt: null,
    maxRuns: null,
  };
  const archived: string[] = [];
  let started = false;
  const owner = createClient(async (id) => {
    archived.push(id);
    return archivePayload({ workspaceId: id });
  });
  const companion = createClient(
    async (id) => {
      archived.push(id);
      return archivePayload({ workspaceId: id });
    },
    [schedule],
  );
  await expect(
    archiveWorkspaceOptimistically({
      client: owner,
      workspace: target(),
      getCompanionClient: () => companion,
      onArchiveStarted: () => {
        started = true;
      },
    }),
  ).rejects.toThrow("Remove schedules to archive");
  expect(archived).toEqual([]);
  expect(started).toBe(false);
  expect(storedWorkspace(original.id)).toEqual(original);
  expect(storedWorkspaceOn(SECOND_SERVER_ID, ordinary.id)).toEqual(ordinary);
  expect(storedWorkspaceOn(SECOND_SERVER_ID, scheduled.id)).toEqual(scheduled);
  expect(isWorkspaceArchivePending(target())).toBe(false);
});

describe("native Factory managed workspace protection", () => {
  function seedFactory(input: Partial<WorkspaceDescriptor> = {}) {
    const member = workspace({
      protected: false,
      factoryMembership: {
        installationId: "installation",
        serverId: SERVER_ID,
        projectId: "project-1",
        role: "factory",
      },
      ...input,
    });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [member]);
    useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: null,
      version: null,
      features: { factoryWorkspaceMembership: true },
    });
    return member;
  }

  it.each(["factory", "builds", "worker"] as const)(
    "blocks ordinary archive for native %s membership without relying on protection labels",
    async (role) => {
      const member = seedFactory({
        factoryMembership: {
          installationId: "installation",
          serverId: SERVER_ID,
          projectId: "project-1",
          role,
        },
      });
      const archive = vi.fn(async (workspaceId: string) => archivePayload({ workspaceId }));
      await expect(
        archiveWorkspaceOptimistically({ client: createClient(archive), workspace: target() }),
      ).rejects.toThrow("Turn Factory off");
      expect(archive).not.toHaveBeenCalled();
      expect(storedWorkspace(member.id)).toEqual(member);
      expect(isWorkspaceArchivePending(target())).toBe(false);
    },
  );

  it.each(["host", "project", "handshake", "capability", "unbound"])(
    "does not infer management from a title or tag when %s is unverified",
    (missing) => {
      const member = seedFactory({
        name: "Freed Factory",
        labels: ["Factory", "Managed"],
        protected: missing === "unbound",
      });
      if (missing === "host" && member.factoryMembership)
        member.factoryMembership.serverId = SECOND_SERVER_ID;
      if (missing === "project" && member.factoryMembership)
        member.factoryMembership.projectId = "another-project";
      if (missing === "unbound") member.factoryMembership = undefined;
      getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [member]);
      if (missing === "handshake" || missing === "capability") {
        useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
          serverId: missing === "handshake" ? SECOND_SERVER_ID : SERVER_ID,
          hostname: null,
          version: null,
          features: { factoryWorkspaceMembership: missing !== "capability" },
        });
      }
      expect(selectFactoryMembership(useSessionStore.getState(), SERVER_ID, member.id)).toBeNull();
    },
  );

  it("keeps managed members visible while bulk archive proceeds for ordinary work", async () => {
    const member = seedFactory();
    const ordinary = workspace({ id: "workspace-2" });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [ordinary]);
    const archive = vi.fn(async (workspaceId: string) => archivePayload({ workspaceId }));
    const failures = await archiveWorkspacesOptimistically({
      getClient: () => createClient(archive),
      workspaces: [target(), target({ workspaceId: ordinary.id })],
    });
    expect(archive).toHaveBeenCalledExactlyOnceWith(ordinary.id);
    expect(failures.map((failure) => failure.workspaceId)).toEqual([member.id]);
    expect(storedWorkspace(member.id)).toEqual(member);
  });

  it.each([true, false])(
    "blocks project deletion before any ordinary member is archived (visible: %s)",
    async (visible) => {
      seedFactory();
      const ordinary = workspace({ id: "workspace-2" });
      getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [ordinary]);
      const archiveWorkspace = vi.fn(async (workspaceId: string) =>
        archivePayload({ workspaceId }),
      );
      const removeProject = vi.fn(async () => ({ removedWorkspaceIds: [] }));
      await expect(
        removeProjectFromHosts({
          targets: [{ serverId: SERVER_ID, projectId: "project-1" }],
          workspaces: visible
            ? [target(), target({ workspaceId: ordinary.id })]
            : [target({ workspaceId: ordinary.id })],
          getClient: () => ({ archiveWorkspace, removeProject }),
        }),
      ).rejects.toThrow("Turn Factory off");
      expect(archiveWorkspace).not.toHaveBeenCalled();
      expect(removeProject).not.toHaveBeenCalled();
    },
  );
});

describe("archive preflight lifecycle changes", () => {
  function seedEnvironments() {
    const owner = workspace();
    const companion = workspace({
      id: "workspace-2",
      projectMembership: { key: "project-1", name: "Project", environmentOwner: target() },
    });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [owner]);
    useSessionStore.getState().initializeSession(SECOND_SERVER_ID, null);
    getHostRuntimeStore().acceptWorkspaceSnapshots(SECOND_SERVER_ID, [companion]);
    useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: null,
      version: null,
      features: { factoryWorkspaceMembership: true },
    });
    return { owner, companion };
  }

  function protectOwner(owner: WorkspaceDescriptor, managed: boolean) {
    const updated = workspace({
      ...owner,
      protected: true,
      factoryMembership: managed
        ? {
            installationId: "installation",
            serverId: SERVER_ID,
            projectId: "project-1",
            role: "factory",
          }
        : undefined,
    });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [updated]);
    return updated;
  }

  it.each([true, false])(
    "refuses with zero effects when companion refresh changes owner lifecycle (managed: %s)",
    async (managed) => {
      const { owner, companion } = seedEnvironments();
      const refreshing = deferred<void>();
      const refresh = deferred<ScheduleSummary[]>();
      const archived: string[] = [];
      let started = false;
      const ownerClient = createClient(async (id) => {
        archived.push(id);
        return archivePayload({ workspaceId: id });
      });
      const companionClient: Pick<DaemonClient, "archiveWorkspace" | "scheduleList"> = {
        archiveWorkspace: async (id) => {
          archived.push(id);
          return archivePayload({ workspaceId: id });
        },
        scheduleList: async () => {
          refreshing.resolve();
          const schedules = await refresh.promise;
          return { schedules, error: null, requestId: "schedule-list" };
        },
      };
      const result = archiveWorkspaceOptimistically({
        client: ownerClient,
        workspace: target(),
        getCompanionClient: () => companionClient,
        onArchiveStarted: () => {
          started = true;
        },
      });
      const rejected = expect(result).rejects.toThrow(/Turn Factory off|Unprotect to archive/);
      await refreshing.promise;
      const updated = protectOwner(owner, managed);
      refresh.resolve([]);
      await rejected;
      expect(archived).toEqual([]);
      expect(started).toBe(false);
      expect(storedWorkspace(owner.id)).toEqual(updated);
      expect(storedWorkspaceOn(SECOND_SERVER_ID, companion.id)).toEqual(companion);
      expect(isWorkspaceArchivePending(target())).toBe(false);
    },
  );

  it("refuses later owner dispatch when membership changes during companion archive", async () => {
    const { owner, companion } = seedEnvironments();
    const archiving = deferred<void>();
    const completed = deferred<ArchiveWorkspacePayload>();
    const archived: string[] = [];
    const ownerClient = createClient(async (id) => {
      archived.push(id);
      return archivePayload({ workspaceId: id });
    });
    const companionClient = createClient(async (id) => {
      archived.push(id);
      archiving.resolve();
      return completed.promise;
    });
    const result = archiveWorkspaceOptimistically({
      client: ownerClient,
      workspace: target(),
      getCompanionClient: () => companionClient,
    });
    const rejected = expect(result).rejects.toThrow("Turn Factory off");
    await archiving.promise;
    const updated = protectOwner(owner, true);
    completed.resolve(archivePayload({ workspaceId: companion.id }));
    await rejected;
    expect(archived).toEqual([companion.id]);
    expect(storedWorkspace(owner.id)).toEqual(updated);
    expect(storedWorkspaceOn(SECOND_SERVER_ID, companion.id)).toEqual(companion);
    expect(isWorkspaceArchivePending(target())).toBe(false);
  });
});
