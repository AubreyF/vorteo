import { bootstrapReviewFeatures } from "./coordinator-bootstrap-session.js";
import { coordinatorAutomaticAuthority, DaemonAutomation } from "./daemon-automation.js";
import { InstallationConfigSchema } from "./config.js";
import {
  createManagedBootstrapReview,
  createConfiguredBootstrapReview,
  deferBootstrapReview,
  refreshBootstrapReviewAfterClaimedRecovery,
} from "./coordinator-bootstrap-launch.js";
import type { BootstrapReviewService } from "./coordinator-bootstrap-session.js";
import { afterEach, test, expect, vi } from "vitest";
import nativeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { CoordinatorBootstrapRequestSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  openSync,
  closeSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  chmodSync,
  linkSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { waitForBootstrapWatchdog } from "./coordinator-bootstrap-runner.js";
import { readBootstrapHealth } from "./coordinator-bootstrap-runtime.js";

import { promisify } from "node:util";
import { hashSync } from "bcryptjs";
import {
  readBootstrapHostBinding,
  createBootstrapReconciliationLedger,
  bootstrapWritableMountRoots,
  verifyBootstrapConfiguration,
  verifyBootstrapPlan,
  createBootstrapReviewService,
} from "./coordinator-bootstrap-host.js";
import { CoordinatorBootstrapPlanSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  createNativeBootstrapServiceReader,
  inspectBootstrapPythonExecutable,
  readBootstrapLauncher,
  verifyRetainedProcessExited,
} from "./coordinator-bootstrap-service.js";

import * as serviceCollector from "./coordinator-bootstrap-service.js";
import * as claimedSuccessor from "./coordinator-bootstrap-claimed-successor.js";
import { FileClaimedRecoveryReviewJournal } from "./coordinator-bootstrap-claimed-journal.js";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";

import { createBootstrapNativeLifecycle } from "./coordinator-bootstrap-native.js";
import { CoordinatorBootstrapRequests, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import { recoverAbandonedBootstrap } from "./coordinator-bootstrap-watchdog.js";
import { preserveBootstrapState, verifyBootstrapState } from "./coordinator-bootstrap-state.js";
import { requireBootstrapOwnership } from "./coordinator-bootstrap-ownership.js";
import {
  selectBootstrapLauncher,
  restoreBootstrapLauncher,
} from "./coordinator-bootstrap-selection.js";

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
    const prepared = {
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
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
    const invalidFile = {
      path: file,
      sha256: createHash("sha256").update(invalid).digest("hex"),
    };
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
      env: {
        VORTEO_INSPECTION_SENTINEL: "fixture-environment-must-not-escape",
      },
      stdio: "ignore",
    });
    const closed = once(child, "close");
    await once(child, "spawn");
    const execute = promisify(execFile);
    const script = path.resolve(
      import.meta.dirname,
      "../../../../../scripts/inspect-coordinator-process.py",
    );
    const inspect = () =>
      execute("/usr/bin/python3", [script, String(child.pid)], {
        timeout: 5000,
      });
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
        createNativeBootstrapServiceReader({
          ...options,
          helperSha256: "f".repeat(64),
        }),
      ).rejects.toThrow("bytes changed");
      await expect(
        createNativeBootstrapServiceReader({
          ...options,
          writableMountRoots: [root],
        }),
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
      await expect(verifyRetainedProcessExited(reader, identity)).rejects.toThrow("unproven");
      // Synthetic retained birth; both current observations use the native helper.
      const [seconds, micros] = identity.startIdentity.split(":");
      await verifyRetainedProcessExited(reader, {
        ...identity,
        startIdentity: `${BigInt(seconds) - 1n}:${micros}`,
      });
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
  "startup inspection accepts scoped recovery labels and the native Python executable",
  async () => {
    const { root } = fixture();
    const helperPath = path.join(root, "inspector.py");
    const bytes = readFileSync(
      new URL("../../../../../scripts/inspect-coordinator-process.py", import.meta.url),
    );
    writeFileSync(helperPath, bytes, { mode: 0o600 });
    const reader = await createNativeBootstrapServiceReader({
      helperPath,
      helperSha256: createHash("sha256").update(bytes).digest("hex"),
      writableMountRoots: [],
    });
    const service = `gui/${process.getuid!()}/local.vorteo.fixture.installation-recovery-${randomUUID()}`;
    await reader.verifyServiceAbsent(service);
    await expect(reader.readService(service)).rejects.toMatchObject({ code: 113 });
    await expect(reader.verifyServiceAbsent(`${service}-other`)).rejects.toThrow();
    await expect(
      reader.verifyServiceAbsent(service.replace(`gui/${process.getuid!()}/`, "gui/999999/")),
    ).rejects.toThrow("another Host account");
    const executable = await inspectBootstrapPythonExecutable();
    const probe = path.join(root, "probe.py");
    writeFileSync(probe, "import time; print('ready',flush=True); time.sleep(30)", { mode: 0o600 });
    const args = ["-I", "-B", probe];
    const child = spawn("/usr/bin/python3", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin" },
    });
    const closed = once(child, "close");
    try {
      await once(child.stdout!, "data");
      const observed = await reader.inspectProcess(child.pid!);
      expect(observed).toMatchObject({
        pid: child.pid,
        executable,
        argumentsSha256: createHash("sha256")
          .update(JSON.stringify([executable, ...args]))
          .digest("hex"),
      });
    } finally {
      child.kill();
      await closed;
    }
  },
);

test.runIf(process.platform === "darwin")(
  "stopped inspection refuses running parents and captures their exact child inventory",
  async () => {
    const execute = promisify(execFile);
    const script = path.resolve(
      import.meta.dirname,
      "../../../../../scripts/inspect-coordinator-process.py",
    );
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
        .toMatchObject({
          pid: parent.pid,
          stopped: true,
          childPids: [childPid],
        });
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
    bootstrapWritableMountRoots({
      container,
      containerId: "b".repeat(64),
      volumes,
    }),
  ).toThrow("identity changed");
  expect(() => bootstrapWritableMountRoots({ container, containerId, volumes: [] })).toThrow(
    "missing or ambiguous",
  );
  expect(() =>
    bootstrapWritableMountRoots({
      container,
      containerId,
      volumes: [...volumes, ...volumes],
    }),
  ).toThrow("missing or ambiguous");
  expect(() =>
    bootstrapWritableMountRoots({
      container,
      containerId,
      volumes: [
        {
          ...volumes[0],
          Options: { type: "none", o: "bind", device: "/private" },
        },
      ],
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
        {
          kind: "host",
          serverId: "host-id",
          endpoint: "127.0.0.1:6768",
          useTls: false,
        },
        {
          kind: "container",
          serverId: "dev-id",
          endpoint: "127.0.0.1:6769",
          useTls: false,
        },
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
    verifyBootstrapConfiguration({
      plan,
      configurationFile: f.file,
      daemonId: "host-id",
    });
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
  save(candidateFile, {
    ...f.config,
    nativeHelper: { ...helper, home: "/different" },
  });
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
  // Host-owned Claude refresh changes only through its own reviewed field.
  save(candidateFile, { ...f.config, claudeHostRefresh: true });
  expect(verify).toThrow("outside its approved policy");
  plan.claudeHostRefreshConfiguration = true;
  expect(verify).not.toThrow();
  save(candidateFile, { ...f.config, claudeHostRefresh: false });
  expect(verify).toThrow("outside its approved policy");
  plan.claudeHostRefreshConfiguration = null;
  save(candidateFile, f.config);
  expect(verify).not.toThrow();
  delete plan.claudeHostRefreshConfiguration;
  // The Docker restart plan changes only through its own reviewed field.
  const engineRestart = {
    docker: "/fixture/docker",
    socket: "/fixture/docker.sock",
    containers: {
      dev: "a".repeat(64),
      gatewayTailscale: "b".repeat(64),
      gatewayCaddy: "c".repeat(64),
    },
  };
  const withEngine = { ...f.config, container: { ...f.config.container, engineRestart } };
  save(candidateFile, withEngine);
  expect(verify).toThrow("outside its approved policy");
  plan.engineRestartConfiguration = { ...engineRestart, deadlineSeconds: 120 };
  expect(verify).toThrow("outside its approved policy");
  plan.engineRestartConfiguration = engineRestart;
  expect(verify).not.toThrow();
  save(candidateFile, f.config);
  expect(verify).toThrow("outside its approved policy");
  plan.engineRestartConfiguration = null;
  expect(verify).not.toThrow();
  delete plan.engineRestartConfiguration;
  // Factory's Dev restart checks change only through their own reviewed field.
  const factoryGate = {
    docker: "/fixture/docker",
    socket: "/fixture/docker.sock",
    container: "a".repeat(64),
    verify: {
      script: "/fixture/verify.sh",
      sha256: "b".repeat(64),
      lockInode: 3901122,
      ownerMode: "paused" as const,
    },
  };
  save(candidateFile, { ...f.config, container: { ...f.config.container, factoryGate } });
  expect(verify).toThrow("outside its approved policy");
  plan.factoryGateConfiguration = factoryGate;
  expect(verify).not.toThrow();
  save(candidateFile, f.config);
  plan.factoryGateConfiguration = null;
  expect(verify).not.toThrow();
  delete plan.factoryGateConfiguration;
  // The Host launcher update plan changes only through its own reviewed field.
  const launcherUpdate = { candidate: "/fixture/candidate.plist", sha256: "c".repeat(64) };
  save(candidateFile, { ...f.config, host: { ...f.config.host, launcherUpdate } });
  expect(verify).toThrow("outside its approved policy");
  plan.hostLauncherUpdateConfiguration = launcherUpdate;
  expect(verify).not.toThrow();
  save(candidateFile, f.config);
  plan.hostLauncherUpdateConfiguration = null;
  expect(verify).not.toThrow();
  delete plan.hostLauncherUpdateConfiguration;

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

test("listed configuration changes verify exactly like the legacy per-setting fields", () => {
  const f = fixture();
  const previousFile = path.join(f.root, "previous.json");
  const candidateFile = path.join(f.root, "candidate.json");
  const save = (file: string, value: unknown) =>
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  save(previousFile, f.config);
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
  const base = {
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
  };
  const verify = (fields: Record<string, unknown>) => () =>
    verifyBootstrapConfiguration({
      plan: CoordinatorBootstrapPlanSchema.parse({ ...base, ...fields }),
      configurationFile: f.file,
      daemonId: "host-id",
    });
  const launcherUpdate = { candidate: "/fixture/candidate.plist", sha256: "c".repeat(64) };
  const factoryGate = {
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
  const cases = [
    {
      setting: "hostLauncherUpdate",
      legacy: "hostLauncherUpdateConfiguration",
      value: launcherUpdate,
      config: { ...f.config, host: { ...f.config.host, launcherUpdate } },
    },
    {
      setting: "factoryGate",
      legacy: "factoryGateConfiguration",
      value: factoryGate,
      config: { ...f.config, container: { ...f.config.container, factoryGate } },
    },
    {
      setting: "claudeHostRefresh",
      legacy: "claudeHostRefreshConfiguration",
      value: true,
      config: { ...f.config, claudeHostRefresh: true },
    },
  ];
  for (const item of cases) {
    const listed = { configurationChanges: [{ setting: item.setting, value: item.value }] };
    const legacy = { [item.legacy]: item.value };
    save(candidateFile, item.config);
    // Both shapes accept exactly the same candidate, and neither accepts it unlisted.
    expect(verify({})).toThrow("outside its approved policy");
    expect(verify(listed)).not.toThrow();
    expect(verify(legacy)).not.toThrow();
    // A further change beyond the listed one is refused under both shapes.
    save(candidateFile, {
      ...item.config,
      container: { ...item.config.container, password: "changed" },
    });
    expect(verify(listed)).toThrow("outside its approved policy");
    expect(verify(legacy)).toThrow("outside its approved policy");
    // Removal: null clears the setting from a configuration that has it.
    save(previousFile, item.config);
    save(f.file, item.config);
    save(candidateFile, f.config);
    expect(
      verify({ configurationChanges: [{ setting: item.setting, value: null }] }),
    ).not.toThrow();
    expect(verify({ [item.legacy]: null })).not.toThrow();
    save(previousFile, f.config);
    save(f.file, f.config);
    // Naming the setting both ways is refused.
    save(candidateFile, item.config);
    expect(verify({ ...listed, ...legacy })).toThrow("named twice");
  }
  save(candidateFile, f.config);
  expect(
    verify({ configurationChanges: [{ setting: "restartApprovalPolicy", value: {} }] }),
  ).toThrow("Unknown configuration setting");
  expect(
    verify({ configurationChanges: [{ setting: "factoryGate", value: { docker: 1 } }] }),
  ).toThrow("Invalid value");
  expect(
    verify({
      configurationChanges: [
        { setting: "claudeHostRefresh", value: true },
        { setting: "claudeHostRefresh", value: null },
      ],
    }),
  ).toThrow("named twice");
  // The wire schema stays loose so older readers can parse later settings.
  expect(() =>
    CoordinatorBootstrapPlanSchema.parse({
      ...base,
      configurationChanges: [{ setting: "future", value: 1 }],
    }),
  ).not.toThrow();
});

test("Dev registration configuration requires an explicit coordinator adoption transition", () => {
  const f = fixture();
  const previousFile = path.join(f.root, "previous.json");
  const candidateFile = path.join(f.root, "candidate.json");
  const operation = InstallationConfigSchema.parse({
    ...f.config,
    containerSourceUpdates: {
      sourceRepository: path.join(f.root, "source"),
      toolingDirectory: path.join(f.root, "tooling"),
      integrationRef: "refs/heads/main",
      receiptFile: path.join(f.root, "source-update-receipt.json"),
      docker: "/usr/local/bin/docker",
      containerId: "a".repeat(64),
      user: "dev",
      node: "/tmp/original-node/bin/node",
      home: "/home/dev/.vorteo",
      releaseRoot: "/home/dev/.vorteo/releases",
      currentReleaseLink: "/home/dev/.vorteo/current",
    },
  });
  const save = (file: string, value: unknown) =>
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  save(f.file, operation);
  save(previousFile, operation);
  save(candidateFile, operation);
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
    installationId: operation.public.installationId,
    service: operation.host.launchdService.replace(/\.host$/, ".installation"),
    expectedProcess: {
      pid: 1,
      bootId: "fixture",
      startIdentity: "fixture",
      argumentsSha256: "a".repeat(64),
    },
    previous: { ...release, configuration: { ...file, path: previousFile } },
    candidate: { ...release, configuration: { ...file, path: candidateFile } },
    state: {
      directory: operation.stateDir,
      restartJournal: path.join(operation.stateDir, "restart-jobs.json"),
      ownerSessions: path.join(operation.stateDir, "owner-sessions.json"),
    },
    hostRequestsAfter: null,
  });
  const verify = () =>
    verifyBootstrapConfiguration({ plan, configurationFile: f.file, daemonId: "host-id" });
  expect(verify).not.toThrow();
  const registered = InstallationConfigSchema.parse({
    ...operation,
    containerSourceUpdates: {
      ...operation.containerSourceUpdates,
      node: "/opt/vorteo/dev/node/bin/node",
    },
    container: {
      ...operation.container,
      persistentRegistration: {
        receiptFile: path.join(f.root, "dev-registration.json"),
        sha256: "b".repeat(64),
      },
    },
  });
  save(candidateFile, registered);
  expect(verify).toThrow("Candidate changes configuration outside its approved policy");
  save(f.file, registered);
  expect(verify).toThrow("Previous coordinator configuration no longer matches");
});

test("coordinator reconciliation revokes protected submissions after credential rotation", async () => {
  const f = fixture();
  const binding = () => readBootstrapHostBinding(f.file, "host-id").binding;
  const preferences = new DaemonAutomation(f.config.stateDir, false);
  preferences.change({ expectedRevision: null, service: "coordinator", enabled: true });
  const config = () => InstallationConfigSchema.parse(JSON.parse(readFileSync(f.file, "utf8")));
  const authority = coordinatorAutomaticAuthority(config());
  if (!authority) throw new Error("Missing fixture authority");
  const identity = { path: f.file, sha256: "a".repeat(64) };
  const release = {
    directory: f.root,
    sourceCommit: "a".repeat(40),
    artifactSha256: "a".repeat(64),
    node: identity,
    entrypoint: identity,
    configuration: identity,
    launcher: identity,
  };
  const plan = CoordinatorBootstrapPlanSchema.parse({
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: f.config.public.installationId,
    service: binding().service,
    expectedProcess: {
      pid: 123,
      bootId: "fixture",
      startIdentity: "fixture",
      argumentsSha256: "a".repeat(64),
    },
    previous: release,
    candidate: release,
    state: {
      directory: f.config.stateDir,
      restartJournal: path.join(f.config.stateDir, "restarts.json"),
      ownerSessions: path.join(f.config.stateDir, "owners.json"),
    },
    hostRequestsAfter: null,
  });
  const requests = new CoordinatorBootstrapRequests(
    new FileBootstrapRequestJournal(f.config.stateDir),
    binding,
    async () => {},
    () => Date.parse(authority.policyActivatedAt) + 1,
    () => coordinatorAutomaticAuthority(config()),
  );
  const pending = await requests.prepareAutomatic(
    { id: randomUUID(), reason: "Reviewed fixture", plan },
    authority,
  );
  const observer = createBootstrapReconciliationLedger(f.file, "host-id");
  // The coordinator loop gets bookkeeping and system cancellations only; never
  // preparation, owner decisions or dispatch claims.
  expect(Object.keys(observer).sort()).toEqual([
    "cancelForReplacedHostRelease",
    "finishAutomaticReconciliation",
    "list",
    "reserveAutomaticReconciliation",
    "revokeAutomatic",
  ]);
  observer.revokeAutomatic();
  expect(observer.list()).toEqual([pending]);
  f.config.hostAgentTokenHash = "c".repeat(64);
  f.save();
  observer.revokeAutomatic();
  expect(observer.list()).toMatchObject([{ id: pending.id, status: "canceled" }]);
  const replacementState = path.join(f.root, "replacement-state");
  mkdirSync(replacementState, { mode: 0o700 });
  f.config.stateDir = replacementState;
  f.save();
  expect(() => observer.revokeAutomatic()).toThrow("binding changed");
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
      save(path.join(directory, ".installation-source.json"), {
        sourceCommit: "a".repeat(40),
      });
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
    writeFileSync(docker, '#!/bin/sh\nexec /bin/cat "' + mounts + '"\n', {
      mode: 0o700,
    });
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
      return {
        ...expectedProcess,
        parentPid: 1,
        uid: process.getuid!(),
        executable: node,
      };
    });
    const verifyProcessExited = vi.fn(async (_pid: number) => {});
    const verifyServiceAbsent = vi.fn(async (_service: string) => {});
    vi.spyOn(serviceCollector, "createNativeBootstrapServiceReader").mockResolvedValue({
      readService: async () => `${service} = {\n\tpid = 123\n}`,
      inspectProcess,
      verifyServiceAbsent,
      verifyProcessExited,
    });
    await expect(verifyBootstrapPlan(plan, host)).resolves.toBeUndefined();
    expect(inspectProcess).toHaveBeenCalledTimes(4);
    // Claimed recovery can retire an updater before its legacy executor record
    // exists. Exercise the actual full plan validator, not only renewal derivation.
    const recovered = CoordinatorBootstrapRequestSchema.parse({
      id: randomUUID(),
      revision: randomUUID(),
      requestedBy: "host-agent",
      reason: "Retained claimed operation",
      createdAt: new Date().toISOString(),
      decisionAt: new Date().toISOString(),
      plan,
      planSha256: "b".repeat(64),
      status: "approved",
      execution: {
        generation: randomUUID(),
        stage: "recovery_required",
        updatedAt: new Date().toISOString(),
      },
    });
    const recoveredFrom = {
      id: recovered.id,
      revision: recovered.revision,
      generation: recovered.execution!.generation,
      planSha256: recovered.planSha256,
    };
    const journalRead = vi
      .spyOn(FileBootstrapRequestJournal.prototype, "read")
      .mockReturnValue([recovered]);
    const retainedIdentity = {
      ...expectedProcess,
      parentPid: 1,
      uid: process.getuid!(),
      executable: node,
    };
    const evidence = {
      recoveredFrom,
      request: {
        plan: { original: recovered, executor: { identity: { ...retainedIdentity, pid: 456 } } },
      },
      executor: { ...retainedIdentity, pid: 789 },
    } as unknown as NonNullable<
      Awaited<ReturnType<typeof claimedSuccessor.readClaimedSuccessorEvidence>>
    >;
    const claimedRead = vi
      .spyOn(claimedSuccessor, "readClaimedSuccessorEvidence")
      .mockResolvedValue(evidence);
    const reviewRead = vi
      .spyOn(FileClaimedRecoveryReviewJournal.prototype, "readReviews")
      .mockReturnValue([evidence.request]);
    const successorPlan = { ...plan, recoveredFrom };
    await expect(verifyBootstrapPlan(successorPlan, host)).resolves.toBeUndefined();
    expect(verifyProcessExited).toHaveBeenCalledWith(456);
    expect(verifyProcessExited).toHaveBeenCalledWith(789);
    claimedRead.mockResolvedValueOnce(undefined);
    await expect(verifyBootstrapPlan(successorPlan, host)).rejects.toThrow("claimed recovery");
    claimedRead.mockResolvedValueOnce({
      ...evidence,
      recoveredFrom: { ...recoveredFrom, revision: randomUUID() },
    });
    await expect(verifyBootstrapPlan(successorPlan, host)).rejects.toThrow("claimed recovery");
    verifyProcessExited.mockRejectedValueOnce(new Error("Updater remains live"));
    await expect(verifyBootstrapPlan(successorPlan, host)).rejects.toThrow(
      "lifetime exit is unproven",
    );
    claimedRead.mockResolvedValueOnce(evidence).mockResolvedValueOnce(undefined);
    await expect(verifyBootstrapPlan(successorPlan, host)).rejects.toThrow("claimed recovery");
    journalRead.mockReturnValueOnce([recovered, { ...recovered, id: randomUUID() }]);
    await expect(verifyBootstrapPlan(successorPlan, host)).rejects.toThrow("another successor");
    const canceledPlan = { ...successorPlan, candidate: previous };
    const canceled = CoordinatorBootstrapRequestSchema.parse({
      ...recovered,
      id: randomUUID(),
      revision: randomUUID(),
      status: "canceled",
      plan: canceledPlan,
      planSha256: coordinatorPlanDigest(canceledPlan),
      execution: undefined,
    });
    const sourceFile = path.join(candidate.directory, ".installation-source.json");
    const oldSource = readFileSync(sourceFile);
    save(sourceFile, { sourceCommit: "c".repeat(40) });
    const newReader = {
      ...candidate,
      sourceCommit: "c".repeat(40),
      artifactSha256: await digestBootstrapArtifact(candidate.directory),
    };
    const manualPlan = {
      ...successorPlan,
      candidate: newReader,
      compatibleRecovery: newReader,
      automaticRecovery: "restore-compatible" as const,
      supervisionRecovery: {
        canceledRequest: {
          id: canceled.id,
          revision: canceled.revision,
          planSha256: canceled.planSha256,
        },
        terminateFrozen: "SIGKILL" as const,
      },
    };
    journalRead.mockReturnValue([recovered, canceled]);
    inspectProcess.mockClear();
    await expect(verifyBootstrapPlan(manualPlan, host)).resolves.toBeUndefined();
    expect(verifyServiceAbsent).toHaveBeenCalledTimes(6);
    expect(inspectProcess).toHaveBeenCalledTimes(4);
    verifyServiceAbsent.mockRejectedValueOnce(new Error("Service unexpectedly registered"));
    await expect(verifyBootstrapPlan(manualPlan, host)).rejects.toThrow("unexpectedly registered");
    journalRead.mockReturnValueOnce([recovered]);
    await expect(verifyBootstrapPlan(manualPlan, host)).rejects.toThrow(
      "canceled migration changed",
    );
    writeFileSync(sourceFile, oldSource);
    journalRead.mockRestore();
    claimedRead.mockRestore();
    reviewRead.mockRestore();
    const compatibleRecovery = await makeRelease("compatible-recovery", "");
    const compatiblePlan = {
      ...plan,
      automaticRecovery: "restore-compatible" as const,
      compatibleRecovery,
    };
    await expect(verifyBootstrapPlan(compatiblePlan, host)).resolves.toBeUndefined();
    const selectedRecovery = path.join(f.root, "selected-recovery.plist");
    writeFileSync(selectedRecovery, readFileSync(previous.launcher.path), {
      mode: 0o600,
    });
    await restoreBootstrapLauncher({
      plan: compatiblePlan,
      launcherFile: selectedRecovery,
      configurationFile: f.file,
      writableMountRoots: [],
      authorizeSelection: async () => {},
    });
    expect(readFileSync(selectedRecovery)).toEqual(readFileSync(compatibleRecovery.launcher.path));
    const recoveryConfigBytes = readFileSync(compatibleRecovery.configuration.path);
    save(compatibleRecovery.configuration.path, {
      ...f.config,
      listen: { host: "127.0.0.1", port: 9999 },
    });
    expect(() =>
      verifyBootstrapConfiguration({
        plan: compatiblePlan,
        configurationFile: f.file,
        daemonId: "host-id",
      }),
    ).toThrow();
    writeFileSync(compatibleRecovery.configuration.path, recoveryConfigBytes);

    writeFileSync(host.helperPath, "fixture helper", { mode: 0o600 });
    writeFileSync(host.socket, "fixture endpoint", { mode: 0o600 });
    const { daemonId, ...setup } = host;
    const setupFile = path.join(f.root, "bootstrap-setup.json");
    save(setupFile, setup);
    const review = await createBootstrapReviewService(setupFile, daemonId);
    expect(review.list()).toEqual([]);
    const request = await review.prepare({
      id: randomUUID(),
      reason: "fixture bootstrap",
      plan,
    });
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
      selectBootstrapLauncher({
        ...selection,
        launcherFile: previous.launcher.path,
      }),
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
    save(mounts, {
      Id: host.containerId,
      State: { Running: true },
      Mounts: [],
    });
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
      inspectRunningProcess: async () => ({
        ...processIdentity,
        stopped: false as const,
      }),
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
    const verifierPath = realpathSync(
      path.resolve(import.meta.dirname, "../../../../../scripts/verify-coordinator-owner.py"),
    );
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
    const verified=spawnSync('/usr/bin/python3',['-I','-B',${JSON.stringify(
      verifierPath,
    )},${JSON.stringify(lock)}],{stdio:['ignore','ignore','pipe',fd]});
    if(verified.status!==0)process.exit(3);
    process.stdout.write('owned\\n');
    process.stdin.resume();
    process.stdin.on('end',()=>process.exit(0));`,
      { mode: 0o600 },
    );
    const helper = path.resolve(
      import.meta.dirname,
      "../../../../../scripts/run-coordinator-owner.py",
    );
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
      const inspector = path.resolve(
        import.meta.dirname,
        "../../../../../scripts/inspect-coordinator-process.py",
      );
      const observed = JSON.parse(
        (await promisify(execFile)("/usr/bin/python3", [inspector, String(second.pid)])).stdout,
      );
      expect(observed.argumentsSha256).toBe(
        createHash("sha256")
          .update(
            JSON.stringify([
              realpathSync(process.execPath),
              entry,
              setup,
              "watchdog",
              second.spawnargs.at(-1),
            ]),
          )
          .digest("hex"),
      );
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
    const child = spawn(process.execPath, ["-e", code], {
      stdio: ["pipe", "pipe", "ignore"],
    });
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
  const file = {
    path: path.join(root, "not-executed"),
    sha256: "a".repeat(64),
  };
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
    writeFileSync(client, JSON.stringify({ kind: "host-agent" }), {
      mode: 0o600,
    });
    await expect(createConfiguredBootstrapReview("host-id", environment)).resolves.toBeUndefined();
    const setup = path.join(root, "coordinator-bootstrap-runner.json");
    writeFileSync(setup, "{}", { mode: 0o600 });
    const unavailable = await createConfiguredBootstrapReview("host-id", environment);
    expect(() => unavailable!.list()).toThrow("maintenance is unavailable");
    expect(bootstrapReviewFeatures(unavailable)).toEqual({
      coordinatorBootstrapReview: false,
      coordinatorBootstrapPreclaimRecovery: false,
      coordinatorBootstrapPreclaimObservation: false,
      coordinatorBootstrapPreclaimOwnerCancellation: false,
      coordinatorBootstrapClaimedRecovery: false,
      coordinatorBootstrapClaimedObservation: false,
      coordinatorBootstrapFactoryAdoption: false,
      coordinatorBootstrapCompatibleRecovery: false,
      coordinatorBootstrapPreviewMonitor: false,
      coordinatorBootstrapClaudeHostRefresh: false,
      coordinatorBootstrapEngineRestart: false,
      coordinatorBootstrapFactoryGate: false,
      coordinatorBootstrapHostLauncherUpdate: false,
      coordinatorBootstrapConfigurationChanges: false,
      coordinatorBootstrapSourceUpdateTooling: false,
      coordinatorBootstrapBootRecovery: false,
      coordinatorBootstrapRecoveryBootPlan: false,
      coordinatorBootstrapAutomaticReconciliation: false,
      coordinatorBootstrapAutomaticStatus: false,
      coordinatorBootstrapAuthenticatedSubmission: false,
      coordinatorBootstrapUnavailableReason: unavailable!.unavailableReason,
    });
    expect(unavailable!.unavailableReason).toContain("maintenance is unavailable");
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
    const helper = path.resolve(
      import.meta.dirname,
      "../../../../../scripts/run-coordinator-owner.py",
    );
    const inspector = path.resolve(
      import.meta.dirname,
      "../../../../../scripts/inspect-coordinator-process.py",
    );
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

test.runIf(process.platform === "darwin")(
  "automatic watchdog accepts advancing executor activity while the stage stays claimed, up to a cap",
  async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bootstrap-activity-")));
    roots.push(root);
    const helper = path.resolve(
      import.meta.dirname,
      "../../../../../scripts/run-coordinator-owner.py",
    );
    const inspector = path.resolve(
      import.meta.dirname,
      "../../../../../scripts/inspect-coordinator-process.py",
    );
    // A simulated clock replaces the helper's monotonic time and sleep. The
    // executor stand-in is a real process so a fence would be observable.
    const probe = `
import ctypes,fcntl,importlib.util,signal,subprocess,sys

def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path)
 module=importlib.util.module_from_spec(spec)
 spec.loader.exec_module(module)
 return module
owner=load('owner',sys.argv[1]); inspector=load('inspector',sys.argv[2]); lock=sys.argv[3]

class Clock:
 def __init__(self,release): self.now=0.0; self.release=release
 def monotonic(self): return self.now
 def sleep(self,seconds):
  self.now+=seconds
  if self.release(self): fcntl.flock(holder,fcntl.LOCK_UN)

def run(release,activity):
 global holder
 child=subprocess.Popen([sys.executable,'-c',"import time; print('ready',flush=True); time.sleep(60)"],stdout=subprocess.PIPE,text=True)
 try:
  assert child.stdout.readline().strip()=='ready'
  token=inspector.audit_token(ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True),child.pid)
  holder=open(lock,'w'); fcntl.flock(holder,fcntl.LOCK_EX)
  clock=Clock(lambda c: release(c,child)); owner.time=clock
  with open(lock) as descriptor:
   owner.wait_for_executor(descriptor,token,progress=lambda:'claimed',activity=lambda:activity(clock))
  holder.close()
  return clock.now,child
 finally:
  if child.poll() is None: child.kill()

# Executor is alive and its runner sequence advances until it finishes at 300 s.
finished,child=run(lambda c,_: c.now>=300,lambda c:(min(int(c.now),299),'t'))
assert 300<=finished<301 and child.poll() is None,(finished,child.poll())
# Executor loops forever: activity cannot postpone the fence past the cap.
limit=owner.EXECUTOR_ACTIVITY_LIMIT
fenced,child=run(lambda c,child: c.now>=limit+0.5 and child.wait(timeout=2) is not None,lambda c:(int(c.now),'t'))
assert child.wait(timeout=2)==-signal.SIGTERM
assert limit<=fenced<limit+2,fenced
# Without activity the original stage-only timeout still applies.
fenced,child=run(lambda c,child: c.now>=180.5 and child.wait(timeout=2) is not None,lambda c:None)
assert child.wait(timeout=2)==-signal.SIGTERM and 180<=fenced<182,fenced
print('verified')
`;
    const result = await promisify(execFile)(
      "/usr/bin/python3",
      ["-I", "-B", "-c", probe, helper, inspector, path.join(root, "lock")],
      { timeout: 30000 },
    );
    expect(result.stdout.trim()).toBe("verified");
  },
);

test.runIf(process.platform === "darwin")(
  "automatic watchdog reads activity only from the exact executor runner file",
  async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bootstrap-runner-activity-")));
    roots.push(root);
    chmodSync(root, 0o700);
    const id = randomUUID();
    const record = { id, generation: randomUUID(), planSha256: "a".repeat(64), pid: 4242 };
    const runner = {
      version: 1,
      authority: "diagnostic-only",
      requestId: id,
      revision: 1,
      planSha256: record.planSha256,
      generation: record.generation,
      role: "executor",
      pid: record.pid,
      updatedAt: "2026-10-19T18:58:23.339Z",
      sequence: 92,
    };
    const write = (name: string, value: unknown, mode = 0o600) => {
      const file = path.join(root, `coordinator-runner-${id}-${name}.json`);
      writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode });
      chmodSync(file, mode);
    };
    const script = path.resolve(
      import.meta.dirname,
      "../../../../../scripts/run-coordinator-owner.py",
    );
    const read = async () =>
      (
        await promisify(execFile)("/usr/bin/python3", [
          "-I",
          "-B",
          "-c",
          "import runpy,sys,json; m=runpy.run_path(sys.argv[1]); print(json.dumps(m['executor_runner_activity'](sys.argv[2],json.loads(sys.argv[3]))))",
          script,
          root,
          JSON.stringify(record),
        ])
      ).stdout.trim();
    expect(JSON.parse(await read())).toBeNull();
    write("watchdog", { ...runner, role: "watchdog", sequence: 500 });
    write("foreign-pid", { ...runner, pid: 1, sequence: 500 });
    write("foreign-generation", { ...runner, generation: randomUUID(), sequence: 500 });
    write("unprotected", { ...runner, sequence: 500 }, 0o644);
    write("unreadable", "{");
    // Deeply nested JSON raises RecursionError; it must not crash the watchdog.
    write("nested", "[".repeat(200_000));
    expect(JSON.parse(await read())).toBeNull();
    write("executor", runner);
    expect(JSON.parse(await read())).toEqual([92, runner.updatedAt]);
    write("duplicate", { ...runner, sequence: 93 });
    expect(JSON.parse(await read())).toBeNull();
  },
);

test.runIf(process.platform === "darwin")(
  "independent watchdog reads a pre-promotion claim and follows main after progress",
  async () => {
    const f = fixture();
    const id = randomUUID();
    const generation = randomUUID();
    const plan = { automaticRecovery: "restore-compatible" };
    const planSha256 = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    const request = {
      id,
      status: "approved",
      plan,
      planSha256,
      execution: { generation, stage: "claimed" },
    };
    const pendingFile = path.join(f.root, "coordinator-bootstrap-pending.json");
    writeFileSync(
      pendingFile,
      JSON.stringify({ version: 1, requests: [request], promotions: [] }),
      { mode: 0o600 },
    );
    const script = path.resolve(
      import.meta.dirname,
      "../../../../../scripts/run-coordinator-owner.py",
    );
    const record = JSON.stringify({ id, generation, planSha256 });
    const read = () =>
      promisify(execFile)("/usr/bin/python3", [
        "-c",
        "import runpy,sys,json; m=runpy.run_path(sys.argv[1]); print(m['read_executor_stage'](sys.argv[2],json.loads(sys.argv[3])))",
        script,
        f.root,
        record,
      ]);
    expect((await read()).stdout.trim()).toBe("claimed");
    const mainFile = path.join(f.root, "coordinator-bootstrap.json");
    writeFileSync(
      mainFile,
      JSON.stringify({
        version: 1,
        requests: [{ ...request, execution: { generation, stage: "frozen" } }],
      }),
      { mode: 0o600 },
    );
    expect((await read()).stdout.trim()).toBe("frozen");
    writeFileSync(
      mainFile,
      JSON.stringify({
        version: 1,
        requests: [
          {
            ...request,
            execution: { generation: randomUUID(), stage: "frozen" },
          },
        ],
      }),
    );
    await expect(read()).rejects.toThrow("Watchdog generation changed");
  },
);

test("uncertain main-directory sync refuses promotion until durable reconciliation", () => {
  const f = fixture();
  const journal = new FileBootstrapRequestJournal(f.root);
  const identity = { path: "/fixture/file", sha256: "a".repeat(64) };
  const release = {
    sourceCommit: "b".repeat(40),
    directory: "/fixture/release",
    artifactSha256: "c".repeat(64),
    node: identity,
    entrypoint: identity,
    configuration: identity,
    launcher: identity,
  };
  const request = CoordinatorBootstrapRequestSchema.parse({
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "fixture",
    createdAt: new Date(0).toISOString(),
    decisionAt: new Date(1).toISOString(),
    status: "approved",
    planSha256: "a".repeat(64),
    plan: {
      version: 1,
      operation: "coordinator-bootstrap",
      installationId: randomUUID(),
      service: "gui/501/local.vorteo.fixture.installation",
      expectedProcess: {
        pid: 123,
        bootId: "fixture",
        startIdentity: "fixture",
        argumentsSha256: "d".repeat(64),
      },
      previous: release,
      candidate: release,
      compatibleRecovery: release,
      automaticRecovery: "restore-compatible",
      state: {
        directory: f.root,
        restartJournal: f.root + "/restart-jobs.json",
        ownerSessions: f.root + "/owner-sessions.json",
      },
      hostRequestsAfter: null,
    },
    execution: {
      generation: randomUUID(),
      stage: "claimed",
      updatedAt: new Date(2).toISOString(),
    },
  });
  const { compatibleRecovery: _recovery, ...legacyPlan } = request.plan;
  const legacy = {
    ...request,
    id: randomUUID(),
    plan: { ...legacyPlan, automaticRecovery: "restore-previous" as const },
  };
  journal.replace([], [legacy]);
  const mainFile = path.join(f.root, "coordinator-bootstrap.json");
  const retainedMain = readFileSync(mainFile);
  journal.replace([legacy], [legacy, request]);
  expect(readFileSync(mainFile)).toEqual(retainedMain);
  const sync = nativeFs.fsyncSync;
  const fault = vi.spyOn(nativeFs, "fsyncSync").mockImplementation((descriptor) => {
    if (
      JSON.parse(readFileSync(mainFile, "utf8")).requests.some(
        (item: { id: string }) => item.id === request.id,
      ) &&
      nativeFs.fstatSync(descriptor).isDirectory()
    ) {
      expect(() =>
        execFileSync(
          "/usr/bin/python3",
          [
            "-I",
            "-B",
            "-c",
            "import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",
            path.join(f.root, "coordinator-bootstrap.lock"),
          ],
          { stdio: "pipe" },
        ),
      ).toThrow();
      throw new Error("fixture directory sync failure");
    }
    sync(descriptor);
  });
  syncBuiltinESMExports();
  try {
    expect(() => journal.promote(request)).toThrow("fixture directory sync failure");
    expect(journal.read()).toEqual([legacy, request]);
  } finally {
    fault.mockRestore();
    syncBuiltinESMExports();
  }
  journal.promote(request);
  expect(journal.readPromoted()).toEqual([legacy, request]);
});

test.runIf(process.platform === "darwin")(
  "journal writer death releases exclusion without replacing its inode",
  async () => {
    const f = fixture();
    const journal = new FileBootstrapRequestJournal(f.root);
    journal.replace([], []);
    const lock = path.join(f.root, "coordinator-bootstrap.lock");
    const inode = nativeFs.statSync(lock).ino;
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-u",
        "-c",
        "import fcntl,sys,time; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_EX); print('held',flush=True); time.sleep(60)",
        lock,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    try {
      const [ready] = await once(child.stdout!, "data");
      expect(String(ready).trim()).toBe("held");
      expect(() => journal.replace([], [])).toThrow("storage is busy");
    } finally {
      // Only this disposable fixture process receives a signal.
      child.kill("SIGKILL");
      await closed;
    }
    journal.replace([], []);
    expect(nativeFs.statSync(lock).ino).toBe(inode);
  },
);

test
  .runIf(process.platform === "darwin")
  .each([
    "before-freeze",
    "after-freeze",
    "during-preservation",
    "after-preservation",
    "reboot-before-preservation",
    "reboot-running-previous",
    "reboot-running-busy",
    "reboot-running-unrelated",
    "reboot-running-wrong-boot",
    "reboot-stopped-previous",
    "reboot-stopped-previous-busy",
    "reboot-stopped-unrelated",
    "reboot-stopped-starts",
    "reboot-after-preservation",
    "reboot-busy-journal",
    "reboot-invalid-journal",
    "reboot-changed-journal",
    "busy-children",
    "busy-journal",
    "busy-during-freeze",
    "invalid-journal",
    "busy-ownership-lost",
  ])("compatible native recovery completes the early handoff after %s", async (interruption) => {
  const f = fixture();
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const save = (file: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, sha256: hash(bytes) };
  };
  const node = path.join(f.root, "node");
  writeFileSync(node, "fixture executable", { mode: 0o700 });
  const serviceName = f.config.host.launchdService.replace(/\.host$/, ".installation");
  const release = async (name: string, selectedConfiguration: string | null) => {
    const directory = path.join(f.root, name);
    mkdirSync(directory, { mode: 0o700 });
    const entrypoint = path.join(directory, "entry.js");
    writeFileSync(entrypoint, name, { mode: 0o600 });
    save(path.join(directory, ".installation-source.json"), {
      sourceCommit: "a".repeat(40),
    });
    const configuration = save(path.join(f.root, name + ".json"), f.config);
    const launcher = save(path.join(f.root, name + ".plist"), {
      Label: serviceName.split("/").slice(2).join("/"),
      ProgramArguments: [node, entrypoint, selectedConfiguration ?? configuration.path],
      KeepAlive: true,
    });
    return {
      directory,
      sourceCommit: "a".repeat(40),
      artifactSha256: await digestBootstrapArtifact(directory),
      node: { path: node, sha256: hash("fixture executable") },
      entrypoint: { path: entrypoint, sha256: hash(name) },
      configuration,
      launcher,
    };
  };
  const previous = await release("previous", f.file);
  const recovery = await release("recovery", null);
  const launcherFile = path.join(f.root, "selected.plist");
  writeFileSync(launcherFile, readFileSync(previous.launcher.path), {
    mode: 0o600,
  });
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
    service: serviceName,
    expectedProcess,
    previous,
    candidate: recovery,
    compatibleRecovery: recovery,
    automaticRecovery: "restore-compatible",
    hostRequestsAfter: null,
    state: {
      directory: f.config.stateDir,
      restartJournal: path.join(f.config.stateDir, "restart-jobs.json"),
      ownerSessions: path.join(f.config.stateDir, "owner-sessions.json"),
    },
  });
  const rebooted = interruption.startsWith("reboot-");
  const currentBoot = rebooted ? randomUUID() : expectedProcess.bootId;
  const requestId = randomUUID();
  if (rebooted)
    plan.bootRecovery = {
      requestId,
      service: `${serviceName}-recovery-${requestId}`,
      launcher: recovery.launcher,
      installedLauncher: path.join(f.root, "startup.plist"),
      setup: recovery.configuration,
      ownerLauncher: recovery.entrypoint,
      node: recovery.node,
      entrypoint: recovery.entrypoint,
    };
  const journal = new FileBootstrapRequestJournal(f.config.stateDir);
  const requests = new CoordinatorBootstrapRequests(
    journal,
    () => ({
      environment: "host",
      installationId: plan.installationId,
      service: serviceName,
      ownerPasswordHash: f.config.ownerPasswordHash,
    }),
    async () => {},
  );
  const pending = await requests.prepare({
    id: requestId,
    reason: "fixture recovery",
    plan,
  });
  const approved = await requests.decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    "fixture-password",
  );
  let record = await requests.claimDispatch({
    id: approved.id,
    revision: approved.revision,
    planSha256: approved.planSha256,
  });
  requests.promoteDispatch(record);
  record = requests.advanceDispatch(
    {
      id: record.id,
      revision: record.revision,
      planSha256: record.planSha256,
      generation: record.execution!.generation,
    },
    "freeze_pending",
  );
  if (
    [
      "during-preservation",
      "after-preservation",
      "reboot-before-preservation",
      "reboot-after-preservation",
      "reboot-changed-journal",
    ].includes(interruption)
  )
    record = requests.advanceDispatch(
      {
        id: record.id,
        revision: record.revision,
        planSha256: record.planSha256,
        generation: record.execution!.generation,
      },
      "frozen",
    );
  if (
    ["after-preservation", "reboot-after-preservation", "reboot-changed-journal"].includes(
      interruption,
    )
  )
    await preserveBootstrapState({
      request: record,
      writableMountRoots: [],
      childPids: [],
    });
  if (interruption === "during-preservation") {
    const failure = vi.spyOn(nativeFs, "renameSync").mockImplementation(() => {
      throw new Error("fixture interrupted receipt");
    });
    syncBuiltinESMExports();
    try {
      await expect(
        preserveBootstrapState({
          request: {
            ...record,
            execution: { ...record.execution!, stage: "frozen" },
          },
          writableMountRoots: [],
          childPids: [],
        }),
      ).rejects.toThrow("fixture interrupted receipt");
    } finally {
      failure.mockRestore();
      syncBuiltinESMExports();
    }
  }
  if (
    [
      "busy-journal",
      "reboot-busy-journal",
      "reboot-stopped-previous-busy",
      "reboot-running-busy",
    ].includes(interruption)
  )
    save(plan.state.restartJournal, [
      {
        id: randomUUID(),
        revision: randomUUID(),
        target: "host",
        reason: "fixture",
        requestedBy: "host-agent",
        createdAt: "2026-10-08T00:00:00.000Z",
        expiresAt: "2026-10-09T00:00:00.000Z",
        status: "approved",
        detail: "fixture",
      },
    ]);
  if (interruption.endsWith("invalid-journal")) save(plan.state.restartJournal, { invalid: true });
  if (interruption === "reboot-changed-journal") save(plan.state.restartJournal, []);
  const busy = interruption.includes("busy-");
  let observedBusy = false;
  let stopped =
    !["before-freeze", "busy-during-freeze"].includes(interruption) &&
    !interruption.startsWith("reboot-running-");
  const stoppedJob = interruption.startsWith("reboot-stopped-");
  const runningJob = interruption.startsWith("reboot-running-");
  let loaded = !rebooted || stoppedJob || runningJob;
  let noProcess = stoppedJob;
  let serviceReads = 0;
  let oldExited = false;
  let identity = {
    ...expectedProcess,
    bootId: currentBoot,
    parentPid: 1,
    uid: process.getuid!(),
    executable: node,
  };
  identity = { ...identity, ...runningBootIdentity(interruption, expectedProcess.bootId) };
  const effects: string[][] = [];
  const native = createBootstrapNativeLifecycle(
    {
      requests,
      recoveryBootId: rebooted ? currentBoot : undefined,
      configurationFile: f.file,
      launcherFile,
      writableMountRoots: async () => [],
      requireOwnership: async () => {
        if (observedBusy && interruption === "busy-ownership-lost")
          throw new Error("lost ownership");
      },
      readHealth: async () => ({ installationId: plan.installationId }),
      reader: {
        readService: async () => {
          if (!loaded) throw new Error("absent");
          serviceReads++;
          if (interruption === "reboot-stopped-starts" && serviceReads > 1) noProcess = false;
          if (noProcess) {
            const entrypoint =
              interruption === "reboot-stopped-unrelated"
                ? "/unrelated/entry.js"
                : previous.entrypoint.path;
            return `${serviceName} = {\n\tprogram = ${node}\n\targuments = {\n\t\t${node}\n\t\t${entrypoint}\n\t\t${f.file}\n\t}\n}`;
          }
          return `${serviceName} = {\n\tpid = ${identity.pid}\n}`;
        },
        inspectProcess: async (pid) =>
          pid === process.pid ? { ...identity, pid, bootId: currentBoot } : identity,
        inspectAuditedProcess: async () => {
          throw new Error("Unexpected audit");
        },
        inspectStoppedProcess: async () => {
          if (!stopped) throw new Error("running");
          observedBusy = busy;
          return {
            ...identity,
            stopped: true as const,
            childPids:
              interruption === "busy-children" || interruption === "busy-ownership-lost"
                ? [999]
                : [],
          };
        },
        inspectRunningProcess: async () => {
          if (stopped) throw new Error("stopped");
          return { ...identity, stopped: false as const };
        },
        verifyProcessExited: async (pid) => {
          if (runningJob) expect(pid).toBe(333);
          if (!oldExited) throw new Error("old still running");
        },
        verifyServiceAbsent: async () => {
          if (loaded) throw new Error("still loaded");
        },
      },
    },
    {
      run: async (args) => {
        effects.push([...args]);
        if (args[0] === "kill") {
          expect(["SIGSTOP", "SIGCONT"]).toContain(args[1]);
          if (args[1] === "SIGSTOP" && interruption === "busy-during-freeze") {
            save(plan.state.restartJournal, [
              {
                id: randomUUID(),
                revision: randomUUID(),
                target: "host",
                reason: "fixture race",
                requestedBy: "host-agent",
                createdAt: "2026-10-08T00:00:00.000Z",
                expiresAt: "2026-10-09T00:00:00.000Z",
                status: "running",
                detail: "fixture",
              },
            ]);
          }
          stopped = args[1] === "SIGSTOP";
        } else if (args[0] === "bootout") {
          loaded = false;
          oldExited = true;
        } else if (args[0] === "bootstrap") {
          loaded = true;
          noProcess = false;
          stopped = false;
          identity = {
            ...identity,
            pid: 124,
            startIdentity: "1234:9999",
            argumentsSha256: hash(
              JSON.stringify([node, recovery.entrypoint.path, recovery.configuration.path]),
            ),
          };
        } else throw new Error("Unexpected native command");
      },
    },
  );
  const beforeRecovery = { stopped, launcher: readFileSync(launcherFile) };
  const result = await recoverAbandonedBootstrap(
    requests,
    { id: record.id, generation: record.execution!.generation },
    {
      withOwnership: async (operation) => operation(),
      verifyExecutorExited: async () => {},
      verifyBootChanged: rebooted ? async () => {} : undefined,
      resumePrevious: async () => {
        throw new Error("Must not resume previous");
      },
      restorePrevious: native.restorePrevious,
    },
  );
  if (
    [
      "busy-journal",
      "invalid-journal",
      "reboot-busy-journal",
      "reboot-invalid-journal",
      "reboot-stopped-previous-busy",
      "reboot-running-busy",
    ].includes(interruption)
  ) {
    // Shared admission refuses promotion before native recovery can begin.
    // Failure bookkeeping must not claim that rollback or resume was attempted.
    expect(result.execution!.stage).toBe("recovery_required");
    expect(result.execution!.generation).toBe(record.execution!.generation);
    expect(result.execution!.rollbackAttemptedAt).toBeUndefined();
    expect(result.plan).toEqual(record.plan);
    expect(effects).toEqual([]);
    expect(stopped).toBe(beforeRecovery.stopped);
    expect(readFileSync(launcherFile)).toEqual(beforeRecovery.launcher);
    const effect = vi.fn();
    const observed = await recoverAbandonedBootstrap(
      requests,
      { id: record.id, generation: record.execution!.generation },
      {
        withOwnership: async (operation) => operation(),
        verifyExecutorExited: async () => {},
        resumePrevious: effect,
        restorePrevious: effect,
      },
    );
    expect(observed.revision).toBe(result.revision);
    expect(effect).not.toHaveBeenCalled();
    return;
  }
  if (
    [
      "busy-children",
      "busy-during-freeze",
      "busy-ownership-lost",
      "reboot-changed-journal",
      "reboot-stopped-unrelated",
      "reboot-stopped-starts",
      "reboot-running-unrelated",
      "reboot-running-wrong-boot",
    ].includes(interruption)
  ) {
    expect(result.execution!.stage).toBe("recovery_required");
    expect(result.execution!.rollbackAttemptedAt).toBeTruthy();
    const resumed = ["busy-children", "busy-during-freeze"].includes(interruption);
    expect(effects).toEqual([
      ...(interruption === "busy-during-freeze" ? [["kill", "SIGSTOP", serviceName]] : []),
      ...(resumed ? [["kill", "SIGCONT", serviceName]] : []),
    ]);
    expect(stopped).toBe(!resumed && !runningJob);
    expect(readFileSync(launcherFile)).toEqual(readFileSync(previous.launcher.path));
    const retry = vi.fn();
    await recoverAbandonedBootstrap(
      requests,
      {
        id: record.id,
        generation: record.execution!.generation,
      },
      {
        withOwnership: async (operation) => operation(),
        verifyExecutorExited: async () => {},
        resumePrevious: retry,
        restorePrevious: retry,
      },
    );
    expect(retry).not.toHaveBeenCalled();
    return;
  }
  expect(result.execution!.stage).toBe("rolled_back");
  expect(effects).toEqual(expectedEarlyRecoveryCommands(interruption, serviceName, launcherFile));
  expect(readFileSync(launcherFile)).toEqual(readFileSync(recovery.launcher.path));
  await verifyBootstrapState({ request: result, writableMountRoots: [] });
  if (interruption === "after-preservation") {
    const effectCount = effects.length;
    const interruptedReceipt = {
      ...result,
      revision: randomUUID(),
      execution: { ...result.execution!, stage: "recovery_required" as const },
    };
    journal.replace([result], [interruptedReceipt]);
    const reconciled = await recoverAbandonedBootstrap(
      requests,
      { id: result.id, generation: result.execution!.generation },
      {
        withOwnership: async (operation) => operation(),
        verifyExecutorExited: async () => {},
        verifyRollback: native.verifyRollback,
        restorePrevious: async () => {
          throw new Error("Cannot repeat completed native rollback");
        },
        resumePrevious: async () => {
          throw new Error("Cannot signal completed recovery");
        },
      },
    );
    expect(reconciled.execution!.stage).toBe("rolled_back");
    expect(effects).toHaveLength(effectCount);
    expect(reconciled.execution!.rollbackAttemptedAt).toBe(result.execution!.rollbackAttemptedAt);
  }
});

test("Host readiness does not await maintenance validation and all operations remain fenced", async () => {
  const validation = Promise.withResolvers<BootstrapReviewService | undefined>();
  const initialize = vi.fn(() => validation.promise);
  const service = deferBootstrapReview(initialize);
  const changed = vi.fn();
  const removed = vi.fn();
  service.subscribeAvailability!(() => {
    throw new Error("isolated notification failure");
  });
  service.subscribeAvailability!(changed);
  service.subscribeAvailability!(removed)();
  expect(bootstrapReviewFeatures(service)).toMatchObject({
    coordinatorBootstrapReview: false,
    coordinatorBootstrapSourceUpdateTooling: false,
    coordinatorBootstrapUnavailableReason: expect.stringContaining("Checking"),
  });
  expect(() => service.list()).toThrow("Checking");
  await expect(service.prepare({} as never)).rejects.toThrow("Checking");
  await expect(service.decide({} as never, "fixture")).rejects.toThrow("Checking");
  expect(initialize).toHaveBeenCalledTimes(1);
  const list = vi.fn(() => []);
  const automatic = { reconcile: vi.fn() };
  expect(service.automatic).toBeUndefined();
  validation.resolve({ list, prepare: vi.fn(), decide: vi.fn(), automatic });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(removed).not.toHaveBeenCalled();
  expect(bootstrapReviewFeatures(service)).toMatchObject({
    coordinatorBootstrapReview: true,
    coordinatorBootstrapSourceUpdateTooling: true,
  });
  expect(bootstrapReviewFeatures(service).coordinatorBootstrapUnavailableReason).toBeUndefined();
  expect(service.list()).toEqual([]);
  expect(service.automatic).toBe(automatic);
  expect(automatic.reconcile).not.toHaveBeenCalled();
  expect(list).toHaveBeenCalledTimes(1);
});

test("background maintenance failure stays unavailable without leaking private errors", async () => {
  const validation = Promise.withResolvers<BootstrapReviewService | undefined>();
  const service = deferBootstrapReview(() => validation.promise);
  const changed = vi.fn();
  service.subscribeAvailability!(changed);
  validation.reject(new Error("private configuration bytes"));
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(bootstrapReviewFeatures(service)).toMatchObject({
    coordinatorBootstrapReview: false,
    coordinatorBootstrapSourceUpdateTooling: false,
  });
  expect(service.unavailableReason).toContain("could not validate");
  expect(service.unavailableReason).not.toContain("private configuration bytes");
  expect(() => service.list()).toThrow("could not validate");
});

test("validated recovery readiness survives ordinary maintenance unavailability", async () => {
  let actions = 0;
  const unavailable = () => {
    throw new Error("ordinary maintenance blocked");
  };
  const recovery = {
    available: true,
    list: () => [],
    prepare: async () => {
      actions++;
      throw new Error("not requested");
    },
    decide: async () => {
      actions++;
      throw new Error("not requested");
    },
  };
  const service = deferBootstrapReview(async () => ({
    unavailableReason: "ordinary maintenance blocked",
    list: unavailable,
    prepare: async () => unavailable(),
    decide: async () => unavailable(),
    preclaimRecovery: recovery,
  }));
  expect(service.preclaimRecovery).toBeUndefined();
  await vi.waitFor(() => expect(service.preclaimRecovery).toBe(recovery));
  expect(bootstrapReviewFeatures(service)).toMatchObject({
    coordinatorBootstrapReview: false,
    coordinatorBootstrapPreclaimRecovery: true,
  });
  expect(service.preclaimRecovery!.list()).toEqual([]);
  expect(actions).toBe(0);
});

test("validated claimed recovery readiness survives ordinary maintenance unavailability", async () => {
  let actions = 0;
  const unavailable = () => {
    throw new Error("ordinary maintenance blocked");
  };
  const recovery = {
    available: true,
    list: () => [],
    prepare: async () => {
      actions++;
      throw new Error("not requested");
    },
    decide: async () => {
      actions++;
      throw new Error("not requested");
    },
  };
  const service = deferBootstrapReview(async () => ({
    unavailableReason: "ordinary maintenance blocked",
    list: unavailable,
    prepare: async () => unavailable(),
    decide: async () => unavailable(),
    claimedRecovery: recovery,
  }));
  expect(service.claimedRecovery).toBeUndefined();
  await vi.waitFor(() => expect(service.claimedRecovery).toBe(recovery));
  expect(bootstrapReviewFeatures(service)).toMatchObject({
    coordinatorBootstrapReview: false,
    coordinatorBootstrapClaimedRecovery: true,
  });
  expect(service.claimedRecovery!.list()).toEqual([]);
  expect(actions).toBe(0);
});

test("absent background maintenance remains unadvertised after verification", async () => {
  const service = deferBootstrapReview(async () => undefined);
  await vi.waitFor(() => expect(service.unavailableReason).toBeUndefined());
  expect(bootstrapReviewFeatures(service)).toMatchObject({
    coordinatorBootstrapReview: false,
    coordinatorBootstrapSourceUpdateTooling: false,
  });
  expect(() => service.list()).toThrow("not configured");
});

async function sourceToolingAdmissionFixture() {
  const f = fixture();
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const save = (file: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, sha256: hash(bytes) };
  };
  const sourceUpdates = {
    sourceRepository: path.join(f.root, "repository"),
    releaseRoot: path.join(f.root, "releases"),
    currentReleaseLink: path.join(f.root, "current"),
    webDirectory: path.join(f.root, "web"),
    toolingDirectory: path.join(f.root, "old-scripts"),
    integrationRef: "refs/heads/protected-integration",
  };
  const config = {
    ...f.config,
    sourceUpdates,
    restartApprovalPolicy: { hostRequestsAfter: "2026-10-11T12:00:00Z" },
    container: {
      ...f.config.container,
      factoryRuntimeAdoption: {
        node: path.join(f.root, "factory-node"),
        script: path.join(f.root, "factory-plan.mjs"),
        sha256: "d".repeat(64),
      },
    },
  };
  save(f.file, config);
  const node = path.join(f.root, "node");
  writeFileSync(node, "fixture executable", { mode: 0o700 });
  const service = f.config.host.launchdService.replace(/\.host$/, ".installation");
  const makeRelease = async (name: string, configurationFile: string) => {
    const directory = path.join(f.root, name);
    mkdirSync(directory, { mode: 0o700 });
    const entrypoint = path.join(directory, "entry.js");
    writeFileSync(entrypoint, "export {};", { mode: 0o600 });
    save(path.join(directory, ".installation-source.json"), {
      sourceCommit: "a".repeat(40),
    });
    const configuration = save(path.join(f.root, name + ".json"), config);
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
  const scripts = path.join(candidate.directory, "scripts");
  mkdirSync(scripts, { mode: 0o700 });
  const toolingFiles = [
    "prepare-installation-update.mjs",
    "publish-instance-web.mjs",
    "instance-web-artifact.mjs",
  ].map((name) => path.join(scripts, name));
  for (const file of toolingFiles)
    writeFileSync(file, "throw new Error('must never execute');", { mode: 0o600 });
  candidate.artifactSha256 = await digestBootstrapArtifact(candidate.directory);
  candidate.configuration = save(candidate.configuration.path, {
    ...config,
    sourceUpdates: { ...sourceUpdates, toolingDirectory: scripts },
  });
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
    sourceUpdateTooling: true,
    state: {
      directory: f.config.stateDir,
      restartJournal: path.join(f.config.stateDir, "restart-jobs.json"),
      ownerSessions: path.join(f.config.stateDir, "owner-sessions.json"),
    },
  });
  const docker = path.join(f.root, "docker-fixture");
  const mounts = path.join(f.root, "mounts.json");
  save(mounts, { Id: "a".repeat(64), State: { Running: true }, Mounts: [] });
  writeFileSync(docker, '#!/bin/sh\nexec /bin/cat "' + mounts + '"\n', {
    mode: 0o700,
  });
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
  const duringInspection = { run: () => {} };
  const inspectProcess = vi.fn(async () => {
    duringInspection.run();
    return {
      ...expectedProcess,
      parentPid: 1,
      uid: process.getuid!(),
      executable: node,
    };
  });
  vi.spyOn(serviceCollector, "createNativeBootstrapServiceReader").mockResolvedValue({
    readService: async () => `${service} = {\n\tpid = 123\n}`,
    inspectProcess,
  });
  return {
    f,
    config,
    sourceUpdates,
    plan,
    host,
    scripts,
    toolingFiles,
    save,
    duringInspection,
    inspectProcess,
  };
}

test.runIf(process.platform === "darwin")(
  "source tooling opt-in preserves exact config and recovery, including Factory and policy",
  async () => {
    const { f, config, sourceUpdates, plan, host, scripts, save } =
      await sourceToolingAdmissionFixture();
    const verify = () => verifyBootstrapConfiguration({ plan, ...host });
    expect(verify).not.toThrow();
    delete plan.sourceUpdateTooling;
    expect(verify).toThrow("outside its approved policy");
    save(plan.candidate.configuration.path, config);
    expect(verify).not.toThrow();
    plan.sourceUpdateTooling = true;
    expect(verify).toThrow("outside its approved policy");
    const candidate = { ...config, sourceUpdates: { ...sourceUpdates, toolingDirectory: scripts } };
    save(plan.candidate.configuration.path, candidate);
    expect(verify).not.toThrow();
    for (const field of Object.keys(sourceUpdates)) {
      save(plan.candidate.configuration.path, {
        ...candidate,
        sourceUpdates: {
          ...candidate.sourceUpdates,
          [field]: field === "integrationRef" ? "refs/heads/escape" : path.join(f.root, "escape"),
        },
      });
      expect(verify, field).toThrow("outside its approved policy");
    }
    for (const change of [
      { hostAgentTokenHash: "e".repeat(64) },
      {
        container: {
          ...config.container,
          factoryRuntimeAdoption: {
            ...config.container.factoryRuntimeAdoption,
            sha256: "e".repeat(64),
          },
        },
      },
      { restartApprovalPolicy: { hostRequestsAfter: "2026-10-12T12:00:00Z" } },
      { stateDir: path.join(f.root, "other-state") },
      { host: { ...config.host, endpoint: "127.0.0.1:9999" } },
    ]) {
      save(plan.candidate.configuration.path, { ...candidate, ...change });
      expect(verify).toThrow("outside its approved policy");
    }
    save(plan.candidate.configuration.path, candidate);
    save(plan.previous.configuration.path, candidate);
    expect(verify).toThrow("Previous coordinator configuration");
    save(plan.previous.configuration.path, config);
    const recovery = {
      ...plan.previous,
      configuration: save(path.join(f.root, "recovery.json"), candidate),
    };
    plan.compatibleRecovery = recovery;
    plan.automaticRecovery = "restore-compatible";
    expect(verify).toThrow("Recovery must preserve");
    save(recovery.configuration.path, config);
    expect(verify).not.toThrow();
    const withoutSource = { ...config, sourceUpdates: undefined };
    save(f.file, withoutSource);
    save(plan.previous.configuration.path, withoutSource);
    expect(verify).toThrow("requires existing source updates");
  },
);

test.runIf(process.platform === "darwin")(
  "source tooling admission rejects missing, alias, linked, writable and changed prepared paths without executing scripts",
  async () => {
    const { f, plan, host, scripts, toolingFiles, duringInspection, inspectProcess, save } =
      await sourceToolingAdmissionFixture();
    await expect(verifyBootstrapPlan(plan, host)).resolves.toBeUndefined();
    expect(inspectProcess).toHaveBeenCalledTimes(4);
    const file = toolingFiles[0]!;
    const bytes = readFileSync(file);
    const restore = () => {
      rmSync(file, { force: true });
      writeFileSync(file, bytes, { mode: 0o600 });
    };
    for (const required of toolingFiles) {
      const original = readFileSync(required);
      rmSync(required);
      await expect(verifyBootstrapPlan(plan, host)).rejects.toThrow("ENOENT");
      writeFileSync(required, original, { mode: 0o600 });
    }
    rmSync(file);
    symlinkSync(toolingFiles[1]!, file);
    await expect(verifyBootstrapPlan(plan, host)).rejects.toThrow("canonical");
    rmSync(file);
    linkSync(toolingFiles[1]!, file);
    await expect(verifyBootstrapPlan(plan, host)).rejects.toThrow("bounded regular file");
    restore();
    chmodSync(file, 0o622);
    await expect(verifyBootstrapPlan(plan, host)).rejects.toThrow();
    chmodSync(file, 0o600);
    const moved = scripts + "-real";
    nativeFs.renameSync(scripts, moved);
    symlinkSync(moved, scripts);
    await expect(verifyBootstrapPlan(plan, host)).rejects.toThrow("canonical directory");
    rmSync(scripts);
    nativeFs.renameSync(moved, scripts);
    save(path.join(f.root, "mounts.json"), {
      Id: host.containerId,
      State: { Running: true },
      Mounts: [{ Type: "bind", Source: scripts, RW: true }],
    });
    await expect(verifyBootstrapPlan(plan, host)).rejects.toThrow(
      "overlaps a writable container mount",
    );
    save(path.join(f.root, "mounts.json"), {
      Id: host.containerId,
      State: { Running: true },
      Mounts: [],
    });
    duringInspection.run = () => writeFileSync(file, "changed prepared tooling");
    // The final pass reuses the operation's retained tooling proof, whose
    // metadata assertion refuses before any second byte digest.
    await expect(verifyBootstrapPlan(plan, host)).rejects.toThrow(
      "Prepared artifact changed during verification",
    );
    restore();
    duringInspection.run = () => {
      rmSync(file, { force: true });
      symlinkSync(toolingFiles[1]!, file);
    };
    await expect(verifyBootstrapPlan(plan, host)).rejects.toThrow("canonical");
    duringInspection.run = () => {};
    restore();
    await expect(verifyBootstrapPlan(plan, host)).resolves.toBeUndefined();
  },
);

test("completed claimed recovery refreshes readiness without dispatch and broadcasts through deferral", async () => {
  const validation = Promise.withResolvers<BootstrapReviewService | undefined>();
  const initialize = vi.fn(() => validation.promise);
  const list = vi.fn(() => []);
  const prepare = vi.fn(async () => {
    throw new Error("Unexpected preparation");
  });
  const decide = vi.fn(async () => {
    throw new Error("Unexpected decision");
  });
  const recovered = { status: "approved", execution: { stage: "succeeded" } } as ReturnType<
    NonNullable<BootstrapReviewService["claimedRecovery"]>["list"]
  >[number];
  const claimed = { available: true, list: () => [recovered], prepare, decide };
  const wrapped = refreshBootstrapReviewAfterClaimedRecovery(
    { unavailableReason: "Recovery required", list, prepare, decide },
    claimed,
    initialize,
  );
  const service = deferBootstrapReview(async () => wrapped);
  await vi.waitFor(() => expect(service.claimedRecovery).toBeDefined());
  service.subscribeAvailability!(() => {
    throw new Error("Disconnected listener");
  });
  const notify = vi.fn();
  service.subscribeAvailability!(notify);
  service.claimedRecovery!.list();
  service.claimedRecovery!.list();
  await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
  await expect(service.prepare({} as never)).rejects.toThrow("Checking coordinator maintenance");
  expect(prepare).not.toHaveBeenCalled();
  expect(decide).not.toHaveBeenCalled();
  validation.resolve({ list, prepare, decide });
  await vi.waitFor(() =>
    expect(bootstrapReviewFeatures(service).coordinatorBootstrapReview).toBe(true),
  );
  service.list();
  expect(list).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(decide).not.toHaveBeenCalled();
});

test("failed post-recovery validation retries only on a later status read", async () => {
  const ready = {
    list: () => [],
    prepare: async () => {
      throw new Error("Unexpected preparation");
    },
    decide: async () => {
      throw new Error("Unexpected decision");
    },
  };
  const failed = { ...ready, unavailableReason: "Native exit unproven" };
  const initialize = vi
    .fn()
    .mockRejectedValueOnce(new Error("Not exited"))
    .mockResolvedValue(ready);
  const recovered = { status: "approved", execution: { stage: "succeeded" } } as ReturnType<
    NonNullable<BootstrapReviewService["claimedRecovery"]>["list"]
  >[number];
  const rows = [recovered];
  const service = refreshBootstrapReviewAfterClaimedRecovery(
    failed,
    { ...ready, available: true, list: () => rows },
    initialize,
  );
  expect(initialize).not.toHaveBeenCalled();
  service.claimedRecovery!.list();
  await vi.waitFor(() => expect(service.unavailableReason).toBe("Native exit unproven"));
  expect(initialize).toHaveBeenCalledTimes(1);
  service.claimedRecovery!.list();
  await vi.waitFor(() => expect(service.available).toBe(true));
  expect(initialize).toHaveBeenCalledTimes(2);
  service.claimedRecovery!.list();
  expect(initialize).toHaveBeenCalledTimes(2);
});

test("retained process exit accepts only independent absence or stable later native birth", async () => {
  const original = {
    pid: 123,
    parentPid: 1,
    uid: 501,
    bootId: randomUUID(),
    startIdentity: "100:123456",
    argumentsSha256: "a".repeat(64),
    executable: "/node",
  };
  const later = { ...original, startIdentity: "101:123456", executable: "/other" };
  const absent = vi.fn(async () => {});
  const noInspection = vi.fn(async () => {
    throw Error("must not inspect");
  });
  await verifyRetainedProcessExited(
    { verifyProcessExited: absent, inspectProcess: noInspection },
    original,
  );
  expect(noInspection).not.toHaveBeenCalled();
  const present = async () => {
    throw Error("PID exists");
  };
  await verifyRetainedProcessExited(
    { verifyProcessExited: present, inspectProcess: async () => later },
    original,
  );
  for (const current of [
    original,
    { ...original, argumentsSha256: "b".repeat(64) },
    { ...later, pid: 124 },
    { ...later, uid: 502 },
    { ...later, bootId: randomUUID() },
    { ...later, startIdentity: "99:123456" },
    { ...later, startIdentity: "101:1000000" },
  ]) {
    await expect(
      verifyRetainedProcessExited(
        { verifyProcessExited: present, inspectProcess: async () => current },
        original,
      ),
    ).rejects.toThrow();
  }
  let reads = 0;
  await expect(
    verifyRetainedProcessExited(
      {
        verifyProcessExited: present,
        inspectProcess: async () =>
          ++reads === 1 ? later : { ...later, startIdentity: "102:123456" },
      },
      original,
    ),
  ).rejects.toThrow("unproven");
  await expect(
    verifyRetainedProcessExited(
      {
        verifyProcessExited: present,
        inspectProcess: async () => {
          throw Error("inspection denied");
        },
      },
      original,
    ),
  ).rejects.toThrow("inspection denied");
  await expect(verifyRetainedProcessExited({}, original)).rejects.toThrow("native exit proof");
});

function expectedEarlyRecoveryCommands(interruption: string, service: string, launcher: string) {
  const commands: string[][] = [];
  if (interruption === "before-freeze" || interruption === "reboot-running-previous")
    commands.push(["kill", "SIGSTOP", service]);
  if (
    !interruption.startsWith("reboot-") ||
    interruption.startsWith("reboot-stopped-") ||
    interruption === "reboot-running-previous"
  )
    commands.push(["bootout", service]);
  commands.push(["bootstrap", `gui/${process.getuid!()}`, launcher]);
  return commands;
}

test("coordinator authority reads only its own permission and current installation credentials", () => {
  const f = fixture();
  const config = InstallationConfigSchema.parse(f.config);
  const preference = new DaemonAutomation(config.stateDir, true, "2026-10-15T00:00:00Z");
  expect(coordinatorAutomaticAuthority(config)).toBeNull();
  const daemon = preference.change({ expectedRevision: null, service: "host", enabled: true });
  expect(coordinatorAutomaticAuthority(config)).toBeNull();
  const enabled = preference.change({
    expectedRevision: daemon.revision,
    service: "coordinator",
    enabled: true,
  });
  const authority = coordinatorAutomaticAuthority(config)!;
  expect(authority.policyActivatedAt).toBe(enabled.services!.coordinator);
  expect(authority.credentialBinding).toMatch(/^[a-f0-9]{64}$/);
  for (const key of [
    "hostAgentTokenHash",
    "containerAgentTokenHash",
    "ownerPasswordHash",
  ] as const) {
    const changed = coordinatorAutomaticAuthority({ ...config, [key]: "changed-credential" });
    expect(changed?.credentialBinding).not.toBe(authority.credentialBinding);
  }
  const unrelated = preference.change({
    expectedRevision: enabled.revision,
    service: "host",
    enabled: false,
  });
  expect(coordinatorAutomaticAuthority(config)).toEqual(authority);
  preference.change({
    expectedRevision: unrelated.revision,
    service: "coordinator",
    enabled: false,
  });
  expect(coordinatorAutomaticAuthority(config)).toBeNull();
});

function runningBootIdentity(interruption: string, oldBoot: string) {
  if (!interruption.startsWith("reboot-running-")) return {};
  return {
    pid: 333,
    startIdentity: "1234:8888",
    ...(interruption === "reboot-running-unrelated" ? { argumentsSha256: "f".repeat(64) } : {}),
    ...(interruption === "reboot-running-wrong-boot" ? { bootId: oldBoot } : {}),
  };
}

async function boundedMountReadFixture() {
  const { inspectBootstrapWritableMountRoots } = await import("./coordinator-bootstrap-host.js");
  const input = {
    docker: "/protected/docker",
    socket: "/private/docker.sock",
    containerId: "a".repeat(64),
  };
  const controller = new AbortController();
  let now = 0;
  let onRead: (
    args: readonly string[],
    limits: import("./coordinator-bootstrap-host.js").BootstrapMountInspectionReadLimits,
  ) => void = () => {};
  let onReserve: () => void = () => {};
  const reservations: number[] = [];
  const calls: Array<{
    file: string;
    args: readonly string[];
    limits: import("./coordinator-bootstrap-host.js").BootstrapMountInspectionReadLimits;
  }> = [];
  const collection = {
    signal: controller.signal,
    remaining(bound = 0) {
      expect(this).toBe(collection);
      reservations.push(bound);
      onReserve();
      return 30_000 - now;
    },
  };
  const command: import("./coordinator-bootstrap-host.js").BootstrapMountInspectionCommand = {
    async execute(file, args, limits) {
      expect(this).toBe(command);
      calls.push({ file, args, limits });
      onRead(args, limits);
      const payload =
        args[2] === "container"
          ? {
              Id: "a".repeat(64),
              State: { Running: true },
              Mounts: [
                { Type: "bind", Source: "/private/guest", RW: true },
                { Type: "volume", Name: "state", RW: true },
                { Type: "volume", Name: "state", RW: true },
                { Type: "volume", Name: "cache", RW: true },
              ],
            }
          : { Name: args.at(-1), Driver: "local", Scope: "local", Options: null };
      return { stdout: JSON.stringify(payload) };
    },
  };
  const options = { collection, command };
  return {
    input,
    options,
    collection,
    command,
    controller,
    calls,
    reservations,
    inspect: () => inspectBootstrapWritableMountRoots(input, options),
    legacy: () => inspectBootstrapWritableMountRoots(input, { command }),
    advance(ms: number) {
      now += ms;
    },
    onRead(callback: typeof onRead) {
      onRead = callback;
    },
    onReserve(callback: typeof onReserve) {
      onReserve = callback;
    },
  };
}

test.runIf(process.platform === "darwin")(
  "bounded mount reads preserve fixed commands, original receivers and full read bounds",
  async () => {
    const f = await boundedMountReadFixture();
    expect(await f.inspect()).toEqual(["/private/guest"]);
    expect(f.reservations).toEqual([10_000, 0, 10_000, 0, 10_000, 0, 0]);
    expect(f.calls.map((call) => call.args)).toEqual([
      [
        "--host",
        "unix:///private/docker.sock",
        "container",
        "inspect",
        "--format",
        '{"Id":{{json .Id}},"State":{"Running":{{json .State.Running}}},"Mounts":{{json .Mounts}}}',
        "a".repeat(64),
      ],
      [
        "--host",
        "unix:///private/docker.sock",
        "volume",
        "inspect",
        "--format",
        "{{json .}}",
        "state",
      ],
      [
        "--host",
        "unix:///private/docker.sock",
        "volume",
        "inspect",
        "--format",
        "{{json .}}",
        "cache",
      ],
    ]);
    for (const call of f.calls) {
      expect(call.file).toBe("/protected/docker");
      expect(call.limits).toEqual({
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        signal: f.controller.signal,
      });
      expect(Object.isFrozen(call.limits)).toBe(true);
      expect(Object.isFrozen(call.limits.env)).toBe(true);
      expect(Object.isFrozen(call.args)).toBe(true);
    }
  },
);

test.runIf(process.platform === "darwin")(
  "bounded mount reads do not start a volume read without the full ten seconds",
  async () => {
    const f = await boundedMountReadFixture();
    f.onRead(() => f.advance(21_000));
    await expect(f.inspect()).rejects.toThrow("deadline exceeded");
    expect(f.calls).toHaveLength(1);
  },
);

test.runIf(process.platform === "darwin")(
  "bounded mount reads reject a late container result before starting another command",
  async () => {
    const f = await boundedMountReadFixture();
    f.onRead(() => f.advance(30_000));
    await expect(f.inspect()).rejects.toThrow("deadline exceeded");
    expect(f.calls).toHaveLength(1);
  },
);

test.runIf(process.platform === "darwin").each(["before", "during"] as const)(
  "bounded mount reads retain caller cancellation %s native return",
  async (phase) => {
    const f = await boundedMountReadFixture();
    if (phase === "before") f.controller.abort(new Error("cancel mount observation"));
    else
      f.onRead(() => {
        if (f.calls.length === 2) f.controller.abort(new Error("cancel mount observation"));
      });
    await expect(f.inspect()).rejects.toThrow("cancel mount observation");
    expect(f.calls).toHaveLength(phase === "before" ? 0 : 2);
  },
);

test
  .runIf(process.platform === "darwin")
  .each(["reader", "remaining", "collection", "signal", "target", "socket"] as const)(
  "bounded mount reads reject retained %s substitution",
  async (change) => {
    const f = await boundedMountReadFixture();
    f.onRead(() => {
      if (change === "reader") f.command.execute = async () => ({ stdout: "{}" });
      if (change === "remaining") f.collection.remaining = () => 60_000;
      if (change === "collection") f.options.collection = { ...f.collection };
      if (change === "signal") f.collection.signal = new AbortController().signal;
      if (change === "target") f.input.containerId = "b".repeat(64);
      if (change === "socket") f.input.socket = "/private/other.sock";
    });
    await expect(f.inspect()).rejects.toThrow("bindings changed");
    expect(f.calls).toHaveLength(1);
  },
);

test.runIf(process.platform === "darwin")(
  "bounded mount reads recheck callback mutations before invoking the command",
  async () => {
    const f = await boundedMountReadFixture();
    f.onReserve(() => {
      f.command.execute = async () => ({ stdout: "{}" });
    });
    await expect(f.inspect()).rejects.toThrow("bindings changed");
    expect(f.calls).toHaveLength(0);
  },
);

test.runIf(process.platform === "darwin")(
  "bounded mount reads keep declared command limits immutable",
  async () => {
    const f = await boundedMountReadFixture();
    f.onRead((_args, limits) => {
      limits.timeout = 60_000;
    });
    await expect(f.inspect()).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(1);
  },
);

test.runIf(process.platform === "darwin")(
  "bounded mount reads preserve the reference-absent command behavior",
  async () => {
    const f = await boundedMountReadFixture();
    expect(await f.legacy()).toEqual(["/private/guest"]);
    expect(f.reservations).toEqual([]);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0].limits).toEqual({
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  },
);

test.runIf(process.platform === "darwin")(
  "bounded mount reads retain the original signal assertion",
  async () => {
    const f = await boundedMountReadFixture();
    f.onRead(() => {
      f.controller.signal.throwIfAborted = () => undefined;
      f.controller.abort(new Error("cancelled with substituted signal assertion"));
    });
    await expect(f.inspect()).rejects.toThrow("bindings changed");
    expect(f.calls).toHaveLength(1);
  },
);
