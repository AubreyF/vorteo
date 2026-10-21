import { createHash, randomUUID } from "node:crypto";
import { ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { InstallationEnrollmentManifestSchema } from "@getpaseo/protocol/installation-enrollment";
import {
  FileEnrollmentJournal,
  enrollInstallation,
  enrollmentManifestDigest,
  reserveActivationStep,
  changeStandingGrant,
} from "./authorization.js";
import { CoordinatorBootstrapPlanSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  inspectBootstrapReleaseArtifacts,
  readBootstrapPreparedFile,
  readProtectedDocument,
  digestBootstrapArtifact,
  assertBootstrapPathsProtected,
} from "../coordinator-bootstrap-artifact.js";
import type { InstallationConfig } from "../config.js";
import { coordinatorPlanDigest } from "../coordinator-bootstrap.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { retainMaintenancePublishedFile } from "../coordinator-bootstrap-maintenance-file-selection.js";
import { enrollmentNativeIdentityDigest } from "./native-identity.js";
import {
  InitialHostSupervisorMigrationPlanSchema,
  InitialHostSupervisorPreconditionSchema,
  InitialHostMigrationIntentSchema,
  InitialHostMigrationClaimSchema,
  initialHostNativeLaunchBinding,
  inspectInitialHostSupervisorMigrationPlan,
} from "./host-supervisor-contract.js";
import {
  writeInitialHostArtifact,
  reserveInitialHostMigrationIntent,
  attemptInitialHostConstruction,
  withInitialHostCommandAdmission,
  type InitialHostConstructorHandle,
  type InitialHostCommandContext,
} from "./host-supervisor-migration.js";
import { attemptInitialHostCommand } from "./host-supervisor-initial-command-admission.js";
import {
  prepareInitialHostNativeLaunch,
  InitialHostClaimNoticeSchema,
  type InitialHostNativeLaunchPorts,
} from "./host-supervisor-native-launch.js";
const roots: string[] = [];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
afterEach(() => {
  vi.useRealTimers();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
/** All native/observation ports below are inert. No OS process or native reader. */
function fixture(ownedNode = false) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "initial-native-")));
  roots.push(directory);
  const installationId = randomUUID();
  const uid = process.getuid!();
  const file = (name: string) => ({ path: path.join(directory, name), sha256: "a".repeat(64) });
  const legacy = path.join(directory, "legacy");
  const identity = {
    version: 1 as const,
    environment: "host" as const,
    target: "host" as const,
    installationId: installationId,
    custodyOwnerUid: uid,
    installationRoot: directory,
    stateDirectory: path.join(directory, "home"),
    serviceDomain: `gui/${uid}`,
    serviceLabel: "local.vorteo.test.host",
    launcherPath: path.join(directory, "host.plist"),
    selectionPath: path.join(directory, "current"),
  };
  const environment = {
    PASEO_HOME: identity.stateDirectory,
    VORTEO_INSTALLATION_CLIENT_CONFIG: file("client.json").path,
  };
  const supervisor = {
    pid: 101,
    parentPid: 1,
    uid,
    bootId: randomUUID(),
    startIdentity: "100:1",
    executable: file("node").path,
    argumentsSha256: "b".repeat(64),
  };
  const precondition = InitialHostSupervisorPreconditionSchema.parse({
    version: 1,
    purpose: "initial-host-supervisor-migration",
    provenance: "service-custody-and-observed-files",
    identity,
    configuration: file("installation.json"),
    launcher: file("host.plist"),
    clientConfiguration: file("client.json"),
    node: file("node"),
    supervisorEntrypoint: {
      ...file("unused"),
      path: path.join(legacy, "packages/server/dist/scripts/supervisor-entrypoint.js"),
    },
    workerEntrypoint: {
      ...file("unused"),
      path: path.join(legacy, "packages/server/dist/server/server/daemon-worker.js"),
    },
    sourceReceipt: { ...file("unused"), path: path.join(legacy, ".installation-source.json") },
    selectedRelease: legacy,
    sourceCommit: "b".repeat(40),
    serverId: "host-fixture",
    workerInstanceId: null,
    workerInstanceSupport: "unsupported",
    hostEndpoint: "127.0.0.1:1234",
    registration: {
      program: null,
      arguments: [
        file("node").path,
        path.join(identity.selectionPath, "packages/server/dist/scripts/supervisor-entrypoint.js"),
      ],
      environment,
      loadedEnvironment: environment,
    },
    supervisor,
    worker: { ...supervisor, pid: 102, parentPid: 101, startIdentity: "101:1" },
  });
  const release = (name: string, source: string, artifact: string) => ({
    directory: path.join(directory, name),
    sourceCommit: source.repeat(40),
    artifactSha256: artifact.repeat(64),
    node: precondition.node,
    configuration: precondition.configuration,
    launcher: file(name + "/host.plist"),
    entrypoint: file(name + "/packages/server/dist/scripts/supervisor-entrypoint.js"),
  });
  const plan = InitialHostSupervisorMigrationPlanSchema.parse({
    version: 3,
    operation: "initial-host-supervisor-migration",
    managedReleaseRoot: directory,
    installationId: installationId,
    identitySha256: enrollmentNativeIdentityDigest(identity),
    preconditionSha256: createHash("sha256").update(JSON.stringify(precondition)).digest("hex"),
    precondition,
    candidate: release("candidate", "c", "d"),
    fallback: release("sealed-legacy", "b", "f"),
    fallbackProvenance: file("fallback-copy.json"),
    interruption: { finishTurnsSeconds: 30, terminateGraceSeconds: 10 },
  });

  const { planSha256 } = inspectInitialHostSupervisorMigrationPlan(plan);
  const service = `gui/${uid}/local.vorteo.test.installation`;
  const coordinatorIdentity = {
    ...identity,
    target: "coordinator" as const,
    stateDirectory: directory,
    serviceLabel: "local.vorteo.test.installation",
  };
  const configuration = {
    public: {
      version: 1,
      installationId,
      origin: "https://fixture.example.test",
      environments: [
        { kind: "host", serverId: "host-fixture", endpoint: "127.0.0.1:1234", useTls: false },
      ],
    },
    stateDir: directory,
  } as InstallationConfig;
  const selected = {
    ...plan.candidate,
    node: {
      ...plan.candidate.node,
      path: ownedNode ? path.join(directory, "owned-node") : realpathSync(process.execPath),
    },
    configuration: precondition.configuration,
  };
  const argv = [selected.node.path, selected.entrypoint.path, selected.configuration.path];
  const controllerIdentity = {
    ...supervisor,
    pid: process.pid,
    parentPid: process.ppid,
    executable: selected.node.path,
    argumentsSha256: hash(argv),
  };
  const audit = (observed: typeof controllerIdentity) => ({
    identity: observed,
    auditToken: [0, uid, 0, 0, 0, observed.pid, 0, 1] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ],
  });
  const controller = audit(controllerIdentity);
  let observedChild = controller;
  const bootstrapPlan = CoordinatorBootstrapPlanSchema.parse({
    version: 1,
    operation: "coordinator-bootstrap",
    installationId,
    service,
    previous: plan.fallback,
    candidate: selected,
    state: {
      directory,
      restartJournal: path.join(directory, "restart-jobs.json"),
      ownerSessions: path.join(directory, "owner-sessions.json"),
    },
    hostRequestsAfter: null,
    expectedProcess: {
      pid: 101,
      bootId: supervisor.bootId,
      startIdentity: "100:1",
      argumentsSha256: "a".repeat(64),
    },
  });
  const terminal = {
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "inert source test",
    createdAt: new Date().toISOString(),
    plan: bootstrapPlan,
    planSha256: coordinatorPlanDigest(bootstrapPlan),
    status: "approved",
    decisionAt: new Date().toISOString(),
    execution: {
      generation: randomUUID(),
      stage: "succeeded",
      updatedAt: new Date().toISOString(),
    },
  };
  const entry = path.join(
    selected.directory,
    "packages/server/dist/server/server/execution-installation/maintenance/host-supervisor-native-child.js",
  );
  const save = (filePath: string, bytes: Buffer | string) => {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, bytes, { mode: 0o600 });
  };
  save(entry, "synthetic child bytes, never executed");

  save(selected.configuration.path, JSON.stringify(configuration));
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    writes: Buffer[] = [];
  const gate = new Writable({
    write(bytes, _encoding, done) {
      writes.push(Buffer.from(bytes));
      done();
    },
  });
  const child = new ChildProcess();
  Object.defineProperties(child, {
    pid: { value: 43210 },
    stdout: { value: stdout },
    stderr: { value: stderr },
    stdio: { value: [null, stdout, stderr, gate], writable: true },
    spawnfile: { value: selected.node.path, writable: true },
    spawnargs: { value: [], writable: true },
  });
  const witness = {
    target: "coordinator" as const,
    stateDirectory: directory,
    installationId,
    process: controllerIdentity,
    assertCurrent: vi.fn(() => undefined),
  };
  const artifact = { assertCurrent: vi.fn(() => undefined) };
  const reader = {
    inspectAuditedProcess: vi.fn(async (pid: number) =>
      pid === process.pid ? controller : observedChild,
    ),
    inspectAuditedProcessSync: vi.fn((pid: number) =>
      pid === process.pid ? controller : observedChild,
    ),
  };
  const runtime = {
    installationRoot: directory,
    stateDirectory: directory,
    account: { uid, home: directory },
    nativeAdmission: { path: path.join(directory, "admission.json"), sha256: "a".repeat(64) },
    admission: {},
    writableMountRoots: [],
    ports: { reader, assertCurrent: vi.fn(() => undefined) },
    assertCurrent: vi.fn(() => undefined),
  };
  const invocation = {
    enrollmentStateDirectory: directory,
    plan,
    grantId: randomUUID(),
    grantRevision: randomUUID(),
    stepId: randomUUID(),
    generation: randomUUID(),
  };
  let intent: ReturnType<typeof InitialHostMigrationIntentSchema.parse>;
  let preparation: Awaited<ReturnType<typeof prepareInitialHostNativeLaunch>>;
  let time = 0,
    allow = true,
    noticeMode = "normal",
    claimMode = "normal";
  const noticeBytes = () => {
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "initial-host-claimed",
        stepId: invocation.stepId,
        generation: invocation.generation,
      }),
    );
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const spawnChild = vi.fn((_file: string, args: string[]) => {
    child.spawnargs = [selected.node.path, ...args];
    observedChild = audit({
      ...controllerIdentity,
      pid: child.pid!,
      parentPid: process.pid,
      startIdentity: "200:1",
      argumentsSha256: hash(child.spawnargs),
    });
    setImmediate(() => {
      const claim = InitialHostMigrationClaimSchema.parse({
        version: 1,
        operation: intent.operation,
        intentId: intent.id,
        intentSha256: hash(intent),
        stepId: invocation.stepId,
        generation: invocation.generation,
        planSha256,
        executor: observedChild.identity,
        executorAuditToken: observedChild.auditToken,
        consumedAt: new Date().toISOString(),
      });
      if (claimMode === "wrong-birth") claim.executor.startIdentity = "wrong";
      if (claimMode !== "missing")
        writeInitialHostArtifact(
          directory,
          path.join(
            directory,
            `initial-host-claim-${invocation.stepId}-${invocation.generation}.json`,
          ),
          claim,
        );
      child.emit("spawn");
      const frame = noticeBytes();
      if (noticeMode === "extra") stdout.write(Buffer.concat([frame, Buffer.from("extra")]));
      else if (noticeMode === "split") {
        stdout.write(frame.subarray(0, 2));
        stdout.write(frame.subarray(2, 9));
        stdout.write(frame.subarray(9));
      } else if (noticeMode === "truncated") {
        stdout.write(frame.subarray(0, 5));
        stdout.end();
      } else if (noticeMode === "oversized") {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(4097);
        stdout.write(size);
      } else if (noticeMode === "duplicate") stdout.write(Buffer.concat([frame, frame]));
      else if (noticeMode === "eof") {
        stdout.write(frame);
        stdout.end();
      } else if (noticeMode !== "silent") stdout.write(frame);
    });
    return child;
  });
  const ports = {
    observe: vi.fn(async () => runtime),
    readEnrollment: vi.fn(() => ({
      status: "enrolled",
      grant: { manifest: { targets: [{ target: "coordinator", identitySha256: "a".repeat(64) }] } },
    })),
    readIdentity: vi.fn(() => coordinatorIdentity),
    readHostBinding: vi.fn(() => ({
      binding: { installationId, service, ownerPasswordHash: "never retained" },
      stateDirectory: directory,
    })),
    witness: vi.fn(async () => witness),
    readHistory: vi.fn(() => [terminal]),
    inspectRelease: vi.fn(async () => artifact),
    readPin: vi.fn(async (pin: { path: string }) =>
      pin.path === selected.node.path
        ? Buffer.from("synthetic Node pin assertion")
        : readFileSync(pin.path),
    ),
    readDocument: vi.fn(async (filePath: string) => readFileSync(filePath)),
    protect: vi.fn(async () => undefined),
    retainFiles: (files: readonly string[]) =>
      retainServiceFiles(files.filter((filePath) => filePath !== selected.node.path)),
    retainBytes: retainMaintenancePublishedFile,
    mountRoots: vi.fn(async () => []),
    spawn: spawnChild,
    construct: vi.fn((_handle: unknown, construction: { spawn(value: unknown): void }) => {
      intent = InitialHostMigrationIntentSchema.parse({
        version: 1,
        id: randomUUID(),
        operation: "initial-host-supervisor-migration",
        grantId: invocation.grantId,
        grantRevision: invocation.grantRevision,
        manifestSha256: "a".repeat(64),
        stepId: invocation.stepId,
        generation: invocation.generation,
        planSha256,
        identitySha256: plan.identitySha256,
        preconditionSha256: plan.preconditionSha256,
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        nativeLaunch: initialHostNativeLaunchBinding({
          prepared: preparation.prepared,
          address: {
            enrollmentStateDirectory: directory,
            stepId: invocation.stepId,
            generation: invocation.generation,
          },
        }),
      });
      construction.spawn(intent);
    }),
    admit: vi.fn(
      (...[actor, assertCommand, action]: Parameters<InitialHostNativeLaunchPorts["admit"]>) => {
        if (actor.kind !== "release") throw Error("inert adapter only admits release");
        const context: InitialHostCommandContext = {
          enrollmentStateDirectory: directory,
          plan,
          planSha256,
          intent,
          claim: actor.child.claim,
          executor: controllerIdentity,
          actor: "release",
        };
        const reassert = () => {
          if (!allow) throw Error("revoked");
          actor.child.assertCurrent();
          assertCommand(context);
          if (!allow) throw Error("revoked");
        };
        reassert();
        action(context, reassert);
        reassert();
      },
    ),
    queue: vi.fn((...[actor, owner, files]: Parameters<InitialHostNativeLaunchPorts["queue"]>) =>
      attemptInitialHostCommand(actor, owner, files, { admit: ports.admit }),
    ),
    write: writeInitialHostArtifact,
    self: vi.fn(() => ({
      pid: process.pid,
      parentPid: process.ppid,
      uid,
      node: selected.node.path,
      argv,
    })),
    now: () => time,
  } as unknown as InitialHostNativeLaunchPorts;
  const prepare = async () =>
    (preparation = await prepareInitialHostNativeLaunch(
      { configuration, configurationFile: selected.configuration.path },
      ports,
    ));
  const launch = async () => {
    await prepare();
    return preparation.launch(invocation, {} as InitialHostConstructorHandle);
  };
  return {
    directory,
    entry,
    selected,
    plan,
    configuration,
    controller,
    runtime,
    witness,
    artifact,
    reader,
    terminal,
    ports,
    stdout,
    child,
    gate,
    writes,
    invocation,
    prepare,
    launch,
    get preparation() {
      return preparation;
    },
    spawnChild,
    setNotice(value: string) {
      noticeMode = value;
    },
    setClaim(value: string) {
      claimMode = value;
    },
    advance(ms: number) {
      time += ms;
    },
    revoke() {
      allow = false;
    },
    setIntent(value: ReturnType<typeof InitialHostMigrationIntentSchema.parse>) {
      intent = value;
    },
    observedChild: () => observedChild,
  };
}

test("actual-source composition retains one child and queues byte then EOF without waiting for stdout EOF", async () => {
  const f = fixture();
  const result = await f.launch();
  expect(f.writes).toEqual([Buffer.from([1])]);
  expect(result).toMatchObject({
    attempted: true,
    releaseAttempted: true,
    delivery: "unknown",
    settlement: "unknown",
  });
  expect(f.stdout.readableEnded).toBe(false);
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
  expect(f.reader.inspectAuditedProcess).toHaveBeenCalledWith(43210);
  await expect(
    f.preparation.launch(f.invocation, {} as InitialHostConstructorHandle),
  ).rejects.toThrow("already attempted");
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
});
test("fragmented notice is a hint and cannot replace independent claim audit", async () => {
  const f = fixture();
  f.setNotice("split");
  await f.launch();
  expect(f.writes).toHaveLength(1);
  expect(f.ports.queue).toHaveBeenCalledTimes(1);
});
test.each(["extra", "duplicate", "truncated", "oversized"])(
  "%s notice refuses release and retains actual child",
  async (kind) => {
    const f = fixture();
    f.setNotice(kind);
    await expect(f.launch()).rejects.toThrow();
    expect(f.writes).toEqual([]);
    expect(f.preparation.snapshot()).toMatchObject({
      attempted: true,
      unresolved: true,
      child: { pid: 43210 },
    });
    await expect(
      f.preparation.launch(f.invocation, {} as InitialHostConstructorHandle),
    ).rejects.toThrow();
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
  },
);
test.each(["missing", "wrong-birth"])(
  "%s protected claim cannot release the gate",
  async (kind) => {
    const f = fixture();
    f.setClaim(kind);
    await expect(f.launch()).rejects.toThrow();
    expect(f.writes).toEqual([]);
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
  },
);
test("absent child entrypoint in the approved runtime refuses before construction", async () => {
  const f = fixture();
  rmSync(f.entry);
  await expect(f.prepare()).rejects.toThrow();
  expect(f.spawnChild).not.toHaveBeenCalled();
});
test("pure binder performs no native callbacks or I/O and preserves the original assertion", async () => {
  const f = fixture();
  const prepared = await f.prepare();
  const count = vi.mocked(f.reader.inspectAuditedProcessSync).mock.calls.length;
  const reads = vi.mocked(f.ports.readHistory).mock.calls.length;
  const result = prepared.bindReservation({
    enrollmentStateDirectory: f.directory,
    stepId: f.invocation.stepId,
    generation: f.invocation.generation,
  });
  expect(result.assertCurrent).toBe(prepared.assertCurrent);
  expect(vi.mocked(f.reader.inspectAuditedProcessSync).mock.calls.length).toBe(count);
  expect(vi.mocked(f.ports.readHistory).mock.calls.length).toBe(reads);
  expect(f.spawnChild).not.toHaveBeenCalled();
  result.binding.env.PATH = "mutated" as typeof result.binding.env.PATH;
  expect(prepared.bindReservation(result.binding.address).binding.env.PATH).toBe("/usr/bin:/bin");
});
test("hint schema rejects identity and authority claims", () => {
  expect(
    InitialHostClaimNoticeSchema.safeParse({
      version: 1,
      kind: "initial-host-claimed",
      stepId: randomUUID(),
      generation: randomUUID(),
      pid: 43210,
    }).success,
  ).toBe(false);
});

test.each([
  "controller-birth",
  "controller-audit",
  "selected-process",
  "selected-node",
  "configuration",
  "history",
])("preparation rejects %s substitution", async (kind) => {
  const f = fixture();
  if (kind === "controller-birth")
    f.reader.inspectAuditedProcess.mockResolvedValue({
      ...f.controller,
      identity: { ...f.controller.identity, startIdentity: "999:1" },
    });
  if (kind === "controller-audit") f.controller.auditToken[5]++;
  if (kind === "selected-process") f.witness.process.pid++;
  if (kind === "selected-node") f.terminal.plan.candidate.node.path += ".foreign";
  if (kind === "configuration") writeFileSync(f.selected.configuration.path, "{}");
  if (kind === "history") f.terminal.status = "pending";
  await expect(f.prepare()).rejects.toThrow();
  expect(f.spawnChild).not.toHaveBeenCalled();
});
test.each([
  "runtime-callback",
  "witness-callback",
  "artifact-callback",
  "reader-callback",
  "prepared-data",
])("retains original %s", async (kind) => {
  const f = fixture();
  const p = await f.prepare();
  if (kind === "runtime-callback")
    Object.defineProperty(f.runtime, "assertCurrent", { value: () => undefined });
  if (kind === "witness-callback")
    Object.defineProperty(f.witness, "assertCurrent", { value: () => undefined });
  if (kind === "artifact-callback")
    Object.defineProperty(f.artifact, "assertCurrent", { value: () => undefined });
  if (kind === "reader-callback")
    Object.defineProperty(f.reader, "inspectAuditedProcessSync", { value: () => f.controller });
  if (kind === "prepared-data") p.prepared.approval.revision = randomUUID();
  expect(p.assertCurrent).toThrow();
  expect(f.spawnChild).not.toHaveBeenCalled();
});
test("final native callback cannot substitute the protected claim", async () => {
  const f = fixture();
  const original = f.reader.inspectAuditedProcessSync.getMockImplementation()!;
  f.reader.inspectAuditedProcessSync.mockImplementation((pid) => {
    const observed = original(pid);
    if (pid !== process.pid) {
      const file = path.join(
        f.directory,
        `initial-host-claim-${f.invocation.stepId}-${f.invocation.generation}.json`,
      );
      writeFileSync(file, "{}");
    }
    return observed;
  });
  await expect(f.launch()).rejects.toThrow();
  expect(f.writes).toEqual([]);
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
});
test.each(["writer", "spawn-args", "entrypoint", "history", "clock"])(
  "final native callback cannot change %s before release",
  async (kind) => {
    const f = fixture();
    const original = f.reader.inspectAuditedProcessSync.getMockImplementation()!;
    f.reader.inspectAuditedProcessSync.mockImplementation((pid) => {
      const observed = original(pid);
      if (pid !== process.pid) {
        if (kind === "writer")
          f.child.stdio[3] = new Writable({
            write(_bytes, _encoding, done) {
              done();
            },
          });
        if (kind === "spawn-args") f.child.spawnargs = [...f.child.spawnargs, "foreign"];
        if (kind === "entrypoint") writeFileSync(f.entry, "foreign");
        if (kind === "history") f.terminal.revision = randomUUID();
        if (kind === "clock") f.advance(30_001);
      }
      return observed;
    });
    await expect(f.launch()).rejects.toThrow();
    expect(f.writes).toEqual([]);
  },
);
test("post-fence sync uncertainty cannot release or construct again", async () => {
  const f = fixture();
  const original = f.ports.write;
  f.ports.write = (...args) => {
    original(...args);
    throw Error("sync uncertainty");
  };
  await expect(f.launch()).rejects.toThrow("sync uncertainty");
  expect(f.writes).toEqual([]);
  expect(f.preparation.snapshot().unresolved).toBe(true);
  await expect(
    f.preparation.launch(f.invocation, {} as InitialHostConstructorHandle),
  ).rejects.toThrow();
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
});
test("queue lost reply retains the one byte attempt without inferring delivery", async () => {
  const f = fixture();
  const original = f.ports.queue;
  f.ports.queue = (...args) => {
    original(...args);
    throw Error("lost reply");
  };
  await expect(f.launch()).rejects.toThrow("lost reply");
  expect(f.writes).toEqual([Buffer.from([1])]);
  expect(f.preparation.snapshot()).toMatchObject({
    releaseAttempted: true,
    unresolved: true,
    delivery: "unknown",
    settlement: "unknown",
  });
  await expect(
    f.preparation.launch(f.invocation, {} as InitialHostConstructorHandle),
  ).rejects.toThrow();
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
});
test("silent notice timeout retains live stream ownership and never signals or relaunches", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  f.setNotice("silent");
  const kill = vi.spyOn(f.child, "kill");
  const pending = f.launch();
  const rejected = expect(pending).rejects.toThrow("timed out");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;
  expect(f.preparation.snapshot()).toMatchObject({ actualChildPid: 43210, unresolved: true });
  expect(f.stdout.listenerCount("data")).toBeGreaterThan(0);
  expect(kill).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
  await expect(
    f.preparation.launch(f.invocation, {} as InitialHostConstructorHandle),
  ).rejects.toThrow();
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
});
test("independent child audit remains owned after its collection timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  const original = f.reader.inspectAuditedProcess.getMockImplementation()!;
  let settle!: (value: typeof f.controller) => void;
  f.reader.inspectAuditedProcess.mockImplementation((pid) =>
    pid === process.pid
      ? original(pid)
      : new Promise((resolve) => {
          settle = resolve;
        }),
  );
  const pending = f.launch();
  const rejected = expect(pending).rejects.toThrow("timed out");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;
  settle(f.observedChild());
  await Promise.resolve();
  expect(f.writes).toEqual([]);
  expect(f.preparation.snapshot().actualChildPid).toBe(43210);
});
test("revocation before prior-fence admission blocks the original stream", async () => {
  const f = fixture();
  const original = f.ports.admit;
  f.ports.admit = (...args) => {
    f.revoke();
    original(...args);
  };
  await expect(f.launch()).rejects.toThrow("revoked");
  expect(f.writes).toEqual([]);
});

test("synchronous birth failure burns construction without a second spawn", async () => {
  const f = fixture();
  f.spawnChild.mockImplementation(() => {
    throw Error("birth uncertain");
  });
  await expect(f.launch()).rejects.toThrow("birth uncertain");
  expect(f.preparation.snapshot()).toMatchObject({ attempted: true, unresolved: true });
  await expect(
    f.preparation.launch(f.invocation, {} as InitialHostConstructorHandle),
  ).rejects.toThrow();
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
});
test("additional bytes observed after a complete hint but before release invalidate it", async () => {
  const f = fixture();
  const original = f.reader.inspectAuditedProcess.getMockImplementation()!;
  f.reader.inspectAuditedProcess.mockImplementation(async (pid) => {
    const result = await original(pid);
    if (pid !== process.pid) f.stdout.write("late extra bytes");
    return result;
  });
  await expect(f.launch()).rejects.toThrow("notice");
  expect(f.writes).toEqual([]);
});
test("original opaque channel retains child and writer and rejects replacement", async () => {
  const f = fixture();
  const original = f.ports.queue;
  f.ports.queue = (actor, owner, files) => {
    expect(owner.channel).toMatchObject({ child: f.child, writer: f.gate });
    (owner.channel as { writer: unknown }).writer = {};
    original(actor, owner, files);
  };
  await expect(f.launch()).rejects.toThrow("channel ownership");
  expect(f.writes).toEqual([]);
});
test("missing original writer retains raw process ownership without signalling", async () => {
  const f = fixture();
  f.child.stdio[3] = null;
  const kill = vi.spyOn(f.child, "kill");
  await expect(f.launch()).rejects.toThrow("gate");
  expect(f.preparation.snapshot()).toMatchObject({ actualChildPid: 43210, unresolved: true });
  expect(f.child.listenerCount("error")).toBeGreaterThan(0);
  expect(kill).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});
test("time consumed by prior-fence synchronization cannot extend release custody", async () => {
  const f = fixture();
  const original = f.ports.write;
  f.ports.write = (...args) => {
    original(...args);
    f.advance(30_001);
  };
  await expect(f.launch()).rejects.toThrow();
  expect(f.writes).toEqual([]);
  expect(f.ports.queue).not.toHaveBeenCalled();
});
test("revocation at the actual queue boundary blocks the retained writer", async () => {
  const f = fixture();
  const original = f.ports.queue;
  f.ports.queue = (...args) => {
    f.revoke();
    original(...args);
  };
  await expect(f.launch()).rejects.toThrow("revoked");
  expect(f.writes).toEqual([]);
});
test("terminal rollback selects the approved previous release rather than the candidate", async () => {
  const f = fixture();
  f.terminal.plan.previous = f.selected;
  f.terminal.plan.candidate = f.plan.fallback;
  f.terminal.execution.stage = "rolled_back";
  f.terminal.planSha256 = coordinatorPlanDigest(f.terminal.plan);
  const p = await f.prepare();
  expect(p.prepared.runtime).toEqual(f.selected);
  expect(p.prepared.runtime).not.toEqual(f.terminal.plan.candidate);
  expect(f.spawnChild).not.toHaveBeenCalled();
});
test("preparation deadline retains a pending read without constructing", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  let finish!: (value: Buffer) => void;
  f.ports.readDocument = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.prepare();
  const rejected = expect(pending).rejects.toThrow("timed out");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;
  finish(Buffer.from("late bytes"));
  await Promise.resolve();
  expect(f.spawnChild).not.toHaveBeenCalled();
});

test("notice EOF with no exact claim cannot authorize release", async () => {
  const f = fixture();
  f.setNotice("eof");
  f.setClaim("missing");
  await expect(f.launch()).rejects.toThrow();
  expect(f.writes).toEqual([]);
});
test.each(["pid", "parent", "boot", "argv", "audit"])(
  "independent child %s substitution refuses without another spawn",
  async (kind) => {
    const f = fixture();
    const original = f.reader.inspectAuditedProcess.getMockImplementation()!;
    f.reader.inspectAuditedProcess.mockImplementation(async (pid) => {
      const observed = structuredClone(await original(pid));
      if (pid !== process.pid) {
        if (kind === "pid") observed.identity.pid++;
        if (kind === "parent") observed.identity.parentPid++;
        if (kind === "boot") observed.identity.bootId = randomUUID();
        if (kind === "argv") observed.identity.argumentsSha256 = "0".repeat(64);
        if (kind === "audit") observed.auditToken[5]++;
      }
      return observed;
    });
    await expect(f.launch()).rejects.toThrow();
    expect(f.writes).toEqual([]);
    await expect(
      f.preparation.launch(f.invocation, {} as InitialHostConstructorHandle),
    ).rejects.toThrow();
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
  },
);

test("final preparation native checks cannot restart the collection deadline", async () => {
  const f = fixture();
  const original = f.ports.mountRoots;
  f.ports.mountRoots = async (...args) => {
    const rootsNow = await original(...args);
    f.advance(10_000);
    return rootsNow;
  };
  const inspect = f.reader.inspectAuditedProcessSync.getMockImplementation()!;
  f.reader.inspectAuditedProcessSync.mockImplementation((pid) => {
    const observed = inspect(pid);
    f.advance(21_000);
    return observed;
  });
  await expect(f.prepare()).rejects.toThrow("deadline");
  expect(f.spawnChild).not.toHaveBeenCalled();
});
test.each(["history", "identity"])(
  "final entry custody callback cannot alter %s after its last semantic read",
  async (kind) => {
    const f = fixture();
    const original = f.ports.retainBytes;
    let checks = 0;
    f.ports.retainBytes = (file, bytes) => {
      const retained = original(file, bytes);
      return () => {
        retained();
        if (file === f.entry && ++checks === 2) {
          if (kind === "history") f.terminal.revision = randomUUID();
          else
            vi.mocked(f.ports.readIdentity).mockReturnValue({
              ...f.ports.readIdentity(f.directory, "a".repeat(64)),
              launcherPath: path.join(f.directory, "different.plist"),
            });
        }
      };
    };
    await expect(f.prepare()).rejects.toThrow();
    expect(f.spawnChild).not.toHaveBeenCalled();
  },
);
test("final retained file custody callback cannot change the terminal during release", async () => {
  const f = fixture();
  const original = f.ports.retainFiles;
  f.ports.retainFiles = (files) => {
    const retained = original(files);
    return () => {
      retained();
      if (files.includes(f.entry) && f.spawnChild.mock.calls.length)
        f.terminal.revision = randomUUID();
    };
  };
  await expect(f.launch()).rejects.toThrow();
  expect(f.writes).toEqual([]);
});

test("an expired preparation collection cannot start another native read", async () => {
  const f = fixture();
  const original = f.ports.readHostBinding;
  f.ports.readHostBinding = (...args) => {
    const value = original(...args);
    f.advance(30_001);
    return value;
  };
  await expect(f.prepare()).rejects.toThrow("deadline");
  expect(f.ports.witness).not.toHaveBeenCalled();
  expect(f.spawnChild).not.toHaveBeenCalled();
});

/** File-only runtime inventory. The executable bit marks a disposable byte
 * fixture for the real verifier; no interpreter or OS child executes it. */
async function streamingFixture() {
  const f = fixture(true);
  const save = (file: string, bytes: Buffer | string) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode: 0o600 });
    return createHash("sha256").update(bytes).digest("hex");
  };
  f.selected.node.sha256 = save(f.selected.node.path, Buffer.alloc(1024 * 1024 + 257, 0x61));
  chmodSync(f.selected.node.path, 0o700);
  f.selected.configuration.sha256 = createHash("sha256")
    .update(readFileSync(f.selected.configuration.path))
    .digest("hex");
  f.selected.entrypoint.sha256 = save(
    f.selected.entrypoint.path,
    "// inert owned coordinator fixture\n",
  );
  f.selected.launcher.sha256 = save(f.selected.launcher.path, "owned fixture launcher bytes\n");
  save(
    path.join(f.selected.directory, ".installation-source.json"),
    JSON.stringify({ sourceCommit: f.selected.sourceCommit }),
  );
  f.selected.artifactSha256 = await digestBootstrapArtifact(f.selected.directory);
  f.terminal.plan.candidate = f.selected;
  f.terminal.planSha256 = coordinatorPlanDigest(f.terminal.plan);
  f.ports.inspectRelease = vi.fn(inspectBootstrapReleaseArtifacts);
  f.ports.readPin = vi.fn(readBootstrapPreparedFile);
  f.ports.readDocument = vi.fn(readProtectedDocument);
  f.ports.protect = assertBootstrapPathsProtected;
  f.ports.retainFiles = retainServiceFiles;
  return f;
}

test("preparation streams an exact owned Node pin larger than the document limit", async () => {
  const f = await streamingFixture();
  // Establish the production boundary with the real document reader, not a fake
  // buffer-returning port that could hide this regression.
  await expect(readBootstrapPreparedFile(f.selected.node, [])).rejects.toThrow(
    "bounded regular file",
  );
  const p = await f.prepare();
  expect(f.ports.inspectRelease).toHaveBeenCalledWith(f.selected, []);
  expect(p.prepared.runtime.node).toEqual(f.selected.node);
  expect(f.ports.readPin).not.toHaveBeenCalledWith(f.selected.node, []);
  expect(f.ports.readPin).toHaveBeenCalledWith(f.selected.configuration, []);
  expect(f.spawnChild).not.toHaveBeenCalled();
  writeFileSync(f.selected.node.path, Buffer.alloc(1024 * 1024 + 257, 0x62));
  expect(p.assertCurrent).toThrow();
});
test("real streaming verification refuses an incorrect large Node digest before preparation", async () => {
  const f = await streamingFixture();
  f.selected.node.sha256 = "0".repeat(64);
  f.terminal.plan.candidate = f.selected;
  f.terminal.planSha256 = coordinatorPlanDigest(f.terminal.plan);
  await expect(f.prepare()).rejects.toThrow("dependency digest changed");
  expect(f.spawnChild).not.toHaveBeenCalled();
  expect(f.ports.readPin).not.toHaveBeenCalled();
});

/** Native facts and process birth stay inert; ownership, policy, replay files and
 * all three release admissions below use the actual shared journal. */
async function journalLaunchFixture() {
  const f = fixture();
  const journal = new FileEnrollmentJournal(f.directory);
  const manifest = InstallationEnrollmentManifestSchema.parse({
    version: 1,
    operation: "installation-enrollment",
    installationId: f.plan.installationId,
    revision: randomUUID(),
    createdAt: new Date().toISOString(),
    targets: [
      {
        target: "maintenance-controller",
        identitySha256: "a".repeat(64),
        operations: ["replacement"],
      },
      { target: "recovery-launcher", identitySha256: "b".repeat(64), operations: ["replacement"] },
      { target: "host", identitySha256: f.plan.identitySha256, operations: ["replacement"] },
      {
        target: "coordinator",
        identitySha256: enrollmentNativeIdentityDigest(
          f.ports.readIdentity(f.directory, "a".repeat(64)),
        ),
        operations: ["replacement"],
      },
    ],
    trustedRepositories: ["https://github.com/example/installation.git"],
    provisioning: null,
    interruption: f.plan.interruption,
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    steps: [
      {
        id: f.invocation.stepId,
        target: "host",
        operation: "replacement",
        planSha256: inspectInitialHostSupervisorMigrationPlan(f.plan).planSha256,
        candidate: {
          sourceCommit: f.plan.candidate.sourceCommit,
          artifactSha256: f.plan.candidate.artifactSha256,
        },
        previous: {
          sourceCommit: f.plan.fallback.sourceCommit,
          artifactSha256: f.plan.fallback.artifactSha256,
        },
        dependsOn: [],
      },
    ],
  });
  const enrolled = enrollInstallation(journal, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: new Date().toISOString(),
    },
  });
  if (enrolled.status !== "enrolled") throw Error("Missing fixture enrollment");
  const reserved = reserveActivationStep(journal, {
    grantRevision: enrolled.grant.revision,
    stepId: f.invocation.stepId,
  });
  if (reserved.status !== "enrolled" || reserved.activation.steps[0].status !== "reserved")
    throw Error("Missing fixture reservation");
  Object.assign(f.invocation, {
    grantId: reserved.grant.id,
    grantRevision: reserved.grant.revision,
    generation: reserved.activation.steps[0].generation,
  });
  f.ports.readEnrollment = vi.fn(() => journal.readPolicySnapshot());
  f.ports.construct = vi.fn(
    (...[handle, construction]: Parameters<InitialHostNativeLaunchPorts["construct"]>) => {
      attemptInitialHostConstruction(handle, {
        channel: construction.channel,
        spawn(intent) {
          f.setIntent(intent);
          construction.spawn(intent);
        },
      });
    },
  );
  f.ports.admit = withInitialHostCommandAdmission;
  f.ports.queue = attemptInitialHostCommand;
  await f.prepare();
  const planSha256 = inspectInitialHostSupervisorMigrationPlan(f.plan).planSha256;
  const retained = reserveInitialHostMigrationIntent({
    ...f.invocation,
    native: {
      precondition: f.plan.precondition,
      preconditionSha256: f.plan.preconditionSha256,
      observedAt: new Date().toISOString(),
      assertCurrent() {},
    },
    artifacts: { plan: f.plan, planSha256, assertCurrent() {}, assertPreparedCurrent() {} },
    nativeLaunch: f.preparation.bindReservation({
      enrollmentStateDirectory: f.directory,
      stepId: f.invocation.stepId,
      generation: f.invocation.generation,
    }),
  });
  if (!retained.constructorHandle) throw Error("Missing original constructor");
  return {
    ...f,
    journal,
    retained,
    handle: retained.constructorHandle,
    get currentPreparation() {
      return f.preparation;
    },
  };
}

test("real journal native launcher preserves policy while queueing one original release", async () => {
  const f = await journalLaunchFixture();
  const file = path.join(f.directory, "maintenance-enrollment.json");
  const before = readFileSync(file);
  const result = await f.currentPreparation.launch(f.invocation, f.handle);
  expect(result.releaseAttempted).toBe(true);
  expect(result.delivery).toBe("unknown");
  expect(f.writes).toEqual([Buffer.from([1])]);
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
  expect(readFileSync(file)).toEqual(before);
  await expect(f.currentPreparation.launch(f.invocation, f.handle)).rejects.toThrow(
    "already attempted",
  );
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
});

test("real journal native launcher refuses revocation after birth before release", async () => {
  const f = await journalLaunchFixture();
  f.reader.inspectAuditedProcess.mockImplementation(async (pid: number) => {
    if (pid === f.child.pid) {
      changeStandingGrant(f.journal, {
        expectedRevision: f.invocation.grantRevision,
        paused: false,
        disabledTargets: [],
        revoke: true,
      });
      return f.observedChild();
    }
    return f.controller;
  });
  await expect(f.currentPreparation.launch(f.invocation, f.handle)).rejects.toThrow(
    "authority changed",
  );
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
  expect(f.writes).toEqual([]);
  expect(f.journal.read()).toMatchObject({
    status: "enrolled",
    grant: { revokedAt: expect.any(String) },
  });
  await expect(f.currentPreparation.launch(f.invocation, f.handle)).rejects.toThrow(
    "already attempted",
  );
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
});

test("real journal native launcher cannot reconstruct a spent constructor in another factory", async () => {
  const f = await journalLaunchFixture();
  await f.currentPreparation.launch(f.invocation, f.handle);
  await f.prepare();
  await expect(f.currentPreparation.launch(f.invocation, f.handle)).rejects.toThrow(
    "already attempted",
  );
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
  expect(f.writes).toEqual([Buffer.from([1])]);
});
