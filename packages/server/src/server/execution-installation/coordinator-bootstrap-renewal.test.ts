import {
  derivePreclaimHostRuntime,
  createManagedPreclaimRecoveryReview,
} from "./coordinator-bootstrap-launch.js";
import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { hashSync } from "bcryptjs";
import {
  CoordinatorBootstrapPlanSchema,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { coordinatorPlanDigest, CoordinatorBootstrapRequests } from "./coordinator-bootstrap.js";
import { readBootstrapHostBinding } from "./coordinator-bootstrap-host.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseLifecycleJournal } from "./lifecycle-journal.js";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  deriveBootstrapRenewal,
  persistRenewalSetup,
  retainRenewalGeneration,
  terminalBootstrapRelease,
  verifyRenewalHostProcess,
  verifyRenewalPlan,
  verifyRetainedRenewal,
  type BootstrapRenewalPorts,
} from "./coordinator-bootstrap-renewal.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const runnerRelative =
  "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js";
const workerRelative = "packages/server/dist/server/server/daemon-worker.js";
const mainRelative = "packages/server/dist/server/server/execution-installation/main.js";

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bootstrap-renewal-")));
  roots.push(root);
  const state = path.join(root, "state");
  const releases = path.join(root, "releases");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(releases, { mode: 0o700 });
  const save = (file: string, value: unknown, raw = false, mode = 0o600) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = raw ? String(value) : JSON.stringify(value);
    writeFileSync(file, bytes, { mode });
    return { path: file, sha256: sha(bytes) };
  };
  const node = save(path.join(root, "node"), "disposable executable", true, 0o700);
  const installationId = randomUUID();
  const service = `gui/${process.getuid!()}/local.vorteo.${installationId}.installation`;
  const current = path.join(root, "current");
  const config = {
    public: {
      version: 1,
      installationId,
      origin: "https://fixture.example.test",
      environments: [
        { kind: "host", serverId: "host-id", endpoint: "127.0.0.1:6768", useTls: false },
        { kind: "container", serverId: "dev-id", endpoint: "127.0.0.1:6769", useTls: false },
      ],
    },
    ownerPasswordHash: hashSync("fixture", 4),
    hostAgentTokenHash: "a".repeat(64),
    containerAgentTokenHash: "b".repeat(64),
    listenPort: 6766,
    webDistDir: path.join(root, "web"),
    stateDir: state,
    restartApprovalPolicy: { hostRequestsAfter: "2026-10-01T00:00:00.000Z" },
    sourceUpdates: {
      sourceRepository: path.join(root, "repository"),
      releaseRoot: releases,
      currentReleaseLink: current,
      webDirectory: path.join(root, "web"),
      toolingDirectory: path.join(root, "tooling"),
      integrationRef: "refs/heads/main",
    },
    host: {
      launchdService: service.replace(/\.installation$/, ".host"),
      endpoint: "127.0.0.1:6768",
      password: "host-fixture",
      startupValidation: {
        node: node.path,
        entrypoint: path.join(current, "packages/server/dist/scripts/supervisor-entrypoint.js"),
        home: path.join(root, "home"),
      },
    },
    container: {
      endpoint: "127.0.0.1:6769",
      password: "dev-fixture",
      factoryRuntimeAdoption: {
        node: node.path,
        script: path.join(root, "factory.js"),
        sha256: "c".repeat(64),
      },
    },
  };
  const originalConfiguration = save(path.join(root, "old-config.json"), {
    ...config,
    restartApprovalPolicy: undefined,
  });
  const configuration = save(path.join(root, "selected-config.json"), config);
  const release = async (name: string, sourceCommit: string, configurationFile = configuration) => {
    const directory = path.join(releases, name);
    mkdirSync(directory, { mode: 0o700 });
    save(path.join(directory, ".installation-source.json"), { sourceCommit });
    const entrypoint = save(path.join(directory, mainRelative), "export {};", true);
    save(path.join(directory, runnerRelative), "export {}; // runner", true);
    save(path.join(directory, workerRelative), "export {}; // worker", true);
    save(
      path.join(directory, "packages/server/dist/scripts/supervisor-entrypoint.js"),
      "export {};",
      true,
    );
    save(path.join(directory, "scripts/run-coordinator-owner.py"), "# disposable owner", true);
    save(
      path.join(directory, "scripts/verify-coordinator-owner.py"),
      "# disposable verifier",
      true,
    );
    const launcher = save(path.join(root, name + ".plist"), {
      Label: service.split("/").at(-1),
      ProgramArguments: [node.path, entrypoint.path, configurationFile.path],
      KeepAlive: true,
    });
    return {
      sourceCommit,
      directory,
      node,
      entrypoint,
      configuration: configurationFile,
      launcher,
      artifactSha256: await digestBootstrapArtifact(directory),
    };
  };
  const previous = await release("previous", "a".repeat(40), originalConfiguration);
  const coordinator = await release("coordinator", "b".repeat(40));
  const host = await release("host", "c".repeat(40));
  symlinkSync(host.directory, current);
  const selectedLauncher = save(
    path.join(root, "selected.plist"),
    JSON.parse(readFileSync(coordinator.launcher.path, "utf8")),
  );
  const plan = CoordinatorBootstrapPlanSchema.parse({
    version: 1,
    operation: "coordinator-bootstrap",
    installationId,
    service,
    previous,
    candidate: coordinator,
    state: {
      directory: state,
      restartJournal: path.join(state, "restart-jobs.json"),
      ownerSessions: path.join(state, "owner-sessions.json"),
    },
    hostRequestsAfter: null,
    expectedProcess: {
      pid: 101,
      bootId: randomUUID(),
      startIdentity: "1:2",
      argumentsSha256: sha(
        JSON.stringify([node.path, previous.entrypoint.path, originalConfiguration.path]),
      ),
    },
  });
  const record: CoordinatorBootstrapRequest = {
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "fixture",
    createdAt: new Date().toISOString(),
    plan,
    planSha256: coordinatorPlanDigest(plan),
    status: "approved",
    decisionAt: new Date().toISOString(),
    execution: {
      generation: randomUUID(),
      stage: "succeeded",
      updatedAt: new Date().toISOString(),
    },
  };
  const writeRecords = (records: CoordinatorBootstrapRequest[]) =>
    save(path.join(state, "coordinator-bootstrap.json"), { version: 1, requests: records });
  writeRecords([record]);
  save(path.join(state, `coordinator-executor-${record.execution!.generation}.json`), {
    id: record.id,
    generation: record.execution!.generation,
    pid: 777,
    planSha256: record.planSha256,
    process: {
      pid: 777,
      parentPid: 1,
      uid: process.getuid!(),
      bootId: randomUUID(),
      startIdentity: "1:1",
      argumentsSha256: "a".repeat(64),
      executable: node.path,
    },
    auditToken: [0, process.getuid!(), 0, 0, 0, 777, 0, 1],
  });
  save(path.join(state, `coordinator-transfer-${record.execution!.generation}.json`), {
    version: 1,
    requestId: record.id,
    generation: record.execution!.generation,
    planSha256: record.planSha256,
    restartJournal: null,
    ownerSessions: null,
  });
  const mounts = save(path.join(root, "mounts.json"), {
    Id: "a".repeat(64),
    State: { Running: true },
    Mounts: [],
  });
  const docker = save(
    path.join(root, "docker"),
    `#!/bin/sh\nexec /bin/cat '${mounts.path}'\n`,
    true,
    0o700,
  );
  const admission = save(path.join(root, "admission.json"), {
    configurationFile: originalConfiguration.path,
    launcherFile: selectedLauncher.path,
    docker: docker.path,
    socket: save(path.join(root, "socket"), "", true).path,
    containerId: "a".repeat(64),
    helperPath: save(path.join(root, "helper.py"), "# unused port", true).path,
    helperSha256: sha("# unused port"),
  });
  const original = BootstrapRunnerSetupSchema.parse({
    admissionSetupFile: admission.path,
    daemonId: "host-id",
    node,
    entrypoint: {
      path: path.join(previous.directory, runnerRelative),
      sha256: sha("export {}; // runner"),
    },
    ownerLauncher: {
      path: path.join(previous.directory, "scripts/run-coordinator-owner.py"),
      sha256: sha("# disposable owner"),
    },
    ownershipVerifier: {
      path: path.join(previous.directory, "scripts/verify-coordinator-owner.py"),
      sha256: sha("# disposable verifier"),
    },
    runtimeDirectory: previous.directory,
    runtimeSha256: previous.artifactSha256,
  });
  const setupFile = save(path.join(root, "runner.json"), original).path;
  const bootId = randomUUID();
  const hostProcess = {
    pid: 303,
    parentPid: 202,
    uid: process.getuid!(),
    bootId,
    startIdentity: "3:4",
    executable: node.path,
    argumentsSha256: sha(JSON.stringify([node.path, path.join(host.directory, workerRelative)])),
  };
  const coordinatorProcess = {
    ...hostProcess,
    pid: 404,
    parentPid: 1,
    argumentsSha256: sha(
      JSON.stringify([node.path, coordinator.entrypoint.path, configuration.path]),
    ),
  };
  const ports: BootstrapRenewalPorts & {
    reader: BootstrapRenewalPorts["reader"] & { verifyProcessExited(pid: number): Promise<void> };
  } = {
    hostPid: async () => hostProcess.pid,
    writableMountRoots: async () => [],
    reader: {
      readService: async () => `${service} = {\n\tpid = 404\n}\n`,
      inspectProcess: async (pid) => {
        if (pid === 777) throw new Error("exited fixture");
        return pid === 404 ? coordinatorProcess : hostProcess;
      },
      verifyProcessExited: async (pid: number) => {
        if (pid !== 777) throw new Error("wrong exit proof");
      },
    },
  };
  const derive = (extra: Partial<Parameters<typeof deriveBootstrapRenewal>[0]> = {}) =>
    deriveBootstrapRenewal({
      setupFile,
      setup: original,
      moduleFile: path.join(host.directory, runnerRelative),
      ports,
      ...extra,
    });
  return {
    root,
    state,
    releases,
    current,
    save,
    node,
    config,
    configuration,
    originalConfiguration,
    previous,
    coordinator,
    host,
    plan,
    record,
    original,
    setupFile,
    hostProcess,
    ports,
    derive,
    writeRecords,
    identity: { installationId, service, stateDirectory: state },
  };
}

test("terminal renewal follows exact failure, compatible rollback and fresh-review chains", async () => {
  const f = await fixture();
  const failed = structuredClone(f.record);
  failed.execution!.stage = "recovery_required";
  const recovery = structuredClone(f.record);
  recovery.id = randomUUID();
  recovery.revision = randomUUID();
  recovery.execution!.generation = randomUUID();
  recovery.plan.recoveredFrom = {
    id: failed.id,
    revision: failed.revision,
    generation: failed.execution!.generation,
    planSha256: failed.planSha256,
  };
  recovery.plan.previous = failed.plan.previous;
  recovery.planSha256 = coordinatorPlanDigest(recovery.plan);
  expect(terminalBootstrapRelease([failed, recovery], f.identity)?.release).toEqual(
    recovery.plan.candidate,
  );
  recovery.plan.automaticRecovery = "restore-compatible";
  recovery.plan.compatibleRecovery = f.previous;
  recovery.planSha256 = coordinatorPlanDigest(recovery.plan);
  recovery.execution!.stage = "rolled_back";
  expect(terminalBootstrapRelease([failed, recovery], f.identity)?.release).toEqual(f.previous);
  const next = structuredClone(f.record);
  next.id = randomUUID();
  next.execution!.generation = randomUUID();
  next.plan.recoveredFrom = {
    id: recovery.id,
    revision: recovery.revision,
    generation: recovery.execution!.generation,
    planSha256: recovery.planSha256,
  };
  next.planSha256 = coordinatorPlanDigest(next.plan);
  expect(terminalBootstrapRelease([failed, recovery, next], f.identity)?.request.id).toBe(next.id);
});

test("nonterminal, duplicate, stale reference, corrupt digest and unrelated chains fail closed", async () => {
  const f = await fixture();
  const failed = structuredClone(f.record);
  failed.execution!.stage = "recovery_required";
  expect(() => terminalBootstrapRelease([failed], f.identity)).toThrow("terminal");
  expect(() => terminalBootstrapRelease([f.record, f.record], f.identity)).toThrow("Duplicate");
  const next = structuredClone(f.record);
  next.id = randomUUID();
  next.execution!.generation = randomUUID();
  expect(() => terminalBootstrapRelease([failed, next], f.identity)).toThrow("terminal recovery");
  next.plan.recoveredFrom = {
    id: failed.id,
    revision: randomUUID(),
    generation: failed.execution!.generation,
    planSha256: failed.planSha256,
  };
  next.planSha256 = coordinatorPlanDigest(next.plan);
  expect(() => terminalBootstrapRelease([failed, next], f.identity)).toThrow("history changed");
  expect(() =>
    terminalBootstrapRelease([{ ...f.record, planSha256: "a".repeat(64) }], f.identity),
  ).toThrow("installation");
  expect(() =>
    terminalBootstrapRelease([f.record], { ...f.identity, installationId: randomUUID() }),
  ).toThrow("installation");
});

test.runIf(process.platform === "darwin")(
  "reconstructs stale admission from actual terminal launcher and selected Host, without changing anchors",
  async () => {
    const f = await fixture();
    const before = readFileSync(f.setupFile);
    const renewal = await f.derive();
    expect(renewal?.runtimeDirectory).toBe(f.host.directory);
    expect(renewal?.renewal?.configuration).toEqual(f.configuration);
    expect(renewal?.renewal?.hostProcess).toEqual(f.hostProcess);
    expect(readFileSync(f.setupFile)).toEqual(before);
    expect(f.original.admissionSetupFile).toBe(renewal!.admissionSetupFile);
    await expect(f.derive({ moduleFile: f.original.entrypoint.path })).rejects.toThrow("stale");
    await expect(
      f.derive({
        ports: {
          ...f.ports,
          reader: {
            ...f.ports.reader,
            inspectProcess: async (pid) =>
              pid === 303
                ? { ...f.hostProcess, argumentsSha256: "f".repeat(64) }
                : f.ports.reader.inspectProcess(pid),
          },
        },
      }),
    ).rejects.toThrow("Running Host");
  },
);

test.runIf(process.platform === "darwin")(
  "absence alone permits legacy; failed renewal, writable mounts and changed process lifetime never fall back",
  async () => {
    const f = await fixture();
    f.writeRecords([]);
    await expect(f.derive()).resolves.toBeUndefined();
    const failed = structuredClone(f.record);
    failed.execution!.stage = "recovery_required";
    f.writeRecords([failed]);
    await expect(f.derive()).rejects.toThrow("terminal");
    f.writeRecords([f.record]);
    await expect(
      f.derive({ ports: { ...f.ports, writableMountRoots: async () => [f.host.directory] } }),
    ).rejects.toThrow("writable container mount");
    let observations = 0;
    await expect(
      f.derive({
        ports: {
          ...f.ports,
          reader: {
            ...f.ports.reader,
            inspectProcess: async (pid) => {
              if (pid !== f.hostProcess.pid) return f.ports.reader.inspectProcess(pid);
              observations += 1;
              return {
                ...f.hostProcess,
                startIdentity: observations === 1 ? f.hostProcess.startIdentity : "9:9",
              };
            },
          },
        },
      }),
    ).rejects.toThrow("identity changed");
  },
);

test.runIf(process.platform === "darwin")(
  "terminal receipt paths cannot replace the actual launcher's current configuration authority",
  async () => {
    const f = await fixture();
    const arbitrary = f.save(path.join(f.root, "arbitrary-receipt-config.json"), {
      ...f.config,
      container: { ...f.config.container, password: "receipt-selected-password" },
    });
    const substituted = structuredClone(f.record);
    substituted.plan.candidate.configuration = arbitrary;
    substituted.planSha256 = coordinatorPlanDigest(substituted.plan);
    f.writeRecords([substituted]);
    await expect(f.derive()).rejects.toThrow("digest");
    expect(JSON.parse(readFileSync(f.configuration.path, "utf8"))).toEqual(f.config);
  },
);

test.runIf(process.platform === "darwin")(
  "promoted stale claimed sidecar resolves to succeeded main and remains byte unchanged",
  async () => {
    const f = await fixture();
    const claimed = structuredClone(f.record);
    claimed.revision = randomUUID();
    claimed.execution!.stage = "claimed";
    const pending = f.save(path.join(f.state, "coordinator-bootstrap-pending.json"), {
      version: 1,
      requests: [claimed],
      promotions: [claimed],
    });
    const before = readFileSync(pending.path);
    expect(new FileBootstrapRequestJournal(f.state).read()).toHaveLength(1);
    await expect(f.derive()).resolves.toBeDefined();
    expect(readFileSync(pending.path)).toEqual(before);
  },
);

test.runIf(process.platform === "darwin")(
  "requires matching terminal generation receipts and a complete readable lifecycle history",
  async () => {
    const f = await fixture();
    f.save(path.join(f.state, "restart-jobs.json"), [
      {
        target: "host",
        id: randomUUID(),
        revision: randomUUID(),
        requestedBy: "container-agent",
        reason: "fixture",
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        status: "pending",
        detail: "",
        requireOwnerApproval: true,
        sourceBatch: {
          status: "waiting",
          contributions: [
            {
              id: randomUUID(),
              update: {
                sourceCommit: "c".repeat(40),
                baseCommit: "b".repeat(40),
                sha256: "d".repeat(64),
                bytes: 1,
              },
              reason: "fixture",
              requestedBy: "container-agent",
              createdAt: new Date().toISOString(),
              status: "included",
              detail: "",
              requireOwnerApproval: true,
            },
          ],
        },
      },
    ]);
    const jobs = parseLifecycleJournal(
      JSON.parse(readFileSync(path.join(f.state, "restart-jobs.json"), "utf8")),
    );
    const job = jobs.find((item) => item.target === "host");
    if (!job || !("sourceBatch" in job) || !job.sourceBatch)
      throw new Error("fixture batch missing");
    const original = job.sourceBatch.contributions[0];
    const replacement = { ...original, id: randomUUID(), replaces: original.id };
    original.status = "superseded";
    original.supersededBy = replacement.id;
    job.sourceBatch.contributions.push(replacement);
    f.save(path.join(f.state, "restart-jobs.json"), jobs);
    const before = readFileSync(path.join(f.state, "restart-jobs.json"));
    await expect(f.derive()).resolves.toBeDefined();
    expect(job.requireOwnerApproval).toBe(true);
    expect(job.sourceBatch.contributions.map((item) => item.requireOwnerApproval)).toEqual([
      true,
      true,
    ]);
    expect(readFileSync(path.join(f.state, "restart-jobs.json"))).toEqual(before);
    f.save(path.join(f.state, "restart-jobs.json"), [
      { futureOperationNotReadableByThisHost: true },
    ]);
    await expect(f.derive()).rejects.toThrow("cannot read the complete retained lifecycle history");
    writeFileSync(path.join(f.state, "restart-jobs.json"), before);
    f.save(path.join(f.state, `coordinator-transfer-${f.record.execution!.generation}.json`), {
      version: 1,
      requestId: f.record.id,
      generation: randomUUID(),
      planSha256: f.record.planSha256,
      restartJournal: null,
      ownerSessions: null,
    });
    await expect(f.derive()).rejects.toThrow("preservation receipt changed");
  },
);

test.runIf(process.platform === "darwin")(
  "candidate and compatible recovery use exact selected reader and preserve current policy, Factory and credentials",
  async () => {
    const f = await fixture();
    const setup = (await f.derive())!;
    const plan = {
      ...f.plan,
      previous: f.coordinator,
      candidate: f.host,
      automaticRecovery: "restore-compatible" as const,
      compatibleRecovery: f.host,
    };
    await expect(verifyRenewalPlan(setup, plan)).resolves.toBeUndefined();
    await expect(
      verifyRenewalPlan(setup, { ...plan, compatibleRecovery: f.previous }),
    ).rejects.toThrow("selected Host reader");
    await expect(
      verifyRenewalPlan(setup, { ...plan, automaticRecovery: "restore-previous" }),
    ).rejects.toThrow("compatible recovery reader");
    for (const changed of [
      { ...f.config, host: { ...f.config.host, password: "changed" } },
      { ...f.config, restartApprovalPolicy: undefined },
      { ...f.config, container: { ...f.config.container, factoryRuntimeAdoption: undefined } },
    ]) {
      const other = f.save(path.join(f.root, "other-config.json"), changed);
      await expect(
        verifyRenewalPlan(setup, { ...plan, candidate: { ...f.host, configuration: other } }),
      ).rejects.toThrow("outside its approved policy");
    }
  },
);

test.runIf(process.platform === "darwin")(
  "renewal admits only the declared Factory plan and retains the previous plan for rollback",
  async () => {
    const f = await fixture();
    const setup = (await f.derive())!;
    const adoption = { ...f.config.container.factoryRuntimeAdoption, sha256: "d".repeat(64) };
    const candidateConfig = f.save(path.join(f.root, "factory-recovery-config.json"), {
      ...f.config,
      container: { ...f.config.container, factoryRuntimeAdoption: adoption },
    });
    const plan = {
      ...f.plan,
      previous: f.coordinator,
      candidate: { ...f.host, configuration: candidateConfig },
      automaticRecovery: "restore-compatible" as const,
      compatibleRecovery: f.host,
      factoryRuntimeAdoptionConfiguration: adoption,
    };
    await expect(verifyRenewalPlan(setup, plan)).resolves.toBeUndefined();
    await expect(
      verifyRenewalPlan(setup, { ...plan, factoryRuntimeAdoptionConfiguration: undefined }),
    ).rejects.toThrow("outside its approved policy");
    await expect(
      verifyRenewalPlan(setup, {
        ...plan,
        factoryRuntimeAdoptionConfiguration: {
          ...adoption,
          sha256: "e".repeat(64),
        },
      }),
    ).rejects.toThrow("outside its approved policy");
    await expect(
      verifyRenewalPlan(setup, { ...plan, compatibleRecovery: plan.candidate }),
    ).rejects.toThrow("Recovery must preserve");
    await expect(
      verifyRenewalPlan(setup, { ...plan, hostRequestsAfter: "2026-10-11T00:00:00.000Z" }),
    ).rejects.toThrow("cannot change policy, helper or monitor");
    await expect(
      verifyRenewalPlan(setup, { ...plan, previewMonitorConfiguration: null }),
    ).rejects.toThrow("cannot change policy, helper or monitor");
    await expect(
      verifyRenewalPlan(setup, { ...plan, nativeHelperConfiguration: null }),
    ).rejects.toThrow("cannot change policy, helper or monitor");
    const removed = f.save(path.join(f.root, "factory-disabled.json"), {
      ...f.config,
      container: { ...f.config.container, factoryRuntimeAdoption: undefined },
    });
    await expect(
      verifyRenewalPlan(setup, {
        ...plan,
        candidate: { ...f.host, configuration: removed },
        factoryRuntimeAdoptionConfiguration: null,
      }),
    ).resolves.toBeUndefined();
  },
);

test.runIf(process.platform === "darwin")(
  "retained watchdog survives Host disappearance/selection change and detects snapshot substitution",
  async () => {
    const f = await fixture();
    const setup = (await f.derive())!;
    const approved = structuredClone(f.record);
    approved.id = randomUUID();
    approved.revision = randomUUID();
    delete approved.execution;
    approved.plan = {
      ...f.plan,
      previous: f.coordinator,
      candidate: f.host,
      automaticRecovery: "restore-compatible",
      compatibleRecovery: f.host,
    };
    approved.planSha256 = coordinatorPlanDigest(approved.plan);
    const file = persistRenewalSetup(f.state, setup, approved);
    expect(persistRenewalSetup(f.state, setup, approved)).toBe(file);
    const snapshot = BootstrapRunnerSetupSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    const immutableBytes = readFileSync(file);
    writeFileSync(file, JSON.stringify(snapshot, null, 2));
    expect(() => persistRenewalSetup(f.state, setup, approved)).toThrow("snapshot bytes changed");
    writeFileSync(file, immutableBytes);
    const claimed = {
      ...approved,
      revision: randomUUID(),
      execution: {
        generation: randomUUID(),
        stage: "claimed" as const,
        updatedAt: new Date().toISOString(),
      },
    };
    f.writeRecords([f.record, claimed]);
    await retainRenewalGeneration({
      setup: snapshot,
      setupFile: file,
      request: claimed,
      watchdog: false,
    });
    unlinkSync(f.current);
    symlinkSync(f.previous.directory, f.current);
    f.ports.hostPid = async () => {
      throw new Error("Host disappeared");
    };
    await expect(verifyRetainedRenewal(snapshot, claimed, true)).resolves.toBeUndefined();
    await expect(
      retainRenewalGeneration({
        setup: snapshot,
        setupFile: file,
        request: claimed,
        watchdog: true,
      }),
    ).resolves.toBeUndefined();
    // A failed candidate dependency must not require a complete tree walk during recovery.
    f.save(path.join(f.host.directory, "failed-candidate-dependency.js"), "broken", true);
    await expect(verifyRetainedRenewal(snapshot, claimed, true)).resolves.toBeUndefined();
    await expect(verifyRetainedRenewal(snapshot, claimed)).rejects.toThrow("runtime changed");
    const substitute = f.save(path.join(f.state, "substitute.json"), snapshot).path;
    await expect(
      retainRenewalGeneration({
        setup: snapshot,
        setupFile: substitute,
        request: claimed,
        watchdog: true,
      }),
    ).rejects.toThrow("substitution");
    snapshot.renewal!.request!.revision = randomUUID();
    f.save(file, snapshot);
    await expect(
      retainRenewalGeneration({
        setup: snapshot,
        setupFile: file,
        request: claimed,
        watchdog: true,
      }),
    ).rejects.toThrow("substitution");
  },
);

test.runIf(process.platform === "darwin")(
  "live dispatch reconstruction refuses a changed Host while retained context remains available",
  async () => {
    const f = await fixture();
    const setup = (await f.derive())!;
    const approved = {
      ...f.record,
      id: randomUUID(),
      revision: randomUUID(),
      execution: undefined,
    };
    const file = persistRenewalSetup(f.state, setup, approved);
    const snapshot = BootstrapRunnerSetupSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    f.writeRecords([f.record, approved]);
    await expect(f.derive({ dispatchedRequest: snapshot.renewal!.request })).resolves.toBeDefined();
    unlinkSync(f.current);
    symlinkSync(f.previous.directory, f.current);
    await expect(f.derive({ dispatchedRequest: snapshot.renewal!.request })).rejects.toThrow(
      "stale",
    );
    await expect(verifyRetainedRenewal(snapshot, approved, true)).resolves.toBeUndefined();
  },
);

test("Host identity binds exact executable, argv, owner and process lifetime", () => {
  const observed = {
    pid: 303,
    parentPid: 202,
    uid: process.getuid!(),
    bootId: randomUUID(),
    startIdentity: "3:4",
    executable: "/fixture/node",
    argumentsSha256: sha(
      JSON.stringify(["/fixture/node", path.join("/fixture/release", workerRelative)]),
    ),
  };
  const input = {
    observed,
    pid: observed.pid,
    uid: observed.uid,
    node: observed.executable,
    root: "/fixture/release",
  };
  expect(verifyRenewalHostProcess(input)).toEqual(observed);
  for (const change of [
    { pid: 304 },
    { uid: observed.uid + 1 },
    { parentPid: 1 },
    { executable: "/other/node" },
    { argumentsSha256: "f".repeat(64) },
  ])
    expect(() =>
      verifyRenewalHostProcess({ ...input, observed: { ...observed, ...change } }),
    ).toThrow("Running Host");
});

test.runIf(process.platform === "darwin")(
  "renewal rechecks before exact owner approval and before durable dispatch claim",
  async () => {
    const f = await fixture();
    const setup = (await f.derive())!;
    const plan = {
      ...f.plan,
      previous: f.coordinator,
      candidate: f.host,
      automaticRecovery: "restore-compatible" as const,
      compatibleRecovery: f.host,
    };
    const requests = new CoordinatorBootstrapRequests(
      new FileBootstrapRequestJournal(f.state),
      () => readBootstrapHostBinding(f.configuration.path, "host-id").binding,
      async (candidate) => {
        const current = await f.derive();
        expect(current).toEqual(setup);
        await verifyRenewalPlan(setup, candidate);
      },
    );
    const pending = await requests.prepare({
      id: randomUUID(),
      reason: "disposable renewal",
      plan,
    });
    const decision = {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    };
    unlinkSync(f.current);
    symlinkSync(f.previous.directory, f.current);
    await expect(requests.decide(decision, "fixture")).rejects.toThrow("stale");
    expect(requests.list().find((item) => item.id === pending.id)?.status).toBe("pending");
    unlinkSync(f.current);
    symlinkSync(f.host.directory, f.current);
    const approved = await requests.decide(decision, "fixture");
    await expect(requests.decide(decision, "fixture")).rejects.toThrow();
    unlinkSync(f.current);
    symlinkSync(f.previous.directory, f.current);
    await expect(
      requests.claimDispatch({
        id: approved.id,
        revision: approved.revision,
        planSha256: approved.planSha256,
      }),
    ).rejects.toThrow("stale");
    expect(requests.list().find((item) => item.id === approved.id)?.execution).toBeUndefined();
  },
);

test.runIf(process.platform === "darwin")(
  "native disposable Host identity verifies physical Node and exact loaded worker argv",
  async () => {
    const f = await fixture();
    const node = realpathSync(process.execPath);
    f.save(path.join(f.host.directory, workerRelative), "setInterval(() => {}, 1000);", true);
    const helperBytes = readFileSync(
      new URL("../../../../../scripts/inspect-coordinator-process.py", import.meta.url),
    );
    const helper = f.save(
      path.join(f.root, "native-inspector.py"),
      helperBytes.toString("utf8"),
      true,
    );
    const child = spawn(node, [path.join(f.host.directory, workerRelative)], {
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    });
    await once(child, "spawn");
    const closed = once(child, "close");
    try {
      const reader = await createNativeBootstrapServiceReader({
        helperPath: helper.path,
        helperSha256: helper.sha256,
        writableMountRoots: [],
      });
      await reader.inspectRunningProcess(child.pid!);
      const observed = await reader.inspectProcess(child.pid!);
      expect(
        verifyRenewalHostProcess({
          observed,
          pid: child.pid!,
          node,
          root: f.host.directory,
          uid: process.getuid!(),
        }),
      ).toEqual(observed);
      expect(() =>
        verifyRenewalHostProcess({
          observed,
          pid: child.pid!,
          node,
          root: f.previous.directory,
          uid: process.getuid!(),
        }),
      ).toThrow("Running Host");
    } finally {
      child.kill("SIGTERM");
      await closed;
    }
  },
);

test.runIf(process.platform === "darwin")(
  "recovery initializer validates selected Host from terminal authority without mutations",
  async () => {
    const f = await fixture();
    const before = readFileSync(path.join(f.state, "coordinator-bootstrap.json"), "utf8");
    const service = await createManagedPreclaimRecoveryReview(f.setupFile, f.original.daemonId, {
      ...f.ports,
      moduleFile: path.join(f.host.directory, runnerRelative),
      hostProcessId: f.hostProcess.pid,
    });
    expect(service?.available).toBe(true);
    expect(service?.list()).toEqual([]);
    expect(readFileSync(path.join(f.state, "coordinator-bootstrap.json"), "utf8")).toBe(before);
    expect(readFileSync(f.setupFile, "utf8")).toBe(JSON.stringify(f.original));
  },
);

test
  .runIf(process.platform === "darwin")
  .each(["exact", "other-pending", "claimed", "stale", "changes-during-read", "selected-config"])(
  "preclaim runtime derivation excludes only the exact unclaimed approval (%s)",
  async (mode) => {
    const f = await fixture();
    const original = structuredClone(f.record);
    original.id = randomUUID();
    original.revision = randomUUID();
    delete original.execution;
    original.plan.previous = f.coordinator;
    original.plan.candidate = f.host;
    const observed = await f.ports.reader.inspectProcess(404);
    original.plan.expectedProcess = {
      pid: observed.pid,
      bootId: observed.bootId,
      startIdentity: observed.startIdentity,
      argumentsSha256: observed.argumentsSha256,
    };
    if (mode === "selected-config")
      original.plan.previous = {
        ...f.coordinator,
        configuration: { ...f.coordinator.configuration, sha256: "f".repeat(64) },
      };
    original.planSha256 = coordinatorPlanDigest(original.plan);
    if (mode === "claimed") original.execution = { ...f.record.execution!, stage: "claimed" };
    const records = [f.record, structuredClone(original)];
    if (mode === "other-pending")
      records.push({ ...structuredClone(original), id: randomUUID(), revision: randomUUID() });
    if (mode === "stale") records[1]!.revision = randomUUID();
    f.writeRecords(records);
    const before = readFileSync(path.join(f.state, "coordinator-bootstrap.json"), "utf8");
    let changed = false;
    const operation = derivePreclaimHostRuntime({
      setupFile: f.setupFile,
      daemonId: f.original.daemonId,
      original,
      ports: {
        ...f.ports,
        moduleFile: path.join(f.host.directory, runnerRelative),
        hostProcessId: f.hostProcess.pid,
        writableMountRoots: async () => {
          if (mode === "changes-during-read" && !changed) {
            changed = true;
            records[1]!.revision = randomUUID();
            f.writeRecords(records);
          }
          return [];
        },
      },
    });
    if (mode === "exact") {
      const derived = await operation;
      expect(derived.runtimeDirectory).toBe(f.host.directory);
      expect(derived.runtimeSha256).toBe(f.host.artifactSha256);
      expect(derived.renewal!.configuration).toEqual(f.configuration);
      expect(derived.renewal!.terminal.id).toBe(f.record.id);
      expect(derived.renewal!.request).toBeUndefined();
      const service = await createManagedPreclaimRecoveryReview(f.setupFile, f.original.daemonId, {
        ...f.ports,
        moduleFile: path.join(f.host.directory, runnerRelative),
        hostProcessId: f.hostProcess.pid,
      });
      expect(service?.available).toBe(true);
      expect(service?.list()).toEqual([]);
    } else {
      await expect(operation).rejects.toThrow();
      if (mode === "other-pending" || mode === "claimed")
        await expect(
          createManagedPreclaimRecoveryReview(f.setupFile, f.original.daemonId, {
            ...f.ports,
            moduleFile: path.join(f.host.directory, runnerRelative),
            hostProcessId: f.hostProcess.pid,
          }),
        ).rejects.toThrow("unambiguous unclaimed target");
    }
    if (mode !== "changes-during-read")
      expect(readFileSync(path.join(f.state, "coordinator-bootstrap.json"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(f.setupFile, "utf8"))).toEqual(f.original);
  },
);

test
  .runIf(process.platform === "darwin")
  .each([
    "exact",
    "pending",
    "stale",
    "canceled-during-read",
    "changed-snapshot",
    "attempted",
    "changed-admission",
    "cancel-before-spawn",
    "snapshot-before-spawn",
    "spawn-only",
  ])(
  "preclaim snapshot requires its own exact approval and preserves installed anchors (%s)",
  async (mode) => {
    const { persistPreclaimLaunchSetup, PreclaimRunnerSetupSchema, prepareNativePreclaimLaunch } =
      await import("./coordinator-bootstrap-launch.js");
    const { preclaimRecoveryPlanDigest } =
      await import("./coordinator-bootstrap-preclaim-recovery.js");
    const { FileBootstrapPreclaimJournal } =
      await import("./coordinator-bootstrap-preclaim-journal.js");
    const f = await fixture();
    const original = structuredClone(f.record);
    original.id = randomUUID();
    original.revision = randomUUID();
    delete original.execution;
    original.plan.previous = f.coordinator;
    original.plan.candidate = f.host;
    const coordinator = await f.ports.reader.inspectProcess(404);
    original.plan.expectedProcess = {
      pid: coordinator.pid,
      bootId: coordinator.bootId,
      startIdentity: coordinator.startIdentity,
      argumentsSha256: coordinator.argumentsSha256,
    };
    original.planSha256 = coordinatorPlanDigest(original.plan);
    f.writeRecords([f.record, original]);
    const setup = f.save(path.join(f.root, "target-setup.json"), {});
    const entry = {
      path: path.join(f.host.directory, runnerRelative),
      sha256: sha("export {}; // runner"),
    };
    const admission = JSON.parse(readFileSync(f.original.admissionSetupFile, "utf8"));
    const { decisionAt: _originalDecisionAt, ...originalWithoutDecision } = original;
    const plan = {
      version: 1 as const,
      operation: "bootstrap-preclaim-recovery" as const,
      original,
      canceled: {
        ...originalWithoutDecision,
        revision: randomUUID(),
        status: "canceled" as const,
      },
      executor: {
        identity: {
          ...f.hostProcess,
          pid: 505,
          parentPid: f.hostProcess.pid,
          argumentsSha256: sha(
            JSON.stringify([f.node.path, entry.path, setup.path, "executor", original.id]),
          ),
        },
        auditToken: [0, process.getuid!(), 0, 0, 0, 505, 0, 1],
      },
      hostProcess: f.hostProcess,
      coordinatorProcess: coordinator,
      setup,
      runner: f.host,
      executorEntrypoint: entry,
      ownerLauncher: {
        path: path.join(f.host.directory, "scripts/run-coordinator-owner.py"),
        sha256: sha("# disposable owner"),
      },
      selectedLauncher: { path: admission.launcherFile, sha256: f.coordinator.launcher.sha256 },
      selectedConfiguration: f.configuration,
      executionLock: {
        path: path.join(f.state, "coordinator-bootstrap-execution.lock"),
        device: "1",
        inode: "1",
      },
      signalPolicy: { terminate: "SIGTERM" as const, escalation: "none" as const, graceSeconds: 1 },
    };
    const request = {
      id: randomUUID(),
      revision: randomUUID(),
      requestedBy: "host-agent" as const,
      reason: "fixture recovery",
      createdAt: new Date().toISOString(),
      decisionAt: new Date().toISOString(),
      status: mode === "pending" ? ("pending" as const) : ("approved" as const),
      plan,
      planSha256: preclaimRecoveryPlanDigest(plan),
    };
    const journal = new FileBootstrapPreclaimJournal(f.state);
    journal.replaceReviews(
      [],
      [mode === "stale" ? { ...request, revision: randomUUID() } : request],
    );
    const file = path.join(
      f.state,
      `coordinator-preclaim-launch-${request.id}-${request.revision}.json`,
    );
    if (mode === "changed-snapshot") f.save(file, { retained: "do not overwrite" });
    if (mode === "attempted")
      f.save(
        path.join(f.state, `coordinator-preclaim-attempt-${request.id}-${request.revision}.json`),
        { uncertain: true },
      );
    let changed = false;
    let mountReads = 0;
    const input = {
      setupFile: f.setupFile,
      daemonId: f.original.daemonId,
      request,
      ports: {
        ...f.ports,
        moduleFile: path.join(f.host.directory, runnerRelative),
        hostProcessId: f.hostProcess.pid,
        writableMountRoots: async () => {
          mountReads++;
          if (mode === "changed-admission" && mountReads === 4)
            f.save(f.original.admissionSetupFile, {
              ...admission,
              helperPath: "/untrusted/redirect.py",
            });
          if (mode === "canceled-during-read" && !changed) {
            changed = true;
            journal.replaceReviews(journal.readReviews(), [
              { ...request, status: "canceled", revision: randomUUID() },
            ]);
          }
          return [];
        },
      },
    };
    const before = readFileSync(f.setupFile, "utf8");
    if (
      mode === "cancel-before-spawn" ||
      mode === "snapshot-before-spawn" ||
      mode === "spawn-only"
    ) {
      const launch = await prepareNativePreclaimLaunch(input);
      if (mode === "spawn-only") {
        // This fixture's immutable Python helper contains only a comment. Real
        // spawn acknowledgement must not invent a runner claim or success.
        await expect(launch()).resolves.toBeUndefined();
        expect(journal.readReviews()).toEqual([request]);
        await expect(launch()).rejects.toThrow("already attempted");
        expect(readFileSync(f.setupFile, "utf8")).toBe(before);
        expect(new FileBootstrapRequestJournal(f.state).read()).toEqual([f.record, original]);
        return;
      }
      if (mode === "cancel-before-spawn")
        journal.replaceReviews(
          [request],
          [{ ...request, revision: randomUUID(), status: "canceled" }],
        );
      else f.save(file, { replaced: true });
      await expect(launch()).rejects.toThrow(
        mode === "cancel-before-spawn"
          ? "Recovery decision changed before launch"
          : "digest changed",
      );
      await expect(launch()).rejects.toThrow("already attempted");
      expect(() =>
        readFileSync(
          path.join(f.state, `coordinator-preclaim-attempt-${request.id}-${request.revision}.json`),
        ),
      ).toThrow();
    } else if (mode === "exact") {
      expect(await persistPreclaimLaunchSetup(input)).toBe(file);
      const bytes = readFileSync(file, "utf8");
      const snapshot = PreclaimRunnerSetupSchema.parse(JSON.parse(bytes));
      expect(snapshot.request.id).toBe(request.id);
      expect(snapshot.original.id).toBe(original.id);
      expect(snapshot.runtimeDirectory).toBe(f.host.directory);
      expect(snapshot.renewal.configuration).toEqual(f.configuration);
      expect(await persistPreclaimLaunchSetup(input)).toBe(file);
      expect(readFileSync(file, "utf8")).toBe(bytes);
      const service = await createManagedPreclaimRecoveryReview(
        input.setupFile,
        input.daemonId,
        input.ports,
      );
      expect(service!.list()).toEqual([{ ...request, dispatch: { state: "no_receipt" } }]);
      expect(journal.readReviews()).toEqual([request]);
    } else {
      await expect(persistPreclaimLaunchSetup(input)).rejects.toThrow(
        mode === "changed-admission" ? "digest changed" : undefined,
      );
      if (mode === "changed-snapshot")
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ retained: "do not overwrite" });
      else expect(() => readFileSync(file)).toThrow();
    }
    expect(readFileSync(f.setupFile, "utf8")).toBe(before);
    expect(new FileBootstrapRequestJournal(f.state).read()).toEqual([f.record, original]);
  },
);
