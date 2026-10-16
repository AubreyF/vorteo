import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import type { InstallationConfig } from "../config.js";
import {
  enrollmentNativeIdentityDigest,
  type EnrollmentNativeIdentity,
} from "./native-identity.js";
import {
  inspectEnrollmentDaemonIdentity,
  DEV_DAEMON_INSPECTION_SCRIPT,
  type EnrollmentDaemonInspectionPorts,
} from "./native-daemon-inspection.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture() {
  const root = await mkdtemp(path.join(realpathSync(tmpdir()), "daemon-inspection-"));
  directories.push(root);
  const uid = process.getuid!();
  const state = path.join(root, "state"),
    releases = path.join(root, "releases"),
    release = path.join(releases, "one"),
    home = path.join(root, "home");
  for (const dir of [state, releases, release, home]) await mkdir(dir, { mode: 0o700 });
  const file = async (name: string, value: unknown) => {
    await writeFile(name, JSON.stringify(value), { mode: 0o600 });
  };
  const selection = path.join(releases, "current");
  await symlink(release, selection);
  const node = path.join(root, "node"),
    launcher = path.join(root, "host.plist");
  await file(node, {});
  await file(launcher, {});
  const sourceCommit = "a".repeat(40),
    containerId = "b".repeat(64),
    installationId = randomUUID();
  await file(path.join(release, ".installation-source.json"), { sourceCommit });
  const config: InstallationConfig = {
    public: {
      installationId,
      environments: [
        { kind: "host", serverId: "host-id", label: "Host", endpoint: "https://host.example" },
        { kind: "container", serverId: "dev-id", label: "Dev", endpoint: "https://dev.example" },
      ],
    },
    listenPort: 1234,
    webDistDir: path.join(root, "web"),
    stateDir: state,
    ownerPasswordHash: "$2fixture",
    hostAgentTokenHash: "1".repeat(64),
    containerAgentTokenHash: "2".repeat(64),
    host: {
      endpoint: "127.0.0.1:3333",
      password: "fixture-host",
      launchdService: `gui/${uid}/local.vorteo.test.host`,
      startupValidation: {
        node,
        entrypoint: path.join(selection, "packages/server/dist/scripts/supervisor-entrypoint.js"),
        home,
      },
    },
    container: { endpoint: "127.0.0.1:4444", password: "fixture-dev" },
    sourceUpdates: {
      sourceRepository: root,
      releaseRoot: releases,
      currentReleaseLink: selection,
      webDirectory: path.join(root, "web"),
      toolingDirectory: root,
      integrationRef: "refs/heads/main",
    },
    containerSourceUpdates: {
      sourceRepository: root,
      toolingDirectory: root,
      integrationRef: "refs/heads/main",
      receiptFile: path.join(root, "dev-source.json"),
      docker: "/usr/local/bin/docker",
      containerId,
      user: "dev",
      node: "/usr/bin/node",
      home: "/home/dev/.vorteo",
      releaseRoot: "/releases",
      currentReleaseLink: "/releases/current",
    },
  };
  const configFile = path.join(root, "installation.json"),
    setupFile = path.join(root, "admission.json");
  await file(configFile, config);
  await file(path.join(root, "dev-source.json"), { sourceCommit });
  await file(path.join(root, "coordinator-bootstrap-runner.json"), {
    admissionSetupFile: setupFile,
  });
  await file(setupFile, {
    configurationFile: configFile,
    launcherFile: path.join(root, "coordinator.plist"),
    docker: config.containerSourceUpdates!.docker,
    socket: path.join(root, "docker.sock"),
    containerId,
    helperPath: path.join(root, "helper"),
    helperSha256: "c".repeat(64),
  });
  const expected: EnrollmentNativeIdentity = {
    version: 1,
    environment: "host",
    target: "host",
    installationId,
    custodyOwnerUid: uid,
    installationRoot: root,
    stateDirectory: home,
    serviceDomain: `gui/${uid}`,
    serviceLabel: "local.vorteo.test.host",
    launcherPath: launcher,
    selectionPath: selection,
  };
  const argv = [node, config.host.startupValidation!.entrypoint];
  const plist = {
    Label: "local.vorteo.test.host",
    ProgramArguments: argv,
    EnvironmentVariables: { PASEO_HOME: home },
  };
  const service = () =>
    `${config.host.launchdService} = {\n\tpath = ${launcher}\n\tprogram = ${node}\n\targuments = {\n\t\t${argv.join("\n\t\t")}\n\t}\n\tenvironment = {\n\t\tPASEO_HOME => ${home}\n\t}\n\tpid = 101\n}\n`;
  const bootId = randomUUID();
  const supervisor = {
    pid: 101,
    parentPid: 1,
    uid,
    bootId,
    startIdentity: "100:123",
    executable: node,
    argumentsSha256: hash(argv),
  };
  const worker = {
    ...supervisor,
    pid: 102,
    parentPid: 101,
    startIdentity: "101:123",
    argumentsSha256: hash([
      node,
      path.join(release, "packages/server/dist/server/server/daemon-worker.js"),
    ]),
  };
  const docker: {
    Id: string;
    State: { Running: boolean };
    Mounts: unknown[];
    Path: string;
    Args: string[];
    Config: { Entrypoint: string[]; Cmd: null };
  } = {
    Id: containerId,
    State: { Running: true },
    Mounts: [],
    Path: "/usr/bin/tini",
    Args: ["--", "/bin/bash", "/opt/profile/entrypoint"],
    Config: {
      Entrypoint: ["/usr/bin/tini", "--", "/bin/bash", "/opt/profile/entrypoint"],
      Cmd: null,
    },
  };
  const calls: {
    file: string;
    args: string[];
    timeout: number;
    maxBuffer: number;
    env: unknown;
  }[] = [];
  const dev = {
    uid: 1000,
    gid: 1000,
    home: "/home/dev",
    state: "/home/dev/.vorteo",
    supervisorEntrypoint: "/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js",
    selection: "/releases/current",
    release: "/releases/one",
    sourceCommit,
    supervisor: {
      ...supervisor,
      uid: 1000,
      gid: 1000,
      executable: "/usr/bin/node",
      startIdentity: "100",
    },
    worker: { ...worker, uid: 1000, gid: 1000, executable: "/usr/bin/node", startIdentity: "101" },
  };
  const ports: EnrollmentDaemonInspectionPorts = {
    platform: "darwin",
    uid,
    now: () => Date.parse("2026-10-15T22:00:00Z"),
    async command(command, args, limits) {
      calls.push({ file: command, args, ...limits });
      if (command === "/bin/launchctl") return service();
      if (command === "/usr/bin/plutil") return JSON.stringify(plist);
      if (command === config.containerSourceUpdates!.docker && args[2] === "container")
        return JSON.stringify(docker);
      if (command === config.containerSourceUpdates!.docker && args[2] === "exec")
        return JSON.stringify(dev);
      throw new Error("Unexpected native command");
    },
    async processes() {
      return {
        async inspectRunningProcess(pid) {
          return { ...(pid === 101 ? supervisor : worker), stopped: false };
        },
      };
    },
    async daemon(_config, kind) {
      return { serverId: kind === "host" ? "host-id" : "dev-id", pid: 102 };
    },
  };
  const devExpected: EnrollmentNativeIdentity = {
    version: 1,
    environment: "container",
    target: "container-daemon",
    installationId,
    custodyOwnerUid: uid,
    installationRoot: root,
    stateDirectory: state,
    containerId,
    containerUid: 1000,
    containerGid: 1000,
    containerHome: dev.home,
    containerStateDirectory: dev.state,
    launcherPath: "/opt/profile/daemon-launcher",
    selectionPath: dev.selection,
  };
  return {
    root,
    expected,
    devExpected,
    config,
    configFile,
    file,
    ports,
    plist,
    supervisor,
    worker,
    docker,
    dev,
    calls,
    sourceCommit,
    release,
  };
}

test("Host observation binds registered service, native birth, selected source and authenticated daemon", async () => {
  const f = await fixture();
  const observation = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
  expect(observation).toEqual({
    assertCurrent: expect.any(Function),
    verifyPreviousWorkerExited: expect.any(Function),
    descriptor: f.expected,
    identitySha256: enrollmentNativeIdentityDigest(f.expected),
    writableMountRoots: [],
    custodyStateDirectory: f.config.stateDir,
    serverId: "host-id",
    observedAt: "2026-10-15T22:00:00.000Z",
    selectedRelease: f.release,
    sourceCommit: f.sourceCommit,
    supervisor: f.supervisor,
    worker: f.worker,
  });
  for (const call of f.calls) {
    expect(call.timeout).toBeLessThanOrEqual(10000);
    expect(call.maxBuffer).toBe(1024 * 1024);
    expect(call.env).toEqual({ PATH: "/usr/bin:/bin" });
  }
  expect(f.calls.filter((c) => c.file === "/bin/launchctl").map((c) => c.args)).toEqual([
    ["print", f.config.host.launchdService],
    ["print", f.config.host.launchdService],
  ]);
});

test.each([
  "server",
  "birth",
  "parent",
  "argv",
  "plist",
  "container",
  "mount",
  "permissions",
  "descriptor",
])("Host refuses %s mismatch rather than projecting health", async (failure) => {
  const f = await fixture();
  if (failure === "server") f.ports.daemon = async () => ({ serverId: "wrong", pid: 102 });
  if (failure === "parent") f.worker.parentPid = 999;
  if (failure === "argv") f.worker.argumentsSha256 = "d".repeat(64);
  if (failure === "plist") f.plist.EnvironmentVariables.PASEO_HOME = "/other";
  if (failure === "container") f.docker.Id = "d".repeat(64);
  if (failure === "mount")
    f.docker.Mounts = [{ Type: "bind", RW: true, Source: f.root, Destination: "/guest" }];
  if (failure === "permissions") await chmod(f.root, 0o777);
  if (failure === "descriptor") f.expected.selectionPath = "/wrong";
  if (failure === "birth") {
    let n = 0;
    f.ports.processes = async () => ({
      async inspectRunningProcess(pid) {
        n++;
        return {
          ...(pid === 101 ? f.supervisor : f.worker),
          stopped: false,
          startIdentity: n > 2 ? "200:123" : "100:123",
        };
      },
    });
  }
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports)).rejects.toThrow();
});

test("Dev refuses transient supervisor identity when persistent profile registration is absent", async () => {
  const f = await fixture();
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.devExpected, f.ports)).rejects.toThrow(
    "stable launcher registration is unavailable",
  );
  const call = f.calls.find((c) => c.args[2] === "exec")!;
  expect(call.args.slice(0, 12)).toEqual([
    "--host",
    `unix://${f.root}/docker.sock`,
    "exec",
    "--env",
    "NODE_OPTIONS=",
    "--env",
    "NODE_PATH=",
    "--user",
    "dev",
    f.docker.Id,
    "/usr/bin/node",
    "--eval",
  ]);
  expect(call.args[12]).toBe(DEV_DAEMON_INSPECTION_SCRIPT);
  expect(() => new Script(call.args[12])).not.toThrow();
  expect(JSON.parse(call.args[13])).toEqual({
    home: "/home/dev/.vorteo",
    releaseRoot: "/releases",
    selection: "/releases/current",
    node: "/usr/bin/node",
    pid: 102,
  });
});

test.each(["uid", "gid", "home", "state", "selection", "source", "worker", "boot"])(
  "Dev refuses %s mismatch",
  async (failure) => {
    const f = await fixture();
    if (failure === "uid") f.dev.uid++;
    if (failure === "gid") f.dev.gid++;
    if (failure === "home") f.dev.home = "/home/other";
    if (failure === "state") f.dev.state = "/other";
    if (failure === "selection") f.dev.selection = "/other/current";
    if (failure === "source") f.dev.sourceCommit = "d".repeat(40);
    if (failure === "worker") f.dev.worker.parentPid = 999;
    if (failure === "boot") f.dev.worker.bootId = randomUUID();
    await expect(inspectEnrollmentDaemonIdentity(f.config, f.devExpected, f.ports)).rejects.toThrow(
      /Dev (observed|source)/,
    );
  },
);

test("Unavailable native commands and unsupported platforms refuse without lifecycle commands", async () => {
  const f = await fixture();
  f.ports.platform = "linux";
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports)).rejects.toThrow(
    "macOS",
  );
  expect(f.calls).toEqual([]);
  f.ports.platform = "darwin";
  f.ports.command = async () => {
    throw new Error("Command timed out");
  };
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports)).rejects.toThrow(
    "timed out",
  );
});

test("Observation expires and stops issuing commands when its total budget is exhausted", async () => {
  const f = await fixture();
  let n = 0;
  f.ports.now = () => (n++ === 0 ? 0 : 60001);
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports)).rejects.toThrow(
    "deadline",
  );
  expect(f.calls).toEqual([]);
});

function executeDevProbe(failure?: string) {
  const input = {
    home: "/home/dev/.vorteo",
    releaseRoot: "/releases",
    selection: "/releases/current",
    node: "/usr/bin/node",
    pid: 102,
  };
  const files = new Map<string, string>();
  const boot = "5b60c6c4-0254-4b3a-90a4-c1d89fa37028";
  files.set("/proc/sys/kernel/random/boot_id", boot);
  files.set(
    "/home/dev/.vorteo/managed-supervisor.json",
    JSON.stringify({ version: 1, root: "/releases", link: input.selection, pid: 101 }),
  );
  files.set(
    "/releases/one/.installation-source.json",
    JSON.stringify({ sourceCommit: "a".repeat(40) }),
  );
  for (const pid of [101, 102]) {
    const fields = Array(20).fill("0");
    fields[0] = failure === "stopped" && pid === 102 ? "T" : "S";
    fields[1] = pid === 101 ? "1" : "101";
    fields[19] = "123456";
    files.set(`/proc/${pid}/stat`, `${pid} (node fixture) ${fields.join(" ")}`);
    const uid = failure === "uid" && pid === 102 ? 2000 : 1000;
    files.set(
      `/proc/${pid}/status`,
      `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t1000\t1000\t1000\t1000\n`,
    );
    const entry =
      pid === 101
        ? "/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js"
        : "/releases/one/packages/server/dist/server/server/daemon-worker.js";
    files.set(
      `/proc/${pid}/cmdline`,
      [input.node, failure === "argv" && pid === 102 ? "/other/worker.js" : entry, ""].join("\0"),
    );
    const env =
      pid === 101
        ? [
            `PASEO_MANAGED_RELEASE_LINK=${input.selection}`,
            "PASEO_MANAGED_RELEASE_ROOT=/releases",
            `PASEO_HOME=${input.home}`,
          ]
        : [`PASEO_HOME=${input.home}`, "PASEO_MANAGED_WORKER=1"];
    files.set(`/proc/${pid}/environ`, env.join("\0"));
  }
  let output = "";
  const fsPort = {
    constants: { O_RDONLY: 0, O_NONBLOCK: 0 },
    openSync(file: string) {
      if (!files.has(file)) throw new Error("Unexpected read");
      return file;
    },
    readSync(file: string, buffer: Buffer) {
      const bytes = Buffer.from(files.get(file)!);
      bytes.copy(buffer);
      return bytes.length;
    },
    closeSync() {},
    realpathSync(file: string) {
      if (file === input.selection) return "/releases/one";
      if (/^\/proc\/\d+\/exe$/.test(file)) return input.node;
      return file;
    },
  };
  const modules: Record<string, unknown> = {
    "node:fs": fsPort,
    "node:path": path,
    "node:os": { userInfo: () => ({ uid: 1000, gid: 1000, homedir: "/home/dev" }) },
    "node:crypto": { createHash },
  };
  new Script(DEV_DAEMON_INSPECTION_SCRIPT).runInNewContext(
    {
      require(name: string) {
        if (!(name in modules)) throw new Error("Unexpected module");
        return modules[name];
      },
      process: { argv: ["node", JSON.stringify(input)], getuid: () => 1000, getgid: () => 1000 },
      Buffer,
      console: {
        log(value: string) {
          output = value;
        },
      },
    },
    { timeout: 1000 },
  );
  return JSON.parse(output);
}

test("fixed Dev probe parses kernel start ticks, numeric credentials, parent and actual launcher", () => {
  const result = executeDevProbe();
  expect(result.uid).toBe(1000);
  expect(result.gid).toBe(1000);
  expect(result.worker).toMatchObject({
    pid: 102,
    parentPid: 101,
    startIdentity: "123456",
    executable: "/usr/bin/node",
  });
  expect(result.supervisorEntrypoint).toBe(
    "/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js",
  );
  expect(result.worker).not.toHaveProperty("env");
});

test.each(["uid", "argv", "stopped"])("fixed Dev probe rejects %s evidence", (failure) => {
  expect(() => executeDevProbe(failure)).toThrow("Dev native identity differs");
});

test("a changed daemon PID during observation cannot become fresh identity evidence", async () => {
  const f = await fixture();
  let connections = 0;
  f.ports.daemon = async () => ({ serverId: "host-id", pid: ++connections === 1 ? 102 : 103 });
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports)).rejects.toThrow(
    "Daemon changed",
  );
});

test("native inspection retains the authenticated worker lifetime", async () => {
  const f = await fixture();
  const workerInstanceId = randomUUID();
  const restartDrainId = randomUUID();
  f.ports.daemon = async () => ({
    serverId: "host-id",
    pid: 102,
    workerInstanceId,
    restartDrainId,
  });
  const result = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
  expect(result.workerInstanceId).toBe(workerInstanceId);
  expect(result.restartDrainId).toBe(restartDrainId);
  expect(result.worker.pid).toBe(102);
});

test("a released hold during native observation invalidates the entire proof", async () => {
  const f = await fixture();
  const workerInstanceId = randomUUID();
  const restartDrainId = randomUUID();
  let calls = 0;
  f.ports.daemon = async () => ({
    serverId: "host-id",
    pid: 102,
    workerInstanceId,
    restartDrainId: calls++ === 0 ? restartDrainId : null,
  });
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports)).rejects.toThrow(
    "Daemon changed",
  );
});

test("a changed worker lifetime with the same PID invalidates native evidence", async () => {
  const f = await fixture();
  const instances = [randomUUID(), randomUUID()];
  let connection = 0;
  f.ports.daemon = async () => ({
    serverId: "host-id",
    pid: 102,
    workerInstanceId: instances[connection++],
  });
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports)).rejects.toThrow(
    "Daemon changed",
  );
});

test("replacement inspection requires independent exit proof for the old worker", async () => {
  const f = await fixture();
  const previous = { ...f.worker, pid: 90, startIdentity: "99:123" };
  let alive = true;
  const checked: number[] = [];
  f.ports.processes = async () => ({
    inspectRunningProcess: async (pid) => ({
      ...(pid === f.supervisor.pid ? f.supervisor : f.worker),
      stopped: false,
    }),
    async verifyProcessExited(pid) {
      checked.push(pid);
      if (alive) throw new Error("Worker is still running");
    },
    inspectProcess: async () => previous,
  });
  const current = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
  expect(current.worker.pid).not.toBe(previous.pid);
  await expect(current.verifyPreviousWorkerExited!(previous)).rejects.toThrow("exit is unproven");
  alive = false;
  await current.verifyPreviousWorkerExited!(previous);
  expect(checked).toEqual([90, 90]);
  await expect(
    current.verifyPreviousWorkerExited!({ ...previous, uid: previous.uid + 1 }),
  ).rejects.toThrow("custody differs");
});

test("replacement exit proof distinguishes PID reuse from a current boot change", async () => {
  const f = await fixture();
  const previous = { ...f.worker, pid: 90, startIdentity: "99:123" };
  let laterBirth = "98:123";
  let failedExitReads = 0;
  f.ports.processes = async () => ({
    inspectRunningProcess: async (pid) => ({
      ...(pid === f.supervisor.pid ? f.supervisor : f.worker),
      stopped: false,
    }),
    async verifyProcessExited() {
      failedExitReads++;
      throw new Error("PID is present");
    },
    inspectProcess: async () => ({ ...previous, startIdentity: laterBirth }),
  });
  const current = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
  await expect(current.verifyPreviousWorkerExited!(previous)).rejects.toThrow("exit is unproven");
  laterBirth = "100:123";
  await current.verifyPreviousWorkerExited!(previous);
  expect(failedExitReads).toBe(2);
  await current.verifyPreviousWorkerExited!({ ...previous, bootId: randomUUID() });
  expect(failedExitReads).toBe(2);
});

test("configuration changes during native inspection invalidate the observation", async () => {
  const f = await fixture();
  f.ports.daemon = async () => {
    await f.file(f.configFile, { ...f.config, listenPort: 7777 });
    return { serverId: "host-id", pid: 102 };
  };
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports)).rejects.toThrow(
    "configuration changed",
  );
});

test("mount inventory is bounded before volume inspection or daemon connection", async () => {
  const f = await fixture();
  f.docker.Mounts = Array.from({ length: 129 }, () => ({
    Type: "tmpfs",
    RW: true,
    Destination: "/tmp",
  }));
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports)).rejects.toThrow(
    "Too many container mounts",
  );
  expect(f.calls).toHaveLength(1);
});

test("returns independently inspected Host writable mount roots for source custody checks", async () => {
  const f = await fixture();
  const guestSource = await mkdtemp(path.join(realpathSync(tmpdir()), "guest-source-"));
  directories.push(guestSource);
  f.docker.Mounts = [{ Type: "bind", RW: true, Source: guestSource, Destination: "/workspace" }];
  const observation = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
  expect(observation.writableMountRoots).toEqual([guestSource]);
  expect(observation.descriptor).toEqual(f.expected);
});

test("Host stable identity binds daemon home separately from coordinator custody", async () => {
  const f = await fixture();
  expect(f.expected.stateDirectory).not.toBe(f.config.stateDir);
  const observation = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
  expect(observation.descriptor.stateDirectory).toBe(f.config.host.startupValidation!.home);
  expect(observation.custodyStateDirectory).toBe(f.config.stateDir);
  await expect(
    inspectEnrollmentDaemonIdentity(
      f.config,
      { ...f.expected, stateDirectory: f.config.stateDir },
      f.ports,
    ),
  ).rejects.toThrow("Observed native identity differs");
});

test("Dev supervisor replacement cannot be mistaken for a change in registered launcher identity", async () => {
  const f = await fixture();
  for (const executable of [
    "/releases/one/packages/server/dist/scripts/supervisor-entrypoint.js",
    "/releases/two/packages/server/dist/scripts/supervisor-entrypoint.js",
  ]) {
    f.dev.supervisorEntrypoint = executable;
    await expect(inspectEnrollmentDaemonIdentity(f.config, f.devExpected, f.ports)).rejects.toThrow(
      "stable launcher registration is unavailable",
    );
  }
});

test("matching the transient supervisor path never substitutes for persistent Dev registration", async () => {
  const f = await fixture();
  f.devExpected.launcherPath = f.dev.supervisorEntrypoint;
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.devExpected, f.ports)).rejects.toThrow(
    "stable launcher registration is unavailable",
  );
});

test("Docker entrypoint changes during inspection invalidate Host custody evidence", async () => {
  const f = await fixture();
  f.ports.daemon = async () => {
    f.docker.Config.Entrypoint.push("/changed");
    return { serverId: "host-id", pid: 102 };
  };
  await expect(inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports)).rejects.toThrow(
    "Docker custody changed",
  );
});

test.each(["launcher", "configuration", "receipt", "node"] as const)(
  "retained custody refuses changed %s after inspection",
  async (target) => {
    const f = await fixture();
    const observation = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
    const files = {
      launcher: f.expected.launcherPath,
      configuration: f.configFile,
      receipt: path.join(f.release, ".installation-source.json"),
      node: f.config.host.startupValidation!.node,
    };
    await writeFile(files[target], "changed retained evidence");
    expect(() => observation.assertCurrent()).toThrow("Retained native custody changed");
  },
);

test("retained custody refuses changed selection", async () => {
  const f = await fixture();
  const observation = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
  const next = path.join(f.config.sourceUpdates!.releaseRoot, "two");
  await mkdir(next, { mode: 0o700 });
  await rm(f.expected.selectionPath);
  await symlink(next, f.expected.selectionPath);
  expect(() => observation.assertCurrent()).toThrow("Retained native custody changed");
});

test("retained custody refuses changed parent permissions", async () => {
  const f = await fixture();
  const observation = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
  await chmod(f.root, 0o777);
  expect(() => observation.assertCurrent()).toThrow("Retained native custody changed");
});

test("retained check is synchronous and tolerates unrelated journal writes without native calls", async () => {
  const f = await fixture();
  const observation = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
  const calls = f.calls.length;
  await writeFile(path.join(f.config.stateDir, "queue.json"), "{}", { mode: 0o600 });
  f.ports.command = async () => {
    throw new Error("Native calls forbidden under lock");
  };
  f.ports.daemon = async () => {
    throw new Error("Daemon calls forbidden under lock");
  };
  f.ports.processes = async () => {
    throw new Error("Process calls forbidden under lock");
  };
  expect(observation.assertCurrent()).toBeUndefined();
  expect(f.calls).toHaveLength(calls);
});

test("retained custody refuses a missing launcher", async () => {
  const f = await fixture();
  const observation = await inspectEnrollmentDaemonIdentity(f.config, f.expected, f.ports);
  await rm(f.expected.launcherPath);
  expect(() => observation.assertCurrent()).toThrow();
});
