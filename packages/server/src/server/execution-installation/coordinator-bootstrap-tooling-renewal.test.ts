import { afterEach, expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { hashSync } from "bcryptjs";
import {
  CoordinatorBootstrapPlanSchema,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import {
  BootstrapAdmissionSetupSchema,
  createBootstrapReviewService,
} from "./coordinator-bootstrap-host.js";
import * as serviceCollector from "./coordinator-bootstrap-service.js";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  deriveBootstrapRenewal,
  verifyRenewalPlan,
  persistRenewalSetup,
  retainRenewalGeneration,
  verifyRetainedRenewal,
  type BootstrapRenewalPorts,
} from "./coordinator-bootstrap-renewal.js";
import {
  executeCoordinatorBootstrap,
  type BootstrapExecutorOperations,
} from "./coordinator-bootstrap-executor.js";
import { recoverAbandonedBootstrap } from "./coordinator-bootstrap-watchdog.js";
import {
  selectBootstrapLauncher,
  restoreBootstrapLauncher,
} from "./coordinator-bootstrap-selection.js";
import { preserveBootstrapState, verifyBootstrapState } from "./coordinator-bootstrap-state.js";

// Process and service ports are fake. Admission, renewal reconstruction, journals,
// transfer receipts, executor transitions, launcher selection and recovery are real.
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
    for (const toolingName of [
      "prepare-installation-update.mjs",
      "publish-instance-web.mjs",
      "instance-web-artifact.mjs",
    ])
      save(
        path.join(directory, "scripts", toolingName),
        "throw new Error('never execute tooling fixture');",
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

async function combinedFixture() {
  const f = await fixture();
  const setup = (await f.derive())!;
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(readFileSync(setup.admissionSetupFile, "utf8")),
  );
  const host = { ...admission, configurationFile: f.configuration.path };
  const observed = await f.ports.reader.inspectProcess(404);
  vi.spyOn(serviceCollector, "createNativeBootstrapServiceReader").mockResolvedValue(
    f.ports.reader,
  );
  const adoption = { ...f.config.container.factoryRuntimeAdoption, sha256: "d".repeat(64) };
  const candidateConfiguration = {
    ...f.config,
    container: { ...f.config.container, factoryRuntimeAdoption: adoption },
    sourceUpdates: {
      ...f.config.sourceUpdates,
      toolingDirectory: path.join(f.host.directory, "scripts"),
    },
  };
  const configuration = f.save(path.join(f.root, "reviewed-config.json"), candidateConfiguration);
  const launcher = f.save(path.join(f.root, "reviewed-launcher.plist"), {
    ...JSON.parse(readFileSync(f.host.launcher.path, "utf8")),
    ProgramArguments: [f.node.path, f.host.entrypoint.path, configuration.path],
  });
  const plan = CoordinatorBootstrapPlanSchema.parse({
    ...f.plan,
    previous: f.coordinator,
    candidate: { ...f.host, configuration, launcher },
    expectedProcess: {
      pid: observed.pid,
      bootId: observed.bootId,
      startIdentity: observed.startIdentity,
      argumentsSha256: observed.argumentsSha256,
    },
    automaticRecovery: "restore-compatible",
    compatibleRecovery: f.host,
    sourceUpdateTooling: true,
    factoryRuntimeAdoptionConfiguration: adoption,
  });
  const requests = await createBootstrapReviewService(setup.admissionSetupFile, "host-id", {
    setup: host,
    verify: async (candidate) => {
      await f.derive();
      await verifyRenewalPlan(setup, candidate);
    },
  });
  return { ...f, setup, admissionHost: host, candidateConfiguration, plan, requests };
}
const identity = (request: CoordinatorBootstrapRequest) => ({
  id: request.id,
  revision: request.revision,
  planSha256: request.planSha256,
});

test.runIf(process.platform === "darwin")(
  "combined renewal admission requires explicit exact tooling and Factory projections",
  async () => {
    const f = await combinedFixture();
    const prepare = (plan = f.plan) =>
      f.requests.prepare({ id: randomUUID(), reason: "disposable tooling renewal", plan });
    await expect(prepare({ ...f.plan, sourceUpdateTooling: undefined })).rejects.toThrow(
      "outside its approved policy",
    );
    await expect(
      prepare({ ...f.plan, factoryRuntimeAdoptionConfiguration: undefined }),
    ).rejects.toThrow("outside its approved policy");
    for (const field of Object.keys(f.config.sourceUpdates)) {
      f.save(f.plan.candidate.configuration.path, {
        ...f.candidateConfiguration,
        sourceUpdates: {
          ...f.candidateConfiguration.sourceUpdates,
          [field]: field === "integrationRef" ? "refs/heads/escape" : path.join(f.root, "escape"),
        },
      });
      await expect(prepare(), field).rejects.toThrow("outside its approved policy");
    }
    f.save(f.plan.candidate.configuration.path, f.candidateConfiguration);
    const pending = await prepare();
    expect(pending.status).toBe("pending");
    expect(pending.decisionAt).toBeUndefined();
    const decide = { ...identity(pending), decision: "approve" as const };
    await expect(
      f.requests.decide({ ...decide, revision: randomUUID() }, "fixture"),
    ).rejects.toThrow();
    await expect(
      f.requests.decide({ ...decide, planSha256: "e".repeat(64) }, "fixture"),
    ).rejects.toThrow();
    const script = path.join(f.host.directory, "scripts/publish-instance-web.mjs");
    const bytes = readFileSync(script);
    writeFileSync(script, "changed artifact");
    await expect(f.requests.decide(decide, "fixture")).rejects.toThrow();
    expect(f.requests.list().find((item) => item.id === pending.id)?.status).toBe("pending");
    writeFileSync(script, bytes);
    const approved = await f.requests.decide(decide, "fixture");
    expect(approved.status).toBe("approved");
    expect(approved.revision).not.toBe(pending.revision);
    await expect(f.requests.claimDispatch(identity(pending))).rejects.toThrow();
    writeFileSync(script, "changed after approval");
    await expect(f.requests.claimDispatch(identity(approved))).rejects.toThrow();
    expect(f.requests.list().find((item) => item.id === pending.id)?.execution).toBeUndefined();
    writeFileSync(script, bytes);
    await expect(
      verifyRenewalPlan(f.setup, { ...f.plan, compatibleRecovery: f.plan.candidate }),
    ).rejects.toThrow("Recovery must preserve");
  },
);

test.runIf(process.platform === "darwin")(
  "combined renewal omission keeps old tooling while admitting only explicit Factory change",
  async () => {
    const f = await combinedFixture();
    const candidateConfiguration = {
      ...f.candidateConfiguration,
      sourceUpdates: f.config.sourceUpdates,
    };
    const configuration = f.save(f.plan.candidate.configuration.path, candidateConfiguration);
    const plan = {
      ...f.plan,
      sourceUpdateTooling: undefined,
      candidate: { ...f.plan.candidate, configuration },
    };
    const pending = await f.requests.prepare({
      id: randomUUID(),
      reason: "disposable Factory-only renewal",
      plan,
    });
    expect(pending.plan.sourceUpdateTooling).toBeUndefined();
    expect(JSON.parse(readFileSync(configuration.path, "utf8")).sourceUpdates).toEqual(
      f.config.sourceUpdates,
    );
    expect(pending.status).toBe("pending");
  },
);

test.runIf(process.platform === "darwin").each([false, true])(
  "combined executor and compatible recovery retain old tooling after failure=%s",
  async (fail) => {
    const f = await combinedFixture();
    const beforeConfiguration = readFileSync(f.configuration.path);
    f.save(f.plan.state.restartJournal, []);
    f.save(f.plan.state.ownerSessions, []);
    const stateBytes = [
      readFileSync(f.plan.state.restartJournal),
      readFileSync(f.plan.state.ownerSessions),
    ];
    const pending = await f.requests.prepare({
      id: randomUUID(),
      reason: "disposable exact renewal execution",
      plan: f.plan,
    });
    const approved = await f.requests.decide(
      { ...identity(pending), decision: "approve" },
      "fixture",
    );
    const retainedFile = persistRenewalSetup(f.state, f.setup, approved);
    const retained = BootstrapRunnerSetupSchema.parse(
      JSON.parse(readFileSync(retainedFile, "utf8")),
    );
    await verifyRetainedRenewal(retained, approved);
    const assertSelection = (request: CoordinatorBootstrapRequest, stage: string) => {
      expect(f.requests.list().find((item) => item.id === request.id)).toMatchObject({
        revision: request.revision,
        planSha256: request.planSha256,
        execution: { generation: request.execution!.generation, stage },
      });
    };
    const selection = (request: CoordinatorBootstrapRequest, stage: string) => ({
      plan: request.plan,
      launcherFile: path.join(f.root, "selected.plist"),
      configurationFile: f.configuration.path,
      writableMountRoots: [],
      authorizeSelection: async () => assertSelection(request, stage),
    });
    const operations: BootstrapExecutorOperations = {
      withOwnership: async (_request, operation) => operation(),
      armWatchdog: async (request) => {
        await retainRenewalGeneration({
          setup: retained,
          setupFile: retainedFile,
          request,
          watchdog: false,
        });
        await verifyRetainedRenewal(retained, request);
      },
      freeze: async () => {},
      inspectFrozen: async () => ({ restartJournal: [], childPids: [] }),
      preserveTransfer: async (request) =>
        preserveBootstrapState({ request, writableMountRoots: [], childPids: [] }),
      unload: async () => {},
      select: async (request) => selectBootstrapLauncher(selection(request, "selection_pending")),
      start: async () => {},
      verifyReplacement: async (request) => {
        await verifyBootstrapState({ request, writableMountRoots: [] });
        const selected = JSON.parse(readFileSync(path.join(f.root, "selected.plist"), "utf8"));
        expect(selected.ProgramArguments[2]).toBe(request.plan.candidate.configuration.path);
        expect(JSON.parse(readFileSync(selected.ProgramArguments[2], "utf8"))).toEqual(
          f.candidateConfiguration,
        );
        if (fail) throw new Error("disposable replacement failure");
      },
      releaseReplacement: async () => {},
      resumePrevious: async () => {
        throw new Error("unexpected legacy resume");
      },
    };
    const result = await executeCoordinatorBootstrap(f.requests, identity(approved), operations);
    expect(result.execution!.stage).toBe(fail ? "recovery_required" : "succeeded");
    await expect(
      executeCoordinatorBootstrap(f.requests, identity(approved), operations),
    ).rejects.toThrow();
    if (fail) {
      const recovered = await recoverAbandonedBootstrap(
        f.requests,
        { id: result.id, generation: result.execution!.generation },
        {
          withOwnership: async (operation) => operation(),
          verifyExecutorExited: async () => {},
          resumePrevious: async () => {
            throw new Error("unexpected resume");
          },
          restorePrevious: async (request) => {
            await verifyRetainedRenewal(retained, request, true);
            await verifyBootstrapState({ request, writableMountRoots: [] });
            await restoreBootstrapLauncher(selection(request, "rollback_pending"));
          },
        },
      );
      expect(recovered.execution!.stage).toBe("rolled_back");
      const selected = JSON.parse(readFileSync(path.join(f.root, "selected.plist"), "utf8"));
      expect(selected.ProgramArguments[2]).toBe(f.configuration.path);
      expect(JSON.parse(readFileSync(selected.ProgramArguments[2], "utf8"))).toEqual(f.config);
      expect(
        JSON.parse(readFileSync(selected.ProgramArguments[2], "utf8")).sourceUpdates
          .toolingDirectory,
      ).toBe(f.config.sourceUpdates.toolingDirectory);
      expect(
        new FileBootstrapRequestJournal(f.state).read().find((item) => item.id === result.id)
          ?.execution!.stage,
      ).toBe("rolled_back");
    }
    expect(readFileSync(f.configuration.path)).toEqual(beforeConfiguration);
    expect(readFileSync(f.plan.state.restartJournal)).toEqual(stateBytes[0]);
    expect(readFileSync(f.plan.state.ownerSessions)).toEqual(stateBytes[1]);
  },
);
