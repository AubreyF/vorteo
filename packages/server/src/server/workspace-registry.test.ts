import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  FactoryMembershipService,
  FactoryMembershipPersistedError,
} from "./workspace-lifecycle/factory-membership-service.js";
import {
  createFactoryCoordinatorBinder,
  FactoryCoordinatorBindingError,
} from "./factory/create-coordinator-binder.js";
import { captureFactoryCoordinatorAuthority } from "./factory/coordinator-authority.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import { FactoryInstallCheckpointError } from "./factory/install-checkpoint.js";
import { setWorkspaceLifecycle } from "./workspace-lifecycle/policy.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
} from "./workspace-registry.js";

describe("resolveWorkspaceName", () => {
  test("prefers the user-set title over the derived display name", () => {
    expect(
      resolveWorkspaceName({ title: "Payments work", derivedDisplayName: "feature/payments" }),
    ).toBe("Payments work");
  });

  test("falls back to the derived display name when there is no title", () => {
    expect(resolveWorkspaceName({ title: null, derivedDisplayName: "feature/payments" })).toBe(
      "feature/payments",
    );
  });

  test("resolveWorkspaceDisplayName applies the same rule over the persisted record", () => {
    const record = createPersistedWorkspaceRecord({
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      title: "Renamed",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(resolveWorkspaceDisplayName(record)).toBe("Renamed");
    expect(resolveWorkspaceDisplayName({ ...record, title: null })).toBe("main");
  });
});

describe("workspace registries", () => {
  let tmpDir: string;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-registry-"));
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function factorySetup() {
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "factory-project",
        rootPath: tmpDir,
        kind: "git",
        displayName: "Factory tests",
        createdAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:00:00.000Z",
      }),
    );
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "factory-member",
      projectId: "factory-project",
      cwd: tmpDir,
      kind: "directory",
      displayName: "Unrelated title",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    });
    await workspaceRegistry.upsert(workspace);
    return workspace;
  }

  function membershipService() {
    return new FactoryMembershipService({
      serverId: "factory-host",
      projects: projectRegistry,
      workspaces: workspaceRegistry,
      authority: {
        authorize: async ({ workspace, role, operationId }) => ({
          workspaceId: workspace.workspaceId,
          operationId,
          membership: {
            installationId: "installation",
            serverId: "factory-host",
            projectId: workspace.projectId,
            role,
          },
          revision: "revision",
          assertCurrent: () => {},
        }),
      },
    });
  }

  async function pendingInstallation() {
    await factorySetup();
    const expected = await projectRegistry.get("factory-project");
    if (!expected) throw new Error("Isolated project fixture missing");
    return {
      expected,
      checkpoint: {
        serverId: "factory-host",
        projectId: expected.projectId,
        installationId: "installation-test",
        operationId: "attempt-one",
        revision: "initial-revision",
        observedAt: "2026-10-08T00:00:00.000Z",
        stage: "binding" as const,
        coordinators: {
          factory: { workspaceId: "factory-workspace", agentId: "factory-agent" },
          builds: { workspaceId: "builds-workspace", agentId: "builds-agent" },
        },
      },
      assertCurrent() {},
    };
  }

  test("native Factory installation checkpoint survives reload and rejects a fresh attempt", async () => {
    const input = await pendingInstallation();
    const pending = await projectRegistry.beginFactoryInstallation(input);
    const reloaded = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    expect(await reloaded.get(input.expected.projectId)).toEqual(pending);
    await expect(
      reloaded.beginFactoryInstallation({
        ...input,
        expected: pending,
        checkpoint: { ...input.checkpoint, operationId: "attempt-two" },
      }),
    ).rejects.toThrow("reconciliation");
    expect(await reloaded.get(input.expected.projectId)).toEqual(pending);
  });

  test("ordinary project operations cannot inject, clear or retire native Factory installation state", async () => {
    const input = await pendingInstallation();
    await expect(
      projectRegistry.upsert({ ...input.expected, factoryInstallation: input.checkpoint }),
    ).rejects.toThrow("native installation operation");
    const pending = await projectRegistry.beginFactoryInstallation(input);
    await expect(projectRegistry.upsert(input.expected)).rejects.toThrow(
      "native installation operation",
    );
    await expect(
      projectRegistry.update(pending.projectId, (current) => {
        delete current.factoryInstallation;
        return current;
      }),
    ).rejects.toThrow("native installation operation");
    await expect(
      projectRegistry.archive(pending.projectId, "2026-10-08T01:00:00.000Z"),
    ).rejects.toThrow("owner disable");
    await expect(projectRegistry.remove(pending.projectId)).rejects.toThrow("owner disable");
    expect(await projectRegistry.get(pending.projectId)).toEqual(pending);
  });

  test("native Factory completion requires the exact retained attempt and preserves the durable binding", async () => {
    const input = await pendingInstallation();
    const pending = await projectRegistry.beginFactoryInstallation(input);
    const checkpoint = {
      ...input.checkpoint,
      stage: "attached" as const,
      revision: "attached-revision",
    };
    await expect(
      projectRegistry.completeFactoryInstallation({
        ...input,
        expected: pending,
        checkpoint: { ...checkpoint, operationId: "attempt-two" },
      }),
    ).rejects.toThrow("retained attempt");
    await expect(
      projectRegistry.completeFactoryInstallation({
        ...input,
        expected: pending,
        checkpoint: { ...checkpoint, revision: input.checkpoint.revision },
      }),
    ).rejects.toThrow("retained attempt");
    const attached = await projectRegistry.completeFactoryInstallation({
      ...input,
      expected: pending,
      checkpoint,
    });
    const reloaded = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    expect((await reloaded.get(pending.projectId))?.factoryInstallation).toEqual(checkpoint);
    expect(attached.factoryInstallation).toEqual(checkpoint);
  });

  test("native Factory checkpoint rejects project drift and owner loss before persistence", async () => {
    const input = await pendingInstallation();
    await projectRegistry.update(input.expected.projectId, (current) => ({
      ...current,
      displayName: "Changed project",
    }));
    await expect(projectRegistry.beginFactoryInstallation(input)).rejects.toThrow(
      "project changed",
    );
    const expected = await projectRegistry.get(input.expected.projectId);
    if (!expected) throw new Error("Isolated project fixture missing");
    await expect(
      projectRegistry.beginFactoryInstallation({
        ...input,
        expected,
        assertCurrent() {
          throw new Error("Owner lost");
        },
      }),
    ).rejects.toThrow("Owner lost");
    expect((await projectRegistry.get(expected.projectId))?.factoryInstallation).toBeUndefined();
  });

  test("native Factory checkpoint write uncertainty blocks mutation and retains disk state across reload", async () => {
    const input = await pendingInstallation();
    const uncertain = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
      {
        writeRecords: async (filePath, records) => {
          await writeJsonFileAtomic(filePath, records);
          throw new Error("Write acknowledgment lost");
        },
      },
    );
    await expect(uncertain.beginFactoryInstallation(input)).rejects.toBeInstanceOf(
      FactoryInstallCheckpointError,
    );
    await expect(uncertain.beginFactoryInstallation(input)).rejects.toThrow("blocked");
    const reloaded = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    const pending = await reloaded.get(input.expected.projectId);
    expect(pending?.factoryInstallation).toEqual(input.checkpoint);
    if (!pending) throw new Error("Durable pending checkpoint missing");
    await expect(
      reloaded.beginFactoryInstallation({ ...input, expected: pending }),
    ).rejects.toThrow("reconciliation");
  });

  test("native Factory checkpoint reports caller drift after persistence without storing unverified IDs", async () => {
    const input = await pendingInstallation();
    const captured = structuredClone(input.checkpoint);
    const registry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
      {
        writeRecords: async (filePath, records) => {
          await writeJsonFileAtomic(filePath, records);
          input.checkpoint = {
            ...input.checkpoint,
            coordinators: {
              ...input.checkpoint.coordinators,
              factory: { workspaceId: "unverified-workspace", agentId: "unverified-agent" },
            },
          };
        },
      },
    );
    await expect(registry.beginFactoryInstallation(input)).rejects.toMatchObject({
      name: "FactoryInstallCheckpointError",
      operationId: captured.operationId,
      installationId: captured.installationId,
      reconciliationRequired: true,
    });
    const reloaded = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    expect((await reloaded.get(input.expected.projectId))?.factoryInstallation).toEqual(captured);
    await expect(registry.update(input.expected.projectId, (current) => current)).rejects.toThrow(
      "blocked",
    );
  });

  test("native Factory checkpoint rejects duplicate coordinators and mismatched project before writing", async () => {
    const input = await pendingInstallation();
    await expect(
      projectRegistry.beginFactoryInstallation({
        ...input,
        checkpoint: { ...input.checkpoint, projectId: "other-project" },
      }),
    ).rejects.toThrow("project identity");
    await expect(
      projectRegistry.beginFactoryInstallation({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          coordinators: {
            factory: input.checkpoint.coordinators.factory,
            builds: input.checkpoint.coordinators.factory,
          },
        },
      }),
    ).rejects.toThrow("distinct identities");
    expect(await projectRegistry.get(input.expected.projectId)).toEqual(input.expected);
  });

  test("ordinary project metadata edits preserve a pending Factory checkpoint without clearing its hold", async () => {
    const input = await pendingInstallation();
    const pending = await projectRegistry.beginFactoryInstallation(input);
    const renamed = await projectRegistry.update(pending.projectId, (current) => ({
      ...current,
      displayName: "User rename",
    }));
    expect(renamed?.factoryInstallation).toEqual(input.checkpoint);
    await expect(
      projectRegistry.completeFactoryInstallation({
        ...input,
        expected: pending,
        checkpoint: { ...input.checkpoint, stage: "attached", revision: "new-revision" },
      }),
    ).rejects.toThrow("project changed");
    expect((await projectRegistry.get(pending.projectId))?.factoryInstallation?.stage).toBe(
      "binding",
    );
  });

  test.each(["get", "list", "getLoadedRecord", "begin", "complete", "update"] as const)(
    "native Factory checkpoint cannot be cleared through a %s result alias",
    async (source) => {
      const input = await pendingInstallation();
      const pending = await projectRegistry.beginFactoryInstallation(input);
      let exposed = pending;
      if (source === "get") {
        const value = await projectRegistry.get(pending.projectId);
        if (!value) throw new Error("Isolated project fixture missing");
        exposed = value;
      }
      if (source === "list") exposed = (await projectRegistry.list())[0];
      if (source === "getLoadedRecord") {
        const value = projectRegistry.getLoadedRecord(pending.projectId);
        if (!value) throw new Error("Isolated project fixture missing");
        exposed = value;
      }
      if (source === "complete")
        exposed = await projectRegistry.completeFactoryInstallation({
          ...input,
          expected: pending,
          checkpoint: { ...input.checkpoint, stage: "attached", revision: "attached-revision" },
        });
      if (source === "update") {
        const value = await projectRegistry.update(pending.projectId, (current) => ({
          ...current,
          displayName: "User metadata rename",
        }));
        if (!value) throw new Error("Isolated project fixture missing");
        exposed = value;
      }
      const retained = structuredClone(exposed.factoryInstallation);
      delete exposed.factoryInstallation;
      await expect(projectRegistry.upsert(exposed)).rejects.toThrow(
        "native installation operation",
      );
      await expect(
        projectRegistry.archive(pending.projectId, "2026-10-08T02:00:00.000Z"),
      ).rejects.toThrow("owner disable");
      await expect(projectRegistry.remove(pending.projectId)).rejects.toThrow("owner disable");
      expect((await projectRegistry.get(pending.projectId))?.factoryInstallation).toEqual(retained);
      const reloaded = new FileBackedProjectRegistry(
        path.join(tmpDir, "projects", "projects.json"),
        logger,
      );
      expect((await reloaded.get(pending.projectId))?.factoryInstallation).toEqual(retained);
    },
  );

  test("native Factory checkpoint notification payloads cannot alter cache or other listeners", async () => {
    const input = await pendingInstallation();
    const observed: unknown[] = [];
    projectRegistry.subscribeToMutations((mutation) => {
      if (mutation.project) delete mutation.project.factoryInstallation;
    });
    projectRegistry.subscribeToMutations((mutation) => {
      observed.push(mutation.project?.factoryInstallation);
    });
    const pending = await projectRegistry.beginFactoryInstallation(input);
    expect(observed).toEqual([input.checkpoint]);
    expect(pending.factoryInstallation).toEqual(input.checkpoint);
    expect((await projectRegistry.get(pending.projectId))?.factoryInstallation).toEqual(
      input.checkpoint,
    );
  });

  const member = {
    operationId: "native-operation",
    workspaceId: "factory-member",
    installationId: "installation",
    expectedRevision: "revision",
  };

  async function coordinatorAuthorityFixture() {
    const workspace = await factorySetup();
    await projectRegistry.update(workspace.projectId, (record) => ({
      ...record,
      projectKey: "remote:github.com/example/repository",
    }));
    const builds = { ...workspace, workspaceId: "builds-member" };
    await workspaceRegistry.upsert(builds);
    const profile = { id: "configured-profile", name: "Configured", provider: "codex" };
    const provider = "codex-account-selected";
    const agents = new AgentStorage(path.join(tmpDir, "agents"), logger);
    const factoryAgent: StoredAgentRecord = {
      id: "factory-agent",
      provider,
      cwd: workspace.cwd,
      workspaceId: workspace.workspaceId,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      labels: {},
      lastStatus: "idle",
      config: { profileLaunch: { profile } },
    };
    await agents.upsert(factoryAgent);
    await agents.upsert({ ...factoryAgent, id: "builds-agent", workspaceId: builds.workspaceId });
    let current = true;
    const input = {
      owner: {
        identity: {
          version: 1 as const,
          installationId: "installation",
          epoch: 1,
          token: "test-owner-token",
          supervisorPid: process.pid,
          lockDevice: 1,
          lockInode: 1,
        },
        assertCurrent() {
          if (!current) throw new Error("Retained owner revoked");
        },
      },
      binding: {
        installationId: "installation",
        serverId: "factory-host",
        projectId: workspace.projectId,
        projectRoot: tmpDir,
        repository: "example/repository",
        coordinators: {
          factory: { workspaceId: workspace.workspaceId, agentId: factoryAgent.id },
          builds: { workspaceId: builds.workspaceId, agentId: "builds-agent" },
        },
      },
      operationId: member.operationId,
      provider,
      profile,
      agents,
      projects: projectRegistry,
      workspaces: workspaceRegistry,
    };
    return { input, workspace, builds, factoryAgent, revoke: () => (current = false) };
  }

  test("Startup binder resolves the native configured profile and protects both existing coordinators", async () => {
    const f = await coordinatorAuthorityFixture();
    const bind = createFactoryCoordinatorBinder({
      ...f.input,
      serverId: f.input.binding.serverId,
      readProfiles: () => [f.input.profile],
    });
    const result = await bind({ ...f.input, profileId: f.input.profile.id });
    expect(result.coordinators).toEqual(f.input.binding.coordinators);
    expect((await workspaceRegistry.get(f.workspace.workspaceId))?.factoryMembership?.role).toBe(
      "factory",
    );
    expect((await workspaceRegistry.get(f.builds.workspaceId))?.factoryMembership?.role).toBe(
      "builds",
    );
    expect(await f.input.agents.get(f.factoryAgent.id)).toEqual(f.factoryAgent);
  });

  test("Startup binder refuses missing, ambiguous and changed configured profiles without binding", async () => {
    const f = await coordinatorAuthorityFixture();
    let profiles = [f.input.profile];
    const bind = createFactoryCoordinatorBinder({
      ...f.input,
      serverId: f.input.binding.serverId,
      readProfiles: () => profiles,
    });
    const input = { ...f.input, profileId: f.input.profile.id };
    profiles = [];
    await expect(bind(input)).rejects.toThrow("unavailable or ambiguous");
    profiles = [f.input.profile, f.input.profile];
    await expect(bind(input)).rejects.toThrow("unavailable or ambiguous");
    let reads = 0;
    profiles = [f.input.profile];
    const drifting = createFactoryCoordinatorBinder({
      ...f.input,
      serverId: f.input.binding.serverId,
      readProfiles: () => (++reads === 1 ? profiles : [{ ...f.input.profile, model: "changed" }]),
    });
    await expect(drifting(input)).rejects.toThrow("configured profile or retained owner changed");
    expect(
      (await workspaceRegistry.get(f.workspace.workspaceId))?.factoryMembership,
    ).toBeUndefined();
    expect((await workspaceRegistry.get(f.builds.workspaceId))?.factoryMembership).toBeUndefined();
  });

  test("Startup binder preserves the first protected role and reports second-role uncertainty", async () => {
    const f = await coordinatorAuthorityFixture();
    const original = workspaceRegistry.bindFactoryMember.bind(workspaceRegistry);
    workspaceRegistry.bindFactoryMember = async (input) => {
      if (input.membership.role === "builds") throw new Error("storage unavailable");
      return original(input);
    };
    const bind = createFactoryCoordinatorBinder({
      ...f.input,
      serverId: f.input.binding.serverId,
      readProfiles: () => [f.input.profile],
    });
    let failure: unknown;
    try {
      await bind({ ...f.input, profileId: f.input.profile.id });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FactoryCoordinatorBindingError);
    expect(failure).toMatchObject({
      operationId: f.input.operationId,
      completedRoles: ["factory"],
      uncertainRole: "builds",
      cause: { message: "storage unavailable" },
    });
    expect((await workspaceRegistry.get(f.workspace.workspaceId))?.factoryMembership?.role).toBe(
      "factory",
    );
    expect((await workspaceRegistry.get(f.builds.workspaceId))?.factoryMembership).toBeUndefined();
  });

  test("Startup binder rejects caller binding replacement during final persistence and retains both protections", async () => {
    const f = await coordinatorAuthorityFixture();
    const input = { ...f.input, profileId: f.input.profile.id };
    const original = workspaceRegistry.bindFactoryMember.bind(workspaceRegistry);
    workspaceRegistry.bindFactoryMember = async (request) => {
      const result = await original(request);
      if (request.membership.role === "builds") {
        input.binding = structuredClone(input.binding);
        input.binding.coordinators.factory.agentId = "unverified-factory-agent";
        input.binding.coordinators.builds.agentId = "unverified-builds-agent";
      }
      return result;
    };
    const bind = createFactoryCoordinatorBinder({
      ...f.input,
      serverId: f.input.binding.serverId,
      readProfiles: () => [f.input.profile],
    });
    let failure: unknown;
    try {
      await bind(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FactoryCoordinatorBindingError);
    expect(failure).toMatchObject({
      operationId: f.input.operationId,
      completedRoles: ["factory"],
      uncertainRole: "builds",
      cause: { name: "FactoryMembershipPersistedError" },
    });
    expect((await workspaceRegistry.get(f.workspace.workspaceId))?.factoryMembership?.role).toBe(
      "factory",
    );
    expect((await workspaceRegistry.get(f.builds.workspaceId))?.factoryMembership?.role).toBe(
      "builds",
    );
    expect(await f.input.agents.get(f.factoryAgent.id)).toEqual(f.factoryAgent);
  });

  test("Startup binder refuses a different serving daemon before any native binding", async () => {
    const f = await coordinatorAuthorityFixture();
    const bind = createFactoryCoordinatorBinder({
      ...f.input,
      serverId: "other",
      readProfiles: () => [f.input.profile],
    });
    await expect(bind({ ...f.input, profileId: f.input.profile.id })).rejects.toThrow(
      "another daemon",
    );
    expect(
      (await workspaceRegistry.get(f.workspace.workspaceId))?.factoryMembership,
    ).toBeUndefined();
  });

  test("Factory coordinator authority binds only the exact retained pair and survives idempotent binding", async () => {
    const f = await coordinatorAuthorityFixture();
    const grant = await captureFactoryCoordinatorAuthority(f.input);
    const service = new FactoryMembershipService({
      serverId: f.input.binding.serverId,
      projects: projectRegistry,
      workspaces: workspaceRegistry,
      authority: grant.authority,
    });
    const request = { ...member, expectedRevision: grant.revision };
    const first = await service.bind({ ...request, role: "factory" });
    const second = await service.bind({
      ...request,
      role: "builds",
      workspaceId: f.builds.workspaceId,
    });
    expect(first.factoryMembership?.role).toBe("factory");
    expect(second.factoryMembership?.role).toBe("builds");
    expect(await service.bind({ ...request, role: "factory" })).toEqual(first);
    await expect(service.retire({ ...request, action: "disable" })).rejects.toThrow(
      "cannot authorize",
    );
    await expect(service.bind({ ...request, role: "worker" })).rejects.toThrow("cannot authorize");
    expect(await f.input.agents.get(f.factoryAgent.id)).toEqual(f.factoryAgent);
  });

  test.each(["provider", "profile", "workspace", "archive"])(
    "Factory coordinator authority rejects initial native %s mismatch without mutation",
    async (change) => {
      const f = await coordinatorAuthorityFixture();
      const agent = { ...f.factoryAgent };
      if (change === "provider") agent.provider = "codex-account-other";
      if (change === "profile")
        agent.config = { profileLaunch: { profile: { ...f.input.profile, id: "other" } } };
      if (change === "workspace") agent.workspaceId = "another-workspace";
      if (change === "archive") agent.archivedAt = "2026-10-08T00:02:00Z";
      await f.input.agents.upsert(agent);
      await expect(captureFactoryCoordinatorAuthority(f.input)).rejects.toThrow(
        "configured native",
      );
      expect(await workspaceRegistry.get(f.workspace.workspaceId)).toEqual(f.workspace);
      expect(await workspaceRegistry.get(f.builds.workspaceId)).toEqual(f.builds);
    },
  );

  test("Factory coordinator leases cannot mutate the captured native relationship", async () => {
    const f = await coordinatorAuthorityFixture();
    const grant = await captureFactoryCoordinatorAuthority(f.input);
    const request = {
      action: "bind" as const,
      operationId: f.input.operationId,
      role: "factory" as const,
      workspace: f.workspace,
    };
    const first = await grant.authority.authorize(request);
    first.membership.role = "worker";
    first.membership.installationId = "other";
    expect((await grant.authority.authorize(request)).membership).toMatchObject({
      role: "factory",
      installationId: "installation",
    });
    expect(await workspaceRegistry.get(f.workspace.workspaceId)).toEqual(f.workspace);
  });

  test.each(["owner", "agent", "project", "workspace", "reader"])(
    "Factory coordinator authority rejects %s drift before persistence",
    async (change) => {
      const f = await coordinatorAuthorityFixture();
      const grant = await captureFactoryCoordinatorAuthority(f.input);
      if (change === "owner") f.revoke();
      if (change === "agent")
        await f.input.agents.upsert({ ...f.factoryAgent, lastStatus: "running" });
      if (change === "project")
        await projectRegistry.archive(f.workspace.projectId, "2026-10-08T00:02:00Z");
      if (change === "workspace")
        await workspaceRegistry.update(f.builds.workspaceId, (record) => ({
          ...record,
          title: "Changed",
        }));
      if (change === "reader") f.input.owner.assertCurrent = () => {};
      await expect(
        grant.authority.authorize({
          action: "bind",
          operationId: f.input.operationId,
          role: "factory",
          workspace: f.workspace,
        }),
      ).rejects.toThrow();
      expect(
        (await workspaceRegistry.get(f.workspace.workspaceId))?.factoryMembership,
      ).toBeUndefined();
    },
  );

  test("Factory coordinator binding marks a post-persistence owner loss as partial and keeps protection", async () => {
    let revokeAfterWrite = false;
    let revoke = () => {};
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
      {
        writeRecords: async (file, records) => {
          await writeJsonFileAtomic(file, records);
          if (revokeAfterWrite) revoke();
        },
      },
    );
    const f = await coordinatorAuthorityFixture();
    revoke = f.revoke;
    const grant = await captureFactoryCoordinatorAuthority(f.input);
    const service = new FactoryMembershipService({
      serverId: f.input.binding.serverId,
      projects: projectRegistry,
      workspaces: workspaceRegistry,
      authority: grant.authority,
    });
    revokeAfterWrite = true;
    await expect(
      service.bind({ ...member, role: "factory", expectedRevision: grant.revision }),
    ).rejects.toBeInstanceOf(FactoryMembershipPersistedError);
    expect((await workspaceRegistry.get(f.workspace.workspaceId))?.factoryMembership?.role).toBe(
      "factory",
    );
    await expect(
      workspaceRegistry.archive(f.workspace.workspaceId, f.workspace.updatedAt),
    ).rejects.toThrow("Factory");
    expect((await workspaceRegistry.get(f.builds.workspaceId))?.factoryMembership).toBeUndefined();
  });

  test("Factory membership survives reload and generic unprotection cannot allow archive", async () => {
    await factorySetup();
    const bound = await membershipService().bind({ ...member, role: "factory" });
    await workspaceRegistry.update(bound.workspaceId, (record) =>
      setWorkspaceLifecycle(record, { standing: false, protected: false }),
    );
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    expect((await reloaded.get(bound.workspaceId))?.factoryMembership).toEqual({
      installationId: "installation",
      serverId: "factory-host",
      projectId: "factory-project",
      role: "factory",
    });
    await expect(reloaded.archive(bound.workspaceId, bound.updatedAt)).rejects.toThrow("Factory");
    await expect(reloaded.remove(bound.workspaceId)).rejects.toThrow("Factory");
  });

  test("Factory worker cleanup releases only the reconciled relationship and preserves identity", async () => {
    await factorySetup();
    const service = membershipService();
    const bound = await service.bind({ ...member, role: "worker" });
    const retired = await service.retire({ ...member, action: "cleanup" });
    const { factoryMembership: released, updatedAt: boundAt, ...retainedBound } = bound;
    const { updatedAt: retiredAt, ...retainedRetired } = retired;
    expect(released?.role).toBe("worker");
    expect(boundAt).toEqual(expect.any(String));
    expect(retiredAt).toEqual(expect.any(String));
    expect(retainedRetired).toEqual(retainedBound);
    await workspaceRegistry.archive(retired.workspaceId, retired.updatedAt);
    expect((await workspaceRegistry.get(retired.workspaceId))?.archivedAt).toBe(retired.updatedAt);
  });

  test("Factory coordinators refuse worker cleanup and accept separately authorized owner disable", async () => {
    await factorySetup();
    const service = membershipService();
    await service.bind({ ...member, role: "builds" });
    await expect(service.retire({ ...member, action: "cleanup" })).rejects.toThrow("owner disable");
    expect((await workspaceRegistry.get(member.workspaceId))?.factoryMembership?.role).toBe(
      "builds",
    );
    expect(
      (await service.retire({ ...member, action: "disable" })).factoryMembership,
    ).toBeUndefined();
  });

  test("Factory serial binding refuses duplicate retained coordinator roles", async () => {
    const record = await factorySetup();
    await workspaceRegistry.upsert({ ...record, workspaceId: "second-member" });
    const service = membershipService();
    const first = service.bind({ ...member, role: "factory" });
    const second = membershipService().bind({
      ...member,
      workspaceId: "second-member",
      role: "factory",
    });
    await expect(first).resolves.toMatchObject({ factoryMembership: { role: "factory" } });
    await expect(second).rejects.toThrow("role already has a retained workspace");
    expect((await workspaceRegistry.get("second-member"))?.factoryMembership).toBeUndefined();
  });

  test("Factory atomic binding refuses two simultaneous installations for one project", async () => {
    const first = await factorySetup();
    const second = { ...first, workspaceId: "second-installation-member" };
    await workspaceRegistry.upsert(second);
    const bind = (expected: typeof first, installationId: string) =>
      workspaceRegistry.bindFactoryMember({
        expected,
        membership: {
          installationId,
          projectId: first.projectId,
          serverId: "factory-host",
          role: "worker",
        },
        assertCurrent: () => {},
      });
    const results = await Promise.allSettled([bind(first, "installation"), bind(second, "other")]);
    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: "Project already belongs to another Factory installation.",
      }),
    });
    expect((await workspaceRegistry.get(second.workspaceId))?.factoryMembership).toBeUndefined();
  });

  test.each([
    { installationId: "other-installation" },
    { expectedRevision: "other-revision" },
    { expectedRevision: "" },
    { operationId: "" },
  ])("Factory binding refuses mismatched installation preconditions %j", async (change) => {
    const record = await factorySetup();
    await expect(
      membershipService().bind({ ...member, role: "worker", ...change }),
    ).rejects.toThrow("installation authority changed");
    expect(await workspaceRegistry.get(record.workspaceId)).toEqual(record);
  });

  test("Factory binding refuses a record change before its serialized update", async () => {
    const record = await factorySetup();
    const service = new FactoryMembershipService({
      serverId: "factory-host",
      projects: projectRegistry,
      workspaces: workspaceRegistry,
      authority: {
        authorize: async ({ role, operationId }) => {
          await workspaceRegistry.update(record.workspaceId, (current) => ({
            ...current,
            title: "Changed during authorization",
          }));
          return {
            workspaceId: record.workspaceId,
            operationId,
            membership: {
              installationId: "installation",
              serverId: "factory-host",
              projectId: record.projectId,
              role,
            },
            revision: "revision",
            assertCurrent: () => {},
          };
        },
      },
    });
    await expect(service.bind({ ...member, role: "worker" })).rejects.toThrow("Workspace changed");
    expect(await workspaceRegistry.get(record.workspaceId)).toMatchObject({
      title: "Changed during authorization",
    });
    expect((await workspaceRegistry.get(record.workspaceId))?.factoryMembership).toBeUndefined();
  });

  test("Factory binding refuses an archived project without restoring it", async () => {
    await factorySetup();
    await projectRegistry.archive("factory-project", "2026-10-08T00:01:00.000Z");
    await expect(membershipService().bind({ ...member, role: "worker" })).rejects.toThrow(
      "project is unavailable",
    );
    expect((await workspaceRegistry.get(member.workspaceId))?.factoryMembership).toBeUndefined();
    expect((await projectRegistry.get("factory-project"))?.archivedAt).toBe(
      "2026-10-08T00:01:00.000Z",
    );
  });

  test("Factory binding rechecks owner generation inside the registry mutation", async () => {
    const workspace = await factorySetup();
    let current = true;
    const bind = workspaceRegistry.bindFactoryMember.bind(workspaceRegistry);
    workspaceRegistry.bindFactoryMember = async (input) => {
      current = false;
      return bind(input);
    };
    const service = new FactoryMembershipService({
      serverId: "factory-host",
      projects: projectRegistry,
      workspaces: workspaceRegistry,
      authority: {
        authorize: async ({ role, operationId }) => ({
          workspaceId: workspace.workspaceId,
          operationId,
          membership: {
            installationId: "installation",
            projectId: workspace.projectId,
            serverId: "factory-host",
            role,
          },
          revision: "revision",
          assertCurrent: () => {
            if (!current) throw new Error("Factory owner generation changed");
          },
        }),
      },
    });
    await expect(service.bind({ ...member, role: "worker" })).rejects.toThrow(
      "owner generation changed",
    );
    expect(await workspaceRegistry.get(workspace.workspaceId)).toEqual(workspace);
  });

  test("Factory unresolved cleanup authority retains membership and archive refusal", async () => {
    await factorySetup();
    await membershipService().bind({ ...member, role: "worker" });
    const retained = await workspaceRegistry.get(member.workspaceId);
    const service = new FactoryMembershipService({
      serverId: "factory-host",
      projects: projectRegistry,
      workspaces: workspaceRegistry,
      authority: {
        authorize: async () => {
          throw new Error("Execution custody remains unresolved");
        },
      },
    });
    await expect(service.retire({ ...member, action: "cleanup" })).rejects.toThrow(
      "custody remains unresolved",
    );
    expect(await workspaceRegistry.get(member.workspaceId)).toEqual(retained);
    await expect(workspaceRegistry.remove(member.workspaceId)).rejects.toThrow("Factory");
  });

  test("protected workspaces survive archive attempts and retain protection after reload", async () => {
    const record = createPersistedWorkspaceRecord({
      workspaceId: "standing",
      projectId: "project",
      cwd: tmpDir,
      kind: "directory",
      displayName: "Standing task",
      createdAt: "2026-10-06T00:00:00.000Z",
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
    await workspaceRegistry.upsert({ ...record, standing: true, protected: true });
    await expect(workspaceRegistry.archive(record.workspaceId, record.updatedAt)).rejects.toThrow(
      "protected",
    );
    await expect(workspaceRegistry.remove(record.workspaceId)).rejects.toThrow("protected");
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    expect(await reloaded.get(record.workspaceId)).toMatchObject({
      standing: true,
      protected: true,
      archivedAt: null,
    });
    await workspaceRegistry.update(record.workspaceId, (current) => ({
      ...current,
      protected: false,
    }));
    await workspaceRegistry.archive(record.workspaceId, record.updatedAt);
    expect(await workspaceRegistry.get(record.workspaceId)).toMatchObject({
      standing: true,
      protected: false,
      archivedAt: record.updatedAt,
    });
  });

  test("creates, updates, archives, deletes, and lists project records", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await projectRegistry.archive("remote:github.com/acme/repo", "2026-03-03T00:00:00.000Z");

    const archived = await projectRegistry.get("remote:github.com/acme/repo");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");
    expect(await projectRegistry.list()).toHaveLength(1);

    await projectRegistry.remove("remote:github.com/acme/repo");
    expect(await projectRegistry.get("remote:github.com/acme/repo")).toBeNull();
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("preserves a concurrent project update when archiving", async () => {
    let pauseNextWrite = false;
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const concurrentRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "concurrent-projects.json"),
      logger,
      {
        writeRecords: async (filePath, records) => {
          if (pauseNextWrite) {
            pauseNextWrite = false;
            writeStarted();
            await release;
          }
          await writeJsonFileAtomic(filePath, records);
        },
      },
    );
    const project = createPersistedProjectRecord({
      projectId: "project-concurrent",
      rootPath: "/tmp/project-concurrent",
      kind: "git",
      displayName: "project-concurrent",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await concurrentRegistry.upsert(project);
    pauseNextWrite = true;

    const update = concurrentRegistry.update(project.projectId, (current) => ({
      ...current,
      customName: "Kept name",
      updatedAt: "2026-03-02T00:00:00.000Z",
    }));
    await started;
    const archive = concurrentRegistry.archive(project.projectId, "2026-03-03T00:00:00.000Z");
    releaseWrite();
    await Promise.all([update, archive]);

    expect(await concurrentRegistry.get(project.projectId)).toMatchObject({
      customName: "Kept name",
      archivedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("publishes only project mutations that change the persisted lifecycle", async () => {
    await projectRegistry.initialize();
    const mutations: Array<{
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: ReturnType<typeof createPersistedProjectRecord> | null;
    }> = [];
    const unsubscribe = projectRegistry.subscribeToMutations((mutation) => {
      mutations.push(mutation);
    });
    const active = createPersistedProjectRecord({
      projectId: "project-one",
      rootPath: "/tmp/project-one",
      kind: "non_git",
      displayName: "project-one",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const archived = {
      ...active,
      updatedAt: "2026-03-02T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    };

    await projectRegistry.upsert(active);
    await projectRegistry.archive(active.projectId, archived.archivedAt);
    await projectRegistry.archive(active.projectId, "2026-03-03T00:00:00.000Z");
    await projectRegistry.archive("project-unknown", "2026-03-03T00:00:00.000Z");
    await projectRegistry.remove(active.projectId);
    await projectRegistry.remove(active.projectId);
    await projectRegistry.remove("project-unknown");

    expect(mutations).toEqual([
      { kind: "upsert", projectId: active.projectId, project: active },
      { kind: "archive", projectId: active.projectId, project: archived },
      { kind: "remove", projectId: active.projectId, project: null },
    ]);
    unsubscribe();
  });

  test("atomically allocates one opaque project for concurrent exact-root adds", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "same-root");
    const projects = await Promise.all(
      Array.from({ length: 20 }, () =>
        projectRegistry.getOrCreateActiveByRoot({
          rootPath,
          kind: "non_git",
          displayName: "same-root",
          timestamp: "2026-03-01T00:00:00.000Z",
        }),
      ),
    );

    expect(new Set(projects.map((project) => project.projectId))).toEqual(
      new Set([projects[0]!.projectId]),
    );
    expect(projects[0]!.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(await projectRegistry.list()).toHaveLength(1);
  });

  test("keeps readable legacy IDs alongside newly allocated opaque IDs", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/legacy",
        kind: "git",
        displayName: "repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    const opaque = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "/tmp/new",
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    expect((await projectRegistry.get("remote:github.com/acme/repo"))?.rootPath).toBe(
      "/tmp/legacy",
    );
    expect(opaque.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  });

  test("allocates a fresh opaque ID when only an archived exact root exists", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "archived-root");
    const archived = createPersistedProjectRecord({
      projectId: "prj_archived",
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(archived);

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      timestamp: "2026-03-03T00:00:00.000Z",
    });

    expect(created).toMatchObject({ rootPath, archivedAt: null });
    expect(created.projectId).not.toBe(archived.projectId);
    expect(await projectRegistry.get(archived.projectId)).toEqual(archived);
  });

  test("refreshes the oldest active legacy duplicate kind without rewriting its identity", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "legacy-root");
    const oldest = createPersistedProjectRecord({
      projectId: "remote:oldest",
      rootPath,
      kind: "git",
      displayName: "oldest",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const duplicate = createPersistedProjectRecord({
      projectId: "remote:duplicate",
      rootPath,
      kind: "git",
      displayName: "duplicate",
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(oldest);
    await projectRegistry.upsert(duplicate);

    await expect(
      projectRegistry.getOrCreateActiveByRoot({
        rootPath,
        kind: "non_git",
        displayName: "new-name",
        timestamp: "2026-03-03T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      ...oldest,
      kind: "non_git",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
    expect(await projectRegistry.list()).toEqual([
      { ...oldest, kind: "non_git", updatedAt: "2026-03-03T00:00:00.000Z" },
      duplicate,
    ]);
  });

  test("reuses an active project for Windows lexical-equivalent root spellings", async () => {
    await projectRegistry.initialize();
    const first = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "C:\\Users\\Paseo\\Repo",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const second = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "c:/users/paseo/repo/.",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(second).toEqual(first);
    expect(await projectRegistry.list()).toEqual([first]);
  });

  test("keeps lexical and symlink root spellings distinct without realpath", async () => {
    await projectRegistry.initialize();
    const target = path.join(tmpDir, "target");
    const link = path.join(tmpDir, "link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    const targetProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: target,
      kind: "non_git",
      displayName: "target",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const linkProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: link,
      kind: "non_git",
      displayName: "link",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(linkProject.projectId).not.toBe(targetProject.projectId);
    expect(await projectRegistry.list()).toEqual([targetProject, linkProject]);
  });

  test("retries a generated project ID collision", async () => {
    const generatedIds = ["prj_collision", "prj_fresh"];
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
      { projectIdFactory: () => generatedIds.shift() ?? "prj_unexpected" },
    );
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "prj_collision",
        rootPath: path.join(tmpDir, "existing"),
        kind: "non_git",
        displayName: "existing",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: path.join(tmpDir, "new"),
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(created.projectId).toBe("prj_fresh");
    expect(await projectRegistry.list()).toHaveLength(2);
  });

  test("project record schema accepts records without customName (legacy on-disk records)", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBeNull();
  });

  test("project record persists a customName override", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/home/me/work/repo",
        kind: "git",
        displayName: "acme/repo",
        customName: "Acme (work)",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBe("Acme (work)");
    expect(record?.displayName).toBe("acme/repo");
  });

  test("creates, updates, archives, deletes, and lists workspace records", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "feature/workspace",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await workspaceRegistry.archive("/tmp/repo", "2026-03-03T00:00:00.000Z");

    const archived = await workspaceRegistry.get("/tmp/repo");
    expect(archived?.displayName).toBe("feature/workspace");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");

    await workspaceRegistry.remove("/tmp/repo");
    expect(await workspaceRegistry.get("/tmp/repo")).toBeNull();
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("refreshes workspace archive timestamps when an archive is repeated", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-one",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.archive("workspace-one", "2026-03-02T00:00:00.000Z");
    await workspaceRegistry.archive("workspace-one", "2026-03-03T00:00:00.000Z");

    expect(await workspaceRegistry.get("workspace-one")).toMatchObject({
      archivedAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("persists the consumed change request with the workspace archive", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-auto-archive",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "worktree",
        displayName: "feature",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.archive("workspace-auto-archive", "2026-03-02T00:00:00.000Z", {
      autoArchivedChangeRequestUrl: "https://github.com/acme/repo/pull/123",
    });

    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloaded.initialize();
    expect(await reloaded.get("workspace-auto-archive")).toMatchObject({
      archivedAt: "2026-03-02T00:00:00.000Z",
      autoArchivedChangeRequestUrl: "https://github.com/acme/repo/pull/123",
    });
  });

  test("composes concurrent workspace field updates without losing either change", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-1",
        projectId: "proj-1",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await Promise.all([
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        title: "Payments work",
        updatedAt: "2026-03-02T00:00:00.000Z",
      })),
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        pinnedAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-03T00:00:00.000Z",
      })),
    ]);

    const reloadedRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloadedRegistry.initialize();
    expect(await reloadedRegistry.get("ws-1")).toMatchObject({
      title: "Payments work",
      pinnedAt: "2026-03-03T00:00:00.000Z",
    });
  });
});
