import { supervisionReviewClient } from "./coordinator-bootstrap-supervision-control.js";
import {
  BootstrapRunnerSetupSchema,
  verifyBootstrapSupervisionRunner,
  assertSupervisionHelpers,
} from "./coordinator-bootstrap-runner.js";
import * as bootstrapArtifact from "./coordinator-bootstrap-artifact.js";
import nativeChildProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import * as bootstrapHost from "./coordinator-bootstrap-host.js";
import {
  DaemonAutomation,
  coordinatorAutomaticAuthority,
  signCoordinatorSubmission,
  verifyCoordinatorSubmission,
} from "./daemon-automation.js";
import {
  submitInstallationCoordinator,
  reconcileInstallationCoordinator,
  inspectInstallationCoordinator,
} from "./daemon.js";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { hashSync } from "bcryptjs";
import {
  CoordinatorBootstrapRequestSchema,
  CoordinatorBootstrapReconcileAutomaticRequestSchema,
  CoordinatorBootstrapListResponseSchema,
  CoordinatorBootstrapPlanSchema,
  type CoordinatorBootstrapPlan,
  type CoordinatorBootstrapRequest,
  type CoordinatorBootstrapStage,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { handleBootstrapReview } from "./coordinator-bootstrap-session.js";
import {
  CoordinatorBootstrapRequests,
  coordinatorPlanDigest,
  coordinatorAutomaticStatus,
  openBootstrapRequests,
  assertFrozenCoordinatorIdle,
} from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { InstallationRestarts } from "./restarts.js";
import {
  loadedCoordinatorPid,
  isStoppedBootstrapCandidate,
  verifyBootstrapReplacement,
  verifyBootstrapServiceIdentity,
  verifyLoadedBootstrapService,
  verifyUnregisteredBootstrapCoordinator,
  verifyBootstrapLaunchers,
  createNativeBootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";

import {
  executeCoordinatorBootstrap,
  type BootstrapExecutorOperations,
} from "./coordinator-bootstrap-executor.js";

import {
  loadCoordinatorStartupFence,
  coordinatorStartupAdmission,
  coordinatorStartupReleased,
} from "./coordinator-bootstrap-startup.js";

import { recoverAbandonedBootstrap } from "./coordinator-bootstrap-watchdog.js";

import { preserveBootstrapState, verifyBootstrapState } from "./coordinator-bootstrap-state.js";
import { createBootstrapNativeLifecycle } from "./coordinator-bootstrap-native.js";
import {
  createBootstrapNativeOperations,
  createBootstrapSupervisionControl,
} from "./coordinator-bootstrap-runtime.js";

import {
  BOOT_RECOVERY_READINESS_TIMEOUT_MS,
  bootstrapRecoveryLauncher,
  registerBootstrapRecovery,
  removeCompletedBootstrapRecovery,
  verifyBootstrapRecoveryLauncher,
} from "./coordinator-bootstrap-boot-recovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ownerPassword = "fixture-installation-owner";
const ownerHash = hashSync(ownerPassword, 4);

test("frozen handoff refuses active jobs, preparations, unresolved holds and children", () => {
  const pending = {
    id: randomUUID(),
    revision: randomUUID(),
    target: "host",
    reason: "fixture",
    requestedBy: "host-agent",
    createdAt: "2026-10-08T00:00:00.000Z",
    expiresAt: "2026-10-09T00:00:00.000Z",
    status: "pending",
    detail: "fixture",
  };
  expect(() => assertFrozenCoordinatorIdle([pending], [])).not.toThrow();
  expect(() => assertFrozenCoordinatorIdle([pending], [123])).toThrow("children");
  expect(() => assertFrozenCoordinatorIdle([pending], undefined)).toThrow();
  expect(() => assertFrozenCoordinatorIdle([pending, pending], [])).toThrow("duplicate");
  for (const change of [
    { status: "approved" },
    { status: "running" },
    { sourceBatch: { status: "preparing", contributions: [] } },
    { status: "failed", finishCurrentTurns: true },
    { status: "rejected", finishCurrentTurns: true, holdReleased: false },
    { status: "succeeded", finishCurrentTurns: true },
    { status: "failed", continuationCaptureRequested: true },
    { status: "rejected", continuationCaptureRequested: true, holdReleased: false },
    { status: "succeeded", continuationCaptureRequested: true },
  ])
    expect(() => assertFrozenCoordinatorIdle([{ ...pending, ...change }], [])).toThrow(
      "unresolved",
    );
  expect(() =>
    assertFrozenCoordinatorIdle(
      [{ ...pending, status: "failed", finishCurrentTurns: true, holdReleased: true }],
      [],
    ),
  ).not.toThrow();
  expect(() => assertFrozenCoordinatorIdle([{ ...pending, status: "unknown" }], [])).toThrow();
  expect(() => assertFrozenCoordinatorIdle(null, [])).toThrow();
});

test("bootstrap launchers preserve environment and lifetime settings with exact approved arguments", () => {
  const { plan } = fixture();
  const configurationFile = "/protected/active-config.json";
  const current = {
    Label: plan.service.split("/").slice(2).join("/"),
    ProgramArguments: [plan.previous.node.path, plan.previous.entrypoint.path, configurationFile],
    EnvironmentVariables: { PATH: "/usr/bin:/bin", PRESERVED: "fixture-value" },
    KeepAlive: true,
    RunAtLoad: true,
  };
  const candidate = {
    ...current,
    ProgramArguments: [
      plan.candidate.node.path,
      plan.candidate.entrypoint.path,
      plan.candidate.configuration.path,
    ],
  };
  const input = { plan, configurationFile, current, previous: structuredClone(current), candidate };
  expect(() => verifyBootstrapLaunchers(input)).not.toThrow();
  for (const change of [
    { EnvironmentVariables: { PATH: "/unapproved" } },
    { KeepAlive: false },
    { Program: "/unapproved/executable" },
    { Label: "another-service" },
    { ProgramArguments: [...candidate.ProgramArguments, "--unapproved"] },
  ])
    expect(() =>
      verifyBootstrapLaunchers({ ...input, candidate: { ...candidate, ...change } }),
    ).toThrow("unapproved service settings");
  expect(() =>
    verifyBootstrapLaunchers({ ...input, previous: { ...current, RunAtLoad: false } }),
  ).toThrow("no longer matches");
});

test("loaded coordinator PID parsing rejects nested, foreign and incomplete records", () => {
  const service = "gui/501/local.vorteo.fixture.installation";
  expect(loadedCoordinatorPid(service, `${service} = {\n\tpid = 123\n}`)).toBe(123);
  for (const output of [
    `other = {\n\tpid = 123\n}`,
    `${service} = {\n\t\tpid = 123\n}`,
    `${service} = {\n\tpid = 123\n\tpid = 124\n}`,
    `${service} = {\n\tpid = 123\n`,
  ])
    expect(() => loadedCoordinatorPid(service, output)).toThrow();
});

test("loaded coordinator identity binds kernel birth, owner, parent and exact launch arguments", async () => {
  const { plan } = fixture();
  const configurationFile = "/protected/config.json";
  const digest = createHash("sha256")
    .update(
      JSON.stringify([plan.previous.node.path, plan.previous.entrypoint.path, configurationFile]),
    )
    .digest("hex");
  plan.expectedProcess = {
    pid: 123,
    bootId: randomUUID(),
    startIdentity: "1234:5678",
    argumentsSha256: digest,
  };
  const observation = {
    ...plan.expectedProcess,
    uid: 501,
    parentPid: 1,
    executable: plan.previous.node.path,
  };
  const input = {
    plan,
    configurationFile,
    hostUid: 501,
    launchctlOutput: `${plan.service} = {\n\tpid = 123\n}`,
    process: observation,
  };
  expect(() => verifyBootstrapServiceIdentity(input)).not.toThrow();
  for (const change of [
    { pid: 124 },
    { bootId: randomUUID() },
    { startIdentity: "1234:5679" },
    { uid: 502 },
    { parentPid: 99 },
    { executable: "/other/node" },
    { argumentsSha256: "f".repeat(64) },
  ])
    expect(() =>
      verifyBootstrapServiceIdentity({ ...input, process: { ...observation, ...change } }),
    ).toThrow();
  expect(() =>
    verifyBootstrapServiceIdentity({ ...input, configurationFile: "/other/config.json" }),
  ).toThrow("prepared launcher");
  expect(() =>
    verifyBootstrapServiceIdentity({
      ...input,
      launchctlOutput: `${plan.service} = {\n\tpid = 124\n}`,
    }),
  ).toThrow("changed since preparation");
  for (const changedServiceRead of [0, 1, 2, 3]) {
    let reads = 0;
    let processReads = 0;
    const verification = verifyLoadedBootstrapService({
      ...input,
      reader: {
        async readService(service) {
          expect(service).toBe(plan.service);
          reads++;
          const pid = reads === changedServiceRead ? 124 : 123;
          return `${service} = {\n\tpid = ${pid}\n}`;
        },
        async inspectProcess(pid) {
          expect(pid).toBe(123);
          processReads++;
          return observation;
        },
      },
    });
    if (changedServiceRead === 0) {
      await expect(verification).resolves.toBeUndefined();
      expect(processReads).toBe(2);
      expect(reads).toBe(3);
    } else {
      await expect(verification).rejects.toThrow("PID changed");
      expect(processReads).toBe(changedServiceRead - 1);
    }
  }
  let inspections = 0;
  await expect(
    verifyLoadedBootstrapService({
      ...input,
      reader: {
        async readService() {
          return input.launchctlOutput;
        },
        async inspectProcess() {
          inspections++;
          if (inspections === 2) return { ...observation, startIdentity: "1234:5679" };
          return observation;
        },
      },
    }),
  ).rejects.toThrow("changed since preparation");
});

test.each([
  "unchanged",
  "service-appears-before-inspection",
  "service-appears-between-inspections",
  "service-appears-after-inspection",
  "birth-changes",
  "boot-changes",
  "owner-changes",
  "parent-changes",
  "executable-changes",
  "arguments-change",
  "inspection-fails",
])("unregistered coordinator preparation refuses ambiguous supervision: %s", async (change) => {
  const { plan } = fixture();
  const configurationFile = "/protected/config.json";
  plan.expectedProcess.bootId = randomUUID();
  plan.expectedProcess.startIdentity = "1234:5678";
  plan.expectedProcess.argumentsSha256 = createHash("sha256")
    .update(
      JSON.stringify([plan.previous.node.path, plan.previous.entrypoint.path, configurationFile]),
    )
    .digest("hex");
  const process = {
    ...plan.expectedProcess,
    uid: 501,
    parentPid: 1,
    executable: plan.previous.node.path,
  };
  const events: string[] = [];
  let absenceReads = 0;
  let processReads = 0;
  const verification = verifyUnregisteredBootstrapCoordinator({
    plan,
    configurationFile,
    hostUid: 501,
    reader: {
      async verifyServiceAbsent(service) {
        expect(service).toBe(plan.service);
        events.push("absence");
        absenceReads++;
        const expectedFailure = [
          "service-appears-before-inspection",
          "service-appears-between-inspections",
          "service-appears-after-inspection",
        ][absenceReads - 1];
        if (change === expectedFailure) throw new Error("Native service is present");
      },
      async inspectProcess(pid) {
        expect(pid).toBe(plan.expectedProcess.pid);
        events.push("process");
        processReads++;
        if (processReads === 1) return process;
        switch (change) {
          case "birth-changes":
            return { ...process, startIdentity: "1234:5679" };
          case "boot-changes":
            return { ...process, bootId: randomUUID() };
          case "owner-changes":
            return { ...process, uid: 502 };
          case "parent-changes":
            return { ...process, parentPid: 99 };
          case "executable-changes":
            return { ...process, executable: "/other/node" };
          case "arguments-change":
            return { ...process, argumentsSha256: "f".repeat(64) };
          case "inspection-fails":
            throw new Error("Native inspection unavailable");
          default:
            return process;
        }
      },
    },
  });
  if (change === "unchanged") {
    await expect(verification).resolves.toBeUndefined();
    expect(events).toEqual(["absence", "process", "absence", "process", "absence"]);
  } else {
    await expect(verification).rejects.toThrow();
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "coordinator-bootstrap-")));
  roots.push(root);
  const identity = { path: "/protected/file", sha256: "a".repeat(64) };
  const release = {
    sourceCommit: "b".repeat(40),
    directory: "/protected/release",
    artifactSha256: "c".repeat(64),
    node: identity,
    entrypoint: identity,
    configuration: identity,
    launcher: identity,
  };
  const plan: CoordinatorBootstrapPlan = {
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: randomUUID(),
    service: "gui/501/local.vorteo.fixture.installation",
    expectedProcess: {
      pid: 123,
      bootId: "fixture-boot",
      startIdentity: "fixture-start",
      argumentsSha256: "d".repeat(64),
    },
    previous: release,
    candidate: { ...release, sourceCommit: "e".repeat(40) },
    state: {
      directory: "/protected/state",
      restartJournal: "/protected/state/restarts.json",
      ownerSessions: "/protected/state/owners.json",
    },
    hostRequestsAfter: null,
  };
  let binding = {
    environment: "host",
    installationId: plan.installationId,
    service: plan.service,
    ownerPasswordHash: ownerHash,
  };
  let verify = async (_plan: CoordinatorBootstrapPlan) => {};
  const journal = new FileBootstrapRequestJournal(root);
  const service = () =>
    new CoordinatorBootstrapRequests(
      journal,
      () => binding,
      (value) => verify(value),
    );
  return {
    root,
    plan,
    journal,
    service,
    binding,
    setBinding: (value: typeof binding) => {
      binding = value;
    },
    setVerify: (value: typeof verify) => {
      verify = value;
    },
    prepare: () =>
      service().prepare({ id: randomUUID(), reason: "Install reviewed coordinator", plan }),
  };
}

test("bootstrap preparation stays pending and exact owner approval survives reopening without storing credentials", async () => {
  const f = fixture();
  const pending = await f.prepare();
  expect(f.service().list()).toEqual([pending]);
  expect(pending.status).toBe("pending");
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  expect(approved.status).toBe("approved");
  expect(approved.revision).not.toBe(pending.revision);
  expect(f.service().list()).toEqual([approved]);
  const stored = readFileSync(path.join(f.root, "coordinator-bootstrap.json"), "utf8");
  expect(stored).not.toContain(ownerPassword);
  expect(stored).not.toContain(ownerHash);
  expect(statSync(path.join(f.root, "coordinator-bootstrap.json")).mode & 0o777).toBe(0o600);
});

test("Dev bindings and owner role labels cannot substitute for installation-owner authentication", async () => {
  const f = fixture();
  f.setBinding({ ...f.binding, environment: "container" });
  expect(() => f.service()).toThrow();
  f.setBinding(f.binding);
  const pending = await f.prepare();
  const input = {
    id: pending.id,
    revision: pending.revision,
    planSha256: pending.planSha256,
    decision: "approve",
  };
  for (const credential of ["", "host-agent-token", "container-agent-token", "owner"])
    await expect(f.service().decide(input, credential)).rejects.toThrow(
      "owner authentication required",
    );
  await expect(
    f.service().decide({ ...input, principalId: "owner" }, ownerPassword),
  ).rejects.toThrow();
  expect(f.service().list()[0]?.status).toBe("pending");
  f.setBinding({ ...f.binding, ownerPasswordHash: "" });
  expect(() => f.service()).toThrow();
});

test("preparation is idempotent and rejects another open request or changed request identity", async () => {
  const f = fixture();
  const input = { id: randomUUID(), reason: "Prepared", plan: f.plan };
  const first = await f.service().prepare(input);
  expect(await f.service().prepare(input)).toEqual(first);
  await expect(f.service().prepare({ ...input, reason: "Different" })).rejects.toThrow(
    "different prepared work",
  );
  await expect(f.prepare()).rejects.toThrow("already open");
  expect(f.service().list()).toEqual([first]);
});

test.each(["succeeded", "resumed", "rolled_back"] as const)(
  "a %s bootstrap retains history and permits a new pending review",
  async (stage) => {
    const f = fixture();
    const first = await f.prepare();
    const completed = {
      ...first,
      status: "approved" as const,
      execution: { generation: randomUUID(), stage, updatedAt: new Date().toISOString() },
    };
    f.journal.replace([first], [completed]);
    let verified = false;
    f.setVerify(async () => {
      verified = true;
    });
    const next = await f.prepare();
    expect(verified).toBe(true);
    expect(next.status).toBe("pending");
    expect(next.execution).toBeUndefined();
    expect(f.service().list()).toEqual([completed, next]);
    await expect(f.prepare()).rejects.toThrow("already open");
  },
);

test("successful recovery closes only its exact failed ancestry for later maintenance", async () => {
  const f = fixture();
  const first = await f.prepare();
  const failed = {
    ...first,
    status: "approved" as const,
    execution: {
      generation: randomUUID(),
      stage: "recovery_required" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  f.journal.replace([first], [failed]);
  const plan = {
    ...f.plan,
    recoveredFrom: {
      id: failed.id,
      revision: failed.revision,
      planSha256: failed.planSha256,
      generation: failed.execution.generation,
    },
  };
  const pending = await f.service().prepare({ id: randomUUID(), reason: "Recovery", plan });
  const completed = {
    ...pending,
    status: "approved" as const,
    execution: {
      generation: randomUUID(),
      stage: "succeeded" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  f.journal.replace([failed, pending], [failed, completed]);
  expect(openBootstrapRequests([failed, completed])).toEqual([]);
  const next = await f.prepare();
  expect(f.service().list()).toEqual([failed, completed, next]);
  const active = {
    ...next,
    status: "approved" as const,
    execution: {
      generation: randomUUID(),
      stage: "start_pending" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  const identity = {
    installationId: f.plan.installationId,
    stateDirectory: f.plan.state.directory,
    node: next.plan.candidate.node.path,
    entrypoint: next.plan.candidate.entrypoint.path,
    configuration: next.plan.candidate.configuration.path,
  };
  expect(coordinatorStartupAdmission([failed, completed, active], identity)).toEqual({
    kind: "fenced",
    request: active,
  });
  expect(coordinatorStartupReleased([failed, completed, active], identity, active)).toBe(false);
  const finished = { ...active, execution: { ...active.execution, stage: "succeeded" as const } };
  expect(coordinatorStartupReleased([failed, completed, finished], identity, active)).toBe(true);
  // A separate unresolved failure must still fence the next review.
  const unrelated = { ...failed, id: randomUUID() };
  expect(openBootstrapRequests([failed, completed, unrelated])).toEqual([unrelated]);
  f.journal.replace([failed, completed, next], [failed, completed, unrelated]);
  await expect(f.prepare()).rejects.toThrow("already open");
  expect(() =>
    coordinatorStartupAdmission([failed, completed, unrelated, active], identity),
  ).toThrow("Multiple bootstrap");
  // A terminal label cannot cover a changed recovery generation.
  const stale = {
    ...completed,
    plan: { ...completed.plan, recoveredFrom: { ...plan.recoveredFrom, generation: randomUUID() } },
  };
  stale.planSha256 = coordinatorPlanDigest(stale.plan);
  expect(() => openBootstrapRequests([failed, stale])).toThrow("history changed");
  f.journal.replace([failed, completed, unrelated], [failed, stale]);
  await expect(f.prepare()).rejects.toThrow("history changed");
});

test("approval rechecks artifacts and rejects stale revision or installation selection", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const input = {
    id: pending.id,
    revision: pending.revision,
    planSha256: pending.planSha256,
    decision: "approve",
  };
  await expect(
    f.service().decide({ ...input, revision: randomUUID() }, ownerPassword),
  ).rejects.toThrow("changed");
  f.setVerify(async () => {
    throw new Error("Prepared bytes changed");
  });
  await expect(f.service().decide(input, ownerPassword)).rejects.toThrow("Prepared bytes changed");
  f.setBinding({ ...f.binding, installationId: randomUUID() });
  await expect(f.service().decide(input, ownerPassword)).rejects.toThrow("does not match");
  expect(f.journal.read()[0]?.status).toBe("pending");
});

test("cancellation wins while asynchronous approval validation is outstanding", async () => {
  const f = fixture();
  const pending = await f.prepare();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setVerify(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const input = { id: pending.id, revision: pending.revision, planSha256: pending.planSha256 };
  const approval = f.service().decide({ ...input, decision: "approve" }, ownerPassword);
  await started;
  const canceled = await f.service().decide({ ...input, decision: "cancel" }, ownerPassword);
  release();
  await expect(approval).rejects.toThrow("changed");
  expect(f.service().list()).toEqual([canceled]);
  expect(canceled.status).toBe("canceled");
});

test.each([null, { node: "/private/node", script: "/private/adopt.mjs", sha256: "d".repeat(64) }])(
  "bootstrap Factory configuration preserves legacy review and requires explicit support (%j)",
  async (configuration) => {
    const f = fixture();
    const service = f.service();
    const request = await service.prepare({
      id: randomUUID(),
      reason: "Reviewed startup configuration",
      plan: { ...f.plan, factoryRuntimeAdoptionConfiguration: configuration },
    });
    const list = {
      type: "installation.bootstrap.list_requests.request" as const,
      requestId: "legacy",
    };
    const legacy = await handleBootstrapReview(list, service);
    const legacySchema = CoordinatorBootstrapRequestSchema.extend({
      plan: CoordinatorBootstrapPlanSchema.omit({ factoryRuntimeAdoptionConfiguration: true }),
    });
    expect(legacySchema.safeParse(request).success).toBe(false);
    const projected = legacy.payload.requests![0]!;
    expect(legacySchema.safeParse(projected).success).toBe(true);
    expect(projected.reason).toContain("Reload");
    expect(projected.planSha256).toBe(request.planSha256);
    const current = await handleBootstrapReview({ ...list, factoryRuntimeAdoption: true }, service);
    expect(current.payload.requests![0]!.plan.factoryRuntimeAdoptionConfiguration).toEqual(
      configuration,
    );
    const decision = {
      type: "installation.bootstrap.decide.request" as const,
      requestId: "approval",
      ownerPassword,
      input: {
        id: request.id,
        revision: request.revision,
        planSha256: request.planSha256,
        decision: "approve" as const,
      },
    };
    const refused = await handleBootstrapReview(decision, service);
    expect(refused.payload.error).toContain("Reload");
    expect(service.list()[0]!.status).toBe("pending");
    const approved = await handleBootstrapReview(
      { ...decision, factoryRuntimeAdoption: true },
      service,
    );
    expect(approved.payload.error).toBeNull();
    expect(approved.payload.requests![0]!.status).toBe("approved");
    const retained = service.list()[0]!;
    const cancelled = await handleBootstrapReview(
      {
        ...decision,
        input: { ...decision.input, revision: retained.revision, decision: "cancel" },
      },
      service,
    );
    expect(cancelled.payload.error).toBeNull();
    expect(cancelled.payload.requests![0]!.status).toBe("canceled");
    expect(legacySchema.safeParse(cancelled.payload.requests![0]).success).toBe(true);
  },
);

test("plan digest ignores object key order but binds replacement and policy changes", () => {
  const f = fixture();
  expect(coordinatorPlanDigest(Object.fromEntries(Object.entries(f.plan).toReversed()))).toBe(
    coordinatorPlanDigest(f.plan),
  );
  expect(
    coordinatorPlanDigest({ ...f.plan, hostRequestsAfter: new Date(0).toISOString() }),
  ).not.toBe(coordinatorPlanDigest(f.plan));
  expect(
    coordinatorPlanDigest({
      ...f.plan,
      candidate: { ...f.plan.candidate, artifactSha256: "f".repeat(64) },
    }),
  ).not.toBe(coordinatorPlanDigest(f.plan));
  expect(coordinatorPlanDigest({ ...f.plan, nativeHelperConfiguration: null })).not.toBe(
    coordinatorPlanDigest(f.plan),
  );
  const helper = {
    home: "/private/host",
    docker: "/usr/local/bin/docker",
    socket: "/private/docker.sock",
    containerId: "a".repeat(64),
  };
  const adoption = {
    node: "/private/host/node",
    script: "/private/host/adopt.mjs",
    sha256: "d".repeat(64),
  };
  const adoptionDigest = coordinatorPlanDigest({
    ...f.plan,
    factoryRuntimeAdoptionConfiguration: adoption,
  });
  expect(adoptionDigest).not.toBe(coordinatorPlanDigest(f.plan));
  expect(coordinatorPlanDigest({ ...f.plan, factoryRuntimeAdoptionConfiguration: null })).not.toBe(
    adoptionDigest,
  );
  expect(
    coordinatorPlanDigest({
      ...f.plan,
      factoryRuntimeAdoptionConfiguration: { ...adoption, sha256: "e".repeat(64) },
    }),
  ).not.toBe(adoptionDigest);
  const enabled = coordinatorPlanDigest({ ...f.plan, nativeHelperConfiguration: helper });
  expect(enabled).not.toBe(coordinatorPlanDigest(f.plan));
  expect(
    coordinatorPlanDigest({
      ...f.plan,
      nativeHelperConfiguration: { ...helper, containerId: "b".repeat(64) },
    }),
  ).not.toBe(enabled);
  expect(() => coordinatorPlanDigest({ ...f.plan, command: "arbitrary shell" })).toThrow();
});

test("journal refuses symlink substitution and preserves an existing writer lock", async () => {
  const f = fixture();
  await f.prepare();
  const link = path.join(f.root, "alias");
  symlinkSync(f.root, link);
  expect(() => new FileBootstrapRequestJournal(link)).toThrow("canonical directory");
  writeFileSync(path.join(f.root, "coordinator-bootstrap.lock"), "other owner", { mode: 0o600 });
  const pending = f.service().list()[0]!;
  await expect(
    f.service().decide(
      {
        id: pending.id,
        revision: pending.revision,
        planSha256: pending.planSha256,
        decision: "cancel",
      },
      ownerPassword,
    ),
  ).rejects.toThrow("storage is busy");
  expect(readFileSync(path.join(f.root, "coordinator-bootstrap.lock"), "utf8")).toBe("other owner");
  expect(f.service().list()[0]?.status).toBe("pending");
});

test("owner credential rotation during artifact verification invalidates approval", async () => {
  const f = fixture();
  const pending = await f.prepare();
  f.setVerify(async () => {
    f.setBinding({ ...f.binding, ownerPasswordHash: hashSync("replacement-owner", 4) });
  });
  await expect(
    f.service().decide(
      {
        id: pending.id,
        revision: pending.revision,
        planSha256: pending.planSha256,
        decision: "approve",
      },
      ownerPassword,
    ),
  ).rejects.toThrow("authentication changed");
  expect(f.journal.read()[0]?.status).toBe("pending");
});

test("approved bootstrap can be canceled without accepting damaged replacement bytes", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  f.setVerify(async () => {
    throw new Error("Candidate no longer available");
  });
  const canceled = await f.service().decide(
    {
      id: approved.id,
      revision: approved.revision,
      planSha256: approved.planSha256,
      decision: "cancel",
    },
    ownerPassword,
  );
  expect(canceled.status).toBe("canceled");
  await expect(
    f.service().decide(
      {
        id: canceled.id,
        revision: canceled.revision,
        planSha256: canceled.planSha256,
        decision: "approve",
      },
      ownerPassword,
    ),
  ).rejects.toThrow("already been decided");
});

test("two asynchronous preparations cannot publish competing bootstrap requests", async () => {
  const f = fixture();
  const waiting: Array<() => void> = [];
  f.setVerify(
    () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
      }),
  );
  const first = f.prepare();
  const second = f.prepare();
  expect(waiting).toHaveLength(2);
  waiting[0]!();
  const saved = await first;
  waiting[1]!();
  await expect(second).rejects.toThrow("changed");
  expect(f.service().list()).toEqual([saved]);
});

test("stored plan alteration and journal file symlinks are refused", async () => {
  const f = fixture();
  await f.prepare();
  const file = path.join(f.root, "coordinator-bootstrap.json");
  const value = JSON.parse(readFileSync(file, "utf8"));
  value.requests[0].plan.candidate.sourceCommit = "f".repeat(40);
  writeFileSync(file, JSON.stringify(value));
  expect(() => f.service().list()).toThrow("digest check");
  const target = path.join(f.root, "other.json");
  writeFileSync(target, JSON.stringify(value), { mode: 0o600 });
  rmSync(file);
  symlinkSync(target, file);
  expect(() => f.journal.read()).toThrow();
  expect(readFileSync(target, "utf8")).toBe(JSON.stringify(value));
});

test("dispatch claims exact approval once and preserves its generation across reopen", async () => {
  const f = fixture();
  const pending = await f.prepare();
  await expect(
    f.service().claimDispatch({
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
    }),
  ).rejects.toThrow("approval required");
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  const identity = {
    id: approved.id,
    revision: approved.revision,
    planSha256: approved.planSha256,
  };
  const results = await Promise.allSettled([
    f.service().claimDispatch(identity),
    f.service().claimDispatch(identity),
  ]);
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  const claimed = f.service().list()[0]!;
  expect(claimed.execution?.stage).toBe("claimed");
  await expect(f.service().claimDispatch(identity)).rejects.toThrow("approval required");
  await expect(
    f.service().decide(
      {
        id: claimed.id,
        revision: claimed.revision,
        planSha256: claimed.planSha256,
        decision: "cancel",
      },
      ownerPassword,
    ),
  ).rejects.toThrow("already claimed");
  const progress = {
    id: claimed.id,
    revision: claimed.revision,
    planSha256: claimed.planSha256,
    generation: claimed.execution!.generation,
  };
  expect(() =>
    f.service().advanceDispatch({ ...progress, generation: randomUUID() }, "freeze_pending"),
  ).toThrow("ownership changed");
  expect(() => f.service().advanceDispatch(progress, "succeeded")).toThrow("Invalid");
  const freezing = f.service().advanceDispatch(progress, "freeze_pending");
  expect(f.service().list()[0]).toEqual(freezing);
  expect(() => f.service().advanceDispatch(progress, "freeze_pending")).toThrow(
    "ownership changed",
  );
  const uncertain = f
    .service()
    .advanceDispatch({ ...progress, revision: freezing.revision }, "recovery_required");
  expect(() =>
    f.service().advanceDispatch({ ...progress, revision: uncertain.revision }, "freeze_pending"),
  ).toThrow("Invalid");
});

test("cancellation during dispatch validation wins without a stored claim", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  let release!: () => void;
  const validation = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setVerify(() => validation);
  const identity = {
    id: approved.id,
    revision: approved.revision,
    planSha256: approved.planSha256,
  };
  const claim = f.service().claimDispatch(identity);
  await f.service().decide({ ...identity, decision: "cancel" }, ownerPassword);
  release();
  await expect(claim).rejects.toThrow("request changed");
  expect(f.service().list()[0]).toMatchObject({ status: "canceled" });
  expect(f.service().list()[0]?.execution).toBeUndefined();
});

test("bootstrap executor persists intent before each operation and never replays a completed claim", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  const calls: string[] = [];
  const observe = async (name: string, stage: string) => {
    expect(f.service().list()[0]?.execution?.stage).toBe(stage);
    calls.push(name);
  };
  const operations: BootstrapExecutorOperations = {
    withOwnership: async (_request, operation) => operation(),
    armWatchdog: () => observe("watchdog", "claimed"),
    freeze: () => observe("freeze", "freeze_pending"),
    inspectFrozen: async () => {
      await observe("inspect", "freeze_pending");
      return { restartJournal: [], childPids: [] };
    },
    preserveTransfer: () => observe("preserve", "frozen"),
    unload: () => observe("unload", "unload_pending"),
    select: () => observe("select", "selection_pending"),
    start: () => observe("start", "start_pending"),
    verifyReplacement: () => observe("verify", "verifying"),
    releaseReplacement: () => observe("release", "verifying"),
    resumePrevious: async () => {
      throw new Error("Unexpected resume");
    },
  };
  const identity = {
    id: approved.id,
    revision: approved.revision,
    planSha256: approved.planSha256,
  };
  const result = await executeCoordinatorBootstrap(f.service(), identity, operations);
  expect(result.execution?.stage).toBe("succeeded");
  expect(calls).toEqual([
    "watchdog",
    "freeze",
    "inspect",
    "preserve",
    "unload",
    "select",
    "start",
    "verify",
    "release",
  ]);
  await expect(executeCoordinatorBootstrap(f.service(), identity, operations)).rejects.toThrow(
    "undispatched",
  );
  expect(calls).toHaveLength(9);
});

test.each([
  "freeze",
  "inspectFrozen",
  "preserveTransfer",
  "unload",
  "select",
  "start",
  "verifyReplacement",
  "releaseReplacement",
] as const)(
  "bootstrap executor contains failure at %s without retrying the side effect",
  async (failure) => {
    const f = fixture();
    const pending = await f.prepare();
    const approved = await f.service().decide(
      {
        id: pending.id,
        revision: pending.revision,
        planSha256: pending.planSha256,
        decision: "approve",
      },
      ownerPassword,
    );
    const calls: string[] = [];
    const failures: string[] = [];
    const call = async (name: string) => {
      calls.push(name);
      if (name === failure) throw new Error("private diagnostic must not escape");
    };
    const operations: BootstrapExecutorOperations = {
      recordFailure: async (_request, diagnostic) => {
        failures.push(JSON.stringify(diagnostic));
      },
      withOwnership: async (_request, operation) => operation(),
      armWatchdog: () => call("armWatchdog"),
      freeze: () => call("freeze"),
      inspectFrozen: async () => {
        await call("inspectFrozen");
        return { restartJournal: [], childPids: [] };
      },
      preserveTransfer: () => call("preserveTransfer"),
      unload: () => call("unload"),
      select: () => call("select"),
      start: () => call("start"),
      verifyReplacement: () => call("verifyReplacement"),
      releaseReplacement: () => call("releaseReplacement"),
      resumePrevious: () => call("resumePrevious"),
    };
    const result = await executeCoordinatorBootstrap(
      f.service(),
      { id: approved.id, revision: approved.revision, planSha256: approved.planSha256 },
      operations,
    );
    const canResume = ["freeze", "inspectFrozen", "preserveTransfer"].includes(failure);
    expect(result.execution?.stage).toBe(canResume ? "resumed" : "recovery_required");
    const order = [
      "armWatchdog",
      "freeze",
      "inspectFrozen",
      "preserveTransfer",
      "unload",
      "select",
      "start",
      "verifyReplacement",
      "releaseReplacement",
    ];
    expect(calls).toEqual([
      ...order.slice(0, order.indexOf(failure) + 1),
      ...(canResume ? ["resumePrevious"] : []),
    ]);
    expect(JSON.stringify(f.service().list())).not.toContain("private diagnostic");
    expect(failures).toHaveLength(1);
    expect(failures[0]).not.toContain("private diagnostic");
    expect(failures[0]).toContain("operation");
  },
);

test.each([false, true])(
  "busy bootstrap resumes only the old process and records resume failure: %s",
  async (resumeFails) => {
    const f = fixture();
    const pending = await f.prepare();
    const approved = await f.service().decide(
      {
        id: pending.id,
        revision: pending.revision,
        planSha256: pending.planSha256,
        decision: "approve",
      },
      ownerPassword,
    );
    const calls: string[] = [];
    const forbidden = async () => {
      calls.push("forbidden");
      throw new Error("Unexpected transfer");
    };
    const operations: BootstrapExecutorOperations = {
      withOwnership: async (_request, operation) => operation(),
      armWatchdog: async () => {
        calls.push("watchdog");
      },
      freeze: async () => {
        calls.push("freeze");
      },
      inspectFrozen: async () => ({ restartJournal: [], childPids: [123] }),
      preserveTransfer: forbidden,
      unload: forbidden,
      select: forbidden,
      start: forbidden,
      verifyReplacement: forbidden,
      releaseReplacement: forbidden,
      resumePrevious: async () => {
        calls.push("resume");
        if (resumeFails) throw new Error("Identity changed");
      },
    };
    const result = await executeCoordinatorBootstrap(
      f.service(),
      { id: approved.id, revision: approved.revision, planSha256: approved.planSha256 },
      operations,
    );
    expect(result.execution?.stage).toBe(resumeFails ? "recovery_required" : "resumed");
    expect(calls).toEqual(["watchdog", "freeze", "resume"]);
  },
);

test("replacement startup remains fenced until its exact generation succeeds", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const identity = {
    installationId: f.plan.installationId,
    stateDirectory: f.plan.state.directory,
    node: f.plan.candidate.node.path,
    entrypoint: f.plan.candidate.entrypoint.path,
    configuration: f.plan.candidate.configuration.path,
  };
  expect(coordinatorStartupAdmission([pending], identity)).toEqual({ kind: "ordinary" });
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  const record = {
    ...approved,
    execution: {
      generation: randomUUID(),
      stage: "start_pending" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  expect(coordinatorStartupAdmission([record], identity)).toEqual({
    kind: "fenced",
    request: record,
  });
  expect(coordinatorStartupReleased([record], identity, record)).toBe(false);
  const success = { ...record, execution: { ...record.execution, stage: "succeeded" as const } };
  expect(coordinatorStartupReleased([success], identity, record)).toBe(true);
  expect(() => coordinatorStartupReleased([], identity, record)).toThrow("ownership changed");
  expect(() =>
    coordinatorStartupReleased(
      [{ ...success, execution: { ...success.execution, generation: randomUUID() } }],
      identity,
      record,
    ),
  ).toThrow("ownership changed");
  for (const field of ["node", "entrypoint", "configuration", "stateDirectory"] as const)
    expect(() =>
      coordinatorStartupAdmission([record], { ...identity, [field]: "/wrong" }),
    ).toThrow();
  expect(() =>
    coordinatorStartupAdmission([record], { ...identity, installationId: randomUUID() }),
  ).toThrow();
  expect(() =>
    coordinatorStartupAdmission([{ ...record, planSha256: "0".repeat(64) }], identity),
  ).toThrow();
  expect(() => coordinatorStartupAdmission([record, record], identity)).toThrow("Duplicate");
  expect(() =>
    coordinatorStartupAdmission([record, { ...record, id: randomUUID() }], identity),
  ).toThrow("Multiple");
  expect(() =>
    coordinatorStartupAdmission([{ ...record, status: "canceled" }], identity),
  ).toThrow();
  for (const stage of [
    "claimed",
    "freeze_pending",
    "frozen",
    "unload_pending",
    "unloaded",
    "selection_pending",
    "selected",
    "resume_pending",
    "recovery_required",
  ])
    expect(() =>
      coordinatorStartupAdmission(
        [{ ...record, execution: { ...record.execution, stage } }],
        identity,
      ),
    ).toThrow("recovery");
});

test("native startup fence reloads its durable generation and refuses deleted or replaced records", async () => {
  const f = fixture();
  f.plan.state.directory = f.root;
  const identity = {
    installationId: f.plan.installationId,
    stateDirectory: f.root,
    node: f.plan.candidate.node.path,
    entrypoint: f.plan.candidate.entrypoint.path,
    configuration: f.plan.candidate.configuration.path,
  };
  expect(loadCoordinatorStartupFence(identity)).toBeUndefined();
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  const record = {
    ...approved,
    execution: {
      generation: randomUUID(),
      stage: "started" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  f.journal.replace([approved], [record]);
  const fence = loadCoordinatorStartupFence(identity);
  expect(fence?.generation).toBe(record.execution.generation);
  expect(fence?.released()).toBe(false);
  f.journal.replace([record], []);
  expect(() => fence?.released()).toThrow("ownership changed");
  const success = { ...record, execution: { ...record.execution, stage: "succeeded" as const } };
  f.journal.replace([], [success]);
  expect(fence?.released()).toBe(true);
  expect(loadCoordinatorStartupFence(identity)).toBeUndefined();
});

test.each([
  "claimed",
  "freeze_pending",
  "frozen",
  "resume_pending",
  "unload_pending",
  "unloaded",
  "selection_pending",
  "selected",
  "start_pending",
  "started",
  "verifying",
  "succeeded",
  "resumed",
  "recovery_required",
] as const)("watchdog crash recovery at %s never resumes after transfer intent", async (stage) => {
  const f = fixture();
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  const record = {
    ...approved,
    execution: { generation: randomUUID(), stage, updatedAt: new Date().toISOString() },
  };
  f.journal.replace([approved], [record]);
  const calls: string[] = [];
  const result = await recoverAbandonedBootstrap(
    f.service(),
    { id: record.id, generation: record.execution.generation },
    {
      withOwnership: async (operation) => {
        calls.push("exclusive");
        return operation();
      },
      verifyExecutorExited: async () => {
        calls.push("exited");
      },
      resumePrevious: async () => {
        expect(f.service().list()[0]?.execution?.stage).toBe("resume_pending");
        calls.push("resume");
      },
    },
  );
  const resumable = ["freeze_pending", "frozen", "resume_pending"].includes(stage);
  const terminal = ["succeeded", "resumed", "recovery_required"].includes(stage);
  let expectedStage: string = "recovery_required";
  if (terminal) expectedStage = stage;
  if (resumable) expectedStage = "resumed";
  expect(result.execution?.stage).toBe(expectedStage);
  expect(calls).toEqual(["exclusive", "exited", ...(resumable ? ["resume"] : [])]);
});

test("watchdog refuses uncertain executor death and changed ownership before any resume", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  const record = {
    ...approved,
    execution: {
      generation: randomUUID(),
      stage: "frozen" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  f.journal.replace([approved], [record]);
  const expected = { id: record.id, generation: record.execution.generation };
  let resumes = 0;
  const operations = {
    withOwnership: async <T>(operation: () => Promise<T>) => operation(),
    verifyExecutorExited: async () => {
      throw new Error("Observation unavailable");
    },
    resumePrevious: async () => {
      resumes++;
    },
  };
  await expect(recoverAbandonedBootstrap(f.service(), expected, operations)).rejects.toThrow(
    "Observation unavailable",
  );
  expect(f.service().list()).toEqual([record]);
  await expect(
    recoverAbandonedBootstrap(
      f.service(),
      { ...expected, generation: randomUUID() },
      { ...operations, verifyExecutorExited: async () => {} },
    ),
  ).rejects.toThrow("ownership changed");
  expect(resumes).toBe(0);
  const result = await recoverAbandonedBootstrap(f.service(), expected, {
    ...operations,
    verifyExecutorExited: async () => {},
    resumePrevious: async () => {
      throw new Error("Old process identity changed");
    },
  });
  expect(result.execution?.stage).toBe("recovery_required");
  expect(resumes).toBe(0);
});

test.runIf(process.platform === "darwin").each([
  ["freeze", "freeze_pending", ["kill", "SIGSTOP"]],
  ["resumePrevious", "resume_pending", ["kill", "SIGCONT"]],
  ["unload", "unload_pending", ["bootout"]],
] as const)(
  "native %s binds exact dispatch and verifies process observations",
  async (operation, stage, args) => {
    const f = fixture();
    f.plan.state = {
      directory: f.root,
      restartJournal: path.join(f.root, "restart-jobs.json"),
      ownerSessions: path.join(f.root, "owner-sessions.json"),
    };
    const configurationFile = "/protected/config.json";
    f.plan.expectedProcess.bootId = randomUUID();
    f.plan.expectedProcess.startIdentity = "123:456";
    f.plan.expectedProcess.argumentsSha256 = createHash("sha256")
      .update(
        JSON.stringify([
          f.plan.previous.node.path,
          f.plan.previous.entrypoint.path,
          configurationFile,
        ]),
      )
      .digest("hex");
    const pending = await f.prepare();
    const approved = await f.service().decide(
      {
        id: pending.id,
        revision: pending.revision,
        planSha256: pending.planSha256,
        decision: "approve",
      },
      ownerPassword,
    );
    const record = {
      ...approved,
      execution: { generation: randomUUID(), stage, updatedAt: new Date().toISOString() },
    };
    f.journal.replace([approved], [record]);
    const identity = {
      ...f.plan.expectedProcess,
      parentPid: 1,
      uid: process.getuid!(),
      executable: f.plan.previous.node.path,
    };
    const calls: string[][] = [];
    const observations: string[] = [];
    let owned = true;
    const reader = {
      readService: async () => `${f.plan.service} = {\n\tpid = ${identity.pid}\n}`,
      inspectProcess: async () => identity,
      inspectStoppedProcess: async () => ({ ...identity, stopped: true as const, childPids: [] }),
      inspectRunningProcess: async () => ({ ...identity, stopped: false as const }),
      verifyProcessExited: async () => {
        observations.push("exited");
      },
      verifyServiceAbsent: async () => {
        observations.push("absent");
      },
    };
    const actions = createBootstrapNativeLifecycle(
      {
        requests: f.service(),
        reader,
        configurationFile,
        launcherFile: "/protected/selected.plist",
        writableMountRoots: async () => [],
        readHealth: async () => {
          throw new Error("Unexpected fixture health read");
        },
        requireOwnership: async () => {
          if (!owned) throw new Error("Ownership lost");
        },
      },
      {
        run: async (command) => {
          calls.push([...command]);
        },
      },
    );
    await preserveBootstrapState({
      request: { ...record, execution: { ...record.execution, stage: "frozen" } },
      writableMountRoots: [],
      childPids: [],
    });
    await actions[operation](record);
    expect(calls).toEqual([[...args, f.plan.service]]);
    expect(observations).toEqual(operation === "unload" ? ["exited", "absent"] : []);
    owned = false;
    await expect(actions[operation](record)).rejects.toThrow("Ownership lost");
    expect(calls).toHaveLength(1);
    owned = true;
    await expect(actions[operation]({ ...record, revision: randomUUID() })).rejects.toThrow(
      "exact dispatch",
    );
    expect(calls).toHaveLength(1);
  },
);

test("replacement readiness binds fenced health to exact native candidate and stable process", async () => {
  const { plan } = fixture();
  const generation = randomUUID();
  plan.expectedProcess.bootId = randomUUID();
  const candidate = {
    pid: plan.expectedProcess.pid + 1,
    parentPid: 1,
    uid: 501,
    bootId: plan.expectedProcess.bootId,
    startIdentity: "9999:123",
    executable: plan.candidate.node.path,
    argumentsSha256: createHash("sha256")
      .update(
        JSON.stringify([
          plan.candidate.node.path,
          plan.candidate.entrypoint.path,
          plan.candidate.configuration.path,
        ]),
      )
      .digest("hex"),
  };
  const health = {
    installationId: plan.installationId,
    bootstrap: { generation, pid: candidate.pid, fenced: true },
  };
  const reader = {
    readService: async () => `${plan.service} = {\n\tpid = ${candidate.pid}\n}`,
    inspectProcess: async () => candidate,
  };
  const input = { plan, generation, hostUid: 501, reader, readHealth: async () => health };
  await expect(verifyBootstrapReplacement(input)).resolves.toBeUndefined();
  for (const change of [
    { uid: 502 },
    { parentPid: 2 },
    { bootId: randomUUID() },
    { executable: "/unapproved/node" },
    { argumentsSha256: "0".repeat(64) },
    { pid: candidate.pid + 1 },
  ]) {
    await expect(
      verifyBootstrapReplacement({
        ...input,
        reader: { ...reader, inspectProcess: async () => ({ ...candidate, ...change }) },
      }),
    ).rejects.toThrow("approved candidate");
  }
  for (const change of [{ generation: randomUUID() }, { fenced: false }]) {
    await expect(
      verifyBootstrapReplacement({
        ...input,
        readHealth: async () => ({ ...health, bootstrap: { ...health.bootstrap, ...change } }),
      }),
    ).rejects.toThrow();
  }
  await expect(
    verifyBootstrapReplacement({
      ...input,
      readHealth: async () => ({ ...health, installationId: randomUUID() }),
    }),
  ).rejects.toThrow();
  await expect(
    verifyBootstrapReplacement({
      ...input,
      readHealth: async () => ({
        ...health,
        bootstrap: { ...health.bootstrap, pid: candidate.pid + 1 },
      }),
    }),
  ).rejects.toThrow("another process");
  let observations = 0;
  await expect(
    verifyBootstrapReplacement({
      ...input,
      reader: {
        ...reader,
        inspectProcess: async () => ({
          ...candidate,
          startIdentity: String(++observations) + ":123",
        }),
      },
    }),
  ).rejects.toThrow("changed during readiness");
  await expect(
    verifyBootstrapReplacement({
      ...input,
      reader: {
        ...reader,
        readService: async () => `${plan.service} = {\n\tpid = ${plan.expectedProcess.pid}\n}`,
      },
    }),
  ).rejects.toThrow("previous PID");
});

test("bootstrap state preservation retains sessions and detects changed or missing journal without restoration", async () => {
  const f = fixture();
  f.plan.state = {
    directory: f.root,
    restartJournal: path.join(f.root, "restart-jobs.json"),
    ownerSessions: path.join(f.root, "owner-sessions.json"),
  };
  const pending = await f.prepare();
  const request = {
    ...pending,
    execution: {
      generation: randomUUID(),
      stage: "frozen" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  const sessions = JSON.stringify([{ hash: "private-session-hash", expiresAt: 9999999999999 }]);
  writeFileSync(f.plan.state.restartJournal, "[]", { mode: 0o600 });
  writeFileSync(f.plan.state.ownerSessions, sessions, { mode: 0o600 });
  const context = { request, writableMountRoots: [], childPids: [] };
  await preserveBootstrapState(context);
  await verifyBootstrapState(context);
  expect(readFileSync(f.plan.state.ownerSessions, "utf8")).toBe(sessions);
  const receipt = readFileSync(
    path.join(f.root, `coordinator-transfer-${request.execution.generation}.json`),
    "utf8",
  );
  expect(receipt).not.toContain("private-session-hash");
  await expect(preserveBootstrapState(context)).rejects.toThrow();
  writeFileSync(f.plan.state.restartJournal, "[ ]", { mode: 0o600 });
  await expect(verifyBootstrapState(context)).rejects.toThrow("no longer matches");
  expect(readFileSync(f.plan.state.restartJournal, "utf8")).toBe("[ ]");
  writeFileSync(f.plan.state.restartJournal, "[]", { mode: 0o600 });
  rmSync(f.plan.state.ownerSessions);
  await expect(verifyBootstrapState(context)).rejects.toThrow("no longer matches");
});

test("bootstrap state preservation refuses active children and permits an absent initial session store", async () => {
  const f = fixture();
  f.plan.state = {
    directory: f.root,
    restartJournal: path.join(f.root, "restart-jobs.json"),
    ownerSessions: path.join(f.root, "owner-sessions.json"),
  };
  const request = {
    ...(await f.prepare()),
    execution: {
      generation: randomUUID(),
      stage: "frozen" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  const context = { request, writableMountRoots: [], childPids: [456] };
  await expect(preserveBootstrapState(context)).rejects.toThrow("children");
  await preserveBootstrapState({ ...context, childPids: [] });
  await verifyBootstrapState(context);
  writeFileSync(f.plan.state.ownerSessions, "[]", { mode: 0o600 });
  await expect(verifyBootstrapState(context)).rejects.toThrow("no longer matches");
});

test("bootstrap state refuses exposed sessions and substituted state files", async () => {
  const f = fixture();
  f.plan.state = {
    directory: f.root,
    restartJournal: path.join(f.root, "restart-jobs.json"),
    ownerSessions: path.join(f.root, "owner-sessions.json"),
  };
  const request = {
    ...(await f.prepare()),
    execution: {
      generation: randomUUID(),
      stage: "frozen" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  const context = { request, writableMountRoots: [], childPids: [] };
  writeFileSync(f.plan.state.ownerSessions, "[]", { mode: 0o644 });
  await expect(preserveBootstrapState(context)).rejects.toThrow("private owned file");
  chmodSync(f.plan.state.ownerSessions, 0o600);
  writeFileSync(f.plan.state.ownerSessions, "{}");
  await expect(preserveBootstrapState(context)).rejects.toThrow();
  rmSync(f.plan.state.ownerSessions);
  const target = path.join(f.root, "substitute.json");
  writeFileSync(target, "[]", { mode: 0o600 });
  symlinkSync(target, f.plan.state.ownerSessions);
  await expect(preserveBootstrapState(context)).rejects.toThrow();
  expect(readFileSync(target, "utf8")).toBe("[]");
});

test.each([false, true])(
  "approved automatic recovery restores once and never replays the update (failure=%s)",
  async (fail) => {
    const f = fixture();
    f.plan.automaticRecovery = "restore-previous";
    const pending = await f.prepare();
    const approved = await f.service().decide(
      {
        id: pending.id,
        revision: pending.revision,
        planSha256: pending.planSha256,
        decision: "approve",
      },
      ownerPassword,
    );
    const record = {
      ...approved,
      execution: {
        generation: randomUUID(),
        stage: "selection_pending" as const,
        updatedAt: new Date().toISOString(),
      },
    };
    f.journal.replace([approved], [record]);
    let restores = 0;
    const operations = {
      withOwnership: async <T>(operation: () => Promise<T>) => operation(),
      verifyExecutorExited: async () => {},
      resumePrevious: async () => {
        throw new Error("Not a resume");
      },
      restorePrevious: async () => {
        restores++;
        expect(f.service().list()[0]?.execution?.stage).toBe("rollback_pending");
        expect(f.service().list()[0]?.execution?.rollbackAttemptedAt).toBeTruthy();
        if (fail) throw new Error("Readiness failed");
      },
    };
    const expected = { id: record.id, generation: record.execution.generation };
    const result = await recoverAbandonedBootstrap(f.service(), expected, operations);
    expect(result.execution?.stage).toBe(fail ? "recovery_required" : "rolled_back");
    expect(result.planSha256).toBe(approved.planSha256);
    await recoverAbandonedBootstrap(f.service(), expected, operations);
    expect(restores).toBe(1);
  },
);

test("automatic rollback cannot be added to an existing approval", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  const record = {
    ...approved,
    execution: {
      generation: randomUUID(),
      stage: "recovery_required" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  f.journal.replace([approved], [record]);
  expect(() =>
    f.service().advanceDispatch(
      {
        id: record.id,
        revision: record.revision,
        planSha256: record.planSha256,
        generation: record.execution.generation,
      },
      "rollback_pending",
    ),
  ).toThrow("unused exact plan approval");
  const altered = {
    ...record,
    plan: { ...record.plan, automaticRecovery: "restore-previous" as const },
  };
  f.journal.replace([record], [altered]);
  expect(() => f.service().list()).toThrow("digest");
});

test("rollback startup accepts only the previous launch arguments, including its active config path", async () => {
  const f = fixture();
  f.plan.automaticRecovery = "restore-previous";
  const identity = {
    installationId: f.plan.installationId,
    stateDirectory: f.plan.state.directory,
    node: f.plan.previous.node.path,
    entrypoint: f.plan.previous.entrypoint.path,
    configuration: "/protected/active-config.json",
  };
  f.plan.expectedProcess.argumentsSha256 = createHash("sha256")
    .update(JSON.stringify([identity.node, identity.entrypoint, identity.configuration]))
    .digest("hex");
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  const record = {
    ...approved,
    execution: {
      generation: randomUUID(),
      stage: "rollback_pending" as const,
      updatedAt: new Date().toISOString(),
      rollbackAttemptedAt: new Date().toISOString(),
    },
  };
  expect(coordinatorStartupAdmission([record], identity)).toEqual({ kind: "ordinary" });
  expect(() =>
    coordinatorStartupAdmission([record], { ...identity, configuration: "/other/config.json" }),
  ).toThrow();
});

test("a fresh review after restoration preserves the failed receipt and rejects stale recovery references", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  const failed = {
    ...approved,
    execution: {
      generation: randomUUID(),
      stage: "recovery_required" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  f.journal.replace([approved], [failed]);
  const recoveredFrom = {
    id: failed.id,
    revision: failed.revision,
    planSha256: failed.planSha256,
    generation: failed.execution.generation,
  };
  const nextPlan = { ...f.plan, recoveredFrom, automaticRecovery: "restore-previous" as const };
  await expect(
    f.service().prepare({
      id: randomUUID(),
      plan: { ...nextPlan, recoveredFrom: { ...recoveredFrom, revision: randomUUID() } },
      reason: "Fresh review",
    }),
  ).rejects.toThrow("history changed");
  await expect(
    f.service().prepare({
      id: randomUUID(),
      plan: { ...nextPlan, previous: { ...nextPlan.previous, sourceCommit: "f".repeat(40) } },
      reason: "Fresh review",
    }),
  ).rejects.toThrow("restored release");
  const next = await f
    .service()
    .prepare({ id: randomUUID(), plan: nextPlan, reason: "Fresh review" });
  expect(next.status).toBe("pending");
  expect(next.execution).toBeUndefined();
  expect(f.service().list()[0]).toEqual(failed);
  const decided = await f
    .service()
    .decide(
      { id: next.id, revision: next.revision, planSha256: next.planSha256, decision: "approve" },
      ownerPassword,
    );
  const started = {
    ...decided,
    execution: {
      generation: randomUUID(),
      stage: "start_pending" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  const candidate = started.plan.candidate;
  expect(
    coordinatorStartupAdmission([failed, started], {
      installationId: f.plan.installationId,
      stateDirectory: f.plan.state.directory,
      node: candidate.node.path,
      entrypoint: candidate.entrypoint.path,
      configuration: candidate.configuration.path,
    }).kind,
  ).toBe("fenced");
});

async function supervisionRecoveryFixture(
  input: { restored?: CoordinatorBootstrapPlan["previous"] } = {},
) {
  const f = fixture();
  f.plan.state.directory = f.root;
  f.plan.state.restartJournal = path.join(f.root, "restart-jobs.json");
  f.plan.state.ownerSessions = path.join(f.root, "owner-sessions.json");
  f.plan.service = `gui/${process.getuid!()}/local.vorteo.${f.plan.installationId}.installation`;
  f.setBinding({ ...f.binding, service: f.plan.service });
  if (input.restored) f.plan.candidate = input.restored;
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const claimed = await f.service().claimDispatch(pickDecision(approved));
  const failed = f.journal.fenceUnpromotedClaim(claimed, {
    id: randomUUID(),
    revision: randomUUID(),
    generation: randomUUID(),
    planSha256: "f".repeat(64),
  });
  const recoveredFrom = {
    id: failed.id,
    revision: failed.revision,
    generation: failed.execution!.generation,
    planSha256: failed.planSha256,
  };
  const migration = await f.service().prepare({
    id: randomUUID(),
    reason: "Reviewed migration before manual restoration",
    plan: { ...f.plan, recoveredFrom },
  });
  const approvedMigration = await f
    .service()
    .decide({ ...pickDecision(migration), decision: "approve" }, ownerPassword);
  const restored = approvedMigration.plan.candidate;
  const candidate = {
    ...restored,
    sourceCommit: "f".repeat(40),
    artifactSha256: "f".repeat(64),
    directory: "/protected/reader-aware-replacement",
    entrypoint: { ...restored.entrypoint, path: "/protected/reader-aware-replacement/main.js" },
  };
  const plan: CoordinatorBootstrapPlan = {
    ...approvedMigration.plan,
    previous: restored,
    candidate,
    compatibleRecovery: candidate,
    expectedProcess: { ...f.plan.expectedProcess, pid: 456 },
    supervisionRecovery: {
      canceledRequest: pickDecision(approvedMigration),
      terminateFrozen: "SIGKILL",
    },
  };
  return { ...f, failed, approvedMigration, plan };
}

function reserveSupervisionFixture(
  f: ReturnType<typeof fixture>,
  request: CoordinatorBootstrapRequest,
) {
  return f.journal.reserveSupervisionLaunch({
    request,
    setup: { path: path.join(f.root, "setup.json"), sha256: "a".repeat(64) },
    parent: {
      ...f.plan.expectedProcess,
      bootId: randomUUID(),
      startIdentity: "1000:1",
      parentPid: 1,
      uid: process.getuid!(),
      executable: process.execPath,
    },
    assertCurrent: () => undefined,
  });
}

test("supervision recovery waits for recorded cancellation and preserves both migration histories", async () => {
  const f = await supervisionRecoveryFixture();
  const before = f.journal.read();
  await expect(
    f.service().prepare({ id: randomUUID(), reason: "Restore supervision", plan: f.plan }),
  ).rejects.toThrow("canceled migration changed");
  expect(f.journal.read()).toEqual(before);
  const canceled = await f
    .service()
    .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
  f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
  const pending = await f
    .service()
    .prepare({ id: randomUUID(), reason: "Restore supervision", plan: f.plan });
  expect(pending.status).toBe("pending");
  expect(pending.execution).toBeUndefined();
  expect(f.service().list()).toEqual([f.failed, canceled, pending]);
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  await expect(f.service().claimDispatch(pickDecision(approved))).rejects.toThrow(
    "reserve its exact native launch",
  );
  const claimed = await f
    .service()
    .claimDispatch(pickDecision(reserveSupervisionFixture(f, approved)));
  f.journal.promote(claimed);
  const started = {
    ...claimed,
    execution: { ...claimed.execution!, stage: "start_pending" as const },
  };
  const afterPromotion = f.journal.read();
  f.journal.replace(
    afterPromotion,
    afterPromotion.map((record) => (record.id === claimed.id ? started : record)),
  );
  const identity = {
    installationId: f.plan.installationId,
    stateDirectory: f.root,
    node: f.plan.candidate.node.path,
    entrypoint: f.plan.candidate.entrypoint.path,
    configuration: f.plan.candidate.configuration.path,
  };
  const fence = loadCoordinatorStartupFence(identity);
  expect(fence?.generation).toBe(started.execution.generation);
  expect(fence?.released()).toBe(false);
  const pendingPath = path.join(f.root, "coordinator-bootstrap-pending.json");
  const pendingBytes = readFileSync(pendingPath);
  const futurePending = JSON.parse(pendingBytes.toString("utf8"));
  futurePending.requests.push({
    ...canceled,
    id: randomUUID(),
    plan: { ...canceled.plan, futureMaintenanceField: true },
  });
  writeFileSync(pendingPath, JSON.stringify(futurePending), { mode: 0o600 });
  expect(loadCoordinatorStartupFence(identity)?.generation).toBe(started.execution.generation);
  const required = futurePending.requests.find(
    (record: { id: string }) => record.id === canceled.id,
  );
  required.plan.futureMaintenanceField = true;
  writeFileSync(pendingPath, JSON.stringify(futurePending), { mode: 0o600 });
  const invalidBytes = readFileSync(pendingPath);
  expect(() => loadCoordinatorStartupFence(identity)).toThrow("futureMaintenanceField");
  expect(readFileSync(pendingPath)).toEqual(invalidBytes);
  writeFileSync(pendingPath, pendingBytes, { mode: 0o600 });
  const finished = {
    ...started,
    execution: { ...started.execution, stage: "succeeded" as const },
  };
  const beforeCompletion = f.journal.read();
  f.journal.replace(
    beforeCompletion,
    beforeCompletion.map((record) => (record.id === started.id ? finished : record)),
  );
  expect(fence?.released()).toBe(true);
  expect(loadCoordinatorStartupFence(identity)).toBeUndefined();
  expect(f.service().list()).toEqual([finished, f.failed, canceled]);
  expect(openBootstrapRequests(f.service().list())).toEqual([]);
});

test("supervision launch is reserved once under shared exclusion and survives lost replies", async () => {
  const f = await supervisionRecoveryFixture();
  const canceled = await f
    .service()
    .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
  f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
  const pending = await f.service().prepare({
    id: randomUUID(),
    reason: "Restore supervision",
    plan: f.plan,
  });
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const parent = {
    ...f.plan.expectedProcess,
    bootId: randomUUID(),
    startIdentity: "1000:1",
    parentPid: 1,
    uid: process.getuid!(),
    executable: f.plan.previous.node.path,
  };
  const setup = { path: path.join(f.root, "supervision-setup.json"), sha256: "a".repeat(64) };
  const assertCurrent = vi.fn(() => {
    expect(() => new FileBootstrapRequestJournal(f.root).writeLifecycle([])).toThrow(
      "storage is busy",
    );
  });
  const reserved = f.journal.reserveSupervisionLaunch({
    request: approved,
    setup,
    parent,
    assertCurrent,
  });
  expect(assertCurrent).toHaveBeenCalledOnce();
  expect(reserved.supervisionDispatch).toEqual({
    approvedRevision: approved.revision,
    requestedAt: expect.any(String),
    setup,
    parent,
  });
  expect(reserved.revision).not.toBe(approved.revision);
  expect(reserved.execution).toBeUndefined();
  const reopened = new FileBootstrapRequestJournal(f.root);
  expect(reopened.read()).toEqual([f.failed, canceled, reserved]);
  expect(() =>
    reopened.reserveSupervisionLaunch({ request: approved, setup, parent, assertCurrent }),
  ).toThrow("unreserved");
  expect(() =>
    reopened.reserveSupervisionLaunch({ request: reserved, setup, parent, assertCurrent }),
  ).toThrow("unreserved");
  expect(assertCurrent).toHaveBeenCalledOnce();
  const before = reopened.read();
  expect(() =>
    reopened.replace(
      before,
      before.filter((record) => record.id !== reserved.id),
    ),
  ).toThrow("history cannot change");
  expect(() =>
    reopened.replace(
      before,
      before.map((record) =>
        record.id === reserved.id
          ? {
              ...record,
              supervisionDispatch: {
                ...reserved.supervisionDispatch!,
                setup: { ...setup, sha256: "b".repeat(64) },
              },
            }
          : record,
      ),
    ),
  ).toThrow("reservation cannot change");
  expect(reopened.read()).toEqual(before);
  const ownerCanceled = await f
    .service()
    .decide({ ...pickDecision(reserved), decision: "cancel" }, ownerPassword);
  expect(ownerCanceled.status).toBe("canceled");
  expect(ownerCanceled.supervisionDispatch).toEqual(reserved.supervisionDispatch);
  await expect(f.service().claimDispatch(pickDecision(reserved))).rejects.toThrow("undispatched");
  expect(reopened.read()).toEqual([f.failed, canceled, ownerCanceled]);
});

test("supervision launch refuses asynchronous or changed custody without persisting authority", async () => {
  const f = await supervisionRecoveryFixture();
  const canceled = await f
    .service()
    .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
  f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
  const pending = await f
    .service()
    .prepare({ id: randomUUID(), reason: "Restore supervision", plan: f.plan });
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const setup = { path: path.join(f.root, "setup.json"), sha256: "a".repeat(64) };
  const parent = {
    ...f.plan.expectedProcess,
    bootId: randomUUID(),
    startIdentity: "1000:1",
    parentPid: 1,
    uid: process.getuid!(),
    executable: f.plan.previous.node.path,
  };
  const before = f.journal.read();
  expect(() =>
    f.journal.reserveSupervisionLaunch({
      request: f.approvedMigration,
      setup,
      parent,
      assertCurrent: () => undefined,
    }),
  ).toThrow("unreserved");
  expect(() =>
    f.journal.reserveSupervisionLaunch({
      request: approved,
      setup,
      parent,
      assertCurrent: async () => undefined,
    }),
  ).toThrow("synchronous");
  expect(() =>
    f.journal.reserveSupervisionLaunch({
      request: approved,
      setup,
      parent,
      assertCurrent: () => {
        throw new Error("Custody changed");
      },
    }),
  ).toThrow("Custody changed");
  expect(() =>
    f.journal.reserveSupervisionLaunch({
      request: approved,
      setup,
      parent,
      assertCurrent: async () => {
        throw new Error("Late custody failure");
      },
    }),
  ).toThrow("synchronous");
  const forged = CoordinatorBootstrapRequestSchema.parse({
    ...approved,
    supervisionDispatch: {
      approvedRevision: approved.revision,
      requestedAt: new Date().toISOString(),
      setup,
      parent,
    },
  });
  expect(() =>
    f.journal.replace(
      before,
      before.map((record) => (record.id === approved.id ? forged : record)),
    ),
  ).toThrow("locked native custody");
  expect(f.journal.read()).toEqual(before);
});

test.each(["success", "changed-generation", "deadline", "private-error"])(
  "supervision production control binds one native generation: %s",
  async (scenario) => {
    const f = await supervisionRecoveryFixture();
    const canceled = await f
      .service()
      .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
    f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
    const pending = await f
      .service()
      .prepare({ id: randomUUID(), reason: "Restore supervision", plan: f.plan });
    const approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
    const reserved = f.journal.reserveSupervisionLaunch({
      request: approved,
      setup: { path: path.join(f.root, "setup.json"), sha256: "a".repeat(64) },
      parent: {
        ...f.plan.expectedProcess,
        bootId: randomUUID(),
        startIdentity: "1000:1",
        parentPid: 1,
        uid: process.getuid!(),
        executable: process.execPath,
      },
      assertCurrent: () => undefined,
    });
    const claimed = await f.service().claimDispatch(pickDecision(reserved));
    f.journal.promote(claimed);
    const request = f
      .service()
      .advanceDispatch(
        { ...pickDecision(claimed), generation: claimed.execution!.generation },
        "freeze_pending",
      );
    const ownerLauncher = {
      path: path.join(f.root, "owner.py"),
      sha256: createHash("sha256").update("pass").digest("hex"),
    };
    writeFileSync(ownerLauncher.path, "pass", { mode: 0o600 });
    const host = {
      daemonId: "host-id",
      configurationFile: "/protected/actual-config.json",
      launcherFile: "/protected/selected.plist",
      docker: "/protected/docker",
      socket: "/protected/docker.sock",
      containerId: "a".repeat(64),
      helperPath: "/protected/inspector.py",
      helperSha256: "b".repeat(64),
    };
    const mounts = vi
      .spyOn(bootstrapHost, "inspectBootstrapWritableMountRoots")
      .mockResolvedValue([]);
    const lateArtifact =
      scenario === "deadline"
        ? vi
            .spyOn(bootstrapArtifact, "readBootstrapPreparedFile")
            .mockResolvedValue(Buffer.from("pass"))
        : undefined;
    const spawn = vi.spyOn(nativeChildProcess, "spawn").mockImplementation(() => {
      const child = new nativeChildProcess.ChildProcess();
      const stderr = new PassThrough();
      Object.defineProperty(child, "stderr", { value: stderr });
      queueMicrotask(() => {
        if (scenario === "private-error") stderr.write("private diagnostic must not escape");
        child.emit("close", scenario === "private-error" ? 1 : 0);
      });
      return child;
    });
    syncBuiltinESMExports();
    let release = () => {};
    const pendingOwnership = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requireOwnership = vi.fn(() =>
      scenario === "deadline" ? pendingOwnership : Promise.resolve(),
    );
    const control = createBootstrapSupervisionControl({
      requests: f.service(),
      host,
      ownerLauncher,
      descriptor: 7,
      requireOwnership,
    });
    try {
      if (scenario === "deadline") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const result = expect(control.signal(request, "freeze")).rejects.toThrow(
          "deadline elapsed",
        );
        await vi.advanceTimersByTimeAsync(25_000);
        await result;
        release();
        // Fake wall time is irrelevant to the monotonic fence. Late validation
        // must be rejected even after the outer deadline has returned.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(spawn).not.toHaveBeenCalled();
      } else if (scenario === "changed-generation") {
        f.service().advanceDispatch(
          { ...pickDecision(request), generation: request.execution!.generation },
          "recovery_required",
        );
        await expect(control.signal(request, "freeze")).rejects.toThrow("generation changed");
        expect(spawn).not.toHaveBeenCalled();
      } else if (scenario === "private-error") {
        await expect(control.signal(request, "freeze")).rejects.toThrow(
          "reconciliation: verification_failed",
        );
        expect(spawn).toHaveBeenCalledOnce();
      } else {
        await control.signal(request, "freeze");
        expect(spawn).toHaveBeenCalledOnce();
        const [executable, args, options] = spawn.mock.calls[0]!;
        expect(executable).toBe("/usr/bin/python3");
        expect(args).toEqual([
          "-I",
          "-B",
          "-c",
          "pass",
          "supervision-effect",
          f.root,
          request.id,
          request.revision,
          request.execution!.generation,
          request.planSha256,
          "freeze",
          host.helperPath,
          host.helperSha256,
          host.configurationFile,
          host.launcherFile,
          expect.any(String),
        ]);
        expect(options).toEqual({
          env: { PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "ignore", "pipe", 7],
          timeout: expect.any(Number),
          killSignal: "SIGKILL",
        });
      }
      expect(requireOwnership).toHaveBeenCalledOnce();
      expect(
        f.journal.read().find((record) => record.id === request.id)?.supervisionDispatch,
      ).toEqual(reserved.supervisionDispatch);
    } finally {
      release();
      vi.useRealTimers();
      spawn.mockRestore();
      mounts.mockRestore();
      lateArtifact?.mockRestore();
      syncBuiltinESMExports();
    }
  },
);

test.each(["ready", "parent-changed", "wrong-module", "setup-mutated", "claimed-reopen"])(
  "protected supervision runner verifies its retained launch: %s",
  async (scenario) => {
    const artifacts = fixture();
    const configurationFile = path.join(artifacts.root, "actual-config.json");
    writeFileSync(configurationFile, "{}", { mode: 0o600 });
    const configuration = {
      path: configurationFile,
      sha256: createHash("sha256").update("{}").digest("hex"),
    };
    const f = await supervisionRecoveryFixture({
      restored: { ...artifacts.plan.candidate, configuration },
    });
    const canceled = await f
      .service()
      .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
    f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
    const bootId = randomUUID();
    f.plan.expectedProcess = { ...f.plan.expectedProcess, bootId, startIdentity: "1000:1" };
    const setupFile = path.join(f.root, "setup.json");
    const pending = await f
      .service()
      .prepare({ id: randomUUID(), reason: "Supervision runner fixture", plan: f.plan });
    const approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
    const pinned = { path: "/protected/file", sha256: "a".repeat(64) };
    const setup = BootstrapRunnerSetupSchema.parse({
      admissionSetupFile: "/protected/admission.json",
      daemonId: "host-id",
      node: { ...pinned, path: process.execPath },
      entrypoint: { ...pinned, path: "/protected/runner.js" },
      ownerLauncher: pinned,
      ownershipVerifier: pinned,
      runtimeDirectory: "/protected/runtime",
      runtimeSha256: "b".repeat(64),
      supervision: { requestId: approved.id, configuration },
    });
    const setupBytes = JSON.stringify(setup);
    writeFileSync(setupFile, setupBytes, { mode: 0o600 });
    const parent = {
      pid: process.pid + 1,
      parentPid: 1,
      uid: process.getuid!(),
      bootId,
      startIdentity: "1000:2",
      argumentsSha256: "c".repeat(64),
      executable: process.execPath,
    };
    const reserved = f.journal.reserveSupervisionLaunch({
      request: approved,
      setup: { path: setupFile, sha256: createHash("sha256").update(setupBytes).digest("hex") },
      parent,
      assertCurrent: () => undefined,
    });
    let request = structuredClone(reserved);
    let role: "executor" | "watchdog" = "executor";
    let identifier = request.id;
    if (scenario === "claimed-reopen") {
      const claimed = await f.service().claimDispatch(pickDecision(reserved));
      request = f
        .service()
        .advanceDispatch(
          { ...pickDecision(claimed), generation: claimed.execution!.generation },
          "recovery_required",
        );
      role = "watchdog";
      identifier = request.execution!.generation;
    }
    const args = [setup.node.path, setup.entrypoint.path, setupFile, role, identifier];
    const own = {
      ...parent,
      pid: process.pid,
      parentPid: parent.pid,
      startIdentity: "1000:3",
      argumentsSha256: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    };
    const inspectProcess = vi.fn(async (pid: number) => {
      if (pid === process.pid)
        return scenario === "wrong-module" ? { ...own, argumentsSha256: "e".repeat(64) } : own;
      if (scenario === "claimed-reopen") throw new Error("Review process no longer exists");
      return scenario === "parent-changed" ? { ...parent, startIdentity: "999:1" } : parent;
    });
    if (scenario === "setup-mutated") writeFileSync(setupFile, setupBytes + " ", { mode: 0o600 });
    const input = {
      setup,
      setupFile,
      request,
      role,
      reader: { inspectProcess },
      writableMountRoots: [],
    };
    const before = f.journal.read();
    if (scenario === "ready" || scenario === "claimed-reopen")
      await expect(verifyBootstrapSupervisionRunner(input)).resolves.toBeUndefined();
    else await expect(verifyBootstrapSupervisionRunner(input)).rejects.toThrow();
    if (scenario === "claimed-reopen") expect(inspectProcess).toHaveBeenCalledTimes(1);
    expect(f.journal.read()).toEqual(before);
  },
);

function preparationFixtureChild(scenario: string) {
  const child = new nativeChildProcess.ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.defineProperty(child, "stdin", { value: stdin });
  Object.defineProperty(child, "stdout", { value: stdout });
  stdin.once("data", (bytes: Buffer) => {
    const digest = createHash("sha256").update(bytes).digest("hex");
    queueMicrotask(() => {
      stdout.write(`verified:${scenario === "wrong-ack" ? "wrong" : digest}\n`);
      child.emit(
        "close",
        scenario === "timeout" ? null : 0,
        scenario === "timeout" ? "SIGKILL" : null,
      );
    });
  });
  return child;
}

test.each(["exact-ack", "wrong-ack", "timeout"])(
  "isolated supervision preparation requires its own input receipt: %s",
  async (scenario) => {
    const f = fixture();
    const host = {
      daemonId: "host-id",
      configurationFile: "/protected/config",
      launcherFile: "/protected/plist",
      docker: "/protected/docker",
      socket: "/protected/socket",
      containerId: "a".repeat(64),
      helperPath: "/protected/inspector",
      helperSha256: "b".repeat(64),
    };
    const spawn = vi
      .spyOn(nativeChildProcess, "spawn")
      .mockImplementation(() => preparationFixtureChild(scenario));
    syncBuiltinESMExports();
    try {
      const result = bootstrapHost.verifyBootstrapPlanInChild({
        plan: f.plan,
        host,
        node: "/protected/node",
      });
      if (scenario === "exact-ack") await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow("did not complete");
      expect(spawn).toHaveBeenCalledOnce();
      const [node, args, options] = spawn.mock.calls[0]!;
      expect(node).toBe("/protected/node");
      expect(args?.slice(0, 2)).toEqual(["--input-type=module", "--eval"]);
      expect(options?.stdio).toEqual(["pipe", "pipe", "ignore"]);
      expect(options?.timeout).toBe(120_000);
      expect(options?.killSignal).toBe("SIGKILL");
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
    }
  },
);

test.each(["approval", "lost-dispatch-reply", "cancellation-race"])(
  "supervision review dispatches only its recorded owner decision: %s",
  async (scenario) => {
    const f = await supervisionRecoveryFixture();
    const canceled = await f
      .service()
      .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
    f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
    const pending = await f
      .service()
      .prepare({ id: randomUUID(), reason: "Review fixture", plan: f.plan });
    const dispatch = vi.fn(async (approved: CoordinatorBootstrapRequest) => {
      expect(f.journal.read().find((request) => request.id === approved.id)).toEqual(approved);
      if (scenario === "lost-dispatch-reply") {
        reserveSupervisionFixture(f, approved);
        throw new Error("Reply lost after reservation");
      }
    });
    const client = supervisionReviewClient({
      requests: f.service(),
      binding: pickDecision(pending),
      dispatch,
    });
    const approve = { ...pickDecision(pending), decision: "approve" as const };
    await expect(client.decideCoordinatorBootstrap(approve, "wrong-password")).rejects.toThrow(
      "authentication required",
    );
    expect(dispatch).not.toHaveBeenCalled();
    if (scenario === "cancellation-race") {
      let release = () => {};
      let entered = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const validating = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.setVerify(async () => {
        entered();
        await gate;
      });
      const result = client.decideCoordinatorBootstrap(approve, ownerPassword);
      const refused = expect(result).rejects.toThrow("request changed");
      await validating;
      await client.decideCoordinatorBootstrap(
        { ...pickDecision(pending), decision: "cancel" },
        ownerPassword,
      );
      release();
      await refused;
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.journal.read().find((request) => request.id === pending.id)?.status).toBe(
        "canceled",
      );
    } else if (scenario === "lost-dispatch-reply") {
      await expect(client.decideCoordinatorBootstrap(approve, ownerPassword)).rejects.toThrow(
        "Reply lost",
      );
      const reopened = new FileBootstrapRequestJournal(f.root)
        .read()
        .find((request) => request.id === pending.id)!;
      expect(reopened.status).toBe("approved");
      expect(reopened.supervisionDispatch?.approvedRevision).toBe(
        dispatch.mock.calls[0]![0].revision,
      );
      await expect(
        client.decideCoordinatorBootstrap(
          { ...pickDecision(reopened), decision: "approve" },
          ownerPassword,
        ),
      ).rejects.toThrow("already been decided");
      expect(dispatch).toHaveBeenCalledOnce();
    } else {
      await client.decideCoordinatorBootstrap(approve, ownerPassword);
      const approved = dispatch.mock.calls[0]![0];
      expect(approved.status).toBe("approved");
      expect(approved.revision).not.toBe(pending.revision);
      await expect(client.decideCoordinatorBootstrap(approve, ownerPassword)).rejects.toThrow(
        "request changed",
      );
      expect(dispatch).toHaveBeenCalledOnce();
    }
  },
);

test("short supervision acknowledgement deadline observes without killing or retrying", async () => {
  const child = new nativeChildProcess.ChildProcess();
  const stdout = new PassThrough();
  Object.defineProperty(child, "stdout", { value: stdout });
  const kill = vi.spyOn(child, "kill");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { waitForBootstrapWatchdog } = await import("./coordinator-bootstrap-runner.js");
    const refused = expect(
      waitForBootstrapWatchdog(child, { role: "executor", timeoutMs: 25_000 }),
    ).rejects.toThrow("did not become ready");
    await vi.advanceTimersByTimeAsync(25_000);
    await refused;
    expect(kill).not.toHaveBeenCalled();
    expect(stdout.listenerCount("data")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  } finally {
    vi.useRealTimers();
    kill.mockRestore();
  }
});

test("supervision helper authority stays inside the reviewed runtime", () => {
  const file = { path: "/reviewed/scripts/helper.py", sha256: "a".repeat(64) };
  const setup = BootstrapRunnerSetupSchema.parse({
    admissionSetupFile: "/protected/admission.json",
    daemonId: "host-id",
    node: file,
    entrypoint: file,
    ownerLauncher: file,
    ownershipVerifier: file,
    runtimeDirectory: "/reviewed",
    runtimeSha256: "b".repeat(64),
    supervision: { requestId: randomUUID(), configuration: file },
  });
  expect(() => assertSupervisionHelpers(setup)).not.toThrow();
  expect(() =>
    assertSupervisionHelpers({
      ...setup,
      ownerLauncher: { ...file, path: "/unreviewed/helper.py" },
    }),
  ).toThrow("outside the reviewed runtime");
  expect(() =>
    assertSupervisionHelpers({ ...setup, entrypoint: { ...file, path: "/unreviewed/runner.js" } }),
  ).toThrow("outside the reviewed runtime");
  expect(() =>
    assertSupervisionHelpers({
      ...setup,
      ownershipVerifier: { ...file, path: "/reviewed-other/helper.py" },
    }),
  ).toThrow("outside the reviewed runtime");
});

test("ordinary native dispatch refuses supervision recovery before ownership or effects", async () => {
  const f = await supervisionRecoveryFixture();
  const canceled = await f
    .service()
    .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
  f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
  const pending = await f
    .service()
    .prepare({ id: randomUUID(), reason: "Restore supervision", plan: f.plan });
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const verifySetup = vi.fn(async () => {});
  const armWatchdog = vi.fn(async () => {});
  const before = f.journal.read();
  await expect(
    createBootstrapNativeOperations({
      requests: f.service(),
      approved,
      host: {
        daemonId: "fixture-host",
        configurationFile: "/protected/config.json",
        launcherFile: "/protected/launcher.plist",
        docker: "/protected/docker",
        socket: "/protected/docker.sock",
        containerId: "a".repeat(64),
        helperPath: "/protected/inspector.py",
        helperSha256: "a".repeat(64),
      },
      descriptor: 3,
      lockFile: path.join(f.root, "coordinator-bootstrap-execution.lock"),
      ownershipVerifier: { path: "/protected/verifier.py", sha256: "a".repeat(64) },
      verifySetup,
      armWatchdog,
    }),
  ).rejects.toThrow("exact unregistered-process executor");
  expect(verifySetup).not.toHaveBeenCalled();
  expect(armWatchdog).not.toHaveBeenCalled();
  expect(f.journal.read()).toEqual(before);
});

test("supervision recovery can bind a separate compatible fallback source", async () => {
  const f = await supervisionRecoveryFixture();
  const canceled = await f
    .service()
    .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
  f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
  f.plan.compatibleRecovery = {
    ...f.plan.candidate,
    sourceCommit: "7".repeat(40),
    artifactSha256: "7".repeat(64),
    directory: "/protected/reader-aware-fallback",
    entrypoint: {
      ...f.plan.candidate.entrypoint,
      path: "/protected/reader-aware-fallback/main.js",
    },
  };
  const pending = await f.service().prepare({
    id: randomUUID(),
    reason: "Restore supervision with an independent compatible fallback",
    plan: f.plan,
  });
  expect(pending.status).toBe("pending");
  expect(pending.automaticSubmission).toBeUndefined();
  expect(pending.automaticApproval).toBeUndefined();
  expect(pending.plan.compatibleRecovery).toEqual(f.plan.compatibleRecovery);
  expect(f.service().list()).toEqual([f.failed, canceled, pending]);
});

test.runIf(process.platform === "darwin")(
  "tracked supervision freezes and retires only its admitted manual process without service-label commands",
  async () => {
    const f = await supervisionRecoveryFixture();
    const canceled = await f
      .service()
      .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
    f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
    f.plan.state.restartJournal = path.join(f.root, "restart-jobs.json");
    f.plan.state.ownerSessions = path.join(f.root, "owner-sessions.json");
    const configurationFile = "/protected/current-config.json";
    f.plan.expectedProcess.bootId = randomUUID();
    f.plan.expectedProcess.startIdentity = "1234:5678";
    f.plan.expectedProcess.argumentsSha256 = createHash("sha256")
      .update(
        JSON.stringify([
          f.plan.previous.node.path,
          f.plan.previous.entrypoint.path,
          configurationFile,
        ]),
      )
      .digest("hex");
    const pending = await f
      .service()
      .prepare({ id: randomUUID(), reason: "Restore supervision", plan: f.plan });
    const approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
    let current = await f
      .service()
      .claimDispatch(pickDecision(reserveSupervisionFixture(f, approved)));
    f.journal.promote(current);
    const advance = (stage: CoordinatorBootstrapStage) => {
      current = f
        .service()
        .advanceDispatch(
          { ...pickDecision(current), generation: current.execution!.generation },
          stage,
        );
    };
    const processIdentity = {
      ...f.plan.expectedProcess,
      uid: process.getuid!(),
      parentPid: 1,
      executable: f.plan.previous.node.path,
    };
    let alive = true;
    let stopped = false;
    const effects: string[] = [];
    const assertAlive = () => {
      if (!alive) throw new Error("Reviewed process exited");
    };
    const assertAbsent = async () => {};
    const run = vi.fn(async () => {});
    const native = createBootstrapNativeLifecycle(
      {
        requests: f.service(),
        configurationFile,
        launcherFile: "/protected/current.plist",
        writableMountRoots: async () => [],
        requireOwnership: async () => {},
        readHealth: async () => {
          throw new Error("No replacement in this fixture");
        },
        reader: {
          readService: async () => {
            throw new Error("Service absent");
          },
          verifyServiceAbsent: assertAbsent,
          inspectProcess: async () => {
            assertAlive();
            return processIdentity;
          },
          inspectAuditedProcess: async () => {
            throw new Error("Signal port owns audited proof");
          },
          inspectRunningProcess: async () => {
            assertAlive();
            if (stopped) throw new Error("Process stopped");
            return { ...processIdentity, stopped: false };
          },
          inspectStoppedProcess: async () => {
            assertAlive();
            if (!stopped) throw new Error("Process running");
            return { ...processIdentity, stopped: true, childPids: [] };
          },
          verifyProcessExited: async () => {
            if (alive) throw new Error("Process alive");
          },
        },
        manualPrevious: {
          signal: async (request, effect) => {
            expect(request).toEqual(current);
            expect(
              f
                .service()
                .list()
                .find((record) => record.id === current.id),
            ).toEqual(current);
            effects.push(effect);
            if (effect === "freeze") stopped = true;
            else {
              expect(stopped).toBe(true);
              alive = false;
            }
          },
        },
      },
      { run },
    );
    advance("freeze_pending");
    await native.freeze(current);
    expect(await native.inspectFrozen(current)).toEqual({ restartJournal: [], childPids: [] });
    advance("frozen");
    await native.preserveTransfer(current);
    advance("unload_pending");
    await native.unload(current);
    expect(effects).toEqual(["freeze", "terminate-frozen"]);
    expect(alive).toBe(false);
    expect(run).not.toHaveBeenCalled();
    await expect(native.unload(current)).rejects.toThrow("Reviewed process exited");
    expect(effects).toEqual(["freeze", "terminate-frozen"]);
    expect(
      f
        .service()
        .list()
        .find((record) => record.id === f.failed.id),
    ).toEqual(f.failed);
    expect(
      f
        .service()
        .list()
        .find((record) => record.id === canceled.id),
    ).toEqual(canceled);
  },
);

test
  .runIf(process.platform === "darwin")
  .each([
    "before-first-freeze",
    "consumed-freeze",
    "reboot-pid-reused",
    "wrong-boot",
    "missing-boot-plan",
    "same-boot-recovery",
    "same-boot-pid-reused",
  ])("manual supervision rollback preserves exact lifetime boundaries: %s", async (scenario) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "supervision-rollback-")));
  roots.push(root);
  const file = (name: string, bytes: string, mode = 0o600) => {
    const destination = path.join(root, name);
    writeFileSync(destination, bytes, { mode });
    return { path: destination, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const node = file("node", "fixture executable", 0o700);
  const configuration = file("configuration.json", "{}");
  const release = async (name: string, sourceCommit: string) => {
    const directory = path.join(root, name);
    mkdirSync(directory, { mode: 0o700 });
    const entrypoint = file(name + "/main.js", "fixture " + name);
    file(name + "/.installation-source.json", JSON.stringify({ sourceCommit }));
    return {
      directory,
      sourceCommit,
      node,
      configuration,
      entrypoint,
      launcher: file(name + ".plist", "fixture launcher " + name),
      artifactSha256: await digestBootstrapArtifact(directory),
    };
  };
  const previous = await release("previous", "e".repeat(40));
  const candidate = await release("candidate", "f".repeat(40));
  const selected = file("selected.plist", readFileSync(previous.launcher.path, "utf8"));
  const f = await supervisionRecoveryFixture({ restored: previous });
  const canceled = await f
    .service()
    .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
  f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
  f.plan.candidate = candidate;
  f.plan.compatibleRecovery = candidate;
  f.plan.expectedProcess = {
    pid: 456,
    bootId: randomUUID(),
    startIdentity: "1000:1",
    argumentsSha256: createHash("sha256")
      .update(JSON.stringify([node.path, previous.entrypoint.path, configuration.path]))
      .digest("hex"),
  };
  const id = randomUUID();
  const rebooted = scenario.includes("boot") && scenario !== "same-boot-pid-reused";
  const currentBoot =
    rebooted && scenario !== "same-boot-recovery" ? randomUUID() : f.plan.expectedProcess.bootId;
  if (rebooted && scenario !== "missing-boot-plan")
    f.plan.bootRecovery = {
      requestId: id,
      service: `gui/${process.getuid!()}/local.vorteo.${f.plan.installationId}.installation-recovery-${id}`,
      launcher: selected,
      installedLauncher: path.join(root, "recovery.plist"),
      setup: configuration,
      ownerLauncher: selected,
      node,
      entrypoint: candidate.entrypoint,
    };
  const pending = await f.service().prepare({ id, reason: "Fixture rollback", plan: f.plan });
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  let current = await f
    .service()
    .claimDispatch(pickDecision(reserveSupervisionFixture(f, approved)));
  f.journal.promote(current);
  for (const stage of ["recovery_required", "rollback_pending"] as const)
    current = f
      .service()
      .advanceDispatch(
        { ...pickDecision(current), generation: current.execution!.generation },
        stage,
      );
  const original = {
    ...f.plan.expectedProcess,
    parentPid: 1,
    uid: process.getuid!(),
    executable: node.path,
  };
  let alive = true;
  let stopped = false;
  let loaded = false;
  const effects: string[] = [];
  const processReads: number[] = [];
  const native = createBootstrapNativeLifecycle(
    {
      requests: f.service(),
      configurationFile: configuration.path,
      launcherFile: selected.path,
      recoveryBootId: rebooted ? currentBoot : undefined,
      writableMountRoots: async () => [],
      requireOwnership: async () => {},
      readHealth: async () => ({ installationId: f.plan.installationId }),
      reader: {
        readService: async () => {
          if (!loaded) throw new Error("Absent");
          return `${f.plan.service} = {\n\tpid = 789\n}`;
        },
        verifyServiceAbsent: async () => {
          if (loaded) throw new Error("Loaded");
        },
        verifyProcessExited: async (pid) => {
          processReads.push(pid);
          if (alive) throw new Error("PID still exists");
        },
        inspectProcess: async (pid) => {
          processReads.push(pid);
          if (pid === process.pid)
            return {
              ...original,
              pid,
              bootId: scenario === "wrong-boot" ? randomUUID() : currentBoot,
            };
          if (pid === 789)
            return {
              ...original,
              pid,
              bootId: currentBoot,
              startIdentity: "1000:2",
              argumentsSha256: createHash("sha256")
                .update(JSON.stringify([node.path, candidate.entrypoint.path, configuration.path]))
                .digest("hex"),
            };
          return scenario === "same-boot-pid-reused"
            ? { ...original, startIdentity: "9999:1" }
            : original;
        },
        inspectAuditedProcess: async () => {
          throw new Error("Audited signal port owns proof");
        },
        inspectRunningProcess: async () => {
          if (stopped) throw new Error("Stopped");
          return { ...original, stopped: false };
        },
        inspectStoppedProcess: async () => {
          if (!stopped) throw new Error("Running");
          return { ...original, stopped: true, childPids: [] };
        },
      },
      manualPrevious: {
        signal: async (_request, effect) => {
          effects.push(effect);
          if (scenario === "consumed-freeze") throw new Error("Freeze intent already consumed");
          if (effect === "freeze") stopped = true;
          else {
            expect(stopped).toBe(true);
            alive = false;
          }
        },
      },
    },
    {
      run: async (args) => {
        expect(args[0]).toBe("bootstrap");
        effects.push("bootstrap");
        loaded = true;
      },
    },
  );
  const history = f.service().list();
  if (
    scenario === "consumed-freeze" ||
    scenario === "wrong-boot" ||
    scenario === "missing-boot-plan" ||
    scenario === "same-boot-recovery" ||
    scenario === "same-boot-pid-reused"
  ) {
    await expect(native.restorePrevious(current)).rejects.toThrow();
    expect(effects).toEqual(scenario === "consumed-freeze" ? ["freeze"] : []);
    expect(readFileSync(selected.path)).toEqual(readFileSync(previous.launcher.path));
  } else {
    await native.restorePrevious(current);
    expect(effects).toEqual(rebooted ? ["bootstrap"] : ["freeze", "terminate-frozen", "bootstrap"]);
    expect(readFileSync(selected.path)).toEqual(readFileSync(candidate.launcher.path));
    expect(
      JSON.parse(
        readFileSync(
          path.join(f.root, `coordinator-transfer-${current.execution!.generation}.json`),
          "utf8",
        ),
      ).requestId,
    ).toBe(current.id);
  }
  if (rebooted) expect(processReads).not.toContain(original.pid);
  expect(f.service().list()).toEqual(history);
});

test.runIf(process.platform === "darwin").each(["normal", "before-first-freeze"])(
  "audited supervision effects consume one generation and require preserved frozen state: %s",
  async (interruption) => {
    const execute = promisify(execFile);
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "supervision-effect-")));
    roots.push(root);
    const runtime = path.join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const entrypoint = path.join(runtime, "entry.mjs");
    writeFileSync(entrypoint, "setInterval(() => {}, 1000);", { mode: 0o600 });
    writeFileSync(
      path.join(runtime, ".installation-source.json"),
      JSON.stringify({ sourceCommit: "e".repeat(40) }),
      { mode: 0o600 },
    );
    const configuration = path.join(root, "configuration.json");
    writeFileSync(configuration, JSON.stringify({ fixture: true }), { mode: 0o600 });
    const launcher = path.join(root, "launcher.plist");
    writeFileSync(launcher, "protected fixture launcher", { mode: 0o600 });
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const identity = (file: string) => ({ path: file, sha256: hash(file) });
    const restored = {
      sourceCommit: "e".repeat(40),
      directory: runtime,
      artifactSha256: await digestBootstrapArtifact(runtime),
      node: identity(realpathSync(process.execPath)),
      entrypoint: identity(entrypoint),
      configuration: identity(configuration),
      launcher: identity(launcher),
    };
    const inspector = path.join(root, "inspector.py");
    writeFileSync(
      inspector,
      readFileSync(
        new URL("../../../../../scripts/inspect-coordinator-process.py", import.meta.url),
      ),
      { mode: 0o600 },
    );
    const reader = await createNativeBootstrapServiceReader({
      helperPath: inspector,
      helperSha256: hash(inspector),
      writableMountRoots: [],
    });
    const launcherSource = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,${JSON.stringify([entrypoint, configuration])},{detached:true,stdio:'ignore'});child.unref();console.log(child.pid);`;
    const spawned = await execute(process.execPath, ["-e", launcherSource], {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 5000,
    });
    const pid = Number(spawned.stdout.trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    const verifyExit = async () => {
      const deadline = performance.now() + 2000;
      for (;;) {
        try {
          await reader.verifyProcessExited(pid);
          return;
        } catch (error) {
          if (performance.now() >= deadline) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    let retained: Awaited<ReturnType<typeof reader.inspectAuditedProcess>> | undefined;
    let disposed = false;
    try {
      const observed = await reader.inspectAuditedProcess(pid);
      retained = observed;
      expect(observed.identity.parentPid).toBe(1);
      const f = await supervisionRecoveryFixture({ restored });
      const sessionBytes = Buffer.from(
        JSON.stringify(
          Array.from({ length: 15_000 }, (_, index) => ({
            hash: index.toString(16).padStart(64, "0"),
            expiresAt: 2_000_000_000_000,
          })),
        ),
      );
      expect(sessionBytes.length).toBeGreaterThan(1024 * 1024);
      writeFileSync(f.plan.state.ownerSessions, sessionBytes, { mode: 0o600 });
      const canceled = await f
        .service()
        .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
      f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
      const { pid: expectedPid, bootId, startIdentity, argumentsSha256 } = observed.identity;
      f.plan.expectedProcess = { pid: expectedPid, bootId, startIdentity, argumentsSha256 };
      const pending = await f
        .service()
        .prepare({ id: randomUUID(), reason: "Fixture exact supervision", plan: f.plan });
      const approved = await f
        .service()
        .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
      let current = await f
        .service()
        .claimDispatch(pickDecision(reserveSupervisionFixture(f, approved)));
      f.journal.promote(current);
      const advance = (stage: CoordinatorBootstrapStage) => {
        current = f
          .service()
          .advanceDispatch(
            { ...pickDecision(current), generation: current.execution!.generation },
            stage,
          );
      };
      if (interruption === "before-first-freeze") {
        advance("recovery_required");
        advance("rollback_pending");
      } else advance("freeze_pending");
      const lock = path.join(f.root, "coordinator-bootstrap-execution.lock");
      writeFileSync(lock, "", { mode: 0o600 });
      const owner = path.resolve(
        import.meta.dirname,
        "../../../../../scripts/run-coordinator-owner.py",
      );
      const wrapper = `import os,fcntl,subprocess,sys
lock=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW)
assert lock==3
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
result=subprocess.run([sys.executable,'-I','-B',sys.argv[2],'supervision-effect',*sys.argv[3:]],pass_fds=(3,),timeout=12,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
sys.stdout.buffer.write(result.stdout);sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
`;
      const effect = (
        kind: "freeze" | "terminate-frozen",
        generation = current.execution!.generation,
        deadline = Date.now() + 25_000,
      ) =>
        execute(
          "/usr/bin/python3",
          [
            "-I",
            "-B",
            "-c",
            wrapper,
            lock,
            owner,
            f.root,
            current.id,
            current.revision,
            generation,
            current.planSha256,
            kind,
            inspector,
            hash(inspector),
            configuration,
            launcher,
            String(deadline),
          ],
          { env: { PATH: "/usr/bin:/bin" }, timeout: 15_000, maxBuffer: 8192 },
        );
      await expect(effect("freeze", randomUUID())).rejects.toMatchObject({
        stderr: "supervision:approval_changed\n",
      });
      await expect(
        effect("freeze", current.execution!.generation, Date.now() - 1),
      ).rejects.toMatchObject({ stderr: "supervision:deadline_elapsed\n" });
      expect((await reader.inspectRunningProcess(pid)).stopped).toBe(false);
      await effect("freeze");
      expect(await reader.inspectStoppedProcess(pid)).toEqual({
        ...observed.identity,
        stopped: true,
        childPids: [],
      });
      await expect(effect("freeze")).rejects.toMatchObject({
        stderr: "supervision:effect_consumed\n",
      });
      expect((await reader.inspectStoppedProcess(pid)).stopped).toBe(true);
      if (interruption === "normal") {
        advance("frozen");
        advance("unload_pending");
      }
      await expect(effect("terminate-frozen")).rejects.toMatchObject({
        stderr: "supervision:transfer_unavailable\n",
      });
      expect((await reader.inspectStoppedProcess(pid)).stopped).toBe(true);
      if (interruption === "normal") {
        advance("recovery_required");
        advance("rollback_pending");
      }
      await preserveBootstrapState({ request: current, writableMountRoots: [], childPids: [] });
      writeFileSync(f.plan.state.ownerSessions, Buffer.concat([sessionBytes, Buffer.from("\n")]));
      await expect(effect("terminate-frozen")).rejects.toMatchObject({
        stderr: "supervision:state_changed\n",
      });
      expect((await reader.inspectStoppedProcess(pid)).stopped).toBe(true);
      writeFileSync(f.plan.state.ownerSessions, sessionBytes);
      await effect("terminate-frozen");
      await verifyExit();
      disposed = true;
      await expect(effect("terminate-frozen")).rejects.toThrow();
      const intent = JSON.parse(
        readFileSync(
          path.join(
            f.root,
            `coordinator-supervision-effect-${current.execution!.generation}-terminate-frozen.json`,
          ),
          "utf8",
        ),
      );
      expect(intent).toEqual({
        requestId: current.id,
        revision: current.revision,
        generation: current.execution!.generation,
        planSha256: current.planSha256,
        effect: "terminate-frozen",
        process: observed.identity,
        auditToken: observed.auditToken,
      });
      expect(readFileSync(f.plan.state.ownerSessions)).toEqual(sessionBytes);
      expect(
        f
          .service()
          .list()
          .find((record) => record.id === f.failed.id),
      ).toEqual(f.failed);
      expect(
        f
          .service()
          .list()
          .find((record) => record.id === canceled.id),
      ).toEqual(canceled);
    } finally {
      const observed = retained ?? (await reader.inspectAuditedProcess(pid));
      expect(observed.identity.pid).toBe(pid);
      expect(observed.identity.uid).toBe(process.getuid!());
      expect(observed.identity.executable).toBe(restored.node.path);
      expect(observed.identity.argumentsSha256).toBe(
        createHash("sha256")
          .update(JSON.stringify([restored.node.path, entrypoint, configuration]))
          .digest("hex"),
      );
      // Cleanup also uses the retained audit token, never a potentially reused PID.
      const cleanup = `import ctypes,json,sys
library=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
library.proc_signal_with_audittoken.argtypes=[ctypes.c_void_p,ctypes.c_int]
library.proc_signal_with_audittoken.restype=ctypes.c_int
token=(ctypes.c_uint32*8)(*json.loads(sys.argv[1]))
result=library.proc_signal_with_audittoken(ctypes.byref(token),9)
if result!=0 and ctypes.get_errno()!=3: raise RuntimeError('Fixture cleanup is unproven')
`;
      if (!disposed)
        await execute(
          "/usr/bin/python3",
          ["-I", "-B", "-c", cleanup, JSON.stringify(observed.auditToken)],
          { env: { PATH: "/usr/bin:/bin" }, timeout: 5000, maxBuffer: 8192 },
        );
      await verifyExit();
    }
  },
  30_000,
);

test.each([
  "stale-cancellation",
  "missing-cancellation",
  "wrong-restored-source",
  "wrong-rollback",
  "configuration-change",
  "missing-history",
])(
  "supervision recovery refuses substituted or unsupported handoff evidence: %s",
  async (change) => {
    const f = await supervisionRecoveryFixture();
    const canceled = await f
      .service()
      .decide({ ...pickDecision(f.approvedMigration), decision: "cancel" }, ownerPassword);
    f.plan.supervisionRecovery!.canceledRequest = pickDecision(canceled);
    switch (change) {
      case "stale-cancellation":
        f.plan.supervisionRecovery!.canceledRequest = pickDecision(f.approvedMigration);
        break;
      case "missing-cancellation":
        f.plan.supervisionRecovery!.canceledRequest.id = randomUUID();
        break;
      case "wrong-restored-source":
        f.plan.previous = { ...f.plan.previous, sourceCommit: "a".repeat(40) };
        break;
      case "wrong-rollback":
        f.plan.compatibleRecovery = f.plan.previous;
        break;
      case "configuration-change":
        f.plan.candidate = {
          ...f.plan.candidate,
          configuration: { ...f.plan.candidate.configuration, sha256: "c".repeat(64) },
        };
        f.plan.compatibleRecovery = f.plan.candidate;
        break;
      case "missing-history":
        delete f.plan.recoveredFrom;
        break;
    }
    const before = f.journal.read();
    await expect(
      f.service().prepare({ id: randomUUID(), reason: "Restore supervision", plan: f.plan }),
    ).rejects.toThrow();
    expect(f.journal.read()).toEqual(before);
  },
);

test("stopped candidate recovery verifies loaded arguments and refuses unrelated jobs", () => {
  const { plan } = fixture();
  const output = `${plan.service} = {\n\tprogram = ${plan.candidate.node.path}\n\targuments = {\n\t\t${plan.candidate.node.path}\n\t\t${plan.candidate.entrypoint.path}\n\t\t${plan.candidate.configuration.path}\n\t}\n}`;
  expect(isStoppedBootstrapCandidate(plan, output)).toBe(true);
  expect(isStoppedBootstrapCandidate(plan, output.replace("\n}", "\n\tpid = 456\n}"))).toBe(false);
  expect(() =>
    isStoppedBootstrapCandidate(
      plan,
      output.replace("\tprogram = /protected/file", "\tprogram = /other"),
    ),
  ).toThrow("Stopped coordinator");
  expect(() =>
    isStoppedBootstrapCandidate(plan, output.replace("\t\t/protected/file", "\t\t/other")),
  ).toThrow("Stopped coordinator");
  expect(() =>
    isStoppedBootstrapCandidate(plan, output.replace(plan.service, "gui/501/other")),
  ).toThrow("service identity");
});

test("concurrent exact approvals share verification and commit only once", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const service = f.service();
  let checks = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setVerify(async () => {
    checks++;
    await gate;
  });
  const input = {
    id: pending.id,
    revision: pending.revision,
    planSha256: pending.planSha256,
    decision: "approve" as const,
  };
  const attempts = [service.decide(input, ownerPassword), service.decide(input, ownerPassword)];
  const outcomes = Promise.allSettled(attempts);
  await expect.poll(() => checks).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(checks).toBe(1);
  release();
  const results = await outcomes;
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(service.list()[0]?.status).toBe("approved");
});

test("failed approval verification is never reused by a later attempt", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const service = f.service();
  let checks = 0;
  f.setVerify(async () => {
    checks++;
    if (checks === 1) throw new Error("fixture changed bytes");
  });
  const input = {
    id: pending.id,
    revision: pending.revision,
    planSha256: pending.planSha256,
    decision: "approve" as const,
  };
  await expect(service.decide(input, ownerPassword)).rejects.toThrow("fixture changed bytes");
  expect(service.list()[0]?.status).toBe("pending");
  await expect(service.decide(input, ownerPassword)).resolves.toMatchObject({ status: "approved" });
  expect(checks).toBe(2);
});

function pickDecision(request: CoordinatorBootstrapRequest) {
  return { id: request.id, revision: request.revision, planSha256: request.planSha256 };
}

test("reviewed claim fencing preserves approval and prevents stale promotion", async () => {
  const f = fixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const claimed = await f.service().claimDispatch(pickDecision(approved));
  const recovery = {
    id: randomUUID(),
    revision: randomUUID(),
    generation: randomUUID(),
    planSha256: "e".repeat(64),
  };
  const fenced = f.journal.fenceUnpromotedClaim(claimed, recovery);
  expect(fenced).toEqual({
    ...claimed,
    revision: fenced.revision,
    execution: {
      ...claimed.execution,
      stage: "recovery_required",
      updatedAt: fenced.execution?.updatedAt,
    },
  });
  expect(fenced.revision).not.toBe(claimed.revision);
  expect(f.journal.readPromoted()).toEqual([]);
  expect(() => f.journal.promote(claimed)).toThrow("Exact protected bootstrap claim");
  expect(f.journal.fenceUnpromotedClaim(claimed, recovery)).toEqual(fenced);
  const record = JSON.parse(
    readFileSync(path.join(f.root, `coordinator-claim-fence-${recovery.generation}.json`), "utf8"),
  );
  expect(record).toEqual({ version: 1, recovery, original: claimed, fenced });
  expect(() =>
    f.journal.fenceUnpromotedClaim(claimed, { ...recovery, revision: randomUUID() }),
  ).toThrow("recovery binding");
  expect(f.journal.read()).toEqual([fenced]);
});

async function claimFenceFixture() {
  const f = fixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const claimed = await f.service().claimDispatch(pickDecision(approved));
  const recovery = {
    id: randomUUID(),
    revision: randomUUID(),
    generation: randomUUID(),
    planSha256: "e".repeat(64),
  };
  return {
    ...f,
    claimed,
    recovery,
    evidence: path.join(f.root, `coordinator-claim-fence-${recovery.generation}.json`),
    pendingFile: path.join(f.root, "coordinator-bootstrap-pending.json"),
  };
}

test("bootstrap promotion refuses an installation already executing in the shared state", async () => {
  const f = await claimFenceFixture();
  const lifecycleFile = path.join(f.root, "restart-jobs.json");
  let attempts = 0;
  const queue = new InstallationRestarts(
    {
      read: () => [],
      write: (jobs) => writeFileSync(lifecycleFile, JSON.stringify(jobs), { mode: 0o600 }),
    },
    {
      restart: async () => {
        attempts++;
        expect(() => f.journal.promote(f.claimed)).toThrow("unresolved installation work");
        expect(f.journal.readPromoted()).toEqual([]);
        return "Disposable replacement verified";
      },
    },
  );
  const pending = queue.request({ target: "host", reason: "Disposable restart" }, "owner");
  queue.decide(pending.id, pending.revision, "approve");
  await queue.drain();
  expect(attempts).toBe(1);
  expect(queue.list()[0]?.status).toBe("succeeded");
  expect(f.journal.read()).toEqual([f.claimed]);
});

test("shared admission refuses new daemon work during a coordinator claim", async () => {
  const f = await claimFenceFixture();
  const effects: string[] = [];
  const queue = new InstallationRestarts(
    {
      read: () => f.journal.readLifecycle(),
      write: (jobs) => f.journal.writeLifecycle(jobs),
      admissionAvailable: () => f.journal.lifecycleAdmissionAvailable(),
    },
    {
      restart: async () => {
        effects.push("restart");
        return "ready";
      },
    },
  );
  const pending = queue.request({ target: "host", reason: "Disposable restart" }, "owner");
  expect(() => queue.decide(pending.id, pending.revision, "approve")).toThrow(
    "Coordinator recovery must finish",
  );
  await queue.drain();
  expect(effects).toEqual([]);
  expect(queue.list()[0]?.status).toBe("pending");
  queue.decide(pending.id, pending.revision, "reject");
  expect(queue.list()[0]?.status).toBe("rejected");
  expect(f.journal.read()).toEqual([f.claimed]);
});

test("shared admission refuses a coordinator claim until queued daemon work is canceled", async () => {
  const f = fixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const queue = new InstallationRestarts(
    {
      read: () => f.journal.readLifecycle(),
      write: (jobs) => f.journal.writeLifecycle(jobs),
      admissionAvailable: () => f.journal.lifecycleAdmissionAvailable(),
    },
    { restart: async () => "ready", restartWhenIdle: async () => "ready" },
  );
  const pending = queue.request({ target: "host", reason: "Disposable restart" }, "owner");
  const queued = queue.decide(pending.id, pending.revision, "approve-when-idle");
  const bootstrap = await f.prepare();
  const approved = await f
    .service()
    .decide({ ...pickDecision(bootstrap), decision: "approve" }, ownerPassword);
  await expect(f.service().claimDispatch(pickDecision(approved))).rejects.toThrow(
    "unresolved installation work",
  );
  expect(f.journal.read()).toEqual([approved]);
  queue.decide(queued.id, queued.revision, "cancel");
  await expect(f.service().claimDispatch(pickDecision(approved))).resolves.toMatchObject({
    execution: { stage: "claimed" },
  });
});

test("shared admission preserves cancellation and hold release for legacy overlapping work", async () => {
  const f = await claimFenceFixture();
  const effects: string[] = [];
  const executor = {
    restart: async () => {
      effects.push("restart");
      return "ready";
    },
    restartWhenIdle: async () => {
      effects.push("restart");
      return "ready";
    },
    holdCurrentTurns: async () => {
      effects.push("hold");
    },
    releaseCurrentTurns: async () => {
      effects.push("release");
    },
    inspect: async () => ({
      target: "host" as const,
      agents: [],
      pendingStarts: 0,
      checkedAt: new Date().toISOString(),
      idleRestartSupported: true,
      gracefulRestartSupported: true,
    }),
  };
  const legacy = new InstallationRestarts(
    {
      read: () => [],
      write: (jobs) =>
        writeFileSync(path.join(f.root, "restart-jobs.json"), JSON.stringify(jobs), {
          mode: 0o600,
        }),
    },
    executor,
  );
  const pending = legacy.request({ target: "host", reason: "Retained queued restart" }, "owner");
  const approved = legacy.decide(pending.id, pending.revision, "finish-current-turns");
  const queue = new InstallationRestarts(
    {
      read: () => f.journal.readLifecycle(),
      write: (jobs) => f.journal.writeLifecycle(jobs),
      admissionAvailable: () => f.journal.lifecycleAdmissionAvailable(),
    },
    executor,
  );
  await queue.drain();
  expect(effects).toEqual([]);
  queue.decide(approved.id, approved.revision, "cancel");
  await queue.drain();
  await queue.drain();
  expect(effects).toEqual(["release"]);
  expect(queue.list()[0]).toMatchObject({ status: "rejected", holdReleased: true });
  expect(f.journal.read()).toEqual([f.claimed]);
});

test("lifecycle admission uses the bootstrap writer lock and reopens without losing requests", async () => {
  const f = fixture();
  f.journal.writeLifecycle([]);
  const file = path.join(f.root, "restart-jobs.json");
  const before = readFileSync(file);
  f.journal.withRecoveryTransaction(() => {
    expect(() => f.journal.writeLifecycle([])).toThrow("storage is busy");
  });
  expect(readFileSync(file)).toEqual(before);
  const reopened = new FileBootstrapRequestJournal(f.root);
  expect(reopened.lifecycleAdmissionAvailable()).toBe(true);
  reopened.writeLifecycle([]);
  expect(reopened.readLifecycle()).toEqual([]);
});

test("lifecycle write admission sees locked snapshots and rejection preserves bytes", () => {
  const f = fixture();
  const queue = new InstallationRestarts(
    { read: () => f.journal.readLifecycle(), write: (jobs) => f.journal.writeLifecycle(jobs) },
    { restart: async () => "unused" },
  );
  queue.request({ target: "host", reason: "Admission fixture" }, "owner");
  const previous = f.journal.readLifecycle();
  const file = path.join(f.root, "restart-jobs.json");
  const before = readFileSync(file);
  const competingWrite = () => new FileBootstrapRequestJournal(f.root).writeLifecycle([]);
  expect(() =>
    f.journal.writeLifecycle([], (retained, next) => {
      expect(retained).toEqual(previous);
      expect(next).toEqual([]);
      expect(competingWrite).toThrow("storage is busy");
      throw new Error("Grant revision revoked");
    }),
  ).toThrow("Grant revision revoked");
  expect(readFileSync(file)).toEqual(before);
  f.journal.writeLifecycle(previous, (_retained, next) => {
    // Even an incorrectly mutating policy cannot alter the persisted candidate.
    next[0]!.reason = "mutated policy input";
  });
  expect(f.journal.readLifecycle()).toEqual(previous);
  f.journal.writeLifecycle([], () => undefined);
  expect(new FileBootstrapRequestJournal(f.root).readLifecycle()).toEqual([]);
});

test.each(["complete", "intent"])(
  "reviewed claim fencing refuses %s promotion without altering history",
  async (stage) => {
    const f = await claimFenceFixture();
    f.journal.promote(f.claimed);
    if (stage === "intent") rmSync(path.join(f.root, "coordinator-bootstrap.json"));
    const before = readFileSync(f.pendingFile);
    expect(() => f.journal.fenceUnpromotedClaim(f.claimed, f.recovery)).toThrow(
      "promotion already started",
    );
    expect(readFileSync(f.pendingFile)).toEqual(before);
    expect(() => readFileSync(f.evidence)).toThrow();
  },
);

test("reviewed claim fencing reconciles retention before an interrupted pending write", async () => {
  const f = await claimFenceFixture();
  const before = readFileSync(f.pendingFile);
  const fenced = f.journal.fenceUnpromotedClaim(f.claimed, f.recovery);
  // Reproduce the durable files left by a crash between the two atomic writes.
  writeFileSync(f.pendingFile, before);
  const reopened = new FileBootstrapRequestJournal(f.root);
  expect(reopened.fenceUnpromotedClaim(f.claimed, f.recovery)).toEqual(fenced);
  expect(reopened.read()).toEqual([fenced]);
  expect(() => reopened.promote(f.claimed)).toThrow("Exact protected bootstrap claim");
});

test.each(["revision", "generation", "stage", "plan"])(
  "reviewed claim fencing rejects changed original %s",
  async (field) => {
    const f = await claimFenceFixture();
    const changed = structuredClone(f.claimed);
    if (field === "revision") changed.revision = randomUUID();
    if (field === "generation") changed.execution!.generation = randomUUID();
    if (field === "stage") changed.execution!.stage = "recovery_required";
    if (field === "plan") changed.plan.candidate.sourceCommit = "f".repeat(40);
    const before = readFileSync(f.pendingFile);
    expect(() => f.journal.fenceUnpromotedClaim(changed, f.recovery)).toThrow();
    expect(readFileSync(f.pendingFile)).toEqual(before);
    expect(() => readFileSync(f.evidence)).toThrow();
  },
);

test("reviewed claim fencing rejects altered retained history before changing the claim", async () => {
  const f = await claimFenceFixture();
  const before = readFileSync(f.pendingFile);
  f.journal.fenceUnpromotedClaim(f.claimed, f.recovery);
  writeFileSync(f.pendingFile, before);
  const record = JSON.parse(readFileSync(f.evidence, "utf8"));
  record.fenced.execution.generation = randomUUID();
  writeFileSync(f.evidence, JSON.stringify(record));
  expect(() => f.journal.fenceUnpromotedClaim(f.claimed, f.recovery)).toThrow(
    "Retained claim fence changed",
  );
  expect(readFileSync(f.pendingFile)).toEqual(before);
});

test("reviewed claim fencing refuses unsafe evidence storage before changing the claim", async () => {
  const f = await claimFenceFixture();
  const before = readFileSync(f.pendingFile);
  const target = path.join(f.root, "unrelated");
  writeFileSync(target, "preserve", { mode: 0o600 });
  symlinkSync(target, f.evidence);
  expect(() => f.journal.fenceUnpromotedClaim(f.claimed, f.recovery)).toThrow();
  expect(readFileSync(f.pendingFile)).toEqual(before);
  expect(readFileSync(target, "utf8")).toBe("preserve");
});

test("compatible recovery keeps review and claim out of legacy startup until protected promotion", async () => {
  const f = fixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  expect(f.journal.readPromoted()).toEqual([]);
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const claimed = await f.service().claimDispatch(pickDecision(approved));
  expect(f.journal.readPromoted()).toEqual([]);
  f.service().promoteDispatch(claimed);
  expect(f.journal.readPromoted()).toEqual([claimed]);
  const advanced = f
    .service()
    .advanceDispatch(
      { ...pickDecision(claimed), generation: claimed.execution!.generation },
      "freeze_pending",
    );
  expect(f.journal.read()).toEqual([advanced]);
  expect(() => f.service().promoteDispatch(claimed)).toThrow("ownership changed");
  expect(() => f.journal.replace([claimed], [claimed])).toThrow("changed");
});

// The 2026-10-22 automatic renewal failed at promotion because another process
// (the coordinator loop or a Host status read) briefly held the journal lock.
test("promotion waits for another process to release the journal lock", async () => {
  const f = fixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const claimed = await f.service().claimDispatch(pickDecision(approved));
  const holder = nativeChildProcess.spawn(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      "import fcntl, os, sys, time\n" +
        "fd = os.open(sys.argv[1], os.O_RDWR)\n" +
        "fcntl.flock(fd, fcntl.LOCK_EX)\n" +
        "print('locked', flush=True)\n" +
        "time.sleep(0.5)",
      path.join(f.root, "coordinator-bootstrap.lock"),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout!.once("data", () => resolve());
    });
    f.service().promoteDispatch(claimed);
    expect(f.journal.readPromoted()).toEqual([claimed]);
  } finally {
    holder.kill();
  }
});

test.each(["reason", "decisionAt", "revision", "generation"])(
  "promotion refuses changed pre-claim evidence: %s",
  async (field) => {
    const f = fixture();
    f.plan.automaticRecovery = "restore-compatible";
    f.plan.compatibleRecovery = f.plan.candidate;
    const pending = await f.prepare();
    const approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
    const claimed = await f.service().claimDispatch(pickDecision(approved));
    f.service().promoteDispatch(claimed);
    const file = path.join(f.root, "coordinator-bootstrap-pending.json");
    const sidecar = JSON.parse(readFileSync(file, "utf8"));
    if (field === "generation") sidecar.requests[0].execution.generation = randomUUID();
    else
      sidecar.requests[0][field] =
        field === "decisionAt" ? new Date(0).toISOString() : randomUUID();
    writeFileSync(file, JSON.stringify(sidecar));
    expect(() => f.service().list()).toThrow("source changed");
  },
);

test("promotion intent without main commit requires reconciliation and cannot be canceled", async () => {
  const f = fixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const claimed = await f.service().claimDispatch(pickDecision(approved));
  const file = path.join(f.root, "coordinator-bootstrap-pending.json");
  writeFileSync(file, JSON.stringify({ version: 1, requests: [claimed], promotions: [claimed] }));
  expect(f.journal.readPromoted()).toEqual([]);
  expect(() =>
    f
      .service()
      .advanceDispatch(
        { ...pickDecision(claimed), generation: claimed.execution!.generation },
        "recovery_required",
      ),
  ).toThrow("reconciliation");
  await expect(
    f.service().decide({ ...pickDecision(claimed), decision: "cancel" }, ownerPassword),
  ).rejects.toThrow("claimed");
  f.service().promoteDispatch(claimed);
  expect(f.journal.readPromoted()).toEqual([claimed]);
});

test.each(["claimed", "freeze_pending", "frozen"] as const)(
  "compatible watchdog never records resumed after promotion at %s",
  async (stage) => {
    const f = fixture();
    f.plan.automaticRecovery = "restore-compatible";
    f.plan.compatibleRecovery = f.plan.candidate;
    const pending = await f.prepare();
    const approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
    let record = await f.service().claimDispatch(pickDecision(approved));
    f.service().promoteDispatch(record);
    if (stage !== "claimed")
      record = f
        .service()
        .advanceDispatch(
          { ...pickDecision(record), generation: record.execution!.generation },
          "freeze_pending",
        );
    if (stage === "frozen")
      record = f
        .service()
        .advanceDispatch(
          { ...pickDecision(record), generation: record.execution!.generation },
          "frozen",
        );
    const effects: string[] = [];
    const result = await recoverAbandonedBootstrap(
      f.service(),
      { id: record.id, generation: record.execution!.generation },
      {
        withOwnership: async (operation) => operation(),
        verifyExecutorExited: async () => {
          effects.push("exit verified");
        },
        resumePrevious: async () => {
          effects.push("resume");
        },
        restorePrevious: async () => {
          effects.push("compatible restoration");
        },
      },
    );
    expect(effects).toEqual(["exit verified", "compatible restoration"]);
    expect(result.execution!.stage).toBe("rolled_back");
  },
);

test("compatible executor promotes only after watchdog readiness and leaves early failure unresolved", async () => {
  const f = fixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const effects: string[] = [];
  const unexpected = async () => {
    throw new Error("Unexpected lifecycle effect");
  };
  const result = await executeCoordinatorBootstrap(f.service(), pickDecision(approved), {
    withOwnership: async (_request, operation) => {
      effects.push("ownership");
      return operation();
    },
    armWatchdog: async () => {
      expect(f.journal.readPromoted()).toEqual([]);
      effects.push("watchdog ready");
    },
    freeze: async (request) => {
      expect(f.journal.readPromoted()[0]!.id).toBe(request.id);
      effects.push("freeze");
      throw new Error("freeze uncertain");
    },
    inspectFrozen: async () => {
      throw new Error("Unexpected inspection");
    },
    preserveTransfer: unexpected,
    unload: unexpected,
    select: unexpected,
    start: unexpected,
    verifyReplacement: unexpected,
    releaseReplacement: unexpected,
    resumePrevious: unexpected,
  });
  expect(effects).toEqual(["ownership", "watchdog ready", "freeze"]);
  expect(result.execution!.stage).toBe("recovery_required");
});

test("ownership failure after claim records recovery without promotion or lifecycle effects", async () => {
  const f = fixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const effects: string[] = [];
  const unexpected = async () => {
    effects.push("unexpected lifecycle effect");
    throw new Error("Unexpected lifecycle effect");
  };
  const operations: BootstrapExecutorOperations = {
    withOwnership: async () => {
      throw new Error("private ownership diagnostic");
    },
    armWatchdog: unexpected,
    freeze: unexpected,
    inspectFrozen: async () => {
      effects.push("unexpected inspection");
      throw new Error("Unexpected inspection");
    },
    preserveTransfer: unexpected,
    unload: unexpected,
    select: unexpected,
    start: unexpected,
    verifyReplacement: unexpected,
    releaseReplacement: unexpected,
    resumePrevious: unexpected,
  };
  const result = await executeCoordinatorBootstrap(f.service(), pickDecision(approved), operations);
  expect(result.execution?.stage).toBe("recovery_required");
  expect(result.status).toBe("approved");
  expect(result.planSha256).toBe(approved.planSha256);
  expect(result.decisionAt).toBe(approved.decisionAt);
  expect(f.service().list()).toEqual([result]);
  expect(f.journal.readPromoted()).toEqual([]);
  expect(effects).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("private ownership diagnostic");
  await expect(
    executeCoordinatorBootstrap(f.service(), pickDecision(approved), operations),
  ).rejects.toThrow("undispatched");
});

test("reviewed claim fencing stops an already running executor before coordinator effects", async () => {
  const f = fixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  let fenced: CoordinatorBootstrapRequest | undefined;
  const unexpected = vi.fn(async () => {
    throw new Error("Unexpected native effect");
  });
  const operations: BootstrapExecutorOperations = {
    withOwnership: async (_request, operation) => operation(),
    // Model recovery winning while the old runner awaits its last pre-promotion step.
    armWatchdog: async (claimed) => {
      fenced = f.journal.fenceUnpromotedClaim(claimed, {
        id: randomUUID(),
        revision: randomUUID(),
        generation: randomUUID(),
        planSha256: "e".repeat(64),
      });
    },
    freeze: unexpected,
    inspectFrozen: unexpected,
    preserveTransfer: unexpected,
    unload: unexpected,
    select: unexpected,
    start: unexpected,
    verifyReplacement: unexpected,
    releaseReplacement: unexpected,
    resumePrevious: unexpected,
  };
  await expect(
    executeCoordinatorBootstrap(f.service(), pickDecision(approved), operations),
  ).rejects.toThrow();
  expect(unexpected).not.toHaveBeenCalled();
  expect(f.journal.readPromoted()).toEqual([]);
  expect(f.journal.read()).toEqual([fenced]);
  expect(fenced?.execution?.stage).toBe("recovery_required");
});

test("legacy clients cannot approve a hidden compatible recovery executable", async () => {
  const f = fixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  const legacy = await handleBootstrapReview(
    { type: "installation.bootstrap.list_requests.request", requestId: "old" },
    f.service(),
  );
  const projected = legacy.payload.requests![0]!;
  expect(projected.plan.compatibleRecovery).toBeUndefined();
  expect(projected.plan.automaticRecovery).toBeUndefined();
  expect(projected.planSha256).toBe(pending.planSha256);
  const decision = {
    type: "installation.bootstrap.decide.request" as const,
    requestId: "decision",
    ownerPassword,
    input: { ...pickDecision(pending), decision: "approve" as const },
  };
  expect((await handleBootstrapReview(decision, f.service())).payload.error).toContain("Reload");
  expect(f.service().list()[0]!.status).toBe("pending");
  expect(
    (await handleBootstrapReview({ ...decision, compatibleRecovery: true }, f.service())).payload
      .error,
  ).toBeNull();
});

function monitorBootstrapFixture(change: "enable" | "remove") {
  const f = fixture();
  const file = { path: "/protected/file", sha256: "a".repeat(64) };
  f.plan.previewMonitorConfiguration =
    change === "remove"
      ? null
      : {
          docker: "/protected/docker",
          socket: "/protected/docker.sock",
          containerId: "b".repeat(64),
          home: "/home/paseo",
          worker: file,
          recovery: { node: file, journal: file, queue: file },
        };
  return f;
}

test.each(["enable", "remove"] as const)(
  "old strict bootstrap list parses hidden monitor %s without altering approval digest",
  async (change) => {
    const f = monitorBootstrapFixture(change);
    const pending = await f.prepare();
    const oldRequest = CoordinatorBootstrapRequestSchema.extend({
      plan: CoordinatorBootstrapPlanSchema.omit({ previewMonitorConfiguration: true }),
    });
    const oldResponse = CoordinatorBootstrapListResponseSchema.extend({
      payload: CoordinatorBootstrapListResponseSchema.shape.payload.extend({
        requests: z.array(oldRequest).nullable(),
      }),
    });
    expect(() => oldRequest.parse(pending)).toThrow();
    const legacy = await handleBootstrapReview(
      {
        type: "installation.bootstrap.list_requests.request",
        requestId: "old",
      },
      f.service(),
    );
    expect(() => oldResponse.parse(legacy)).not.toThrow();
    const projected = legacy.payload.requests![0]!;
    expect(projected.plan).not.toHaveProperty("previewMonitorConfiguration");
    expect(projected.planSha256).toBe(pending.planSha256);
    expect(projected.revision).toBe(pending.revision);
    expect(projected.reason).toContain("Cancellation remains available");
    expect(f.service().list()).toEqual([pending]);
    const supported = await handleBootstrapReview(
      {
        type: "installation.bootstrap.list_requests.request",
        requestId: "new",
        previewMonitor: true,
      },
      f.service(),
    );
    expect(supported.payload.requests).toEqual([pending]);
  },
);

test.each(["enable", "remove"] as const)(
  "legacy approval of hidden monitor %s is refused before service.decide",
  async (change) => {
    const f = monitorBootstrapFixture(change);
    const pending = await f.prepare();
    const service = f.service();
    const decide = vi.spyOn(service, "decide");
    const reply = await handleBootstrapReview(
      {
        type: "installation.bootstrap.decide.request",
        requestId: "approve",
        ownerPassword,
        input: { ...pickDecision(pending), decision: "approve" },
      },
      service,
    );
    expect(reply.payload.error).toContain("preview monitor configuration");
    expect(decide).not.toHaveBeenCalled();
    expect(service.list()).toEqual([pending]);
  },
);

test.each([
  ["enable", "approve", "approved"],
  ["enable", "cancel", "canceled"],
  ["remove", "approve", "approved"],
  ["remove", "cancel", "canceled"],
] as const)("supported monitor %s permits exact %s", async (change, action, status) => {
  const f = monitorBootstrapFixture(change);
  const pending = await f.prepare();
  const service = f.service();
  const decide = vi.spyOn(service, "decide");
  const input = { ...pickDecision(pending), decision: action };
  const reply = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "decision",
      ownerPassword,
      previewMonitor: true,
      input,
    },
    service,
  );
  expect(reply.payload.error).toBeNull();
  expect(decide).toHaveBeenCalledExactlyOnceWith(input, ownerPassword);
  expect(reply.payload.requests![0]!.status).toBe(status);
  expect(reply.payload.requests![0]!.plan).toEqual(pending.plan);
  expect(reply.payload.requests![0]!.planSha256).toBe(pending.planSha256);
});

test.each(["enable", "remove"] as const)(
  "legacy monitor %s cancellation stays available",
  async (change) => {
    const f = monitorBootstrapFixture(change);
    const pending = await f.prepare();
    const service = f.service();
    const decide = vi.spyOn(service, "decide");
    const input = { ...pickDecision(pending), decision: "cancel" as const };
    const reply = await handleBootstrapReview(
      {
        type: "installation.bootstrap.decide.request",
        requestId: "cancel",
        ownerPassword,
        input,
      },
      service,
    );
    expect(reply.payload.error).toBeNull();
    expect(decide).toHaveBeenCalledExactlyOnceWith(input, ownerPassword);
    expect(reply.payload.requests![0]!.status).toBe("canceled");
    expect(reply.payload.requests![0]!.plan).not.toHaveProperty("previewMonitorConfiguration");
    expect(reply.payload.requests![0]!.planSha256).toBe(pending.planSha256);
  },
);

function claudeRefreshFixture(change: "enable" | "disable") {
  const f = fixture();
  f.plan.claudeHostRefreshConfiguration = change === "enable" ? true : null;
  return f;
}

test("an older coordinator's strict plan schema refuses the Claude refresh field", () => {
  const f = claudeRefreshFixture("enable");
  const older = CoordinatorBootstrapPlanSchema.omit({ claudeHostRefreshConfiguration: true });
  expect(() => older.parse(f.plan)).toThrow();
  expect(() =>
    CoordinatorBootstrapPlanSchema.parse({ ...f.plan, claudeHostRefreshConfiguration: false }),
  ).toThrow();
});

test.each(["enable", "disable"] as const)(
  "old clients see Claude refresh %s hidden, cannot approve it, and can still cancel",
  async (change) => {
    const f = claudeRefreshFixture(change);
    const pending = await f.prepare();
    const legacy = await handleBootstrapReview(
      { type: "installation.bootstrap.list_requests.request", requestId: "old" },
      f.service(),
    );
    const projected = legacy.payload.requests![0]!;
    expect(projected.plan).not.toHaveProperty("claudeHostRefreshConfiguration");
    expect(projected.planSha256).toBe(pending.planSha256);
    expect(projected.reason).toContain("Claude refresh");
    const supported = await handleBootstrapReview(
      {
        type: "installation.bootstrap.list_requests.request",
        requestId: "new",
        claudeHostRefresh: true,
      },
      f.service(),
    );
    expect(supported.payload.requests).toEqual([pending]);
    const service = f.service();
    const decide = vi.spyOn(service, "decide");
    const refused = await handleBootstrapReview(
      {
        type: "installation.bootstrap.decide.request",
        requestId: "approve",
        ownerPassword,
        input: { ...pickDecision(pending), decision: "approve" },
      },
      service,
    );
    expect(refused.payload.error).toContain("Claude refresh configuration");
    expect(decide).not.toHaveBeenCalled();
    const cancel = { ...pickDecision(pending), decision: "cancel" as const };
    const canceled = await handleBootstrapReview(
      {
        type: "installation.bootstrap.decide.request",
        requestId: "cancel",
        ownerPassword,
        input: cancel,
      },
      service,
    );
    expect(canceled.payload.error).toBeNull();
    expect(canceled.payload.requests![0]!.status).toBe("canceled");
  },
);

test("a client that reviews Claude refresh can approve the exact plan", async () => {
  const f = claudeRefreshFixture("enable");
  const pending = await f.prepare();
  const input = { ...pickDecision(pending), decision: "approve" as const };
  const reply = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "decision",
      ownerPassword,
      claudeHostRefresh: true,
      input,
    },
    f.service(),
  );
  expect(reply.payload.error).toBeNull();
  expect(reply.payload.requests![0]!.status).toBe("approved");
  expect(reply.payload.requests![0]!.plan.claudeHostRefreshConfiguration).toBe(true);
});

// A Host install that selects a new release makes coordinator updates prepared
// for the old one stale (2026-10-22 07:28Z); the renewal prepared minutes after
// each install targets the new release and must survive.
test("a Host release change cancels only stale undispatched coordinator updates", async () => {
  const releaseRoot = "/protected/releases";
  const replaced = `${releaseRoot}/old-update/build-a`;
  const selected = `${releaseRoot}/new-update/build-b`;
  const at = (directory: string) => {
    const f = fixture();
    f.plan.candidate = { ...f.plan.candidate, directory };
    return f;
  };
  const stale = at(replaced);
  const pending = await stale.prepare();
  expect(stale.service().cancelForReplacedHostRelease(selected, releaseRoot)).toEqual([pending.id]);
  const [canceled] = stale.service().list();
  expect(canceled).toMatchObject({ id: pending.id, status: "canceled", plan: pending.plan });
  expect(canceled!.revision).not.toBe(pending.revision);
  expect(stale.service().cancelForReplacedHostRelease(selected, releaseRoot)).toEqual([]);

  const approvedStale = at(replaced);
  const approved = await approvedStale
    .service()
    .decide({ ...pickDecision(await approvedStale.prepare()), decision: "approve" }, ownerPassword);
  expect(approvedStale.service().cancelForReplacedHostRelease(selected, releaseRoot)).toEqual([
    approved.id,
  ]);

  const renewal = at(selected);
  const current = await renewal.prepare();
  expect(renewal.service().cancelForReplacedHostRelease(selected, releaseRoot)).toEqual([]);
  expect(renewal.service().list()).toEqual([current]);

  const elsewhere = at("/protected/supervision-release");
  const outside = await elsewhere.prepare();
  expect(elsewhere.service().cancelForReplacedHostRelease(selected, releaseRoot)).toEqual([]);
  expect(elsewhere.service().list()).toEqual([outside]);
});

test("stale coordinator cancellation never touches executing requests or restart jobs", async () => {
  const releaseRoot = "/protected/releases";
  const f = fixture();
  f.plan.candidate = { ...f.plan.candidate, directory: `${releaseRoot}/old-update/build-a` };
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const approved = await f
    .service()
    .decide({ ...pickDecision(await f.prepare()), decision: "approve" }, ownerPassword);
  const claimed = await f.service().claimDispatch(pickDecision(approved));
  expect(
    f.service().cancelForReplacedHostRelease(`${releaseRoot}/new-update/build-b`, releaseRoot),
  ).toEqual([]);
  expect(f.service().list()).toEqual([claimed]);

  // A pending restart (such as a session host restart awaiting the owner) beside
  // a stale coordinator update: only the coordinator update is canceled.
  const g = fixture();
  g.plan.candidate = { ...g.plan.candidate, directory: `${releaseRoot}/old-update/build-a` };
  const queue = new InstallationRestarts(
    { read: () => g.journal.readLifecycle(), write: (next) => g.journal.writeLifecycle(next) },
    { restart: async () => "unused" },
  );
  queue.request({ target: "host", reason: "Awaiting owner" }, "owner");
  const jobs = g.journal.readLifecycle();
  const stale = await g.prepare();
  expect(
    g.service().cancelForReplacedHostRelease(`${releaseRoot}/new-update/build-b`, releaseRoot),
  ).toEqual([stale.id]);
  expect(g.journal.readLifecycle()).toEqual(jobs);
  expect(jobs[0]).toMatchObject({ status: "pending" });
});

test("old clients see a Host launcher update plan hidden and cannot approve it", async () => {
  const f = fixture();
  f.plan.hostLauncherUpdateConfiguration = {
    candidate: "/fixture/candidate.plist",
    sha256: "c".repeat(64),
  };
  const pending = await f.prepare();
  const legacy = await handleBootstrapReview(
    { type: "installation.bootstrap.list_requests.request", requestId: "old" },
    f.service(),
  );
  expect(legacy.payload.requests![0]!.plan).not.toHaveProperty("hostLauncherUpdateConfiguration");
  expect(legacy.payload.requests![0]!.reason).toContain("Host launcher");
  const refused = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "approve",
      ownerPassword,
      input: { ...pickDecision(pending), decision: "approve" },
    },
    f.service(),
  );
  expect(refused.payload.error).toContain("Host launcher update plan");
  const approved = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "decision",
      ownerPassword,
      hostLauncherUpdate: true,
      input: { ...pickDecision(pending), decision: "approve" },
    },
    f.service(),
  );
  expect(approved.payload.error).toBeNull();
});

test("clients that do not name a listed setting see it hidden and cannot approve it", async () => {
  const f = fixture();
  f.plan.configurationChanges = [
    {
      setting: "hostLauncherUpdate",
      value: { candidate: "/fixture/candidate.plist", sha256: "c".repeat(64) },
    },
  ];
  const pending = await f.prepare();
  const decide = (requestId: string, configurationSettings?: string[]) =>
    handleBootstrapReview(
      {
        type: "installation.bootstrap.decide.request",
        requestId,
        ownerPassword,
        ...(configurationSettings ? { configurationSettings } : {}),
        input: { ...pickDecision(pending), decision: "approve" },
      },
      f.service(),
    );
  // A client from before configuration settings, and one that knows other settings only.
  for (const configurationSettings of [undefined, ["claudeHostRefresh"]]) {
    const listed = await handleBootstrapReview(
      {
        type: "installation.bootstrap.list_requests.request",
        requestId: "list",
        ...(configurationSettings ? { configurationSettings } : {}),
      },
      f.service(),
    );
    expect(listed.payload.requests![0]!.plan).not.toHaveProperty("configurationChanges");
    expect(listed.payload.requests![0]!.reason).toContain("Reload the client");
    expect((await decide("approve", configurationSettings)).payload.error).toContain(
      "review this configuration change",
    );
  }
  const current = await handleBootstrapReview(
    {
      type: "installation.bootstrap.list_requests.request",
      requestId: "list",
      configurationSettings: ["hostLauncherUpdate"],
    },
    f.service(),
  );
  expect(current.payload.requests![0]!.plan.configurationChanges).toHaveLength(1);
  expect((await decide("decision", ["hostLauncherUpdate"])).payload.error).toBeNull();
});

test("automatic coordinator plans refuse listed configuration changes", async () => {
  const f = await preFreezeFailureFixture();
  const submitted = await f.submit({
    ...f.plan,
    configurationChanges: [{ setting: "claudeHostRefresh", value: true }],
  });
  await expect(
    f.service().approveAutomatic(automaticCoordinatorIdentity(submitted)),
  ).rejects.toThrow("require exact owner review");
});

test("old clients see a Factory check configuration hidden and cannot approve it", async () => {
  const f = fixture();
  f.plan.factoryGateConfiguration = {
    docker: "/fixture/docker",
    socket: "/fixture/docker.sock",
    container: "a".repeat(64),
    verify: {
      script: "/fixture/verify.sh",
      sha256: "b".repeat(64),
      lockInode: 3901122,
      ownerMode: "paused",
    },
  };
  const pending = await f.prepare();
  const legacy = await handleBootstrapReview(
    { type: "installation.bootstrap.list_requests.request", requestId: "old" },
    f.service(),
  );
  expect(legacy.payload.requests![0]!.plan).not.toHaveProperty("factoryGateConfiguration");
  expect(legacy.payload.requests![0]!.reason).toContain("Factory check");
  const refused = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "approve",
      ownerPassword,
      input: { ...pickDecision(pending), decision: "approve" },
    },
    f.service(),
  );
  expect(refused.payload.error).toContain("Factory check configuration");
  const approved = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "decision",
      ownerPassword,
      factoryGate: true,
      input: { ...pickDecision(pending), decision: "approve" },
    },
    f.service(),
  );
  expect(approved.payload.error).toBeNull();
});

test("old clients see a Docker restart plan hidden, cannot approve it, and can still cancel", async () => {
  const f = fixture();
  f.plan.engineRestartConfiguration = {
    docker: "/fixture/docker",
    socket: "/fixture/docker.sock",
    containers: {
      dev: "a".repeat(64),
      gatewayTailscale: "b".repeat(64),
      gatewayCaddy: "c".repeat(64),
    },
  };
  const pending = await f.prepare();
  const legacy = await handleBootstrapReview(
    { type: "installation.bootstrap.list_requests.request", requestId: "old" },
    f.service(),
  );
  const projected = legacy.payload.requests![0]!;
  expect(projected.plan).not.toHaveProperty("engineRestartConfiguration");
  expect(projected.planSha256).toBe(pending.planSha256);
  expect(projected.reason).toContain("Docker restart");
  const service = f.service();
  const decide = vi.spyOn(service, "decide");
  const refused = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "approve",
      ownerPassword,
      input: { ...pickDecision(pending), decision: "approve" },
    },
    service,
  );
  expect(refused.payload.error).toContain("Docker restart configuration");
  expect(decide).not.toHaveBeenCalled();
  const approved = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "decision",
      ownerPassword,
      engineRestart: true,
      input: { ...pickDecision(pending), decision: "approve" },
    },
    f.service(),
  );
  expect(approved.payload.error).toBeNull();
  expect(approved.payload.requests![0]!.plan.engineRestartConfiguration?.containers.dev).toBe(
    "a".repeat(64),
  );
});

test("source tooling selection is literal true and binds exact review identity and durable retries", async () => {
  const f = fixture();
  const original = coordinatorPlanDigest(f.plan);
  expect(() =>
    CoordinatorBootstrapPlanSchema.parse({ ...f.plan, sourceUpdateTooling: false }),
  ).toThrow();
  expect(() =>
    CoordinatorBootstrapPlanSchema.parse({ ...f.plan, sourceUpdateTooling: null }),
  ).toThrow();
  expect(() =>
    CoordinatorBootstrapPlanSchema.parse({ ...f.plan, sourceUpdateTooling: "/other/tools" }),
  ).toThrow();
  f.plan.sourceUpdateTooling = true;
  expect(coordinatorPlanDigest(f.plan)).not.toBe(original);
  const input = { id: randomUUID(), reason: "Select reviewed source tooling", plan: f.plan };
  const pending = await f.service().prepare(input);
  expect(pending.status).toBe("pending");
  expect(f.service().list()).toEqual([pending]);
  expect(await f.service().prepare(input)).toEqual(pending);
  await expect(
    f.service().prepare({ ...input, plan: { ...f.plan, sourceUpdateTooling: undefined } }),
  ).rejects.toThrow("different prepared work");
});

test("source tooling legacy projection parses strictly and blocks hidden approval before decision", async () => {
  const f = fixture();
  f.plan.sourceUpdateTooling = true;
  const pending = await f.prepare();
  const service = f.service();
  const decide = vi.spyOn(service, "decide");
  const legacyRequest = CoordinatorBootstrapRequestSchema.extend({
    plan: CoordinatorBootstrapPlanSchema.omit({ sourceUpdateTooling: true }),
  });
  const legacyResponse = CoordinatorBootstrapListResponseSchema.extend({
    payload: CoordinatorBootstrapListResponseSchema.shape.payload.extend({
      requests: z.array(legacyRequest).nullable(),
    }),
  });
  expect(() => legacyRequest.parse(pending)).toThrow();
  const reply = await handleBootstrapReview(
    { type: "installation.bootstrap.list_requests.request", requestId: "legacy" },
    service,
  );
  expect(() => legacyResponse.parse(reply)).not.toThrow();
  const projected = reply.payload.requests![0]!;
  expect(projected.plan).not.toHaveProperty("sourceUpdateTooling");
  expect(projected.planSha256).toBe(pending.planSha256);
  expect(projected.revision).toBe(pending.revision);
  expect(projected.reason).toContain("Cancellation remains available");
  const hidden = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "hidden",
      ownerPassword,
      input: { ...pickDecision(pending), decision: "approve" },
    },
    service,
  );
  expect(hidden.payload.error).toContain("source update tooling");
  expect(decide).not.toHaveBeenCalled();
  expect(service.list()).toEqual([pending]);
});

test.each(["approve", "cancel"] as const)(
  "source tooling permits exact supported %s and durable recovery",
  async (action) => {
    const f = fixture();
    f.plan.sourceUpdateTooling = true;
    const pending = await f.prepare();
    const service = f.service();
    const decide = vi.spyOn(service, "decide");
    const input = { ...pickDecision(pending), decision: action };
    const reply = await handleBootstrapReview(
      {
        type: "installation.bootstrap.decide.request",
        requestId: "supported",
        ownerPassword,
        sourceUpdateTooling: true,
        input,
      },
      service,
    );
    expect(reply.payload.error).toBeNull();
    expect(decide).toHaveBeenCalledExactlyOnceWith(input, ownerPassword);
    const recorded = reply.payload.requests![0]!;
    expect(recorded.status).toBe(action === "approve" ? "approved" : "canceled");
    expect(recorded.plan).toEqual(pending.plan);
    expect(recorded.planSha256).toBe(pending.planSha256);
    expect(f.service().list()).toEqual([recorded]);
  },
);

test("source tooling legacy cancellation preserves the exact hidden plan", async () => {
  const f = fixture();
  f.plan.sourceUpdateTooling = true;
  const pending = await f.prepare();
  const service = f.service();
  const reply = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "cancel",
      ownerPassword,
      input: { ...pickDecision(pending), decision: "cancel" },
    },
    service,
  );
  expect(reply.payload.error).toBeNull();
  expect(reply.payload.requests![0]!.status).toBe("canceled");
  expect(reply.payload.requests![0]!.planSha256).toBe(pending.planSha256);
  expect(service.list()[0]!.plan).toEqual(pending.plan);
});

async function pendingRecoveryStartupFixture() {
  const f = fixture();
  f.plan.state.directory = f.root;
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.candidate;
  const pending = await f.prepare();
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const claimed = await f.service().claimDispatch(pickDecision(approved));
  const failed = f.journal.fenceUnpromotedClaim(claimed, {
    id: randomUUID(),
    revision: randomUUID(),
    generation: randomUUID(),
    planSha256: "f".repeat(64),
  });
  const next = await f.service().prepare({
    id: randomUUID(),
    reason: "Reviewed successor",
    plan: {
      ...f.plan,
      recoveredFrom: {
        id: failed.id,
        revision: failed.revision,
        generation: failed.execution!.generation,
        planSha256: failed.planSha256,
      },
    },
  });
  const decided = await f
    .service()
    .decide({ ...pickDecision(next), decision: "approve" }, ownerPassword);
  const successor = await f.service().claimDispatch(pickDecision(decided));
  f.journal.promote(successor);
  const started = {
    ...successor,
    execution: { ...successor.execution!, stage: "start_pending" as const },
  };
  const records = f.journal.read();
  f.journal.replace(
    records,
    records.map((r) => (r.id === started.id ? started : r)),
  );
  const identity = {
    installationId: f.plan.installationId,
    stateDirectory: f.root,
    node: f.plan.candidate.node.path,
    entrypoint: f.plan.candidate.entrypoint.path,
    configuration: f.plan.candidate.configuration.path,
  };
  return { ...f, failed, started, identity };
}

test("startup retains exact pending recovery ancestry without granting unrelated pending claims authority", async () => {
  const f = await pendingRecoveryStartupFixture();
  const records = f.journal.read();
  const unrelated = {
    ...f.failed,
    id: randomUUID(),
    revision: randomUUID(),
    execution: { ...f.failed.execution!, generation: randomUUID(), stage: "claimed" as const },
  };
  f.journal.replace(records, [...records, unrelated]);
  const paths = ["coordinator-bootstrap.json", "coordinator-bootstrap-pending.json"].map((n) =>
    path.join(f.root, n),
  );
  const before = paths.map((p) => readFileSync(p));
  expect(f.journal.readPromoted().map((r) => r.id)).toEqual([f.started.id]);
  const fence = loadCoordinatorStartupFence(f.identity);
  expect(fence?.generation).toBe(f.started.execution.generation);
  expect(fence?.released()).toBe(false);
  expect(paths.map((p) => readFileSync(p))).toEqual(before);
  const current = f.journal.read();
  const completed = {
    ...f.started,
    execution: { ...f.started.execution, stage: "succeeded" as const },
  };
  f.journal.replace(
    current,
    current.map((r) => (r.id === f.started.id ? completed : r)),
  );
  expect(fence?.released()).toBe(true);
  expect(loadCoordinatorStartupFence(f.identity)).toBeUndefined();
  expect(f.journal.readPromoted().map((r) => r.id)).toEqual([f.started.id]);
});

test("a future unrelated pending plan cannot disable promoted startup or grant mutation authority", async () => {
  const f = await pendingRecoveryStartupFixture();
  const mainPath = path.join(f.root, "coordinator-bootstrap.json");
  const pendingPath = path.join(f.root, "coordinator-bootstrap-pending.json");
  const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
  const futurePlan = { ...f.plan, futureMaintenanceTooling: true };
  pending.requests.push({
    ...f.failed,
    id: randomUUID(),
    revision: randomUUID(),
    status: "pending",
    execution: undefined,
    plan: futurePlan,
    planSha256: createHash("sha256").update(JSON.stringify(futurePlan)).digest("hex"),
  });
  writeFileSync(pendingPath, JSON.stringify(pending), { mode: 0o600 });
  const before = [mainPath, pendingPath].map((file) => readFileSync(file));
  expect(f.journal.readPromoted().map((record) => record.id)).toEqual([f.started.id]);
  const fence = loadCoordinatorStartupFence(f.identity);
  expect(fence?.released()).toBe(false);
  expect(() => f.journal.read()).toThrow("futureMaintenanceTooling");
  expect(() =>
    f.journal.writeLifecycle([
      {
        id: randomUUID(),
        revision: randomUUID(),
        target: "host",
        requestedBy: "host-agent",
        reason: "Must not gain effect authority",
        createdAt: new Date().toISOString(),
        expiresAt: "9999-12-31T23:59:59.999Z",
        status: "approved",
        detail: "Fixture admission",
      },
    ]),
  ).toThrow("futureMaintenanceTooling");
  expect([mainPath, pendingPath].map((file) => readFileSync(file))).toEqual(before);
  const main = JSON.parse(readFileSync(mainPath, "utf8"));
  main.requests[0].execution.stage = "succeeded";
  writeFileSync(mainPath, JSON.stringify(main), { mode: 0o600 });
  expect(fence?.released()).toBe(true);
  expect(loadCoordinatorStartupFence(f.identity)).toBeUndefined();
  expect(readFileSync(pendingPath)).toEqual(before[1]);
});

test.each(["ancestor", "promotion", "promoted"])(
  "startup still rejects unsupported required authority: %s",
  async (location) => {
    const f = await pendingRecoveryStartupFixture();
    const mainPath = path.join(f.root, "coordinator-bootstrap.json");
    const pendingPath = path.join(f.root, "coordinator-bootstrap-pending.json");
    if (location === "promoted") {
      const main = JSON.parse(readFileSync(mainPath, "utf8"));
      main.requests[0].plan.futureMaintenanceTooling = true;
      writeFileSync(mainPath, JSON.stringify(main), { mode: 0o600 });
    } else {
      const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
      const record = location === "ancestor" ? f.failed : f.started;
      const changed = { ...record, plan: { ...record.plan, futureMaintenanceTooling: true } };
      if (location === "ancestor")
        pending.requests = pending.requests.map((item: { id: string }) =>
          item.id === f.failed.id ? changed : item,
        );
      else
        pending.promotions = pending.promotions.map(
          (item: { id: string; plan: CoordinatorBootstrapPlan }) =>
            item.id === f.started.id
              ? { ...item, plan: { ...item.plan, futureMaintenanceTooling: true } }
              : item,
        );
      writeFileSync(pendingPath, JSON.stringify(pending), { mode: 0o600 });
    }
    const before = [mainPath, pendingPath].map((file) => readFileSync(file));
    expect(() => loadCoordinatorStartupFence(f.identity)).toThrow("futureMaintenanceTooling");
    expect([mainPath, pendingPath].map((file) => readFileSync(file))).toEqual(before);
  },
);

test.each(["missing", "revision", "generation", "plan"])(
  "startup refuses changed pending recovery ancestry: %s",
  async (change) => {
    const f = await pendingRecoveryStartupFixture();
    const records = f.journal.read();
    const changed = structuredClone(f.failed);
    if (change === "revision") changed.revision = randomUUID();
    if (change === "generation") changed.execution!.generation = randomUUID();
    if (change === "plan") changed.planSha256 = "0".repeat(64);
    f.journal.replace(
      records,
      records.flatMap((r) => {
        if (r.id !== f.failed.id) return [r];
        return change === "missing" ? [] : [changed];
      }),
    );
    expect(() => loadCoordinatorStartupFence(f.identity)).toThrow(
      "Recovered coordinator history changed",
    );
  },
);

test.each([true, false])(
  "watchdog reconciles completed replacement without replaying effects: %s",
  async (healthy) => {
    const f = fixture();
    const pending = await f.prepare();
    const approved = await f.service().decide(
      {
        id: pending.id,
        revision: pending.revision,
        planSha256: pending.planSha256,
        decision: "approve",
      },
      ownerPassword,
    );
    const record = {
      ...approved,
      execution: {
        generation: randomUUID(),
        stage: "verifying" as const,
        updatedAt: new Date().toISOString(),
      },
    };
    f.journal.replace([approved], [record]);
    const calls: string[] = [];
    const result = await recoverAbandonedBootstrap(
      f.service(),
      {
        id: record.id,
        generation: record.execution.generation,
      },
      {
        withOwnership: async (operation) => operation(),
        verifyExecutorExited: async () => {
          calls.push("exit");
        },
        verifyReplacement: async (request) => {
          expect(request.execution?.stage).toBe("verifying");
          calls.push("verify");
          if (!healthy) throw new Error("candidate unavailable");
        },
        resumePrevious: async () => {
          throw new Error("must not resume");
        },
        restorePrevious: async () => {
          throw new Error("rollback not authorized");
        },
      },
    );
    expect(result.execution?.stage).toBe(healthy ? "succeeded" : "recovery_required");
    expect(calls).toEqual(["exit", "verify"]);
  },
);

test("watchdog cannot release a replacement after dispatch ownership changes during observation", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  const record = {
    ...approved,
    execution: {
      generation: randomUUID(),
      stage: "verifying" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  f.journal.replace([approved], [record]);
  await expect(
    recoverAbandonedBootstrap(
      f.service(),
      {
        id: record.id,
        generation: record.execution.generation,
      },
      {
        withOwnership: async (operation) => operation(),
        verifyExecutorExited: async () => {},
        verifyReplacement: async () => {
          f.journal.replace([record], [{ ...record, revision: randomUUID() }]);
        },
        resumePrevious: async () => {
          throw new Error("must not resume");
        },
        restorePrevious: async () => {
          throw new Error("must not restore");
        },
      },
    ),
  ).rejects.toThrow("ownership changed");
  expect(f.service().list()[0].execution?.stage).toBe("verifying");
});

function bootRecoveryFixture() {
  const f = fixture();
  const id = randomUUID();
  const service = `${f.plan.service}-recovery-${id}`;
  const identity = (file: string) => ({ path: file, sha256: "a".repeat(64) });
  f.plan.bootRecovery = {
    requestId: id,
    service,
    launcher: identity("/protected/prepared-recovery.plist"),
    installedLauncher: `/Users/fixture/Library/LaunchAgents/${service.split("/")[2]}.plist`,
    setup: identity("/protected/recovery-setup.json"),
    ownerLauncher: identity(`${f.plan.candidate.directory}/scripts/run-coordinator-owner.py`),
    node: f.plan.candidate.node,
    entrypoint: identity(
      `${f.plan.candidate.directory}/packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js`,
    ),
  };
  return { ...f, id };
}

test("startup recovery binds its request and all startup settings to the reviewed candidate", async () => {
  const f = bootRecoveryFixture();
  const launcher = bootstrapRecoveryLauncher(f.plan);
  const input = { plan: f.plan, hostUid: 501, hostHome: "/Users/fixture", launcher };
  expect(() => verifyBootstrapRecoveryLauncher(input)).not.toThrow();
  for (const altered of [
    { ...launcher, KeepAlive: true },
    { ...launcher, RunAtLoad: false },
    { ...launcher, EnvironmentVariables: { NODE_OPTIONS: "--require /other/code" } },
    { ...launcher, ProgramArguments: [...launcher.ProgramArguments, "automatic-recovery"] },
    { ...launcher, Label: "unrelated" },
  ])
    expect(() => verifyBootstrapRecoveryLauncher({ ...input, launcher: altered })).toThrow(
      "startup settings",
    );
  expect(() => verifyBootstrapRecoveryLauncher({ ...input, hostUid: 502 })).toThrow("Host account");
  expect(() => verifyBootstrapRecoveryLauncher({ ...input, hostHome: "/Users/other" })).toThrow(
    "Host account",
  );
  const pending = await f
    .service()
    .prepare({ id: f.id, reason: "Restore after login", plan: f.plan });
  expect(pending.plan.bootRecovery?.requestId).toBe(f.id);
  await expect(f.prepare()).rejects.toThrow("exact maintenance request");
});

test("startup recovery preserves retained scheduling and verifies reviewed responsive scheduling", () => {
  const f = bootRecoveryFixture();
  const retained = bootstrapRecoveryLauncher(f.plan);
  expect(retained.ProcessType).toBe("Background");
  expect(bootstrapRecoveryLauncher(f.plan, { processType: "Background" })).toEqual(retained);
  const responsive = bootstrapRecoveryLauncher(f.plan, { processType: "Interactive" });
  expect(responsive).toEqual({ ...retained, ProcessType: "Interactive" });
  expect(() =>
    verifyBootstrapRecoveryLauncher({
      plan: f.plan,
      hostUid: 501,
      hostHome: "/Users/fixture",
      launcher: responsive,
    }),
  ).not.toThrow();
  expect(() =>
    verifyBootstrapRecoveryLauncher({
      plan: f.plan,
      hostUid: 501,
      hostHome: "/Users/fixture",
      launcher: { ...responsive, KeepAlive: true },
    }),
  ).toThrow("startup settings");
});

test("startup recovery refuses unrelated executables and startup destinations", () => {
  const f = bootRecoveryFixture();
  const original = f.plan.bootRecovery!;
  for (const change of [
    { node: { ...original.node, path: "/other/node" } },
    { entrypoint: { ...original.entrypoint, path: "/other/runner.js" } },
    { ownerLauncher: { ...original.ownerLauncher, path: "/other/owner.py" } },
    { installedLauncher: "/Library/LaunchDaemons/unrelated.plist" },
    { service: `${f.plan.service}-recovery-${randomUUID()}` },
    { launcher: { ...original.launcher, path: original.installedLauncher } },
  ]) {
    const plan = { ...f.plan, bootRecovery: { ...original, ...change } };
    expect(() =>
      verifyBootstrapRecoveryLauncher({
        plan,
        hostUid: 501,
        hostHome: "/Users/fixture",
        launcher: bootstrapRecoveryLauncher(plan),
      }),
    ).toThrow();
  }
});

test("strict legacy readers can cancel but cannot approve hidden startup recovery", async () => {
  const f = bootRecoveryFixture();
  const pending = await f
    .service()
    .prepare({ id: f.id, reason: "Restore after login", plan: f.plan });
  const service = f.service();
  const reply = await handleBootstrapReview(
    { type: "installation.bootstrap.list_requests.request", requestId: "legacy" },
    service,
  );
  const legacyRequest = CoordinatorBootstrapRequestSchema.extend({
    plan: CoordinatorBootstrapPlanSchema.omit({ bootRecovery: true }),
  });
  expect(() => legacyRequest.parse(pending)).toThrow();
  const projected = legacyRequest.parse(reply.payload.requests![0]);
  expect(projected.planSha256).toBe(pending.planSha256);
  expect(projected.revision).toBe(pending.revision);
  const hidden = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "hidden",
      ownerPassword,
      input: { ...pickDecision(pending), decision: "approve" },
    },
    service,
  );
  expect(hidden.payload.error).toContain("startup recovery");
  expect(service.list()[0]?.status).toBe("pending");
  const canceled = await handleBootstrapReview(
    {
      type: "installation.bootstrap.decide.request",
      requestId: "cancel",
      ownerPassword,
      input: { ...pickDecision(pending), decision: "cancel" },
    },
    service,
  );
  expect(canceled.payload.error).toBeNull();
  expect(service.list()[0]?.status).toBe("canceled");
});

test("startup recovery must be armed before a coordinator can be frozen", async () => {
  const f = bootRecoveryFixture();
  const pending = await f
    .service()
    .prepare({ id: f.id, reason: "Restore after login", plan: f.plan });
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  const calls: string[] = [];
  const unexpected = async () => {
    throw new Error("Unexpected lifecycle effect");
  };
  const operations: BootstrapExecutorOperations = {
    withOwnership: async (_request, operation) => operation(),
    armWatchdog: async () => {
      calls.push("watchdog");
    },
    freeze: unexpected,
    inspectFrozen: async () => {
      throw new Error("Unexpected inspection");
    },
    preserveTransfer: unexpected,
    unload: unexpected,
    select: unexpected,
    start: unexpected,
    verifyReplacement: unexpected,
    releaseReplacement: unexpected,
    resumePrevious: unexpected,
  };
  await expect(
    executeCoordinatorBootstrap(f.service(), pickDecision(approved), operations),
  ).rejects.toThrow("cannot arm");
  expect(f.service().list()[0]?.execution).toBeUndefined();
  expect(calls).toEqual([]);
  const result = await executeCoordinatorBootstrap(f.service(), pickDecision(approved), {
    ...operations,
    armBootRecovery: async (claimed) => {
      expect(claimed.execution?.stage).toBe("claimed");
      calls.push("startup recovery");
      throw new Error("Startup service registration failed");
    },
  });
  expect(calls).toEqual(["watchdog", "startup recovery"]);
  expect(result.execution?.stage).toBe("recovery_required");
});

test("replacement after reboot accepts a recycled PID only with approved boot recovery and exact fenced health", async () => {
  const { plan } = bootRecoveryFixture();
  const generation = randomUUID();
  const recoveryBootId = randomUUID();
  const candidate = {
    pid: plan.expectedProcess.pid,
    parentPid: 1,
    uid: 501,
    bootId: recoveryBootId,
    startIdentity: "9999:123",
    executable: plan.candidate.node.path,
    argumentsSha256: createHash("sha256")
      .update(
        JSON.stringify([
          plan.candidate.node.path,
          plan.candidate.entrypoint.path,
          plan.candidate.configuration.path,
        ]),
      )
      .digest("hex"),
  };
  const health = {
    installationId: plan.installationId,
    bootstrap: { generation, pid: candidate.pid, fenced: true },
  };
  const reader = {
    readService: async () => `${plan.service} = {\n\tpid = ${candidate.pid}\n}`,
    inspectProcess: async () => candidate,
  };
  const input = {
    plan,
    generation,
    recoveryBootId,
    hostUid: 501,
    reader,
    readHealth: async () => health,
  };
  await expect(verifyBootstrapReplacement(input)).resolves.toBeUndefined();
  await expect(verifyBootstrapReplacement({ ...input, recoveryBootId: undefined })).rejects.toThrow(
    "previous PID",
  );
  await expect(
    verifyBootstrapReplacement({ ...input, recoveryBootId: plan.expectedProcess.bootId }),
  ).rejects.toThrow("distinct verified boot");
  await expect(
    verifyBootstrapReplacement({ ...input, plan: { ...plan, bootRecovery: undefined } }),
  ).rejects.toThrow("distinct verified boot");
  await expect(
    verifyBootstrapReplacement({
      ...input,
      reader: {
        ...reader,
        inspectProcess: async () => ({ ...candidate, bootId: randomUUID() }),
      },
    }),
  ).rejects.toThrow("approved candidate");
  await expect(
    verifyBootstrapReplacement({
      ...input,
      readHealth: async () => ({ ...health, bootstrap: { ...health.bootstrap, fenced: false } }),
    }),
  ).rejects.toThrow();
});

test.each([true, false])(
  "startup watchdog never resumes a pre-reboot PID and preserves one rollback budget: %s",
  async (authorized) => {
    const f = bootRecoveryFixture();
    if (authorized) f.plan.automaticRecovery = "restore-previous";
    const pending = await f
      .service()
      .prepare({ id: f.id, reason: "Restore after login", plan: f.plan });
    const approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
    const request = {
      ...approved,
      execution: {
        generation: randomUUID(),
        stage: "frozen" as const,
        updatedAt: new Date().toISOString(),
      },
    };
    f.journal.replace([approved], [request]);
    let restores = 0;
    const operations = {
      withOwnership: async <T>(operation: () => Promise<T>) => operation(),
      verifyExecutorExited: async () => {},
      verifyBootChanged: async () => {},
      resumePrevious: async () => {
        throw new Error("Must never signal a recycled PID");
      },
      restorePrevious: async () => {
        restores++;
        throw new Error("Uncertain rollback outcome");
      },
    };
    const ownership = { id: request.id, generation: request.execution.generation };
    const first = await recoverAbandonedBootstrap(f.service(), ownership, operations);
    expect(first.execution?.stage).toBe("recovery_required");
    expect(restores).toBe(authorized ? 1 : 0);
    await recoverAbandonedBootstrap(f.service(), ownership, operations);
    expect(restores).toBe(authorized ? 1 : 0);
  },
);

test.each([true, false])(
  "startup registration persists exact bytes and never repeats an uncertain native effect: %s",
  async (succeeds) => {
    const f = bootRecoveryFixture();
    const bytes = Buffer.from("prepared fixture launcher");
    const source = path.join(f.root, "prepared.plist");
    writeFileSync(source, bytes, { mode: 0o600 });
    f.plan.state.directory = f.root;
    f.plan.bootRecovery!.launcher = {
      path: source,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    f.plan.bootRecovery!.installedLauncher = path.join(f.root, "selected.plist");
    const pending = await f
      .service()
      .prepare({ id: f.id, reason: "Restore after login", plan: f.plan });
    const approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
    const request = await f.service().claimDispatch(pickDecision(approved));
    let registrations = 0;
    let verified = 0;
    const input = {
      request,
      writableMountRoots: [],
      requireClaim: async () => {
        expect(f.service().list()[0]).toEqual(request);
      },
      verifyServiceAbsent: async () => {},
      register: async (domain: string, launcher: string) => {
        registrations++;
        expect(domain).toBe("gui/501");
        expect(readFileSync(launcher)).toEqual(bytes);
        expect(
          JSON.parse(
            readFileSync(
              path.join(
                f.root,
                `coordinator-boot-registration-${request.execution!.generation}.json`,
              ),
              "utf8",
            ),
          ),
        ).toMatchObject({
          requestId: request.id,
          planSha256: request.planSha256,
          generation: request.execution!.generation,
        });
        if (!succeeds) throw new Error("Native registration result lost");
      },
      requireHeldClaim: async () => {
        expect(f.service().list()[0]).toEqual(request);
      },
      probeRegistered: async () => {
        verified++;
      },
    };
    const verifyArtifacts = async () => {};
    if (succeeds) await registerBootstrapRecovery(input, verifyArtifacts);
    else
      await expect(registerBootstrapRecovery(input, verifyArtifacts)).rejects.toThrow(
        "result lost",
      );
    expect(registrations).toBe(1);
    expect(verified).toBe(succeeds ? 1 : 0);
    await expect(registerBootstrapRecovery(input, verifyArtifacts)).rejects.toThrow();
    expect(registrations).toBe(1);
    expect(statSync(f.plan.bootRecovery!.installedLauncher).nlink).toBe(1);
  },
);

async function claimedStartupRegistration() {
  const f = bootRecoveryFixture();
  const bytes = Buffer.from("prepared fixture launcher");
  const source = path.join(f.root, "prepared.plist");
  writeFileSync(source, bytes, { mode: 0o600 });
  f.plan.state.directory = f.root;
  f.plan.bootRecovery!.launcher = {
    path: source,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  f.plan.bootRecovery!.installedLauncher = path.join(f.root, "selected.plist");
  const pending = await f
    .service()
    .prepare({ id: f.id, reason: "Restore after login", plan: f.plan });
  const approved = await f
    .service()
    .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  return { f, request: await f.service().claimDispatch(pickDecision(approved)) };
}

/** Simulated clock: a full ownership check rehashes the release tree (8 to
 * 17 seconds on the Host), the lock-only check spawns one small helper. */
function startupReadinessClock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    wait: async (ms: number) => {
      now += ms;
    },
  };
}

test("startup registration waits for a slow launchd spawn with cheap ownership polls", async () => {
  const { f, request } = await claimedStartupRegistration();
  const clock = startupReadinessClock();
  const events: string[] = [];
  let registeredAt: number | undefined;
  await registerBootstrapRecovery(
    {
      request,
      writableMountRoots: [],
      requireClaim: async () => {
        clock.advance(12_000);
        expect(f.service().list()[0]).toEqual(request);
        events.push("full");
      },
      requireHeldClaim: async () => {
        clock.advance(60);
        expect(f.service().list()[0]).toEqual(request);
        events.push("held");
      },
      verifyServiceAbsent: async () => {},
      register: async () => {
        registeredAt = clock.now();
        events.push("register");
      },
      probeRegistered: async () => {
        // Observed on the Host: launchd spawned the job 58 seconds after bootstrap.
        if (clock.now() - registeredAt! < 58_000) throw new Error("Service is not running yet");
        events.push("ready");
      },
      readiness: clock,
    },
    async () => {},
  );
  const registration = events.indexOf("register");
  expect(events[registration - 1]).toBe("full");
  expect(events.slice(-2)).toEqual(["ready", "full"]);
  const waiting = events.slice(registration + 1, -2);
  expect(waiting.length).toBeGreaterThan(50);
  expect(new Set(waiting)).toEqual(new Set(["held"]));
});

test("startup readiness stays bounded and fails closed on ownership loss", async () => {
  const { request } = await claimedStartupRegistration();
  const clock = startupReadinessClock();
  let full = 0;
  let probes = 0;
  const input = {
    request,
    writableMountRoots: [],
    requireClaim: async () => {
      full++;
    },
    requireHeldClaim: async () => {},
    verifyServiceAbsent: async () => {},
    register: async () => {},
    probeRegistered: async () => {
      probes++;
      throw new Error("Service never started");
    },
    readiness: clock,
  };
  await expect(registerBootstrapRecovery(input, async () => {})).rejects.toThrow(
    "did not establish readiness",
  );
  expect(clock.now()).toBeGreaterThanOrEqual(BOOT_RECOVERY_READINESS_TIMEOUT_MS);
  expect(clock.now()).toBeLessThan(BOOT_RECOVERY_READINESS_TIMEOUT_MS + 2_000);
  // Every full check precedes registration; none follows an unready service.
  expect(full).toBe(4);

  const lost = await claimedStartupRegistration();
  probes = 0;
  await expect(
    registerBootstrapRecovery(
      {
        ...input,
        request: lost.request,
        requireHeldClaim: async () => {
          if (probes > 2) throw new Error("Bootstrap ownership lost");
        },
      },
      async () => {},
    ),
  ).rejects.toThrow("ownership lost");
  expect(probes).toBe(3);
  expect(full).toBe(8);
});

test("startup cleanup keeps unresolved and altered launchers and removes only exact completed work", async () => {
  const f = bootRecoveryFixture();
  const bytes = Buffer.from("approved startup launcher");
  const selected = path.join(f.root, "selected.plist");
  writeFileSync(selected, bytes, { mode: 0o600 });
  f.plan.bootRecovery!.installedLauncher = selected;
  f.plan.bootRecovery!.launcher.sha256 = createHash("sha256").update(bytes).digest("hex");
  const pending = await f
    .service()
    .prepare({ id: f.id, reason: "Restore after login", plan: f.plan });
  const input = { request: pending, writableMountRoots: [], requireTerminal: async () => {} };
  await expect(removeCompletedBootstrapRecovery(input)).rejects.toThrow("remains necessary");
  const completed = {
    ...pending,
    status: "approved" as const,
    execution: {
      generation: randomUUID(),
      stage: "succeeded" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  writeFileSync(selected, "unrelated replacement", { mode: 0o600 });
  await expect(removeCompletedBootstrapRecovery({ ...input, request: completed })).rejects.toThrow(
    "digest changed",
  );
  expect(readFileSync(selected, "utf8")).toBe("unrelated replacement");
  writeFileSync(selected, bytes, { mode: 0o600 });
  await removeCompletedBootstrapRecovery({ ...input, request: completed });
  expect(() => readFileSync(selected)).toThrow();
  await expect(
    removeCompletedBootstrapRecovery({ ...input, request: completed }),
  ).resolves.toBeUndefined();
});

test.each(["rollback_pending", "recovery_required"] as const)(
  "watchdog recognizes a completed rollback from %s without another effect",
  async (stage) => {
    const f = fixture();
    f.plan.automaticRecovery = "restore-previous";
    const pending = await f.prepare();
    const approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
    const request = {
      ...approved,
      execution: {
        generation: randomUUID(),
        stage,
        updatedAt: new Date().toISOString(),
        rollbackAttemptedAt: new Date().toISOString(),
      },
    };
    f.journal.replace([approved], [request]);
    let observations = 0;
    const result = await recoverAbandonedBootstrap(
      f.service(),
      { id: request.id, generation: request.execution.generation },
      {
        withOwnership: async (operation) => operation(),
        verifyExecutorExited: async () => {},
        verifyRollback: async (current) => {
          expect(current).toEqual(request);
          observations++;
        },
        resumePrevious: async () => {
          throw new Error("Unexpected resume");
        },
        restorePrevious: async () => {
          throw new Error("Rollback must not run again");
        },
      },
    );
    expect(observations).toBe(1);
    expect(result.execution?.stage).toBe("rolled_back");
    expect(result.execution?.rollbackAttemptedAt).toBe(request.execution.rollbackAttemptedAt);
  },
);

test.each(["verified fallback", "unverified fallback"])(
  "a real rollback-process crash reopens the retained generation without replay: %s",
  async (outcome) => {
    const f = fixture();
    f.plan.automaticRecovery = "restore-previous";
    const pending = await f.prepare();
    const approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
    const claimed = await f.service().claimDispatch(pickDecision(approved));
    const selected = path.join(f.root, "selected-fixture-runtime");
    const driver = path.join(f.root, "crash-during-rollback.mjs");
    const childIdentity = path.join(f.root, "rollback-child.json");
    const bindingFile = path.join(f.root, "fixture-binding.json");
    writeFileSync(bindingFile, JSON.stringify(f.binding), { mode: 0o600 });
    const source = `
import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {FileBootstrapRequestJournal} from ${JSON.stringify(new URL("./coordinator-bootstrap-journal.ts", import.meta.url).href)};
import {CoordinatorBootstrapRequests} from ${JSON.stringify(new URL("./coordinator-bootstrap.ts", import.meta.url).href)};
import {recoverAbandonedBootstrap} from ${JSON.stringify(new URL("./coordinator-bootstrap-watchdog.ts", import.meta.url).href)};
const root=process.argv[2];
writeFileSync(${JSON.stringify(childIdentity)},JSON.stringify({pid:process.pid}),{mode:0o600});
const binding=JSON.parse(readFileSync(${JSON.stringify(bindingFile)},'utf8'));
const requests=new CoordinatorBootstrapRequests(new FileBootstrapRequestJournal(root),()=>binding,async()=>{});
await recoverAbandonedBootstrap(requests,${JSON.stringify({ id: claimed.id, generation: claimed.execution!.generation })},{
 withOwnership:async operation=>operation(),verifyExecutorExited:async()=>{},
 resumePrevious:async()=>{throw Error('Unexpected resume')},
 restorePrevious:async()=>{
  writeFileSync(${JSON.stringify(selected)},'selected-compatible-fixture',{mode:0o600,flag:'wx'});
  const fd=openSync(${JSON.stringify(selected)},'r');try{fsyncSync(fd)}finally{closeSync(fd)}
  process.kill(process.pid,'SIGKILL');
 }
});
`;
    writeFileSync(driver, source, { mode: 0o600 });
    await expect(
      promisify(execFile)(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), driver, f.root],
        { timeout: 10_000, killSignal: "SIGKILL" },
      ),
    ).rejects.toMatchObject({ signal: "SIGKILL" });
    const child = z
      .object({ pid: z.number().int().positive() })
      .parse(JSON.parse(readFileSync(childIdentity, "utf8")));
    const verifyChildExited = async () => {
      expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    };
    await verifyChildExited();
    const reopened = new FileBootstrapRequestJournal(f.root);
    const interrupted = reopened.read().find((request) => request.id === claimed.id)!;
    expect(interrupted.execution).toMatchObject({
      stage: "rollback_pending",
      generation: claimed.execution!.generation,
      rollbackAttemptedAt: expect.any(String),
    });
    expect(readFileSync(selected, "utf8")).toBe("selected-compatible-fixture");
    const effects = vi.fn(async () => {
      throw new Error("Interrupted rollback must not run twice");
    });
    const observe = vi.fn(async () => {
      expect(readFileSync(selected, "utf8")).toBe("selected-compatible-fixture");
      if (outcome === "unverified fallback") throw new Error("Fixture readiness is not proven");
    });
    const requests = new CoordinatorBootstrapRequests(
      reopened,
      () => f.binding,
      async () => {},
    );
    const result = await recoverAbandonedBootstrap(
      requests,
      { id: claimed.id, generation: claimed.execution!.generation },
      {
        withOwnership: async (operation) => operation(),
        verifyExecutorExited: verifyChildExited,
        verifyRollback: observe,
        resumePrevious: effects,
        restorePrevious: effects,
      },
    );
    expect(result.execution).toMatchObject({
      generation: claimed.execution!.generation,
      rollbackAttemptedAt: interrupted.execution!.rollbackAttemptedAt,
      stage: outcome === "verified fallback" ? "rolled_back" : "recovery_required",
    });
    expect(result.plan).toEqual(claimed.plan);
    expect(result.decisionAt).toBe(claimed.decisionAt);
    expect(observe).toHaveBeenCalledOnce();
    expect(effects).not.toHaveBeenCalled();
    expect(reopened.read().find((request) => request.id === claimed.id)).toEqual(result);
  },
  15_000,
);

test.each(["unhealthy", "changed ownership", "no attempt"])(
  "rollback reconciliation does not invent success: %s",
  async (failure) => {
    const f = fixture();
    f.plan.automaticRecovery = "restore-previous";
    const pending = await f.prepare();
    const approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
    const request = {
      ...approved,
      execution: {
        generation: randomUUID(),
        stage: "recovery_required" as const,
        updatedAt: new Date().toISOString(),
        ...(failure !== "no attempt" ? { rollbackAttemptedAt: new Date().toISOString() } : {}),
      },
    };
    f.journal.replace([approved], [request]);
    let observations = 0;
    const recovery = recoverAbandonedBootstrap(
      f.service(),
      { id: request.id, generation: request.execution.generation },
      {
        withOwnership: async (operation) => operation(),
        verifyExecutorExited: async () => {},
        verifyRollback: async () => {
          observations++;
          if (failure === "unhealthy") throw new Error("Recovery identity does not match");
          f.journal.replace([request], [{ ...request, revision: randomUUID() }]);
        },
        resumePrevious: async () => {
          throw new Error("Unexpected resume");
        },
      },
    );
    if (failure === "changed ownership")
      await expect(recovery).rejects.toThrow("ownership changed");
    else expect((await recovery).execution?.stage).toBe("recovery_required");
    expect(observations).toBe(failure === "no attempt" ? 0 : 1);
  },
);

function automaticCoordinatorFixture() {
  const f = bootRecoveryFixture();
  f.plan.automaticRecovery = "restore-compatible";
  f.plan.compatibleRecovery = f.plan.previous;
  let now = Date.parse("2026-10-15T00:00:01Z");
  let authority: { credentialBinding: string; policyActivatedAt: string } | null = {
    credentialBinding: "b".repeat(64),
    policyActivatedAt: "2026-10-15T00:00:00Z",
  };
  let verify = async () => {};
  const service = () =>
    new CoordinatorBootstrapRequests(
      f.journal,
      () => f.binding,
      () => verify(),
      () => now,
      () => authority,
    );
  const prepare = () =>
    service().prepare({ id: f.id, reason: "Automatic coordinator fixture", plan: f.plan });
  return {
    ...f,
    service,
    prepare,
    submit: () =>
      service().prepareAutomatic(
        { id: f.id, reason: "Automatic coordinator fixture", plan: f.plan },
        {
          credentialBinding: "b".repeat(64),
          policyActivatedAt: "2026-10-15T00:00:00Z",
        },
      ),
    advance: (milliseconds = 30_000) => {
      now += milliseconds;
    },
    disable: () => {
      authority = null;
    },
    rotate: () => {
      authority = { ...authority!, credentialBinding: "c".repeat(64) };
    },
    setVerify: (value: typeof verify) => {
      verify = value;
    },
  };
}

test("automatic coordinator status distinguishes checks, cancellation and uncertain launch without private authority", async () => {
  const f = automaticCoordinatorFixture();
  const now = Date.parse("2026-10-15T00:00:01Z");
  const pending = await f.submit();
  expect(coordinatorAutomaticStatus(pending, now)).toEqual({
    authorization: "host-policy",
    state: "waiting",
    observedAt: new Date(now).toISOString(),
  });
  const checking = f
    .service()
    .reserveAutomaticReconciliation(automaticCoordinatorIdentity(pending))!;
  expect(coordinatorAutomaticStatus(checking, now)).toMatchObject({
    state: "checking",
    attempt: 1,
  });
  f.service().finishAutomaticReconciliation(checking.id, checking.automaticCheck);
  const retrying = f.service().list()[0]!;
  expect(coordinatorAutomaticStatus(retrying, now)).toMatchObject({
    state: "retry-wait",
    attempt: 1,
  });
  expect(
    coordinatorAutomaticStatus(
      { ...retrying, automaticCheck: { ...retrying.automaticCheck!, attempt: 3 } },
      now,
    ),
  ).toMatchObject({ state: "review-required", attempt: 3 });
  const approved = await f.service().approveAutomatic(automaticCoordinatorIdentity(retrying));
  expect(coordinatorAutomaticStatus(approved, now)).toMatchObject({
    state: "cancellation-window",
    dispatchAfter: approved.automaticApproval!.dispatchAfter,
  });
  f.advance();
  expect(coordinatorAutomaticStatus(approved, now + 30_000)).toMatchObject({
    state: "dispatch-ready",
  });
  const reserved = f.service().reserveAutomaticDispatch(automaticCoordinatorIdentity(approved));
  expect(coordinatorAutomaticStatus(reserved, now + 30_000)).toMatchObject({
    state: "launch-unconfirmed",
  });
  const message = {
    type: "installation.bootstrap.list_requests.request" as const,
    requestId: "status",
  };
  const legacy = await handleBootstrapReview(message, f.service());
  expect(legacy.payload.requests?.[0]).not.toHaveProperty("automaticStatus");
  const modern = await handleBootstrapReview({ ...message, automaticStatus: true }, f.service());
  expect(modern.payload.requests?.[0]?.automaticStatus).toMatchObject({
    state: "launch-unconfirmed",
  });
  expect(JSON.stringify(modern)).not.toContain("credentialBinding");
  expect(modern.payload.requests?.[0]).not.toHaveProperty("automaticCheck");
  expect(CoordinatorBootstrapRequestSchema.parse(legacy.payload.requests?.[0]).id).toBe(pending.id);
});

test("coordinator reconciliation budgets survive reopening and delayed responses", async () => {
  const f = automaticCoordinatorFixture();
  let request = await f.submit();
  expect(() => f.service().requireAutomaticReconciliation(request)).toThrow("bounded");
  for (const attempt of [1, 2, 3]) {
    const reserved = f
      .service()
      .reserveAutomaticReconciliation(automaticCoordinatorIdentity(request));
    if (!reserved) throw new Error("Missing reconciliation reservation");
    expect(reserved.automaticCheck).toMatchObject({
      phase: "approval",
      attempt,
      outcome: "running",
    });
    expect(() => f.service().requireAutomaticReconciliation(reserved)).not.toThrow();
    expect(
      f.service().reserveAutomaticReconciliation(automaticCoordinatorIdentity(reserved)),
    ).toBeNull();
    f.service().finishAutomaticReconciliation(reserved.id, reserved.automaticCheck);
    request = f.service().list()[0]!;
    expect(request.automaticCheck).toMatchObject({
      phase: "approval",
      attempt,
      outcome: "unconfirmed",
    });
    expect(() => f.service().requireAutomaticReconciliation(request)).toThrow("bounded");
    expect(
      f.service().reserveAutomaticReconciliation(automaticCoordinatorIdentity(request)),
    ).toBeNull();
    f.advance(60_000);
  }
  expect(
    f.service().reserveAutomaticReconciliation(automaticCoordinatorIdentity(request)),
  ).toBeNull();
});

test("a crashed reconciliation retains its budget and cannot overwrite approval or launch", async () => {
  const f = automaticCoordinatorFixture();
  const pending = await f.submit();
  const first = f.service().reserveAutomaticReconciliation(automaticCoordinatorIdentity(pending))!;
  f.advance(16 * 60_000);
  expect(() => f.service().requireAutomaticReconciliation(first)).toThrow("bounded");
  const second = f.service().reserveAutomaticReconciliation(automaticCoordinatorIdentity(first))!;
  expect(second.automaticCheck?.attempt).toBe(2);
  f.service().finishAutomaticReconciliation(first.id, first.automaticCheck);
  expect(f.service().list()).toEqual([second]);
  const approved = await f.service().approveAutomatic(automaticCoordinatorIdentity(second));
  f.service().finishAutomaticReconciliation(second.id, second.automaticCheck);
  expect(f.service().list()).toEqual([approved]);
  expect(
    f.service().reserveAutomaticReconciliation(automaticCoordinatorIdentity(approved)),
  ).toBeNull();
  f.advance();
  const dispatch = f
    .service()
    .reserveAutomaticReconciliation(automaticCoordinatorIdentity(approved))!;
  expect(dispatch.automaticCheck).toMatchObject({ phase: "dispatch", attempt: 1 });
  expect(dispatch.automaticApproval?.requestRevision).toBe(dispatch.revision);
  const launched = f.service().reserveAutomaticDispatch(automaticCoordinatorIdentity(dispatch));
  f.service().finishAutomaticReconciliation(dispatch.id, dispatch.automaticCheck);
  expect(f.service().list()).toEqual([launched]);
  expect(
    f.service().reserveAutomaticReconciliation(automaticCoordinatorIdentity(launched)),
  ).toBeNull();
});

test("concurrent coordinator ticks share durable admission and retain failed connection attempts", async () => {
  const f = automaticCoordinatorFixture();
  await f.submit();
  const { config } = coordinatorSubmissionFixture();
  const connected = Promise.withResolvers<never>();
  const connect = vi.fn(() => connected.promise);
  const first = reconcileInstallationCoordinator(config, f.service(), connect);
  await reconcileInstallationCoordinator(config, f.service(), connect);
  expect(connect).toHaveBeenCalledOnce();
  connected.reject(new Error("Fixture disconnected"));
  await expect(first).rejects.toThrow("Fixture disconnected");
  expect(f.service().list()[0]?.automaticCheck).toMatchObject({
    attempt: 1,
    outcome: "unconfirmed",
  });
  await reconcileInstallationCoordinator(config, f.service(), connect);
  expect(connect).toHaveBeenCalledOnce();
});

test("coordinator ticks advance approval and dispatch once without consuming the cancellation interval", async () => {
  const f = automaticCoordinatorFixture();
  await f.submit();
  const { config } = coordinatorSubmissionFixture();
  const approve = vi.fn(async () => {
    const request = f.service().list()[0]!;
    f.service().requireAutomaticReconciliation(request);
    return [await f.service().approveAutomatic(automaticCoordinatorIdentity(request))];
  });
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ reconcileAutomaticCoordinatorBootstrap: approve, close }));
  await reconcileInstallationCoordinator(config, f.service(), connect);
  const approved = f.service().list()[0]!;
  expect(approved.status).toBe("approved");
  await reconcileInstallationCoordinator(config, f.service(), connect);
  expect(connect).toHaveBeenCalledOnce();
  f.advance();
  const dispatch = vi.fn(async () => {
    const request = f.service().list()[0]!;
    f.service().requireAutomaticReconciliation(request);
    return [f.service().reserveAutomaticDispatch(automaticCoordinatorIdentity(request))];
  });
  const dispatchConnection = vi.fn(async () => ({
    reconcileAutomaticCoordinatorBootstrap: dispatch,
    close,
  }));
  await reconcileInstallationCoordinator(config, f.service(), dispatchConnection);
  await reconcileInstallationCoordinator(config, f.service(), dispatchConnection);
  expect(dispatchConnection).toHaveBeenCalledOnce();
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(approved.id);
  expect(close).toHaveBeenCalledTimes(2);
  expect(f.service().list()[0]?.automaticDispatch?.approvedRevision).not.toBeUndefined();
});

test("coordinator automation requires protected Host provenance and waits before exact dispatch", async () => {
  const f = automaticCoordinatorFixture();
  const submitted = await f.submit();
  expect(await f.submit()).toEqual(submitted);
  const approved = await f.service().approveAutomatic(automaticCoordinatorIdentity(submitted));
  expect(approved.automaticApproval?.requestRevision).toBe(approved.revision);
  await expect(f.service().claimDispatch(automaticCoordinatorIdentity(approved))).rejects.toThrow(
    "not yet eligible",
  );
  const visible = await handleBootstrapReview(
    {
      type: "installation.bootstrap.list_requests.request",
      requestId: "review",
      bootRecovery: true,
      compatibleRecovery: true,
    },
    f.service(),
  );
  expect(visible.payload.requests?.[0]).not.toHaveProperty("automaticApproval");
  expect(visible.payload.requests?.[0]).not.toHaveProperty("automaticSubmission");
  f.advance();
  const reserved = f.service().reserveAutomaticDispatch(automaticCoordinatorIdentity(approved));
  const claimed = await f.service().claimDispatch(automaticCoordinatorIdentity(reserved));
  expect(claimed.execution?.stage).toBe("claimed");
  f.disable();
  f.service().revokeAutomatic();
  expect(f.service().list()[0]).toEqual(claimed);
  await expect(f.service().claimDispatch(automaticCoordinatorIdentity(approved))).rejects.toThrow();
});

test.each(["pending", "approved", "validation", "claim"])(
  "coordinator permission revocation fences the %s boundary",
  async (boundary) => {
    const f = automaticCoordinatorFixture();
    const submitted = await f.submit();
    if (boundary === "validation") {
      f.setVerify(async () => {
        f.disable();
        f.service().revokeAutomatic();
      });
      await expect(
        f.service().approveAutomatic(automaticCoordinatorIdentity(submitted)),
      ).rejects.toThrow("revoked");
    } else if (boundary === "pending") {
      f.disable();
      f.service().revokeAutomatic();
      await expect(
        f.service().approveAutomatic(automaticCoordinatorIdentity(submitted)),
      ).rejects.toThrow("pending");
    } else {
      const approved = await f.service().approveAutomatic(automaticCoordinatorIdentity(submitted));
      f.advance();
      if (boundary === "claim")
        f.setVerify(async () => {
          f.disable();
          f.service().revokeAutomatic();
        });
      else {
        f.rotate();
        f.service().revokeAutomatic();
      }
      await expect(
        f.service().claimDispatch(automaticCoordinatorIdentity(approved)),
      ).rejects.toThrow();
    }
    expect(f.service().list()[0]).toMatchObject({ status: "canceled" });
    expect(f.service().list()[0]).not.toHaveProperty("execution");
  },
);

test("manual coordinator approval remains exact when automatic permission is revoked", async () => {
  const f = automaticCoordinatorFixture();
  const submitted = await f.submit();
  const approved = await f.service().decide(
    {
      id: submitted.id,
      revision: submitted.revision,
      planSha256: submitted.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  f.disable();
  f.service().revokeAutomatic();
  expect(f.service().list()[0]).toEqual(approved);
  expect(approved).not.toHaveProperty("automaticApproval");
  expect(
    (await f.service().claimDispatch(automaticCoordinatorIdentity(approved))).execution?.stage,
  ).toBe("claimed");
});

function automaticCoordinatorIdentity(request: CoordinatorBootstrapRequest) {
  return { id: request.id, revision: request.revision, planSha256: request.planSha256 };
}

test.each(["no-startup", "configuration", "other-service", "tooling"])(
  "automatic coordinator authority refuses %s changes",
  async (change) => {
    const f = automaticCoordinatorFixture();
    if (change === "no-startup") delete f.plan.bootRecovery;
    if (change === "configuration")
      f.plan.candidate = {
        ...f.plan.candidate,
        configuration: { ...f.plan.candidate.configuration, sha256: "f".repeat(64) },
      };
    if (change === "other-service") f.plan.nativeHelperConfiguration = null;
    if (change === "tooling") f.plan.sourceUpdateTooling = true;
    const submitted = await f.submit();
    await expect(
      f.service().approveAutomatic(automaticCoordinatorIdentity(submitted)),
    ).rejects.toThrow();
    expect(f.service().list()[0].status).toBe("pending");
    expect(f.service().list()[0]).not.toHaveProperty("automaticApproval");
  },
);

test("generic coordinator preparation cannot inject provenance or grant old requests automatically", async () => {
  const f = automaticCoordinatorFixture();
  await expect(
    f.service().prepare({
      id: f.id,
      reason: "Forged provenance",
      plan: f.plan,
      automaticSubmission: {
        credentialBinding: "b".repeat(64),
        policyActivatedAt: "2026-10-15T00:00:00Z",
        submittedAt: "2026-10-15T00:00:01Z",
      },
    }),
  ).rejects.toThrow();
  const pending = await f.prepare();
  const later = new CoordinatorBootstrapRequests(
    f.journal,
    () => f.binding,
    async () => {},
    () => Date.parse("2026-10-15T00:00:30Z"),
    () => ({ credentialBinding: "b".repeat(64), policyActivatedAt: "2026-10-15T00:00:20Z" }),
  );
  await expect(
    later.prepareAutomatic(
      { id: f.id, reason: pending.reason, plan: f.plan },
      {
        credentialBinding: "b".repeat(64),
        policyActivatedAt: "2026-10-15T00:00:20Z",
      },
    ),
  ).rejects.toThrow("cannot acquire automatic authority");
  expect(later.list()[0]).toEqual(pending);
});

test("owner cancellation wins over in-flight automatic coordinator validation", async () => {
  const f = automaticCoordinatorFixture();
  const submitted = await f.submit();
  f.setVerify(async () => {
    await f
      .service()
      .decide({ ...automaticCoordinatorIdentity(submitted), decision: "cancel" }, ownerPassword);
  });
  await expect(
    f.service().approveAutomatic(automaticCoordinatorIdentity(submitted)),
  ).rejects.toThrow();
  expect(f.service().list()[0].status).toBe("canceled");
  expect(f.service().list()[0]).not.toHaveProperty("automaticApproval");
});

test("automatic coordinator launch reservation survives lost replies and permits cancellation", async () => {
  const f = automaticCoordinatorFixture();
  const submitted = await f.submit();
  const approved = await f.service().approveAutomatic(automaticCoordinatorIdentity(submitted));
  expect(() =>
    f.service().reserveAutomaticDispatch(automaticCoordinatorIdentity(approved)),
  ).toThrow("not yet eligible");
  f.advance();
  await expect(f.service().claimDispatch(automaticCoordinatorIdentity(approved))).rejects.toThrow(
    "reserve its native launch",
  );
  const reserved = f.service().reserveAutomaticDispatch(automaticCoordinatorIdentity(approved));
  expect(reserved.automaticDispatch?.approvedRevision).toBe(approved.revision);
  expect(reserved).not.toHaveProperty("execution");
  const legacy = await handleBootstrapReview(
    {
      type: "installation.bootstrap.list_requests.request",
      requestId: "legacy-reservation",
      bootRecovery: true,
      compatibleRecovery: true,
    },
    f.service(),
  );
  expect(legacy.payload.error).toBeNull();
  expect(legacy.payload.requests?.[0]).not.toHaveProperty("automaticDispatch");

  expect(() =>
    f.service().reserveAutomaticDispatch(automaticCoordinatorIdentity(approved)),
  ).toThrow("already changed or reserved");
  expect(() =>
    f.service().reserveAutomaticDispatch(automaticCoordinatorIdentity(reserved)),
  ).toThrow("already changed or reserved");
  const canceled = await f
    .service()
    .decide({ ...automaticCoordinatorIdentity(reserved), decision: "cancel" }, ownerPassword);
  expect(canceled.status).toBe("canceled");
  await expect(f.service().claimDispatch(automaticCoordinatorIdentity(reserved))).rejects.toThrow();
});

test("coordinator revocation after launch reservation prevents the native claim", async () => {
  const f = automaticCoordinatorFixture();
  const submitted = await f.submit();
  const approved = await f.service().approveAutomatic(automaticCoordinatorIdentity(submitted));
  f.advance();
  const reserved = f.service().reserveAutomaticDispatch(automaticCoordinatorIdentity(approved));
  f.disable();
  f.service().revokeAutomatic();
  expect(f.service().list()[0]).toMatchObject({
    status: "canceled",
    automaticDispatch: reserved.automaticDispatch,
  });
  await expect(f.service().claimDispatch(automaticCoordinatorIdentity(reserved))).rejects.toThrow();
});

test("automatic coordinator RPC cannot mint provenance and refuses unavailable services", async () => {
  const f = automaticCoordinatorFixture();
  const pending = await f.prepare();
  const message = CoordinatorBootstrapReconcileAutomaticRequestSchema.parse({
    type: "installation.bootstrap.reconcile_automatic.request",
    requestId: "reconcile",
    id: pending.id,
    bootRecovery: true,
    compatibleRecovery: true,
  });
  expect(
    CoordinatorBootstrapReconcileAutomaticRequestSchema.safeParse({
      ...message,
      credentialBinding: "b".repeat(64),
    }).success,
  ).toBe(false);
  const unavailable = await handleBootstrapReview(message, f.service());
  expect(unavailable.payload.error).toContain("unavailable");
  const requests = f.service();
  const service = Object.assign(requests, {
    automatic: {
      reconcile: async (id: string) => {
        const current = requests.list().find((item) => item.id === id)!;
        return requests.approveAutomatic(automaticCoordinatorIdentity(current));
      },
    },
  });
  const forged = await handleBootstrapReview(message, service);
  expect(forged.payload.error).toContain("missing or revoked");
  expect(requests.list()[0].status).toBe("pending");
  await expect(f.submit()).rejects.toThrow("cannot acquire automatic authority");
  expect(requests.list()[0]).toEqual(pending);
});

test.each(["disable", "rotate"] as const)(
  "automatic preparation rejects %s during native validation without a partial request",
  async (change) => {
    const f = automaticCoordinatorFixture();
    f.setVerify(async () => {
      f[change]();
    });
    await expect(f.submit()).rejects.toThrow("permission required");
    expect(f.service().list()).toEqual([]);
  },
);

function coordinatorSubmissionFixture() {
  const f = fixture();
  const config: Parameters<typeof submitInstallationCoordinator>[0]["config"] = {
    stateDir: f.root,
    public: {
      version: 1,
      installationId: f.plan.installationId,
      origin: "https://fixture.example.test",
      environments: [],
    },
    hostAgentTokenHash: "a".repeat(64),
    containerAgentTokenHash: "b".repeat(64),
    ownerPasswordHash: ownerHash,
    listenPort: 6766,
    webDistDir: f.root,
    host: {
      endpoint: "127.0.0.1:6768",
      password: "fixture-host",
      launchdService: "gui/501/local.vorteo.fixture.host",
    },
    container: { endpoint: "127.0.0.1:6769", password: "fixture-dev" },
  };
  const input = { id: randomUUID(), reason: "Scoped coordinator preparation", plan: f.plan };
  const preference = new DaemonAutomation(f.root, false);
  return { f, config, input, preference };
}

test("scoped Host submission sends an exact proof and returns only its review receipt", async () => {
  const { f, config, input, preference } = coordinatorSubmissionFixture();
  preference.change({ expectedRevision: null, service: "coordinator", enabled: true });
  const pending = await f.service().prepare(input);
  const prepare = vi.fn(async () => [pending]);
  const close = vi.fn(async () => {});
  const receipt = await submitInstallationCoordinator(
    { config, input, requester: "host-agent", requireOwnerApproval: false },
    async () => ({ prepareCoordinatorBootstrap: prepare, close }),
  );
  expect(prepare).toHaveBeenCalledExactlyOnceWith(input, {
    submissionProof: signCoordinatorSubmission(config, input),
  });
  expect(close).toHaveBeenCalledOnce();
  expect(receipt).toEqual({
    id: pending.id,
    revision: pending.revision,
    status: "pending",
    approvalUrl: `https://fixture.example.test/settings/general?installation=1&bootstrap=${pending.id}`,
  });
});

test.each([
  { requester: "container-agent", requireOwnerApproval: false, enabled: true },
  { requester: "host-agent", requireOwnerApproval: true, enabled: true },
  { requester: "host-agent", requireOwnerApproval: false, enabled: false },
] as const)(
  "coordinator submission preserves manual review: %j",
  async ({ requester, requireOwnerApproval, enabled }) => {
    const { f, config, input, preference } = coordinatorSubmissionFixture();
    preference.change({ expectedRevision: null, service: "coordinator", enabled });
    const pending = await f.service().prepare(input);
    const prepare = vi.fn(async () => [pending]);
    const close = vi.fn(async () => {});
    await submitInstallationCoordinator(
      { config, input, requester, requireOwnerApproval },
      async () => ({ prepareCoordinatorBootstrap: prepare, close }),
    );
    expect(prepare).toHaveBeenCalledExactlyOnceWith(input, { submissionProof: undefined });
    expect(close).toHaveBeenCalledOnce();
  },
);

test("unsupported authenticated coordinator submission closes without retrying as manual", async () => {
  const { config, input, preference } = coordinatorSubmissionFixture();
  preference.change({ expectedRevision: null, service: "coordinator", enabled: true });
  const prepare = vi.fn(async () => {
    throw new Error("Host capability unavailable");
  });
  const close = vi.fn(async () => {});
  await expect(
    submitInstallationCoordinator(
      { config, input, requester: "host-agent", requireOwnerApproval: false },
      async () => ({ prepareCoordinatorBootstrap: prepare, close }),
    ),
  ).rejects.toThrow("Host capability unavailable");
  expect(prepare).toHaveBeenCalledExactlyOnceWith(input, {
    submissionProof: signCoordinatorSubmission(config, input),
  });
  expect(close).toHaveBeenCalledOnce();
});

test("scoped coordinator proof binds the exact preparation, policy and credentials", () => {
  const f = fixture();
  const config: Parameters<typeof signCoordinatorSubmission>[0] = {
    stateDir: f.root,
    public: {
      version: 1,
      installationId: f.plan.installationId,
      origin: "https://fixture.example.test",
      environments: [],
    },
    hostAgentTokenHash: "a".repeat(64),
    containerAgentTokenHash: "b".repeat(64),
    ownerPasswordHash: ownerHash,
  };
  const input = { id: randomUUID(), reason: "Exact authenticated preparation", plan: f.plan };
  expect(() => signCoordinatorSubmission(config, input)).toThrow("disabled");
  const preference = new DaemonAutomation(f.root, false);
  const enabled = preference.change({
    expectedRevision: null,
    service: "coordinator",
    enabled: true,
  });
  const proof = signCoordinatorSubmission(config, input);
  expect(verifyCoordinatorSubmission(config, input, proof)).toEqual(
    coordinatorAutomaticAuthority(config),
  );
  expect(signCoordinatorSubmission(config, input)).toEqual(proof);
  for (const changed of [
    { ...input, id: randomUUID() },
    { ...input, reason: "Different reason" },
    {
      ...input,
      plan: { ...input.plan, candidate: { ...input.plan.candidate, sourceCommit: "f".repeat(40) } },
    },
  ])
    expect(() => verifyCoordinatorSubmission(config, changed, proof)).toThrow();
  for (const key of ["hostAgentTokenHash", "containerAgentTokenHash", "ownerPasswordHash"] as const)
    expect(() =>
      verifyCoordinatorSubmission({ ...config, [key]: "c".repeat(64) }, input, proof),
    ).toThrow("Exact scoped Host");
  expect(() =>
    verifyCoordinatorSubmission(config, input, { ...proof, signature: "0".repeat(64) }),
  ).toThrow("Exact scoped Host");
  preference.change({ expectedRevision: enabled.revision, service: "coordinator", enabled: false });
  expect(() => verifyCoordinatorSubmission(config, input, proof)).toThrow("disabled");
});

test("same-millisecond permission reactivation retains a distinct epoch across reopening", () => {
  const f = fixture();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-15T00:00:00Z"));
  try {
    const preference = new DaemonAutomation(f.root, false);
    const first = preference.change({
      expectedRevision: null,
      service: "coordinator",
      enabled: true,
    });
    const disabled = preference.change({
      expectedRevision: first.revision,
      service: "coordinator",
      enabled: false,
    });
    const enabled = new DaemonAutomation(f.root, false).change({
      expectedRevision: disabled.revision,
      service: "coordinator",
      enabled: true,
    });
    expect(Date.parse(enabled.services!.coordinator!)).toBeGreaterThan(
      Date.parse(first.services!.coordinator!),
    );
    expect(enabled.services!.host).toBe(first.services!.host);
    expect(preference.read()).not.toHaveProperty("changedAt");
  } finally {
    clock.mockRestore();
  }
});

test("authenticated preparation RPC validates proof before atomically recording provenance", async () => {
  const f = fixture();
  const config: Parameters<typeof signCoordinatorSubmission>[0] = {
    stateDir: f.root,
    public: {
      version: 1,
      installationId: f.plan.installationId,
      origin: "https://fixture.example.test",
      environments: [],
    },
    hostAgentTokenHash: "a".repeat(64),
    containerAgentTokenHash: "b".repeat(64),
    ownerPasswordHash: ownerHash,
  };
  new DaemonAutomation(f.root, false).change({
    expectedRevision: null,
    service: "coordinator",
    enabled: true,
  });
  const input = { id: randomUUID(), reason: "Scoped preparation", plan: f.plan };
  const proof = signCoordinatorSubmission(config, input);
  const requests = new CoordinatorBootstrapRequests(
    f.journal,
    () => f.binding,
    async () => {},
    Date.now,
    () => coordinatorAutomaticAuthority(config),
  );
  const message = {
    type: "installation.bootstrap.prepare.request" as const,
    requestId: "authenticated-preparation",
    input,
    submissionProof: proof,
  };
  expect((await handleBootstrapReview(message, requests)).payload.error).toContain("unavailable");
  expect(requests.list()).toEqual([]);
  const service = Object.assign(requests, {
    automatic: {
      prepare: async (value: typeof input, supplied: typeof proof) =>
        requests.prepareAutomatic(value, verifyCoordinatorSubmission(config, value, supplied)),
      reconcile: async () => {
        throw new Error("No dispatch from preparation");
      },
    },
  });
  const forged = await handleBootstrapReview(
    { ...message, submissionProof: { ...proof, signature: "0".repeat(64) } },
    service,
  );
  expect(forged.payload.error).toContain("Exact scoped Host");
  expect(requests.list()).toEqual([]);
  const prepared = await handleBootstrapReview(message, service);
  expect(prepared.payload.error).toBeNull();
  expect(prepared.payload.requests?.[0].status).toBe("pending");
  expect(prepared.payload.requests?.[0]).not.toHaveProperty("automaticSubmission");
  const retained = requests.list()[0];
  expect(retained.automaticSubmission).toMatchObject(coordinatorAutomaticAuthority(config)!);
  expect(retained).not.toHaveProperty("execution");
  expect((await handleBootstrapReview(message, service)).payload.error).toBeNull();
  expect(requests.list()).toEqual([retained]);
});

test.each(["ready", "legacy", "missing-review", "offline"] as const)(
  "coordinator readiness uses connected Host features and closes its probe (%s)",
  async (mode) => {
    const { config } = coordinatorSubmissionFixture();
    const close = vi.fn(async () => {});
    const result = await inspectInstallationCoordinator(config, async () => {
      if (mode === "offline") throw new Error("PRIVATE CONNECTION DETAIL");
      return {
        close,
        getLastServerInfoMessage: () => ({
          status: "server_info",
          serverId: "host-id",
          hostname: null,
          version: null,
          features: {
            coordinatorBootstrapReview: mode !== "missing-review",
            coordinatorBootstrapAuthenticatedSubmission: mode === "ready",
            coordinatorBootstrapAutomaticReconciliation: mode === "ready",
            coordinatorBootstrapAutomaticStatus: mode === "ready",
            coordinatorBootstrapBootRecovery: mode === "ready",
            coordinatorBootstrapCompatibleRecovery: mode === "ready",
            coordinatorBootstrapRecoveryBootPlan: mode === "ready",
          },
        }),
      };
    });
    expect(result.available).toBe(mode === "ready" || mode === "legacy");
    expect(result.automaticAvailable).toBe(mode === "ready");
    expect(close).toHaveBeenCalledTimes(mode === "offline" ? 0 : 1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE CONNECTION DETAIL");
  },
);

test("completed observation permits normal state writes but retains exact transfer provenance", async () => {
  const { verifyCompletedBootstrapState } = await import("./coordinator-bootstrap-state.js");
  const f = fixture();
  f.plan.state = {
    directory: f.root,
    restartJournal: path.join(f.root, "restart-jobs.json"),
    ownerSessions: path.join(f.root, "owner-sessions.json"),
  };
  const pending = await f.prepare();
  const request = {
    ...pending,
    execution: {
      generation: randomUUID(),
      stage: "frozen" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  writeFileSync(f.plan.state.restartJournal, "[]", { mode: 0o600 });
  writeFileSync(f.plan.state.ownerSessions, "[]", { mode: 0o600 });
  const context = { request, writableMountRoots: [], childPids: [] };
  await preserveBootstrapState(context);
  await expect(verifyCompletedBootstrapState(context)).rejects.toThrow("succeeded execution");
  const completed = {
    ...context,
    request: { ...request, execution: { ...request.execution, stage: "succeeded" as const } },
  };
  writeFileSync(f.plan.state.restartJournal, "[ ]", { mode: 0o600 });
  writeFileSync(
    f.plan.state.ownerSessions,
    JSON.stringify([{ hash: "new-session", expiresAt: 9999999999999 }]),
    { mode: 0o600 },
  );
  await expect(verifyBootstrapState(completed)).rejects.toThrow("no longer matches");
  await expect(verifyCompletedBootstrapState(completed)).resolves.toBeUndefined();
  writeFileSync(f.plan.state.restartJournal, "[{}]", { mode: 0o600 });
  await expect(verifyCompletedBootstrapState(completed)).rejects.toThrow();
  writeFileSync(f.plan.state.restartJournal, "[]", { mode: 0o600 });
  const file = path.join(f.root, `coordinator-transfer-${request.execution.generation}.json`);
  const original = readFileSync(file, "utf8");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(original), requestId: randomUUID() }), {
    mode: 0o600,
  });
  await expect(verifyCompletedBootstrapState(completed)).rejects.toThrow("provenance");
  writeFileSync(file, original, { mode: 0o600 });
  rmSync(f.plan.state.ownerSessions);
  await expect(verifyCompletedBootstrapState(completed)).rejects.toThrow("provenance");
  rmSync(file);
  await expect(verifyCompletedBootstrapState(completed)).rejects.toThrow("receipt is missing");
});

test("lifecycle mutation preserves intervening jobs and rejects stale reservation CAS", () => {
  const f = fixture();
  const queue = new InstallationRestarts(
    { read: () => f.journal.readLifecycle(), write: (jobs) => f.journal.writeLifecycle(jobs) },
    { restart: async () => "unused" },
  );
  const first = queue.request({ target: "host", reason: "First retained job" }, "owner");
  const stale = f.journal.readLifecycle();
  const second = queue.request({ target: "container-daemon", reason: "Intervening job" }, "owner");
  const reopened = new FileBootstrapRequestJournal(f.root);
  const revised = randomUUID();
  reopened.mutateLifecycle(
    (current) => {
      expect(current).toHaveLength(stale.length + 1);
      return current.map((job) => (job.id === first.id ? { ...job, revision: revised } : job));
    },
    (previous, next) => {
      expect(previous.find((job) => job.id === first.id)?.revision).toBe(first.revision);
      expect(next.find((job) => job.id === second.id)).toEqual(second);
    },
  );
  const retained = reopened.readLifecycle();
  const staleRevision = (current: readonly { id: string; revision: string }[]) =>
    current.find((job) => job.id === first.id)?.revision !== first.revision;
  expect(() =>
    f.journal.mutateLifecycle(
      (current) => {
        if (staleRevision(current)) throw new Error("Exact reservation revision changed");
        return [];
      },
      () => undefined,
    ),
  ).toThrow("Exact reservation revision changed");
  expect(f.journal.readLifecycle()).toEqual(retained);
  f.journal.mutateLifecycle(
    (current) => current.filter((job) => job.id !== first.id),
    () => undefined,
  );
  expect(reopened.readLifecycle()).toEqual([second]);
});

test("lifecycle mutation and admission share exclusion and isolate rejected mutations", () => {
  const f = fixture();
  const queue = new InstallationRestarts(
    { read: () => f.journal.readLifecycle(), write: (jobs) => f.journal.writeLifecycle(jobs) },
    { restart: async () => "unused" },
  );
  queue.request({ target: "host", reason: "Retained job" }, "owner");
  const before = f.journal.readLifecycle();
  const competing = () =>
    new FileBootstrapRequestJournal(f.root).mutateLifecycle(
      () => [],
      () => undefined,
    );
  expect(() =>
    f.journal.mutateLifecycle(
      (current) => {
        expect(competing).toThrow("storage is busy");
        current[0].reason = "Only detached update input";
        return [...current];
      },
      (previous, next) => {
        expect(competing).toThrow("storage is busy");
        expect(previous).toEqual(before);
        expect(next[0].reason).toBe("Only detached update input");
        throw new Error("Grant revoked");
      },
    ),
  ).toThrow("Grant revoked");
  expect(f.journal.readLifecycle()).toEqual(before);
});

/** A request whose claim failed before promotion, plus an automatic successor plan. */
async function preFreezeFailureFixture({ promoted = false, ownerReviewed = false } = {}) {
  const f = automaticCoordinatorFixture();
  let approved: CoordinatorBootstrapRequest;
  if (ownerReviewed) {
    const pending = await f.prepare();
    approved = await f
      .service()
      .decide({ ...pickDecision(pending), decision: "approve" }, ownerPassword);
  } else {
    const submitted = await f.submit();
    const automatic = await f.service().approveAutomatic(automaticCoordinatorIdentity(submitted));
    f.advance();
    approved = f.service().reserveAutomaticDispatch(automaticCoordinatorIdentity(automatic));
  }
  const claimed = await f.service().claimDispatch(automaticCoordinatorIdentity(approved));
  const progress = {
    id: claimed.id,
    revision: claimed.revision,
    planSha256: claimed.planSha256,
    generation: claimed.execution!.generation,
  };
  let failed: CoordinatorBootstrapRequest;
  if (promoted) {
    f.service().promoteDispatch(claimed);
    const freezing = f.service().advanceDispatch(progress, "freeze_pending");
    failed = f
      .service()
      .advanceDispatch({ ...progress, revision: freezing.revision }, "recovery_required");
  } else failed = f.service().advanceDispatch(progress, "recovery_required");
  const id = randomUUID();
  const plan: CoordinatorBootstrapPlan = {
    ...structuredClone(f.plan),
    bootRecovery: { ...f.plan.bootRecovery!, requestId: id },
    recoveredFrom: {
      id: failed.id,
      revision: failed.revision,
      generation: failed.execution!.generation,
      planSha256: failed.planSha256,
    },
  };
  const submit = (value = plan) =>
    f
      .service()
      .prepareAutomatic(
        { id, reason: "Automatic successor", plan: value },
        { credentialBinding: "b".repeat(64), policyActivatedAt: "2026-10-15T00:00:00Z" },
      );
  return { ...f, failed, plan, submit };
}

test("an automatic successor closes a failure that never reached promotion", async () => {
  const f = await preFreezeFailureFixture();
  expect(() => f.journal.verifyUnpromotedFailure(f.failed)).not.toThrow();
  const submitted = await f.submit();
  const approved = await f.service().approveAutomatic(automaticCoordinatorIdentity(submitted));
  expect(approved.status).toBe("approved");
  expect(approved.automaticApproval?.requestRevision).toBe(approved.revision);
  expect(approved.plan.recoveredFrom?.id).toBe(f.failed.id);
});

test("an automatic successor cannot close a failure after promotion or for another coordinator process", async () => {
  const promoted = await preFreezeFailureFixture({ promoted: true });
  const afterFreeze = await promoted.submit();
  await expect(
    promoted.service().approveAutomatic(automaticCoordinatorIdentity(afterFreeze)),
  ).rejects.toThrow("require exact owner review");

  const f = await preFreezeFailureFixture();
  const other = await f.submit({
    ...f.plan,
    expectedProcess: { ...f.plan.expectedProcess, pid: 456 },
  });
  await expect(f.service().approveAutomatic(automaticCoordinatorIdentity(other))).rejects.toThrow(
    "require exact owner review",
  );
});

test("an automatic successor cannot close an owner-reviewed failure, so its reviewed change is never dropped", async () => {
  const f = await preFreezeFailureFixture({ ownerReviewed: true });
  expect(() => f.journal.verifyUnpromotedFailure(f.failed)).not.toThrow();
  const submitted = await f.submit();
  await expect(
    f.service().approveAutomatic(automaticCoordinatorIdentity(submitted)),
  ).rejects.toThrow("require exact owner review");
  expect(
    f
      .service()
      .list()
      .find((item) => item.id === submitted.id)?.status,
  ).toBe("pending");
});
