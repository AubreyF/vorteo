import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { expect, test, vi, afterEach } from "vitest";
vi.mock(
  "@getpaseo/protocol/execution-installation",
  () => import("../../../../../protocol/src/execution-installation.js"),
);
vi.mock(
  "@getpaseo/protocol/installation-enrollment",
  () => import("../../../../../protocol/src/installation-enrollment.js"),
);
import { SupervisorEffectSchema } from "@getpaseo/protocol/execution-installation";
import { InstallationStandingGrantSchema } from "@getpaseo/protocol/installation-enrollment";
import {
  DevRegistrationProvisionerInputSchema,
  prepareDevRegistrationProvisioner,
  devRegistrationLinuxArtifactDigest,
} from "./dev-registration-provisioner.js";
import type { DevRegistrationNativeObservationInput } from "./dev-registration-native-observation.js";
import { DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT } from "./dev-registration-native-observation.js";
import {
  observeDevRegistrationNativeFromHost,
  type DevRegistrationObservationHostPorts,
} from "./dev-registration-native-observation-host.js";
import type { MaintenanceObservationRuntime } from "../coordinator-bootstrap-maintenance-observation-runtime.js";
import type { NativeBootstrapServiceReader } from "../coordinator-bootstrap-service.js";
import { enrollmentManifestDigest } from "./authorization.js";

// The observer only runs on the native macOS Host and refuses every other platform.
const nativeHostTest = test.runIf(process.platform === "darwin");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const FACTORY_ENTRY =
  "const candidate = '/fixture/factory-candidate';\nvoid [candidate + '/modules/factory/launch.py', '/fixture/linux-node/bin/node', '/fixture/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js', candidate + '/runtime.mjs'];\n";
const FACTORY_LAUNCHER =
  "def launch(options):\n    for path in [options.supervisor_entry]:\n        if path == options.node:\n            pass\n        else:\n            physical(path)\n";
function staticInput() {
  const file = (path: string, content: string) => ({
    path,
    content,
    sha256: hash(content),
    size: Buffer.byteLength(content),
  });
  const linuxArtifact = {
    algorithm: "vorteo-container-artifact-v1",
    platform: "linux",
    arch: "arm64",
    root: "/opt/vorteo-managed-releases/prepared-linux",
    sourceCommit: "2".repeat(40),
    artifactSha256: "3".repeat(64),
    entries: [
      { kind: "directory", path: "", mode: 0o40755 },
      { kind: "directory", path: "packages", mode: 0o40755 },
      { kind: "directory", path: "packages/server", mode: 0o40755 },
      { kind: "directory", path: "packages/server/dist", mode: 0o40755 },
      { kind: "directory", path: "packages/server/dist/scripts", mode: 0o40755 },
      {
        kind: "file",
        path: "packages/server/dist/scripts/supervisor-entrypoint.js",
        mode: 0o100644,
        sha256: hash("fixture supervisor"),
        size: 18,
      },
      { kind: "directory", path: "packages/server/dist/server", mode: 0o40755 },
      { kind: "directory", path: "packages/server/dist/server/server", mode: 0o40755 },
      {
        kind: "file",
        path: "packages/server/dist/server/server/daemon-worker.js",
        mode: 0o100644,
        sha256: hash("fixture worker"),
        size: 14,
      },
    ],
  };
  linuxArtifact.artifactSha256 = devRegistrationLinuxArtifactDigest(linuxArtifact);
  const parent = {
    pid: 7,
    parentPid: 1,
    uid: 0,
    gid: 0,
    bootId: "fixture-boot",
    startIdentity: "5113560",
    executable: "/usr/bin/python3.11",
    argumentsSha256: "4".repeat(64),
  };
  return DevRegistrationProvisionerInputSchema.parse({
    installationId: "a3ed817e-d9f4-40c4-8409-5948c4d6b35c",
    preparationNonce: "2fd5c9ab-e74a-4cd1-98fe-47715955740a",
    hostInspector: {
      path: "/host/audited-inspector.py",
      sha256: hash("fixture read-only inspector"),
      size: Buffer.byteLength("fixture read-only inspector"),
    },
    configurationFile: "/host/coordinator.json",
    hostReceiptFile: "/host/dev-registration.json",
    docker: {
      path: "/host/docker",
      socket: "/host/docker.sock",
      containerId: "5".repeat(64),
      sha256: hash("reviewed docker"),
      size: Buffer.byteLength("reviewed docker"),
    },
    startup: {
      path: "/usr/bin/tini",
      args: ["--", "/bin/bash", "/opt/personal-tailscale/entrypoint"],
      entrypoint: ["/usr/bin/tini", "--", "/bin/bash", "/opt/personal-tailscale/entrypoint"],
      cmd: null,
    },
    account: {
      user: "paseo",
      uid: 1000,
      gid: 1000,
      home: "/home/paseo",
      stateDirectory: "/home/paseo/.paseo",
    },
    requiredCapability: "reviewed-dev-root-registration-and-parent-observation-v1",
    systemPython: { path: "/usr/bin/python3.11", sha256: "6".repeat(64), size: 100 },
    node: {
      path: "/fixture/linux-node/bin/node",
      sha256: "7".repeat(64),
      size: 200,
      platform: "linux",
      arch: "arm64",
    },
    supervisor: {
      ...parent,
      pid: 101,
      parentPid: 7,
      uid: 1000,
      gid: 1000,
      executable: "/fixture/linux-node/bin/node",
      startIdentity: "132361430",
    },
    parent,
    startupFiles: [
      "/opt/personal-tailscale/entrypoint",
      "/etc/personal-tailscale/supervisord.conf",
      "/opt/personal-tailscale/start-paseo",
      "/usr/local/bin/paseo-docker-entrypoint",
    ].map((path) => ({ path, sha256: "8".repeat(64), size: 100 })),
    originalPointer: file("/etc/paseo-server-entry", "/fixture/bootstrap/factory-main-entry.mjs\n"),
    factoryEntry: file("/fixture/bootstrap/factory-main-entry.mjs", FACTORY_ENTRY),
    factoryLauncher: file("/fixture/factory-candidate/modules/factory/launch.py", FACTORY_LAUNCHER),
    originalSupervisorEntrypoint:
      "/fixture/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js",
    originalFactoryRuntime: "/fixture/factory-candidate/runtime.mjs",
    selectionPath: "/opt/vorteo-managed-releases/current",
    releaseRoot: "/opt/vorteo-managed-releases",
    linuxArtifact,
    originalLinuxArtifact: { ...linuxArtifact, root: "/fixture/bootstrap" },
    factoryRuntime: {
      path: "/fixture/factory-candidate/runtime.mjs",
      sha256: "9".repeat(64),
      size: 100,
    },
  });
}

function observationInput(
  operation: "replace" | "rollback" = "replace",
  dockerPath = "/host/approved-runtime/docker",
): DevRegistrationNativeObservationInput {
  const source = staticInput();
  source.docker.path = dockerPath;
  source.systemPython = { path: source.systemPython.path, sha256: hash("python"), size: 6 };
  const provisioner = prepareDevRegistrationProvisioner(source);
  if (dockerPath !== "/host/approved-runtime/docker") {
    // Synthetic retained pinless metadata is used only by refusal tests. Exact
    // historical script reproduction is covered by the provisioner suite.
    delete provisioner.plan.docker.sha256;
    delete provisioner.plan.docker.size;
    provisioner.planSha256 = hash(JSON.stringify(provisioner.plan));
  }
  const executor = {
    pid: 501,
    parentPid: 500,
    uid: 501,
    bootId: "host-boot",
    startIdentity: "1:2",
    argumentsSha256: "a".repeat(64),
    auditToken: [0, 501, 0, 0, 0, 501, 0, 1],
    executable: { path: "/host/node", sha256: "b".repeat(64) },
    entrypoint: { path: "/host/controller", sha256: "c".repeat(64) },
    artifactSha256: "d".repeat(64),
  };
  const script = operation === "replace" ? provisioner : provisioner.rollback;
  const binding = {
    requestId: randomUUID(),
    requestRevision: randomUUID(),
    approvedAt: "2026-10-17T00:00:00.000Z",
    decisionSha256: "a".repeat(64),
    requestPlanSha256: "b".repeat(64),
    supervisorPlanSha256: script.sha256,
    registrationPlanSha256: provisioner.planSha256,
    operation,
    preparationNonce: source.preparationNonce,
    original:
      operation === "replace" ? null : { requestId: randomUUID(), claimSha256: "e".repeat(64) },
    generation: randomUUID(),
    candidateSha256: "c".repeat(64),
    grantId: randomUUID(),
    grantRevision: randomUUID(),
    manifestSha256: "d".repeat(64),
    stepId: randomUUID(),
    activationGeneration: randomUUID(),
    sourceCommit: source.linuxArtifact.sourceCommit,
    artifactSha256: source.linuxArtifact.artifactSha256,
    nativeIdentitySha256: "a".repeat(64),
    preconditionSha256: "b".repeat(64),
    settlementSha256: "c".repeat(64),
    controller: executor,
  };
  const reservedAt = "2026-10-17T00:00:01.000Z";
  const effect = SupervisorEffectSchema.parse({
    phase: "consumed",
    binding,
    reservedAt,
    consumedAt: "2026-10-17T00:00:02.000Z",
    child: {
      reservationSha256: hash(JSON.stringify({ binding, reservedAt })),
      executor: { ...executor, pid: 502, parentPid: 501, auditToken: [0, 501, 0, 0, 0, 502, 0, 1] },
      acknowledgedAt: "2026-10-17T00:00:01.500Z",
    },
  });
  return {
    provisioner,
    effect,
    container: {
      containerId: source.docker.containerId,
      startup: source.startup,
      writableMounts: ["/workspace"],
      assertCurrent() {},
    },
  };
}

class InertChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  killed: NodeJS.Signals[] = [];
  payload = "";
  constructor(onInput: (child: InertChild) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.payload += chunk.toString();
        callback();
      },
      final: (callback) => {
        callback();
        queueMicrotask(() => onInput(this));
      },
    });
  }
  kill(signal: NodeJS.Signals) {
    this.killed.push(signal);
    return true;
  }
  complete(stdout: string, code = 0) {
    this.stdout.write(stdout);
    this.emit("close", code, null);
  }
}
function fixture(fixtureOptions: { outsideDocker?: boolean } = {}) {
  let dockerPath = "/host/approved-runtime/docker";
  if (fixtureOptions.outsideDocker) dockerPath = "/Applications/Docker.app/docker";
  const observed = observationInput("replace", dockerPath);
  const effect = observed.effect;
  if (effect.phase !== "consumed") throw Error("fixture needs consumed claim");
  const uid = process.getuid!();
  const root = "/host/approved-runtime";
  const node = effect.child.executor.executable;
  const coordinatorStep = randomUUID();
  const manifest = {
    version: 1,
    operation: "installation-enrollment",
    installationId: observed.provisioner.plan.installationId,
    revision: randomUUID(),
    createdAt: "2026-10-17T00:00:00.000Z",
    targets: ["host", "coordinator", "supervisor"].map((target) => ({
      target,
      identitySha256: "a".repeat(64),
      operations: ["replacement"],
    })),
    trustedRepositories: ["https://example.test/source"],
    provisioning: {
      admissionSha256: hash("actual inert admission"),
      coordinatorStepId: coordinatorStep,
    },
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 30 },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    steps: [
      {
        id: coordinatorStep,
        target: "coordinator",
        operation: "replacement",
        planSha256: hash("coordinator plan"),
        candidate: {
          sourceCommit: "1".repeat(40),
          artifactSha256: hash("approved complete graph"),
        },
        previous: null,
        dependsOn: [],
      },
      {
        id: effect.binding.stepId,
        target: "supervisor",
        operation: "replacement",
        planSha256: effect.binding.requestPlanSha256,
        candidate: {
          sourceCommit: effect.binding.sourceCommit,
          artifactSha256: effect.binding.artifactSha256,
        },
        previous: null,
        dependsOn: [coordinatorStep],
      },
    ],
  };
  let grant = InstallationStandingGrantSchema.parse({
    id: effect.binding.grantId,
    revision: effect.binding.grantRevision,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: randomUUID(),
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: "2026-10-17T00:00:00.000Z",
    },
    manifest,
    paused: false,
    revokedAt: null,
    disabledTargets: [],
  });
  effect.binding.manifestSha256 = grant.approval.manifestSha256;
  effect.binding.controller.bootId = "11111111-1111-4111-8111-111111111111";
  effect.child.executor.bootId = effect.binding.controller.bootId;
  effect.child.executor.uid = uid;
  effect.child.executor.entrypoint = {
    path: "/host/registration.js",
    sha256: observed.provisioner.sha256,
  };
  effect.child.executor.argumentsSha256 = hash(
    JSON.stringify([node.path, "--input-type=module", "--eval", observed.provisioner.script]),
  );
  effect.child.reservationSha256 = hash(
    JSON.stringify({ binding: effect.binding, reservedAt: effect.reservedAt }),
  );
  const plan = observed.provisioner.plan;
  let clock = 0;
  let exitError: Error | null = null;
  let hook = (_phase: string) => {};
  let boot = effect.child.executor.bootId;
  let autoClose = true;
  const calls: string[] = [];
  const children: InertChild[] = [];
  const commands: Array<{ file: string; args: string[]; timeoutMs?: number }> = [];
  const argv = [node.path, root + "/main.js"];
  async function unused(): Promise<never> {
    throw Error("Unexpected native method");
  }
  const reader: NativeBootstrapServiceReader = {
    async inspectAuditedProcess(pid) {
      calls.push("observer");
      hook("observer");
      return {
        identity: {
          pid,
          parentPid: process.ppid,
          uid,
          bootId: boot,
          startIdentity: "100:1",
          executable: node.path,
          argumentsSha256: hash(JSON.stringify(argv)),
        },
        auditToken: [0, uid, 0, 0, 0, pid, 0, 8],
      };
    },
    async verifyProcessExited(pid) {
      calls.push(`exit:${pid}`);
      hook("exit");
      if (exitError) throw exitError;
    },
    inspectProcess: unused,
    readService: unused,
    inspectRunningProcess: unused,
    verifyServiceAbsent: unused,
    inspectStoppedProcess: unused,
  };
  const runtime: MaintenanceObservationRuntime = {
    installationRoot: "/host",
    stateDirectory: "/host/state",
    account: { uid, home: "/host/home" },
    nativeAdmission: { path: "/host/native-admission.json", sha256: hash("native admission") },
    admission: {
      configurationFile: "/host/config.json",
      launcherFile: "/host/launcher",
      docker: plan.docker.path,
      socket: plan.docker.socket,
      containerId: plan.docker.containerId,
      helperPath: plan.hostInspector.path,
      helperSha256: plan.hostInspector.sha256,
    },
    writableMountRoots: ["/guest-writable"],
    ports: { reader, assertCurrent() {} },
    assertCurrent() {
      hook("runtime");
    },
  };
  let container = {
    Id: plan.docker.containerId,
    State: { Running: true },
    Path: plan.startup.path,
    Args: plan.startup.args,
    Config: { Entrypoint: plan.startup.entrypoint, Cmd: plan.startup.cmd },
    Mounts: [{ Type: "bind", Source: "/guest-writable", Destination: "/workspace", RW: true }],
  };
  function output(args: string[]) {
    if (args.includes("inspect")) {
      calls.push("metadata");
      hook("metadata");
      return JSON.stringify(container);
    }
    calls.push("root");
    hook("root");
    return JSON.stringify({ kind: "unresolved", reason: "Inert source observation only" });
  }
  const ports: DevRegistrationObservationHostPorts = {
    grant() {
      hook("grant");
      return grant;
    },
    effect() {
      hook("effect");
      return effect;
    },
    async approvedRuntime() {
      hook("approval");
      return {
        directory: root,
        sourceCommit: "1".repeat(40),
        artifactSha256: hash("approved complete graph"),
        planSha256: hash("coordinator plan"),
        node,
        entrypoint: { path: root + "/main.js", sha256: hash("main") },
        files: ["/host/approved-plan"],
        assertCurrent() {
          hook("approved-files-current");
        },
      };
    },
    async artifact() {
      hook("artifact");
      return {
        sha256: hash("approved complete graph"),
        assertCurrent() {
          hook("artifact-current");
        },
      };
    },
    async verifyFile() {
      hook("verify-file");
    },
    async readFile(pin) {
      hook("file");
      return Buffer.from(pin.path === plan.docker.path ? "reviewed docker" : "inert file");
    },
    async protect() {
      hook("protect");
    },
    retainFiles() {
      return () => hook("files-current");
    },
    retainSocket() {
      return () => hook("socket-current");
    },
    canonical: (file) => file,
    moduleFile: () =>
      root +
      "/packages/server/dist/server/server/execution-installation/maintenance/dev-registration-native-observation-host.js",
    observerArgv: () => [...argv],
    readBytes: () => Buffer.from("reviewed docker"),
    spawn(file, args) {
      commands.push({ file, args: [...args] });
      const child = new InertChild((value) => {
        if (autoClose) value.complete(output(args));
      });
      children.push(child);
      return child;
    },
    commandSync(file, args, options) {
      commands.push({ file, args: [...args], timeoutMs: options.timeoutMs });
      return output(args);
    },
    now: () => clock,
  };
  return {
    input: { runtime, requestId: effect.binding.requestId, provisioner: observed.provisioner },
    ports,
    effect,
    runtime,
    calls,
    commands,
    children,
    container,
    setHook(value: typeof hook) {
      hook = value;
    },
    advance(ms: number) {
      clock += ms;
    },
    exitFailure(error: Error) {
      exitError = error;
    },
    setBoot(value: string) {
      boot = value;
    },
    pauseChildren() {
      autoClose = false;
    },
    revoke() {
      grant = {
        ...grant,
        revision: randomUUID(),
        paused: true,
        revokedAt: "2026-10-17T01:00:00.000Z",
      };
    },
    replaceContainer(value: typeof container) {
      container = value;
    },
    run() {
      return observeDevRegistrationNativeFromHost(this.input, ports);
    },
  };
}
afterEach(() => vi.useRealTimers());

nativeHostTest(
  "composes only fixed Docker observation after the exact child exit gate",
  async () => {
    const f = fixture();
    const proof = await f.run();
    expect(proof.facts).toEqual({ kind: "unresolved", reason: "Inert source observation only" });
    expect(f.calls.indexOf(`exit:${f.effect.child.executor.pid}`)).toBeLessThan(
      f.calls.indexOf("metadata"),
    );
    expect(f.calls.filter((call) => call === "root")).toHaveLength(1);
    const rootCommand = f.commands.find((command) => command.args.includes("exec"));
    expect(rootCommand?.args).toEqual([
      "--host",
      `unix://${f.input.provisioner.plan.docker.socket}`,
      "exec",
      "-i",
      "--user",
      "0:0",
      f.input.provisioner.plan.docker.containerId,
      f.input.provisioner.plan.systemPython.path,
      "-I",
      "-B",
      "-c",
      DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT,
    ]);
    proof.assertCurrent();
    expect(f.calls.filter((call) => call.startsWith("exit:"))).toHaveLength(1);
    expect(f.calls.filter((call) => call === "root")).toHaveLength(2);
    expect(
      f.commands.every((command) => command.file === f.input.provisioner.plan.docker.path),
    ).toBe(true);
  },
);

nativeHostTest("external path-only Docker refuses before any command", async () => {
  const f = fixture({ outsideDocker: true });
  await expect(f.run()).rejects.toThrow("static Docker byte pin is missing");
  expect(f.commands).toEqual([]);
});

nativeHostTest(
  "an unapproved current module cannot stand in for coordinator artifact membership",
  async () => {
    const f = fixture();
    f.ports.moduleFile = () => "/host/other/dev-registration-native-observation-host.js";
    await expect(f.run()).rejects.toThrow("outside its approved coordinator graph");
    expect(f.commands).toEqual([]);
  },
);

nativeHostTest(
  "a Host graph with a different approved artifact cannot authorize observer code",
  async () => {
    const f = fixture();
    f.ports.artifact = async () => ({ sha256: hash("different graph"), assertCurrent() {} });
    await expect(f.run()).rejects.toThrow("coordinator artifact differs");
    expect(f.commands).toEqual([]);
  },
);

nativeHostTest("observed external Docker bytes cannot become their own approval", async () => {
  const f = fixture({ outsideDocker: true });
  f.ports.readBytes = () => Buffer.from("unapproved actual bytes");
  await expect(f.run()).rejects.toThrow("static Docker byte pin is missing");
  expect(f.commands).toEqual([]);
});

nativeHostTest("a changed endpoint or Docker path cannot redirect the protected plan", async () => {
  const f = fixture();
  f.runtime.admission.socket = "/host/other.sock";
  await expect(f.run()).rejects.toThrow("endpoint or helper differs");
  expect(f.commands).toEqual([]);
});

nativeHostTest("cross-boot child absence is refused before Docker inspection", async () => {
  const f = fixture();
  f.setBoot("22222222-2222-4222-8222-222222222222");
  await expect(f.run()).rejects.toThrow("local lifetime or boot differs");
  expect(f.commands).toEqual([]);
});

nativeHostTest("a native exit error is never converted into absence", async () => {
  const f = fixture();
  f.exitFailure(Error("native permission denied"));
  await expect(f.run()).rejects.toThrow("Unexpected native method");
  expect(f.commands).toEqual([]);
});

nativeHostTest("stable same-boot later birth can establish the old child exited", async () => {
  const f = fixture();
  f.exitFailure(Error("PID is in use"));
  const old = f.effect.child.executor;
  let reads = 0;
  f.runtime.ports.reader.inspectProcess = async (pid) => {
    reads++;
    return {
      pid,
      parentPid: 1,
      uid: old.uid,
      bootId: old.bootId,
      startIdentity: "2:3",
      executable: "/other/later/process",
      argumentsSha256: hash("later argv"),
    };
  };
  const proof = await f.run();
  expect(proof.facts.kind).toBe("unresolved");
  expect(reads).toBe(2);
});

nativeHostTest("changed observer boot around exit verification refuses", async () => {
  const f = fixture();
  f.setHook((phase) => {
    if (phase === "exit") f.setBoot("22222222-2222-4222-8222-222222222222");
  });
  await expect(f.run()).rejects.toThrow("lifetime changed around child exit");
  expect(f.commands).toEqual([]);
});

nativeHostTest("child substitution during a custody callback cannot reach Docker", async () => {
  const f = fixture();
  f.setHook((phase) => {
    if (phase === "exit") f.effect.child.executor.pid += 1;
  });
  await expect(f.run()).rejects.toThrow("consumed child changed");
  expect(f.commands).toEqual([]);
});

nativeHostTest("fixed observer remains readable after grant revocation", async () => {
  const f = fixture();
  f.setHook((phase) => {
    if (phase === "exit") f.revoke();
  });
  const proof = await f.run();
  proof.assertCurrent();
  expect(proof.facts.kind).toBe("unresolved");
  expect(f.calls.filter((call) => call === "root")).toHaveLength(2);
});

nativeHostTest("reconstructing observation repeats the actual child exit gate", async () => {
  const f = fixture();
  await f.run();
  await f.run();
  expect(f.calls.filter((call) => call.startsWith("exit:"))).toHaveLength(2);
});

nativeHostTest("an unsafe current startup never reaches the root observer", async () => {
  const f = fixture();
  f.container.Path = "/other/startup";
  await expect(f.run()).rejects.toThrow("startup tuple changed");
  expect(f.calls.filter((call) => call === "root")).toEqual([]);
});

nativeHostTest("root output is discarded if actual mounts change during the command", async () => {
  const f = fixture();
  f.setHook((phase) => {
    if (phase === "root") f.container.Mounts[0].Source = "/changed";
  });
  await expect(f.run()).rejects.toThrow("writable Host mounts changed");
});

nativeHostTest(
  "metadata consumes the same command budget and preserves final-read time",
  async () => {
    const f = fixture();
    let reads = 0;
    f.setHook((phase) => {
      if (phase === "metadata" && ++reads === 2) f.advance(8500);
    });
    await expect(f.run()).rejects.toThrow("command budget exhausted");
    expect(f.calls.filter((call) => call === "root")).toEqual([]);
  },
);

nativeHostTest("synchronous recheck rejects results beyond its shared total budget", async () => {
  const f = fixture();
  const proof = await f.run();
  f.setHook((phase) => {
    if (phase === "root") f.advance(11000);
  });
  expect(() => proof.assertCurrent()).toThrow("command budget exhausted");
});

nativeHostTest("expired proofs refuse before another native command", async () => {
  const f = fixture();
  const proof = await f.run();
  const commands = f.commands.length;
  f.advance(30000);
  expect(() => proof.assertCurrent()).toThrow("expired");
  expect(f.commands).toHaveLength(commands);
});

nativeHostTest(
  "callback replacement after native collection cannot become final custody",
  async () => {
    const f = fixture();
    const proof = await f.run();
    f.runtime.assertCurrent = () => {};
    const commands = f.commands.length;
    expect(() => proof.assertCurrent()).toThrow("input, reader or local owner changed");
    expect(f.commands).toHaveLength(commands);
  },
);

nativeHostTest("raw local child remains owned after timeout until its close event", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.pauseChildren();
  let settled = false;
  const pending = f.run();
  const checked = pending.catch((error: unknown) => {
    settled = true;
    throw error;
  });
  void checked.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(f.children).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.children[0].killed).toEqual(["SIGKILL"]);
  expect(settled).toBe(false);
  expect(f.commands).toHaveLength(1);
  f.children[0].emit("close", null, "SIGKILL");
  await expect(checked).rejects.toThrow("timed out");
});

nativeHostTest(
  "bounded output keeps draining and waits for actual raw-child settlement",
  async () => {
    const f = fixture();
    f.pauseChildren();
    const pending = f.run();
    await vi.waitFor(() => expect(f.children).toHaveLength(1));
    const raw = f.children[0];
    raw.stdout.write(Buffer.alloc(1024 * 1024 + 1));
    raw.stderr.write(Buffer.from("still draining"));
    expect(raw.killed.length).toBeGreaterThan(0);
    raw.emit("close", null, "SIGKILL");
    await expect(pending).rejects.toThrow("output exceeded bound");
    expect(f.calls.filter((call) => call === "root")).toEqual([]);
  },
);

nativeHostTest(
  "an approved observer module cannot authorize an unrelated process entrypoint",
  async () => {
    const f = fixture();
    const original = f.ports.approvedRuntime;
    f.ports.approvedRuntime = async (...args) => ({
      ...(await original(...args)),
      entrypoint: { path: "/host/unapproved-main.js", sha256: hash("unapproved") },
    });
    await expect(f.run()).rejects.toThrow(
      "entrypoint is outside its independently approved runtime",
    );
    expect(f.commands).toEqual([]);
  },
);

nativeHostTest(
  "adding an unapproved static Docker hash does not alter the consumed commitment",
  async () => {
    const f = fixture({ outsideDocker: true });
    Object.assign(f.input.provisioner.plan.docker, { sha256: hash("reviewed docker"), size: 15 });
    await expect(f.run()).rejects.toThrow("approved static plan");
    expect(f.commands).toEqual([]);
  },
);

nativeHostTest("socket custody failure refuses before any Docker command", async () => {
  const f = fixture();
  f.ports.retainSocket = () => {
    throw Error("actual socket replaced");
  };
  await expect(f.run()).rejects.toThrow("actual socket replaced");
  expect(f.commands).toEqual([]);
});

nativeHostTest("synchronous spawn failure has no fallback root invocation", async () => {
  const f = fixture();
  f.ports.spawn = () => {
    throw Error("spawn failed");
  };
  await expect(f.run()).rejects.toThrow("spawn failed");
  expect(f.calls.filter((call) => call === "root")).toEqual([]);
});

nativeHostTest("local nonzero exit cannot produce even a parsed metadata observation", async () => {
  const f = fixture();
  f.ports.spawn = () => new InertChild((child) => child.complete("{}", 1));
  await expect(f.run()).rejects.toThrow("fixed Docker command failed");
  expect(f.calls.filter((call) => call === "root")).toEqual([]);
});

nativeHostTest("local error events retain ownership until close", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.pauseChildren();
  let settled = false;
  const pending = f.run().catch((error: unknown) => {
    settled = true;
    throw error;
  });
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  const raw = f.children[0];
  raw.emit("error", Error("raw process error"));
  raw.emit("error", Error("later local error"));
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  raw.emit("close", 1, null);
  await expect(pending).rejects.toThrow("raw process error");
});

nativeHostTest("post-read claim mutation invalidates the retained terminal gate", async () => {
  const f = fixture();
  const proof = await f.run();
  f.effect.child.executor.bootId = randomUUID();
  const count = f.commands.length;
  expect(() => proof.assertCurrent()).toThrow("consumed child changed");
  expect(f.commands).toHaveLength(count);
});

nativeHostTest("mutable native port replacement cannot become a recheck", async () => {
  const f = fixture();
  const proof = await f.run();
  f.ports.commandSync = () => JSON.stringify({ kind: "unresolved", reason: "replacement" });
  expect(() => proof.assertCurrent()).toThrow("native port changed");
});

nativeHostTest("synchronous stdin failure retains the raw child until close", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const raw = new InertChild(() => {});
  raw.stdin.end = () => {
    throw Error("synchronous stdin failure");
  };
  f.ports.spawn = () => raw;
  let settled = false;
  const pending = f.run().catch((error: unknown) => {
    settled = true;
    throw error;
  });
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(raw.killed).toEqual(["SIGKILL"]);
  expect(settled).toBe(false);
  raw.emit("close", null, "SIGKILL");
  await expect(pending).rejects.toThrow("synchronous stdin failure");
});

nativeHostTest("drained chunk boundaries preserve UTF-8 native output", async () => {
  const f = fixture();
  const originalSpawn = f.ports.spawn;
  f.ports.spawn = (file, args) => {
    if (!args.includes("exec")) return originalSpawn(file, args);
    return new InertChild((child) => {
      const bytes = Buffer.from(
        JSON.stringify({ kind: "unresolved", reason: "Observation 未確定" }),
      );
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
      child.emit("close", 0, null);
    });
  };
  const proof = await f.run();
  expect(proof.facts).toEqual({ kind: "unresolved", reason: "Observation 未確定" });
});
