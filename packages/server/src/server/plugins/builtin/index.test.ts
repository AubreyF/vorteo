import {
  recoverFactoryAccount,
  reconcileFactoryExecutionOwner,
  type FactoryAccountRecoveryOptions,
  type FactoryExecutionRecoveryOptions,
} from "../../../../../../plugins/factory/server/controller/recovery.mjs";
import {
  createFactoryObservationReader,
  FactoryExecutionObservationUncertainError,
  type FactoryExecutionObservationOptions,
} from "../../../../../../plugins/factory/server/controller/execution-observation.mjs";
import { QuotaGovernorStore } from "../../agent/quota-reserve/governor-store.js";
import { captureFactoryQuotaPolicy } from "../../../../../../plugins/factory/server/controller/quota-policy.mjs";
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import {
  createFactoryGovernedStage,
  type FactoryGovernedStageOptions,
} from "../../../../../../plugins/factory/server/controller/governed-stage.mjs";
import { QuotaConstructionCleanupError } from "../../agent/agent-sdk-types.js";
import {
  advanceGovernorExecution,
  type GovernorExecution,
} from "../../agent/quota-reserve/governor-lifecycle.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { attachFactoryControllerObservation } from "../../factory/attach-controller-observation.js";
import type { GovernedScheduleRuntime } from "../../schedule/governed-runtime.js";
import { createFactoryControllerObservationSource } from "../../factory/create-controller-observation-source.js";
import { createAccountingContract } from "../../agent/quota-reserve/governor-accounting-contract.js";
import {
  FactoryControllerObservationProvider,
  type FactoryControllerObservationSource,
} from "../../factory/controller-observation-provider.js";
import type { QuotaObservation, QuotaConsumptionLimit } from "@getpaseo/protocol/quota-governor";
import {
  NativeFactoryObservationService,
  createNativeFactoryObservationResolver,
} from "../../factory/observation-service.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
} from "../../workspace-registry.js";
import {
  createNativeFactoryInstallStartup,
  createNativeFactoryInstallerResolver,
} from "../../factory/native-install-startup.js";
import { NativeFactorySetupService } from "../../factory/setup-service.js";
import {
  createNativeFactoryInstallAdapter,
  holdNativeFactoryInstallAdapter,
  nativeFactoryInstallAdapterOrigin,
} from "../../factory/native-install-adapter.js";
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

import {
  assertFactoryMergeReceipt,
  createFactoryMergeController,
  createClaimMergeJournal,
  verifyFactoryMergedReceipt,
  type FactoryMergeCandidate,
  type FactoryMergeControllerOptions,
  type FactoryMergeState,
  type FactoryMergeClaimState,
} from "../../../../../../plugins/factory/server/controller/merge-controller.mjs";
import {
  FactoryWorkflow,
  initialFactoryWorkflow,
  assertFactoryWorkflow,
  type FactoryWorkflowOptions,
  type FactoryWorkflowClaimState,
  type FactoryWorkflowAttempt,
  type FactoryWorkflowPublishedDraft,
} from "../../../../../../plugins/factory/server/controller/workflow.mjs";
import {
  assertFactoryBaseRevision,
  createPristineBaseRevision,
  factoryPreparationKey,
  factoryPreparationOperationId,
  factoryPublicationBranch,
  hasOnlyPriorRevisionExecutions,
} from "../../../../../../plugins/factory/server/controller/base-revision.mjs";
import {
  assertFactoryRetirement,
  createFactoryExternalCompletionVerifier,
  createFactoryParkingVerifier,
  type FactoryExternalRetirement,
  type FactoryParkedRetirement,
} from "../../../../../../plugins/factory/server/controller/retirement.mjs";
import {
  FactoryClaimJournal,
  type FactoryClaimAttempt,
  type FactoryClaimAuthority,
  type FactoryClaimInput,
  type FactoryWorkerExecution,
  type FactoryCustodyIdentity,
} from "../../../../../../plugins/factory/server/controller/claim-journal.mjs";
import {
  createFactorySelection,
  type FactorySelectionOptions,
} from "../../../../../../plugins/factory/server/controller/selection.mjs";
import {
  createFactoryGitHubDelivery,
  verifyFactoryReleasedDelivery,
  type FactoryDeliveryOptions,
  type FactoryDeliveryPull,
  type FactoryDeliveryNativePublication,
  type FactoryDraftPublication,
} from "../../../../../../plugins/factory/server/controller/github-delivery.mjs";
import { captureControllerOwnership } from "../../../../../../plugins/factory/server/controller/ownership.mjs";
import { createFactoryProjectGuard } from "../../../../../../plugins/factory/server/controller/project-binding.mjs";
import { openBuildJournal } from "../../../../../../plugins/factory/server/controller/build-journal.mjs";
import {
  openQualificationJournal,
  type QualificationPublicationState,
} from "../../../../../../plugins/factory/server/controller/qualification-journal.mjs";
import {
  publishQualification,
  createFactoryQualificationPublisher,
  type QualificationPublicationOptions,
} from "../../../../../../plugins/factory/server/controller/qualification-publisher.mjs";
import {
  createFactoryIntakeSelector,
  createQualifiedAssignmentVerifier,
  type FactoryQualifiedVerifierOptions,
} from "../../../../../../plugins/factory/server/controller/qualified-assignment.mjs";
import {
  approvalComment,
  issueContentDigest,
  selectApprovedIssues,
  readApprovedFactoryQueue,
  recheckFactoryAssignment,
  type FactoryQueuePolicy,
  type FactoryQueueIssue,
  type FactoryQueueComment,
  type FactoryApprovedQueueSelection,
  type FactoryQueueTimeline,
} from "../../../../../../plugins/factory/server/controller/github-queue.mjs";
import {
  devReleaseStatus,
  planDevRelease,
  planDevSourceReview,
} from "../../../../../../plugins/factory/server/controller/dev-release.mjs";

import {
  decodeGitHubResponse,
  githubRequest,
  githubJobLog,
  githubArtifactArchive,
} from "../../../../../../plugins/factory/server/controller/github-transport.mjs";

import {
  prepareQualification,
  assertQualificationCurrent,
  qualificationAuditBody,
  type QualificationInputs,
  type QualificationAssessment,
  type CriterionAssessment,
} from "../../../../../../plugins/factory/server/controller/qualification.mjs";

import {
  createFactoryQualificationReader,
  type FactoryQualificationReaderOptions,
  type FactoryQualificationSelectedSource,
} from "../../../../../../plugins/factory/server/controller/qualification-reader.mjs";

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

test("native Factory startup restores completed membership without rebinding or replaying installation", async () => {
  const f = await nativeInstallFixture();
  expect(await f.adapter.install(f.request)).toMatchObject({ outcome: "applied" });
  const beforeProject = structuredClone(await f.deps.projects.get(f.request.projectId));
  const beforeAgents = await f.deps.agents.list();
  const runtime = attachmentFixture().runtime;
  const adapter = createNativeFactoryInstallAdapter({ ...f.deps, runtime });
  expect(await adapter.readSetup(f.request.projectId)).toMatchObject({ state: "held" });
  await adapter.restore();
  expect(await adapter.readSetup(f.request.projectId)).toMatchObject({ state: "installed" });
  await adapter.restore();
  expect(await f.deps.projects.get(f.request.projectId)).toEqual(beforeProject);
  expect(await f.deps.agents.list()).toEqual(beforeAgents);
  expect(runtime.factoryObservation).toBeDefined();
  f.revoke();
  await expect(adapter.restore()).rejects.toThrow("Retained custody changed");
});

test("native Factory restoration method replacement invalidates adapter provenance", async () => {
  const f = await nativeInstallFixture();
  expect(nativeFactoryInstallAdapterOrigin(f.adapter)).not.toBeNull();
  f.adapter.restore = async () => {};
  expect(nativeFactoryInstallAdapterOrigin(f.adapter)).toBeNull();
});

test.each(["before attachment", "during observation"] as const)(
  "native Factory restoration rejects a reconciliation hold introduced %s",
  async (phase) => {
    const f = await nativeInstallFixture();
    expect(await f.adapter.install(f.request)).toMatchObject({ outcome: "applied" });
    const runtime = attachmentFixture().runtime;
    let hold = () => {};
    f.source.readLifecycle = async () => {
      if (phase === "during observation") hold();
      return f.lifecycle;
    };
    const adapter = createNativeFactoryInstallAdapter({
      ...f.deps,
      runtime,
      readProfiles() {
        if (phase === "before attachment") hold();
        return f.deps.readProfiles();
      },
    });
    hold = () => holdNativeFactoryInstallAdapter(adapter);
    await expect(adapter.restore()).rejects.toThrow("requires reconciliation");
    if (phase === "before attachment") expect(runtime.factoryObservation).toBeUndefined();
    expect(await adapter.readSetup(f.request.projectId)).toMatchObject({
      state: "held",
      operations: { install: false },
    });
    await expect(adapter.restore()).rejects.toThrow("requires reconciliation");
  },
);

test("native Factory restoration holds after configured profile changes during observation", async () => {
  const f = await nativeInstallFixture();
  expect(await f.adapter.install(f.request)).toMatchObject({ outcome: "applied" });
  const runtime = attachmentFixture().runtime;
  f.source.readLifecycle = async () => {
    f.deps.readProfiles()[0].name = "Changed profile";
    return f.lifecycle;
  };
  const adapter = createNativeFactoryInstallAdapter({ ...f.deps, runtime });
  await expect(adapter.restore()).rejects.toThrow(/profile/);
  expect(await adapter.readSetup(f.request.projectId)).toMatchObject({
    state: "held",
    operations: { install: false },
  });
  await expect(adapter.restore()).rejects.toThrow("requires reconciliation");
});

test("native Factory restoration refuses incomplete binding and never fills missing membership", async () => {
  const f = await nativeInstallFixture("checkpoint_acknowledgment");
  expect(await f.adapter.install(f.request)).toMatchObject({ outcome: "uncertain" });
  const runtime = attachmentFixture().runtime;
  const projects = new FileBackedProjectRegistry(
    path.join(f.root, "projects.json"),
    createTestLogger(),
  );
  const adapter = createNativeFactoryInstallAdapter({ ...f.deps, projects, runtime });
  await expect(adapter.restore()).rejects.toThrow("exact completed");
  expect(runtime.factoryObservation).toBeUndefined();
  expect((await projects.get(f.request.projectId))?.factoryInstallation?.stage).toBe("binding");
  for (const record of await f.deps.workspaces.list())
    expect(record.factoryMembership).toBeUndefined();
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

test("retained controller projection does not present allowance occupancy as prepaid spending", async () => {
  const f = controllerProjectionFixture();
  f.source.policy.prepaidAuthorization = {
    bucketId: "weekly",
    windowId: "primary",
    startsAt: new Date(f.now).toISOString(),
    expiresAt: new Date(f.now + 60_000).toISOString(),
  };
  const before = structuredClone(f.observation);
  const provider = new FactoryControllerObservationProvider(f.source, () => f.now);
  const snapshot = await provider.snapshot({ projectId: "prj_test" });
  expect(snapshot.account).toEqual({
    usagePoints: null,
    limitPoints: null,
    observedAt: f.observation.estimatedHourlyUsage!.observedAt,
    unit: "allowance-points",
  });
  expect(snapshot.admission).toEqual(f.lifecycle.admission);
  expect(f.observation).toEqual(before);
  expect(f.source.readAccountObservation).toHaveBeenCalledTimes(1);
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
  const version = "0.11.0-beta.3.vorteo.254";
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

async function nativeStartupInstallerFixture() {
  const f = await nativeInstallFixture();
  let dispatchable = true;
  const contract = createAccountingContract(f.source.policy);
  const store = { accountingContract: vi.fn(async () => contract) };
  const canDispatch = () => dispatchable;
  const create = createNativeFactoryInstallStartup({
    serverId: f.deps.serverId,
    projects: f.deps.projects,
    workspaces: f.deps.workspaces,
    agents: f.deps.agents,
    readProfiles: f.deps.readProfiles,
    store,
    canDispatch,
  });
  const options = {
    runtime: f.runtime,
    source: f.source,
    provider: f.deps.provider,
    profileId: f.deps.profileId,
    assertReconciled: f.deps.assertReconciled,
  };
  const adapter = await create(options);
  f.runtime.factoryInstallation = adapter;
  const installer = createNativeFactoryInstallerResolver(f.runtime, f.deps.serverId, canDispatch);
  const service = new NativeFactorySetupService({
    serverId: f.deps.serverId,
    projects: f.deps.projects,
    installer,
  });
  return {
    ...f,
    adapter,
    create,
    options,
    store,
    installer,
    service,
    setDispatchable(value: boolean) {
      dispatchable = value;
    },
  };
}

test("native Factory startup dispatches only the account-wrapped branded owner and preserves RPC identity", async () => {
  const f = await nativeStartupInstallerFixture();
  const setup = await f.service.read({ projectId: f.request.projectId });
  expect(setup).toMatchObject({ state: "ready", operations: { install: true } });
  const result = await f.service.install({ ...f.request, expectedRevision: setup.revision });
  expect(result).toMatchObject({
    outcome: "applied",
    serverId: setup.serverId,
    projectId: setup.projectId,
    operationId: f.request.operationId,
    installationId: f.source.binding.installationId,
    setup: { state: "installed", operations: { install: false } },
  });
  expect(f.store.accountingContract).toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
});

test("native Factory startup does not enable install without a loaded dispatch boundary", async () => {
  const f = await nativeStartupInstallerFixture();
  f.setDispatchable(false);
  expect(await f.service.read({ projectId: f.request.projectId })).toMatchObject({
    state: "unavailable",
    operations: { install: false },
  });
  expect(await f.service.install(f.request)).toMatchObject({
    outcome: "refused",
    code: "unavailable",
  });
  expect((await f.deps.projects.get(f.request.projectId))?.factoryInstallation).toBeUndefined();
});

test("native Factory startup refuses shape-compatible and foreign-runtime adapters", async () => {
  const f = await nativeStartupInstallerFixture();
  const foreign = { ...f.runtime };
  expect(createNativeFactoryInstallerResolver(foreign, f.deps.serverId, () => true)()).toBeNull();
  f.runtime.factoryInstallation = {
    readSetup: f.adapter.readSetup,
    install: f.adapter.install,
    restore: f.adapter.restore,
  };
  expect(createNativeFactoryInstallerResolver(f.runtime, f.deps.serverId, () => true)()).toBeNull();
  expect(() => f.installer()).toThrow("startup owner");
  expect((await f.deps.projects.get(f.request.projectId))?.factoryInstallation).toBeUndefined();
});

test("native Factory startup refuses foreign host and project before effects", async () => {
  const f = await nativeStartupInstallerFixture();
  expect(
    await f.service.install({ ...f.request, expectedServerId: "another-daemon" }),
  ).toMatchObject({ outcome: "refused", code: "identity_mismatch", serverId: f.deps.serverId });
  expect(await f.service.install({ ...f.request, projectId: "another-project" })).toMatchObject({
    outcome: "refused",
    code: "unavailable",
  });
  expect((await f.deps.projects.get(f.request.projectId))?.factoryInstallation).toBeUndefined();
});

test("native Factory startup loses dispatch after checkpoint with typed uncertainty and durable protection", async () => {
  const f = await nativeStartupInstallerFixture();
  const unsubscribe = f.deps.projects.subscribeToMutations((mutation) => {
    if (mutation.project?.factoryInstallation) f.setDispatchable(false);
  });
  expect(await f.service.install(f.request)).toMatchObject({
    outcome: "uncertain",
    reconciliationRequired: true,
    operationId: f.request.operationId,
  });
  unsubscribe();
  expect((await f.deps.projects.get(f.request.projectId))?.factoryInstallation?.stage).toBe(
    "binding",
  );
  f.setDispatchable(true);
  expect(await f.service.read({ projectId: f.request.projectId })).toMatchObject({
    state: "held",
    operations: { install: false },
  });
  expect(await f.service.install({ ...f.request, operationId: "fresh-attempt" })).toMatchObject({
    outcome: "refused",
    code: "held",
  });
});

test("native Factory startup replacement of adapter methods cannot advertise or dispatch installation", async () => {
  const f = await nativeStartupInstallerFixture();
  const install = vi.fn(f.adapter.install);
  f.adapter.install = install;
  expect(() => f.installer()).toThrow("startup owner");
  await expect(f.service.read({ projectId: f.request.projectId })).rejects.toThrow("startup owner");
  expect(install).not.toHaveBeenCalled();
});

test("native Factory startup fresh adapter never upgrades a persisted attached checkpoint to installed", async () => {
  const f = await nativeStartupInstallerFixture();
  expect(await f.service.install(f.request)).toMatchObject({ outcome: "applied" });
  const replacement = await f.create(f.options);
  f.runtime.factoryInstallation = replacement;
  const installer = createNativeFactoryInstallerResolver(f.runtime, f.deps.serverId, () => true);
  const service = new NativeFactorySetupService({
    serverId: f.deps.serverId,
    projects: f.deps.projects,
    installer,
  });
  expect(await service.read({ projectId: f.request.projectId })).toMatchObject({
    state: "held",
    operations: { install: false },
  });
});

test("bundled GitHub transport preserves legacy paginated arrays without partial results", () => {
  const first = [{ body: 'A ] [ " \\ café', values: [[], { key: "}" }] }];
  const second = [{ number: 2 }];
  const bytes = Buffer.from(`${JSON.stringify(first)}\n[]\n${JSON.stringify(second)}\n`);
  expect(decodeGitHubResponse(bytes, true)).toEqual([...first, ...second]);
  expect(decodeGitHubResponse(Buffer.from("[]\n"), true)).toEqual([]);
});

test("bundled GitHub transport refuses incomplete or corrupt pagination", () => {
  const invalid = ["", "[1]\n[", "[1]\n{}", "[1,]", '[{"x":1]]', '["unterminated]'];
  for (const response of invalid) {
    expect(() => decodeGitHubResponse(Buffer.from(response), true)).toThrow();
  }
  expect(() => decodeGitHubResponse(Buffer.from([91, 34, 0xff, 34, 93]), true)).toThrow();
});

test("bundled GitHub transport cannot paginate writes or accept multiple ordinary documents", () => {
  expect(decodeGitHubResponse(Buffer.from('{"merged":true}'))).toEqual({ merged: true });
  expect(() => decodeGitHubResponse(Buffer.from("[] []"))).toThrow();
  expect(() => githubRequest("POST", "repos/example/project/issues", {}, true)).toThrow("reads");
  expect(() => githubRequest("GET", "repos/example/project/issues", {}, true)).toThrow("reads");
});

test("bundled GitHub evidence transport rejects invalid identities before subprocess dispatch", () => {
  for (const repository of [
    "",
    "example",
    "example/project/extra",
    "https://github.com/example/project",
  ]) {
    expect(() => githubJobLog(repository, 1)).toThrow("identity");
    expect(() => githubArtifactArchive(repository, 1)).toThrow("identity");
  }
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => githubJobLog("example/project", id)).toThrow("identity");
    expect(() => githubArtifactArchive("example/project", id)).toThrow("identity");
  }
});

const qualificationNow = Date.parse("2026-10-06T12:00:00Z");
function qualificationFixture() {
  const input: QualificationInputs = {
    repository: "example/product",
    policySha256: "a".repeat(64),
    permitted: true,
    issue: {
      number: 1,
      title: "Fix search error",
      body: "Show failure without stale results",
      state: "open",
      assignees: [],
    },
    dependencies: [],
    relatedPulls: [],
    sourceInputs: [{ path: "src/search.ts", blob: "b".repeat(40) }],
    evidence: [
      { id: "issue", sha256: "c".repeat(64) },
      { id: "source", sha256: "d".repeat(64) },
    ],
  };
  function criterion(reason: string): CriterionAssessment {
    return { verdict: "pass", reason, evidence: ["issue", "source"] };
  }
  const assessment: QualificationAssessment = {
    issueNumber: 1,
    decision: "ready",
    summary: "Bounded search correction with a regression case.",
    criteria: {
      outcome: criterion("Inspected outcome"),
      scope: criterion("Inspected scope"),
      acceptance: criterion("Inspected acceptance"),
      verification: criterion("Inspected verification"),
      dependencies: criterion("Inspected dependencies"),
      duplicates: criterion("Inspected duplicates"),
      ownership: criterion("Inspected ownership"),
      authority: criterion("Inspected authority"),
    },
  };
  return {
    input,
    assessment,
    executionId: "11111111-1111-4111-8111-111111111111",
    reviewedAt: new Date(qualificationNow).toISOString(),
    validUntil: new Date(qualificationNow + 3600000).toISOString(),
  };
}

test("bundled qualification retains exact evidence and canonical order without granting execution", () => {
  const f = qualificationFixture();
  const result = prepareQualification(f);
  expect(
    assertQualificationCurrent({ ...result, input: f.input, now: qualificationNow }).assessment
      .decision,
  ).toBe("ready");
  expect(result.receipt.executionId).toBe(f.executionId);
  expect(result.receipt.snapshot.sourceInputs[0].blob).toBe("b".repeat(40));
  f.input.evidence.reverse();
  expect(prepareQualification(f)).toEqual(result);
  f.assessment.summary = "Changed model output";
  expect(result.receipt.assessment.summary).not.toBe(f.assessment.summary);
});

test("bundled qualification admission rejects drift in issue, source, policy, dependency and ownership", () => {
  const changes: Array<(f: ReturnType<typeof qualificationFixture>) => void> = [
    (f) => {
      f.input.issue.body = "Broader request";
    },
    (f) => {
      f.input.sourceInputs[0].blob = "e".repeat(40);
    },
    (f) => {
      f.input.policySha256 = "f".repeat(64);
    },
    (f) => {
      f.input.dependencies.push({ repository: "example/product", number: 2, state: "open" });
    },
    (f) => {
      f.input.evidence[0].sha256 = "e".repeat(64);
    },
    (f) => {
      f.input.issue.assignees.push({ id: 99 });
    },
    (f) => {
      f.input.relatedPulls.push({ number: 3, state: "open", head: "c".repeat(40) });
    },
    (f) => {
      f.input.permitted = false;
    },
  ];
  for (const change of changes) {
    const f = qualificationFixture();
    const result = prepareQualification(f);
    change(f);
    expect(() =>
      assertQualificationCurrent({ ...result, input: f.input, now: qualificationNow }),
    ).toThrow();
  }
});

test("bundled qualification refuses model-invented evidence, incomplete criteria and extra authority", () => {
  const changes: Array<(f: ReturnType<typeof qualificationFixture>) => void> = [
    (f) => {
      f.assessment.criteria.acceptance.verdict = "unknown";
    },
    (f) => {
      f.assessment.criteria.acceptance.evidence = [];
    },
    (f) => {
      f.assessment.criteria.scope.evidence = ["imaginary-owner-approval"];
    },
    (f) => {
      Object.assign(f.assessment, { grantsProviderAuthority: true });
    },
    (f) => {
      f.input.permitted = false;
    },
  ];
  for (const change of changes) {
    const f = qualificationFixture();
    change(f);
    expect(() => prepareQualification(f)).toThrow();
  }
});

test("bundled qualification records blocked decisions without turning them into dispatch authority", () => {
  const f = qualificationFixture();
  f.assessment.decision = "needs-information";
  f.assessment.criteria.acceptance = {
    verdict: "unknown",
    reason: "Required behavior is unspecified",
    evidence: ["issue"],
  };
  const result = prepareQualification(f);
  expect(result.receipt.assessment.criteria.acceptance.reason).toBe(
    "Required behavior is unspecified",
  );
  expect(() =>
    assertQualificationCurrent({ ...result, input: f.input, now: qualificationNow }),
  ).toThrow("fresh review");
});

test("bundled qualification expires and rejects future review or tampered receipts", () => {
  const f = qualificationFixture();
  const result = prepareQualification(f);
  for (const now of [qualificationNow - 1, qualificationNow + 3600000, NaN]) {
    expect(() => assertQualificationCurrent({ ...result, input: f.input, now })).toThrow();
  }
  result.receipt.assessment.summary += " changed";
  expect(() =>
    assertQualificationCurrent({ ...result, input: f.input, now: qualificationNow }),
  ).toThrow("changed");
});

test("bundled qualification audit is attributable and refuses oversized comments", () => {
  const f = qualificationFixture();
  const result = prepareQualification(f);
  expect(qualificationAuditBody(result)).toContain(
    `<!-- vorton-factory:qualification:v1:${result.receiptSha256} -->`,
  );
  expect(qualificationAuditBody(result).startsWith("(AI Generated).\n\n")).toBe(true);
  for (let i = 0; i < 100; i++) {
    f.input.sourceInputs.push({ path: `src/${"x".repeat(700)}/${i}.ts`, blob: "b".repeat(40) });
  }
  expect(() => qualificationAuditBody(prepareQualification(f))).toThrow("comment bound");
});

const executeReaderGit = promisify(execFile);
const readerHash = (value: string) => createHash("sha256").update(value).digest("hex");
interface QualificationReaderFixtureIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  assignees: Array<{ id: number }>;
}
interface QualificationReaderFixtureDependency {
  number: number;
  repository_url: string;
  state: "open" | "closed";
}
interface QualificationReaderFixtureRelatedIssue {
  number: number;
  repository_url: string;
  pull_request?: Record<string, never>;
}
interface QualificationReaderFixtureEvent {
  event: string;
  source?: { issue?: QualificationReaderFixtureRelatedIssue };
}
interface QualificationReaderFixturePull {
  number: number;
  state: "open" | "closed";
  head: { sha: string };
  base: { repo: { full_name: string } };
}
interface QualificationReaderFixtureState {
  commit: string;
  issue: QualificationReaderFixtureIssue;
  dependencies: QualificationReaderFixtureDependency[];
  timeline: QualificationReaderFixtureEvent[];
  permitted: boolean;
  pulls: Record<string, QualificationReaderFixturePull>;
  selected: FactoryQualificationSelectedSource[];
}
async function qualificationReaderFixture(
  readerOptions: Partial<FactoryQualificationReaderOptions> = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-intake-reader-"));
  roots.push(root);
  const git = async (...args: string[]) =>
    (await executeReaderGit("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "-b", "dev");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("remote", "add", "origin", "https://github.com/example/product.git");
  // Local repository configuration only. The capture still executes its real
  // immutable Git reads and fetch; no network or owner registry is touched.
  await git("config", `url.file://${root}.insteadOf`, "https://github.com/example/product.git");
  const config = JSON.stringify({
    repository: "example/product",
    baseBranch: "dev",
  });
  await writeFile(path.join(root, "vorton.factory.json"), config);
  await writeFile(path.join(root, "AGENTS.md"), "Root instructions");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/AGENTS.md"), "Scoped instructions");
  await writeFile(path.join(root, "src/task.mjs"), "export const task = true;");
  await git("add", ".");
  await git("commit", "-m", "fixture");
  const state: QualificationReaderFixtureState = {
    commit: await git("rev-parse", "HEAD"),
    issue: {
      number: 7,
      title: "Fix task",
      body: "Acceptance and scope",
      state: "open",
      labels: [],
      assignees: [],
    },
    dependencies: [],
    timeline: [],
    permitted: true,
    pulls: {},
    selected: [],
  };
  const base = "repos/example/product";
  const request = async (method: "GET", endpoint: string): Promise<unknown> => {
    assert.equal(method, "GET");
    if (endpoint === `${base}/issues/7`) return structuredClone(state.issue);
    if (endpoint === `${base}/git/ref/heads/dev`)
      return { object: { type: "commit", sha: state.commit } };
    if (endpoint === `${base}/issues/7/dependencies/blocked_by?per_page=100&page=1`)
      return structuredClone(state.dependencies);
    if (endpoint === `${base}/issues/7/timeline?per_page=100&page=1`)
      return structuredClone(state.timeline);
    if (endpoint.startsWith(`${base}/pulls/`))
      return structuredClone(state.pulls[endpoint.slice(`${base}/pulls/`.length)]);
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  const options: FactoryQualificationReaderOptions = {
    authority: { assertCurrent() {} },
    repositoryRoot: root,
    policy: {
      config: { repository: "example/product", baseBranch: "dev" },
      configSha256: readerHash(config),
    },
    sourcePaths: ["src/task.mjs", "src/missing.mjs"],
    authorizeScope: async () => state.permitted,
    request,
    executeGit: async (command, args, gitOptions) =>
      args.slice(2).join(" ") === "remote get-url origin"
        ? { stdout: Buffer.from("https://github.com/example/product.git\n") }
        : executeReaderGit(command, args, gitOptions),
  };
  const makeReader = (extra: Partial<FactoryQualificationReaderOptions> = {}) =>
    createFactoryQualificationReader({ ...options, ...readerOptions, ...extra });
  return { root, git, state, reader: makeReader(), makeReader, request };
}

test("bundled qualification reader capture retains actual source and ancestor instructions; ready projection does not invalidate its own audit", async () => {
  const { reader, state } = await qualificationReaderFixture();
  const packet = await reader.capture(7);
  assert.equal(
    packet.documents.find((item) => item.id === "source:src/AGENTS.md").text,
    "Scoped instructions",
  );
  assert.equal(
    packet.input.sourceInputs.find((item) => item.path === "src/missing.mjs").blob,
    null,
  );
  for (const document of packet.documents) assert.equal(readerHash(document.text), document.sha256);
  const criteria = Object.fromEntries(
    [
      "outcome",
      "scope",
      "acceptance",
      "verification",
      "dependencies",
      "duplicates",
      "ownership",
      "authority",
    ].map((name) => [name, { verdict: "pass", reason: "Fixture evidence", evidence: ["issue"] }]),
  );
  const decision = prepareQualification({
    input: packet.input,
    assessment: {
      issueNumber: 7,
      decision: "ready",
      summary: "Bounded fixture",
      criteria,
    },
    executionId: "00000000-0000-4000-8000-000000000001",
    reviewedAt: "2026-10-06T00:00:00Z",
    validUntil: "2026-10-07T00:00:00Z",
  });
  state.issue.labels.push({ name: "factory:ready" });
  assertQualificationCurrent({
    ...decision,
    input: await reader.readInputs(packet.snapshot),
    now: Date.parse("2026-10-06T01:00:00Z"),
  });
  state.issue.labels.push({ name: "owner-hold" });
  assert.throws(() =>
    assertQualificationCurrent({
      ...decision,
      input: { ...packet.input, permitted: false },
      now: Date.parse("2026-10-06T01:00:00Z"),
    }),
  );
  assert.notEqual((await reader.capture(7)).inputSha256, packet.inputSha256);
});

test("bundled qualification reader sees fresh source, dependencies and related PR identities instead of trusting supplied evidence", async () => {
  const { reader, state, root, git } = await qualificationReaderFixture();
  const before = await reader.capture(7);
  await writeFile(path.join(root, "src/task.mjs"), "export const task = false;");
  await git("add", ".");
  await git("commit", "-m", "changed source");
  state.commit = await git("rev-parse", "HEAD");
  state.dependencies = [
    {
      number: 8,
      repository_url: "https://api.github.com/repos/example/product",
      state: "open",
    },
  ];
  state.timeline = [
    {
      event: "cross-referenced",
      source: {
        issue: {
          number: 9,
          repository_url: "https://api.github.com/repos/example/product",
          pull_request: {},
        },
      },
    },
  ];
  state.pulls[9] = {
    number: 9,
    state: "open",
    head: { sha: state.commit },
    base: { repo: { full_name: "example/product" } },
  };
  const fresh = await reader.capture(7);
  assert.notEqual(fresh.inputSha256, before.inputSha256);
  assert.equal(fresh.input.dependencies[0].state, "open");
  assert.equal(fresh.input.relatedPulls[0].head, state.commit);
  assert.equal(
    fresh.documents.find((item) => item.id === "source:src/task.mjs").text,
    "export const task = false;",
  );
  await assert.rejects(
    reader.readInputs({ ...before.snapshot, sourceInputs: [] }),
    /inspection scope/,
  );
});

test("bundled qualification reader refuses source symlinks and changed policy without following checkout paths", async () => {
  const { reader, state, root, git } = await qualificationReaderFixture();
  await rm(path.join(root, "src/task.mjs"));
  await symlink("/etc/passwd", path.join(root, "src/task.mjs"));
  await git("add", ".");
  await git("commit", "-m", "symlink fixture");
  state.commit = await git("rev-parse", "HEAD");
  await assert.rejects(reader.capture(7), /regular committed file/);
  await rm(path.join(root, "src/task.mjs"));
  await writeFile(path.join(root, "src/task.mjs"), "ok");
  await writeFile(path.join(root, "vorton.factory.json"), "{}");
  await git("add", ".");
  await git("commit", "-m", "policy fixture");
  state.commit = await git("rev-parse", "HEAD");
  await assert.rejects(reader.capture(7), /repository policy changed/);
});

test("bundled qualification reader refuses external PR ambiguity and oversized source evidence", async () => {
  const { reader, state, root, git } = await qualificationReaderFixture();
  state.timeline = [
    {
      event: "cross-referenced",
      source: {
        issue: {
          number: 9,
          repository_url: "https://api.github.com/repos/other/project",
          pull_request: {},
        },
      },
    },
  ];
  await assert.rejects(reader.capture(7), /external or unidentified/);
  state.timeline = [];
  await writeFile(path.join(root, "src/task.mjs"), "x".repeat(65537));
  await git("add", ".");
  await git("commit", "-m", "size fixture");
  state.commit = await git("rev-parse", "HEAD");
  await assert.rejects(reader.capture(7), /source file exceeds/);
});

test("bundled qualification reader cancelled capture starts no source or network work", async () => {
  const { reader } = await qualificationReaderFixture();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(reader.capture(7, abort.signal), /capture stopped/);
});

test("bundled qualification reader per-issue selector captures distinct committed scope and invalidates changed policy or resolution", async () => {
  let selectedPath = "src/task.mjs";
  const { reader, makeReader, state, root, git } = await qualificationReaderFixture({
    sourcePaths: [],
    selectorPolicySha256: readerHash("reviewed selector v1"),
    standingScope: "Development only; missing provider approval must block readiness.",
    resolveSourcePaths: async ({ commit, issue, inventory }) => {
      assert.equal(commit, state.commit);
      assert.deepEqual(
        typeof issue === "object" && issue !== null && "number" in issue ? issue.number : null,
        7,
      );
      assert.ok(
        inventory.some((item) => item.path === selectedPath && /^[a-f0-9]{40}$/.test(item.blob)),
      );
      return [{ path: selectedPath, reason: "Trusted fixture rule, not issue authority" }];
    },
  });
  const first = await reader.capture(7);
  assert.match(
    first.documents.find((item) => item.id === "standing-scope").text,
    /missing provider approval/,
  );
  assert.match(first.documents.find((item) => item.id === "source-selection").text, /uncaptured/);
  assert.ok(first.input.sourceInputs.some((item) => item.path === "src/AGENTS.md"));
  await reader.readInputs(first.snapshot);
  await assert.rejects(
    makeReader({ selectorPolicySha256: readerHash("changed policy") }).readInputs(first.snapshot),
    /selector policy/,
  );
  await writeFile(path.join(root, "src/other.mjs"), "export const other = true;");
  await git("add", ".");
  await git("commit", "-m", "next source");
  state.commit = await git("rev-parse", "HEAD");
  selectedPath = "src/other.mjs";
  const second = await reader.capture(7);
  assert.ok(second.input.sourceInputs.some((item) => item.path === selectedPath));
  assert.ok(!second.input.sourceInputs.some((item) => item.path === "src/task.mjs"));
  await assert.rejects(reader.readInputs(first.snapshot), /inspection scope/);
  state.permitted = false;
  assert.equal((await reader.capture(7)).input.permitted, false);
});

test("bundled qualification reader per-issue selector refuses invalid, oversized and symlink scope without following it", async () => {
  const { reader, state, root, git } = await qualificationReaderFixture({
    sourcePaths: [],
    selectorPolicySha256: readerHash("bounded selector"),
    resolveSourcePaths: async () => state.selected,
  });
  for (const selected of [
    [{ path: "../outside", reason: "hint" }],
    Array.from({ length: 65 }, (_, i) => ({ path: `src/${i}`, reason: "hint" })),
    [
      { path: "src/task.mjs", reason: "hint" },
      { path: "src/task.mjs", reason: "duplicate" },
    ],
  ]) {
    state.selected = selected;
    await assert.rejects(reader.capture(7), /source selection is invalid/);
  }
  await symlink("/etc/passwd", path.join(root, "src/link"));
  await git("add", ".");
  await git("commit", "-m", "unsafe source");
  state.commit = await git("rev-parse", "HEAD");
  state.selected = [{ path: "src/link", reason: "Untrusted hint" }];
  await assert.rejects(reader.capture(7), /regular committed file/);
  state.selected = [{ path: "src/absent", reason: "Missing hint" }];
  const missing = await reader.capture(7);
  assert.equal(missing.input.sourceInputs.find((item) => item.path === "src/absent").blob, null);
});

test("bundled qualification reader refuses owner loss after source selection without granting scope", async () => {
  let current = true;
  let scopeCalls = 0;
  const f = await qualificationReaderFixture({
    authority: {
      assertCurrent() {
        if (!current) throw new Error("Owner changed");
      },
    },
    sourcePaths: [],
    selectorPolicySha256: readerHash("installed selector"),
    resolveSourcePaths: async () => {
      current = false;
      return [{ path: "src/task.mjs", reason: "Installed rule" }];
    },
    authorizeScope: async () => {
      scopeCalls++;
      return true;
    },
  });
  await expect(f.reader.capture(7)).rejects.toThrow("Owner changed");
  expect(scopeCalls).toBe(0);
});

test("bundled qualification reader refuses capped GitHub evidence rather than returning complete inputs", async () => {
  const f = await qualificationReaderFixture();
  let dependencyPages = 0;
  const reader = f.makeReader({
    request: async (method, endpoint) => {
      if (endpoint.includes("/dependencies/blocked_by?")) {
        dependencyPages++;
        return Array.from({ length: 100 }, (_, i) => ({
          number: i + 1,
          repository_url: "https://api.github.com/repos/example/product",
          state: "closed",
        }));
      }
      return f.request(method, endpoint);
    },
  });
  await expect(reader.capture(7)).rejects.toThrow("inspection bound");
  expect(dependencyPages).toBe(10);
});

async function qualificationRecordFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-publication-record-"));
  roots.push(root);
  await chmod(root, 0o700);
  let current = true;
  const decision = prepareQualification(qualificationFixture());
  const input = {
    root,
    receiptSha256: decision.receiptSha256,
    authority: {
      assertCurrent() {
        if (!current) throw new Error("Owner changed");
      },
    },
  };
  const state: QualificationPublicationState = {
    version: 1,
    decision,
    phase: "audit",
    commentIntent: true,
    labelIntent: false,
    commentId: null,
  };
  return {
    root,
    input,
    state,
    journal: openQualificationJournal(input),
    loseOwner() {
      current = false;
    },
    filename: path.join(root, `qualification-${decision.receiptSha256}.json`),
  };
}

test("bundled publication record preserves pending intent across replacement without initialization", async () => {
  const f = await qualificationRecordFixture();
  await expect(f.journal.write(f.state)).rejects.toThrow("Read qualification state");
  expect(await f.journal.read()).toBeNull();
  await expect(readFile(f.filename)).rejects.toMatchObject({ code: "ENOENT" });
  await f.journal.write(f.state);
  const reopened = openQualificationJournal(f.input);
  const retained = await reopened.read();
  expect(retained).toEqual(f.state);
  assert.ok(retained);
  retained.commentIntent = false;
  expect(reopened.inspect()).toEqual(f.state);
  expect((await stat(f.filename)).mode & 0o777).toBe(0o600);
});

test("bundled publication record rejects stale writers and lost owner without resetting intent", async () => {
  const f = await qualificationRecordFixture();
  const stale = openQualificationJournal(f.input);
  await stale.read();
  await f.journal.read();
  await f.journal.write(f.state);
  await expect(stale.write(f.state)).rejects.toThrow("reconcile before writing");
  const persisted = await readFile(f.filename, "utf8");
  f.loseOwner();
  await expect(f.journal.write({ ...f.state, commentIntent: false })).rejects.toThrow(
    "Owner changed",
  );
  expect(await readFile(f.filename, "utf8")).toBe(persisted);
});

test("bundled publication record rejects corrupt, permissive and linked retained files", async () => {
  const f = await qualificationRecordFixture();
  await f.journal.read();
  await f.journal.write(f.state);
  const saved = await readFile(f.filename);
  await writeFile(f.filename, "not JSON");
  expect(() => f.journal.inspect()).toThrow();
  await writeFile(f.filename, saved);
  await chmod(f.filename, 0o644);
  expect(() => f.journal.inspect()).toThrow("Unsafe qualification journal file");
  await chmod(f.filename, 0o600);
  const retained = path.join(f.root, "retained.json");
  await rename(f.filename, retained);
  await symlink(retained, f.filename);
  expect(() => f.journal.inspect()).toThrow();
  expect(await readFile(retained)).toEqual(saved);
});

test("bundled publication record rejects receipt substitution and changed directory identity", async () => {
  const f = await qualificationRecordFixture();
  await f.journal.read();
  const changed = structuredClone(f.state);
  changed.decision.receipt.assessment.summary = "Unverified replacement";
  await expect(f.journal.write(changed)).rejects.toThrow("Invalid qualification journal state");
  await expect(readFile(f.filename)).rejects.toMatchObject({ code: "ENOENT" });
  await f.journal.write(f.state);
  const moved = `${f.root}-retained`;
  roots.push(moved);
  await rename(f.root, moved);
  await mkdir(f.root, { mode: 0o700 });
  expect(() => f.journal.inspect()).toThrow("directory changed");
  expect(await readFile(path.join(moved, path.basename(f.filename)), "utf8")).toBe(
    JSON.stringify(f.state),
  );
});

interface QualificationAuditComment {
  id: number;
  user: { id: number };
  body: string;
  created_at?: string | null;
  updated_at?: string | null;
}

async function qualificationPublisherFixture() {
  const f = qualificationFixture();
  const decision = prepareQualification(f);
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-publisher-"));
  roots.push(root);
  await chmod(root, 0o700);
  const controls = {
    authorized: true,
    current: true,
    accountId: 42,
    losePost: false,
    loseBeforePost: false,
    loseLabel: false,
  };
  const comments: QualificationAuditComment[] = [];
  const labels = [{ name: "debt" }];
  const writes: string[] = [];
  const authority = {
    assertCurrent() {
      if (!controls.current) throw new Error("Owner changed");
    },
  };
  const journal = openQualificationJournal({
    root,
    receiptSha256: decision.receiptSha256,
    authority,
  });
  const options: QualificationPublicationOptions = {
    decision,
    ownerId: 42,
    now: () => qualificationNow,
    authority,
    authorize: async () => controls.authorized,
    readInputs: async () => structuredClone(f.input),
    journal,
    request: async (method, endpoint, body) => {
      if (method === "GET") {
        if (endpoint === "user") return { id: controls.accountId };
        if (endpoint.includes("/comments?")) return structuredClone(comments);
        if (endpoint === "repos/example/product/labels/factory%3Aready")
          return { name: "factory:ready" };
        return { ...structuredClone(f.input.issue), labels: structuredClone(labels) };
      }
      writes.push(`${method} ${endpoint}`);
      const saved = journal.inspect();
      assert.ok(saved);
      if (endpoint.endsWith("/comments")) {
        assert.equal(saved.commentIntent, true);
        if (controls.loseBeforePost) throw new Error("unknown POST outcome");
        assert.ok(typeof body === "object" && body !== null && "body" in body);
        assert.equal(typeof body.body, "string");
        assert.ok(typeof body.body === "string");
        const comment: QualificationAuditComment = {
          id: 10,
          user: { id: 42 },
          body: body.body,
          created_at: f.reviewedAt,
          updated_at: f.reviewedAt,
        };
        comments.push(comment);
        if (controls.losePost) throw new Error("lost response");
        return comment;
      }
      assert.equal(saved.phase, "label");
      assert.equal(saved.labelIntent, true);
      assert.equal(comments.length, 1, "immutable audit must precede ready label");
      if (method === "POST") {
        assert.ok(typeof body === "object" && body !== null && "labels" in body);
        assert.deepEqual(body.labels, ["factory:ready"]);
        labels.push({ name: "factory:ready" });
      } else {
        assert.equal(method, "DELETE");
        labels.splice(
          labels.findIndex((label) => label.name === "factory:ready"),
          1,
        );
      }
      if (controls.loseLabel) throw new Error("lost label response");
      return labels;
    },
  };
  return { root, input: f.input, options, controls, comments, labels, writes };
}

test("bundled qualification publisher persists audit before ready membership and preserves unrelated labels", async () => {
  const f = await qualificationPublisherFixture();
  const result = await publishQualification(f.options);
  expect(result).toEqual({ receiptSha256: f.options.decision.receiptSha256, commentId: 10 });
  expect(f.options.journal.inspect()?.phase).toBe("complete");
  expect(f.labels).toEqual([{ name: "debt" }, { name: "factory:ready" }]);
  expect(f.comments[0].body).toMatch(/^\(AI Generated\)\.\n\n/);
  await publishQualification(f.options);
  expect(f.writes).toHaveLength(2);
});

test("bundled qualification publisher reconciles visible lost responses without duplicate writes", async () => {
  for (const fault of ["losePost", "loseLabel"]) {
    const f = await qualificationPublisherFixture();
    if (fault === "losePost") f.controls.losePost = true;
    else f.controls.loseLabel = true;
    await expect(publishQualification(f.options)).rejects.toThrow("lost");
    f.controls.losePost = false;
    f.controls.loseLabel = false;
    await publishQualification(f.options);
    expect(f.comments).toHaveLength(1);
    expect(f.labels).toEqual([{ name: "debt" }, { name: "factory:ready" }]);
    expect(f.writes).toHaveLength(2);
  }
});

test("bundled qualification publisher holds an absent uncertain POST without replay", async () => {
  const f = await qualificationPublisherFixture();
  f.controls.loseBeforePost = true;
  await expect(publishQualification(f.options)).rejects.toThrow("unknown POST");
  f.controls.loseBeforePost = false;
  await expect(publishQualification(f.options)).rejects.toThrow("Uncertain qualification");
  expect(f.writes).toHaveLength(1);
  expect(f.labels).toEqual([{ name: "debt" }]);
  expect(f.options.journal.inspect()?.commentIntent).toBe(true);
});

test("bundled qualification publisher rejects revoked authority, changed inputs and edited audits", async () => {
  const revoked = await qualificationPublisherFixture();
  revoked.controls.authorized = false;
  await expect(publishQualification(revoked.options)).rejects.toThrow("standing authority");
  expect(revoked.writes).toHaveLength(0);
  expect(revoked.options.journal.inspect()).toBeNull();
  const changed = await qualificationPublisherFixture();
  changed.input.issue.body += " new requirements";
  await expect(publishQualification(changed.options)).rejects.toThrow("fresh review");
  expect(changed.writes).toHaveLength(0);
  const edited = await qualificationPublisherFixture();
  edited.controls.losePost = true;
  await expect(publishQualification(edited.options)).rejects.toThrow("lost response");
  edited.comments[0].updated_at = new Date(qualificationNow + 1000).toISOString();
  await expect(publishQualification(edited.options)).rejects.toThrow("audit identity changed");
  expect(edited.labels).toEqual([{ name: "debt" }]);
});

test("bundled qualification publisher preserves owner holds after completed or uncertain label writes", async () => {
  const completed = await qualificationPublisherFixture();
  await publishQualification(completed.options);
  completed.labels.pop();
  await expect(publishQualification(completed.options)).rejects.toThrow("owner hold");
  expect(completed.writes).toHaveLength(2);
  const uncertain = await qualificationPublisherFixture();
  uncertain.controls.loseLabel = true;
  await expect(publishQualification(uncertain.options)).rejects.toThrow("lost label");
  uncertain.labels.pop();
  uncertain.controls.loseLabel = false;
  await expect(publishQualification(uncertain.options)).rejects.toThrow("preserve owner changes");
  expect(uncertain.writes).toHaveLength(2);
});

test("bundled qualification publisher recovers durable audit intent across replacement and serializes replay", async () => {
  const f = await qualificationPublisherFixture();
  f.controls.losePost = true;
  const first = createFactoryQualificationPublisher({ root: f.root, ...f.options });
  await expect(first(f.options.decision)).rejects.toThrow("lost response");
  f.controls.losePost = false;
  const reopened = createFactoryQualificationPublisher({ root: f.root, ...f.options });
  await reopened(f.options.decision);
  expect(f.options.journal.inspect()?.phase).toBe("complete");
  await Promise.all([reopened(f.options.decision), reopened(f.options.decision)]);
  expect(f.comments).toHaveLength(1);
  expect(f.writes).toHaveLength(2);
});

test("bundled qualification publisher rejects account or audit sender substitution and duplicate audit identities", async () => {
  const account = await qualificationPublisherFixture();
  account.controls.accountId = 43;
  await expect(publishQualification(account.options)).rejects.toThrow("account changed");
  expect(account.writes).toHaveLength(0);
  expect(account.options.journal.inspect()).toBeNull();
  const sender = await qualificationPublisherFixture();
  sender.controls.losePost = true;
  await expect(publishQualification(sender.options)).rejects.toThrow("lost response");
  sender.comments[0].user.id = 43;
  await expect(publishQualification(sender.options)).rejects.toThrow("audit identity changed");
  expect(sender.writes).toHaveLength(1);
  const duplicate = await qualificationPublisherFixture();
  duplicate.controls.losePost = true;
  await expect(publishQualification(duplicate.options)).rejects.toThrow("lost response");
  duplicate.comments.push({ ...duplicate.comments[0], id: 11 });
  await expect(publishQualification(duplicate.options)).rejects.toThrow("audit identity changed");
  expect(duplicate.writes).toHaveLength(1);
});

test("bundled qualification publisher fails closed on owner loss after persisting write intent", async () => {
  const f = await qualificationPublisherFixture();
  const write = f.options.journal.write;
  f.options.journal.write = async (state) => {
    await write(state);
    if (state.commentIntent) f.controls.current = false;
  };
  await expect(publishQualification(f.options)).rejects.toThrow("Owner changed");
  expect(f.writes).toHaveLength(0);
  f.controls.current = true;
  expect(f.options.journal.inspect()?.commentIntent).toBe(true);
  await expect(publishQualification(f.options)).rejects.toThrow("Uncertain qualification");
  expect(f.writes).toHaveLength(0);
});

test("bundled qualification publisher reconciles a rejected record write that persisted intent", async () => {
  const f = await qualificationPublisherFixture();
  const write = f.options.journal.write;
  let interrupted = false;
  f.options.journal.write = async (state) => {
    await write(state);
    if (state.commentIntent && !interrupted) {
      interrupted = true;
      throw new Error("Directory durability outcome uncertain");
    }
  };
  await expect(publishQualification(f.options)).rejects.toThrow("durability outcome uncertain");
  expect(f.writes).toHaveLength(0);
  expect(f.options.journal.inspect()?.commentIntent).toBe(true);
  await expect(publishQualification(f.options)).rejects.toThrow("Uncertain qualification");
  expect(f.writes).toHaveLength(0);
  expect(f.labels).toEqual([{ name: "debt" }]);
});

test("bundled qualification publisher refuses absent or invalid timestamps in completed audit receipts", async () => {
  const mutations: Array<(comment: QualificationAuditComment) => void> = [
    (comment) => {
      delete comment.created_at;
      delete comment.updated_at;
    },
    (comment) => {
      comment.created_at = null;
      comment.updated_at = null;
    },
    (comment) => {
      comment.created_at = "";
      comment.updated_at = "";
    },
    (comment) => {
      comment.created_at = "not a timestamp";
      comment.updated_at = "not a timestamp";
    },
    (comment) => {
      comment.created_at = "2026";
      comment.updated_at = "2026";
    },
    (comment) => {
      comment.created_at = "2026-02-30T12:00:00Z";
      comment.updated_at = "2026-02-30T12:00:00Z";
    },
    (comment) => {
      delete comment.created_at;
    },
    (comment) => {
      delete comment.updated_at;
    },
  ];
  for (const mutate of mutations) {
    const f = await qualificationPublisherFixture();
    await publishQualification(f.options);
    const saved = f.options.journal.inspect();
    mutate(f.comments[0]);
    await expect(publishQualification(f.options)).rejects.toThrow("audit identity changed");
    expect(f.writes).toHaveLength(2);
    expect(f.options.journal.inspect()).toEqual(saved);
  }
});

function qualifiedAssignmentFixture() {
  const f = qualificationFixture();
  const issue: FactoryQueueIssue = { ...f.input.issue, labels: [{ name: "factory:ready" }] };
  f.input.issue = issue;
  const decision = prepareQualification(f);
  const binding = { ...decision, commentId: 10 };
  const comments: FactoryQueueComment[] = [
    {
      id: 10,
      user: { id: 42 },
      body: qualificationAuditBody(decision),
      created_at: f.reviewedAt,
      updated_at: f.reviewedAt,
    },
  ];
  const policy: FactoryQueuePolicy = {
    trustedCommit: "e".repeat(40),
    configSha256: f.input.policySha256,
    config: {
      repository: f.input.repository,
      issues: {
        requiredLabels: ["factory:ready"],
        excludedLabels: ["factory:human-review"],
        priorityLabels: ["priority:high"],
      },
    },
  };
  const control = { allowed: true, current: true, time: qualificationNow, dependency: false };
  const reads: string[] = [];
  const options: FactoryQualifiedVerifierOptions = {
    authority: {
      assertCurrent() {
        if (!control.current) throw new Error("Owner changed");
      },
    },
    policy,
    ownerId: 42,
    authorize: async () => control.allowed,
    readInputs: async () => structuredClone(f.input),
    now: () => control.time,
    request: async (method, endpoint) => {
      expect(method).toBe("GET");
      reads.push(endpoint);
      if (endpoint === "user") return { id: 42 };
      if (endpoint.includes("/comments?")) return structuredClone(comments);
      if (endpoint.includes("/dependencies/")) return control.dependency ? [{ state: "open" }] : [];
      if (endpoint.includes("?state=open")) return [structuredClone(issue)];
      return structuredClone(issue);
    },
  };
  return {
    input: f.input,
    issue,
    binding,
    comments,
    policy,
    control,
    reads,
    options,
    verifier: createQualifiedAssignmentVerifier(options),
  };
}

test("bundled qualified assignment intake preserves current decisions, owner holds and prior work", async () => {
  const f = qualifiedAssignmentFixture();
  const select = createFactoryIntakeSelector(f.options);
  expect(await select(f.policy)).toBeNull();
  f.control.time += 3600001;
  expect(await select(f.policy)).toEqual({ issueNumber: 1 });
  f.issue.labels = [];
  expect(await select(f.policy)).toBeNull();
  f.comments.length = 0;
  expect(await select(f.policy)).toEqual({ issueNumber: 1 });
  f.issue.labels.push({ name: "factory:human-review" });
  expect(await select(f.policy)).toBeNull();
  f.issue.labels = [];
  f.comments.push({ body: "<!-- vorton-factory:status:v1:prior -->" });
  expect(await select(f.policy)).toBeNull();
});

test("bundled qualified assignment intake avoids repeating unchanged non-ready review", async () => {
  const f = qualifiedAssignmentFixture();
  const decision = prepareQualification({
    input: f.input,
    assessment: { ...f.binding.receipt.assessment, decision: "needs-information" },
    executionId: f.binding.receipt.executionId,
    reviewedAt: f.binding.receipt.reviewedAt,
    validUntil: f.binding.receipt.validUntil,
  });
  f.comments[0].body = qualificationAuditBody(decision);
  f.issue.labels = [];
  const select = createFactoryIntakeSelector(f.options);
  expect(await select(f.policy)).toBeNull();
  f.issue.body = "Now includes the missing acceptance criterion";
  expect(await select(f.policy)).toEqual({ issueNumber: 1 });
});

test("bundled qualified assignment verifies a standing qualification without fabricated manual approval", async () => {
  const f = qualifiedAssignmentFixture();
  const queue = await f.verifier.readQueue();
  expect(queue.held).toEqual([]);
  expect(queue.eligible).toEqual([
    {
      issueNumber: 1,
      qualification: f.binding,
      approvedAt: f.binding.receipt.reviewedAt,
      priority: 1,
    },
  ]);
  const admitted = await f.verifier.admit(f.binding);
  expect(admitted.approval.delivery).toBe("reviewed-draft-only");
  expect(admitted.approvalCommentId).toBe(10);
  expect(admitted.qualification).toEqual(f.binding);
  expect(admitted.issue).toEqual(f.issue);
  expect(f.comments).toHaveLength(1);
  expect(f.reads.some((endpoint) => endpoint === "user")).toBe(true);
});

test("bundled qualified assignment refuses malformed audit dates before admission and queue ordering", async () => {
  const timestamps: unknown[] = [
    undefined,
    null,
    "",
    "not-a-date",
    "2026",
    2026,
    "2026-02-30T12:00:00Z",
  ];
  for (const timestamp of timestamps) {
    const f = qualifiedAssignmentFixture();
    const request = f.options.request;
    const verifier = createQualifiedAssignmentVerifier({
      ...f.options,
      request: async (...args) => {
        if (args[1].includes("/comments?"))
          return f.comments.map((comment) => ({
            ...comment,
            created_at: timestamp,
            updated_at: timestamp,
          }));
        return request(...args);
      },
    });
    await expect(verifier.admit(f.binding)).rejects.toThrow("audit metadata is incomplete");
    expect(await verifier.readQueue()).toEqual({
      eligible: [],
      held: [{ issueNumber: 1, reason: "qualification_metadata_invalid" }],
    });
  }
});

test("bundled qualified assignment requires both valid audit dates and holds malformed intake history", async () => {
  const metadata = [
    { created_at: undefined, updated_at: new Date(qualificationNow).toISOString() },
    { created_at: new Date(qualificationNow).toISOString(), updated_at: undefined },
    { created_at: "2026", updated_at: "2026" },
    { created_at: "2026-02-30T12:00:00Z", updated_at: "2026-02-30T12:00:00Z" },
    { created_at: 2026, updated_at: 2026 },
  ];
  for (const dates of metadata) {
    const f = qualifiedAssignmentFixture();
    const request = f.options.request;
    const options: FactoryQualifiedVerifierOptions = {
      ...f.options,
      request: async (...args) => {
        if (args[1].includes("/comments?"))
          return f.comments.map((comment) => ({ ...comment, ...dates }));
        return request(...args);
      },
    };
    const verifier = createQualifiedAssignmentVerifier(options);
    await expect(verifier.admit(f.binding)).rejects.toThrow("audit metadata is incomplete");
    expect((await verifier.readQueue()).eligible).toEqual([]);
    f.issue.body = "Changed scope needs a fresh qualification";
    expect(await createFactoryIntakeSelector(f.options)(f.policy)).toEqual({ issueNumber: 1 });
    expect(await createFactoryIntakeSelector(options)(f.policy)).toBeNull();
  }
});

test("bundled qualified assignment rejects stale, revoked, changed, forged and superseded evidence", async () => {
  const changes: Array<(f: ReturnType<typeof qualifiedAssignmentFixture>) => void> = [
    (f) => {
      f.control.allowed = false;
    },
    (f) => {
      f.control.time += 3600001;
    },
    (f) => {
      f.issue.body = "Changed";
    },
    (f) => {
      f.input.sourceInputs[0].blob = "d".repeat(40);
    },
    (f) => {
      f.control.dependency = true;
    },
    (f) => {
      f.comments[0].updated_at = new Date(qualificationNow + 1000).toISOString();
    },
    (f) => {
      f.comments.push({
        ...f.comments[0],
        id: 11,
        body: "<!-- vorton-factory:qualification:invalid -->",
      });
    },
    (f) => {
      f.comments.push({
        id: 11,
        user: { id: 42 },
        created_at: new Date(qualificationNow + 1000).toISOString(),
        body: "<!-- vorton-factory:approval:invalid -->",
      });
    },
    (f) => {
      f.comments.push({ id: 12, body: "<!-- vorton-factory:status:v1:prior -->" });
    },
    (f) => {
      f.comments[0].user = { id: 43 };
    },
  ];
  for (const change of changes) {
    const f = qualifiedAssignmentFixture();
    change(f);
    await expect(f.verifier.admit(f.binding)).rejects.toThrow();
    expect((await f.verifier.readQueue()).eligible).toEqual([]);
  }
});

test("bundled qualified assignment ongoing work keeps pinned admission while enforcing current owner holds", async () => {
  const f = qualifiedAssignmentFixture();
  const admitted = await f.verifier.admit(f.binding);
  f.control.time += 86400000;
  f.input.sourceInputs[0].blob = "d".repeat(40);
  f.comments.push({ id: 20, body: "<!-- vorton-factory:status:v1:current -->" });
  expect((await f.verifier.ongoing(admitted)).issue).toEqual(f.issue);
  f.control.allowed = false;
  await expect(f.verifier.ongoing(admitted)).rejects.toThrow("standing authority");
});

test("bundled qualified assignment propagates owner loss instead of returning held queue data", async () => {
  const f = qualifiedAssignmentFixture();
  const verifier = createQualifiedAssignmentVerifier({
    ...f.options,
    authorize: async () => {
      f.control.current = false;
      return true;
    },
  });
  await expect(verifier.readQueue()).rejects.toThrow("Owner changed");
});

test("bundled qualified assignment refuses capped queues before reading individual audits", async () => {
  const f = qualifiedAssignmentFixture();
  const options = {
    ...f.options,
    request: async () => Array.from({ length: 1001 }, () => f.issue),
  };
  await expect(createQualifiedAssignmentVerifier(options).readQueue()).rejects.toThrow(
    "exceeds its bound",
  );
  await expect(createFactoryIntakeSelector(options)(f.policy)).rejects.toThrow("exceeds its bound");
});

test("bundled qualified assignment rejects attempt drift during ongoing asynchronous verification", async () => {
  const f = qualifiedAssignmentFixture();
  const attempt = await f.verifier.admit(f.binding);
  let release = () => {
    throw new Error("Gate not initialized");
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive = () => {
    throw new Error("Arrival not initialized");
  };
  const arrival = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const request = f.options.request;
  assert.ok(request);
  const verifier = createQualifiedAssignmentVerifier({
    ...f.options,
    request: async (...args) => {
      if (args[1] === "user") {
        arrive();
        await gate;
      }
      return request(...args);
    },
  });
  const pending = verifier.ongoing(attempt);
  await arrival;
  attempt.approval.scope = "Unverified replacement scope";
  release();
  await expect(pending).rejects.toThrow("binding changed");
});

function legacyApprovalFixture(numbers = [1]): FactoryApprovedQueueSelection {
  const policy: FactoryQueuePolicy = {
    trustedCommit: "a".repeat(40),
    configSha256: "b".repeat(64),
    config: {
      repository: "example/product",
      issues: {
        requiredLabels: ["factory:ready"],
        excludedLabels: ["factory:running"],
        priorityLabels: ["priority:high", "priority:normal"],
      },
    },
  };
  const issues: FactoryQueueIssue[] = numbers.map((number) => ({
    number,
    state: "open",
    title: `Issue ${number}`,
    body: "Bounded acceptance",
    assignees: [],
    labels: [{ name: "factory:ready" }],
  }));
  const commentsByIssue = new Map<number, FactoryQueueComment[]>();
  for (const issue of issues)
    commentsByIssue.set(issue.number, [
      {
        id: issue.number,
        user: { id: 42 },
        created_at: new Date(qualificationNow).toISOString(),
        body: approvalComment({
          schemaVersion: 1,
          action: "approve",
          repository: policy.config.repository,
          issueNumber: issue.number,
          issueContentSha256: issueContentDigest(issue),
          baseCommit: policy.trustedCommit,
          configSha256: policy.configSha256,
          host: "linux-container",
          delivery: "reviewed-draft-only",
          scope: "Only the bounded fixture",
        }),
      },
    ]);
  return {
    policy,
    ownerId: 42,
    issues,
    commentsByIssue,
    dependenciesByIssue: new Map(numbers.map((number) => [number, []])),
    timelinesByIssue: new Map(numbers.map((number) => [number, []])),
    excludedIssues: [],
  };
}

function legacyComment(input: FactoryApprovedQueueSelection, number = 1) {
  const comments = input.commentsByIssue.get(number);
  assert.ok(comments);
  return comments;
}

test("bundled qualified assignment legacy ordering retains priority, approval time and issue identity", () => {
  const f = legacyApprovalFixture([3, 2, 1, 4, 5]);
  f.issues[0].labels.push({ name: "priority:normal" });
  for (const i of [1, 3, 4]) f.issues[i].labels.push({ name: "priority:high" });
  legacyComment(f, 5)[0].created_at = new Date(qualificationNow - 3600000).toISOString();
  expect(selectApprovedIssues(f).eligible.map((issue) => issue.issueNumber)).toEqual([
    5, 2, 4, 3, 1,
  ]);
});

test("bundled qualified assignment legacy labels cannot authorize forged or changed scope", () => {
  const forged = legacyApprovalFixture();
  legacyComment(forged)[0].user = { id: 7 };
  expect(selectApprovedIssues(forged).held[0].reason).toBe("approval_missing");
  const mutations: Array<(f: FactoryApprovedQueueSelection) => void> = [
    (f) => {
      f.issues[0].body += " new work";
    },
    (f) => {
      f.issues[0].title += " changed";
    },
    (f) => {
      f.policy = { ...f.policy, trustedCommit: "c".repeat(40) };
    },
    (f) => {
      f.policy = { ...f.policy, configSha256: "d".repeat(64) };
    },
  ];
  for (const mutate of mutations) {
    const f = legacyApprovalFixture();
    mutate(f);
    expect(selectApprovedIssues(f).held[0].reason).toBe("approval_scope_changed");
  }
});

test("bundled qualified assignment legacy owner revocation or malformed controls supersede approval", () => {
  for (const kind of ["revoke", "malformed"]) {
    const f = legacyApprovalFixture();
    const previous = legacyComment(f)[0];
    assert.ok(typeof previous.body === "string");
    const body =
      kind === "revoke"
        ? previous.body.replace('"approve"', '"revoke"')
        : previous.body.replace(":v1", ":v2");
    legacyComment(f).push({ ...previous, id: 2, body });
    const result = selectApprovedIssues(f);
    expect(result.eligible).toEqual([]);
    expect(result.held[0].reason).toBe(kind === "revoke" ? "approval_revoked" : "approval_invalid");
  }
});

test("bundled qualified assignment legacy holds existing assignment, dependencies, priority conflicts and delivered work", () => {
  const f = legacyApprovalFixture([1, 2, 3, 4, 5]);
  f.excludedIssues = [1];
  f.issues[1].assignees = [{ id: 7 }];
  f.dependenciesByIssue.set(3, [{ state: "open" }]);
  f.issues[3].labels.push({ name: "priority:high" }, { name: "priority:normal" });
  f.issues[4].labels.push({ name: "factory:running" });
  expect(selectApprovedIssues(f).held.map((issue) => issue.reason)).toEqual([
    "existing_assignment",
    "dependencies_unresolved",
    "conflicting_priorities",
  ]);
  const delivered = legacyApprovalFixture([1, 2, 3]);
  legacyComment(delivered).push({ body: "<!-- vorton-factory:status:v1:prior -->" });
  assert.ok(delivered.timelinesByIssue);
  delivered.timelinesByIssue.set(2, [
    { event: "cross-referenced", source: { issue: { pull_request: { url: "fixture" } } } },
  ]);
  const result = selectApprovedIssues(delivered);
  expect(result.eligible.map((issue) => issue.issueNumber)).toEqual([3]);
  expect(result.held.map((issue) => issue.reason)).toEqual([
    "prior_assignment_or_pr",
    "prior_assignment_or_pr",
  ]);
  delivered.timelinesByIssue.delete(3);
  expect(selectApprovedIssues(delivered).eligible).toEqual([]);
  expect(selectApprovedIssues(delivered).held.at(-1)?.reason).toBe("timeline_unavailable");
});

test("bundled qualified assignment legacy discovery propagates read failure without returning an empty complete queue", async () => {
  const f = legacyApprovalFixture();
  const seen: string[] = [];
  const api = async (endpoint: string) => {
    seen.push(endpoint);
    if (endpoint.includes("/comments?")) return legacyComment(f);
    if (endpoint.includes("/dependencies/") || endpoint.includes("/timeline?")) return [];
    return f.issues;
  };
  expect((await readApprovedFactoryQueue({ ...f, api })).eligible[0].issueNumber).toBe(1);
  expect(seen).toHaveLength(4);
  await expect(
    readApprovedFactoryQueue({
      ...f,
      api: async () => {
        throw new Error("offline");
      },
    }),
  ).rejects.toThrow("offline");
});

test("bundled qualified assignment legacy preclaim recheck refuses changed eligibility and prior connected work", async () => {
  const f = legacyApprovalFixture();
  const selected = selectApprovedIssues(f).eligible[0];
  const timeline: FactoryQueueTimeline[] = [];
  const options = {
    ...f,
    selected,
    readIssue: async () => f.issues[0],
    api: async (endpoint: string) => {
      if (endpoint.includes("/comments?")) return legacyComment(f);
      if (endpoint.includes("/dependencies/")) return f.dependenciesByIssue.get(1);
      if (endpoint.includes("/timeline?")) return timeline;
      throw new Error("Unexpected fixture endpoint");
    },
  };
  expect((await recheckFactoryAssignment(options)).issueNumber).toBe(1);
  f.issues[0].body += " changed";
  await expect(recheckFactoryAssignment(options)).rejects.toThrow("eligibility changed");
  const prior = legacyApprovalFixture();
  const priorSelected = selectApprovedIssues(prior).eligible[0];
  await expect(
    recheckFactoryAssignment({
      ...prior,
      selected: priorSelected,
      readIssue: async () => prior.issues[0],
      api: async (endpoint) => {
        if (endpoint.includes("/comments?")) return legacyComment(prior);
        if (endpoint.includes("/dependencies/")) return [];
        return [{ event: "connected" }];
      },
    }),
  ).rejects.toThrow("prior assignment or PR");
});

test("bundled qualified assignment reports unknown verification failure as a hold without granting work", async () => {
  const f = qualifiedAssignmentFixture();
  const verifier = createQualifiedAssignmentVerifier({
    ...f.options,
    authorize: async () => {
      throw null;
    },
  });
  expect(await verifier.readQueue()).toEqual({
    eligible: [],
    held: [{ issueNumber: 1, reason: "qualification_verification_failed" }],
  });
});

test("bundled qualified assignment captures configured policy and exclusions independently of caller aliases", async () => {
  const f = qualifiedAssignmentFixture();
  const excludedIssues = [2];
  const verifier = createQualifiedAssignmentVerifier({ ...f.options, excludedIssues });
  f.policy.config.repository = "unverified/other";
  excludedIssues.push(1);
  const admitted = await verifier.admit(f.binding);
  expect(admitted.approval.repository).toBe("example/product");
  expect(f.reads.some((endpoint) => endpoint.includes("unverified/other"))).toBe(false);
});

interface MergeFixturePull {
  number: number;
  user: { id: number };
  state: string;
  merged: boolean;
  draft: boolean;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
  title: string;
  body: string;
  mergeable: boolean;
  mergeable_state: string;
  merge_commit_sha: string | null;
  merged_at: string | null;
}

interface MergeFixtureCheck {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  app: { id: number };
}

function protectedMergeFixture() {
  const repository = "example/product";
  const head = "a".repeat(40);
  const baseCommit = "b".repeat(40);
  const mergeCommit = "c".repeat(40);
  const candidate: FactoryMergeCandidate = {
    number: 4,
    commit: head,
    branch: "fix/search",
    operationId: crypto.randomUUID(),
    publicationOperationId: crypto.randomUUID(),
  };
  const pull: MergeFixturePull = {
    number: 4,
    user: { id: 42 },
    state: "open",
    merged: false,
    draft: false,
    head: { sha: head, ref: candidate.branch, repo: { full_name: repository } },
    base: { ref: "dev", repo: { full_name: repository } },
    title: "fix: repair search",
    body: `(AI Generated).\n\n<!-- vorton-factory:publication:v1:${candidate.publicationOperationId} -->\n\nReviewed.`,
    mergeable: true,
    mergeable_state: "clean",
    merge_commit_sha: null,
    merged_at: null,
  };
  const checks: MergeFixtureCheck[] = ["Feature validation", "Tooling smoke", "Windows native"].map(
    (name, index) => ({
      id: index + 1,
      name,
      head_sha: head,
      status: "completed",
      conclusion: "success",
      app: { id: 15368 },
    }),
  );
  const rules = [
    { type: "pull_request", ruleset_id: 1, parameters: { allowed_merge_methods: ["squash"] } },
    {
      type: "required_status_checks",
      ruleset_id: 1,
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: checks
          .slice(0, 2)
          .map((item) => ({ context: item.name, integration_id: 15368 })),
      },
    },
  ];
  const controls = {
    allowed: true,
    reviewed: true,
    current: true,
    bypass: false,
    stale: false,
    lost: false,
    noApply: false,
    treeWrong: false,
    strict: true,
    mergedAt: "2026-10-06T12:00:00Z",
  };
  const state: { saved: FactoryMergeState | null; puts: number; promotions: number } = {
    saved: null,
    puts: 0,
    promotions: 0,
  };
  const request: typeof githubRequest = async (method, endpoint, body) => {
    if (method === "PUT") {
      state.puts++;
      if (!state.saved?.intent) throw new Error("Intent must be durable before merge");
      expect(endpoint).toBe(`repos/${repository}/pulls/4/merge`);
      expect(body).toEqual({
        sha: head,
        merge_method: "squash",
        commit_title: pull.title,
        commit_message: pull.body,
      });
      if (controls.noApply) throw new Error("Unknown network outcome");
      Object.assign(pull, {
        state: "closed",
        merged: true,
        merge_commit_sha: mergeCommit,
        merged_at: controls.mergedAt,
      });
      if (controls.lost) throw new Error("Lost merge response");
      return { merged: true, sha: mergeCommit };
    }
    expect(method).toBe("GET");
    if (endpoint.endsWith("/pulls/4")) return structuredClone(pull);
    if (endpoint.endsWith("/rules/branches/dev")) {
      const value = structuredClone(rules);
      value[1].parameters.strict_required_status_checks_policy = controls.strict;
      return value;
    }
    if (endpoint.endsWith("/rulesets/1"))
      return { enforcement: "active", bypass_actors: controls.bypass ? [{ actor_id: 42 }] : [] };
    if (endpoint.includes("/check-runs?"))
      return { total_count: checks.length, check_runs: structuredClone(checks) };
    if (endpoint.endsWith("/git/ref/heads/dev"))
      return { object: { type: "commit", sha: pull.merged ? mergeCommit : baseCommit } };
    if (endpoint.includes("/compare/"))
      return {
        status: controls.stale ? "diverged" : "ahead",
        merge_base_commit: { sha: pull.merged ? mergeCommit : baseCommit },
      };
    if (endpoint.endsWith(`/git/commits/${mergeCommit}`))
      return {
        sha: mergeCommit,
        parents: [{ sha: baseCommit }],
        tree: { sha: (controls.treeWrong ? "f" : "d").repeat(40) },
        message: pull.title + "\n\n" + pull.body,
      };
    if (endpoint.endsWith(`/git/commits/${head}`))
      return { sha: head, tree: { sha: "d".repeat(40) } };
    throw new Error(`Unexpected ${endpoint}`);
  };
  const options: FactoryMergeControllerOptions = {
    authority: {
      assertCurrent() {
        if (!controls.current) throw new Error("Owner changed");
      },
    },
    repository,
    ownerId: 42,
    requiredChecks: checks.map((item) => ({ name: item.name, appId: item.app.id })),
    authorize: async () => controls.allowed,
    verifyCandidate: async () => controls.reviewed,
    promote: async () => {
      state.promotions++;
      pull.draft = false;
    },
    journal: {
      read: async () => structuredClone(state.saved),
      write: async (value) => {
        state.saved = structuredClone(value);
      },
    },
    request,
  };
  return { candidate, options, request, pull, checks, rules, controls, state };
}

test("bundled protected merge promotes and verifies one squash integration with original timestamp", async () => {
  const f = protectedMergeFixture();
  f.pull.draft = true;
  const step = createFactoryMergeController(f.options);
  const result = await step(f.candidate);
  if (result.kind !== "merged") throw new Error("Expected verified merge");
  expect(f.state.promotions).toBe(1);
  expect(f.state.puts).toBe(1);
  expect(f.state.saved?.receipt).toEqual(result.receipt);
  expect(result.receipt.mergedAt).toBe("2026-10-06T12:00:00Z");
  expect(
    await verifyFactoryMergedReceipt({
      receipt: result.receipt,
      assertCurrent: f.options.authority.assertCurrent,
      request: f.request,
    }),
  ).toBe(true);
  expect((await step(f.candidate)).kind).toBe("merged");
  expect(f.state.puts).toBe(1);
});

test("bundled protected merge reconciles a lost response without another PUT", async () => {
  const f = protectedMergeFixture();
  f.controls.lost = true;
  await expect(createFactoryMergeController(f.options)(f.candidate)).rejects.toThrow(
    "Lost merge response",
  );
  expect(f.state.saved?.intent?.baseCommit).toBe("b".repeat(40));
  expect((await createFactoryMergeController(f.options)(f.candidate)).kind).toBe("merged");
  expect(f.state.puts).toBe(1);
});

test("bundled protected merge holds an uncertain unmerged request and refuses replacement intent", async () => {
  const f = protectedMergeFixture();
  f.controls.noApply = true;
  await expect(createFactoryMergeController(f.options)(f.candidate)).rejects.toThrow(
    "Unknown network outcome",
  );
  f.controls.noApply = false;
  expect(await createFactoryMergeController(f.options)(f.candidate)).toEqual({
    kind: "held",
    reason: "merge_response_unconfirmed",
  });
  await expect(
    createFactoryMergeController(f.options)({ ...f.candidate, operationId: crypto.randomUUID() }),
  ).rejects.toThrow("Another Factory merge intent");
  expect(f.state.puts).toBe(1);
});

test("bundled protected merge distinguishes CI repair, owner holds, pending checks and stale base", async () => {
  for (const conclusion of [
    "failure",
    "timed_out",
    "cancelled",
    "skipped",
    "neutral",
    "action_required",
  ]) {
    const f = protectedMergeFixture();
    f.checks[0].conclusion = conclusion;
    const kind = ["failure", "timed_out"].includes(conclusion) ? "repair_required" : "held";
    expect(await createFactoryMergeController(f.options)(f.candidate)).toEqual({
      kind,
      reason: `required_check:${f.checks[0].name}:${conclusion}`,
      evidence: {
        head: f.candidate.commit,
        checkId: 1,
        name: f.checks[0].name,
        appId: 15368,
        conclusion,
      },
    });
    expect(f.state.puts).toBe(0);
  }
  const pending = protectedMergeFixture();
  pending.checks[0].status = "in_progress";
  pending.checks[0].conclusion = null;
  expect((await createFactoryMergeController(pending.options)(pending.candidate)).kind).toBe(
    "waiting",
  );
  const stale = protectedMergeFixture();
  stale.controls.stale = true;
  expect(await createFactoryMergeController(stale.options)(stale.candidate)).toEqual({
    kind: "repair_required",
    reason: "reviewed_base_integration_required",
    evidence: { head: stale.candidate.commit, base: "b".repeat(40) },
  });
  expect(stale.state.puts).toBe(0);
});

test("bundled protected merge refuses missing authenticated checks, bypass rules and absent owner review", async () => {
  const changes: Array<(f: ReturnType<typeof protectedMergeFixture>) => void> = [
    (f) => {
      f.checks.pop();
    },
    (f) => {
      f.checks[0].id = 0;
    },
    (f) => {
      f.checks[0].id = -1;
    },
    (f) => {
      f.checks[0].app.id = 1;
    },
    (f) => {
      f.checks[0].head_sha = "e".repeat(40);
    },
    (f) => {
      f.controls.bypass = true;
    },
    (f) => {
      f.controls.strict = false;
    },
    (f) => {
      f.controls.reviewed = false;
    },
    (f) => {
      f.controls.allowed = false;
    },
    (f) => {
      f.controls.current = false;
    },
  ];
  for (const change of changes) {
    const f = protectedMergeFixture();
    change(f);
    const result = await createFactoryMergeController(f.options)(f.candidate).catch(() => ({
      kind: "refused",
    }));
    expect(result.kind).not.toBe("merged");
    expect(f.state.puts).toBe(0);
    expect(f.state.saved).toBeNull();
  }
});

test("bundled protected merge rejects changed squash trees and does not attribute an external merge", async () => {
  const f = protectedMergeFixture();
  f.controls.treeWrong = true;
  await expect(createFactoryMergeController(f.options)(f.candidate)).rejects.toThrow(
    "expected squash integration",
  );
  expect(f.state.saved?.receipt).toBeNull();
  const external = protectedMergeFixture();
  external.pull.merged = true;
  external.pull.state = "closed";
  expect(await createFactoryMergeController(external.options)(external.candidate)).toEqual({
    kind: "held",
    reason: "merged_without_factory_intent",
  });
  expect(external.state.puts).toBe(0);
});

test("bundled protected merge abort after persisted intent stops PUT and retains reconciliation state", async () => {
  const f = protectedMergeFixture();
  const abort = new AbortController();
  const step = createFactoryMergeController({
    ...f.options,
    signal: abort.signal,
    journal: {
      read: f.options.journal.read,
      write: async (value) => {
        await f.options.journal.write(value);
        abort.abort();
      },
    },
  });
  await expect(step(f.candidate)).rejects.toThrow("merge stopped");
  expect(f.state.puts).toBe(0);
  expect(f.state.saved?.intent?.baseCommit).toBe("b".repeat(40));
  expect(f.state.saved?.receipt).toBeNull();
});

test("bundled protected merge refuses malformed original timestamps before reporting shipment", async () => {
  const f = protectedMergeFixture();
  const receipt = {
    repository: "example/product",
    number: 4,
    head: f.candidate.commit,
    mergeCommit: "c".repeat(40),
    mergedAt: "2026-10-06T12:00:00Z",
    url: "https://github.com/example/product/pull/4",
  };
  for (const timestamp of [undefined, null, 2026, "2026", "2026-02-30T12:00:00Z"]) {
    expect(() => assertFactoryMergeReceipt({ ...receipt, mergedAt: timestamp })).toThrow(
      "Invalid Factory merge receipt",
    );
  }
  for (const timestamp of ["2026", "2026-02-30T12:00:00Z"]) {
    const bad = protectedMergeFixture();
    bad.controls.mergedAt = timestamp;
    await expect(createFactoryMergeController(bad.options)(bad.candidate)).rejects.toThrow(
      "merge is unconfirmed",
    );
    expect(bad.state.puts).toBe(1);
    expect(bad.state.saved?.receipt).toBeNull();
  }
});

test("bundled protected merge verifier refuses caller receipt drift across asynchronous reads", async () => {
  const f = protectedMergeFixture();
  const result = await createFactoryMergeController(f.options)(f.candidate);
  if (result.kind !== "merged") throw new Error("Expected verified merge");
  const expected = structuredClone(result.receipt);
  let changed = false;
  const request: typeof githubRequest = async (...args) => {
    const response = await f.request(...args);
    if (!changed) {
      result.receipt.mergeCommit = "e".repeat(40);
      result.receipt.mergedAt = "2026";
      changed = true;
    }
    return response;
  };
  await expect(
    verifyFactoryMergedReceipt({
      receipt: result.receipt,
      assertCurrent: f.options.authority.assertCurrent,
      request,
    }),
  ).rejects.toThrow("receipt changed during verification");
  expect(f.state.saved?.receipt).toEqual(expected);
});

test("bundled protected merge journal preserves complete claim and rejects changed operation or intent", async () => {
  const f = protectedMergeFixture();
  await createFactoryMergeController(f.options)(f.candidate);
  const value = f.state.saved;
  if (!value) throw new Error("Missing merge intent");
  const state: { current: FactoryMergeClaimState } = {
    current: {
      active: {
        attemptId: "attempt-1",
        workflow: { phase: "release", operation: { kind: "merge", id: f.candidate.operationId } },
      },
    },
  };
  const journal = createClaimMergeJournal({
    attemptId: "attempt-1",
    operationId: f.candidate.operationId,
    claims: {
      current: () => structuredClone(state.current),
      replace(previous, nextActive) {
        expect(previous).toEqual(state.current);
        state.current.active = structuredClone(nextActive);
      },
    },
  });
  expect(await journal.read()).toBeNull();
  await journal.write(value);
  expect(await journal.read()).toEqual(value);
  await expect(journal.write({ ...value, intent: null })).rejects.toThrow(
    "intent cannot be replaced",
  );
  if (!state.current.active?.workflow.operation) throw new Error("Missing claim operation");
  state.current.active.workflow.operation.id = crypto.randomUUID();
  await expect(journal.read()).rejects.toThrow("operation changed");
});

test("bundled protected merge owner loss after receipt persistence fails with retained reconciliation evidence", async () => {
  const f = protectedMergeFixture();
  const step = createFactoryMergeController({
    ...f.options,
    journal: {
      read: f.options.journal.read,
      write: async (value) => {
        await f.options.journal.write(value);
        if (value.receipt) f.controls.current = false;
      },
    },
  });
  await expect(step(f.candidate)).rejects.toThrow("Owner changed");
  expect(f.state.puts).toBe(1);
  expect(f.state.saved?.receipt?.mergeCommit).toBe("c".repeat(40));
});

function nativeWorkflowFixture() {
  const issue = {
    number: 7,
    title: "Bounded issue",
    body: "Acceptance",
    state: "open",
    assignees: [],
  };
  const approvedIssue = structuredClone(issue);
  const policy = {
    trustedCommit: "a".repeat(40),
    configSha256: "b".repeat(64),
    config: {
      repository: "example/product",
      maxRepairAttempts: 2,
      validation: [{ argv: ["node", "check.mjs"], timeoutSeconds: 60 }],
    },
  };
  const active: FactoryWorkflowAttempt = {
    attemptId: "attempt-1",
    occurrenceId: "occurrence-1",
    approval: {
      schemaVersion: 1,
      action: "approve",
      repository: policy.config.repository,
      issueNumber: 7,
      issueContentSha256: issueContentDigest(issue),
      baseCommit: policy.trustedCommit,
      configSha256: policy.configSha256,
      host: "linux-container",
      delivery: "reviewed-draft-only",
      scope: "Bounded fixture",
    },
    workflow: null,
    executions: [],
  };
  const state: FactoryWorkflowClaimState = { active };
  const control = {
    current: true,
    commit: "c".repeat(40),
    failValidation: false,
    failReview: false,
    wrongReview: false,
    interruptStage: false,
    lostPublication: false,
    settled: true,
    wrongCustody: false,
    publishCount: 0,
    publishCalls: 0,
    reconcileCalls: 0,
  };
  const events: string[] = [];
  const publicationIds: string[] = [];
  const published = new Map<string, FactoryWorkflowPublishedDraft>();
  const authority = {
    assertCurrent() {
      if (!control.current) throw new Error("Owner changed");
    },
  };
  function currentAttempt() {
    if (!state.active) throw new Error("No active claim");
    return state.active;
  }
  const options: FactoryWorkflowOptions = {
    authority,
    policy,
    attemptId: active.attemptId,
    claims: {
      current: () => structuredClone(state),
      updateWorkflow(attemptId, previous, next) {
        authority.assertCurrent();
        const attempt = currentAttempt();
        expect(attemptId).toBe(attempt.attemptId);
        expect(previous).toEqual(attempt.workflow);
        attempt.workflow = structuredClone(assertFactoryWorkflow(next));
      },
      reconcile: async () => {
        control.reconcileCalls++;
        if (!control.settled) throw new Error("Custody remains unsettled");
      },
      release: async (attemptId, verify) => {
        authority.assertCurrent();
        expect(attemptId).toBe(active.attemptId);
        if (!control.settled) throw new Error("Custody remains unsettled");
        expect(await verify(structuredClone(currentAttempt()))).toBe(true);
        state.active = null;
      },
    },
    createStage: async ({ kind, operation, command, commit }) => {
      expect(currentAttempt().workflow?.operation?.id).toBe(operation.id);
      const executionId = crypto.randomUUID();
      currentAttempt().executions.push({
        identity: { executionId },
        binding: { stage: kind, occurrenceId: "occurrence-1:" + operation.id },
      });
      return {
        stop: async () => {
          events.push("stop:" + kind);
        },
        run: async () => {
          events.push(kind);
          if (control.interruptStage) {
            control.interruptStage = false;
            throw new Error("Interrupted stage");
          }
          return {
            executionId: control.wrongCustody ? "unknown-execution" : executionId,
            result: {
              validation: {
                command,
                exitCode: control.failValidation ? 1 : 0,
                timedOut: false,
                signal: null,
              },
              finalText: JSON.stringify({
                commit: control.wrongReview ? "e".repeat(40) : commit,
                approved: !control.failReview,
                findings: control.failReview ? ["Unresolved defect"] : [],
              }),
            },
          };
        },
      };
    },
    checkpoint: async (_attempt, operation) => {
      expect(operation.kind).toBe("checkpoint");
      events.push("checkpoint");
      return control.commit;
    },
    assertCheckpoint: async (commit) => {
      expect(commit).toBe(control.commit);
    },
    publish: async ({ operation, review, validations, commit, issue: publishedIssue }) => {
      expect(review.approved).toBe(true);
      expect(review.commit).toBe(commit);
      expect(validations).toHaveLength(1);
      expect(validations[0].commit).toBe(commit);
      expect(publishedIssue).toEqual(approvedIssue);
      control.publishCalls++;
      publicationIds.push(operation.id);
      if (!published.has(operation.id)) {
        control.publishCount++;
        events.push("publication");
        published.set(operation.id, {
          number: 9,
          html_url: "https://github.com/example/product/pull/9",
        });
      }
      if (control.lostPublication) {
        control.lostPublication = false;
        throw new Error("Lost publication response");
      }
      const draft = published.get(operation.id);
      if (!draft) throw new Error("No publication identity");
      return structuredClone(draft);
    },
    verifyDelivery: async (_attempt, workflow) =>
      workflow.draft?.number === 9 &&
      workflow.review?.approved === true &&
      control.publishCount === 1,
  };
  return {
    issue,
    options,
    state,
    control,
    events,
    publicationIds,
    workflow: () => new FactoryWorkflow(options),
  };
}

test("bundled workflow advances only through custody-matched validation and independent review", async () => {
  const f = nativeWorkflowFixture();
  const result = await f.workflow().run(f.issue);
  expect(result.kind).toBe("published");
  expect(f.events).toEqual(["implementation", "checkpoint", "validation", "review", "publication"]);
  expect(f.control.reconcileCalls).toBe(3);
  expect(f.state.active).toBeNull();
  expect(f.control.publishCount).toBe(1);
});

test("bundled workflow retains publication operation through response loss and explicit recovery", async () => {
  const f = nativeWorkflowFixture();
  f.control.lostPublication = true;
  await expect(f.workflow().run(f.issue)).rejects.toThrow("Lost publication response");
  const retained = structuredClone(f.state.active?.workflow);
  const restarted = f.workflow();
  await expect(restarted.run(f.issue)).rejects.toThrow("interrupted operation requires recovery");
  expect(f.state.active?.workflow).toEqual(retained);
  expect(f.control.publishCalls).toBe(1);
  await restarted.recover(async () => "retry");
  expect((await restarted.run(f.issue)).kind).toBe("published");
  expect(f.control.publishCount).toBe(1);
  expect(f.control.publishCalls).toBe(2);
  expect(new Set(f.publicationIds).size).toBe(1);
});

test("bundled workflow persists repair budget and requires fresh validation after failed review", async () => {
  const failed = nativeWorkflowFixture();
  failed.control.failValidation = true;
  expect((await failed.workflow().run(failed.issue)).kind).toBe("blocked");
  expect(failed.state.active?.workflow?.repairAttempts).toBe(2);
  expect(failed.control.publishCount).toBe(0);
  expect((await failed.workflow().run(failed.issue)).kind).toBe("blocked");
  const reviewed = nativeWorkflowFixture();
  reviewed.control.failReview = true;
  const create = reviewed.options.createStage;
  reviewed.options.createStage = async (input) => {
    if (input.kind === "repair") reviewed.control.failReview = false;
    return create(input);
  };
  expect((await reviewed.workflow().run(reviewed.issue)).kind).toBe("published");
  expect(reviewed.events).toEqual([
    "implementation",
    "checkpoint",
    "validation",
    "review",
    "repair",
    "checkpoint",
    "validation",
    "review",
    "publication",
  ]);
});

test("bundled workflow refuses wrong issue, wrong review commit and missing execution custody", async () => {
  const wrongIssue = nativeWorkflowFixture();
  await expect(wrongIssue.workflow().run({ ...wrongIssue.issue, body: "Changed" })).rejects.toThrow(
    "approved scope",
  );
  const wrongReview = nativeWorkflowFixture();
  wrongReview.control.wrongReview = true;
  await expect(wrongReview.workflow().run(wrongReview.issue)).rejects.toThrow("another commit");
  const wrongCustody = nativeWorkflowFixture();
  wrongCustody.control.wrongCustody = true;
  await expect(wrongCustody.workflow().run(wrongCustody.issue)).rejects.toThrow(
    "matching execution custody",
  );
  expect(wrongIssue.control.publishCount).toBe(0);
  expect(wrongReview.control.publishCount).toBe(0);
  expect(wrongCustody.control.publishCount).toBe(0);
});

test("bundled workflow interrupted stage never implies success and requires settled recovery", async () => {
  const f = nativeWorkflowFixture();
  f.control.interruptStage = true;
  await expect(f.workflow().run(f.issue)).rejects.toThrow("Interrupted stage");
  expect(f.state.active?.workflow?.operation?.kind).toBe("implementation");
  const restart = f.workflow();
  f.control.settled = false;
  await expect(restart.recover(async () => "repeat")).rejects.toThrow("unsettled");
  f.control.settled = true;
  await restart.recover(async () => "repeat");
  expect((await restart.run(f.issue)).kind).toBe("published");
  expect(f.control.publishCount).toBe(1);
});

test("bundled workflow does not replace an uncertain external operation with a new identity", async () => {
  const f = nativeWorkflowFixture();
  f.control.lostPublication = true;
  await expect(f.workflow().run(f.issue)).rejects.toThrow("Lost publication response");
  const retained = structuredClone(f.state.active?.workflow);
  await expect(f.workflow().recover(async () => "repeat")).rejects.toThrow(
    "external operation must retain",
  );
  expect(f.state.active?.workflow).toEqual(retained);
  expect(f.control.publishCalls).toBe(1);
});

test("bundled workflow captures policy and issue scope independently of caller aliases", async () => {
  const f = nativeWorkflowFixture();
  f.options.progress = async () => {
    f.issue.body = "Injected unapproved scope";
  };
  const workflow = f.workflow();
  f.options.policy.config.validation.length = 0;
  expect((await workflow.run(f.issue)).kind).toBe("published");
  expect(f.events).toContain("validation");
});

test("bundled workflow checkpoint validator rejects malformed and mismatched merge identities", () => {
  const initial = initialFactoryWorkflow();
  expect(assertFactoryWorkflow(initial)).toEqual(initial);
  expect(() => assertFactoryWorkflow({ ...initial, repairAttempts: 4 })).toThrow(
    "Invalid Factory workflow checkpoint",
  );
  expect(() => assertFactoryWorkflow({ ...initial, phase: "publication" })).toThrow(
    "Invalid Factory workflow checkpoint",
  );
  const receipt = {
    repository: "example/product",
    number: 9,
    head: "c".repeat(40),
    mergeCommit: "d".repeat(40),
    mergedAt: "2026-10-06T12:00:00Z",
    url: "https://github.com/example/product/pull/9",
  };
  const state = {
    ...initial,
    phase: "release",
    commit: "c".repeat(40),
    review: { approved: true, commit: "c".repeat(40) },
    draft: { number: 9, url: receipt.url, mergeReceipt: { ...receipt, head: "e".repeat(40) } },
  };
  expect(() => assertFactoryWorkflow(state)).toThrow("merge identity differs");
});

test("bundled workflow retains verified merge and same Builds handoff after acknowledgment loss", async () => {
  const f = nativeWorkflowFixture();
  let merges = 0;
  const acknowledgments: string[] = [];
  f.options.merge = async ({ state, operation }) => {
    if (!state.commit || !state.draft) throw new Error("Missing publication");
    expect(operation.kind).toBe("merge");
    merges++;
    return {
      repository: "example/product",
      number: state.draft.number,
      head: state.commit,
      mergeCommit: "d".repeat(40),
      mergedAt: "2026-10-06T12:00:00Z",
      url: state.draft.url,
    };
  };
  f.options.onMerged = async ({ receipt }) => {
    acknowledgments.push(receipt.mergeCommit);
    if (acknowledgments.length === 1) throw new Error("Lost Builds acknowledgment");
  };
  await expect(f.workflow().run(f.issue)).rejects.toThrow("Lost Builds acknowledgment");
  expect(f.state.active?.workflow?.draft?.mergeReceipt?.mergeCommit).toBe("d".repeat(40));
  const restarted = f.workflow();
  await restarted.recover(async () => "held");
  expect((await restarted.run(f.issue)).kind).toBe("merged");
  expect(merges).toBe(1);
  expect(acknowledgments).toEqual(["d".repeat(40), "d".repeat(40)]);
  expect(f.state.active).toBeNull();
});

test("bundled workflow stop during recovery cannot be undone by a late decision or caller attempt edits", async () => {
  const f = nativeWorkflowFixture();
  f.control.interruptStage = true;
  await expect(f.workflow().run(f.issue)).rejects.toThrow("Interrupted stage");
  const workflow = f.workflow();
  let decide: (value: "repeat") => void = () => {
    throw new Error("Missing deferred decision");
  };
  let entered: () => void = () => {
    throw new Error("Missing entry signal");
  };
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const decision = new Promise<"repeat">((resolve) => {
    decide = resolve;
  });
  const recovering = workflow.recover(async (_operation, attempt) => {
    attempt.approval.scope = "Caller mutation must not change the captured claim";
    entered();
    return decision;
  });
  const rejected = expect(recovering).rejects.toThrow("recovery was stopped");
  await entry;
  expect(() => workflow.run(f.issue)).toThrow("recovery is running");
  await workflow.stop();
  decide("repeat");
  await rejected;
  expect(f.state.active?.approval.scope).toBe("Bounded fixture");
  await expect(workflow.run(f.issue)).rejects.toThrow("stopped");
  expect(f.control.publishCount).toBe(0);
});

function baseRevisionFixture() {
  const workflow = initialFactoryWorkflow();
  workflow.phase = "checkpoint";
  workflow.operation = { id: randomUUID(), phase: "checkpoint", kind: "checkpoint" };
  const approval: FactoryWorkflowAttempt["approval"] = {
    schemaVersion: 1,
    action: "approve",
    repository: "example/product",
    issueNumber: 7,
    issueContentSha256: "a".repeat(64),
    baseCommit: "b".repeat(40),
    configSha256: "c".repeat(64),
    host: "linux-container",
    delivery: "reviewed-draft-only",
    scope: "One fix",
  };
  const attempt = {
    attemptId: randomUUID(),
    schedulerRunId: randomUUID(),
    statusOperationId: randomUUID(),
    publicationOperationId: randomUUID(),
    approvalCommentId: 10,
    approval,
    workflow,
    executions: [{ identity: { executionId: randomUUID() }, directory: "prior-execution" }],
    helpers: [{ identity: { executionId: randomUUID() }, directory: "prior-helper" }],
  };
  const input = {
    id: randomUUID(),
    receiptSha256: "e".repeat(64),
    approval: { ...approval, baseCommit: "d".repeat(40) },
    approvalCommentId: 11,
  };
  return { attempt, input };
}

test("bundled recovery records preserve prior custody and isolate a pristine base revision", () => {
  const { attempt, input } = baseRevisionFixture();
  const before = structuredClone(attempt);
  const next = createPristineBaseRevision(attempt, input);
  expect(attempt).toEqual(before);
  expect(next.attemptId).toBe(attempt.attemptId);
  expect(next.schedulerRunId).toBe(attempt.schedulerRunId);
  expect(next.statusOperationId).toBe(attempt.statusOperationId);
  expect(next.publicationOperationId).toBe(attempt.publicationOperationId);
  expect(next.executions).toEqual(attempt.executions);
  expect(next.helpers).toEqual(attempt.helpers);
  expect(Object.hasOwn(next, "workflow")).toBe(false);
  expect(next.baseRevision.previous.workflow).toEqual(attempt.workflow);
  expect(next.baseRevision.previous.approval).toEqual(attempt.approval);
  expect(factoryPreparationKey(next)).not.toBe(factoryPreparationKey(attempt));
  expect(factoryPreparationOperationId(next)).toBe(input.id);
  expect(factoryPublicationBranch(next.attemptId, 7, input.id)).not.toBe(
    factoryPublicationBranch(attempt.attemptId, 7),
  );
  expect(hasOnlyPriorRevisionExecutions(next)).toBe(true);
  next.executions.push({ identity: { executionId: randomUUID() }, directory: "new-execution" });
  assertFactoryBaseRevision(next);
  expect(hasOnlyPriorRevisionExecutions(next)).toBe(false);
});

test("bundled recovery records reject candidate scope, reused approval and repeated revision", () => {
  const { attempt, input } = baseRevisionFixture();
  const candidate = structuredClone(attempt);
  candidate.workflow.commit = "f".repeat(40);
  expect(() => createPristineBaseRevision(candidate, input)).toThrow("pristine workflow");
  const repaired = structuredClone(attempt);
  repaired.workflow.repairAttempts = 1;
  expect(() => createPristineBaseRevision(repaired, input)).toThrow("pristine workflow");
  const validating = structuredClone(attempt);
  validating.workflow.phase = "validation";
  expect(() => createPristineBaseRevision(validating, input)).toThrow();
  for (const change of [
    { scope: "Expanded" },
    { configSha256: "f".repeat(64) },
    { issueContentSha256: "f".repeat(64) },
    { baseCommit: attempt.approval.baseCommit },
  ]) {
    expect(() =>
      createPristineBaseRevision(attempt, {
        ...input,
        approval: { ...input.approval, ...change },
      }),
    ).toThrow("scope");
  }
  expect(() => createPristineBaseRevision(attempt, { ...input, approvalCommentId: 10 })).toThrow(
    "revision",
  );
  const next = createPristineBaseRevision(attempt, input);
  expect(() => createPristineBaseRevision(next, input)).toThrow("reconciliation");
});

test("bundled recovery records reject prior custody edits, truncation and injected identity", () => {
  const { attempt, input } = baseRevisionFixture();
  for (const collection of ["executions", "helpers"] as const) {
    const changed = createPristineBaseRevision(attempt, input);
    changed[collection][0].directory = "different";
    expect(() => assertFactoryBaseRevision(changed)).toThrow("custody history");
    changed[collection].length = 0;
    expect(() => assertFactoryBaseRevision(changed)).toThrow("custody history");
  }
  expect(() => createPristineBaseRevision(attempt, { ...input, id: "../../old" })).toThrow(
    "revision",
  );
  expect(() => createPristineBaseRevision(attempt, { ...input, receiptSha256: "unbound" })).toThrow(
    "revision",
  );
});

function retirementFixture() {
  const receipt: FactoryExternalRetirement = {
    reason: "completed_elsewhere",
    attemptId: randomUUID(),
    schedulerRunId: randomUUID(),
    archiveSha256: "a".repeat(64),
    repository: "example/product",
    issueNumber: 4,
    scheduleId: "schedule",
    occurrenceId: "occurrence",
    completion: { pullRequest: 8, mergeCommit: "b".repeat(40), devCommit: "c".repeat(40) },
  };
  const issue = {
    number: 4,
    state: "closed",
    state_reason: "completed",
    updated_at: "2026-10-08T12:00:00Z",
  };
  const pr = {
    number: 8,
    merged: true,
    state: "closed",
    base: { ref: "dev", repo: { full_name: "example/product" } },
    merge_commit_sha: "b".repeat(40),
  };
  const reference = {
    event: "cross-referenced",
    source: {
      issue: { pull_request: { url: "https://api.github.com/repos/example/product/pulls/8" } },
    },
  };
  const control = { owned: true, issueReads: 0 };
  let mutate: (result: unknown, endpoint: string, reads: number) => void = () => {};
  const calls: string[] = [];
  const authority = {
    assertCurrent() {
      if (!control.owned) throw new Error("Lost retained owner");
    },
  };
  const verify = createFactoryExternalCompletionVerifier({
    authority,
    request: async (method, endpoint) => {
      expect(method).toBe("GET");
      calls.push(endpoint);
      let result: unknown;
      if (endpoint.endsWith("/issues/4")) {
        control.issueReads++;
        result = { ...issue };
      } else if (endpoint.endsWith("/pulls/8")) result = structuredClone(pr);
      else if (endpoint.includes("/timeline?")) result = [structuredClone(reference)];
      else if (endpoint.endsWith("/git/ref/heads/dev"))
        result = { object: { type: "commit", sha: "d".repeat(40) } };
      else if (endpoint.includes("/compare/"))
        result = { status: "ahead", merge_base_commit: { sha: "b".repeat(40) } };
      else throw new Error(endpoint);
      mutate(result, endpoint, control.issueReads);
      return result;
    },
  });
  return {
    receipt,
    issue,
    pr,
    reference,
    control,
    calls,
    verify,
    setMutate(fn: typeof mutate) {
      mutate = fn;
    },
  };
}

test("bundled recovery records require a referenced external merge retained by both Dev observations", async () => {
  const f = retirementFixture();
  expect(await f.verify(f.receipt)).toBe(true);
  expect(f.calls.filter((endpoint) => endpoint.includes("/compare/"))).toEqual([
    `repos/example/product/compare/${"b".repeat(40)}...${"c".repeat(40)}`,
    `repos/example/product/compare/${"b".repeat(40)}...${"d".repeat(40)}`,
  ]);
  for (const failure of ["closed", "merged", "repository", "reference", "ancestry"]) {
    const bad = retirementFixture();
    bad.setMutate((value, endpoint) => {
      if (failure === "closed" && endpoint.endsWith("/issues/4"))
        Object.assign(value ?? {}, { state_reason: "not_planned" });
      if (failure === "merged" && endpoint.endsWith("/pulls/8"))
        Object.assign(value ?? {}, { merged: false });
      if (failure === "repository" && endpoint.endsWith("/pulls/8"))
        Object.assign(value ?? {}, { base: { ref: "dev", repo: { full_name: "other/product" } } });
      if (failure === "reference" && Array.isArray(value)) value.length = 0;
      if (failure === "ancestry" && endpoint.includes("/compare/"))
        Object.assign(value ?? {}, { status: "diverged" });
    });
    await expect(bad.verify(bad.receipt)).rejects.toThrow();
  }
});

test("bundled recovery records reject changed or malformed external issue observations", async () => {
  for (const invalid of [undefined, null, 2026, "2026", "2026-02-30T12:00:00Z"]) {
    const f = retirementFixture();
    f.setMutate((value, endpoint) => {
      if (endpoint.endsWith("/issues/4")) Object.assign(value ?? {}, { updated_at: invalid });
    });
    await expect(f.verify(f.receipt)).rejects.toThrow("unconfirmed");
    expect(f.calls).toHaveLength(1);
  }
  for (const field of ["state", "updated_at"]) {
    const f = retirementFixture();
    f.setMutate((value, endpoint, reads) => {
      if (endpoint.endsWith("/issues/4") && reads === 2)
        Object.assign(value ?? {}, { [field]: "changed" });
    });
    await expect(f.verify(f.receipt)).rejects.toThrow("changed during");
  }
});

test("bundled recovery records reject receipt drift and owner loss after external reads", async () => {
  for (const failure of ["receipt", "owner"]) {
    const f = retirementFixture();
    f.setMutate((_value, endpoint) => {
      if (!endpoint.endsWith("/issues/4")) return;
      if (failure === "receipt") f.receipt.completion.pullRequest = 9;
      else f.control.owned = false;
    });
    await expect(f.verify(f.receipt)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  }
});

function parkingFixture() {
  const f = retirementFixture();
  const body = `(AI Generated).\n\n<!-- factory:status:v1:${randomUUID()} -->\n\`\`\`json\n${JSON.stringify({ attemptId: f.receipt.attemptId, issueNumber: 4, stage: "blocked" })}\n\`\`\``;
  const receipt: FactoryParkedRetirement = {
    ...f.receipt,
    reason: "blocked",
    completion: {
      blockerSha256: "c".repeat(64),
      commentId: 2,
      commentSha256: createHash("sha256").update(body).digest("hex"),
      pull: { number: 8, head: "d".repeat(40) },
    },
  };
  const comment = {
    id: 2,
    user: { id: 42 },
    issue_url: "https://api.github.com/repos/example/product/issues/4",
    body,
  };
  const pull = {
    number: 8,
    state: "open",
    merged: false,
    auto_merge: null,
    user: { id: 42 },
    head: { sha: "d".repeat(40), repo: { full_name: "example/product" } },
    base: { ref: "dev", repo: { full_name: "example/product" } },
  };
  let afterRead: () => void = () => {};
  const calls: string[] = [];
  const verify = createFactoryParkingVerifier({
    authority: {
      assertCurrent() {
        if (!f.control.owned) throw new Error("Lost retained owner");
      },
    },
    ownerId: 42,
    request: async (method, endpoint) => {
      expect(method).toBe("GET");
      calls.push(endpoint);
      const result = structuredClone(endpoint.endsWith("/pulls/8") ? pull : comment);
      afterRead();
      return result;
    },
  });
  return {
    f,
    receipt,
    comment,
    pull,
    verify,
    calls,
    setAfterRead(fn: typeof afterRead) {
      afterRead = fn;
    },
  };
}

test("bundled recovery records verify parked holds without presenting them as external completion", async () => {
  const p = parkingFixture();
  expect(await p.verify(p.receipt)).toBe(true);
  await expect(p.f.verify(p.receipt)).rejects.toThrow("not external completion");
  p.pull.merged = true;
  await expect(p.verify(p.receipt)).rejects.toThrow("PR requires reconciliation");
  p.pull.merged = false;
  p.comment.body += "edited";
  await expect(p.verify(p.receipt)).rejects.toThrow("status changed");
  const withoutPull = parkingFixture();
  withoutPull.receipt.completion.pull = null;
  expect(await withoutPull.verify(withoutPull.receipt)).toBe(true);
  expect(withoutPull.calls).toHaveLength(1);
});

test("bundled recovery records reject parked receipt drift and altered owner or PR identity", async () => {
  const drift = parkingFixture();
  drift.setAfterRead(() => {
    drift.receipt.completion.commentId = 3;
  });
  await expect(drift.verify(drift.receipt)).rejects.toThrow("receipt changed");
  expect(drift.calls).toHaveLength(1);
  const owner = parkingFixture();
  owner.comment.user.id = 43;
  await expect(owner.verify(owner.receipt)).rejects.toThrow("status changed");
  const head = parkingFixture();
  head.pull.head.sha = "e".repeat(40);
  await expect(head.verify(head.receipt)).rejects.toThrow("PR requires reconciliation");
});

test("bundled recovery records reject malformed retirement identities before GitHub reads", async () => {
  const f = retirementFixture();
  for (const malformed of [
    { ...f.receipt, unexpected: true },
    { ...f.receipt, attemptId: "../attempt" },
    { ...f.receipt, attemptId: [f.receipt.attemptId] },
    { ...f.receipt, schedulerRunId: [f.receipt.schedulerRunId] },
    { ...f.receipt, archiveSha256: [f.receipt.archiveSha256] },
    { ...f.receipt, repository: [f.receipt.repository] },
    { ...f.receipt, completion: { ...f.receipt.completion, mergeCommit: ["b".repeat(40)] } },
    { ...f.receipt, repository: "https://example/product" },
    { ...f.receipt, completion: { ...f.receipt.completion, pullRequest: 0 } },
  ]) {
    expect(() => assertFactoryRetirement(malformed)).toThrow();
  }
  await expect(f.verify({ ...f.receipt, schedulerRunId: "unbound" })).rejects.toThrow(
    "retirement receipt",
  );
  expect(f.calls).toHaveLength(0);
});

test("bundled recovery records reject coercible base identity and custody digest values", () => {
  for (const field of ["id", "receiptSha256"]) {
    const { attempt, input } = baseRevisionFixture();
    const value = field === "id" ? input.id : input.receiptSha256;
    Object.assign(input, { [field]: [value] });
    expect(() => createPristineBaseRevision(attempt, input)).toThrow("revision");
  }
  for (const field of ["attemptId", "schedulerRunId"]) {
    const { attempt, input } = baseRevisionFixture();
    const value = field === "attemptId" ? attempt.attemptId : attempt.schedulerRunId;
    Object.assign(attempt, { [field]: [value] });
    expect(() => createPristineBaseRevision(attempt, input)).toThrow("retained attempt");
    expect(() => assertFactoryBaseRevision(attempt)).toThrow("retained attempt");
    expect(() => factoryPreparationKey(attempt)).toThrow("retained attempt");
    expect(() => factoryPreparationOperationId(attempt)).toThrow("retained attempt");
  }
  for (const field of ["id", "receiptSha256"]) {
    const { attempt, input } = baseRevisionFixture();
    const next = createPristineBaseRevision(attempt, input);
    const value = field === "id" ? next.baseRevision.id : next.baseRevision.receiptSha256;
    Object.assign(next.baseRevision, { [field]: [value] });
    expect(() => assertFactoryBaseRevision(next)).toThrow("revision");
    expect(() => factoryPreparationOperationId(next)).toThrow("revision");
  }
  for (const field of ["executionsSha256", "helpersSha256"]) {
    const { attempt, input } = baseRevisionFixture();
    const next = createPristineBaseRevision(attempt, input);
    const value =
      field === "executionsSha256"
        ? next.baseRevision.previous.executionsSha256
        : next.baseRevision.previous.helpersSha256;
    Object.assign(next.baseRevision.previous, { [field]: [value] });
    expect(() => assertFactoryBaseRevision(next)).toThrow("custody history");
  }
  const { attempt, input } = baseRevisionFixture();
  expect(() =>
    Reflect.apply(factoryPublicationBranch, undefined, [[attempt.attemptId], 7]),
  ).toThrow("publication identity");
  expect(() =>
    Reflect.apply(factoryPublicationBranch, undefined, [attempt.attemptId, 7, [input.id]]),
  ).toThrow("publication identity");
});

async function nativeClaimFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-native-claims-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "factory-native-workspace-"));
  roots.push(root, workspace);
  await chmod(root, 0o700);
  await chmod(workspace, 0o700);
  await mkdir(path.join(root, "custody"), { mode: 0o700 });
  const control = {
    owned: true,
    beforeSettlement: async (_directory: string, _identity: FactoryCustodyIdentity) => {},
  };
  const authority: FactoryClaimAuthority = {
    root,
    identity: { installationId: randomUUID(), epoch: 1 },
    assertCurrent() {
      if (!control.owned) throw new Error("Native owner revoked");
    },
  };
  const readSettlement = async (directory: string, identity: FactoryCustodyIdentity) => {
    const receipt: unknown = JSON.parse(
      await readFile(path.join(directory, "receipt.json"), "utf8"),
    );
    expect(receipt).toEqual({ identity, settled: true });
    await control.beforeSettlement(directory, identity);
  };
  const journal = new FactoryClaimJournal(authority, readSettlement);
  const binding: FactoryClaimInput = {
    approval: baseRevisionFixture().attempt.approval,
    approvalCommentId: 10,
    scheduleId: "schedule",
    occurrenceId: "occurrence",
  };
  async function execution(attemptId: string): Promise<FactoryWorkerExecution> {
    const directory = await mkdtemp(path.join(root, "custody", "execution-"));
    const identity: FactoryCustodyIdentity = {
      version: 1,
      executionId: randomUUID(),
      authenticationGeneration: "isolated-fixture",
      attemptId,
      ownershipGeneration: authority.identity.epoch,
      nonce: randomUUID(),
    };
    await writeFile(path.join(directory, "intent.json"), JSON.stringify(identity), { mode: 0o600 });
    return {
      directory,
      identity,
      binding: {
        account: { issuer: "isolated-fixture", accountId: "isolated-fixture" },
        reservationId: randomUUID(),
        providerId: "isolated-fixture",
        occurrenceId: binding.occurrenceId,
        stage: "implementation",
        workspace,
      },
    };
  }
  const settle = async (custody: FactoryWorkerExecution) => {
    await writeFile(
      path.join(custody.directory, "receipt.json"),
      JSON.stringify({ identity: custody.identity, settled: true }),
      { mode: 0o600 },
    );
  };
  return {
    root,
    workspace,
    authority,
    control,
    binding,
    journal,
    execution,
    settle,
    readSettlement,
  };
}

function activeNativeClaim(journal: FactoryClaimJournal) {
  const attempt = journal.current().active;
  if (!attempt) throw new Error("Missing native fixture claim");
  return attempt;
}

function nativeReleaseCheckpoint() {
  const workflow = initialFactoryWorkflow();
  workflow.phase = "release";
  workflow.commit = "d".repeat(40);
  workflow.review = {
    approved: true,
    commit: workflow.commit,
    executionId: randomUUID(),
    operationId: randomUUID(),
    findings: [],
  };
  workflow.draft = { number: 5, url: "https://github.com/example/product/pull/5" };
  return workflow;
}

test("bundled native claims require explicit initialization and detach reads before full-record CAS", async () => {
  const f = await nativeClaimFixture();
  expect(() => f.journal.current()).toThrow("ENOENT");
  f.journal.initialize();
  expect(() => f.journal.initialize()).toThrow("already initialized");
  const original = f.journal.current();
  const read = f.journal.current();
  read.revision = 90;
  expect(f.journal.current()).toEqual(original);
  const attempt = await f.journal.claim(f.binding);
  attempt.approval.scope = "Caller alias";
  expect(activeNativeClaim(f.journal).approval.scope).toBe("One fix");
  expect(() => f.journal.replace(original, null)).toThrow("changed during");
  const before = f.journal.current();
  const invalid = activeNativeClaim(f.journal);
  invalid.approval.action = "revoke";
  expect(() => f.journal.replace(before, invalid)).toThrow("Invalid active");
  expect(f.journal.current()).toEqual(before);
});

test("bundled native claims keep an omitted pre-binding run and fence scheduler adoption", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  expect(Object.hasOwn(attempt, "schedulerRunId")).toBe(false);
  expect(factoryPreparationOperationId(attempt)).toBe(attempt.attemptId);
  const execution = await f.execution(attempt.attemptId);
  await expect(
    f.journal.bindPreparationExecution(attempt.attemptId, execution, f.workspace),
  ).rejects.toThrow("bound run before workflow");
  const runId = randomUUID();
  f.journal.bindScheduleRun(attempt.attemptId, runId);
  const revision = f.journal.current().revision;
  expect(f.journal.bindScheduleRun(attempt.attemptId, runId).schedulerRunId).toBe(runId);
  expect(f.journal.current().revision).toBe(revision);
  expect(() => f.journal.bindScheduleRun(randomUUID(), runId)).toThrow("attempt identity");
  expect(() => f.journal.bindScheduleRun(attempt.attemptId, randomUUID())).toThrow(
    "reconciliation",
  );
  await f.journal.bindPreparationExecution(attempt.attemptId, execution, f.workspace);
  const restarted = new FactoryClaimJournal(f.authority, f.readSettlement);
  expect(activeNativeClaim(restarted).helpers?.[0].binding.kind).toBe("preparation");
  await expect(restarted.reconcile()).rejects.toThrow("ENOENT");
  await f.settle(execution);
  expect(await restarted.reconcile()).toBe("resume_required");
});

test("bundled native claims fence simultaneous admission and mutable input across settlement", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const outcomes = await Promise.allSettled([
    f.journal.claim(f.binding),
    f.journal.claim(f.binding),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  const drift = await nativeClaimFixture();
  drift.journal.initialize();
  const historical = await drift.execution("historical-fixture");
  await drift.settle(historical);
  drift.control.beforeSettlement = async () => {
    drift.binding.approval.scope = "Uncaptured edit";
  };
  await expect(drift.journal.claim(drift.binding)).rejects.toThrow("invocation changed");
  expect(drift.journal.current().active).toBeNull();
});

test("bundled native claims preserve old execution identity and hold unsettled overlapping work", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  const first = await f.execution(attempt.attemptId);
  await f.journal.bindExecution(attempt.attemptId, first, first.binding);
  const second = await f.execution(attempt.attemptId);
  await expect(f.journal.bindExecution(attempt.attemptId, second, second.binding)).rejects.toThrow(
    "ENOENT",
  );
  await f.settle(first);
  await f.journal.bindExecution(attempt.attemptId, second, second.binding);
  await f.settle(second);
  f.authority.identity.epoch = 2;
  const restarted = new FactoryClaimJournal(f.authority, f.readSettlement);
  expect(activeNativeClaim(restarted).executions[0].identity.ownershipGeneration).toBe(1);
  expect(await restarted.reconcile()).toBe("resume_required");
  const read = activeNativeClaim(restarted);
  read.executions[0].binding.account.accountId = "Alias edit";
  expect(activeNativeClaim(restarted).executions[0].binding).toEqual(first.binding);
});

test("bundled native claims require exact helper operation and settlement before worker dispatch", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  const workflow = initialFactoryWorkflow();
  workflow.phase = "checkpoint";
  workflow.operation = { id: randomUUID(), kind: "checkpoint", phase: "checkpoint" };
  f.journal.updateWorkflow(attempt.attemptId, null, workflow);
  const helper = await f.execution(attempt.attemptId);
  const binding = {
    operationId: workflow.operation.id,
    kind: "checkpoint",
    workspace: f.workspace,
  };
  await expect(
    f.journal.bindHelperExecution(attempt.attemptId, helper, {
      ...binding,
      kind: "checkpoint",
      operationId: randomUUID(),
    }),
  ).rejects.toThrow("retained workflow operation");
  await f.journal.bindHelperExecution(attempt.attemptId, helper, {
    ...binding,
    kind: "checkpoint",
  });
  const restarted = new FactoryClaimJournal(f.authority, f.readSettlement);
  const worker = await f.execution(attempt.attemptId);
  await expect(restarted.bindExecution(attempt.attemptId, worker, worker.binding)).rejects.toThrow(
    "ENOENT",
  );
  await f.settle(helper);
  await restarted.bindExecution(attempt.attemptId, worker, worker.binding);
  await f.settle(worker);
  expect(await restarted.reconcile()).toBe("resume_required");
});

test("bundled native claims refuse unbound native intent and missing retained custody", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  await f.execution("unbound-fixture");
  await expect(f.journal.claim(f.binding)).rejects.toThrow("ENOENT");
  expect(f.journal.current().active).toBeNull();
  const missing = await nativeClaimFixture();
  missing.journal.initialize();
  const attempt = await missing.journal.claim(missing.binding);
  const execution = await missing.execution(attempt.attemptId);
  await missing.journal.bindExecution(attempt.attemptId, execution, execution.binding);
  await missing.settle(execution);
  await rm(execution.directory, { recursive: true });
  await expect(missing.journal.reconcile()).rejects.toThrow("directory is missing");
});

test("bundled native claims archive released delivery and retain exact scheduler identity across restart", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  const runId = randomUUID();
  f.journal.bindScheduleRun(attempt.attemptId, runId);
  const execution = await f.execution(attempt.attemptId);
  await f.journal.bindExecution(attempt.attemptId, execution, execution.binding);
  await f.settle(execution);
  f.journal.updateWorkflow(attempt.attemptId, null, nativeReleaseCheckpoint());
  const before = f.journal.current();
  await f.journal.release(attempt.attemptId, async () => true);
  const restarted = new FactoryClaimJournal(f.authority, f.readSettlement);
  const released = restarted.current().lastReleased;
  if (!released?.archiveSha256) throw new Error("Missing released fixture archive");
  expect(released.schedulerRunId).toBe(runId);
  expect(released.issueNumber).toBe(7);
  expect(released.delivery?.commit).toBe("d".repeat(40));
  const archive: unknown = JSON.parse(
    await readFile(path.join(f.root, `delivered-${released.archiveSha256}.json`), "utf8"),
  );
  expect(archive).toEqual(before);
  expect(await restarted.reconcile()).toBe("clear");
  await writeFile(
    restarted.path,
    JSON.stringify({
      ...restarted.current(),
      lastReleased: { ...released, occurrenceId: undefined },
    }),
  );
  expect(() => restarted.current()).toThrow("released execution receipt");
});

test("bundled native claims stop before archive persistence when delivery verification loses owner", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  const execution = await f.execution(attempt.attemptId);
  await f.journal.bindExecution(attempt.attemptId, execution, execution.binding);
  await f.settle(execution);
  await expect(
    f.journal.release(attempt.attemptId, async () => {
      f.control.owned = false;
      return true;
    }),
  ).rejects.toThrow("owner revoked");
  expect((await readdir(f.root)).filter((name) => name.startsWith("delivered-"))).toHaveLength(0);
  f.control.owned = true;
  expect(activeNativeClaim(f.journal).attemptId).toBe(attempt.attemptId);
});

test("bundled native claims preserve external retirement archive across interrupted pointer persistence", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  f.journal.bindScheduleRun(attempt.attemptId, randomUUID());
  const execution = await f.execution(attempt.attemptId);
  await f.journal.bindExecution(attempt.attemptId, execution, execution.binding);
  const completion = { pullRequest: 12, mergeCommit: "d".repeat(40), devCommit: "e".repeat(40) };
  const confirmed = async () => true;
  await expect(
    f.journal.retireCompletedElsewhere(attempt.attemptId, completion, confirmed, confirmed),
  ).rejects.toThrow("ENOENT");
  await f.settle(execution);
  await expect(
    f.journal.retireCompletedElsewhere(attempt.attemptId, completion, confirmed, async () => false),
  ).rejects.toThrow("unsettled");
  const before = f.journal.current();
  const replace = f.journal.replace.bind(f.journal);
  f.journal.replace = () => {
    throw new Error("Interrupted pointer persistence");
  };
  await expect(
    f.journal.retireCompletedElsewhere(attempt.attemptId, completion, confirmed, confirmed),
  ).rejects.toThrow("Interrupted pointer");
  expect(f.journal.current()).toEqual(before);
  f.journal.replace = replace;
  const receipt = await f.journal.retireCompletedElsewhere(
    attempt.attemptId,
    completion,
    confirmed,
    confirmed,
  );
  expect(f.journal.current().active).toBeNull();
  expect(f.journal.current().lastReleased).toBeNull();
  const archive: unknown = JSON.parse(
    await readFile(path.join(f.root, `retired-${receipt.archiveSha256}.json`), "utf8"),
  );
  expect(archive).toEqual(before);
  const restarted = new FactoryClaimJournal(f.authority, f.readSettlement);
  expect(
    await restarted.retireCompletedElsewhere(attempt.attemptId, completion, confirmed, confirmed),
  ).toEqual(receipt);
  await expect(
    restarted.retireCompletedElsewhere(
      attempt.attemptId,
      { ...completion, pullRequest: 13 },
      confirmed,
      confirmed,
    ),
  ).rejects.toThrow("reused");
  await rm(path.join(execution.directory, "receipt.json"));
  await expect(restarted.verifyRetirement(receipt, confirmed, confirmed)).rejects.toThrow("ENOENT");
});

test("bundled native claims park blocked work without a shipment and reject receipt drift", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  f.journal.bindScheduleRun(attempt.attemptId, randomUUID());
  const execution = await f.execution(attempt.attemptId);
  await f.journal.bindExecution(attempt.attemptId, execution, execution.binding);
  await f.settle(execution);
  const workflow = initialFactoryWorkflow();
  workflow.phase = "blocked";
  workflow.blocker = "Repair budget exhausted";
  workflow.repairAttempts = 2;
  f.journal.updateWorkflow(attempt.attemptId, null, workflow);
  const audit = {
    blockerSha256: createHash("sha256").update(workflow.blocker).digest("hex"),
    commentId: 42,
    commentSha256: "e".repeat(64),
    pull: null,
  };
  const confirmed = async () => true;
  const receipt = await f.journal.parkBlocked(attempt.attemptId, audit, confirmed, confirmed);
  expect(receipt.reason).toBe("blocked");
  expect(f.journal.current().lastReleased).toBeNull();
  expect(await f.journal.verifyRetirement(receipt, confirmed, confirmed)).toBe(true);
  f.control.beforeSettlement = async () => {
    receipt.completion.commentId = 43;
  };
  await expect(f.journal.verifyRetirement(receipt, confirmed, confirmed)).rejects.toThrow(
    "invocation changed",
  );
});

test("bundled native claims retain prior revision custody before new preparation", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  f.journal.bindScheduleRun(attempt.attemptId, randomUUID());
  const old = await f.execution(attempt.attemptId);
  await f.journal.bindExecution(attempt.attemptId, old, old.binding);
  f.journal.updateWorkflow(attempt.attemptId, null, initialFactoryWorkflow());
  const before = f.journal.current();
  const original = activeNativeClaim(f.journal);
  const revised = createPristineBaseRevision(original, {
    approval: { ...original.approval, baseCommit: "d".repeat(40) },
    approvalCommentId: 11,
    id: randomUUID(),
    receiptSha256: "e".repeat(64),
  });
  f.journal.replace(before, revised);
  const fresh = await f.execution(attempt.attemptId);
  await expect(
    f.journal.bindPreparationExecution(attempt.attemptId, fresh, f.workspace),
  ).rejects.toThrow("ENOENT");
  await f.settle(old);
  await f.journal.bindPreparationExecution(attempt.attemptId, fresh, f.workspace);
  expect(activeNativeClaim(f.journal).helpers?.at(-1)?.binding.operationId).toBe(
    revised.baseRevision.id,
  );
  expect(activeNativeClaim(f.journal).executions).toEqual(original.executions);
});

test("bundled native claims reject unsafe files and malformed UTF-8 instead of silently repairing history", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const original = await readFile(f.journal.path);
  await chmod(f.journal.path, 0o644);
  expect(() => f.journal.current()).toThrow("Unsafe Factory claim record");
  await chmod(f.journal.path, 0o600);
  await writeFile(f.journal.path, Buffer.alloc(1024 * 1024 + 1));
  expect(() => f.journal.current()).toThrow("Unsafe Factory claim record");
  await writeFile(f.journal.path, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
  expect(() => f.journal.current()).toThrow("encoded data");
  await writeFile(f.journal.path, original);
  const saved = path.join(f.root, "saved-claim.json");
  await rename(f.journal.path, saved);
  await symlink(saved, f.journal.path);
  expect(() => f.journal.current()).toThrow("ELOOP");
});

test("bundled native claims reject mutable custody binding during settlement before writing its entry", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  const first = await f.execution(attempt.attemptId);
  await f.journal.bindExecution(attempt.attemptId, first, first.binding);
  await f.settle(first);
  const second = await f.execution(attempt.attemptId);
  f.control.beforeSettlement = async () => {
    second.binding.reservationId = randomUUID();
  };
  await expect(f.journal.bindExecution(attempt.attemptId, second, second.binding)).rejects.toThrow(
    "invocation changed",
  );
  expect(activeNativeClaim(f.journal).executions).toHaveLength(1);
});

test("bundled native claims run the approved workflow through real detached claim and custody files", async () => {
  const f = await nativeClaimFixture();
  const issue = { number: 7, title: "Fixture workflow", body: "One bounded fix" };
  f.binding.approval.issueContentSha256 = issueContentDigest(issue);
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  f.journal.bindScheduleRun(attempt.attemptId, randomUUID());
  const commit = "d".repeat(40);
  const events: string[] = [];
  const options: FactoryWorkflowOptions = {
    authority: f.authority,
    claims: f.journal,
    policy: {
      trustedCommit: f.binding.approval.baseCommit,
      configSha256: f.binding.approval.configSha256,
      config: {
        repository: f.binding.approval.repository,
        validation: [{ argv: ["npm", "run", "typecheck"], timeoutSeconds: 60 }],
      },
    },
    attemptId: attempt.attemptId,
    createStage: async (input) => ({
      stop: async () => {},
      run: async () => {
        events.push(input.kind);
        const custody = await f.execution(attempt.attemptId);
        custody.binding.stage = input.kind;
        custody.binding.occurrenceId = `${attempt.occurrenceId}:${input.operation.id}`;
        await f.journal.bindExecution(attempt.attemptId, custody, custody.binding);
        await f.settle(custody);
        if (input.kind === "validation") {
          return {
            executionId: custody.identity.executionId,
            result: {
              validation: { command: input.command, exitCode: 0, timedOut: false, signal: null },
            },
          };
        }
        if (input.kind === "review") {
          return {
            executionId: custody.identity.executionId,
            result: { finalText: JSON.stringify({ commit, approved: true, findings: [] }) },
          };
        }
        return { executionId: custody.identity.executionId, result: {} };
      },
    }),
    checkpoint: async (_attempt, operation) => {
      events.push("checkpoint");
      const helper = await f.execution(attempt.attemptId);
      await f.journal.bindHelperExecution(attempt.attemptId, helper, {
        operationId: operation.id,
        kind: "checkpoint",
        workspace: f.workspace,
      });
      await f.settle(helper);
      return commit;
    },
    assertCheckpoint: async (value) => {
      expect(value).toBe(commit);
    },
    publish: async ({ operation }) => {
      events.push("publication");
      const helper = await f.execution(attempt.attemptId);
      await f.journal.bindHelperExecution(attempt.attemptId, helper, {
        operationId: operation.id,
        kind: "publication",
        workspace: f.workspace,
      });
      await f.settle(helper);
      return { number: 5, html_url: "https://github.com/example/product/pull/5" };
    },
    verifyDelivery: async (_attempt, state) => {
      expect(state.commit).toBe(commit);
      expect(state.review?.approved).toBe(true);
      expect(state.validations).toHaveLength(1);
      return true;
    },
  };
  expect((await new FactoryWorkflow(options).run(issue)).kind).toBe("published");
  expect(events).toEqual(["implementation", "checkpoint", "validation", "review", "publication"]);
  const restarted = new FactoryClaimJournal(f.authority, f.readSettlement);
  expect(restarted.current().active).toBeNull();
  expect(restarted.current().lastReleased?.delivery?.commit).toBe(commit);
  expect(await restarted.reconcile()).toBe("clear");
  expect((await readdir(path.join(f.root, "custody"))).length).toBe(5);
});

test("bundled native claims reject malformed stored custody and coercible released identities", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  const execution = await f.execution(attempt.attemptId);
  await f.journal.bindExecution(attempt.attemptId, execution, execution.binding);
  const pristine = f.journal.current();
  for (const change of [
    { identity: { ...execution.identity, nonce: [execution.identity.nonce] } },
    { directory: f.workspace },
  ]) {
    const malformed = structuredClone(pristine);
    if (!malformed.active) throw new Error("Missing corrupted fixture claim");
    Object.assign(malformed.active.executions[0], change);
    await writeFile(f.journal.path, JSON.stringify(malformed));
    expect(() => f.journal.current()).toThrow("custody record");
  }
  await writeFile(f.journal.path, JSON.stringify(pristine));
  await f.settle(execution);
  f.journal.updateWorkflow(attempt.attemptId, null, nativeReleaseCheckpoint());
  await f.journal.release(attempt.attemptId, async () => true);
  const released = f.journal.current();
  if (!released.lastReleased?.delivery) throw new Error("Missing released fixture delivery");
  for (const field of ["commit", "repository"]) {
    const malformed = structuredClone(released);
    const delivery = malformed.lastReleased?.delivery;
    if (!delivery) throw new Error("Missing delivery identity");
    const value = field === "commit" ? delivery.commit : delivery.repository;
    Object.assign(delivery, { [field]: [value] });
    await writeFile(f.journal.path, JSON.stringify(malformed));
    expect(() => f.journal.current()).toThrow("released delivery identity");
  }
  const malformed = structuredClone(released);
  Object.assign(malformed.lastReleased ?? {}, { baseRevisionId: [randomUUID()] });
  await writeFile(f.journal.path, JSON.stringify(malformed));
  expect(() => f.journal.current()).toThrow("released execution receipt");
});

test("bundled native claims bind all released metadata to the exact archived claim", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  f.journal.bindScheduleRun(attempt.attemptId, randomUUID());
  f.journal.updateWorkflow(attempt.attemptId, null, initialFactoryWorkflow());
  const original = f.journal.current();
  const current = activeNativeClaim(f.journal);
  const revised = createPristineBaseRevision(current, {
    approval: { ...current.approval, baseCommit: "e".repeat(40) },
    approvalCommentId: 11,
    id: randomUUID(),
    receiptSha256: "f".repeat(64),
  });
  f.journal.replace(original, revised);
  const execution = await f.execution(attempt.attemptId);
  await f.journal.bindExecution(attempt.attemptId, execution, execution.binding);
  await f.settle(execution);
  const workflow = nativeReleaseCheckpoint();
  if (!workflow.draft || !workflow.commit) throw new Error("Missing release fixture");
  workflow.draft.mergeReceipt = {
    repository: "example/product",
    number: workflow.draft.number,
    head: workflow.commit,
    mergeCommit: "a".repeat(40),
    mergedAt: "2026-10-08T12:00:00Z",
    url: workflow.draft.url,
  };
  f.journal.updateWorkflow(attempt.attemptId, null, workflow);
  await f.journal.release(attempt.attemptId, async () => true);
  const pristine = f.journal.current();
  const released = pristine.lastReleased;
  if (!released?.archiveSha256 || !released.delivery) throw new Error("Missing archive fixture");
  const archivePath = path.join(f.root, `delivered-${released.archiveSha256}.json`);
  const archiveBytes = await readFile(archivePath);
  const pointerChanges = [
    { schedulerRunId: randomUUID() },
    { scheduleId: "another-schedule" },
    { occurrenceId: "another-occurrence" },
    { issueNumber: 99 },
    { baseRevisionId: randomUUID() },
    {
      delivery: {
        ...released.delivery,
        commit: "e".repeat(40),
        mergeReceipt: { ...workflow.draft.mergeReceipt, head: "e".repeat(40) },
      },
    },
    {
      delivery: {
        ...released.delivery,
        repository: "other/product",
        draftUrl: "https://github.com/other/product/pull/5",
        mergeReceipt: {
          ...workflow.draft.mergeReceipt,
          repository: "other/product",
          url: "https://github.com/other/product/pull/5",
        },
      },
    },
    {
      delivery: {
        ...released.delivery,
        draftNumber: 6,
        draftUrl: "https://github.com/example/product/pull/6",
        mergeReceipt: {
          ...workflow.draft.mergeReceipt,
          number: 6,
          url: "https://github.com/example/product/pull/6",
        },
      },
    },
    {
      delivery: {
        ...released.delivery,
        mergeReceipt: { ...workflow.draft.mergeReceipt, mergeCommit: "b".repeat(40) },
      },
    },
    { delivery: { ...released.delivery, mergeReceipt: undefined } },
    { delivery: undefined },
    { baseRevisionId: undefined },
    {
      schedulerRunId: undefined,
      scheduleId: undefined,
      occurrenceId: undefined,
      issueNumber: undefined,
    },
  ];
  for (const change of pointerChanges) {
    await writeFile(
      f.journal.path,
      JSON.stringify({ ...pristine, lastReleased: { ...released, ...change } }),
    );
    expect(() => f.journal.current()).toThrow("delivery archive changed");
    expect(await readFile(archivePath)).toEqual(archiveBytes);
  }
  await writeFile(f.journal.path, JSON.stringify(pristine));
  expect(new FactoryClaimJournal(f.authority, f.readSettlement).current()).toEqual(pristine);
});

test("bundled native claims preserve legacy pointers and identical archive-before-pointer retry", async () => {
  const f = await nativeClaimFixture();
  f.journal.initialize();
  const attempt = await f.journal.claim(f.binding);
  const execution = await f.execution(attempt.attemptId);
  await f.journal.bindExecution(attempt.attemptId, execution, execution.binding);
  await f.settle(execution);
  f.journal.updateWorkflow(attempt.attemptId, null, nativeReleaseCheckpoint());
  const before = f.journal.current();
  const replace = f.journal.replace.bind(f.journal);
  f.journal.replace = () => {
    throw new Error("Interrupted delivery pointer persistence");
  };
  await expect(f.journal.release(attempt.attemptId, async () => true)).rejects.toThrow(
    "Interrupted delivery pointer",
  );
  expect(f.journal.current()).toEqual(before);
  const archiveNames = (await readdir(f.root)).filter((name) => name.startsWith("delivered-"));
  expect(archiveNames).toHaveLength(1);
  const archiveBytes = await readFile(path.join(f.root, archiveNames[0]));
  f.journal.replace = replace;
  await f.journal.release(attempt.attemptId, async () => true);
  expect((await readdir(f.root)).filter((name) => name.startsWith("delivered-"))).toEqual(
    archiveNames,
  );
  expect(await readFile(path.join(f.root, archiveNames[0]))).toEqual(archiveBytes);
  const released = f.journal.current().lastReleased;
  if (!released) throw new Error("Missing released fixture");
  expect(released.schedulerRunId).toBeUndefined();
  const legacy = {
    attemptId: released.attemptId,
    publicationOperationId: released.publicationOperationId,
  };
  await writeFile(f.journal.path, JSON.stringify({ ...f.journal.current(), lastReleased: legacy }));
  expect(new FactoryClaimJournal(f.authority, f.readSettlement).current().lastReleased).toEqual(
    legacy,
  );
});

async function nativeSelectionFixture() {
  const n = await nativeClaimFixture();
  n.journal.initialize();
  const q = qualifiedAssignmentFixture();
  const calls: FactoryClaimAttempt[] = [];
  const progress = {
    calls,
    fail: false,
    after: (_attempt: FactoryClaimAttempt) => {},
  };
  const input: FactorySelectionOptions = {
    authority: n.authority,
    claims: n.journal,
    policy: q.policy,
    ownerId: 42,
    excludedIssues: [],
    qualified: q.verifier,
    request: q.options.request,
    delivery: {
      async writeProgress(attempt, value) {
        expect(value.stage).toBe("working");
        expect(n.journal.current().active).toEqual(attempt);
        progress.calls.push(structuredClone(attempt));
        progress.after(attempt);
        if (progress.fail) throw new Error("Lost status response");
      },
    },
  };
  return { n, q, input, progress, create: () => createFactorySelection(input) };
}
const nativeSelectionTime = "2026-10-09T00:35:00Z";

test("bundled native selection admits a freshly qualified issue into a durable native claim", async () => {
  const f = await nativeSelectionFixture();
  const select = f.create();
  const result = await select({ id: "native-schedule" }, nativeSelectionTime);
  if (!result) throw new Error("Missing selected fixture claim");
  expect(result.approval.issueNumber).toBe(1);
  expect(result.qualification).toEqual(f.q.binding);
  expect(result.occurrenceId).toBe(`native-schedule:${nativeSelectionTime}`);
  expect(Object.hasOwn(result, "schedulerRunId")).toBe(false);
  expect(f.progress.calls).toHaveLength(1);
  expect(f.q.reads.filter((endpoint) => endpoint.includes("/comments?")).length).toBeGreaterThan(1);
  result.approval.scope = "unverified caller edit";
  expect(activeNativeClaim(f.n.journal).approval.scope).not.toBe(result.approval.scope);
  expect(new FactoryClaimJournal(f.n.authority, f.n.readSettlement).current()).toEqual(
    f.n.journal.current(),
  );
});

test("bundled native selection preserves empty or withheld queue and refuses excluded or mismatched identity", async () => {
  const empty = await nativeSelectionFixture();
  empty.q.issue.labels = [];
  expect(await empty.create()({ id: "schedule" }, nativeSelectionTime)).toBeNull();
  expect(empty.n.journal.current().active).toBeNull();
  expect(empty.progress.calls).toEqual([]);
  const held = await nativeSelectionFixture();
  held.q.control.allowed = false;
  expect(await held.create()({ id: "schedule" }, nativeSelectionTime)).toBeNull();
  expect(held.n.journal.current().active).toBeNull();
  const excluded = await nativeSelectionFixture();
  excluded.input.excludedIssues.push(1);
  await expect(excluded.create()({ id: "schedule" }, nativeSelectionTime)).rejects.toThrow(
    "excluded issue",
  );
  expect(excluded.n.journal.current().active).toBeNull();
  const mismatch = await nativeSelectionFixture();
  const read = mismatch.q.verifier.readQueue;
  mismatch.q.verifier.readQueue = async () => {
    const queue = await read();
    queue.eligible[0].issueNumber = 99;
    return queue;
  };
  await expect(mismatch.create()({ id: "schedule" }, nativeSelectionTime)).rejects.toThrow(
    "identity differs",
  );
  expect(mismatch.progress.calls).toEqual([]);
});

test("bundled native selection holds retained work and unbound unsettled custody before queue reads", async () => {
  const active = await nativeSelectionFixture();
  await active.n.journal.claim(active.n.binding);
  await expect(active.create()({ id: "schedule" }, nativeSelectionTime)).rejects.toThrow(
    "unfinished claim",
  );
  expect(active.q.reads).toEqual([]);
  const unsettled = await nativeSelectionFixture();
  await unsettled.n.execution(randomUUID());
  await expect(unsettled.create()({ id: "schedule" }, nativeSelectionTime)).rejects.toThrow(
    "ENOENT",
  );
  expect(unsettled.q.reads).toEqual([]);
  expect(unsettled.progress.calls).toEqual([]);
});

test("bundled native selection rejects changed occurrence and configuration after queue reads", async () => {
  for (const change of ["occurrence", "policy", "exclusions"]) {
    const f = await nativeSelectionFixture();
    const schedule = { id: "schedule" };
    const read = f.q.verifier.readQueue;
    f.q.verifier.readQueue = async () => {
      const queue = await read();
      if (change === "occurrence") schedule.id = "unverified-schedule";
      else if (change === "policy") f.input.policy.config.repository = "unverified/repository";
      else f.input.excludedIssues.push(1);
      return queue;
    };
    await expect(f.create()(schedule, nativeSelectionTime)).rejects.toThrow("changed");
    expect(f.n.journal.current().active).toBeNull();
    expect(f.progress.calls).toEqual([]);
  }
});

test("bundled native selection rejects callback replacement and owner loss during admission", async () => {
  for (const failure of ["callback", "owner"]) {
    const f = await nativeSelectionFixture();
    const admit = f.q.verifier.admit;
    f.q.verifier.admit = async (binding) => {
      const result = await admit(binding);
      if (failure === "callback") f.input.delivery.writeProgress = async () => {};
      else f.n.control.owned = false;
      return result;
    };
    await expect(f.create()({ id: "schedule" }, nativeSelectionTime)).rejects.toThrow();
    f.n.control.owned = true;
    expect(f.n.journal.current().active).toBeNull();
    expect(f.progress.calls).toEqual([]);
  }
});

test("bundled native selection repeats fresh issue verification before retaining the claim", async () => {
  const f = await nativeSelectionFixture();
  const read = f.q.verifier.readQueue;
  f.q.verifier.readQueue = async () => {
    const queue = await read();
    f.q.issue.body = "changed after discovery";
    return queue;
  };
  await expect(f.create()({ id: "schedule" }, nativeSelectionTime)).rejects.toThrow();
  expect(f.n.journal.current().active).toBeNull();
  expect(f.progress.calls).toEqual([]);
});

test("bundled native selection retains a possibly published claim on status response loss without replay", async () => {
  const f = await nativeSelectionFixture();
  f.progress.fail = true;
  const select = f.create();
  await expect(select({ id: "schedule" }, nativeSelectionTime)).rejects.toThrow(
    "Lost status response",
  );
  const retained = f.n.journal.current();
  expect(retained.active?.approval.issueNumber).toBe(1);
  const readCount = f.q.reads.length;
  await expect(select({ id: "schedule" }, "2026-10-09T00:36:00Z")).rejects.toThrow(
    "unfinished claim",
  );
  expect(f.progress.calls).toHaveLength(1);
  expect(f.q.reads).toHaveLength(readCount);
  expect(new FactoryClaimJournal(f.n.authority, f.n.readSettlement).current()).toEqual(retained);
});

test("bundled native selection serializes concurrent occurrences without duplicate ownership", async () => {
  const f = await nativeSelectionFixture();
  const select = f.create();
  const results = await Promise.allSettled([
    select({ id: "schedule" }, nativeSelectionTime),
    select({ id: "schedule" }, "2026-10-09T00:36:00Z"),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(f.progress.calls).toHaveLength(1);
  expect(activeNativeClaim(f.n.journal).occurrenceId).toBe(`schedule:${nativeSelectionTime}`);
});

test("bundled native selection isolates publisher aliases and rejects postclaim native identity drift", async () => {
  const detached = await nativeSelectionFixture();
  detached.progress.after = (attempt) => {
    attempt.approval.scope = "publisher alias edit";
  };
  const result = await detached.create()({ id: "schedule" }, nativeSelectionTime);
  expect(result?.approval.scope).not.toBe("publisher alias edit");
  const changed = await nativeSelectionFixture();
  changed.progress.after = (attempt) => {
    changed.n.journal.bindScheduleRun(attempt.attemptId, randomUUID());
  };
  await expect(changed.create()({ id: "schedule" }, nativeSelectionTime)).rejects.toThrow(
    "claim changed",
  );
  expect(activeNativeClaim(changed.n.journal).schedulerRunId).toBeDefined();
  expect(changed.progress.calls).toHaveLength(1);
});

test("bundled native selection preserves genuine legacy owner-comment admission", async () => {
  const f = await nativeSelectionFixture();
  const legacy = legacyApprovalFixture();
  f.input.qualified = undefined;
  f.input.policy = legacy.policy;
  f.input.request = async (method, endpoint) => {
    expect(method).toBe("GET");
    if (endpoint.includes("/comments?")) return structuredClone(legacyComment(legacy));
    if (endpoint.includes("/dependencies/") || endpoint.includes("/timeline?")) return [];
    if (endpoint.includes("/issues?")) return structuredClone(legacy.issues);
    return structuredClone(legacy.issues[0]);
  };
  const result = await f.create()({ id: "schedule" }, nativeSelectionTime);
  expect(result?.approvalCommentId).toBe(1);
  expect(result?.qualification).toBeUndefined();
  expect(result?.approval.issueContentSha256).toBe(issueContentDigest(legacy.issues[0]));
  expect(f.progress.calls).toHaveLength(1);
});

test("bundled native selection rejects malformed scheduler timestamps and capped queue before claiming", async () => {
  const f = await nativeSelectionFixture();
  const select = f.create();
  for (const timestamp of ["2026", "2026-02-30T12:00:00Z", "2026-10-09T00:35:00+00:00"]) {
    await expect(select({ id: "schedule" }, timestamp)).rejects.toThrow("occurrence");
  }
  await expect(
    Reflect.apply(select, undefined, [{ id: ["schedule"] }, nativeSelectionTime]),
  ).rejects.toThrow("occurrence");
  expect(f.q.reads).toEqual([]);
  const capped = await nativeSelectionFixture();
  const read = capped.q.verifier.readQueue;
  capped.q.verifier.readQueue = async () => {
    const queue = await read();
    queue.eligible = Array.from({ length: 1001 }, () => queue.eligible[0]);
    return queue;
  };
  await expect(capped.create()({ id: "schedule" }, nativeSelectionTime)).rejects.toThrow(
    "coverage is invalid",
  );
  expect(capped.n.journal.current().active).toBeNull();
  expect(capped.progress.calls).toEqual([]);
});

function governedDeliveryFixture() {
  const commit = "c".repeat(40);
  const issue = {
    number: 12,
    title: "Fix bounded behavior",
    body: "Acceptance criteria",
    state: "open",
  };
  const policy: FactoryDeliveryOptions["policy"] = {
    trustedCommit: "a".repeat(40),
    configSha256: "b".repeat(64),
    config: {
      repository: "fixture/project",
      baseBranch: "dev",
      validation: [{ argv: ["npm", "test"], timeoutSeconds: 60 }],
    },
  };
  const attempt: FactoryClaimAttempt = {
    attemptId: randomUUID(),
    controllerEpoch: 1,
    scheduleId: "fixture",
    occurrenceId: "fixture:occurrence",
    statusOperationId: randomUUID(),
    publicationOperationId: randomUUID(),
    approvalCommentId: 1,
    approval: {
      schemaVersion: 1,
      action: "approve",
      repository: policy.config.repository,
      issueNumber: issue.number,
      issueContentSha256: issueContentDigest(issue),
      baseCommit: policy.trustedCommit,
      configSha256: policy.configSha256,
      host: "linux-container",
      delivery: "reviewed-draft-only",
      scope: "One bounded correction",
    },
    executions: [],
  };
  for (const stage of ["implementation", "validation", "review"] as const) {
    attempt.executions.push({
      directory: `fixture-${stage}`,
      identity: {
        version: 1,
        executionId: randomUUID(),
        authenticationGeneration: "fixture",
        attemptId: attempt.attemptId,
        ownershipGeneration: 1,
        nonce: randomUUID(),
      },
      binding: {
        stage,
        providerId: "fixture",
        account: { issuer: "fixture", accountId: "fixture" },
        reservationId: randomUUID(),
        workspace: "fixture",
        occurrenceId: attempt.occurrenceId,
      },
    });
  }
  const reviewer = attempt.executions[2];
  const validator = attempt.executions[1];
  const input: FactoryDraftPublication = {
    attempt,
    commit,
    title: issue.title,
    summary: "Correct the approved behavior.",
    review: {
      executionId: reviewer.identity.executionId,
      operationId: randomUUID(),
      commit,
      approved: true,
      findings: [],
    },
    validations: [
      {
        executionId: validator.identity.executionId,
        operationId: randomUUID(),
        commit,
        command: policy.config.validation[0],
        exitCode: 0,
      },
    ],
  };
  const comments: FactoryQueueComment[] = [
    {
      id: 1,
      user: { id: 42 },
      created_at: "2026-10-08T12:00:00Z",
      body: approvalComment(attempt.approval),
    },
  ];
  const pulls: FactoryDeliveryPull[] = [];
  const publications: FactoryDeliveryNativePublication[] = [];
  const writes: string[] = [];
  const control = {
    owned: true,
    loseResponse: false,
    active: structuredClone(attempt),
    remote: commit,
    beforePublish: async (_input: FactoryDeliveryNativePublication) => {},
    afterRead: async (_endpoint: string) => {},
  };
  const options: FactoryDeliveryOptions = {
    authority: {
      assertCurrent() {
        if (!control.owned) throw new Error("Native owner lost");
      },
    },
    claims: {
      current() {
        return {
          schemaVersion: 1,
          installationId: "fixture",
          revision: 1,
          active: structuredClone(control.active),
          lastReleased: null,
        };
      },
      reconcile: async () => "resume_required",
      bindHelperExecution: async (id, custody, binding) => {
        expect(id).toBe(control.active.attemptId);
        control.active.helpers = [
          ...(control.active.helpers ?? []),
          { ...structuredClone(custody), binding: structuredClone(binding) },
        ];
      },
    },
    policy,
    ownerId: 42,
    request: async (method, endpoint, body) => {
      if (method === "GET") {
        await control.afterRead(endpoint);
        if (endpoint === "user") return { id: 42 };
        if (endpoint.includes("/git/ref/"))
          return { object: { type: "commit", sha: control.remote } };
        if (endpoint.includes("/comments?")) return structuredClone(comments);
        if (endpoint.includes("/pulls?")) return structuredClone(pulls);
        if (endpoint.includes("/pulls/")) return structuredClone(pulls[0]);
        return structuredClone(issue);
      }
      if (method !== "POST" && method !== "PATCH") throw new Error("Unexpected write");
      if (endpoint.includes("/pulls")) throw new Error("Direct pull creation forbidden");
      if (
        typeof body !== "object" ||
        body === null ||
        !("body" in body) ||
        typeof body.body !== "string"
      )
        throw new Error("Invalid comment body");
      writes.push(endpoint);
      const existing =
        method === "PATCH"
          ? comments.find((comment) => endpoint.endsWith(`/${comment.id}`))
          : undefined;
      const id = existing ? existing.id : comments.length + 1;
      if (!id) throw new Error("Missing fixture comment identity");
      const result = {
        id,
        user: { id: 42 },
        body: body.body,
        html_url: `https://github.com/fixture/project/issues/12#issuecomment-${id}`,
      };
      if (existing) Object.assign(existing, result);
      else comments.push(result);
      if (control.loseResponse) throw new Error("Response lost");
      return result;
    },
    publish: async (publication) => {
      publication.assertCurrent();
      await control.beforePublish(publication);
      publications.push(publication);
      const pull: FactoryDeliveryPull = {
        number: 25,
        html_url: "https://github.com/fixture/project/pull/25",
        user: { id: 42 },
        state: "open",
        draft: publication.draft,
        auto_merge: null,
        title: publication.title,
        body: publication.body,
        head: {
          sha: publication.commit,
          ref: publication.branch,
          repo: { full_name: publication.repository },
        },
        base: { ref: publication.base },
      };
      if (pulls.length) Object.assign(pulls[0], pull);
      else pulls.push(pull);
      if (control.loseResponse) throw new Error("Response lost");
      return undefined;
    },
  };
  return {
    options,
    input,
    policy,
    comments,
    pulls,
    publications,
    writes,
    control,
    create: () => createFactoryGitHubDelivery(options),
  };
}

test("bundled governed delivery reconciles response loss without a second native publication", async () => {
  const f = governedDeliveryFixture();
  const delivery = f.create();
  f.control.loseResponse = true;
  await expect(delivery.publishDraft(f.input)).rejects.toThrow("Response lost");
  f.control.loseResponse = false;
  const result = await delivery.publishDraft(f.input);
  expect(result.number).toBe(25);
  expect(result.body.startsWith("(AI Generated).\n\n")).toBe(true);
  expect(f.publications).toHaveLength(1);
  expect(f.writes).toEqual([]);
  const concurrent = await Promise.all([
    delivery.publishDraft(f.input),
    delivery.publishDraft(f.input),
  ]);
  expect(concurrent.map((pull) => pull.number)).toEqual([25, 25]);
  expect(f.publications).toHaveLength(1);
});

test("bundled governed delivery captures serialized invocation data before caller mutation", async () => {
  const f = governedDeliveryFixture();
  const promise = f.create().publishDraft(f.input);
  f.input.title = "Unreviewed caller replacement";
  f.input.review.commit = "d".repeat(40);
  const result = await promise;
  expect(result.title).toBe("Fix bounded behavior");
  expect(result.body).not.toContain("Unreviewed caller replacement");
  expect(f.publications).toHaveLength(1);
});

test("bundled governed delivery rejects incomplete validation and self review before publication", async () => {
  for (const failure of ["self", "validation", "commit", "coercion"]) {
    const f = governedDeliveryFixture();
    if (failure === "self")
      f.input.review.executionId = f.input.attempt.executions[0].identity.executionId;
    if (failure === "validation") f.input.validations = [];
    if (failure === "commit") f.input.review.commit = "d".repeat(40);
    if (failure === "coercion") Object.assign(f.input, { commit: [f.input.commit] });
    await expect(f.create().publishDraft(f.input)).rejects.toThrow();
    expect(f.publications).toEqual([]);
  }
});

test("bundled governed delivery refuses missing native publisher without direct PR fallback", async () => {
  const f = governedDeliveryFixture();
  f.options.publish = undefined;
  await expect(f.create().publishDraft(f.input)).rejects.toThrow("not installed");
  expect(f.publications).toEqual([]);
  expect(f.writes).toEqual([]);
});

test("bundled governed delivery rejects policy or native method drift and lost owner", async () => {
  for (const failure of ["policy", "method", "owner"]) {
    const f = governedDeliveryFixture();
    f.control.afterRead = async () => {
      if (failure === "policy") f.policy.config.baseBranch = "unreviewed";
      if (failure === "method")
        f.options.claims.current = () => {
          throw new Error("Unverified replacement called");
        };
      if (failure === "owner") f.control.owned = false;
    };
    await expect(f.create().publishDraft(f.input)).rejects.toThrow();
    expect(f.publications).toEqual([]);
  }
});

test("bundled governed delivery retains exact helper custody and rejects unrelated claim mutation", async () => {
  for (const failure of [false, true]) {
    const f = governedDeliveryFixture();
    f.control.beforePublish = async (publication) => {
      await publication.retainHelper(
        {
          directory: "fixture-helper",
          identity: {
            version: 1,
            executionId: randomUUID(),
            authenticationGeneration: "fixture",
            attemptId: f.input.attempt.attemptId,
            ownershipGeneration: 1,
            nonce: randomUUID(),
          },
        },
        "fixture",
      );
      if (failure) f.control.active.approval.scope = "Unreviewed mutation";
    };
    const workflow = initialFactoryWorkflow();
    workflow.phase = "publication";
    workflow.operation = { id: randomUUID(), phase: "publication", kind: "publication" };
    f.control.active.workflow = workflow;
    f.input.attempt = structuredClone(f.control.active);
    if (failure) await expect(f.create().publishDraft(f.input)).rejects.toThrow("attempt changed");
    else expect((await f.create().publishDraft(f.input)).number).toBe(25);
    expect(f.control.active.helpers).toHaveLength(1);
  }
});

test("bundled governed delivery updates one status comment after response loss and refuses foreign markers", async () => {
  const f = governedDeliveryFixture();
  const delivery = f.create();
  f.control.loseResponse = true;
  await expect(delivery.writeProgress(f.input.attempt, { stage: "working" })).rejects.toThrow(
    "Response lost",
  );
  f.control.loseResponse = false;
  expect(
    (await delivery.writeProgress(f.input.attempt, { stage: "reviewing", commit: f.input.commit }))
      .id,
  ).toBe(2);
  expect(f.comments).toHaveLength(2);
  f.comments[1].user = { id: 99 };
  await expect(delivery.writeProgress(f.input.attempt, { stage: "blocked" })).rejects.toThrow(
    "reconciliation",
  );
  expect(f.writes).toHaveLength(2);
});

test("bundled governed delivery requires canonical publication identity and held automatic merge", async () => {
  for (const failure of ["url", "number", "auto", "body", "title"]) {
    const f = governedDeliveryFixture();
    const delivery = f.create();
    const saved = await delivery.publishDraft(f.input);
    const workflow = initialFactoryWorkflow();
    workflow.commit = f.input.commit;
    workflow.draft = {
      number: saved.number,
      url: saved.html_url,
      commit: f.input.commit,
      publicationSha256: createHash("sha256")
        .update(JSON.stringify({ title: saved.title, body: saved.body }))
        .digest("hex"),
    };
    f.control.active.workflow = workflow;
    if (failure === "url") f.pulls[0].html_url = "https://untrusted.example/pull/25";
    if (failure === "number") Object.assign(f.pulls[0], { number: "25" });
    if (failure === "auto") f.pulls[0].auto_merge = {};
    if (failure === "body") f.pulls[0].body += "unreviewed";
    if (failure === "title") Object.assign(f.pulls[0], { title: 25 });
    await expect(
      delivery.verifyPublication(structuredClone(f.control.active), {
        number: 25,
        commit: f.input.commit,
      }),
    ).rejects.toThrow();
    expect(f.publications).toHaveLength(1);
  }
});

test("bundled governed delivery binds checkpoint custody and verifies actual remote head", async () => {
  for (const mismatch of [false, true]) {
    const f = governedDeliveryFixture();
    const workflow = initialFactoryWorkflow();
    workflow.phase = "checkpoint";
    workflow.operation = { id: randomUUID(), phase: "checkpoint", kind: "checkpoint" };
    f.control.active.workflow = workflow;
    f.input.attempt = structuredClone(f.control.active);
    let dispatched = 0;
    f.options.checkpointPublisher = async (checkpoint) => {
      checkpoint.assertCurrent();
      expect(checkpoint.operationId).toBe(workflow.operation?.id);
      await checkpoint.retainHelper(
        {
          directory: "fixture-checkpoint",
          identity: {
            version: 1,
            executionId: randomUUID(),
            authenticationGeneration: "fixture",
            attemptId: f.input.attempt.attemptId,
            ownershipGeneration: 1,
            nonce: randomUUID(),
          },
        },
        "fixture",
      );
      dispatched++;
      f.control.remote = mismatch ? "d".repeat(40) : f.input.commit;
    };
    const result = f.create().pushCheckpoint({ attempt: f.input.attempt, commit: f.input.commit });
    if (mismatch) await expect(result).rejects.toThrow("differs");
    else expect(await result).toBe(f.input.commit);
    expect(dispatched).toBe(1);
    expect(f.control.active.helpers).toHaveLength(1);
  }
});

test("bundled governed delivery READY recovery retains merge helper without another promotion", async () => {
  const f = governedDeliveryFixture();
  const delivery = f.create();
  const saved = await delivery.publishDraft(f.input);
  const workflow = initialFactoryWorkflow();
  workflow.phase = "publication";
  workflow.commit = f.input.commit;
  workflow.draft = {
    number: saved.number,
    url: saved.html_url,
    commit: f.input.commit,
    publicationSha256: createHash("sha256")
      .update(JSON.stringify({ title: saved.title, body: saved.body }))
      .digest("hex"),
  };
  workflow.operation = { id: randomUUID(), phase: "publication", kind: "merge" };
  f.control.active.workflow = workflow;
  f.control.beforePublish = async (publication) => {
    expect(publication.draft).toBe(false);
    await publication.verifyRemote();
    await publication.retainHelper(
      {
        directory: "fixture-merge",
        identity: {
          version: 1,
          executionId: randomUUID(),
          authenticationGeneration: "fixture",
          attemptId: f.input.attempt.attemptId,
          ownershipGeneration: 1,
          nonce: randomUUID(),
        },
      },
      "fixture",
    );
  };
  f.control.loseResponse = true;
  await expect(
    delivery.promoteReviewed({
      attempt: structuredClone(f.control.active),
      candidate: { number: 25, commit: f.input.commit },
    }),
  ).rejects.toThrow("Response lost");
  f.control.loseResponse = false;
  const recovered = await delivery.promoteReviewed({
    attempt: structuredClone(f.control.active),
    candidate: { number: 25, commit: f.input.commit },
  });
  expect(recovered.draft).toBe(false);
  expect(f.publications).toHaveLength(2);
  expect(f.control.active.helpers).toHaveLength(1);
});

test("bundled governed delivery verifies exact released draft rather than trusting a release pointer", async () => {
  const f = governedDeliveryFixture();
  const saved = await f.create().publishDraft(f.input);
  const receipt = {
    attemptId: f.input.attempt.attemptId,
    publicationOperationId: f.input.attempt.publicationOperationId,
    schedulerRunId: randomUUID(),
    scheduleId: f.input.attempt.scheduleId,
    occurrenceId: f.input.attempt.occurrenceId,
    issueNumber: f.input.attempt.approval.issueNumber,
    delivery: {
      repository: f.policy.config.repository,
      commit: f.input.commit,
      draftNumber: saved.number,
      draftUrl: saved.html_url,
    },
  };
  const verifier = {
    authority: f.options.authority,
    claims: {
      current: () => ({
        schemaVersion: 1 as const,
        installationId: "fixture",
        revision: 2,
        active: null,
        lastReleased: structuredClone(receipt),
      }),
    },
    receipt,
    ownerId: f.options.ownerId,
    baseBranch: f.policy.config.baseBranch,
    request: f.options.request,
  };
  expect(await verifyFactoryReleasedDelivery(verifier)).toBe(saved.html_url);
  Object.assign(receipt.delivery, { commit: [receipt.delivery.commit] });
  await expect(verifyFactoryReleasedDelivery(verifier)).rejects.toThrow("exact delivery");
  expect(f.publications).toHaveLength(1);
});

test("bundled governed delivery rejects deferred candidate replacement instead of verifying an unshown commit", async () => {
  const f = governedDeliveryFixture();
  const delivery = f.create();
  const saved = await delivery.publishDraft(f.input);
  const workflow = initialFactoryWorkflow();
  workflow.commit = f.input.commit;
  workflow.draft = {
    number: saved.number,
    url: saved.html_url,
    commit: f.input.commit,
    publicationSha256: createHash("sha256")
      .update(JSON.stringify({ title: saved.title, body: saved.body }))
      .digest("hex"),
  };
  f.control.active.workflow = workflow;
  let resume = () => {};
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.control.afterRead = async (endpoint) => {
    if (endpoint.includes("/pulls?")) {
      started();
      await waiting;
    }
  };
  const invocationCommit = "d".repeat(40);
  const candidate = { number: saved.number, commit: invocationCommit };
  const pending = delivery.verifyPublication(structuredClone(f.control.active), candidate);
  const rejected = expect(pending).rejects.toThrow("read input changed");
  await reading;
  candidate.commit = f.input.commit;
  resume();
  await rejected;
  expect(workflow.commit).toBe(f.input.commit);
  expect(f.publications).toHaveLength(1);
  expect(f.writes).toHaveLength(0);
});

test("bundled governed delivery rejects caller attempt drift across public lookup and checkpoint reads", async () => {
  for (const method of ["findOwnedPull", "findDraft", "verifyRemoteCheckpoint"] as const) {
    const f = governedDeliveryFixture();
    const delivery = f.create();
    await delivery.publishDraft(f.input);
    const attempt = structuredClone(f.control.active);
    let resume = () => {};
    let started = () => {};
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.control.afterRead = async () => {
      started();
      await waiting;
    };
    const pending =
      method === "findOwnedPull"
        ? delivery.findOwnedPull(attempt)
        : delivery[method](attempt, f.input.commit);
    const rejected = expect(pending).rejects.toThrow("read input changed");
    await reading;
    attempt.publicationOperationId = randomUUID();
    resume();
    await rejected;
    expect(f.control.active.publicationOperationId).toBe(f.input.attempt.publicationOperationId);
    expect(f.publications).toHaveLength(1);
    expect(f.writes).toHaveLength(0);
  }
});

test("bundled governed delivery captures released receipts and participating native methods across reads", async () => {
  for (const drift of ["receipt", "authority", "claims"] as const) {
    const f = governedDeliveryFixture();
    const saved = await f.create().publishDraft(f.input);
    const receipt = {
      attemptId: f.input.attempt.attemptId,
      publicationOperationId: f.input.attempt.publicationOperationId,
      schedulerRunId: randomUUID(),
      scheduleId: f.input.attempt.scheduleId,
      occurrenceId: f.input.attempt.occurrenceId,
      issueNumber: f.input.attempt.approval.issueNumber,
      delivery: {
        repository: f.policy.config.repository,
        commit: f.input.commit,
        draftNumber: saved.number,
        draftUrl: saved.html_url,
      },
    };
    const retained = structuredClone(receipt);
    const claims = {
      current: () => ({
        schemaVersion: 1 as const,
        installationId: "fixture",
        revision: 2,
        active: null,
        lastReleased: structuredClone(retained),
      }),
    };
    f.control.afterRead = async () => {
      if (drift === "receipt") receipt.delivery.commit = "d".repeat(40);
      if (drift === "authority") f.options.authority.assertCurrent = () => {};
      if (drift === "claims")
        claims.current = () => {
          throw new Error("Replacement must not run");
        };
    };
    await expect(
      verifyFactoryReleasedDelivery({
        authority: f.options.authority,
        claims,
        receipt,
        ownerId: f.options.ownerId,
        baseBranch: f.policy.config.baseBranch,
        request: f.options.request,
      }),
    ).rejects.toThrow("verification input changed");
    expect(retained.delivery.commit).toBe(f.input.commit);
    expect(f.publications).toHaveLength(1);
    expect(f.writes).toHaveLength(0);
  }
});

const governedStageChildren: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  await Promise.all(
    governedStageChildren.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }),
  );
});

function governedStageFixture() {
  const events: string[] = [];
  const account = { issuer: "fixture", accountId: "fixture" };
  const observation: QuotaObservation = { status: "unavailable", reason: "read_failed" };
  let execution: GovernorExecution = {
    generation: 0,
    state: "reserved",
    executionId: null,
    authenticationGeneration: null,
    pauseReason: null,
    settlementId: null,
  };
  let child: ChildProcessWithoutNullStreams | undefined;
  const control = {
    settled: false,
    owned: true,
    mode: "normal",
    finalizeHeld: false,
    reads: 0,
    beforeObservation: async () => {},
    beforeTransition: async (_type: string) => {},
    beforeRecord: async () => {},
    beforeRun: async () => {},
  };
  const settlement = async () => {
    if (!control.settled) throw new Error("Native settlement unconfirmed");
  };
  const settleChild = async (value: ChildProcessWithoutNullStreams) => {
    expect(value).toBe(child);
    if (value.exitCode === null && value.signalCode === null) {
      const exited = new Promise<void>((resolve) => value.once("close", () => resolve()));
      value.kill("SIGTERM");
      await exited;
    }
    control.settled = true;
    events.push("settled");
  };
  const options: FactoryGovernedStageOptions = {
    authority: {
      identity: { epoch: 1 },
      assertCurrent() {
        if (!control.owned) throw new Error("Owner lost");
      },
    },
    account,
    reservationId: randomUUID(),
    providerId: "fixture",
    occurrenceId: "fixture",
    attemptId: randomUUID(),
    stage: "implementation",
    authenticationGeneration: "fixture",
    assertAuthentication() {},
    async readObservation() {
      control.reads++;
      await control.beforeObservation();
      return observation;
    },
    async recordCustody() {
      events.push("retained");
      await control.beforeRecord();
    },
    sessionConfig: { provider: "codex", cwd: "fixture" },
    custodyOptions: {
      journalRoot: "fixture",
      executable: "fixture",
      pythonExecutable: "fixture",
      cwd: "fixture",
      env: {},
    },
    ConstructionCleanupError: QuotaConstructionCleanupError,
    store: {
      async execution() {
        return structuredClone(execution);
      },
      async transition(input) {
        await control.beforeTransition(input.event.type);
        execution = advanceGovernorExecution(execution, input.expectedGeneration, input.event);
        events.push(input.event.type);
        if (control.mode === "persisted-start-error" && input.event.type === "start")
          throw new Error("Persisted start response lost");
        return { kind: "transitioned", execution: structuredClone(execution) };
      },
      async finalize() {
        events.push("finalize");
        if (control.finalizeHeld) return { kind: "deferred", reason: "observation_regressed" };
        return { kind: "finalized" };
      },
    },
    NativeCustody: {
      async create(input) {
        events.push("custody");
        return {
          directory: "fixture-custody",
          identity: { ...input.identity, version: 1, nonce: randomUUID() },
          async spawn() {
            events.push("spawn");
            child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
              stdio: ["pipe", "pipe", "pipe"],
            });
            governedStageChildren.push(child);
            if (control.mode === "cleanup")
              throw new QuotaConstructionCleanupError(async () => {
                events.push("retryCleanup");
                if (!child) throw new Error("Missing retained fixture child");
                await settleChild(child);
              });
            return child;
          },
          settle: settleChild,
        };
      },
      readSettlement: settlement,
      async readOutcome() {
        await settlement();
        return { exitCode: 0, signal: null };
      },
    },
    client: {
      assertCurrent() {},
      async openSession(input) {
        if (!input.processCustody) throw new Error("Missing custody");
        await input.processCustody.spawn("fixture", []);
        return {
          async readQuotaObservation() {
            return observation;
          },
          async run() {
            events.push("run");
            await control.beforeRun();
            return { sessionId: "fixture", finalText: "Complete", timeline: [] };
          },
          async close() {
            events.push("close");
          },
        };
      },
    },
    QuotaSupervisor: {
      prototype: {
        async complete() {
          return structuredClone(execution);
        },
      },
      async attach(input) {
        events.push("supervisor");
        let freezing: Promise<GovernorExecution> | undefined;
        const freeze = (reason: "manual" | "quota") => {
          freezing ??= (async () => {
            await options.store.transition({
              account,
              reservationId: options.reservationId,
              expectedGeneration: execution.generation,
              event: { type: "freeze", reason },
            });
            const receipt = await input.freezeAndSettle(input.executionId);
            await options.store.transition({
              account,
              reservationId: options.reservationId,
              expectedGeneration: execution.generation,
              event: {
                type: "settled",
                executionId: input.executionId,
                settlementId: receipt.settlementId,
              },
            });
            return structuredClone(execution);
          })();
          return freezing;
        };
        return {
          async guard() {
            input.assertAuthority();
            return { assertValidForDispatch: input.assertAuthority };
          },
          startMonitoring() {
            events.push("monitoring");
          },
          freeze,
          async reconcileFreeze() {
            freezing = undefined;
            return freeze("manual");
          },
          async complete() {
            input.assertAuthority();
            const receipt = await input.freezeAndSettle(input.executionId);
            await options.store.transition({
              account,
              reservationId: options.reservationId,
              expectedGeneration: execution.generation,
              event: {
                type: "complete",
                executionId: input.executionId,
                settlementId: receipt.settlementId,
              },
            });
            return structuredClone(execution);
          },
        };
      },
    },
  };
  return {
    options,
    control,
    events,
    execution: () => structuredClone(execution),
    seedExecution: (value: GovernorExecution) => {
      execution = structuredClone(value);
    },
    create: () => createFactoryGovernedStage(options),
  };
}

test("bundled governed stage retains custody before launch and completes native settlement before finalization", async () => {
  const f = governedStageFixture();
  const stage = f.create();
  const result = await stage.run("Bounded implementation");
  expect(result.executionId).toBe(stage.executionId);
  expect(result.result.finalText).toBe("Complete");
  expect(f.events).toEqual([
    "start",
    "custody",
    "retained",
    "spawn",
    "supervisor",
    "monitoring",
    "started",
    "run",
    "settled",
    "complete",
    "finalize",
    "close",
  ]);
  expect(f.execution().state).toBe("completed");
  await stage.stop();
  await expect(stage.run("Again")).rejects.toThrow("twice");
});

test("bundled governed stage captures invocation data and refuses native method drift before launch", async () => {
  for (const drift of ["data", "method", "owner"] as const) {
    const f = governedStageFixture();
    f.control.beforeObservation = async () => {
      if (drift === "data") f.options.sessionConfig.cwd = "changed";
      if (drift === "method")
        f.options.client.openSession = async () => {
          throw new Error("Replacement must not run");
        };
      if (drift === "owner") f.control.owned = false;
    };
    await expect(f.create().run("Bounded")).rejects.toThrow();
    expect(f.events).toEqual([]);
    expect(f.execution().state).toBe("reserved");
  }
});

test("bundled governed stage uses native construction cleanup and does not invent settlement", async () => {
  const f = governedStageFixture();
  f.control.mode = "cleanup";
  await expect(f.create().run("Bounded")).rejects.toThrow("cleanup is unresolved");
  expect(f.events).toContain("retryCleanup");
  expect(f.control.settled).toBe(true);
  expect(f.execution().state).toBe("frozen");
  expect(f.events).not.toContain("run");
  expect(f.events).not.toContain("finalize");
});

test("bundled governed stage holds unknown construction or persisted start outcomes for recovery", async () => {
  for (const mode of ["no-custody", "persisted-start-error"] as const) {
    const f = governedStageFixture();
    f.control.mode = mode;
    if (mode === "no-custody")
      f.options.NativeCustody.create = async () => {
        throw new Error("Construction unknown");
      };
    await expect(f.create().run("Bounded")).rejects.toThrow("retained for recovery");
    expect(f.execution().state).toBe("freezing");
    expect(f.control.settled).toBe(false);
    expect(f.events).not.toContain("spawn");
    expect(f.events).not.toContain("finalize");
  }
});

test("bundled governed stage does not report success when native finalization is held", async () => {
  const f = governedStageFixture();
  f.control.finalizeHeld = true;
  await expect(f.create().run("Bounded")).rejects.toThrow("finalization held");
  expect(f.execution().state).toBe("completed");
  expect(f.control.settled).toBe(true);
  expect(f.events).toContain("close");
});

test("bundled governed stage observes committed start before a concurrent stop finishes", async () => {
  const f = governedStageFixture();
  let resume = () => {};
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.control.beforeTransition = async (type) => {
    if (type === "start") {
      started();
      await waiting;
    }
  };
  const stage = f.create();
  const run = stage.run("Bounded");
  const rejected = expect(run).rejects.toThrow();
  await reading;
  const stopping = stage.stop();
  const held = expect(stopping).rejects.toThrow("custody reconciliation");
  resume();
  await Promise.all([rejected, held]);
  expect(f.execution().state).toBe("freezing");
  expect(f.events).toEqual(["start", "freeze"]);
});

test("bundled governed stage preserves captured cleanup when owner is lost after native session returns", async () => {
  const f = governedStageFixture();
  const open = f.options.client.openSession;
  f.options.client.openSession = async (input) => {
    const session = await open(input);
    f.control.owned = false;
    return session;
  };
  await expect(f.create().run("Bounded")).rejects.toThrow("Owner lost");
  expect(f.control.settled).toBe(true);
  expect(f.execution().state).toBe("frozen");
  expect(f.events).toContain("close");
  expect(f.events).not.toContain("run");
});

test("bundled governed stage retains supervisor cleanup when owner is lost during attachment", async () => {
  const f = governedStageFixture();
  const attach = f.options.QuotaSupervisor.attach;
  f.options.QuotaSupervisor.attach = async (input) => {
    const supervisor = await attach(input);
    f.control.owned = false;
    return supervisor;
  };
  await expect(f.create().run("Bounded")).rejects.toThrow("Owner lost");
  expect(f.control.settled).toBe(true);
  expect(f.execution().state).toBe("frozen");
  expect(f.events).toContain("close");
  expect(f.events).not.toContain("monitoring");
});

test("bundled governed stage stops admitted execution before reporting canceled provider result", async () => {
  const f = governedStageFixture();
  const open = f.options.client.openSession;
  f.options.client.openSession = async (input) => {
    const session = await open(input);
    return {
      ...session,
      async run() {
        return { sessionId: "fixture", finalText: "Canceled", timeline: [], canceled: true };
      },
    };
  };
  await expect(f.create().run("Bounded")).rejects.toThrow("cancelled");
  expect(f.execution().state).toBe("frozen");
  expect(f.control.settled).toBe(true);
  expect(f.events).not.toContain("finalize");
});

test("bundled governed stage requires explicit reconciled resume and a fresh execution identity", async () => {
  for (const allowed of [false, true]) {
    const f = governedStageFixture();
    const previousExecution = randomUUID();
    f.seedExecution({
      generation: 4,
      state: "frozen",
      executionId: previousExecution,
      authenticationGeneration: "fixture",
      pauseReason: "manual",
      settlementId: randomUUID(),
    });
    f.options.resume = allowed;
    f.options.manualResume = allowed;
    const stage = f.create();
    if (!allowed) {
      await expect(stage.run("Bounded")).rejects.toThrow("reconciled resume");
      expect(f.events).toEqual([]);
      expect(f.execution().executionId).toBe(previousExecution);
    } else {
      const completed = await stage.run("Bounded");
      expect(completed.executionId).not.toBe(previousExecution);
      expect(f.events[0]).toBe("resume");
      expect(f.execution().state).toBe("completed");
    }
  }
});

test("Factory stage quota capture retains native policy and detached account limits", () => {
  const policy = controllerProjectionFixture().source.policy;
  const captured = captureFactoryQuotaPolicy(policy);
  expect(captured).toEqual(policy);
  policy.account.accountId = "caller-changed";
  policy.estimatedHourly = { bucketId: "weekly", windowId: "primary", maxConsumedPoints: 99 };
  expect(captured.account.accountId).toBe("test-account");
  expect(captured.estimatedHourly?.maxConsumedPoints).toBe(15);
});

test("Factory stage quota capture refuses missing hourly bound and fractional freshness", () => {
  const policy = controllerProjectionFixture().source.policy;
  const { estimatedHourly, ...withoutEstimate } = policy;
  expect(estimatedHourly?.maxConsumedPoints).toBe(15);
  expect(() => captureFactoryQuotaPolicy(withoutEstimate)).toThrow("bounded account consumption");
  expect(() => captureFactoryQuotaPolicy({ ...policy, maxObservationAgeSeconds: 1.5 })).toThrow(
    "fresh telemetry",
  );
});

test("Factory stage quota capture delegates window and hysteresis validity to native parser", () => {
  const policy = controllerProjectionFixture().source.policy;
  expect(() => captureFactoryQuotaPolicy({ ...policy, freezeFloorPercent: 10 })).toThrow(
    "Freeze floor",
  );
  expect(() =>
    captureFactoryQuotaPolicy({
      ...policy,
      requiredWindows: [{ bucketId: "weekly", windowId: "primary", durationMinutes: 60 }],
    }),
  ).toThrow("weekly allowance window");
  expect(() =>
    captureFactoryQuotaPolicy({ ...policy, account: { issuer: "codex", accountId: [] } }),
  ).toThrow();
});

test("Factory stage quota capture preserves native exhaustion and consumption rules", () => {
  const policy = controllerProjectionFixture().source.policy;
  expect(
    captureFactoryQuotaPolicy({ ...policy, launchFloorPercent: 0, freezeFloorPercent: 0 }),
  ).toMatchObject({
    launchFloorPercent: 0,
    freezeFloorPercent: 0,
  });
  const consumptionLimits: QuotaConsumptionLimit[] = [
    {
      meterId: "fixture-meter",
      revision: "fixture-revision",
      bucketId: "weekly",
      unit: "weekly_quota_points",
      period: { kind: "trailing_hour" },
      throttleAt: 3,
      holdAt: 2,
      freezeAt: 4,
    },
  ];
  expect(() => captureFactoryQuotaPolicy({ ...policy, consumptionLimits })).toThrow(
    "throttle <= hold <= freeze",
  );
});

function executionObservationFixture() {
  const projection = controllerProjectionFixture();
  const { estimatedHourlyUsage, ...raw } = projection.observation;
  expect(estimatedHourlyUsage?.authenticationGeneration).toBe("auth-test");
  const observe = vi.fn(
    async (
      input: Parameters<FactoryExecutionObservationOptions["store"]["observeEstimatedUsage"]>[0],
    ): Promise<QuotaObservation> => {
      if (input.observation.status !== "available")
        throw new Error("Unavailable sample passed to native store");
      return {
        ...input.observation,
        estimatedHourlyUsage: {
          bucketId: input.bucketId,
          windowId: input.windowId,
          authenticationGeneration: input.authenticationGeneration,
          observedAt: input.observation.observedAt,
          coverageStart: input.observation.observedAt,
          consumedPoints: null,
        },
      };
    },
  );
  const options: FactoryExecutionObservationOptions = {
    authority: { assertCurrent: vi.fn() },
    client: { assertCurrent: vi.fn() },
    authentication: { authenticationGeneration: "auth-test", assertCurrent: vi.fn() },
    store: { observeEstimatedUsage: observe },
    quotaPolicy: projection.source.policy,
    readRawObservation: vi.fn(async () => raw),
  };
  return { options, observe, raw, fixture: projection };
}

test("Factory execution observation coalesces a sample and retains native measurement identity", async () => {
  const f = executionObservationFixture();
  const read = createFactoryObservationReader(f.options);
  const first = read();
  const second = read();
  expect(second).toBe(first);
  const retained = await first;
  expect(f.options.readRawObservation).toHaveBeenCalledTimes(1);
  expect(f.observe).toHaveBeenCalledTimes(1);
  expect(retained).toMatchObject({
    account: f.raw.account,
    observedAt: f.raw.observedAt,
    estimatedHourlyUsage: {
      authenticationGeneration: "auth-test",
      observedAt: f.raw.observedAt,
      consumedPoints: null,
    },
  });
  f.raw.account.accountId = "caller-mutated";
  expect(retained).toMatchObject({ account: { accountId: "test-account" } });
});

test("Factory execution observation skips unavailable telemetry and refuses another account before writes", async () => {
  const f = executionObservationFixture();
  f.options.readRawObservation = vi.fn(async () => ({
    status: "unavailable",
    reason: "read_failed",
  }));
  await expect(createFactoryObservationReader(f.options)()).resolves.toEqual({
    status: "unavailable",
    reason: "read_failed",
  });
  expect(f.observe).not.toHaveBeenCalled();
  f.options.readRawObservation = vi.fn(async () => ({
    ...f.raw,
    account: { issuer: "codex", accountId: "another-account" },
  }));
  await expect(createFactoryObservationReader(f.options)()).rejects.toThrow(
    "telemetry account changed",
  );
  expect(f.observe).not.toHaveBeenCalled();
});

test("Factory execution observation refuses authentication drift while raw telemetry is pending", async () => {
  const f = executionObservationFixture();
  let release: (observation: QuotaObservation) => void = () => {
    throw new Error("No pending sample");
  };
  const gate = new Promise<QuotaObservation>((resolve) => {
    release = resolve;
  });
  f.options.readRawObservation = vi.fn(() => gate);
  const pending = createFactoryObservationReader(f.options)();
  await Promise.resolve();
  expect(f.options.readRawObservation).toHaveBeenCalledTimes(1);
  f.options.authentication.authenticationGeneration = "changed-auth";
  release(f.raw);
  await expect(pending).rejects.toThrow("binding changed");
  expect(f.observe).not.toHaveBeenCalled();
});

test("Factory execution observation keeps possibly persisted method drift held without replay", async () => {
  const f = executionObservationFixture();
  f.observe.mockImplementationOnce(async (input) => {
    f.options.readRawObservation = vi.fn(async () => f.raw);
    return input.observation;
  });
  const read = createFactoryObservationReader(f.options);
  const pending = read();
  await expect(pending).rejects.toBeInstanceOf(FactoryExecutionObservationUncertainError);
  await expect(pending).rejects.toMatchObject({
    writeAttempted: true,
    cause: { message: "Factory execution observation binding changed" },
  });
  await expect(read()).rejects.toBeInstanceOf(FactoryExecutionObservationUncertainError);
  expect(f.observe).toHaveBeenCalledTimes(1);
});

test("Factory execution observation preserves native write rejection and rejects mismatched returned estimate", async () => {
  const f = executionObservationFixture();
  const cause = new Error("Native estimate save failed after persistence");
  f.observe.mockRejectedValueOnce(cause);
  const read = createFactoryObservationReader(f.options);
  await expect(read()).rejects.toMatchObject({ writeAttempted: true, cause });
  await expect(read()).rejects.toMatchObject({ writeAttempted: true, cause });
  expect(f.observe).toHaveBeenCalledTimes(1);
  const other = executionObservationFixture();
  other.observe.mockResolvedValueOnce({
    ...other.fixture.observation,
    estimatedHourlyUsage: {
      ...other.fixture.observation.estimatedHourlyUsage!,
      authenticationGeneration: "other-auth",
    },
  });
  await expect(createFactoryObservationReader(other.options)()).rejects.toMatchObject({
    writeAttempted: true,
    cause: { message: "Factory native estimate binding changed" },
  });
});

test("Factory execution observation uses the actual native store without inventing hourly usage", async () => {
  const f = executionObservationFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-observation-store-"));
  try {
    const store = new QuotaGovernorStore(directory, { nowMs: () => f.fixture.now });
    f.options.store = store;
    const read = createFactoryObservationReader(f.options);
    const retained = await read();
    expect(retained).toMatchObject({
      account: f.raw.account,
      observedAt: f.raw.observedAt,
      estimatedHourlyUsage: {
        bucketId: "weekly",
        windowId: "primary",
        authenticationGeneration: "auth-test",
        observedAt: f.raw.observedAt,
        coverageStart: f.raw.observedAt,
        consumedPoints: null,
      },
    });
    const saved = JSON.parse(
      await readFile(store.accountPath(f.raw.account) + ".estimate", "utf8"),
    );
    expect(saved.account).toEqual(f.raw.account);
    expect(saved.authenticationGeneration).toBe("auth-test");
    expect(f.options.readRawObservation).toHaveBeenCalledTimes(1);
    expect((await readdir(directory)).filter((name) => name.endsWith(".lock"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Factory execution observation assigns its pending read before a reentrant sample callback", async () => {
  const f = executionObservationFixture();
  let read: () => Promise<QuotaObservation> = () => {
    throw new Error("Reader not constructed");
  };
  let reentered: Promise<QuotaObservation> | null = null;
  f.options.readRawObservation = vi.fn(async () => {
    reentered = read();
    return f.raw;
  });
  read = createFactoryObservationReader(f.options);
  const pending = read();
  await pending;
  expect(reentered).toBe(pending);
  expect(f.options.readRawObservation).toHaveBeenCalledTimes(1);
  expect(f.observe).toHaveBeenCalledTimes(1);
});

function factoryRecoveryFixture() {
  const account = { issuer: "test", accountId: "recovery-test" };
  const records = { current: () => ({ active: null }), reconcile: vi.fn(async () => "clear") };
  const recover = vi.fn(
    async (input: Parameters<QuotaGovernorStore["recoverAbandonedAccountLock"]>[0]) => {
      await input.reconcileCustody({ account, ledger: null });
      input.assertExclusiveWriter();
      return "absent" as const;
    },
  );
  const options: FactoryAccountRecoveryOptions = {
    authority: { assertCurrent() {} },
    claims: records,
    store: { recoverAbandonedAccountLock: recover },
    account,
  };
  return { options, records, recover };
}

test("Factory native recovery checks custody before reporting an absent account lock", async () => {
  const f = factoryRecoveryFixture();
  await expect(recoverFactoryAccount(f.options)).resolves.toBe("absent");
  expect(f.records.reconcile).toHaveBeenCalledTimes(1);
  expect(f.recover).toHaveBeenCalledTimes(1);
});

test("Factory native recovery refuses changed account input before native dispatch", async () => {
  const f = factoryRecoveryFixture();
  f.options.authority.assertCurrent = () => {
    f.options.account.accountId = "other";
  };
  await expect(recoverFactoryAccount(f.options)).rejects.toThrow("invocation changed");
  expect(f.recover).toHaveBeenCalledTimes(0);
});

test("Factory native recovery preserves uncertainty after a possibly committed lock recovery", async () => {
  const f = factoryRecoveryFixture();
  const cause = new Error("Directory fsync failed after removal");
  f.recover.mockRejectedValueOnce(cause);
  await expect(recoverFactoryAccount(f.options)).rejects.toMatchObject({
    writeAttempted: true,
    cause,
    operation: "recoverAbandonedAccountLock",
  });
  expect(f.recover).toHaveBeenCalledTimes(1);
});

test("Factory native recovery rejects owner-method drift while custody reconciliation waits", async () => {
  const f = factoryRecoveryFixture();
  let release: () => void = () => {
    throw new Error("Not waiting");
  };
  f.records.reconcile = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = () => resolve("clear");
      }),
  );
  const pending = recoverFactoryAccount(f.options);
  f.options.authority.assertCurrent = () => {};
  release();
  await expect(pending).rejects.toMatchObject({
    writeAttempted: true,
    cause: { message: "Factory recovery invocation changed" },
  });
});

test("Factory native recovery uses the actual native lock protocol without creating accounting history", async () => {
  const f = factoryRecoveryFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-recovery-store-"));
  try {
    const store = new QuotaGovernorStore(directory);
    f.options.store = store;
    const lock = store.accountPath(f.options.account) + ".lock";
    await mkdir(lock, { mode: 0o700 });
    await expect(recoverFactoryAccount(f.options)).resolves.toBe("recovered");
    expect(await readdir(directory)).toEqual([]);
    await expect(recoverFactoryAccount(f.options)).resolves.toBe("absent");
    expect(f.records.reconcile).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Factory native recovery reports clear claims without reading or mutating reservations", async () => {
  const f = factoryRecoveryFixture();
  const store = { reservationState: vi.fn(), transition: vi.fn(), finalize: vi.fn() };
  await expect(
    reconcileFactoryExecutionOwner({
      authority: f.options.authority,
      records: f.records,
      store,
      readObservation: async () => ({ status: "unavailable", reason: "read_failed" }),
      authenticationGeneration: async () => "test-auth",
    }),
  ).resolves.toEqual({ kind: "clear" });
  expect(store.reservationState).toHaveBeenCalledTimes(0);
  expect(store.transition).toHaveBeenCalledTimes(0);
  expect(store.finalize).toHaveBeenCalledTimes(0);
});

function factoryExecutionRecoveryFixture() {
  const entry: FactoryWorkerExecution = {
    directory: "/isolated/custody",
    identity: {
      version: 1,
      executionId: randomUUID(),
      authenticationGeneration: "recovery-auth",
      attemptId: randomUUID(),
      ownershipGeneration: 1,
      nonce: randomUUID(),
    },
    binding: {
      account: { issuer: "test", accountId: "test" },
      reservationId: randomUUID(),
      providerId: "test",
      stage: "implementation",
      workspace: "/isolated/workspace",
      occurrenceId: "occurrence",
    },
  };
  const active = { scheduleId: "schedule", occurrenceId: "occurrence", executions: [entry] };
  let execution: GovernorExecution = {
    generation: 2,
    state: "running",
    executionId: entry.identity.executionId,
    authenticationGeneration: entry.identity.authenticationGeneration,
    pauseReason: null,
    settlementId: null,
  };
  const transition = vi.fn(async (input: Parameters<QuotaGovernorStore["transition"]>[0]) => {
    expect(input.expectedGeneration).toBe(execution.generation);
    execution = advanceGovernorExecution(execution, input.expectedGeneration, input.event);
    return { kind: "transitioned" as const, execution };
  });
  const finalize = vi.fn<QuotaGovernorStore["finalize"]>();
  const options: FactoryExecutionRecoveryOptions = {
    authority: { assertCurrent() {} },
    records: { reconcile: async () => "resume_required", current: () => ({ active }) },
    store: {
      reservationState: async () => ({
        kind: "active",
        execution,
        providerId: "test",
        policy: controllerProjectionFixture().source.policy,
        observation: { status: "unavailable", reason: "read_failed" },
        scheduleId: "schedule",
        occurrenceId: "occurrence",
      }),
      transition,
      finalize,
    },
    readObservation: async () => ({ status: "unavailable", reason: "read_failed" }),
    authenticationGeneration: async () => "recovery-auth",
  };
  return { options, active, entry, transition, finalize };
}

test("Factory native recovery freezes and settles interrupted execution without resuming or releasing it", async () => {
  const f = factoryExecutionRecoveryFixture();
  const recovered = await reconcileFactoryExecutionOwner(f.options);
  expect(recovered).toEqual({
    kind: "resume_required",
    attempt: f.active,
    executions: [{ ...f.entry, kind: "resumable" }],
  });
  expect(f.transition.mock.calls.map(([input]) => input.event.type)).toEqual(["freeze", "settled"]);
  expect(f.finalize).toHaveBeenCalledTimes(0);
  expect(f.active.executions).toEqual([f.entry]);
});

test("Factory native recovery refuses a caller-changed execution after an awaited reservation read", async () => {
  const f = factoryExecutionRecoveryFixture();
  const read = f.options.store.reservationState;
  f.options.store.reservationState = async (account, reservationId) => {
    const saved = await read(account, reservationId);
    f.entry.identity.executionId = randomUUID();
    return saved;
  };
  await expect(reconcileFactoryExecutionOwner(f.options)).rejects.toThrow("claim changed");
  expect(f.transition).toHaveBeenCalledTimes(0);
});

test("Factory native recovery retains typed uncertainty after transition persistence fails", async () => {
  const f = factoryExecutionRecoveryFixture();
  const cause = new Error("Transition persisted before directory fsync failed");
  f.transition.mockRejectedValueOnce(cause);
  await expect(reconcileFactoryExecutionOwner(f.options)).rejects.toMatchObject({
    writeAttempted: true,
    operation: "transition",
    cause,
  });
  expect(f.transition).toHaveBeenCalledTimes(1);
  expect(f.finalize).toHaveBeenCalledTimes(0);
});
