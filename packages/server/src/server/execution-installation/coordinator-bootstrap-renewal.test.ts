import { readBoundedMaintenanceInspection } from "./coordinator-bootstrap-maintenance-service-native.js";
import {
  readInitialHostObservation,
  initialHostObservationPending,
} from "./maintenance/host-supervisor-recovery-inspection.js";
import {
  derivePreclaimHostRuntime,
  createManagedPreclaimRecoveryReview,
} from "./coordinator-bootstrap-launch.js";
import { afterEach, expect, test, vi } from "vitest";
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
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { hashSync } from "bcryptjs";
import {
  CoordinatorBootstrapPlanSchema,
  BootstrapProcessIdentitySchema,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { coordinatorPlanDigest, CoordinatorBootstrapRequests } from "./coordinator-bootstrap.js";
import { readBootstrapHostBinding } from "./coordinator-bootstrap-host.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseLifecycleJournal } from "./lifecycle-journal.js";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import {
  BootstrapRunnerSetupSchema,
  resolveBootstrapBootSetup,
  verifyBootRunnerBinding,
} from "./coordinator-bootstrap-runner.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { InstallationConfigSchema } from "./config.js";
import { BootstrapAdmissionSetupSchema } from "./coordinator-bootstrap-host.js";
import { InstallationEnrollmentManifestSchema } from "@getpaseo/protocol/installation-enrollment";
import {
  enrollInstallation,
  enrollmentManifestDigest,
  FileEnrollmentJournal,
} from "./maintenance/authorization.js";
import { retainEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import { inspectEffectiveMaintenanceConfiguration } from "./coordinator-bootstrap-maintenance-observation-runtime.js";
import {
  createCoordinatorObservationCollection,
  deriveBootstrapRenewal,
  inspectSelectedCoordinatorRuntime,
  persistRenewalSetup,
  retainRenewalGeneration,
  terminalBootstrapRelease,
  verifyRenewalHostProcess,
  verifyRenewalPlan,
  verifyRetainedRenewal,
  verifyHistoricalRenewal,
  type BootstrapRenewalPorts,
} from "./coordinator-bootstrap-renewal.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const runnerRelative =
  "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js";
const workerRelative = "packages/server/dist/server/server/daemon-worker.js";
const mainRelative = "packages/server/dist/server/server/execution-installation/main.js";

test.runIf(process.platform === "darwin")(
  "retained verification kills a SIGTERM-ignoring reader within its existing deadline",
  async () => {
    const f = await fixture();
    const pidFile = path.join(f.root, "reader-pid");
    const ignoredFile = path.join(f.root, "reader-ignored-term");
    const emergencyFile = path.join(f.root, "reader-emergency-exit");
    const reader = f.save(
      path.join(f.root, "hanging-reader.mjs"),
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(ignoredFile)}, "ignored"));
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.kill(process.pid, "SIGTERM");
process.stdin.resume();
setInterval(() => {}, 1000);
setTimeout(() => {
  writeFileSync(${JSON.stringify(emergencyFile)}, "expired");
  process.exit(17);
}, 130000);
`,
      true,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const executable = f.save(
      path.join(f.root, "reader-node"),
      `#!/bin/sh\nexec ${quote(realpathSync(process.execPath))} ${quote(reader.path)}\n`,
      true,
      0o700,
    );
    const before = readFileSync(path.join(f.state, "coordinator-bootstrap.json"));
    const originalArguments = process.argv;
    const started = performance.now();
    const verification = (() => {
      try {
        process.argv = [
          process.execPath,
          fileURLToPath(new URL("./coordinator-bootstrap-runner.js", import.meta.url)),
          "/fixture/setup.json",
          "executor",
        ];
        return verifyRetainedRenewal({ ...f.original, node: executable });
      } finally {
        process.argv = originalArguments;
      }
    })().then(
      () => "verified",
      () => "refused",
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.waitFor(() => expect(readFileSync(ignoredFile, "utf8")).toBe("ignored"), {
        timeout: 5000,
      });
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
      const outcome = await Promise.race([
        verification,
        new Promise<string>((resolve) => {
          deadline = setTimeout(() => resolve("deadline exceeded"), 125000);
        }),
      ]);
      expect(outcome).toBe("refused");
      expect(performance.now() - started).toBeGreaterThanOrEqual(119000);
      expect(performance.now() - started).toBeLessThan(125000);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(() => readFileSync(emergencyFile)).toThrow();
      expect(readFileSync(path.join(f.state, "coordinator-bootstrap.json"))).toEqual(before);
    } finally {
      clearTimeout(deadline);
      // The fixture's own emergency exit also bounds cleanup if the regression returns.
      await verification;
    }
  },
  145000,
);

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

async function sharedCoordinatorFixture() {
  const f = await fixture();
  const identity = {
    version: 1,
    environment: "host",
    target: "coordinator",
    installationId: f.identity.installationId,
    custodyOwnerUid: process.getuid!(),
    installationRoot: f.root,
    stateDirectory: f.state,
    serviceDomain: f.identity.service.split("/").slice(0, 2).join("/"),
    serviceLabel: f.identity.service.split("/").at(-1),
    launcherPath: path.join(f.root, "selected.plist"),
    selectionPath: null,
  };
  let observed = await f.ports.reader.inspectProcess(404);
  let serviceCurrent = true;
  const ports = {
    reader: {
      ...f.ports.reader,
      inspectProcess: async (pid: number) => {
        if (pid === 404) return observed;
        return f.ports.reader.inspectProcess(pid);
      },
    },
    assertCurrent(service: string, expected: unknown) {
      expect(service).toBe(f.identity.service);
      if (!serviceCurrent || !isDeepStrictEqual(observed, expected))
        throw new Error("native selection changed");
    },
  };
  const inspect = async () => {
    const witness = await inspectSelectedCoordinatorRuntime({
      identity,
      executables: [f.node.path],
      writableMountRoots: [],
      ports,
    });
    if (!witness) throw new Error("Fixture requires shared runtime proof");
    return witness;
  };
  return {
    ...f,
    identity,
    inspect,
    ports,
    changeProcess(value: unknown) {
      observed = value;
    },
    changeService() {
      serviceCurrent = false;
    },
  };
}

test.each(["succeeded", "rolled_back", "resumed"] as const)(
  "shared coordinator witness verifies the exact %s selected runtime",
  async (stage) => {
    const f = await sharedCoordinatorFixture();
    const record = structuredClone(f.record);
    record.execution!.stage = stage;
    f.writeRecords([record]);
    const selected = stage === "succeeded" ? f.coordinator : f.previous;
    f.save(f.identity.launcherPath, JSON.parse(readFileSync(selected.launcher.path, "utf8")));
    const actual = BootstrapProcessIdentitySchema.parse(await f.ports.reader.inspectProcess(404));
    f.changeProcess({
      ...actual,
      argumentsSha256: sha(
        JSON.stringify([selected.node.path, selected.entrypoint.path, selected.configuration.path]),
      ),
    });
    const witness = await f.inspect();
    expect(witness.target).toBe("coordinator");
    expect(witness.process.pid).toBe(404);
    expect(witness.process.executable).toBe(f.node.path);
    witness.assertCurrent();
    f.changeService();
    expect(() => witness.assertCurrent()).toThrow("native selection changed");
  },
);

test("shared coordinator witness rejects changed lifetime, selected history and transfer proof", async () => {
  const f = await sharedCoordinatorFixture();
  const witness = await f.inspect();
  const actual = BootstrapProcessIdentitySchema.parse(await f.ports.reader.inspectProcess(404));
  f.changeProcess({ ...actual, startIdentity: "99:99" });
  expect(() => witness.assertCurrent()).toThrow("native selection changed");
  f.changeProcess(actual);
  f.writeRecords([{ ...f.record, revision: randomUUID() }]);
  expect(() => witness.assertCurrent()).toThrow("selection or custody changed");
  f.writeRecords([f.record]);
  const file = path.join(f.state, `coordinator-transfer-${f.record.execution!.generation}.json`);
  f.save(file, { version: 1, requestId: randomUUID() });
  expect(() => witness.assertCurrent()).toThrow("custody changed");
  await expect(f.inspect()).rejects.toThrow();
});

async function successorConfigurationFixture() {
  const f = await sharedCoordinatorFixture();
  const identitySha256 = retainEnrollmentNativeIdentity(f.state, f.identity);
  const manifest = InstallationEnrollmentManifestSchema.parse({
    version: 1,
    operation: "installation-enrollment",
    installationId: f.identity.installationId,
    revision: randomUUID(),
    createdAt: "2026-10-17T00:00:00.000Z",
    targets: [
      { target: "coordinator", identitySha256, operations: ["replacement"] },
      {
        target: "maintenance-controller",
        identitySha256: "1".repeat(64),
        operations: ["replacement"],
      },
      { target: "recovery-launcher", identitySha256: "2".repeat(64), operations: ["replacement"] },
    ],
    trustedRepositories: ["https://example.test/installation.git"],
    provisioning: null,
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 10 },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    steps: [
      {
        id: randomUUID(),
        target: "coordinator",
        operation: "replacement",
        planSha256: coordinatorPlanDigest(f.plan),
        candidate: {
          sourceCommit: f.coordinator.sourceCommit,
          artifactSha256: f.coordinator.artifactSha256,
        },
        previous: {
          sourceCommit: f.previous.sourceCommit,
          artifactSha256: f.previous.artifactSha256,
        },
        dependsOn: [],
      },
    ],
  });
  const enrollment = new FileEnrollmentJournal(f.state);
  enrollInstallation(enrollment, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: "2026-10-17T00:00:00.000Z",
    },
  });
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(readFileSync(f.original.admissionSetupFile, "utf8")),
  );
  const configuration = InstallationConfigSchema.parse(f.config);
  const input = {
    configuration,
    configurationFile: f.configuration.path,
    admission,
    writableMountRoots: [],
    ports: f.ports,
  };
  return { ...f, enrollment, input };
}

test("effective maintenance configuration preserves cold anchor observation without terminal history", async () => {
  const f = await fixture();
  f.writeRecords([]);
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(readFileSync(f.original.admissionSetupFile, "utf8")),
  );
  const configuration = InstallationConfigSchema.parse(
    JSON.parse(readFileSync(f.originalConfiguration.path, "utf8")),
  );
  const proof = await inspectEffectiveMaintenanceConfiguration({
    configuration,
    configurationFile: f.originalConfiguration.path,
    admission,
    writableMountRoots: [],
  });
  expect(proof.admission).toEqual(admission);
  proof.assertCurrent();
  f.save(f.originalConfiguration.path, { ...configuration, listenPort: 6765 });
  expect(proof.assertCurrent).toThrow("custody changed");
});

test("effective maintenance configuration verifies the selected successor without rewriting its anchor", async () => {
  const f = await successorConfigurationFixture();
  const original = readFileSync(f.originalConfiguration.path);
  const proof = await inspectEffectiveMaintenanceConfiguration(f.input);
  expect(proof.admission).toEqual({
    ...f.input.admission,
    configurationFile: f.configuration.path,
  });
  expect(f.input.admission.configurationFile).toBe(f.originalConfiguration.path);
  expect(readFileSync(f.originalConfiguration.path)).toEqual(original);
  proof.admission.configurationFile = f.originalConfiguration.path;
  expect(proof.assertCurrent).toThrow("approval or custody changed");
  proof.admission.configurationFile = f.configuration.path;
  f.enrollment.update((state) => {
    if (state.status !== "enrolled") throw Error("Fixture enrollment absent");
    return { ...state, grant: { ...state.grant, revokedAt: "2026-10-17T00:01:00.000Z" } };
  });
  proof.assertCurrent();
  f.changeService();
  expect(proof.assertCurrent).toThrow("native selection changed");
});

test.each(["wrong-path", "unresolved-history", "credentials", "unpinned-bytes"])(
  "effective maintenance configuration refuses %s without adopting caller expectations",
  async (kind) => {
    const f = await successorConfigurationFixture();
    if (kind === "wrong-path")
      f.input.configurationFile = f.save(path.join(f.root, "unselected.json"), f.config).path;
    if (kind === "unresolved-history") {
      const record = structuredClone(f.record);
      record.execution!.stage = "claimed";
      f.writeRecords([record]);
    }
    if (kind === "credentials") f.input.configuration.containerAgentTokenHash = "c".repeat(64);
    if (kind === "unpinned-bytes") f.save(f.configuration.path, { ...f.config, listenPort: 6765 });
    await expect(inspectEffectiveMaintenanceConfiguration(f.input)).rejects.toThrow();
  },
);

test.each(["runtime-file", "native-callback"])(
  "shared coordinator witness retains %s through its final assertion",
  async (kind) => {
    const f = await sharedCoordinatorFixture();
    const witness = await f.inspect();
    if (kind === "runtime-file")
      f.save(path.join(f.coordinator.directory, workerRelative), "changed", true);
    else f.ports.assertCurrent = () => {};
    expect(witness.assertCurrent).toThrow();
  },
);

test.each(["initial-process", "process", "history", "returned-process", "returned-release"])(
  "shared coordinator witness refuses %s mutation across native custody",
  async (kind) => {
    const f = await sharedCoordinatorFixture();
    const native = f.ports.assertCurrent;
    let mutate = kind === "initial-process";
    f.ports.assertCurrent = (service, expected) => {
      native(service, expected);
      if (!mutate) return;
      if (kind === "history") f.writeRecords([{ ...f.record, revision: randomUUID() }]);
      else if (expected && typeof expected === "object" && "pid" in expected) expected.pid = 999;
    };
    if (kind === "initial-process") {
      await expect(f.inspect()).rejects.toThrow("selection or custody changed");
      return;
    }
    const witness = await f.inspect();
    if (kind === "returned-process") witness.process.pid = 999;
    else if (kind === "returned-release")
      witness.release.configuration.path = f.originalConfiguration.path;
    else mutate = true;
    expect(witness.assertCurrent).toThrow("selection or custody changed");
  },
);

test("effective maintenance configuration rechecks the original anchor after the final native callback", async () => {
  const f = await successorConfigurationFixture();
  const host = await import("./coordinator-bootstrap-host.js");
  const inspection = await import("./coordinator-bootstrap-maintenance-service-inspection.js");
  const { inspectMaintenanceObservationRuntime } =
    await import("./coordinator-bootstrap-maintenance-observation-runtime.js");
  const anchor = path.join(f.root, "coordinator-bootstrap-runner.json");
  f.save(anchor, { admissionSetupFile: f.original.admissionSetupFile });
  let mutate = false;
  vi.spyOn(host, "inspectBootstrapWritableMountRoots").mockResolvedValue([]);
  vi.spyOn(inspection, "createMaintenanceServiceInspectionPorts").mockResolvedValue({
    reader: {
      ...f.ports.reader,
      async inspectAuditedProcess() {
        throw Error("Unused audited reader");
      },
      async inspectRunningProcess() {
        throw Error("Unused running reader");
      },
      async verifyServiceAbsent() {
        throw Error("Unused absence reader");
      },
      async inspectStoppedProcess() {
        throw Error("Unused stopped reader");
      },
    },
    assertCurrent(service, process) {
      f.ports.assertCurrent(service, process);
      if (mutate) f.save(anchor, { admissionSetupFile: "/substituted/admission.json" });
    },
  });
  const proof = await inspectMaintenanceObservationRuntime({
    configuration: f.input.configuration,
    configurationFile: f.configuration.path,
  });
  mutate = true;
  expect(proof.assertCurrent).toThrow("custody changed");
});

test("shared coordinator witness refuses live installer, unresolved history and launcher substitution", async () => {
  const f = await sharedCoordinatorFixture();
  const inspectProcess = f.ports.reader.inspectProcess;
  const executor = JSON.parse(
    readFileSync(
      path.join(f.state, `coordinator-executor-${f.record.execution!.generation}.json`),
      "utf8",
    ),
  );
  // The PID is held, so native absence proof fails and birth identity decides.
  const verifyProcessExited = f.ports.reader.verifyProcessExited;
  f.ports.reader.verifyProcessExited = async (pid: number) => {
    if (pid === 777) throw new Error("PID 777 is held");
    return verifyProcessExited(pid);
  };
  f.ports.reader.inspectProcess = async (pid) =>
    pid === 777 ? executor.process : inspectProcess(pid);
  await expect(f.inspect()).rejects.toThrow("lifetime exit is unproven");
  // macOS reuses PIDs: a later birth at the recorded PID in the same boot proves the updater exited.
  f.ports.reader.inspectProcess = async (pid) =>
    pid === 777
      ? {
          ...f.hostProcess,
          ...executor.process,
          startIdentity: "2:0",
          argumentsSha256: "b".repeat(64),
        }
      : inspectProcess(pid);
  await expect(f.inspect()).resolves.toBeDefined();
  // An earlier birth at that PID is not proof of exit.
  f.ports.reader.inspectProcess = async (pid) =>
    pid === 777 ? { ...executor.process, startIdentity: "0:5" } : inspectProcess(pid);
  await expect(f.inspect()).rejects.toThrow("lifetime exit is unproven");
  const g = await sharedCoordinatorFixture();
  const running = structuredClone(g.record);
  running.execution!.stage = "claimed";
  g.writeRecords([running]);
  await expect(g.inspect()).rejects.toThrow("terminal");
  g.writeRecords([g.record]);
  g.save(g.identity.launcherPath, JSON.parse(readFileSync(g.previous.launcher.path, "utf8")));
  await expect(g.inspect()).rejects.toThrow("digest changed");
});

test("shared coordinator exemption is optional for an unrelated selected Node", async () => {
  const f = await sharedCoordinatorFixture();
  let nativeCalls = 0;
  const result = await inspectSelectedCoordinatorRuntime({
    identity: f.identity,
    executables: [path.join(f.root, "different-node")],
    writableMountRoots: [],
    ports: {
      reader: {
        ...f.ports.reader,
        readService: async () => {
          nativeCalls++;
          throw new Error("coordinator absent");
        },
      },
      assertCurrent() {
        throw new Error("no native witness requested");
      },
    },
  });
  expect(result).toBeUndefined();
  expect(nativeCalls).toBe(0);
});

test("enrolled shared coordinator witness rechecks under the existing lifecycle lock", async () => {
  const f = await sharedCoordinatorFixture();
  const { changeStandingGrant } = await import("./maintenance/authorization.js");
  const { inspectMaintenanceLauncherPlan } =
    await import("./coordinator-bootstrap-maintenance-launcher.js");
  const { inspectMaintenanceCoordinatorWitness } =
    await import("./coordinator-bootstrap-maintenance-executor-evidence.js");
  const coordinatorDigest = retainEnrollmentNativeIdentity(f.state, f.identity);
  const label = `local.vorteo.${f.identity.installationId}.controller.installation`;
  const base = path.join(f.root, "maintenance-services", "maintenance-controller");
  const commit = "d".repeat(40),
    directory = path.join(f.root, "maintenance-runtimes", commit);
  const original = inspectMaintenanceLauncherPlan(
    {
      version: 1,
      operation: "maintenance-launcher-replacement",
      retryLimit: 3,
      recovery: "after-login",
      previous: null,
      identity: {
        ...f.identity,
        target: "maintenance-controller",
        serviceLabel: label,
        launcherPath: path.join(f.root, "Library", "LaunchAgents", label + ".plist"),
        selectionPath: path.join(base, "selection.json"),
      },
      candidate: {
        sourceCommit: commit,
        directory,
        artifactSha256: "d".repeat(64),
        node: f.node,
        entrypoint: { path: path.join(directory, runnerRelative), sha256: "e".repeat(64) },
        setup: { path: path.join(base, commit + ".json"), sha256: "f".repeat(64) },
      },
    },
    { uid: process.getuid!(), home: f.root },
  );
  const step = randomUUID();
  const manifest = InstallationEnrollmentManifestSchema.parse({
    version: 1,
    operation: "installation-enrollment",
    installationId: f.identity.installationId,
    revision: randomUUID(),
    createdAt: "2026-10-15T00:00:00.000Z",
    targets: [
      {
        target: "maintenance-controller",
        identitySha256: "a".repeat(64),
        operations: ["replacement"],
      },
      { target: "recovery-launcher", identitySha256: "b".repeat(64), operations: ["replacement"] },
      { target: "coordinator", identitySha256: coordinatorDigest, operations: ["replacement"] },
    ],
    trustedRepositories: ["https://example.test/fixture"],
    provisioning: null,
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 5 },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    steps: [
      {
        id: step,
        target: "recovery-launcher",
        operation: "replacement",
        planSha256: "a".repeat(64),
        candidate: { sourceCommit: commit, artifactSha256: "d".repeat(64) },
        previous: null,
        dependsOn: [],
      },
    ],
  });
  const enrollment = new FileEnrollmentJournal(f.state);
  const state = enrollInstallation(enrollment, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: "2026-10-15T01:00:00.000Z",
    },
  });
  const plan = {
    version: 2,
    operation: "maintenance-service-recovery",
    originalPlanSha256: original.planSha256,
    original: original.plan,
    recoveryOf: {
      requestId: randomUUID(),
      generation: randomUUID(),
      planSha256: original.planSha256,
      observationSha256: "a".repeat(64),
    },
  };
  const witness = await inspectMaintenanceCoordinatorWitness({
    installationId: f.identity.installationId,
    stateDirectory: f.state,
    account: { uid: process.getuid!(), home: f.root },
    plan,
    writableMountRoots: [],
    ports: {
      ...f.ports,
      reader: {
        ...f.ports.reader,
        inspectAuditedProcess: async () => {
          throw new Error("unused");
        },
        inspectRunningProcess: async () => {
          throw new Error("unused");
        },
        inspectStoppedProcess: async () => {
          throw new Error("unused");
        },
        verifyServiceAbsent: async () => {
          throw new Error("registered");
        },
      },
    },
  });
  if (!witness) throw new Error("Fixture requires shared coordinator witness");
  const journal = new FileBootstrapRequestJournal(f.state);
  expect(() => journal.withRecoveryTransaction(() => witness.assertCurrent())).not.toThrow();
  if (state.status !== "enrolled") throw new Error("Fixture enrollment absent");
  changeStandingGrant(enrollment, {
    expectedRevision: state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  expect(() => journal.withRecoveryTransaction(() => witness.assertCurrent())).not.toThrow();
});

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
    await expect(f.derive()).rejects.toThrow("Exact unpromoted bootstrap failure required");
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
  .each(["approved", "canceled", "unresolved", "wrong-reference", "other-pending"])(
  "preclaim admission validates retained recovery chains (%s)",
  async (mode) => {
    const f = await fixture();
    const failed = structuredClone(f.record);
    failed.id = randomUUID();
    failed.revision = randomUUID();
    failed.execution!.generation = randomUUID();
    failed.execution!.stage = "recovery_required";
    f.record.plan.recoveredFrom = {
      id: failed.id,
      revision: mode === "wrong-reference" ? randomUUID() : failed.revision,
      generation: failed.execution!.generation,
      planSha256: failed.planSha256,
    };
    f.record.planSha256 = coordinatorPlanDigest(f.record.plan);
    for (const kind of ["executor", "transfer"]) {
      const file = path.join(f.state, `coordinator-${kind}-${f.record.execution!.generation}.json`);
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      f.save(file, { ...receipt, planSha256: f.record.planSha256 });
    }
    const original = structuredClone(f.record);
    original.id = randomUUID();
    original.revision = randomUUID();
    delete original.execution;
    delete original.plan.recoveredFrom;
    original.plan.previous = f.coordinator;
    original.plan.candidate = f.host;
    const observed = await f.ports.reader.inspectProcess(404);
    original.plan.expectedProcess = {
      pid: observed.pid,
      bootId: observed.bootId,
      startIdentity: observed.startIdentity,
      argumentsSha256: observed.argumentsSha256,
    };
    original.planSha256 = coordinatorPlanDigest(original.plan);
    const ownerCancellation = {
      ...original,
      status: "canceled" as const,
      revision: randomUUID(),
      decisionAt: new Date().toISOString(),
    };
    const current = mode === "canceled" ? ownerCancellation : original;
    const records = mode === "unresolved" ? [failed, current] : [failed, f.record, current];
    if (mode === "other-pending")
      records.push({ ...original, id: randomUUID(), revision: randomUUID(), status: "pending" });
    f.writeRecords(records);
    const before = readFileSync(path.join(f.state, "coordinator-bootstrap.json"));
    const ports = {
      ...f.ports,
      moduleFile: path.join(f.host.directory, runnerRelative),
      hostProcessId: f.hostProcess.pid,
    };
    const initialize = () =>
      createManagedPreclaimRecoveryReview(f.setupFile, f.original.daemonId, ports);
    const derive = () =>
      derivePreclaimHostRuntime({
        setupFile: f.setupFile,
        daemonId: f.original.daemonId,
        original,
        ports,
        ...(mode === "canceled" ? { ownerCancellation } : {}),
      });
    if (mode === "approved" || mode === "canceled") {
      const service = await initialize();
      expect(service?.available).toBe(true);
      expect(service?.list()).toEqual([]);
      expect((await derive()).renewal?.terminal.id).toBe(f.record.id);
    } else {
      await expect(initialize()).rejects.toThrow();
      await expect(derive()).rejects.toThrow();
    }
    expect(readFileSync(path.join(f.state, "coordinator-bootstrap.json"))).toEqual(before);
    expect(JSON.parse(readFileSync(f.setupFile, "utf8"))).toEqual(f.original);
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
        ).rejects.toThrow(
          mode === "claimed" ? "generation is ambiguous" : "unambiguous unclaimed target",
        );
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
    "initialize",
    "initialize-fenced",
    "initialize-completed-verified",
    "initialize-completed-forged",
    "initialize-ambiguous",
    "initialize-changed",
    "initialize-anchor-changed",
  ])(
  "claimed snapshot requires its own exact approval and preserves installed anchors (%s)",
  async (mode) => {
    const {
      persistClaimedLaunchSetup,
      ClaimedRunnerSetupSchema,
      prepareNativeClaimedLaunch,
      createManagedClaimedRecoveryReview,
    } = await import("./coordinator-bootstrap-claimed-launch.js");
    const { claimedRecoveryPlanDigest } =
      await import("./coordinator-bootstrap-claimed-recovery.js");
    const { FileClaimedRecoveryReviewJournal } =
      await import("./coordinator-bootstrap-claimed-journal.js");
    const f = await fixture();
    const original = structuredClone(f.record);
    original.id = randomUUID();
    original.revision = randomUUID();
    original.execution = {
      generation: randomUUID(),
      stage: "claimed",
      updatedAt: new Date().toISOString(),
    };
    original.plan.automaticRecovery = "restore-compatible";
    original.plan.compatibleRecovery = f.host;
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
    f.save(path.join(f.state, "coordinator-bootstrap-pending.json"), {
      version: 1,
      requests: [original],
      promotions: [],
    });
    const setup = f.save(path.join(f.root, "target-setup.json"), {});
    const entry = {
      path: path.join(f.host.directory, runnerRelative),
      sha256: sha("export {}; // runner"),
    };
    const admission = JSON.parse(readFileSync(f.original.admissionSetupFile, "utf8"));
    const plan = {
      version: 1 as const,
      operation: "bootstrap-claimed-recovery" as const,
      original,
      dispatchApprovalRevision: randomUUID(),
      retainedObservation: setup,
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
      planSha256: claimedRecoveryPlanDigest(plan),
    };
    const journal = new FileClaimedRecoveryReviewJournal(f.state);
    journal.replaceReviews(
      [],
      [mode === "stale" ? { ...request, revision: randomUUID() } : request],
    );
    const file = path.join(
      f.state,
      `coordinator-claimed-launch-${request.id}-${request.revision}.json`,
    );
    if (mode === "changed-snapshot") f.save(file, { retained: "do not overwrite" });
    if (mode === "attempted")
      f.save(
        path.join(f.state, `coordinator-claimed-attempt-${request.id}-${request.revision}.json`),
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
          if (mode === "changed-admission" && mountReads === 1)
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
    const verifyInitialization = async () => {
      if (mode === "initialize-fenced") {
        const claimed = {
          ...request,
          revision: randomUUID(),
          execution: {
            generation: randomUUID(),
            stage: "claimed" as const,
            updatedAt: new Date().toISOString(),
          },
        };
        journal.replaceReviews([request], [claimed]);
        journal.fenceClaim(claimed);
      }
      if (mode === "initialize-ambiguous") {
        f.save(path.join(f.state, "coordinator-bootstrap-pending.json"), {
          version: 1,
          requests: [original, { ...original, id: randomUUID() }],
          promotions: [],
        });
      }
      let verifiedRenewal;
      if (mode.startsWith("initialize-completed")) {
        const terminalRuntime = await deriveBootstrapRenewal({
          setupFile: input.setupFile,
          setup: f.original,
          moduleFile: input.ports.moduleFile,
          hostPid: input.ports.hostProcessId,
          ports: input.ports,
          dispatchedRequest: { id: original.id, planSha256: original.planSha256 },
        });
        const historical = {
          ...original,
          id: randomUUID(),
          revision: randomUUID(),
          execution: { ...original.execution!, generation: randomUUID() },
        };
        const historicalPlan = {
          ...request.plan,
          original: historical,
          executor: {
            ...request.plan.executor,
            identity: {
              ...request.plan.executor.identity,
              argumentsSha256: sha(
                JSON.stringify([f.node.path, entry.path, setup.path, "executor", historical.id]),
              ),
            },
          },
        };
        const completed = {
          ...request,
          id: randomUUID(),
          revision: randomUUID(),
          plan: historicalPlan,
          planSha256: claimedRecoveryPlanDigest(historicalPlan),
          execution: {
            generation: randomUUID(),
            stage: "succeeded" as const,
            updatedAt: new Date().toISOString(),
          },
        };
        journal.replaceReviews([request], [completed, request]);
        f.save(path.join(f.state, "coordinator-bootstrap-pending.json"), {
          version: 1,
          requests: [
            {
              ...historical,
              revision: randomUUID(),
              execution: { ...historical.execution, stage: "recovery_required" },
            },
            original,
          ],
          promotions: [],
        });
        if (mode === "initialize-completed-verified") {
          // Isolate target classification from the existing terminal-evidence verifier.
          // The forged case below uses the real verifier and must fail closed.
          const renewalModule = await import("./coordinator-bootstrap-renewal.js");
          verifiedRenewal = vi
            .spyOn(renewalModule, "deriveBootstrapRenewal")
            .mockResolvedValue(terminalRuntime);
        }
      }
      const beforeRecords = new FileBootstrapRequestJournal(f.state).read();
      const beforeReviews = journal.readReviews();
      const beforeSetup = readFileSync(f.setupFile);
      const service = createManagedClaimedRecoveryReview(input.setupFile, input.daemonId, {
        ...input.ports,
        writableMountRoots: async () => {
          if (mode === "initialize-anchor-changed" && !changed) {
            changed = true;
            f.save(f.original.admissionSetupFile, {
              ...admission,
              helperPath: "/untrusted/changed.py",
            });
          }
          if (mode === "initialize-changed" && !changed) {
            changed = true;
            journal.replaceReviews(journal.readReviews(), [
              { ...request, status: "canceled", revision: randomUUID() },
            ]);
          }
          return [];
        },
      });
      if (mode === "initialize-completed-forged")
        await expect(service).rejects.toThrow(/ENOENT|fence/);
      else if (
        ["initialize-ambiguous", "initialize-changed", "initialize-anchor-changed"].includes(mode)
      )
        await expect(service).rejects.toThrow();
      else {
        const ready = await service;
        expect(ready?.available).toBe(true);
        expect(ready?.reconcile).toBeTypeOf("function");
        expect(ready?.list().map(({ dispatch: _dispatch, ...record }) => record)).toEqual(
          beforeReviews,
        );
        expect(journal.readReviews()).toEqual(beforeReviews);
      }
      if (verifiedRenewal) {
        expect(verifiedRenewal).toHaveBeenCalledOnce();
        expect(verifiedRenewal.mock.calls[0][0].dispatchedRequest).toEqual({
          id: original.id,
          planSha256: original.planSha256,
        });
      }
      expect(new FileBootstrapRequestJournal(f.state).read()).toEqual(beforeRecords);
      expect(readFileSync(f.setupFile)).toEqual(beforeSetup);
      expect(() => readFileSync(file)).toThrow();
    };
    if (mode.startsWith("initialize")) {
      await verifyInitialization();
      return;
    }
    const before = readFileSync(f.setupFile, "utf8");
    if (
      mode === "cancel-before-spawn" ||
      mode === "snapshot-before-spawn" ||
      mode === "spawn-only"
    ) {
      const launch = await prepareNativeClaimedLaunch(input);
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
          path.join(f.state, `coordinator-claimed-attempt-${request.id}-${request.revision}.json`),
        ),
      ).toThrow();
    } else if (mode === "exact") {
      expect(await persistClaimedLaunchSetup(input)).toBe(file);
      const bytes = readFileSync(file, "utf8");
      const snapshot = ClaimedRunnerSetupSchema.parse(JSON.parse(bytes));
      expect(snapshot.request.id).toBe(request.id);
      expect(snapshot.original.id).toBe(original.id);
      expect(snapshot.renewal.request).toEqual(snapshot.original);
      expect(snapshot.runtimeDirectory).toBe(f.host.directory);
      expect(snapshot.renewal.configuration).toEqual(f.configuration);
      expect(await persistClaimedLaunchSetup(input)).toBe(file);
      expect(readFileSync(file, "utf8")).toBe(bytes);
      expect(journal.readReviews()).toEqual([request]);
    } else {
      await expect(persistClaimedLaunchSetup(input)).rejects.toThrow(
        mode === "changed-admission" ? "anchor changed" : undefined,
      );
      if (mode === "changed-snapshot")
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ retained: "do not overwrite" });
      else expect(() => readFileSync(file)).toThrow();
    }
    expect(readFileSync(f.setupFile, "utf8")).toBe(before);
    expect(new FileBootstrapRequestJournal(f.state).read()).toEqual([f.record, original]);
  },
);

test.runIf(process.platform === "darwin")(
  "renewed successor requires the exact recovered claim reference",
  async () => {
    const f = await fixture();
    const setup = (await f.derive())!;
    const reference = {
      id: randomUUID(),
      revision: randomUUID(),
      generation: randomUUID(),
      planSha256: "a".repeat(64),
    };
    setup.renewal!.claimedRecovery = {
      original: reference,
      recovery: { ...reference, id: randomUUID() },
      fence: f.configuration,
      birth: f.configuration,
      setup: f.configuration,
    };
    const plan = {
      ...f.plan,
      previous: f.coordinator,
      candidate: f.host,
      automaticRecovery: "restore-compatible" as const,
      compatibleRecovery: f.host,
      recoveredFrom: reference,
    };
    await expect(verifyRenewalPlan(setup, plan)).resolves.toBeUndefined();
    await expect(verifyRenewalPlan(setup, { ...plan, recoveredFrom: undefined })).rejects.toThrow(
      "exact recovered claim",
    );
    for (const field of ["id", "revision", "generation", "planSha256"] as const) {
      await expect(
        verifyRenewalPlan(setup, {
          ...plan,
          recoveredFrom: {
            ...reference,
            [field]: field === "planSha256" ? "b".repeat(64) : randomUUID(),
          },
        }),
      ).rejects.toThrow("exact recovered claim");
    }
  },
);

test
  .runIf(process.platform === "darwin")
  .each(["coordinator-bootstrap-claimed-launch.js", "coordinator-bootstrap-claimed-host.js"])(
  "admits the selected recovery caller %s without admitting arbitrary modules",
  async (caller) => {
    const f = await fixture();
    const moduleFile = path.join(
      f.host.directory,
      "packages/server/dist/server/server/execution-installation",
      caller,
    );
    f.save(moduleFile, "disposable recovery caller", true);
    const before = readFileSync(f.setupFile);
    const renewed = await f.derive({ moduleFile });
    expect(renewed?.runtimeDirectory).toBe(f.host.directory);
    expect(renewed?.renewal?.hostProcess).toEqual(f.hostProcess);
    expect(readFileSync(f.setupFile)).toEqual(before);
    const unrelated = f.save(
      path.join(f.host.directory, "unrelated.js"),
      "not a recovery caller",
      true,
    );
    await expect(f.derive({ moduleFile: unrelated.path })).rejects.toThrow("stale");
    await expect(f.derive({ moduleFile: f.original.entrypoint.path })).rejects.toThrow("stale");
  },
);

test.runIf(process.platform === "darwin").each(["claimed", "recovery_required"] as const)(
  "historical repair authority survives later %s without admitting it as current authority",
  async (stage) => {
    const f = await fixture();
    const setup = (await f.derive())!;
    const later = structuredClone(f.record);
    later.id = randomUUID();
    later.revision = randomUUID();
    later.plan.previous = f.coordinator;
    later.planSha256 = coordinatorPlanDigest(later.plan);
    later.execution = {
      generation: randomUUID(),
      stage,
      updatedAt: new Date().toISOString(),
    };
    f.writeRecords([f.record, later]);
    const before = readFileSync(path.join(f.state, "coordinator-bootstrap.json"));
    await expect(verifyHistoricalRenewal(setup)).resolves.toBeUndefined();
    await expect(verifyRetainedRenewal(setup, undefined, true)).rejects.toThrow();
    expect(readFileSync(path.join(f.state, "coordinator-bootstrap.json"))).toEqual(before);
    for (const field of ["revision", "planSha256"] as const) {
      const changed = structuredClone(f.record);
      changed[field] = field === "revision" ? randomUUID() : "a".repeat(64);
      f.writeRecords([changed, later]);
      await expect(verifyHistoricalRenewal(setup)).rejects.toThrow(
        "Historical renewal boundary changed",
      );
    }
    f.writeRecords([f.record, f.record, later]);
    await expect(verifyHistoricalRenewal(setup)).rejects.toThrow(
      "Duplicate bootstrap storage identity",
    );
    f.writeRecords([later]);
    await expect(verifyHistoricalRenewal(setup)).rejects.toThrow(
      "Historical renewal boundary changed",
    );
  },
);

test.runIf(process.platform === "darwin")(
  "preclaim initialization retains an exact unpromoted failed predecessor",
  async () => {
    const f = await fixture();
    const failed = structuredClone(f.record);
    failed.id = randomUUID();
    failed.revision = randomUUID();
    failed.plan.previous = f.coordinator;
    failed.plan.candidate = f.host;
    failed.plan.compatibleRecovery = f.host;
    failed.plan.automaticRecovery = "restore-compatible";
    const observed = await f.ports.reader.inspectProcess(404);
    failed.plan.expectedProcess = {
      pid: observed.pid,
      bootId: observed.bootId,
      startIdentity: observed.startIdentity,
      argumentsSha256: observed.argumentsSha256,
    };
    failed.planSha256 = coordinatorPlanDigest(failed.plan);
    failed.execution = {
      generation: randomUUID(),
      stage: "recovery_required",
      updatedAt: new Date().toISOString(),
    };
    const journal = new FileBootstrapRequestJournal(f.state);
    journal.replace(journal.read(), [f.record, failed]);
    const renewed = (await f.derive())!;
    const original = structuredClone(failed);
    original.id = randomUUID();
    original.revision = randomUUID();
    delete original.execution;
    original.plan.recoveredFrom = renewed.renewal!.unpromotedFailure;
    original.planSha256 = coordinatorPlanDigest(original.plan);
    journal.replace(journal.read(), [f.record, failed, original]);
    const before = journal.read();
    const service = await createManagedPreclaimRecoveryReview(f.setupFile, f.original.daemonId, {
      ...f.ports,
      moduleFile: path.join(f.host.directory, runnerRelative),
      hostProcessId: f.hostProcess.pid,
    });
    expect(service?.available).toBe(true);
    expect(service?.list()).toEqual([]);
    expect(journal.read()).toEqual(before);
    expect(journal.readPromoted()).toEqual([f.record]);
  },
);

test.runIf(process.platform === "darwin")(
  "renews an exact unpromoted failed generation without rewriting its approval or promoting it",
  async () => {
    const f = await fixture();
    const failed = structuredClone(f.record);
    failed.id = randomUUID();
    failed.revision = randomUUID();
    failed.plan.previous = f.coordinator;
    failed.plan.candidate = f.host;
    failed.plan.compatibleRecovery = f.host;
    failed.plan.automaticRecovery = "restore-compatible";
    const observed = await f.ports.reader.inspectProcess(404);
    failed.plan.expectedProcess = {
      pid: observed.pid,
      bootId: observed.bootId,
      startIdentity: observed.startIdentity,
      argumentsSha256: observed.argumentsSha256,
    };
    failed.planSha256 = coordinatorPlanDigest(failed.plan);
    failed.execution = {
      generation: randomUUID(),
      stage: "recovery_required",
      updatedAt: new Date().toISOString(),
    };
    const journal = new FileBootstrapRequestJournal(f.state);
    journal.replace(journal.read(), [f.record, failed]);
    const before = journal.read();
    const renewed = (await f.derive())!;
    expect(renewed.renewal!.unpromotedFailure).toEqual({
      id: failed.id,
      revision: failed.revision,
      generation: failed.execution.generation,
      planSha256: failed.planSha256,
    });
    const successor = { ...failed.plan, recoveredFrom: renewed.renewal!.unpromotedFailure };
    await expect(verifyRenewalPlan(renewed, successor)).resolves.toBeUndefined();
    await expect(
      verifyRenewalPlan(renewed, { ...successor, recoveredFrom: undefined }),
    ).rejects.toThrow("exact unpromoted failure");
    expect(journal.read()).toEqual(before);
    expect(journal.readPromoted()).toEqual([f.record]);
    const finished = {
      ...failed,
      id: randomUUID(),
      revision: randomUUID(),
      plan: successor,
      planSha256: coordinatorPlanDigest(successor),
      execution: {
        generation: randomUUID(),
        stage: "succeeded" as const,
        updatedAt: new Date().toISOString(),
      },
    };
    // Main journal precedes the sidecar, so a promoted successor is read before
    // its still-unpromoted failed predecessor. Exact references define ancestry.
    expect(terminalBootstrapRelease([f.record, finished, failed], f.identity)).toEqual({
      request: finished,
      release: f.host,
    });
    expect(() => journal.promote(failed)).toThrow("Exact protected bootstrap claim required");
    expect(() => journal.verifyUnpromotedFailure({ ...failed, revision: randomUUID() })).toThrow(
      "Exact unpromoted bootstrap failure required",
    );
    const inspect = f.ports.reader.inspectProcess;
    f.ports.reader.inspectProcess = async (pid) => {
      const process = await inspect(pid);
      return pid === failed.plan.expectedProcess.pid
        ? { ...process, startIdentity: "changed-birth" }
        : process;
    };
    await expect(f.derive()).rejects.toThrow();
    f.ports.reader.inspectProcess = inspect;
    expect(() =>
      journal.verifyUnpromotedFailure({
        ...failed,
        execution: { ...failed.execution!, rollbackAttemptedAt: new Date().toISOString() },
      }),
    ).toThrow("Exact unpromoted bootstrap failure required");
    const changed = { ...failed, revision: randomUUID() };
    journal.replace(journal.read(), [f.record, changed]);
    await expect(verifyRetainedRenewal(renewed, undefined, true)).rejects.toThrow(
      "Retained renewal terminal history changed",
    );
    journal.replace(journal.read(), before);
    const promoted = {
      ...failed,
      revision: randomUUID(),
      execution: { ...failed.execution, stage: "claimed" as const },
    };
    journal.replace(journal.read(), [f.record, promoted]);
    journal.promote(promoted);
    const failedAfterPromotion = {
      ...promoted,
      revision: randomUUID(),
      execution: { ...promoted.execution, stage: "recovery_required" as const },
    };
    journal.replace(journal.read(), [f.record, failedAfterPromotion]);
    await expect(f.derive()).rejects.toThrow("Exact unpromoted bootstrap failure required");
  },
);

test.runIf(process.platform === "darwin")(
  "startup renewal resolves the exact retained approval from a preapproval setup",
  async () => {
    const f = await fixture();
    const setup = (await f.derive())!;
    const prepared = f.save(path.join(f.state, "prepared-boot-setup.json"), setup);
    const approved = structuredClone(f.record);
    approved.id = randomUUID();
    approved.revision = randomUUID();
    delete approved.execution;
    const service = `${f.plan.service}-recovery-${approved.id}`;
    approved.plan = {
      ...f.plan,
      previous: f.coordinator,
      candidate: f.host,
      automaticRecovery: "restore-compatible",
      compatibleRecovery: f.host,
      bootRecovery: {
        requestId: approved.id,
        service,
        launcher: f.save(path.join(f.state, "boot.plist"), "inert fixture", true),
        installedLauncher: path.join(f.state, "installed-boot.plist"),
        setup: prepared,
        ownerLauncher: setup.ownerLauncher,
        node: setup.node,
        entrypoint: setup.entrypoint,
      },
    };
    approved.planSha256 = coordinatorPlanDigest(approved.plan);
    const file = persistRenewalSetup(f.state, setup, approved);
    const snapshot = BootstrapRunnerSetupSchema.parse(JSON.parse(readFileSync(file, "utf8")));
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
    await expect(verifyBootRunnerBinding(claimed, file, snapshot)).resolves.toBeUndefined();
    await expect(resolveBootstrapBootSetup(prepared.path, claimed.id)).resolves.toBe(file);
    expect(sha(readFileSync(prepared.path))).toBe(prepared.sha256);
    await expect(verifyBootRunnerBinding(claimed, prepared.path, snapshot)).rejects.toThrow(
      "differs from approved preparation",
    );
    const otherApproval = {
      ...snapshot,
      renewal: {
        ...snapshot.renewal!,
        request: {
          ...snapshot.renewal!.request!,
          planSha256: "c".repeat(64),
        },
      },
    };
    await expect(verifyBootRunnerBinding(claimed, file, otherApproval)).rejects.toThrow(
      "differs from approved preparation",
    );

    await expect(
      verifyBootRunnerBinding(claimed, file, { ...snapshot, daemonId: "different-host" }),
    ).rejects.toThrow("differs from approved preparation");
    const bytes = readFileSync(file);
    writeFileSync(file, JSON.stringify({ ...snapshot, runtimeSha256: "f".repeat(64) }));
    await expect(resolveBootstrapBootSetup(prepared.path, claimed.id)).rejects.toThrow(
      "digest changed",
    );
    writeFileSync(file, bytes);
    const generationFile = path.join(
      f.state,
      `coordinator-renewal-generation-${claimed.execution.generation}.json`,
    );
    const generation = JSON.parse(readFileSync(generationFile, "utf8"));
    writeFileSync(generationFile, JSON.stringify({ ...generation, generation: randomUUID() }));
    await expect(resolveBootstrapBootSetup(prepared.path, claimed.id)).rejects.toThrow(
      "generation changed",
    );
    writeFileSync(generationFile, JSON.stringify(generation));
    writeFileSync(prepared.path, JSON.stringify({ ...setup, daemonId: "substituted-host" }));
    await expect(verifyBootRunnerBinding(claimed, file, snapshot)).rejects.toThrow(
      "digest changed",
    );
  },
);

test("effective successor budget reserves every original native read before starting it", async () => {
  const f = await sharedCoordinatorFixture();
  let now = 0,
    services = 0,
    processes = 0;
  const readService = f.ports.reader.readService;
  f.ports.reader.readService = async (service) => {
    services++;
    now = 51_000;
    return readService(service);
  };
  const inspectProcess = f.ports.reader.inspectProcess;
  f.ports.reader.inspectProcess = async (pid) => {
    processes++;
    return inspectProcess(pid);
  };
  await expect(
    inspectSelectedCoordinatorRuntime({
      identity: f.identity,
      executables: [f.node.path],
      writableMountRoots: [],
      ports: f.ports,
      collection: { deadline: 60_000, now: () => now },
    }),
  ).rejects.toThrow("deadline exceeded");
  expect(services).toBe(1);
  expect(processes).toBe(0);
});

test("effective successor budget refuses late native results and preserves the raw Host reader", async () => {
  const f = await sharedCoordinatorFixture();
  let resolveRead: ((value: string) => void) | undefined;
  let raw: Promise<unknown> | undefined;
  let started: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.ports.reader.readService = () =>
    new Promise<string>((resolve) => {
      resolveRead = resolve;
      started!();
    });
  const controller = new AbortController();
  raw = readInitialHostObservation(() =>
    inspectSelectedCoordinatorRuntime({
      identity: f.identity,
      executables: [f.node.path],
      writableMountRoots: [],
      ports: f.ports,
      collection: { signal: controller.signal },
    }),
  );
  await Promise.race([
    entered,
    raw.then(() => {
      throw Error("Synthetic read returned before entry");
    }),
  ]);
  const outward = readBoundedMaintenanceInspection(
    (signal) => {
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
      return raw!;
    },
    { timeoutMs: 10, detail: "synthetic Host anchor timeout" },
  );
  await expect(outward).rejects.toThrow("synthetic Host anchor timeout");
  expect(initialHostObservationPending()).toBe(true);
  let secondRead = false;
  await expect(
    readInitialHostObservation(async () => {
      secondRead = true;
    }),
  ).rejects.toThrow("still in progress");
  expect(secondRead).toBe(false);
  if (!resolveRead || !raw) throw Error("Synthetic native read did not start");
  resolveRead(`${f.identity.service} = {\n\tpid = 404\n}\n`);
  await expect(raw).rejects.toThrow("synthetic Host anchor timeout");
  expect(initialHostObservationPending()).toBe(false);
});

test("effective successor budget refuses caller cancellation after a raw native read", async () => {
  const f = await sharedCoordinatorFixture();
  const controller = new AbortController();
  let calls = 0;
  const original = f.ports.reader.readService;
  f.ports.reader.readService = async (service) => {
    calls++;
    controller.abort(new Error("owner cancelled observation"));
    return original(service);
  };
  await expect(
    inspectSelectedCoordinatorRuntime({
      identity: f.identity,
      executables: [f.node.path],
      writableMountRoots: [],
      ports: f.ports,
      collection: { signal: controller.signal },
    }),
  ).rejects.toThrow("owner cancelled observation");
  expect(calls).toBe(1);
});

test("effective successor budget passes cancellation and remaining time into full artifact verification", async () => {
  const f = await sharedCoordinatorFixture();
  const artifacts = await import("./coordinator-bootstrap-artifact.js");
  const original = artifacts.inspectBootstrapReleaseArtifacts;
  const controller = new AbortController();
  let fullArtifact = 0;
  vi.spyOn(artifacts, "inspectBootstrapReleaseArtifacts").mockImplementation(
    async (release, mountRoots, limits) => {
      fullArtifact++;
      expect(limits?.signal).toBeDefined();
      expect(limits?.timeoutMs).toBeGreaterThan(0);
      expect(limits?.timeoutMs).toBeLessThanOrEqual(12_345);
      controller.abort(new Error("cancel full artifact"));
      return original(release, mountRoots, limits);
    },
  );
  await expect(
    inspectSelectedCoordinatorRuntime({
      identity: f.identity,
      executables: [f.node.path],
      writableMountRoots: [],
      ports: f.ports,
      collection: { signal: controller.signal, timeoutMs: 12_345 },
    }),
  ).rejects.toThrow("cancel full artifact");
  expect(fullArtifact).toBe(1);
});

test("effective successor budget clears its deadline after success while retaining caller cancellation", async () => {
  const f = await successorConfigurationFixture();
  const controller = new AbortController();
  let now = 0,
    collecting = true;
  const proof = await inspectEffectiveMaintenanceConfiguration({
    ...f.input,
    collection: {
      signal: controller.signal,
      now() {
        if (!collecting) throw Error("collection clock reused");
        return now;
      },
    },
  });
  now = 600_000;
  collecting = false;
  proof.assertRetained();
  proof.assertCurrent();
  controller.abort(new Error("later caller cancellation"));
  expect(proof.assertRetained).toThrow("later caller cancellation");
  expect(proof.assertCurrent).toThrow("later caller cancellation");
});

test("effective successor budget charges final synchronous native assertions", async () => {
  const f = await sharedCoordinatorFixture();
  let now = 0;
  const native = f.ports.assertCurrent;
  f.ports.assertCurrent = (service, process) => {
    native(service, process);
    now = 60_000;
  };
  await expect(
    inspectSelectedCoordinatorRuntime({
      identity: f.identity,
      executables: [f.node.path],
      writableMountRoots: [],
      ports: f.ports,
      collection: { deadline: 60_000, now: () => now },
    }),
  ).rejects.toThrow("deadline exceeded");
});

test("effective successor budget retains reader callbacks and rejects post-success collection replay", async () => {
  const f = await sharedCoordinatorFixture();
  const proof = await f.inspect();
  f.ports.reader.readService = async () => "substituted reader";
  expect(proof.assertRetained).toThrow("reader changed");
  const collection = createCoordinatorObservationCollection();
  collection.finish(true);
  let called = false;
  await expect(
    collection.read(async () => {
      called = true;
    }),
  ).rejects.toThrow("finished");
  expect(called).toBe(false);
});

test("effective successor budget reserves both bounded synchronous native checks", async () => {
  const f = await sharedCoordinatorFixture();
  let now = 0,
    nativeCalls = 0;
  const exit = f.ports.reader.verifyProcessExited;
  f.ports.reader.verifyProcessExited = async (pid) => {
    await exit(pid);
    now = 56_001;
  };
  f.ports.assertCurrent = () => {
    nativeCalls++;
  };
  await expect(
    inspectSelectedCoordinatorRuntime({
      identity: f.identity,
      executables: [f.node.path],
      writableMountRoots: [],
      ports: f.ports,
      collection: { deadline: 60_000, now: () => now },
    }),
  ).rejects.toThrow("deadline exceeded");
  expect(nativeCalls).toBe(0);
});

test("effective successor budget rejects an already expired collection before reading", async () => {
  const f = await successorConfigurationFixture();
  let called = false;
  f.ports.reader.readService = async () => {
    called = true;
    return "unexpected";
  };
  await expect(
    inspectEffectiveMaintenanceConfiguration({
      ...f.input,
      collection: { deadline: 1, now: () => 2 },
    }),
  ).rejects.toThrow("deadline exceeded");
  expect(called).toBe(false);
});

test("effective successor budget cannot be extended by its original clock callback", () => {
  const limits = {
    deadline: 10_000,
    now(): number {
      limits.deadline = 60_000;
      return 0;
    },
  };
  const collection = createCoordinatorObservationCollection(limits);
  try {
    expect(() => collection.remaining(10_001)).toThrow("deadline exceeded");
  } finally {
    collection.finish(false);
  }
});

test("effective successor budget refuses a ten-second read near the original Host thirty-second deadline", async () => {
  const f = await sharedCoordinatorFixture();
  let now = 0,
    reads = 0,
    processReads = 0;
  const clock = () => now;
  const deadline = clock() + 30_000;
  const original = f.ports.reader.readService;
  f.ports.reader.readService = async (service) => {
    reads++;
    now = 21_000;
    return original(service);
  };
  f.ports.reader.inspectProcess = async () => {
    processReads++;
    throw Error("must not start near Host deadline");
  };
  await expect(
    inspectSelectedCoordinatorRuntime({
      identity: f.identity,
      executables: [f.node.path],
      writableMountRoots: [],
      ports: f.ports,
      collection: { deadline, now: clock },
    }),
  ).rejects.toThrow("deadline exceeded");
  expect(reads).toBe(1);
  expect(processReads).toBe(0);
});

test("effective successor budget uses monotonic remaining time after wall-clock rollback", async () => {
  let wall = 0;
  const collection = createCoordinatorObservationCollection({ now: () => wall, timeoutMs: 1000 });
  wall = -60_000;
  let started = false;
  try {
    expect(collection.remaining()).toBeLessThanOrEqual(1000);
    await expect(
      collection.read(async () => {
        started = true;
      }, 10_000),
    ).rejects.toThrow("deadline exceeded");
    expect(started).toBe(false);
  } finally {
    collection.finish(false);
  }
});

test("effective successor nested budget refuses native reads after parent wall rollback", async () => {
  const f = await sharedCoordinatorFixture();
  let wall = 0;
  const parent = createCoordinatorObservationCollection({ now: () => wall, timeoutMs: 1000 });
  wall = -60_000;
  let reads = 0;
  f.ports.reader.readService = async () => {
    reads++;
    throw Error("native read must not start");
  };
  try {
    await expect(
      inspectSelectedCoordinatorRuntime({
        identity: f.identity,
        executables: [f.node.path],
        writableMountRoots: [],
        ports: f.ports,
        collection: parent.limits,
      }),
    ).rejects.toThrow("deadline exceeded");
    expect(reads).toBe(0);
    expect(Object.isFrozen(parent.limits)).toBe(true);
  } finally {
    parent.finish(false);
  }
});

test("effective successor nested budget captures the inherited cutoff before clock callbacks", () => {
  const parent = createCoordinatorObservationCollection({ now: () => 0, timeoutMs: 1000 });
  const originalCutoff = parent.limits.monotonicDeadline;
  const limits = {
    ...parent.limits,
    now() {
      limits.monotonicDeadline += 60_000;
      return -60_000;
    },
  };
  const child = createCoordinatorObservationCollection(limits);
  let reads = 0;
  try {
    expect(child.limits.monotonicDeadline).toBe(originalCutoff);
    expect(() => child.sync(() => reads++, 10_000)).toThrow("deadline exceeded");
    expect(reads).toBe(0);
  } finally {
    child.finish(false);
    parent.finish(false);
  }
});

test("effective successor nested budget charges collection clock callback time", () => {
  const collection = createCoordinatorObservationCollection({
    timeoutMs: 20,
    now() {
      const until = performance.now() + 40;
      while (performance.now() < until) {
        // Inert synchronous callback work must consume the original budget.
      }
      return 0;
    },
  });
  let reads = 0;
  try {
    expect(() => collection.sync(() => reads++, 1)).toThrow("deadline exceeded");
    expect(reads).toBe(0);
  } finally {
    collection.finish(false);
  }
});

test.each([NaN, Infinity, -Infinity])(
  "effective successor nested budget rejects nonfinite inherited cutoff %s",
  (monotonicDeadline) => {
    expect(() => createCoordinatorObservationCollection({ monotonicDeadline })).toThrow(
      "deadline is invalid",
    );
  },
);
