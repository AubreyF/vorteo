import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { attachFactoryControllerObservation } from "../../factory/attach-controller-observation.js";
import type { GovernedScheduleRuntime } from "../../schedule/governed-runtime.js";
import { createFactoryControllerObservationSource } from "../../factory/create-controller-observation-source.js";
import { createAccountingContract } from "../../agent/quota-reserve/governor-accounting-contract.js";
import {
  FactoryControllerObservationProvider,
  type FactoryControllerObservationSource,
} from "../../factory/controller-observation-provider.js";
import type { QuotaObservation } from "@getpaseo/protocol/quota-governor";
import {
  NativeFactoryObservationService,
  createNativeFactoryObservationResolver,
} from "../../factory/observation-service.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
} from "../../workspace-registry.js";
import { NativeFactorySetupService } from "../../factory/setup-service.js";
import { createNativeFactoryInstallAdapter } from "../../factory/native-install-adapter.js";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import { AgentStorage } from "../../agent/agent-storage.js";
import { FileBackedWorkspaceRegistry } from "../../workspace-registry.js";
import { FactorySetupSchema } from "../../../../../../plugins/factory/shared/operations.js";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import { fixtureSnapshot } from "../../../../../../plugins/factory/client/fixtures.js";
import { compilePlugin } from "../compiler.js";
import { readPluginManifest } from "../manifest.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { BuiltinPluginLoader, builtinPlugins, resolveBuiltinPluginsRoot } from "./index.js";
import {
  ActivityReceiptsSchema,
  FactorySnapshotSchema,
  type FactorySnapshot,
  type ActivityReceipts,
} from "../../../../../../plugins/factory/shared/contracts.js";

import { captureControllerOwnership } from "../../../../../../plugins/factory/server/controller/ownership.mjs";
import { createFactoryProjectGuard } from "../../../../../../plugins/factory/server/controller/project-binding.mjs";
import { openBuildJournal } from "../../../../../../plugins/factory/server/controller/build-journal.mjs";
import {
  devReleaseStatus,
  planDevRelease,
  planDevSourceReview,
} from "../../../../../../plugins/factory/server/controller/dev-release.mjs";

const roots: string[] = [];

async function buildJournalFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-build-core-"));
  roots.push(root);
  await chmod(root, 0o700);
  const authority = { assertCurrent: vi.fn() };
  const input = { root, repository: "example/repository", authority };
  return { root, input, authority, journal: await openBuildJournal(input) };
}

test("bundled controller ownership refuses an unsupervised launch", () => {
  expect(() => captureControllerOwnership({})).toThrow("ownership launcher");
});

test("bundled Builds queue never initializes or resets retained state implicitly", async () => {
  const f = await buildJournalFixture();
  await expect(f.journal.inspect()).rejects.toMatchObject({ code: "ENOENT" });
  await f.journal.initialize();
  await f.journal.transact((state) => {
    state.requests.push({ id: "request-1", sourceRef: "a".repeat(40) });
    return { state, result: "retained" };
  });
  const reopened = await openBuildJournal(f.input);
  const before = await reopened.inspect();
  expect(before.revision).toBe(1);
  expect(before.requests).toEqual([{ id: "request-1", sourceRef: "a".repeat(40) }]);
  await expect(reopened.initialize()).rejects.toMatchObject({ code: "EEXIST" });
  expect(await reopened.inspect()).toEqual(before);
});

test("bundled Builds queue rejects lost authority before persistence", async () => {
  const f = await buildJournalFixture();
  await f.journal.initialize();
  const before = await readFile(path.join(f.root, "build-queue.json"));
  await expect(
    f.journal.transact((state) => {
      state.requests.push({ id: "must-not-persist" });
      f.authority.assertCurrent.mockImplementation(() => {
        throw new Error("Owner revoked");
      });
      return { state, result: null };
    }),
  ).rejects.toThrow("Owner revoked");
  expect(await readFile(path.join(f.root, "build-queue.json"))).toEqual(before);
});

test("bundled Builds queue preserves another handle's update when a transaction is stale", async () => {
  const f = await buildJournalFixture();
  await f.journal.initialize();
  const second = await openBuildJournal(f.input);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stale = f.journal.transact(async (state) => {
    entered();
    await waiting;
    state.requests.push({ id: "stale" });
    return { state, result: null };
  });
  const rejected = expect(stale).rejects.toThrow("changed; reconcile");
  await ready;
  await second.transact((state) => {
    state.requests.push({ id: "current" });
    return { state, result: null };
  });
  release();
  await rejected;
  expect((await second.inspect()).requests).toEqual([{ id: "current" }]);
});

test.each(["revision", "capacity"] as const)(
  "bundled Builds queue holds %s violations without data loss",
  async (change) => {
    const f = await buildJournalFixture();
    await f.journal.initialize();
    const before = await f.journal.inspect();
    await expect(
      f.journal.transact((state) => {
        if (change === "revision") state.revision += 1;
        if (change === "capacity") state.requests.push("x".repeat(8 * 1024 * 1024));
        return { state, result: null };
      }),
    ).rejects.toThrow(change === "revision" ? "revision was changed" : "journal is full");
    expect(await f.journal.inspect()).toEqual(before);
  },
);

test.each(["mode", "symlink"] as const)(
  "bundled Builds queue refuses an unsafe %s file",
  async (change) => {
    const f = await buildJournalFixture();
    await f.journal.initialize();
    const file = path.join(f.root, "build-queue.json");
    if (change === "mode") await chmod(file, 0o644);
    if (change === "symlink") {
      await rename(file, path.join(f.root, "saved.json"));
      await symlink(path.join(f.root, "saved.json"), file);
    }
    await expect(f.journal.inspect()).rejects.toThrow();
  },
);

test.each(["host", "removed", "root", "duplicate"] as const)(
  "bundled project guard rejects %s binding without discovery or replacement",
  async (change) => {
    const binding = {
      hostId: "srv_test",
      projectId: "prj_test",
      projectRoot: "/repo",
      repository: "example/repository",
    };
    const project = {
      projectId: binding.projectId,
      projectKind: "git",
      projectRootPath: "/repo",
      projectKey: "remote:github.com/example/repository",
    };
    const client = {
      getLastServerInfoMessage: () => ({ serverId: change === "host" ? "srv_other" : "srv_test" }),
      listProjects: vi.fn(async () => ({
        projects:
          change === "removed" ? [] : [project].concat(change === "duplicate" ? [project] : []),
      })),
    };
    if (change === "root") project.projectRootPath = "/other";
    const guard = createFactoryProjectGuard({
      binding,
      repository: binding.repository,
      client,
      assertCurrent: () => {},
    });
    await expect(guard.check()).rejects.toThrow();
  },
);

test("bundled project guard captures exact identity and rechecks authority after native reads", async () => {
  const binding = {
    hostId: "srv_test",
    projectId: "prj_test",
    projectRoot: "/repo",
    repository: "example/repository",
  };
  const assertCurrent = vi.fn();
  const client = {
    getLastServerInfoMessage: () => ({ serverId: "srv_test" }),
    listProjects: async () => ({
      projects: [
        {
          projectId: "prj_test",
          projectKind: "git",
          projectRootPath: "/repo",
          projectKey: "remote:github.com/example/repository",
        },
      ],
    }),
  };
  const guard = createFactoryProjectGuard({
    binding,
    repository: binding.repository,
    client,
    assertCurrent,
  });
  binding.projectId = "prj_other";
  expect((await guard.check()).projectId).toBe("prj_test");
  client.listProjects = async () => {
    assertCurrent.mockImplementation(() => {
      throw new Error("Revoked during read");
    });
    return { projects: [] };
  };
  await expect(guard.check()).rejects.toThrow("Revoked during read");
});

test("bundled daily release clock uses original publication, never verification time", () => {
  const lastSuccess = {
    version: 1,
    repository: "example/repository",
    channel: "dev",
    status: "published",
    tag: "v1.2.3-dev",
    productCommit: "a".repeat(40),
    releaseCommit: "b".repeat(40),
    artifactManifestSha256: "c".repeat(64),
    runId: 1,
    completedAt: "2026-10-07T00:00:00.000Z",
    verifiedAt: "2026-10-08T00:30:00.000Z",
  };
  expect(
    devReleaseStatus({
      repository: lastSuccess.repository,
      lastSuccess,
      active: null,
      now: Date.parse("2026-10-08T01:00:00.000Z"),
    }),
  ).toMatchObject({
    due: true,
    dueAt: "2026-10-08T00:00:00.000Z",
    lastSuccessfulAt: lastSuccess.completedAt,
  });
  expect(() =>
    devReleaseStatus({
      repository: lastSuccess.repository,
      lastSuccess: { ...lastSuccess, completedAt: "2026-10-09T00:00:00.000Z" },
      active: null,
      now: Date.parse("2026-10-08T01:00:00.000Z"),
    }),
  ).toThrow("unverified");
});

test("bundled release planning requires immutable validation and explicit authority", () => {
  const input = {
    repository: "example/repository",
    lastSuccess: null,
    active: null,
    authorization: {
      repository: "example/repository",
      channel: "dev",
      enabled: true,
      reference: "reviewed-authority",
    },
    source: {
      branch: "dev",
      commit: "a".repeat(40),
      validation: { commit: "a".repeat(40), conclusion: "success", receiptSha256: "b".repeat(64) },
      providerDecision: "satisfied",
      activationDecision: "satisfied",
      reviewCandidate: { productCommit: "a".repeat(40), validationReceiptSha256: "b".repeat(64) },
    },
  };
  expect(planDevRelease(input).kind).toBe("prepare");
  expect(planDevSourceReview(input).kind).toBe("review");
  expect(planDevRelease({ ...input, authorization: null })).toMatchObject({
    kind: "held",
    reason: "dev_release_authority_unavailable",
  });
  expect(
    planDevRelease({ ...input, source: { ...input.source, commit: "c".repeat(40) } }),
  ).toMatchObject({ kind: "held", reason: "validated_dev_snapshot_unavailable" });
});

function nativeObservationFixture() {
  const at = "2026-10-08T00:00:00.000Z";
  const binding = {
    serverId: "srv_test",
    projectId: "prj_test",
    projectRoot: "/repo",
    repository: "example/repository",
    installationId: "installation-test",
    coordinators: {
      factory: { workspaceId: "factory", agentId: "factory-agent" },
      builds: { workspaceId: "builds", agentId: "builds-agent" },
    },
  };
  const project = createPersistedProjectRecord({
    projectId: binding.projectId,
    rootPath: "/repo",
    kind: "git",
    displayName: "Repository",
    projectKey: "remote:github.com/example/repository",
    createdAt: at,
    updatedAt: at,
  });
  const workspaces = ["factory", "builds"].map((role) =>
    Object.assign(
      createPersistedWorkspaceRecord({
        workspaceId: role,
        projectId: binding.projectId,
        cwd: "/repo",
        kind: "local_checkout",
        displayName: role,
        createdAt: at,
        updatedAt: at,
      }),
      {
        factoryMembership: {
          serverId: binding.serverId,
          projectId: binding.projectId,
          installationId: binding.installationId,
          role: role as "factory" | "builds" | "worker",
        },
      },
    ),
  );
  const agents: StoredAgentRecord[] = workspaces.map((workspace) => ({
    id: `${workspace.workspaceId}-agent`,
    workspaceId: workspace.workspaceId,
    provider: "codex",
    cwd: "/repo",
    createdAt: at,
    updatedAt: at,
    labels: {},
    lastStatus: "idle",
  }));
  const snapshot: FactorySnapshot = {
    ...structuredClone(fixtureSnapshot),
    serverId: binding.serverId,
    projectId: binding.projectId,
    installationId: binding.installationId,
    revision: "observed-1",
    observedAt: at,
    work: [],
    issues: [],
    builds: { active: null, pending: [], latestRelease: null },
    coordinators: (["factory", "builds"] as const).map((role) => ({
      role,
      workspaceId: role,
      agentId: `${role}-agent`,
      status: "idle" as const,
    })),
  };
  const receipts: ActivityReceipts = {
    schemaVersion: 1,
    producer: { serverId: binding.serverId, pluginId: "factory" },
    observedAt: at,
    availability: "unavailable",
    receipts: null,
    nextCursor: null,
    coverage: {
      from: null,
      to: at,
      complete: false,
      gaps: ["No verified delivery observation"],
      cursorState: "initial",
    },
  };
  const provider = {
    binding,
    assertCurrent: vi.fn(),
    snapshot: vi.fn(async () => snapshot),
    receipts: vi.fn(async () => receipts),
  };
  const dependencies = {
    serverId: binding.serverId,
    projects: { get: async () => project },
    workspaces: {
      get: async (id: string) =>
        workspaces.find((workspace) => workspace.workspaceId === id) ?? null,
    },
    agents: { get: async (id: string) => agents.find((agent) => agent.id === id) ?? null },
  };
  const service = new NativeFactoryObservationService(provider, dependencies);
  return { service, provider, snapshot, receipts, project, workspaces, agents, dependencies };
}

function controllerProjectionFixture() {
  const native = nativeObservationFixture();
  const now = Date.parse("2026-10-08T01:00:00.000Z");
  const measuredAt = new Date(now - 20_000).toISOString();
  const observation: Extract<QuotaObservation, { status: "available" }> = {
    status: "available",
    account: { issuer: "codex", accountId: "test-account" },
    observedAt: measuredAt,
    windows: [
      {
        bucketId: "weekly",
        windowId: "primary",
        durationMinutes: 10080,
        usedPercent: 30,
        resetsAt: null,
        semantics: "rolling",
      },
    ],
    consumptionMeters: [],
    estimatedHourlyUsage: {
      bucketId: "weekly",
      windowId: "primary",
      authenticationGeneration: "auth-test",
      coverageStart: new Date(now - 3_600_000).toISOString(),
      observedAt: measuredAt,
      consumedPoints: 4.5,
    },
  };
  const claims = {
    schemaVersion: 1,
    installationId: native.provider.binding.installationId,
    revision: 1,
    active: null as unknown,
  };
  const intake = { version: 1, revision: 2, active: null as unknown };
  const builds = {
    version: 1,
    repository: native.provider.binding.repository,
    revision: 3,
    active: null as unknown,
    requests: [] as unknown[],
  };
  const lifecycle = {
    admission: { state: "held", reason: "Retained recovery" },
    coordinators: { factory: "recovery", builds: "recovery" },
  };
  const source: FactoryControllerObservationSource = {
    binding: native.provider.binding,
    authority: {
      identity: {
        version: 1,
        installationId: native.provider.binding.installationId,
        epoch: 1,
        token: "test-token",
        supervisorPid: 1,
        lockDevice: 1,
        lockInode: 1,
      },
      assertCurrent: vi.fn(),
    },
    authentication: { authenticationGeneration: "auth-test", assertCurrent: vi.fn() },
    policy: {
      version: 1,
      account: observation.account,
      requiredWindows: [{ bucketId: "weekly", windowId: "primary", durationMinutes: 10080 }],
      launchFloorPercent: 10,
      freezeFloorPercent: 5,
      maxObservationAgeSeconds: 120,
      consumptionLimits: [],
      estimatedHourly: { bucketId: "weekly", windowId: "primary", maxConsumedPoints: 15 },
      recovery: "automatic_after_reconciliation",
    },
    claims: { current: vi.fn(() => claims) },
    intake: { current: vi.fn(() => intake) },
    builds: { inspect: vi.fn(async () => builds) },
    readLifecycle: vi.fn(() => lifecycle),
    readAccountObservation: vi.fn(async () => observation),
  };
  const provider = new FactoryControllerObservationProvider(source, () => now);
  return { native, source, provider, claims, intake, builds, lifecycle, observation, now };
}

function attachmentFixture() {
  const f = controllerProjectionFixture();
  const stop = vi.fn(async () => {});
  const runtime: GovernedScheduleRuntime = {
    reconcile: async () => {},
    prepare: async () => ({ kind: "deferred", reason: "recovery_required", custody: "none" }),
    readObservation: async () => f.observation,
    stop,
  };
  return { ...f, runtime, stop };
}

async function nativeInstallFixture(failure: "none" | "checkpoint_acknowledgment" = "none") {
  const f = attachmentFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-install-"));
  roots.push(root);
  const logger = createTestLogger();
  const projects = new FileBackedProjectRegistry(path.join(root, "projects.json"), logger, {
    writeRecords: async (file, records) => {
      await writeJsonFileAtomic(file, records);
      if (
        failure === "checkpoint_acknowledgment" &&
        records.some((record) => record.factoryInstallation)
      )
        throw new Error("Native write acknowledgment lost");
    },
  });
  const workspaces = new FileBackedWorkspaceRegistry(path.join(root, "workspaces.json"), logger);
  const agents = new AgentStorage(path.join(root, "agents"), logger);
  const profile = { id: "configured-profile", name: "Configured", provider: "codex" };
  await projects.upsert(f.native.project);
  for (const workspace of f.native.workspaces) {
    const record = structuredClone(workspace);
    delete record.factoryMembership;
    await workspaces.upsert(record);
  }
  for (const agent of f.native.agents)
    await agents.upsert({ ...agent, config: { profileLaunch: { profile } } });
  let reconciled = true;
  const deps = {
    serverId: f.source.binding.serverId,
    projects,
    workspaces,
    agents,
    provider: "codex",
    profileId: profile.id,
    readProfiles: () => [profile],
    runtime: f.runtime,
    source: f.source,
    assertReconciled() {
      if (!reconciled) throw new Error("Retained custody changed");
    },
  };
  const adapter = createNativeFactoryInstallAdapter(deps);
  const setup = await adapter.readSetup(f.source.binding.projectId);
  if (!setup.revision) throw new Error("Native test setup precondition missing");
  const request = {
    projectId: setup.projectId,
    expectedServerId: setup.serverId,
    expectedInstallationId: null,
    expectedRevision: setup.revision,
    operationId: "attempt-test",
  };
  return {
    ...f,
    root,
    deps,
    adapter,
    request,
    revoke: () => {
      reconciled = false;
    },
  };
}

test("native Factory installer persists the attempt, binds existing members and verifies retained observation", async () => {
  const f = await nativeInstallFixture();
  const beforeAgents = await f.deps.agents.list();
  const result = await f.adapter.install(f.request);
  expect(result).toMatchObject({
    outcome: "applied",
    installationId: f.source.binding.installationId,
    setup: { state: "installed", operations: { install: false } },
  });
  expect(await f.adapter.readSetup(f.request.projectId)).toMatchObject({ state: "installed" });
  expect((await f.deps.projects.get(f.request.projectId))?.factoryInstallation?.stage).toBe(
    "attached",
  );
  for (const role of ["factory", "builds"] as const)
    expect(
      (await f.deps.workspaces.get(f.source.binding.coordinators[role].workspaceId))
        ?.factoryMembership?.role,
    ).toBe(role);
  expect(await f.deps.agents.list()).toEqual(beforeAgents);
  expect(f.stop).not.toHaveBeenCalled();
  await expect(
    f.adapter.install({ ...f.request, operationId: "another-attempt" }),
  ).resolves.toMatchObject({ outcome: "refused", code: "held" });
  const reloaded = createNativeFactoryInstallAdapter(f.deps);
  expect(await reloaded.readSetup(f.request.projectId)).toMatchObject({
    state: "held",
    revision: null,
    operations: { install: false },
  });
});

test.each(["host", "project", "revision", "installation"] as const)(
  "native Factory installer refuses changed %s before persistence or attachment",
  async (change) => {
    const f = await nativeInstallFixture();
    const request = { ...f.request };
    if (change === "host") request.expectedServerId = "another-host";
    if (change === "project") request.projectId = "another-project";
    if (change === "revision") request.expectedRevision = "changed-revision";
    const input =
      change === "installation"
        ? { ...request, expectedInstallationId: "another-installation" }
        : request;
    expect(await f.adapter.install(input)).toMatchObject({ outcome: "refused" });
    expect((await f.deps.projects.get(f.request.projectId))?.factoryInstallation).toBeUndefined();
    expect(f.runtime.factoryObservation).toBeUndefined();
    for (const record of await f.deps.workspaces.list())
      expect(record.factoryMembership).toBeUndefined();
  },
);

test("native Factory installer preserves first-member protection and durable hold when custody changes", async () => {
  const f = await nativeInstallFixture();
  const unsubscribe = f.deps.workspaces.subscribeToMutations((mutation) => {
    if (mutation.workspace?.factoryMembership?.role === "factory") f.revoke();
  });
  const result = await f.adapter.install(f.request);
  unsubscribe();
  expect(result).toMatchObject({ outcome: "uncertain", reconciliationRequired: true });
  expect((await f.deps.projects.get(f.request.projectId))?.factoryInstallation?.stage).toBe(
    "binding",
  );
  expect((await f.deps.workspaces.get("factory"))?.factoryMembership?.role).toBe("factory");
  expect((await f.deps.workspaces.get("builds"))?.factoryMembership).toBeUndefined();
  expect(f.runtime.factoryObservation).toBeUndefined();
  const retained = new FileBackedProjectRegistry(
    path.join(f.root, "projects.json"),
    createTestLogger(),
  );
  expect((await retained.get(f.request.projectId))?.factoryInstallation?.operationId).toBe(
    f.request.operationId,
  );
});

test("native Factory installer preserves both members and blocks fresh attempts after attachment failure", async () => {
  const f = await nativeInstallFixture();
  Object.preventExtensions(f.runtime);
  expect(await f.adapter.install(f.request)).toMatchObject({
    outcome: "uncertain",
    reconciliationRequired: true,
  });
  for (const role of ["factory", "builds"] as const)
    expect((await f.deps.workspaces.get(role))?.factoryMembership?.role).toBe(role);
  expect((await f.deps.projects.get(f.request.projectId))?.factoryInstallation?.stage).toBe(
    "binding",
  );
  expect(await f.adapter.readSetup(f.request.projectId)).toMatchObject({
    state: "held",
    operations: { install: false },
  });
  expect(
    await createNativeFactoryInstallAdapter(f.deps).install({
      ...f.request,
      operationId: "fresh-attempt",
    }),
  ).toMatchObject({ outcome: "refused", code: "held" });
  expect(f.stop).not.toHaveBeenCalled();
});

test("native Factory installer does not bind after a persisted checkpoint response becomes uncertain", async () => {
  const f = await nativeInstallFixture("checkpoint_acknowledgment");
  expect(await f.adapter.install(f.request)).toMatchObject({
    outcome: "uncertain",
    reconciliationRequired: true,
  });
  const projects = new FileBackedProjectRegistry(
    path.join(f.root, "projects.json"),
    createTestLogger(),
  );
  expect((await projects.get(f.request.projectId))?.factoryInstallation?.stage).toBe("binding");
  for (const record of await f.deps.workspaces.list())
    expect(record.factoryMembership).toBeUndefined();
  expect(f.runtime.factoryObservation).toBeUndefined();
  expect(
    await createNativeFactoryInstallAdapter(f.deps).readSetup(f.request.projectId),
  ).toMatchObject({ state: "held", operations: { install: false } });
});

test("native Factory installer reports post-completion owner loss without undoing retained attachment", async () => {
  const f = await nativeInstallFixture();
  const unsubscribe = f.deps.projects.subscribeToMutations((mutation) => {
    if (mutation.project?.factoryInstallation?.stage === "attached") f.revoke();
  });
  expect(await f.adapter.install(f.request)).toMatchObject({
    outcome: "uncertain",
    reconciliationRequired: true,
  });
  unsubscribe();
  expect((await f.deps.projects.get(f.request.projectId))?.factoryInstallation?.stage).toBe(
    "attached",
  );
  expect(f.runtime.factoryObservation?.binding).toEqual(f.source.binding);
  for (const role of ["factory", "builds"] as const)
    expect((await f.deps.workspaces.get(role))?.factoryMembership?.role).toBe(role);
  expect(f.stop).not.toHaveBeenCalled();
});

test.each(["lifecycle", "policy", "authentication", "native_reader"] as const)(
  "native Factory installer rejects retained %s replacement before native effects",
  async (change) => {
    const f = await nativeInstallFixture();
    if (change === "lifecycle") f.runtime.stop = async () => {};
    if (change === "policy") f.source.policy.launchFloorPercent += 1;
    if (change === "authentication") f.source.authentication.assertCurrent = () => {};
    if (change === "native_reader") f.deps.projects.getLoadedRecord = () => null;
    expect(await f.adapter.install(f.request)).toMatchObject({ outcome: "refused", code: "held" });
    expect((await f.deps.projects.get(f.request.projectId))?.factoryInstallation).toBeUndefined();
    for (const record of await f.deps.workspaces.list())
      expect(record.factoryMembership).toBeUndefined();
  },
);

test("startup observation combines the existing native account envelope without writes or sampling", async () => {
  const f = controllerProjectionFixture();
  const policy = {
    ...f.source.policy,
    estimatedHourly: { bucketId: "weekly", windowId: "primary", maxConsumedPoints: 3 },
  };
  const contract = { ...createAccountingContract(policy), envelope: policy };
  const store = { accountingContract: vi.fn(async () => contract) };
  const source = await createFactoryControllerObservationSource({ source: f.source, store });
  expect(source.policy.estimatedHourly?.maxConsumedPoints).toBe(3);
  expect(f.source.policy.estimatedHourly?.maxConsumedPoints).toBe(15);
  expect(f.source.readLifecycle).not.toHaveBeenCalled();
  expect(f.source.readAccountObservation).not.toHaveBeenCalled();
  const provider = new FactoryControllerObservationProvider(source, () => f.now);
  const snapshot = FactorySnapshotSchema.parse(
    await provider.snapshot({ projectId: source.binding.projectId }),
  );
  expect(snapshot.account).toEqual({
    usagePoints: 4.5,
    limitPoints: 3,
    observedAt: f.observation.observedAt,
    unit: "allowance-points",
  });
  expect(snapshot.admission).toEqual(f.lifecycle.admission);
});

test("startup observation requires existing matching accounting semantics", async () => {
  const f = controllerProjectionFixture();
  await expect(
    createFactoryControllerObservationSource({
      source: f.source,
      store: { accountingContract: async () => null },
    }),
  ).rejects.toThrow("current native account contract");
  const contract = createAccountingContract({
    ...f.source.policy,
    account: { issuer: "codex", accountId: "other-account" },
  });
  await expect(
    createFactoryControllerObservationSource({
      source: f.source,
      store: { accountingContract: async () => contract },
    }),
  ).rejects.toThrow("differs from the native account contract");
  expect(f.source.readAccountObservation).not.toHaveBeenCalled();
});

test("startup observation supports an unchanged legacy contract without synthesizing an envelope", async () => {
  const f = controllerProjectionFixture();
  const contract = createAccountingContract(f.source.policy);
  const source = await createFactoryControllerObservationSource({
    source: f.source,
    store: { accountingContract: async () => contract },
  });
  expect(source.policy).toEqual(f.source.policy);
  await expect(source.readAccountObservation()).resolves.toEqual(f.observation);
  expect(contract).not.toHaveProperty("envelope");
});

test("startup observation rejects contract content changes even when revision is reused", async () => {
  const f = controllerProjectionFixture();
  const contract = createAccountingContract(f.source.policy);
  const store = { accountingContract: vi.fn(async () => contract) };
  const source = await createFactoryControllerObservationSource({ source: f.source, store });
  contract.estimatedWindow = { bucketId: "weekly", windowId: "replacement" };
  await expect(source.readLifecycle()).rejects.toThrow("account contract changed");
  expect(f.source.readLifecycle).not.toHaveBeenCalled();
});

test("startup observation brackets pending telemetry with current account contract", async () => {
  const f = controllerProjectionFixture();
  const contract = createAccountingContract(f.source.policy);
  f.source.readAccountObservation = async () => {
    contract.revision = "replacement";
    return f.observation;
  };
  const source = await createFactoryControllerObservationSource({
    source: f.source,
    store: { accountingContract: async () => contract },
  });
  await expect(source.readAccountObservation()).rejects.toThrow("account contract changed");
});

test("startup observation rejects replaced readers and policies rather than recapturing them", async () => {
  const f = controllerProjectionFixture();
  const contract = createAccountingContract(f.source.policy);
  const store = { accountingContract: async () => contract };
  const source = await createFactoryControllerObservationSource({ source: f.source, store });
  store.accountingContract = async () => contract;
  expect(() => source.authority.assertCurrent()).toThrow("account reader changed");
  const other = controllerProjectionFixture();
  const next = await createFactoryControllerObservationSource({
    source: other.source,
    store: { accountingContract: async () => createAccountingContract(other.source.policy) },
  });
  other.source.policy.launchFloorPercent = 11;
  expect(() => next.authority.assertCurrent()).toThrow("source or account reader changed");
});

test("retained observation attaches once without starting or replacing controller execution", () => {
  const f = attachmentFixture();
  const prepare = f.runtime.prepare;
  const observation = attachFactoryControllerObservation(f);
  expect(attachFactoryControllerObservation(f)).toBe(observation);
  expect(f.runtime.factoryObservation).toBe(observation);
  expect(f.runtime.prepare).toBe(prepare);
  expect(f.stop).not.toHaveBeenCalled();
  expect(() =>
    attachFactoryControllerObservation({ runtime: f.runtime, source: { ...f.source } }),
  ).toThrow("source already attached");
});

test("retained observation refuses an existing delegate or immutable stop without changing runtime", () => {
  const f = attachmentFixture();
  f.runtime.factoryObservation = f.provider;
  expect(() => attachFactoryControllerObservation(f)).toThrow("unattached runtime");
  expect(f.runtime.stop).toBe(f.stop);
  expect(f.runtime.factoryObservation).toBe(f.provider);
  const other = attachmentFixture();
  Object.defineProperty(other.runtime, "stop", { writable: false });
  expect(() => attachFactoryControllerObservation(other)).toThrow("final stop method");
  expect(other.runtime.factoryObservation).toBeUndefined();
});

test("retained observation revokes synchronously and preserves failed settlement and retry", async () => {
  const f = attachmentFixture();
  const failure = new Error("Retained custody is unsettled");
  f.stop.mockRejectedValueOnce(failure);
  const observation = attachFactoryControllerObservation(f);
  const stopped = f.runtime.stop();
  expect(() => observation.assertCurrent()).toThrow("runtime stopped");
  await expect(stopped).rejects.toBe(failure);
  await f.runtime.stop();
  expect(f.stop).toHaveBeenCalledTimes(2);
  await expect(observation.snapshot({ projectId: f.source.binding.projectId })).rejects.toThrow(
    "runtime stopped",
  );
  expect(() => attachFactoryControllerObservation(f)).toThrow("runtime stopped");
});

test("retained observation rejects an in-flight read when shutdown starts", async () => {
  const f = attachmentFixture();
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.source.builds.inspect = async () => {
    await pending;
    return f.builds;
  };
  const observation = attachFactoryControllerObservation(f);
  const result = observation.snapshot({ projectId: f.source.binding.projectId });
  await f.runtime.stop();
  if (!release) throw new Error("Test gate missing");
  release();
  await expect(result).rejects.toThrow("runtime stopped");
});

test("retained observation awaits native lifecycle reads and rejects replaced shutdown wrappers", async () => {
  const f = attachmentFixture();
  const lifecycle = vi.fn(async () => f.lifecycle);
  f.source.readLifecycle = lifecycle;
  const observation = attachFactoryControllerObservation(f);
  const value = FactorySnapshotSchema.parse(
    await observation.snapshot({ projectId: f.source.binding.projectId }),
  );
  expect(value.admission).toEqual(f.lifecycle.admission);
  expect(lifecycle).toHaveBeenCalledTimes(2);
  f.runtime.stop = async () => {};
  expect(() => observation.assertCurrent()).toThrow("lifecycle replaced");
});

test("retained controller projection composes with native identity checks without exposing private state", async () => {
  const f = controllerProjectionFixture();
  f.claims.active = {
    attemptId: "claim-1",
    approval: { repository: "example/repository", issueNumber: 1 },
    workflow: { phase: "implementation" },
    privatePath: "must-not-leak",
  };
  f.intake.active = {
    intakeId: "intake-1",
    repository: "example/repository",
    issueNumber: 2,
    phase: "execution",
    privatePath: "must-not-leak",
  };
  const before = structuredClone({
    claims: f.claims,
    intake: f.intake,
    builds: f.builds,
    observation: f.observation,
  });
  const service = new NativeFactoryObservationService(f.provider, f.native.dependencies);
  const snapshot = FactorySnapshotSchema.parse(
    await service.invoke("factory.snapshot", { projectId: "prj_test" }),
  );
  expect(snapshot.account).toEqual({
    usagePoints: 4.5,
    limitPoints: 15,
    observedAt: f.observation.observedAt,
    unit: "allowance-points",
  });
  expect(snapshot.observedAt).not.toBe(snapshot.account.observedAt);
  expect(snapshot.work.map((row) => [row.phase, row.workspaceId, row.agentId])).toEqual([
    ["recovery", null, null],
    ["recovery", null, null],
  ]);
  expect(snapshot.work[0]!.title).toContain("recorded implementation");
  expect(snapshot.work[1]!.title).toContain("recorded qualification execution");
  expect(snapshot.issues).toEqual([]);
  expect(snapshot.coverage.issues.complete).toBe(false);
  expect(Object.values(snapshot.capabilities)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
  expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
  expect(JSON.stringify(snapshot)).not.toContain("test-account");
  expect({
    claims: f.claims,
    intake: f.intake,
    builds: f.builds,
    observation: f.observation,
  }).toEqual(before);
});

test.each([
  "incomplete-hour",
  "future-outer",
  "detached-estimate",
  "future-estimate",
  "stale",
  "missing-window",
  "window-duration",
  "duplicate-window",
  "missing-measure",
  "window-identity",
  "generation",
  "account",
] as const)("retained controller projection keeps invalid %s usage null", async (change) => {
  const f = controllerProjectionFixture();
  const estimate = f.observation.estimatedHourlyUsage!;
  if (change === "incomplete-hour") estimate.coverageStart = new Date(f.now - 60_000).toISOString();
  if (change === "future-outer") f.observation.observedAt = new Date(f.now + 1000).toISOString();
  if (change === "detached-estimate")
    f.observation.observedAt = new Date(f.now - 10_000).toISOString();
  if (change === "future-estimate")
    estimate.observedAt = f.observation.observedAt = new Date(f.now + 1000).toISOString();
  if (change === "stale")
    estimate.observedAt = f.observation.observedAt = new Date(f.now - 121_000).toISOString();
  if (change === "missing-window") f.observation.windows[0]!.windowId = "other";
  if (change === "window-duration") f.observation.windows[0]!.durationMinutes = 60;
  if (change === "duplicate-window") f.observation.windows.push({ ...f.observation.windows[0]! });
  if (change === "missing-measure") estimate.consumedPoints = null;
  if (change === "window-identity") estimate.windowId = "other";
  if (change === "generation") estimate.authenticationGeneration = "other";
  if (change === "account")
    f.observation.account = { ...f.observation.account, accountId: "other" };
  const snapshot = await f.provider.snapshot({ projectId: "prj_test" });
  expect(snapshot.account.usagePoints).toBeNull();
  expect(snapshot.account.limitPoints).toBe(15);
  if (!["account", "generation", "window-identity"].includes(change))
    expect(snapshot.account.observedAt).toBe(estimate.observedAt);
});

test("retained controller projection displays valid over-limit usage without changing admission", async () => {
  const f = controllerProjectionFixture();
  f.observation.estimatedHourlyUsage!.consumedPoints = 21;
  const snapshot = await f.provider.snapshot({ projectId: "prj_test" });
  expect(snapshot.account.usagePoints).toBe(21);
  expect(snapshot.admission).toEqual(f.lifecycle.admission);
});

test("retained controller projection discloses capped pending Builds coverage", async () => {
  const f = controllerProjectionFixture();
  f.builds.requests = Array.from({ length: 101 }, (_, index) => ({
    request: {
      id: `request-${index}`,
      repository: "example/repository",
      commits: ["a".repeat(40)],
    },
    releaseId: null,
  }));
  const snapshot = await f.provider.snapshot({ projectId: "prj_test" });
  expect(snapshot.builds.pending).toHaveLength(100);
  expect(snapshot.coverage.builds).toEqual({
    complete: false,
    gaps: [
      "Verified release observation is not connected.",
      "1 pending build requests omitted by the 100-row bound.",
    ],
  });
});

test.each(["revision", "owner", "authentication", "source"] as const)(
  "retained controller projection refuses changed %s during observation",
  async (change) => {
    const f = controllerProjectionFixture();
    vi.mocked(f.source.readAccountObservation).mockImplementation(async () => {
      if (change === "revision") f.claims.revision += 1;
      if (change === "owner") Object.assign(f.source.authority.identity, { epoch: 2 });
      if (change === "authentication") f.source.authentication.authenticationGeneration = "other";
      if (change === "source") f.source.claims = { current: () => f.claims };
      return f.observation;
    });
    await expect(f.provider.snapshot({ projectId: "prj_test" })).rejects.toThrow();
  },
);

test("retained controller receipts stay unavailable and never silently resume an unknown cursor", async () => {
  const f = controllerProjectionFixture();
  const result = await f.provider.receipts({
    projectId: "prj_test",
    cursor: "unknown-cursor",
    limit: 1,
  });
  expect(result.availability).toBe("unavailable");
  expect(result.receipts).toBeNull();
  expect(result.nextCursor).toBeNull();
  expect(result.coverage).toMatchObject({ complete: false, cursorState: "expired" });
  await expect(f.provider.receipts({ projectId: "other", cursor: null, limit: 1 })).rejects.toThrow(
    "project differs",
  );
});

test("native Factory observer resolution captures one startup provider and does not disrupt startup on invalid binding", () => {
  const f = nativeObservationFixture();
  const runtime = { factoryObservation: f.provider };
  const resolve = createNativeFactoryObservationResolver(runtime, f.dependencies);
  const service = resolve();
  expect(resolve()).toBe(service);
  runtime.factoryObservation = nativeObservationFixture().provider;
  expect(resolve()).toBe(service);
  expect(createNativeFactoryObservationResolver(undefined, f.dependencies)()).toBeNull();
  f.provider.binding.serverId = "other-host";
  const malformed = createNativeFactoryObservationResolver(runtime, f.dependencies);
  runtime.factoryObservation.binding.serverId = "other-host";
  expect(() => malformed()).toThrow("binding is invalid");
});

test("native Factory current snapshots require revision and observation timestamp", async () => {
  const f = nativeObservationFixture();
  f.snapshot.freshness = { state: "current", reason: null };
  f.snapshot.revision = null;
  await expect(f.service.invoke("factory.snapshot", { projectId: "prj_test" })).rejects.toThrow(
    "coherent revision",
  );
  f.snapshot.revision = "snapshot-1";
  f.snapshot.observedAt = null;
  await expect(f.service.invoke("factory.snapshot", { projectId: "prj_test" })).rejects.toThrow(
    "observation time",
  );
});

function addNativeWork(f: ReturnType<typeof nativeObservationFixture>) {
  const workspace = structuredClone(f.workspaces[0]!);
  workspace.workspaceId = "worker";
  workspace.factoryMembership.role = "worker";
  f.workspaces.push(workspace);
  const agent = { ...f.agents[0]!, id: "worker-agent", workspaceId: "worker" };
  f.agents.push(agent);
  f.snapshot.work.push({
    id: "work-1",
    title: "Work",
    phase: "executing",
    issueUrl: null,
    workspaceId: workspace.workspaceId,
    agentId: agent.id,
    prUrl: null,
    ciUrl: null,
    blocker: null,
  });
  return { workspace, agent, work: f.snapshot.work[0]! };
}

test.each(["both", "workspace", "agent", "neither"] as const)(
  "native Factory work navigation accepts verified %s identities",
  async (shape) => {
    const f = nativeObservationFixture();
    const { work } = addNativeWork(f);
    if (shape === "agent" || shape === "neither") work.workspaceId = null;
    if (shape === "workspace" || shape === "neither") work.agentId = null;
    expect(await f.service.invoke("factory.snapshot", { projectId: "prj_test" })).toEqual(
      f.snapshot,
    );
  },
);

test.each([
  "project",
  "host",
  "installation",
  "membership",
  "agent-workspace",
  "missing-workspace",
  "missing-agent",
] as const)("native Factory work navigation rejects %s identity", async (change) => {
  const f = nativeObservationFixture();
  const { workspace, agent, work } = addNativeWork(f);
  if (change === "project") workspace.projectId = "other-project";
  if (change === "host") workspace.factoryMembership.serverId = "other-host";
  if (change === "installation") workspace.factoryMembership.installationId = "other-installation";
  if (change === "membership") workspace.factoryMembership.projectId = "other-project";
  if (change === "agent-workspace") agent.workspaceId = "builds";
  if (change === "missing-workspace") work.workspaceId = "missing";
  if (change === "missing-agent") work.agentId = "missing";
  await expect(f.service.invoke("factory.snapshot", { projectId: "prj_test" })).rejects.toThrow(
    "native work",
  );
});

test("native Factory work navigation rechecks identities before emission", async () => {
  const f = nativeObservationFixture();
  const { workspace } = addNativeWork(f);
  const get = f.dependencies.workspaces.get;
  let reads = 0;
  f.dependencies.workspaces.get = async (id) => {
    if (id === "worker" && ++reads === 2) workspace.archivedAt = "2026-10-08T01:00:00.000Z";
    return get(id);
  };
  await expect(f.service.invoke("factory.snapshot", { projectId: "prj_test" })).rejects.toThrow(
    "work identity changed",
  );
});

test("native Factory observation returns bounded DTOs without starting or changing the owner", async () => {
  const f = nativeObservationFixture();
  const before = structuredClone({
    binding: f.provider.binding,
    project: f.project,
    workspaces: f.workspaces,
    agents: f.agents,
  });
  expect(await f.service.invoke("factory.snapshot", { projectId: "prj_test" })).toEqual(f.snapshot);
  expect(
    await f.service.invoke("activity.receipts", { projectId: "prj_test", cursor: null, limit: 1 }),
  ).toEqual(f.receipts);
  expect({
    binding: f.provider.binding,
    project: f.project,
    workspaces: f.workspaces,
    agents: f.agents,
  }).toEqual(before);
  expect(f.provider.assertCurrent).toHaveBeenCalled();
});

test.each(["project", "membership", "agent", "generation"] as const)(
  "native Factory observation rejects changed %s during provider read",
  async (change) => {
    const f = nativeObservationFixture();
    f.provider.snapshot.mockImplementation(async () => {
      if (change === "project") f.project.projectKey = "remote:github.com/other/repository";
      if (change === "membership") f.workspaces[0]!.factoryMembership.installationId = "other";
      if (change === "agent") f.agents[0]!.workspaceId = "other";
      if (change === "generation")
        f.provider.assertCurrent.mockImplementation(() => {
          throw new Error("Owner changed");
        });
      return f.snapshot;
    });
    await expect(f.service.invoke("factory.snapshot", { projectId: "prj_test" })).rejects.toThrow();
  },
);

test.each(["host", "installation", "coordinator", "capability", "github"] as const)(
  "native Factory observation rejects conflicting snapshot %s",
  async (change) => {
    const f = nativeObservationFixture();
    if (change === "host") f.snapshot.serverId = "other-host";
    if (change === "installation") f.snapshot.installationId = "other";
    if (change === "coordinator") f.snapshot.coordinators[0]!.agentId = "other";
    if (change === "capability") f.snapshot.capabilities.resume = true;
    if (change === "github")
      f.snapshot.issues.push({
        id: "issue",
        number: 1,
        title: "Issue",
        url: "https://github.com/other/repository/issues/1",
        qualification: "pending",
        reason: null,
      });
    await expect(f.service.invoke("factory.snapshot", { projectId: "prj_test" })).rejects.toThrow();
  },
);

test("native Factory observation refuses missing membership before touching the provider", async () => {
  const f = nativeObservationFixture();
  f.workspaces.splice(0, 1);
  await expect(f.service.invoke("factory.snapshot", { projectId: "prj_test" })).rejects.toThrow(
    "coordinator",
  );
  expect(f.provider.snapshot).not.toHaveBeenCalled();
  await expect(f.service.invoke("factory.snapshot", { projectId: "other" })).rejects.toThrow(
    "another project",
  );
});

test.each([
  "producer",
  "project",
  "installation",
  "repository",
  "url",
  "limit",
  "verified",
] as const)("native Factory receipts reject conflicting %s", async (change) => {
  const f = nativeObservationFixture();
  const at = "2026-10-08T00:00:00.000Z";
  f.receipts.availability = "available";
  f.receipts.receipts = [
    {
      id: "delivery",
      projectId: "prj_test",
      workspaceId: null,
      agentId: null,
      installationId: "installation-test",
      kind: "publication",
      status: "completed",
      occurredAt: at,
      observedAt: at,
      verifiedAt: at,
      provenance: { source: "factory_controller", sourceId: "release", sourceRevision: "1" },
      delivery: {
        repository: "example/repository",
        sourceCommit: "a".repeat(40),
        deliveryId: "release",
        url: "https://github.com/example/repository/releases/tag/v1",
      },
      verification: { state: "verified", reason: "Synthetic independent evidence" },
      summary: "Test",
      url: null,
    },
  ];
  const receipt = f.receipts.receipts[0]!;
  if (change === "producer") f.receipts.producer.serverId = "other-host";
  if (change === "project") receipt.projectId = "other-project";
  if (change === "installation") receipt.installationId = "other";
  if (change === "repository") receipt.delivery!.repository = "other/repository";
  if (change === "url")
    receipt.delivery!.url = "https://github.com/other/repository/releases/tag/v1";
  if (change === "limit") f.receipts.receipts.push({ ...receipt, id: "second" });
  if (change === "verified") receipt.verifiedAt = null;
  await expect(
    f.service.invoke("activity.receipts", { projectId: "prj_test", cursor: null, limit: 1 }),
  ).rejects.toThrow();
});

test("native Factory receipts preserve original occurrence and independent verification times", async () => {
  const f = nativeObservationFixture();
  const occurredAt = "2026-10-07T23:00:00.000Z";
  const verifiedAt = "2026-10-08T00:00:00.000Z";
  f.receipts.availability = "available";
  f.receipts.receipts = [
    {
      id: "merge",
      projectId: "prj_test",
      workspaceId: null,
      agentId: null,
      installationId: null,
      kind: "merge",
      status: "completed",
      occurredAt,
      observedAt: verifiedAt,
      verifiedAt,
      provenance: { source: "external", sourceId: "merge", sourceRevision: "1" },
      delivery: {
        repository: "example/repository",
        sourceCommit: "b".repeat(40),
        deliveryId: "merge",
        url: "https://github.com/example/repository/pull/1",
      },
      verification: { state: "verified", reason: "Synthetic independent evidence" },
      summary: "Test",
      url: null,
    },
  ];
  const output = ActivityReceiptsSchema.parse(
    await f.service.invoke("activity.receipts", { projectId: null, cursor: null, limit: 1 }),
  );
  expect(output.receipts![0]).toMatchObject({
    occurredAt,
    verifiedAt,
    installationId: null,
    provenance: { source: "external" },
  });
});

test("native Factory archived coordinator remains observable only with explicit recovery hold", async () => {
  const f = nativeObservationFixture();
  f.workspaces[0]!.archivedAt = "2026-10-08T00:00:00.000Z";
  await expect(f.service.invoke("factory.snapshot", { projectId: "prj_test" })).rejects.toThrow(
    "recovery hold",
  );
  f.snapshot.coordinators[0]!.status = "recovery";
  expect(await f.service.invoke("factory.snapshot", { projectId: "prj_test" })).toMatchObject({
    admission: { state: "held" },
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(root: string, id: string, client = false): Promise<string> {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id, requirements: { paseo: ">=0.9.2" } }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    "export default function contribute() { return () => {}; }",
  );
  if (client) {
    await writeFile(
      path.join(directory, "index.client.tsx"),
      "export default function contribute() { const marker = 'builtin-client-marker'; void marker; return () => {}; }",
    );
  }
  return directory;
}

test("bundled Factory observes serving identity without creating or adopting work", async () => {
  const version = "0.11.0-beta.3.vorteo.195";
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-observation-"));
  roots.push(root);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: version,
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(), ["factory"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: version });
  try {
    await client.connect();
    const opened = await client.openProject(root);
    if (!opened.workspace) throw new Error(opened.error ?? "Test workspace did not open");
    const projectId = opened.workspace.projectId;
    const beforeWorkspaces = await client.fetchWorkspaces();
    const beforeAgents = await client.fetchAgents();
    const value = await client.invokePluginRpc("factory", "factory.snapshot", { projectId });
    const snapshot = FactorySnapshotSchema.parse(value);
    const setup = FactorySetupSchema.parse(
      await client.invokePluginRpc("factory", "factory.setup", { projectId }),
    );
    expect(setup).toMatchObject({
      serverId: snapshot.serverId,
      projectId,
      installationId: null,
      revision: null,
      state: "unavailable",
    });
    expect(setup.reason).toContain("installer is unavailable");
    expect(Object.values(setup.operations)).toEqual(Array(5).fill(false));
    expect(setup.observedAt).not.toBeNull();
    await expect(
      client.invokePluginRpc("factory", "factory.install", {
        projectId,
        expectedServerId: snapshot.serverId,
        expectedInstallationId: null,
        expectedRevision: "invented-precondition",
        operationId: "attempt-test",
      }),
    ).rejects.toThrow();
    expect(snapshot.serverId).toBe(client.getLastServerInfoMessage()?.serverId);
    expect(snapshot.installationId).toBeNull();
    expect(snapshot.revision).toBeNull();
    expect(snapshot.account).toEqual({
      usagePoints: null,
      limitPoints: null,
      observedAt: null,
      unit: "allowance-points",
    });
    expect(Object.values(snapshot.capabilities)).toEqual(Array(7).fill(false));
    expect(snapshot.coverage.work.complete).toBe(false);
    const receipts = ActivityReceiptsSchema.parse(
      await client.invokePluginRpc("factory", "activity.receipts", {
        projectId,
        cursor: "another-host-cursor",
        limit: 10,
      }),
    );
    expect(receipts.producer).toEqual({ serverId: snapshot.serverId, pluginId: "factory" });
    expect(receipts.receipts).toBeNull();
    expect(receipts.availability).toBe("unavailable");
    expect(receipts.nextCursor).toBeNull();
    expect(receipts.coverage.cursorState).toBe("expired");
    await client.invokePluginRpc("factory", "factory.snapshot", { projectId });
    expect((await client.fetchWorkspaces()).entries).toEqual(beforeWorkspaces.entries);
    expect((await client.fetchAgents()).entries).toEqual(beforeAgents.entries);
    await expect(
      client.invokePluginRpc("factory", "factory.snapshot", { projectId: "missing" }),
    ).rejects.toThrow("selected project is unavailable");
    await expect(
      client.invokePluginRpc("factory", "factory.command", { projectId, action: "resume" }),
    ).rejects.toThrow();
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("native Factory setup retains checkpoint holds and never treats attached metadata as live installation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-setup-"));
  roots.push(root);
  const projects = new FileBackedProjectRegistry(
    path.join(root, "projects.json"),
    createTestLogger(),
  );
  const project = createPersistedProjectRecord({
    projectId: "project-test",
    rootPath: root,
    kind: "git",
    displayName: "Setup tests",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  });
  await projects.upsert(project);
  const service = new NativeFactorySetupService({
    serverId: "serving-daemon",
    projects,
    now: () => "2026-10-08T01:00:00.000Z",
  });
  expect(await service.read({ projectId: project.projectId })).toMatchObject({
    state: "unavailable",
    installationId: null,
    revision: null,
  });
  const checkpoint = {
    serverId: "serving-daemon",
    projectId: project.projectId,
    installationId: "installation-test",
    operationId: "retained-attempt",
    revision: "pending-revision",
    observedAt: "2026-10-08T00:00:00.000Z",
    stage: "binding" as const,
    coordinators: {
      factory: { workspaceId: "factory-workspace", agentId: "factory-agent" },
      builds: { workspaceId: "builds-workspace", agentId: "builds-agent" },
    },
  };
  const pending = await projects.beginFactoryInstallation({
    expected: project,
    checkpoint,
    assertCurrent() {},
  });
  const held = await service.read({ projectId: project.projectId });
  expect(held).toMatchObject({
    state: "held",
    installationId: checkpoint.installationId,
    revision: null,
  });
  expect(Object.values(held.operations)).toEqual(Array(5).fill(false));
  await projects.completeFactoryInstallation({
    expected: pending,
    checkpoint: { ...checkpoint, stage: "attached", revision: "attached-revision" },
    assertCurrent() {},
  });
  expect(await service.read({ projectId: project.projectId })).toEqual(held);
  const reloaded = new FileBackedProjectRegistry(
    path.join(root, "projects.json"),
    createTestLogger(),
  );
  const otherHost = new NativeFactorySetupService({ serverId: "other-daemon", projects: reloaded });
  expect(await otherHost.read({ projectId: project.projectId })).toMatchObject({
    state: "held",
    installationId: null,
    revision: null,
  });
  expect(await service.read({ projectId: "missing" })).toMatchObject({ state: "unavailable" });
  expect((await projects.get(project.projectId))?.factoryInstallation?.stage).toBe("attached");
});

test("listed built-ins resolve to matching manifests and compile", async () => {
  const root = resolveBuiltinPluginsRoot();
  for (const id of builtinPlugins) {
    const directory = path.join(root, id);
    expect((await readPluginManifest(directory)).id).toBe(id);
    const findEntry = async (names: string[]) => {
      for (const name of names) {
        const entry = path.join(directory, name);
        if ((await stat(entry).catch(() => null))?.isFile()) return entry;
      }
      return null;
    };
    const bundles = await compilePlugin({
      server: await findEntry(["index.server.ts", "index.server.tsx"]),
      client: await findEntry(["index.client.ts", "index.client.tsx"]),
    });
    expect(bundles.serverBundle).toBeTruthy();
  }
});

test("listed client bundle is published while plugins are disabled; unlisted directory is inert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-builtin-fixture-"));
  roots.push(root);
  await fixture(root, "listed", true);
  await fixture(root, "unlisted", true);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["listed"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    expect(await client.listPlugins()).toEqual([]);
    const catalog = await client.getPluginCatalog();
    expect(catalog.map(({ id }) => id)).toEqual(["listed"]);
    expect(catalog[0]?.clientBundle).toContain("builtin-client-marker");
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("directory, Git, and npm installs reject a built-in ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-builtin-install-"));
  roots.push(root);
  const directory = await fixture(root, "reserved");
  const gitDirectory = await fixture(root, "git-source");
  await writeFile(
    path.join(gitDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: "reserved", requirements: { paseo: ">=0.9.2" } }),
  );
  execFileSync("git", ["init", "-q", gitDirectory]);
  execFileSync("git", [
    "-C",
    gitDirectory,
    "-c",
    "user.name=Paseo Tests",
    "-c",
    "user.email=paseo@example.test",
    "add",
    ".",
  ]);
  execFileSync("git", [
    "-C",
    gitDirectory,
    "-c",
    "user.name=Paseo Tests",
    "-c",
    "user.email=paseo@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["reserved"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    await expect(client.installDirectoryPlugin(directory)).rejects.toThrow(
      /reserved for a built-in/,
    );
    await expect(
      client.installPluginSource({ source: pathToFileURL(gitDirectory).href }),
    ).rejects.toThrow(/reserved for a built-in/);
    await expect(
      client.installPluginSource({ source: "npm:unused-fixture", id: "reserved" }),
    ).rejects.toThrow(/reserved for a built-in/);
    expect(await client.listPlugins()).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
