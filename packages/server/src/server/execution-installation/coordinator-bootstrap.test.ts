import { afterEach, expect, test } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { hashSync } from "bcryptjs";
import {
  CoordinatorBootstrapRequestSchema,
  CoordinatorBootstrapPlanSchema,
  type CoordinatorBootstrapPlan,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { handleBootstrapReview } from "./coordinator-bootstrap-session.js";
import {
  CoordinatorBootstrapRequests,
  coordinatorPlanDigest,
  assertFrozenCoordinatorIdle,
} from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  loadedCoordinatorPid,
  isStoppedBootstrapCandidate,
  verifyBootstrapReplacement,
  verifyBootstrapServiceIdentity,
  verifyLoadedBootstrapService,
  verifyBootstrapLaunchers,
} from "./coordinator-bootstrap-service.js";

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
    const call = async (name: string) => {
      calls.push(name);
      if (name === failure) throw new Error("private diagnostic must not escape");
    };
    const operations: BootstrapExecutorOperations = {
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
