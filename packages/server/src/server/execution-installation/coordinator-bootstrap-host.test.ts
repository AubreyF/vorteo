import {
  createManagedBootstrapReview,
  createConfiguredBootstrapReview,
} from "./coordinator-bootstrap-launch.js";
import { afterEach, test, expect, vi } from "vitest";
import {
  openSync,
  closeSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { waitForBootstrapWatchdog } from "./coordinator-bootstrap-runner.js";
import { readBootstrapHealth } from "./coordinator-bootstrap-runtime.js";
import { promisify } from "node:util";
import { hashSync } from "bcryptjs";
import {
  readBootstrapHostBinding,
  bootstrapWritableMountRoots,
  verifyBootstrapConfiguration,
  verifyBootstrapPlan,
  createBootstrapReviewService,
} from "./coordinator-bootstrap-host.js";
import { CoordinatorBootstrapPlanSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  createNativeBootstrapServiceReader,
  readBootstrapLauncher,
} from "./coordinator-bootstrap-service.js";

import * as serviceCollector from "./coordinator-bootstrap-service.js";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";

import { createBootstrapNativeLifecycle } from "./coordinator-bootstrap-native.js";
import { requireBootstrapOwnership } from "./coordinator-bootstrap-ownership.js";
import { selectBootstrapLauncher } from "./coordinator-bootstrap-selection.js";

const roots: string[] = [];

test.runIf(process.platform === "darwin")(
  "native launcher parser consumes reviewed bytes and rejects changed or exposed documents",
  async () => {
    const { root } = fixture();
    const file = path.join(root, "service.plist");
    const bytes = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>fixture</string>
<key>KeepAlive</key><true/><key>ProgramArguments</key><array>
<string>/fixture/node</string><string>a&amp;b</string></array></dict></plist>`);
    writeFileSync(file, bytes, { mode: 0o600 });
    const prepared = { path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
    expect(await readBootstrapLauncher(prepared, [])).toEqual({
      Label: "fixture",
      KeepAlive: true,
      ProgramArguments: ["/fixture/node", "a&b"],
    });
    await expect(readBootstrapLauncher(prepared, [root])).rejects.toThrow("mount");
    await expect(
      readBootstrapLauncher({ ...prepared, sha256: "f".repeat(64) }, []),
    ).rejects.toThrow("digest");
    chmodSync(file, 0o666);
    await expect(readBootstrapLauncher(prepared, [])).rejects.toThrow("another account");
    chmodSync(file, 0o600);
    const invalid = Buffer.from("private-fixture-value is not a plist");
    writeFileSync(file, invalid);
    const invalidFile = { path: file, sha256: createHash("sha256").update(invalid).digest("hex") };
    await expect(readBootstrapLauncher(invalidFile, [])).rejects.toThrow(
      /^Prepared launcher is not a valid plist$/,
    );
    await expect(readBootstrapLauncher(prepared, [])).rejects.toThrow("digest");
  },
);

test.runIf(process.platform === "darwin")(
  "native process inspection binds birth identity and hashes argv without exposing environment",
  async () => {
    const child = spawn("/bin/sleep", ["30"], {
      env: { VORTEO_INSPECTION_SENTINEL: "fixture-environment-must-not-escape" },
      stdio: "ignore",
    });
    const closed = once(child, "close");
    await once(child, "spawn");
    const execute = promisify(execFile);
    const script = path.resolve("../../scripts/inspect-coordinator-process.py");
    const inspect = () =>
      execute("/usr/bin/python3", [script, String(child.pid)], { timeout: 5000 });
    try {
      const first = await inspect();
      const second = await inspect();
      const identity = JSON.parse(first.stdout);
      expect(JSON.parse(second.stdout)).toEqual(identity);
      expect(identity).toMatchObject({
        pid: child.pid,
        parentPid: process.pid,
        uid: process.getuid!(),
        executable: "/bin/sleep",
        argumentsSha256: createHash("sha256")
          .update(JSON.stringify(["/bin/sleep", "30"]))
          .digest("hex"),
      });
      expect(identity.bootId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(identity.startIdentity).toMatch(/^\d+:\d+$/);
      expect(first.stderr).toBe("");
      expect(first.stdout).not.toContain("fixture-environment-must-not-escape");
      expect(Object.keys(identity).sort()).toEqual([
        "argumentsSha256",
        "bootId",
        "executable",
        "parentPid",
        "pid",
        "startIdentity",
        "uid",
      ]);
      const { root } = fixture();
      const helperPath = path.join(root, "inspector.py");
      const bytes = readFileSync(script);
      writeFileSync(helperPath, bytes, { mode: 0o600 });
      const options = {
        helperPath,
        helperSha256: createHash("sha256").update(bytes).digest("hex"),
        writableMountRoots: [],
      };
      await expect(
        createNativeBootstrapServiceReader({ ...options, helperSha256: "f".repeat(64) }),
      ).rejects.toThrow("bytes changed");
      await expect(
        createNativeBootstrapServiceReader({ ...options, writableMountRoots: [root] }),
      ).rejects.toThrow("mount");
      const reader = await createNativeBootstrapServiceReader(options);
      const audited = await reader.inspectAuditedProcess(child.pid!);
      expect(audited.identity).toEqual(identity);
      expect(audited.auditToken).toHaveLength(8);
      expect(await reader.inspectAuditedProcess(child.pid!)).toEqual(audited);
      writeFileSync(helperPath, 'raise RuntimeError("unreviewed replacement")');
      expect(await reader.inspectProcess(child.pid!)).toEqual(identity);
      expect(await reader.inspectRunningProcess(child.pid!)).toEqual({
        ...identity,
        stopped: false,
      });
      await expect(reader.verifyProcessExited(child.pid!)).rejects.toThrow();
      await expect(reader.inspectStoppedProcess(child.pid!)).rejects.toThrow();
      child.kill("SIGSTOP");
      await expect
        .poll(async () => {
          try {
            return await reader.inspectStoppedProcess(child.pid!);
          } catch {
            return null;
          }
        })
        .toEqual({ ...identity, stopped: true, childPids: [] });
      child.kill("SIGCONT");
      await expect(
        reader.readService("gui/999999/local.vorteo.fixture.installation"),
      ).rejects.toThrow("another Host account");
    } finally {
      child.kill("SIGCONT");
      child.kill();
      await closed;
    }
    await expect(inspect()).rejects.toThrow();
    const exited = await execute("/usr/bin/python3", [
      script,
      String(child.pid),
      "--require-exited",
    ]);
    expect(JSON.parse(exited.stdout)).toEqual({ pid: child.pid, exited: true });
  },
);

test.runIf(process.platform === "darwin")(
  "stopped inspection refuses running parents and captures their exact child inventory",
  async () => {
    const execute = promisify(execFile);
    const script = path.resolve("../../scripts/inspect-coordinator-process.py");
    // This fixture owns both processes. No installed service receives signals.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `
      const {spawn}=require('node:child_process');
      const child=spawn('/bin/sleep',['30'],{stdio:'ignore'});
      child.once('spawn',()=>process.stdout.write(String(child.pid)+'\\n'));
      process.on('SIGTERM',()=>{child.kill();child.once('close',()=>process.exit(0));});
      setInterval(()=>{},1000);
    `,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const closed = once(parent, "close");
    const [data] = await once(parent.stdout!, "data");
    const childPid = Number(String(data).trim());
    const inspect = () =>
      execute("/usr/bin/python3", [script, String(parent.pid), "--require-stopped"], {
        timeout: 5000,
      });
    try {
      expect(childPid).toBeGreaterThan(0);
      await expect(inspect()).rejects.toThrow();
      parent.kill("SIGSTOP");
      await expect
        .poll(async () => {
          try {
            return JSON.parse((await inspect()).stdout);
          } catch {
            return null;
          }
        })
        .toMatchObject({ pid: parent.pid, stopped: true, childPids: [childPid] });
      parent.kill("SIGCONT");
      await expect
        .poll(async () => {
          try {
            await inspect();
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
    } finally {
      parent.kill("SIGCONT");
      parent.kill("SIGTERM");
      await closed;
    }
  },
);

test("bootstrap mount evidence distinguishes Host binds from verified local VM volumes", () => {
  const containerId = "a".repeat(64);
  const container = {
    Id: containerId,
    State: { Running: true },
    Mounts: [
      { Type: "bind", Source: "/private/guest", RW: true },
      { Type: "bind", Source: "/private/read-only", RW: false },
      { Type: "volume", Name: "state", RW: true },
      { Type: "tmpfs", RW: true },
    ],
  };
  const volumes = [{ Name: "state", Driver: "local", Scope: "local", Options: null }];
  expect(bootstrapWritableMountRoots({ container, containerId, volumes })).toEqual([
    "/private/guest",
  ]);
  expect(() =>
    bootstrapWritableMountRoots({ container, containerId: "b".repeat(64), volumes }),
  ).toThrow("identity changed");
  expect(() => bootstrapWritableMountRoots({ container, containerId, volumes: [] })).toThrow(
    "missing or ambiguous",
  );
  expect(() =>
    bootstrapWritableMountRoots({ container, containerId, volumes: [...volumes, ...volumes] }),
  ).toThrow("missing or ambiguous");
  expect(() =>
    bootstrapWritableMountRoots({
      container,
      containerId,
      volumes: [{ ...volumes[0], Options: { type: "none", o: "bind", device: "/private" } }],
    }),
  ).toThrow("driver options");
});

test("bootstrap mount evidence fails closed on incomplete or unsupported Docker output", () => {
  const containerId = "a".repeat(64);
  const base = { Id: containerId, State: { Running: true } };
  for (const container of [
    base,
    { ...base, State: { Running: false }, Mounts: [] },
    { ...base, Mounts: [{ Type: "bind", Source: "/private" }] },
    { ...base, Mounts: [{ Type: "bind", Source: "relative", RW: true }] },
    { ...base, Mounts: [{ Type: "unknown", RW: true }] },
  ]) {
    expect(() => bootstrapWritableMountRoots({ container, containerId, volumes: [] })).toThrow();
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bootstrap-host-")));
  roots.push(root);
  const file = path.join(root, "coordinator.json");
  const installationId = randomUUID();
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const config = {
    public: {
      version: 1,
      installationId,
      origin: "https://installation.example.test",
      environments: [
        { kind: "host", serverId: "host-id", endpoint: "127.0.0.1:6768", useTls: false },
        { kind: "container", serverId: "dev-id", endpoint: "127.0.0.1:6769", useTls: false },
      ],
    },
    ownerPasswordHash: hashSync("fixture-password", 4),
    hostAgentTokenHash: "a".repeat(64),
    containerAgentTokenHash: "b".repeat(64),
    listenPort: 6766,
    webDistDir: path.join(root, "web"),
    stateDir,
    host: {
      launchdService: `gui/${process.getuid!()}/local.vorteo.${installationId}.host`,
      endpoint: "127.0.0.1:6768",
      password: "host-fixture",
    },
    container: { endpoint: "127.0.0.1:6769", password: "dev-fixture" },
  };
  const save = () => writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  save();
  return { root, file, config, save };
}

test("bootstrap configuration preserves credentials, service targets and state with exact policy", async () => {
  const f = fixture();
  const previousFile = path.join(f.root, "previous.json");
  const candidateFile = path.join(f.root, "candidate.json");
  const save = (file: string, value: unknown) =>
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  save(previousFile, f.config);
  save(candidateFile, f.config);
  const file = { path: f.file, sha256: "a".repeat(64) };
  const release = {
    directory: f.root,
    sourceCommit: "a".repeat(40),
    artifactSha256: "a".repeat(64),
    node: file,
    entrypoint: file,
    launcher: file,
    configuration: file,
  };
  const plan = CoordinatorBootstrapPlanSchema.parse({
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: f.config.public.installationId,
    service: f.config.host.launchdService.replace(/\.host$/, ".installation"),
    expectedProcess: {
      pid: 1,
      bootId: "fixture",
      startIdentity: "fixture",
      argumentsSha256: "a".repeat(64),
    },
    previous: { ...release, configuration: { ...file, path: previousFile } },
    candidate: { ...release, configuration: { ...file, path: candidateFile } },
    state: {
      directory: f.config.stateDir,
      restartJournal: path.join(f.config.stateDir, "restart-jobs.json"),
      ownerSessions: path.join(f.config.stateDir, "owner-sessions.json"),
    },
    hostRequestsAfter: null,
  });
  await expect(
    verifyBootstrapPlan(plan, {
      daemonId: "dev-id",
      configurationFile: f.file,
      launcherFile: "/nonexistent/launcher",
      docker: "/nonexistent/docker",
      socket: "/nonexistent/socket",
      containerId: "a".repeat(64),
      helperPath: "/nonexistent/helper",
      helperSha256: "a".repeat(64),
    }),
  ).rejects.toThrow("configured Host");
  const verify = () =>
    verifyBootstrapConfiguration({ plan, configurationFile: f.file, daemonId: "host-id" });
  expect(verify).not.toThrow();
  const helper = {
    home: f.root,
    docker: "/usr/local/bin/docker",
    socket: "/private/docker.sock",
    containerId: "a".repeat(64),
  };
  save(candidateFile, { ...f.config, nativeHelper: helper });
  expect(verify).toThrow("outside its approved policy");
  plan.nativeHelperConfiguration = helper;
  expect(verify).not.toThrow();
  await expect(
    verifyBootstrapPlan(plan, {
      daemonId: "host-id",
      configurationFile: f.file,
      launcherFile: "/nonexistent/launcher",
      docker: helper.docker,
      socket: helper.socket,
      containerId: "b".repeat(64),
      helperPath: "/nonexistent/helper",
      helperSha256: "a".repeat(64),
    }),
  ).rejects.toThrow("paired Host Docker identity");
  save(candidateFile, { ...f.config, nativeHelper: { ...helper, home: "/different" } });
  expect(verify).toThrow("outside its approved policy");
  plan.nativeHelperConfiguration = null;
  save(candidateFile, f.config);
  expect(verify).not.toThrow();
  delete plan.nativeHelperConfiguration;
  const adoption = {
    node: "/private/host/node",
    script: "/private/host/adopt.mjs",
    sha256: "d".repeat(64),
  };
  save(candidateFile, {
    ...f.config,
    container: { ...f.config.container, factoryRuntimeAdoption: adoption },
  });
  expect(verify).toThrow("outside its approved policy");
  plan.factoryRuntimeAdoptionConfiguration = adoption;
  expect(verify).not.toThrow();
  save(candidateFile, {
    ...f.config,
    container: {
      ...f.config.container,
      factoryRuntimeAdoption: { ...adoption, sha256: "e".repeat(64) },
    },
  });
  expect(verify).toThrow("outside its approved policy");
  plan.factoryRuntimeAdoptionConfiguration = null;
  save(candidateFile, f.config);
  expect(verify).not.toThrow();
  delete plan.factoryRuntimeAdoptionConfiguration;

  const policy = { hostRequestsAfter: "2026-10-09T00:00:00.000Z" };
  save(candidateFile, { ...f.config, restartApprovalPolicy: policy });
  expect(verify).toThrow("outside its approved policy");
  plan.hostRequestsAfter = policy.hostRequestsAfter;
  expect(verify).not.toThrow();
  save(candidateFile, {
    ...f.config,
    restartApprovalPolicy: policy,
    container: { ...f.config.container, password: "changed" },
  });
  expect(verify).toThrow("outside its approved policy");
  save(candidateFile, { ...f.config, restartApprovalPolicy: policy });
  plan.state.ownerSessions = path.join(f.root, "other-sessions.json");
  expect(verify).toThrow("state paths changed");
  plan.state.ownerSessions = path.join(f.config.stateDir, "owner-sessions.json");
  f.config.host.password = "new-host-password";
  f.save();
  expect(verify).toThrow("no longer matches");
});

test("bootstrap binding pins Host daemon and service, and observes owner credential changes", () => {
  const f = fixture();
  const context = readBootstrapHostBinding(f.file, "host-id");
  expect(context.binding.installationId).toBe(f.config.public.installationId);
  expect(context.binding.service).toBe(
    f.config.host.launchdService.replace(/\.host$/, ".installation"),
  );
  expect(context.stateDirectory).toBe(f.config.stateDir);
  expect(() => readBootstrapHostBinding(f.file, "dev-id")).toThrow("configured Host");
  f.config.ownerPasswordHash = hashSync("changed-password", 4);
  f.save();
  expect(readBootstrapHostBinding(f.file, "host-id").binding.ownerPasswordHash).not.toBe(
    context.binding.ownerPasswordHash,
  );
  f.config.host.launchdService = "gui/501/local.vorteo.other.host";
  f.save();
  expect(() => readBootstrapHostBinding(f.file, "host-id")).toThrow("service identity");
});

test("bootstrap binding rejects exposed or aliased configuration and invalid owner authentication", () => {
  const f = fixture();
  const alias = path.join(f.root, "alias.json");
  symlinkSync(f.file, alias);
  expect(() => readBootstrapHostBinding(alias, "host-id")).toThrow("canonical");
  chmodSync(f.file, 0o644);
  expect(() => readBootstrapHostBinding(f.file, "host-id")).toThrow("private owned file");
  chmodSync(f.file, 0o600);
  chmodSync(f.root, 0o755);
  expect(() => readBootstrapHostBinding(f.file, "host-id")).toThrow("private Host directory");
  chmodSync(f.root, 0o700);
  chmodSync(f.config.stateDir, 0o755);
  expect(() => readBootstrapHostBinding(f.file, "host-id")).toThrow("private Host directory");
  chmodSync(f.config.stateDir, 0o700);
  f.config.ownerPasswordHash = "";
  f.save();
  expect(() => readBootstrapHostBinding(f.file, "host-id")).toThrow();
});

test.runIf(process.platform === "darwin")(
  "complete admission verifies prepared releases and rejects changes during collection",
  async () => {
    const f = fixture();
    const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
    const save = (file: string, value: unknown) => {
      const bytes = JSON.stringify(value);
      writeFileSync(file, bytes, { mode: 0o600 });
      return { path: file, sha256: hash(bytes) };
    };
    const node = path.join(f.root, "node");
    writeFileSync(node, "fixture executable", { mode: 0o700 });
    const service = f.config.host.launchdService.replace(/\.host$/, ".installation");
    const makeRelease = async (name: string, configurationFile: string) => {
      const directory = path.join(f.root, name);
      mkdirSync(directory, { mode: 0o700 });
      const entrypoint = path.join(directory, "entry.js");
      writeFileSync(entrypoint, "export {};", { mode: 0o600 });
      save(path.join(directory, ".installation-source.json"), { sourceCommit: "a".repeat(40) });
      const configuration = save(path.join(f.root, name + ".json"), f.config);
      const launcher = save(path.join(f.root, name + ".plist"), {
        Label: service.split("/").slice(2).join("/"),
        ProgramArguments: [node, entrypoint, configurationFile || configuration.path],
        KeepAlive: true,
      });
      return {
        directory,
        sourceCommit: "a".repeat(40),
        artifactSha256: await digestBootstrapArtifact(directory),
        node: { path: node, sha256: hash("fixture executable") },
        entrypoint: { path: entrypoint, sha256: hash("export {};") },
        configuration,
        launcher,
      };
    };
    const previous = await makeRelease("previous", f.file);
    const candidate = await makeRelease("candidate", "");
    const expectedProcess = {
      pid: 123,
      bootId: randomUUID(),
      startIdentity: "1234:5678",
      argumentsSha256: hash(JSON.stringify([node, previous.entrypoint.path, f.file])),
    };
    const plan = CoordinatorBootstrapPlanSchema.parse({
      version: 1,
      operation: "coordinator-bootstrap",
      installationId: f.config.public.installationId,
      service,
      expectedProcess,
      previous,
      candidate,
      hostRequestsAfter: null,
      state: {
        directory: f.config.stateDir,
        restartJournal: path.join(f.config.stateDir, "restart-jobs.json"),
        ownerSessions: path.join(f.config.stateDir, "owner-sessions.json"),
      },
    });
    const docker = path.join(f.root, "docker-fixture");
    const mounts = path.join(f.root, "mounts.json");
    save(mounts, { Id: "a".repeat(64), State: { Running: true }, Mounts: [] });
    writeFileSync(docker, '#!/bin/sh\nexec /bin/cat "' + mounts + '"\n', { mode: 0o700 });
    const host = {
      daemonId: "host-id",
      configurationFile: f.file,
      launcherFile: previous.launcher.path,
      docker,
      socket: path.join(f.root, "fixture.sock"),
      containerId: "a".repeat(64),
      helperPath: path.join(f.root, "unused-inspector"),
      helperSha256: "a".repeat(64),
    };
    let duringInspection = () => {};
    const inspectProcess = vi.fn(async () => {
      duringInspection();
      return { ...expectedProcess, parentPid: 1, uid: process.getuid!(), executable: node };
    });
    vi.spyOn(serviceCollector, "createNativeBootstrapServiceReader").mockResolvedValue({
      readService: async () => `${service} = {\n\tpid = 123\n}`,
      inspectProcess,
    });
    await expect(verifyBootstrapPlan(plan, host)).resolves.toBeUndefined();
    expect(inspectProcess).toHaveBeenCalledTimes(4);
    writeFileSync(host.helperPath, "fixture helper", { mode: 0o600 });
    writeFileSync(host.socket, "fixture endpoint", { mode: 0o600 });
    const { daemonId, ...setup } = host;
    const setupFile = path.join(f.root, "bootstrap-setup.json");
    save(setupFile, setup);
    const review = await createBootstrapReviewService(setupFile, daemonId);
    expect(review.list()).toEqual([]);
    const request = await review.prepare({ id: randomUUID(), reason: "fixture bootstrap", plan });
    expect(request.status).toBe("pending");
    expect(review.list()).toHaveLength(1);
    save(setupFile, { ...setup, containerId: "b".repeat(64) });
    expect(() => review.list()).toThrow("setup changed");
    save(setupFile, setup);
    chmodSync(setupFile, 0o644);
    await expect(createBootstrapReviewService(setupFile, daemonId)).rejects.toThrow(
      "private owned file",
    );
    chmodSync(setupFile, 0o600);
    await expect(createBootstrapReviewService(setupFile, "dev-id")).rejects.toThrow(
      "configured Host",
    );

    duringInspection = () => writeFileSync(candidate.entrypoint.path, "changed runtime");
    await expect(verifyBootstrapPlan(plan, host)).rejects.toThrow("digest changed");
    writeFileSync(candidate.entrypoint.path, "export {};");
    duringInspection = () =>
      save(mounts, {
        Id: host.containerId,
        State: { Running: true },
        Mounts: [{ Type: "bind", Source: f.root, RW: true }],
      });
    await expect(verifyBootstrapPlan(plan, host)).rejects.toThrow("mounts changed");
    const selectedLauncher = path.join(f.root, "selected.plist");
    const previousBytes = readFileSync(previous.launcher.path);
    writeFileSync(selectedLauncher, previousBytes, { mode: 0o600 });
    const selection = {
      plan,
      launcherFile: selectedLauncher,
      configurationFile: f.file,
      writableMountRoots: [],
      authorizeSelection: async () => {},
    };
    await expect(
      selectBootstrapLauncher({ ...selection, launcherFile: previous.launcher.path }),
    ).rejects.toThrow("rollback");
    await expect(
      selectBootstrapLauncher({
        ...selection,
        authorizeSelection: async () => {
          throw new Error("Approval changed");
        },
      }),
    ).rejects.toThrow("Approval changed");
    expect(readFileSync(selectedLauncher)).toEqual(previousBytes);
    await selectBootstrapLauncher(selection);
    expect(readFileSync(selectedLauncher)).toEqual(readFileSync(candidate.launcher.path));
    expect(readFileSync(previous.launcher.path)).toEqual(previousBytes);
    await expect(selectBootstrapLauncher(selection)).rejects.toThrow("digest changed");
    writeFileSync(selectedLauncher, previousBytes);
    duringInspection = () => {};
    save(mounts, { Id: host.containerId, State: { Running: true }, Mounts: [] });
    const approved = await review.decide(
      {
        id: request.id,
        revision: request.revision,
        planSha256: request.planSha256,
        decision: "approve",
      },
      "fixture-password",
    );
    let executing = await review.claimDispatch({
      id: approved.id,
      revision: approved.revision,
      planSha256: approved.planSha256,
    });
    const advance = (
      stage:
        | "freeze_pending"
        | "frozen"
        | "unload_pending"
        | "unloaded"
        | "selection_pending"
        | "selected"
        | "start_pending",
    ) => {
      executing = review.advanceDispatch(
        {
          id: executing.id,
          revision: executing.revision,
          planSha256: executing.planSha256,
          generation: executing.execution!.generation,
        },
        stage,
      );
    };
    for (const stage of [
      "freeze_pending",
      "frozen",
      "unload_pending",
      "unloaded",
      "selection_pending",
    ] as const)
      advance(stage);
    const commands: string[][] = [];
    const processIdentity = {
      ...expectedProcess,
      parentPid: 1,
      uid: process.getuid!(),
      executable: node,
    };
    const reader = {
      readService: async () => `${service} = {\n\tpid = 123\n}`,
      inspectProcess: async () => processIdentity,
      inspectAuditedProcess: async () => {
        throw new Error("Audit inspection is outside this fixture");
      },
      inspectStoppedProcess: async () => ({
        ...processIdentity,
        stopped: true as const,
        childPids: [],
      }),
      inspectRunningProcess: async () => ({ ...processIdentity, stopped: false as const }),
      verifyProcessExited: async () => {},
      verifyServiceAbsent: async () => {},
    };
    const actions = createBootstrapNativeLifecycle(
      {
        requests: review,
        reader,
        configurationFile: f.file,
        launcherFile: selectedLauncher,
        writableMountRoots: async () => [],
        readHealth: async () => {
          throw new Error("Unexpected fixture health read");
        },
        requireOwnership: async () => {},
      },
      {
        run: async (args) => {
          commands.push([...args]);
        },
      },
    );
    await actions.select(executing);
    advance("selected");
    advance("start_pending");
    writeFileSync(candidate.entrypoint.path, "changed after selection");
    await expect(actions.start(executing)).rejects.toThrow("digest changed");
    expect(commands).toEqual([]);
    writeFileSync(candidate.entrypoint.path, "export {};");
    await actions.start(executing);
    expect(commands).toEqual([["bootstrap", `gui/${process.getuid!()}`, selectedLauncher]]);
  },
);

test.runIf(process.platform === "darwin")(
  "native ownership survives exec and releases on fixture process death",
  async () => {
    const { root } = fixture();
    const entry = path.join(root, "owner.mjs");
    const setup = path.join(root, "setup.json");
    const lock = path.join(root, "coordinator-bootstrap-execution.lock");
    const verifierPath = realpathSync(path.resolve("../../scripts/verify-coordinator-owner.py"));
    const verifier = {
      path: verifierPath,
      sha256: createHash("sha256").update(readFileSync(verifierPath)).digest("hex"),
    };
    writeFileSync(setup, "{}", { mode: 0o600 });
    writeFileSync(
      entry,
      `import fs from 'node:fs';
    import {spawnSync} from 'node:child_process';
    const fd=Number(process.env.VORTEO_BOOTSTRAP_LOCK_FD);
    if(!Number.isInteger(fd)||!fs.fstatSync(fd).isFile())process.exit(2);
    const verified=spawnSync('/usr/bin/python3',['-I','-B',${JSON.stringify(verifierPath)},${JSON.stringify(lock)}],{stdio:['ignore','ignore','pipe',fd]});
    if(verified.status!==0)process.exit(3);
    process.stdout.write('owned\\n');
    process.stdin.resume();
    process.stdin.on('end',()=>process.exit(0));`,
      { mode: 0o600 },
    );
    const helper = path.resolve("../../scripts/run-coordinator-owner.py");
    const launch = (role = "executor") =>
      spawn(
        "/usr/bin/python3",
        [helper, lock, realpathSync(process.execPath), entry, setup, role, randomUUID()],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    const first = launch();
    const firstClosed = once(first, "close");
    await once(first.stdout!, "data");
    try {
      const probe = await promisify(execFile)("/usr/bin/python3", [
        "-c",
        `
import fcntl,os,sys
fd=os.open(sys.argv[1],os.O_RDWR)
try:
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    print("unlocked")
except BlockingIOError:
    print("locked")
finally:
    os.close(fd)
`,
        lock,
      ]);
      expect(probe.stdout.trim()).toBe("locked");
      const unowned = openSync(lock, "r+");
      try {
        await expect(
          requireBootstrapOwnership({
            descriptor: unowned,
            lockFile: lock,
            verifier,
            writableMountRoots: [],
          }),
        ).rejects.toThrow("kernel ownership");
      } finally {
        closeSync(unowned);
      }
    } catch (error) {
      first.kill("SIGKILL");
      await firstClosed;
      throw error;
    }
    const second = launch("watchdog");
    const secondClosed = once(second, "close");
    await waitForBootstrapWatchdog(second);
    const secondReady = once(second.stdout!, "data");
    let secondOwned = false;
    void secondReady.then(() => {
      secondOwned = true;
      return undefined;
    });
    try {
      // A kernel query provides a scheduling opportunity without treating a
      // timeout as process death or using a production service as a fixture.
      await promisify(execFile)("/bin/ps", ["-p", String(second.pid), "-o", "pid="]);
      expect(secondOwned).toBe(false);
      first.kill("SIGKILL");
      await firstClosed;
      const [ready] = await secondReady;
      expect(String(ready)).toBe("owned\n");
      second.stdin!.end();
      const [code] = await secondClosed;
      expect(code).toBe(0);
      const unlocked = openSync(lock, "r+");
      try {
        await expect(
          requireBootstrapOwnership({
            descriptor: unlocked,
            lockFile: lock,
            verifier,
            writableMountRoots: [],
          }),
        ).rejects.toThrow("kernel ownership");
        await expect(
          requireBootstrapOwnership({
            descriptor: unlocked,
            lockFile: lock,
            verifier: { ...verifier, sha256: "0".repeat(64) },
            writableMountRoots: [],
          }),
        ).rejects.toThrow("digest changed");
      } finally {
        closeSync(unlocked);
      }
    } finally {
      first.kill("SIGKILL");
      second.kill("SIGKILL");
      await Promise.all([firstClosed, secondClosed]);
    }
  },
);

test("bootstrap readiness uses its local endpoint and refuses redirects and oversized bodies", async () => {
  let status = 200;
  let body = JSON.stringify({ installationId: randomUUID() });
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url!);
    response.writeHead(status, {
      "Content-Type": "application/json",
      Location: "/redirect-target",
    });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    await expect(readBootstrapHealth(address.port)).resolves.toEqual(JSON.parse(body));
    status = 302;
    await expect(readBootstrapHealth(address.port)).rejects.toThrow();
    status = 503;
    await expect(readBootstrapHealth(address.port)).rejects.toThrow("unavailable");
    status = 200;
    body = "x".repeat(16 * 1024 + 1);
    await expect(readBootstrapHealth(address.port)).rejects.toThrow("too large");
    body = "invalid-json";
    await expect(readBootstrapHealth(address.port)).rejects.toThrow();
    expect(paths).toEqual(Array(5).fill("/api/installation/health"));
    await expect(readBootstrapHealth(80)).rejects.toThrow("Invalid");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
  }
});

test.each([
  ["process.stdout.write('waiting\\n'); process.stdin.resume();", true, "watchdog"],
  ["process.stdout.write('invalid-handshake'); process.stdin.resume();", false, "watchdog"],
  ["process.exit(1)", false, "watchdog"],
  ["process.stdout.write('dispatched\\n'); process.stdin.resume();", true, "executor"],
  ["process.stdout.write('waiting\\n'); process.stdout.end();", false, "executor"],
] as const)(
  "watchdog readiness observes the bounded child handshake: %s",
  async (code, ready, role) => {
    const child = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "ignore"] });
    const closed = once(child, "close");
    try {
      const result = waitForBootstrapWatchdog(child, role);
      if (ready) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow("did not become ready");
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  },
);

test("bootstrap review stays unavailable without setup and rejects a different daemon binding", async () => {
  await expect(createManagedBootstrapReview(undefined, "host-id")).resolves.toBeUndefined();
  const { root } = fixture();
  const setup = path.join(root, "runner.json");
  const file = { path: path.join(root, "not-executed"), sha256: "a".repeat(64) };
  writeFileSync(
    setup,
    JSON.stringify({
      admissionSetupFile: path.join(root, "not-read.json"),
      daemonId: "different-daemon",
      node: file,
      entrypoint: file,
      ownerLauncher: file,
      ownershipVerifier: file,
      runtimeDirectory: root,
      runtimeSha256: "b".repeat(64),
    }),
    { mode: 0o600 },
  );
  await expect(createManagedBootstrapReview(setup, "host-id")).rejects.toThrow(
    process.platform === "darwin" ? "another daemon" : "Native Host",
  );
});

test.runIf(process.platform === "darwin")(
  "bootstrap discovery uses only the private Host client sibling",
  async () => {
    const { root } = fixture();
    const client = path.join(root, "client.json");
    const environment = { VORTEO_INSTALLATION_CLIENT_CONFIG: client };
    writeFileSync(client, JSON.stringify({ kind: "host-agent" }), { mode: 0o600 });
    await expect(createConfiguredBootstrapReview("host-id", environment)).resolves.toBeUndefined();
    const setup = path.join(root, "coordinator-bootstrap-runner.json");
    writeFileSync(setup, "{}", { mode: 0o600 });
    await expect(createConfiguredBootstrapReview("host-id", environment)).rejects.toThrow();
    writeFileSync(client, JSON.stringify({ kind: "container-agent" }));
    await expect(createConfiguredBootstrapReview("host-id", environment)).resolves.toBeUndefined();
    writeFileSync(client, JSON.stringify({ kind: "host-agent" }));
    chmodSync(client, 0o644);
    await expect(createConfiguredBootstrapReview("host-id", environment)).rejects.toThrow();
  },
);

test("executor acknowledgement allows artifact verification beyond one minute", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdin.on('data', () => process.stdout.write('dispatched\\n'))"],
    {
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const closed = once(child, "close");
  vi.useFakeTimers();
  try {
    const result = waitForBootstrapWatchdog(child, "executor");
    let settled = false;
    void result.then(
      () => {
        settled = true;
        return settled;
      },
      () => {
        settled = true;
        return settled;
      },
    );
    await vi.advanceTimersByTimeAsync(61_000);
    expect(settled).toBe(false);
    vi.useRealTimers();
    child.stdin!.write("ready");
    await expect(result).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
    child.kill("SIGKILL");
    await closed;
  }
});

test.runIf(process.platform === "darwin").each(["term", "kill", "stale"])(
  "automatic watchdog fences only the bound updater and waits for lock release: %s",
  async (mode) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bootstrap-deadline-")));
    roots.push(root);
    const helper = path.resolve("../../scripts/run-coordinator-owner.py");
    const inspector = path.resolve("../../scripts/inspect-coordinator-process.py");
    const probe = `
import ctypes,importlib.util,os,signal,subprocess,sys

def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path)
 module=importlib.util.module_from_spec(spec)
 spec.loader.exec_module(module)
 return module
owner=load('owner',sys.argv[1]); inspector=load('inspector',sys.argv[2])
mode=sys.argv[3]; lock=sys.argv[4]
source="import fcntl,signal,sys,time; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); "
if mode=='kill': source+="signal.signal(signal.SIGTERM,signal.SIG_IGN); "
source+="print('ready',flush=True); time.sleep(30)"
child=subprocess.Popen([sys.executable,'-c',source,lock],stdout=subprocess.PIPE,text=True)
try:
 assert child.stdout.readline().strip()=='ready'
 library=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
 token=inspector.audit_token(library,child.pid)
 if mode=='stale': token[7]=(token[7]+1)&0xffffffff
 with open(lock) as descriptor:
  if mode=='stale':
   try: owner.wait_for_executor(descriptor,token,timeout=0.05,grace=0.05)
   except ValueError: pass
   else: raise AssertionError('stale identity acquired ownership')
   assert child.poll() is None
  else:
   owner.wait_for_executor(descriptor,token,timeout=0.05,grace=0.05)
   assert child.wait(timeout=2)==(-signal.SIGKILL if mode=='kill' else -signal.SIGTERM)
 print('verified')
finally:
 if child.poll() is None: child.kill()
 child.wait(timeout=2)
`;
    const result = await promisify(execFile)(
      "/usr/bin/python3",
      ["-I", "-B", "-c", probe, helper, inspector, mode, path.join(root, "lock")],
      { timeout: 10000 },
    );
    expect(result.stdout.trim()).toBe("verified");
  },
);
