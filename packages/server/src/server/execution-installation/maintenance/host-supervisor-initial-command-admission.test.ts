import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  chmodSync,
  readFileSync,
  rmSync,
  realpathSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { enrollmentWriteFiles } from "./authorization.js";
import { enrollmentNativeIdentityDigest } from "./native-identity.js";
import {
  InitialHostSupervisorMigrationPlanSchema,
  InitialHostSupervisorPreconditionSchema,
  InitialHostMigrationIntentSchema,
  InitialHostMigrationClaimSchema,
  inspectInitialHostSupervisorMigrationPlan,
  initialHostNativeLaunchBinding,
} from "./host-supervisor-contract.js";
import {
  writeInitialHostArtifact,
  type InitialHostCommandActor,
  type InitialHostCommandContext,
} from "./host-supervisor-migration.js";
import {
  attemptInitialHostCommand,
  initialHostCommandScope,
  initialHostCommandPaths,
  initialHostCommandFenceRecord,
  initialHostCommandQueueAttemptRecord,
  InitialHostCommandScopeSchema,
  InitialHostCommandQueueAttemptSchema,
  type InitialHostCommandOperation,
  type InitialHostCommandOwner,
  type InitialHostCommandAdmissionPorts,
} from "./host-supervisor-initial-command-admission.js";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
/** Synthetic selectors and inert admission only. No native reader or command is run. */
function fixture(operation: InitialHostCommandOperation = "bootstrap") {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "initial-command-")));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const f = { directory };
  const installationId = randomUUID();
  const uid = process.getuid!();
  const file = (name: string) => ({ path: path.join(f.directory, name), sha256: "a".repeat(64) });
  const legacy = path.join(f.directory, "legacy");
  const identity = {
    version: 1 as const,
    environment: "host" as const,
    target: "host" as const,
    installationId: installationId,
    custodyOwnerUid: uid,
    installationRoot: f.directory,
    stateDirectory: path.join(f.directory, "home"),
    serviceDomain: `gui/${uid}`,
    serviceLabel: "local.vorteo.test.host",
    launcherPath: path.join(f.directory, "host.plist"),
    selectionPath: path.join(f.directory, "current"),
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
    directory: path.join(f.directory, name),
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
    managedReleaseRoot: f.directory,
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
  const executor = {
    ...supervisor,
    pid: process.pid,
    parentPid: process.ppid,
    executable: realpathSync(process.execPath),
  };
  const other = { ...executor, pid: process.pid + 1000, parentPid: process.pid };
  const audited = (observed: typeof executor) => ({
    identity: observed,
    auditToken: [0, observed.uid, 0, 0, 0, observed.pid, 0, 1],
  });
  const stepId = randomUUID(),
    generation = randomUUID();
  const runtime = {
    ...release("coordinator", "e", "e"),
    node: { path: executor.executable, sha256: "a".repeat(64) },
  };
  const nativeLaunch = initialHostNativeLaunchBinding({
    prepared: {
      version: 1,
      approval: {
        requestId: randomUUID(),
        revision: randomUUID(),
        planSha256: "a".repeat(64),
        executionGeneration: randomUUID(),
      },
      coordinator: audited(operation === "release" ? executor : other),
      runtime,
      childEntrypoint: file(
        "coordinator/packages/server/dist/server/server/execution-installation/maintenance/host-supervisor-native-child.js",
      ),
    },
    address: { enrollmentStateDirectory: directory, stepId, generation },
  });
  const intent = InitialHostMigrationIntentSchema.parse({
    version: 1,
    id: randomUUID(),
    operation: "initial-host-supervisor-migration",
    grantId: randomUUID(),
    grantRevision: randomUUID(),
    manifestSha256: "a".repeat(64),
    stepId,
    generation,
    planSha256,
    identitySha256: plan.identitySha256,
    preconditionSha256: plan.preconditionSha256,
    observedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    nativeLaunch,
  });
  const child = operation === "release" ? other : executor;
  const claim = InitialHostMigrationClaimSchema.parse({
    version: 1,
    operation: intent.operation,
    intentId: intent.id,
    intentSha256: hash(intent),
    stepId,
    generation,
    planSha256,
    executor: child,
    executorAuditToken: audited(child).auditToken,
    consumedAt: new Date().toISOString(),
  });
  const context: InitialHostCommandContext = {
    enrollmentStateDirectory: directory,
    plan,
    planSha256,
    intent,
    claim,
    executor,
    actor: operation === "release" ? "release" : "child",
  };
  const channel = {};
  // These handles can only reach the explicitly injected inert admission port.
  const actor = (
    operation === "release"
      ? {
          kind: "release",
          constructorHandle: {},
          channel,
          child: {
            file: path.join(directory, `initial-host-claim-${intent.id}.json`),
            claim,
            audited: audited(child),
            assertCurrent: () => undefined,
          },
        }
      : { kind: "child", claimedHandle: {} }
  ) as InitialHostCommandActor;
  const paths = initialHostCommandPaths(context, operation);
  const fenceRecord = initialHostCommandFenceRecord({ context, operation });
  writeInitialHostArtifact(directory, paths.fenceFile, fenceRecord);
  const trace: string[] = [];
  const owner: InitialHostCommandOwner = {
    operation,
    executor,
    command: { syntheticOnly: true, operation },
    channel,
    channelIdentity: { syntheticOnly: true, id: randomUUID() },
    scope: initialHostCommandScope(context, operation),
    fence: { file: paths.fenceFile, bytes: readFileSync(paths.fenceFile) },
    assertCurrent: vi.fn(() => {
      trace.push("native");
    }),
    enqueue: vi.fn(() => {
      trace.push("enqueue");
    }),
  };
  let grant = true,
    calls = 0;
  let afterTransaction: (count: number) => void = () => undefined;
  const ports: InitialHostCommandAdmissionPorts = {
    admit: (_actor, assertCommand, action) => {
      calls++;
      let active = true;
      const reassert = () => {
        if (!active) throw Error("expired");
        if (!grant) throw Error("revoked");
        assertCommand(context);
        if (!grant) throw Error("revoked");
        trace.push("policy");
      };
      try {
        reassert();
        action(context, reassert);
        reassert();
      } finally {
        active = false;
      }
      afterTransaction(calls);
    },
  };
  return {
    directory,
    context,
    actor,
    owner,
    paths,
    ports,
    trace,
    run: () => attemptInitialHostCommand(actor, owner, undefined, ports),
    revoke: () => {
      grant = false;
    },
    after: (action: typeof afterTransaction) => {
      afterTransaction = action;
    },
    calls: () => calls,
  };
}

test.each(["release", "interruption", "retirement", "bootstrap"] as const)(
  "%s attempts one original enqueue after two admissions",
  (operation) => {
    const f = fixture(operation);
    f.run();
    expect(f.calls()).toBe(2);
    expect(f.owner.enqueue).toHaveBeenCalledTimes(1);
    const record = InitialHostCommandQueueAttemptSchema.parse(
      JSON.parse(readFileSync(f.paths.queueFile, "utf8")),
    );
    expect(record).toEqual(
      initialHostCommandQueueAttemptRecord({
        context: f.context,
        operation,
        fenceBytes: f.owner.fence.bytes,
        command: f.owner.command,
        channelIdentity: f.owner.channelIdentity,
      }),
    );
    const index = f.trace.indexOf("enqueue");
    expect(f.trace[index - 1]).toBe("policy");
    expect(() => f.run()).toThrow();
    expect(f.owner.enqueue).toHaveBeenCalledTimes(1);
  },
);
test("initial incumbent scope preserves original lifetimes and no imported artifact claim", () => {
  const f = fixture("interruption");
  expect(f.owner.scope).toEqual({
    kind: "original-incumbent",
    identitySha256: f.context.plan.identitySha256,
    preconditionSha256: f.context.plan.preconditionSha256,
    service: `gui/${process.getuid!()}/local.vorteo.test.host`,
    selectedRelease: f.context.plan.precondition.selectedRelease,
    supervisor: f.context.plan.precondition.supervisor,
    worker: f.context.plan.precondition.worker,
  });
  expect(
    InitialHostCommandScopeSchema.safeParse({
      ...f.owner.scope,
      artifactSha256: f.context.plan.fallback.artifactSha256,
    }).success,
  ).toBe(false);
});
test("default admission refuses reconstructed handles", () => {
  const f = fixture();
  expect(() => attemptInitialHostCommand(f.actor, f.owner)).toThrow();
  expect(existsSync(f.paths.queueFile)).toBe(false);
  expect(f.owner.enqueue).not.toHaveBeenCalled();
});
test.each(["missing", "address", "bytes", "mode"])("refuses %s prior fence", (kind) => {
  const f = fixture();
  if (kind === "missing") rmSync(f.paths.fenceFile);
  if (kind === "address") f.owner.fence.file += ".other";
  if (kind === "bytes") f.owner.fence.bytes = Buffer.from("{}");
  if (kind === "mode") chmodSync(f.paths.fenceFile, 0o644);
  expect(f.run).toThrow();
  expect(f.owner.enqueue).not.toHaveBeenCalled();
  expect(existsSync(f.paths.queueFile)).toBe(false);
});
test.each(["executor", "scope", "callback", "command", "channel", "actor", "context", "thenable"])(
  "rejects native callback %s substitution",
  (kind) => {
    const f = fixture();
    f.owner.assertCurrent = () => {
      switch (kind) {
        case "executor":
          f.owner.executor.pid++;
          break;
        case "scope":
          f.owner.scope.service += ".other";
          break;
        case "callback":
          f.owner.assertCurrent = () => undefined;
          break;
        case "command":
          f.owner.command = { ...f.owner.command };
          break;
        case "channel":
          f.owner.channel = {};
          break;
        case "actor":
          if (f.actor.kind === "child") f.actor.claimedHandle = {} as typeof f.actor.claimedHandle;
          break;
        case "context":
          f.context.intent.grantRevision = randomUUID();
          break;
        case "thenable":
          // oxlint-disable-next-line unicorn/no-thenable -- Deliberately invalid synchronous proof result.
          // oxlint-disable-next-line unicorn/no-thenable -- Deliberately invalid synchronous enqueue result.
          return Object.fromEntries([["then", () => undefined]]) as unknown as void;
      }
    };
    expect(f.run).toThrow();
    expect(f.owner.enqueue).not.toHaveBeenCalled();
    expect(existsSync(f.paths.queueFile)).toBe(false);
  },
);
test("release rejects another channel", () => {
  const f = fixture("release");
  f.owner.channel = {};
  expect(f.run).toThrow();
  expect(f.owner.enqueue).not.toHaveBeenCalled();
});
test("revocation between transactions retains the fence without enqueue", () => {
  const f = fixture();
  f.after((count) => {
    if (count === 1) f.revoke();
  });
  expect(f.run).toThrow("revoked");
  expect(existsSync(f.paths.queueFile)).toBe(true);
  expect(f.owner.enqueue).not.toHaveBeenCalled();
  expect(f.run).toThrow();
});
test.each([1, 2])("post-action transaction %i sync uncertainty prevents replay", (transaction) => {
  const f = fixture();
  f.after((count) => {
    if (count === transaction) throw Error("uncertain sync");
  });
  expect(f.run).toThrow("uncertain sync");
  expect(existsSync(f.paths.queueFile)).toBe(true);
  expect(f.owner.enqueue).toHaveBeenCalledTimes(transaction === 1 ? 0 : 1);
  expect(f.run).toThrow();
  expect(f.owner.enqueue).toHaveBeenCalledTimes(transaction === 1 ? 0 : 1);
});
test.each(["throw", "thenable"])("uncertain enqueue %s cannot replay", (kind) => {
  const f = fixture();
  f.owner.enqueue = vi.fn(() => {
    if (kind === "throw") throw Error("lost reply");
    // oxlint-disable-next-line unicorn/no-thenable -- Deliberately invalid synchronous enqueue result.
    return Object.fromEntries([["then", () => undefined]]) as unknown as void;
  });
  expect(f.run).toThrow();
  expect(existsSync(f.paths.queueFile)).toBe(true);
  expect(f.run).toThrow();
  expect(f.owner.enqueue).toHaveBeenCalledTimes(1);
});
test.each(["fence", "queue", "queue-inode"])(
  "final native callback cannot replace %s evidence",
  (kind) => {
    const f = fixture();
    f.after((count) => {
      if (count === 1)
        vi.mocked(f.owner.assertCurrent).mockImplementation(() => {
          const file = kind === "fence" ? f.paths.fenceFile : f.paths.queueFile;
          if (kind === "queue-inode") {
            renameSync(file, file + ".old");
            writeFileSync(file, readFileSync(file + ".old"), { mode: 0o600 });
          } else writeFileSync(file, "{}");
        });
    });
    expect(f.run).toThrow();
    expect(f.owner.enqueue).not.toHaveBeenCalled();
  },
);
test("queue fsync failure retains uncertainty and cannot retry", () => {
  const f = fixture();
  expect(() =>
    attemptInitialHostCommand(
      f.actor,
      f.owner,
      {
        ...enrollmentWriteFiles,
        sync: () => {
          throw Error("sync");
        },
      },
      f.ports,
    ),
  ).toThrow("sync");
  expect(existsSync(f.paths.queueFile)).toBe(true);
  expect(f.run).toThrow();
  expect(f.owner.enqueue).not.toHaveBeenCalled();
});

test("native callback revocation cannot pass the final policy check", () => {
  const f = fixture();
  f.owner.assertCurrent = () => {
    f.revoke();
  };
  expect(f.run).toThrow("revoked");
  expect(f.owner.enqueue).not.toHaveBeenCalled();
  expect(existsSync(f.paths.queueFile)).toBe(false);
});
test("a second admission cannot replace the retained context", () => {
  const f = fixture();
  f.after((count) => {
    if (count === 1) f.context.claim.executor.startIdentity = "replacement";
  });
  expect(f.run).toThrow();
  expect(f.owner.enqueue).not.toHaveBeenCalled();
  expect(existsSync(f.paths.queueFile)).toBe(true);
});
test("release retains its original child proof callback identity", () => {
  const f = fixture("release");
  f.owner.assertCurrent = () => {
    if (f.actor.kind === "release") f.actor.child.assertCurrent = () => undefined;
  };
  expect(f.run).toThrow();
  expect(f.owner.enqueue).not.toHaveBeenCalled();
});
test("late launch addresses cannot be substituted in canonical records", () => {
  const f = fixture();
  f.context.intent.nativeLaunch!.address.generation = randomUUID();
  expect(() =>
    initialHostCommandFenceRecord({ context: f.context, operation: "bootstrap" }),
  ).toThrow();
});
test("strict canonical queue schema rejects extra authority fields", () => {
  const f = fixture();
  const record = initialHostCommandQueueAttemptRecord({
    context: f.context,
    operation: "bootstrap",
    fenceBytes: f.owner.fence.bytes,
    command: f.owner.command,
    channelIdentity: f.owner.channelIdentity,
  });
  expect(
    InitialHostCommandQueueAttemptSchema.safeParse({ ...record, delivered: true }).success,
  ).toBe(false);
});
test("thenable admission uncertainty retains its attempt and never enqueues", () => {
  const f = fixture();
  const original = f.ports.admit;
  f.ports.admit = (...args) => {
    original(...args);
    // oxlint-disable-next-line unicorn/no-thenable -- Deliberately invalid synchronous admission result.
    return { then: () => undefined } as unknown as void;
  };
  expect(f.run).toThrow();
  expect(existsSync(f.paths.queueFile)).toBe(true);
  expect(f.owner.enqueue).not.toHaveBeenCalled();
  expect(f.run).toThrow();
});
