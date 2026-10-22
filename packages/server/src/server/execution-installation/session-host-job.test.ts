import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionHostPlan } from "@getpaseo/protocol/session-host-maintenance";
import { expect, test } from "vitest";
import net from "node:net";
import {
  preparePrivateDirectory,
  rotateSessionHostToken,
  sessionHostPaths,
} from "../session-host/host-files.js";
import { bootoutJob, LaunchctlError, type CommandRunner } from "../session-host/launchd.js";
import type { InstallationConfig } from "./config.js";
import {
  FORCED_STOP_AFTER_MS,
  RESTART_ANSWER_DEADLINE_MS,
  SESSION_HOST_ENTRYPOINT,
  SessionHostJobError,
  deriveSessionHostPlan,
  inspectSessionHost,
  installSessionHost,
  readLaunchdJob,
  removeSessionHost,
  renderPlannedPlist,
  restartSessionHost,
  sessionHostLabel,
  type SessionHostPorts,
} from "./session-host-job.js";
import { classifyQueryFailure, createNativeSessionHostPorts } from "./session-host-job-native.js";
import { SessionHostClientError } from "../session-host/client.js";

// Every effect is fake: no launchctl, plutil, files or processes outside this test.
const INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
const UID = process.getuid?.() ?? 501;
const CURRENT = "/fixture/installation/current";
const HOME = "/fixture/installation/paseo-home";
const AGENTS = "/fixture/LaunchAgents";
const HOST_PLIST = `${AGENTS}/local.vorteo.test.host.plist`;
const LABEL = sessionHostLabel(INSTALLATION_ID);
const PLIST = `${AGENTS}/${LABEL}.plist`;
const ENTRYPOINT = `${CURRENT}/${SESSION_HOST_ENTRYPOINT}`;
const HOST_COMMAND = `/usr/local/bin/node ${ENTRYPOINT}`;

function testConfig(overrides: Partial<InstallationConfig> = {}): InstallationConfig {
  return {
    public: {
      version: 1,
      installationId: INSTALLATION_ID,
      origin: "https://installation.example",
      environments: [
        { kind: "host", serverId: "host", endpoint: "host.example", useTls: true },
        { kind: "container", serverId: "container", endpoint: "container.example", useTls: true },
      ],
    },
    listenPort: 6770,
    webDistDir: "/fixture/web",
    stateDir: "/fixture/state",
    ownerPasswordHash: "$2-test",
    hostAgentTokenHash: "0".repeat(64),
    containerAgentTokenHash: "1".repeat(64),
    container: { endpoint: "127.0.0.1:6768", password: "container-test" },
    host: {
      endpoint: "127.0.0.1:6771",
      password: "host-test",
      launchdService: `gui/${UID}/local.vorteo.test.host`,
      startupValidation: {
        node: "/usr/local/bin/node",
        entrypoint: `${CURRENT}/packages/server/dist/scripts/supervisor-entrypoint.js`,
        home: HOME,
      },
    },
    sourceUpdates: {
      sourceRepository: "/fixture/source",
      releaseRoot: "/fixture/installation/releases",
      currentReleaseLink: CURRENT,
      webDirectory: "/fixture/web",
      toolingDirectory: "/fixture/tooling",
      integrationRef: "refs/heads/main",
    },
    ...overrides,
  };
}

interface FakeHost {
  pid: number;
  sessions: number;
  answers: boolean;
  /** Closes the coordinator's connection before greeting, as at its connection limit. */
  refuses?: boolean;
  /** Keeps running after bootout until SIGKILL. */
  survivesBootout?: boolean;
}

/** launchd, the host process and the files, as the job's ports observe them. */
function fakeInstallation() {
  const state = {
    files: new Map<string, Buffer>([
      [
        HOST_PLIST,
        Buffer.from(
          JSON.stringify({
            EnvironmentVariables: {
              HOME: "/Users/owner",
              PATH: "/usr/local/bin:/usr/bin:/bin",
              PASEO_HOME: HOME,
              VORTEO_INSTALLATION_CLIENT_CONFIG: "/fixture/private/client.json",
            },
          }),
        ),
      ],
    ]),
    entrypointPresent: true,
    loaded: null as { pid: number | null; runs: number; lastExit: number | null } | null,
    host: null as FakeHost | null,
    /** What a bootstrap starts; null starts a host that never answers. */
    starts: { pid: 4242, sessions: 0, answers: true } as FakeHost | null,
    setting: false,
    /** What a SIGTERM from launchctl kill does to the host: exit and relaunch, or nothing. */
    ignoresTerm: false,
    /** The pid launchd gives the next relaunch after a kill. */
    nextPid: 4343,
    clock: 1_000_000,
    calls: [] as string[],
    commands: new Map<number, string>([[4242, HOST_COMMAND]]),
    queries: 0,
    onSleep: undefined as (() => void) | undefined,
  };
  /** plutil reads the Host plist's environment and a written plist's label. */
  const plutil = (args: readonly string[]) => {
    if (args[0] === "-convert") {
      const plist = state.files.get(args[4]!);
      if (args[4] !== HOST_PLIST || !plist) throw new LaunchctlError(args, 1, "");
      return { stdout: plist.toString() };
    }
    const plist = state.files.get(args[5]!)?.toString() ?? "";
    const label = /<key>Label<\/key>\n\t<string>([^<]+)<\/string>/.exec(plist)?.[1];
    if (args[0] !== "-extract" || !label) throw new LaunchctlError(args, 1, "");
    return { stdout: `${label}\n` };
  };
  const bootstrap = (args: readonly string[]) => {
    if (args[1] !== `gui/${UID}` || args[2] !== PLIST) throw new Error("Unexpected bootstrap");
    if (state.loaded) throw new LaunchctlError(args, 5, "already loaded");
    const started = state.starts ? { ...state.starts } : null;
    state.loaded = { pid: started?.pid ?? null, runs: 1, lastExit: null };
    state.host = started;
    return { stdout: "" };
  };
  /** launchctl print and bootout for the session host label only. */
  const loadedJob = (args: readonly string[]) => {
    const [verb, target] = args;
    if (target !== `gui/${UID}/${LABEL}`) throw new Error(`Unexpected launchctl target ${target}`);
    const loaded = state.loaded;
    if (!loaded) throw new LaunchctlError(args, 113, "Could not find service");
    if (verb === "bootout") {
      state.loaded = null;
      if (state.host && !state.host.survivesBootout) state.host = null;
      return { stdout: "" };
    }
    if (verb === "kill" || verb === "kickstart") {
      // A SIGTERM the host honours, or a SIGKILL, ends it; KeepAlive relaunches it under a new pid.
      const signal = verb === "kill" ? args[2] : null;
      if (verb === "kickstart" || signal === "SIGKILL" || !state.ignoresTerm) {
        const started = state.starts ? { ...state.starts, pid: state.nextPid } : null;
        state.nextPid += 1;
        loaded.pid = started?.pid ?? null;
        loaded.runs += 1;
        state.host = started;
        if (started) state.commands.set(started.pid, HOST_COMMAND);
      }
      return { stdout: "" };
    }
    if (verb !== "print") throw new Error(`Unexpected launchctl ${verb}`);
    const pid = loaded.pid === null ? "" : `\tpid = ${loaded.pid}\n`;
    const exit = loaded.lastExit === null ? "(never exited)" : String(loaded.lastExit);
    return {
      stdout:
        `gui/${UID}/${LABEL} = {\n\tactive count = 1\n\truns = ${loaded.runs}\n${pid}` +
        `\tlast exit code = ${exit}\n\tspawn type = standard\n\tresource coalition = {\n` +
        `\t\tpid = 1\n\t}\n}\n`,
    };
  };
  const run: CommandRunner = async (file, args) => {
    if (file === "/usr/bin/plutil") return plutil(args);
    if (file !== "/bin/launchctl") throw new Error(`Unexpected command ${file}`);
    if (args[0] === "kill") {
      state.calls.push(`launchctl kill ${args[1]} ${args[2]}`);
      return loadedJob([args[0], args[2]!, args[1]!]);
    }
    if (args[0] !== "print") state.calls.push(`launchctl ${args[0]} ${args[1]}`);
    return args[0] === "bootstrap" ? bootstrap(args) : loadedJob(args);
  };
  const ports: SessionHostPorts = {
    uid: UID,
    launchAgentsDirectory: AGENTS,
    run,
    readFile: async (file) => state.files.get(file) ?? null,
    writePrivateFile: async (file, data) => {
      state.calls.push(`write ${file}`);
      state.files.set(file, Buffer.from(data));
    },
    removeFile: async (file) => {
      state.calls.push(`remove ${file}`);
      state.files.delete(file);
    },
    exists: async (file) =>
      state.files.has(file) || (file === ENTRYPOINT && state.entrypointPresent),
    preparePrivateDirectory: async (directory) => {
      state.calls.push(`prepare ${directory}`);
    },
    queryHost: async (paseoHome) => {
      expect(paseoHome).toBe(HOME);
      state.queries += 1;
      const host = state.host;
      if (host?.refuses) return "refused";
      return host?.answers ? { pid: host.pid, release: "fixture", sessions: host.sessions } : null;
    },
    hostLock: async () =>
      state.host ? { state: "alive", pid: state.host.pid } : { state: "gone", pid: null },
    processCommand: async (pid) => state.commands.get(pid) ?? null,
    kill: (pid, signal) => {
      state.calls.push(`kill ${pid} ${signal}`);
      if (signal === "SIGKILL" && state.host?.pid === pid) {
        // Direct SIGKILL of a job's process: launchd relaunches it like a kill through launchctl.
        if (state.loaded) {
          const started = state.starts ? { ...state.starts, pid: state.nextPid } : null;
          state.nextPid += 1;
          state.loaded.pid = started?.pid ?? null;
          state.loaded.runs += 1;
          state.host = started;
          if (started) state.commands.set(started.pid, HOST_COMMAND);
        } else state.host = null;
      }
    },
    settingEnabled: async (paseoHome) => {
      expect(paseoHome).toBe(HOME);
      return state.setting;
    },
    now: () => state.clock,
    sleep: async (ms) => {
      state.clock += ms;
      state.onSleep?.();
    },
  };
  return { state, ports };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function plan(
  ports: SessionHostPorts,
  operation: "session-host-install" | "session-host-remove" | "session-host-restart",
) {
  return deriveSessionHostPlan({ config: testConfig(), operation, ports });
}

/** Installs through the fake launchd, as an earlier approved operation would have. */
async function installed(fake: ReturnType<typeof fakeInstallation>) {
  await installSessionHost({
    plan: await plan(fake.ports, "session-host-install"),
    ports: fake.ports,
    reportStage: () => {},
  });
  fake.state.calls.length = 0;
}

const stages = () => {
  const reported: string[] = [];
  return { reported, reportStage: (stage: string) => reported.push(stage) };
};

test("the install plan runs the current release with only HOME, PASEO_HOME and PATH", async () => {
  const { ports } = fakeInstallation();
  const install = await plan(ports, "session-host-install");
  expect(install).toEqual({
    version: 1,
    operation: "session-host-install",
    installationId: INSTALLATION_ID,
    label: `local.vorteo.${INSTALLATION_ID}.session-host`,
    serviceDomain: `gui/${UID}`,
    plistPath: PLIST,
    plistSha256: sha256(renderPlannedPlist(install)),
    node: "/usr/local/bin/node",
    entrypoint: ENTRYPOINT,
    paseoHome: HOME,
    logPath: `${HOME}/session-host/launchd.log`,
    workingDirectory: `${CURRENT}/packages/server`,
    environment: { HOME: "/Users/owner", PATH: "/usr/local/bin:/usr/bin:/bin" },
  });
  const plist = renderPlannedPlist(install);
  const variables = /<key>EnvironmentVariables<\/key>\n\t<dict>\n([\s\S]*?)\t<\/dict>/.exec(
    plist,
  )?.[1];
  expect([...(variables ?? "").matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])).toEqual([
    "HOME",
    "PASEO_HOME",
    "PATH",
  ]);
  expect(plist).not.toContain("VORTEO_INSTALLATION_CLIENT_CONFIG");
  expect(plist).toContain(`<string>${ENTRYPOINT}</string>`);
});

test("plans require source updates, Host startup validation and the Host job's user", async () => {
  const { ports } = fakeInstallation();
  const refuse = (config: InstallationConfig) =>
    expect(
      deriveSessionHostPlan({ config, operation: "session-host-install", ports }),
    ).rejects.toBeInstanceOf(SessionHostJobError);
  await refuse(testConfig({ sourceUpdates: undefined }));
  const config = testConfig();
  await refuse({ ...config, host: { ...config.host, startupValidation: undefined } });
  await refuse({ ...config, host: { ...config.host, launchdService: `gui/${UID + 1}/x.host` } });
  // The host must serve the same home as the Host job's workers.
  await refuse({
    ...config,
    host: {
      ...config.host,
      startupValidation: { ...config.host.startupValidation!, home: "/fixture/other-home" },
    },
  });
});

test("a remove plan binds the plist it removes, or none", async () => {
  const fake = fakeInstallation();
  expect((await plan(fake.ports, "session-host-remove")).plistSha256).toBeNull();
  await installed(fake);
  const remove = await plan(fake.ports, "session-host-remove");
  expect(remove.plistSha256).toBe(sha256(fake.state.files.get(PLIST)!));
});

test("install writes the reviewed plist, waits for the host and never writes the setting", async () => {
  const { state, ports } = fakeInstallation();
  const install = await plan(ports, "session-host-install");
  const progress = stages();
  const result = await installSessionHost({ plan: install, ports, ...progress });
  expect(result.host).toEqual({ pid: 4242, release: "fixture" });
  expect(result.detail).toContain("The durable sessions setting was not changed.");
  expect(progress.reported).toEqual(["applying", "verifying"]);
  expect(state.calls).toEqual([
    `prepare ${HOME}/session-host`,
    `write ${PLIST}`,
    `launchctl bootstrap gui/${UID}`,
  ]);
  expect(sha256(state.files.get(PLIST)!)).toBe(install.plistSha256);
});

test("retrying an install over the identical loaded job completes it without changes", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  const result = await installSessionHost({
    plan: await plan(fake.ports, "session-host-install"),
    ports: fake.ports,
    reportStage: () => {},
  });
  expect(result.host?.pid).toBe(4242);
  expect(fake.state.calls).toEqual([]);
});

test("install refuses any other leftover and points to removal", async () => {
  const { state, ports } = fakeInstallation();
  const install = await plan(ports, "session-host-install");
  state.files.set(PLIST, Buffer.from("an older plist"));
  state.loaded = { pid: 99, runs: 3, lastExit: 0 };
  await expect(installSessionHost({ plan: install, ports, reportStage: () => {} })).rejects.toThrow(
    "A different session host job is installed. Remove it from Installation controls first.",
  );
  state.files.delete(PLIST);
  await expect(installSessionHost({ plan: install, ports, reportStage: () => {} })).rejects.toThrow(
    "loaded without its plist",
  );
  expect(state.calls).toEqual([]);
});

test("install refuses a release without the session host or a changed plan", async () => {
  const { state, ports } = fakeInstallation();
  const install = await plan(ports, "session-host-install");
  state.entrypointPresent = false;
  await expect(installSessionHost({ plan: install, ports, reportStage: () => {} })).rejects.toThrow(
    "The selected release has no session host.",
  );
  state.entrypointPresent = true;
  await expect(
    installSessionHost({
      plan: { ...install, environment: { ...install.environment, PATH: "/tmp/evil" } },
      ports,
      reportStage: () => {},
    }),
  ).rejects.toThrow("The planned plist changed.");
  expect(state.calls).toEqual([]);
});

test("a host that never answers is booted out and its plist deleted", async () => {
  const { state, ports } = fakeInstallation();
  state.starts = null;
  const install = await plan(ports, "session-host-install");
  const started = state.clock;
  await expect(installSessionHost({ plan: install, ports, reportStage: () => {} })).rejects.toThrow(
    "The session host did not answer after installation. The job was removed again",
  );
  expect(state.clock - started).toBeGreaterThanOrEqual(60_000);
  expect(state.calls.slice(-2)).toEqual([
    `launchctl bootout gui/${UID}/${LABEL}`,
    `remove ${PLIST}`,
  ]);
  expect(state.files.has(PLIST)).toBe(false);
});

test("a watchdog kill after the start fails the install and removes the job", async () => {
  const { state, ports } = fakeInstallation();
  const install = await plan(ports, "session-host-install");
  state.files.set(
    `${HOME}/session-host/host.log`,
    Buffer.from(
      `${JSON.stringify({ time: state.clock - 1, msg: "Session host watchdog is killing the host" })}\n` +
        `${JSON.stringify({ time: state.clock, msg: "Session host watchdog is killing the host" })}\n`,
    ),
  );
  await expect(installSessionHost({ plan: install, ports, reportStage: () => {} })).rejects.toThrow(
    "The session host watchdog killed the host during the install check. The job was removed again",
  );
  expect(state.files.has(PLIST)).toBe(false);
});

test("an earlier watchdog kill does not fail a new install", async () => {
  const { state, ports } = fakeInstallation();
  state.files.set(
    `${HOME}/session-host/host.log`,
    Buffer.from(
      `${JSON.stringify({ time: state.clock - 1, msg: "Session host watchdog is killing the host" })}\n`,
    ),
  );
  const install = await plan(ports, "session-host-install");
  await expect(
    installSessionHost({ plan: install, ports, reportStage: () => {} }),
  ).resolves.toMatchObject({ host: { pid: 4242 } });
});

test("remove boots out an idle host, waits for it to exit and deletes the plist", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  const progress = stages();
  const result = await removeSessionHost({
    plan: await plan(fake.ports, "session-host-remove"),
    ports: fake.ports,
    ...progress,
  });
  expect(result).toEqual({ detail: "The session host job is removed.", forced: false });
  expect(progress.reported).toEqual(["applying", "verifying"]);
  // The restart marker is removed too, so a leftover never makes workers wait for a removed host.
  expect(fake.state.calls).toEqual([
    `launchctl bootout gui/${UID}/${LABEL}`,
    `remove ${PLIST}`,
    `remove ${HOME}/session-host/restarting`,
  ]);
});

test("remove is refused while the setting is on, sessions run or the plist changed", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  const remove = await plan(fake.ports, "session-host-remove");
  const attempt = () =>
    removeSessionHost({ plan: remove, ports: fake.ports, reportStage: () => {} });
  fake.state.setting = true;
  await expect(attempt()).rejects.toThrow("Turn the durable sessions setting off");
  fake.state.setting = false;
  fake.state.host!.sessions = 2;
  await expect(attempt()).rejects.toThrow("still runs 2 hosted sessions");
  fake.state.host!.sessions = 0;
  fake.state.files.set(PLIST, Buffer.from("edited"));
  await expect(attempt()).rejects.toThrow("The session host plist changed.");
  expect(fake.state.calls).toEqual([]);
  expect(fake.state.loaded).not.toBeNull();
});

const MARKER = `${HOME}/session-host/restarting`;

test("restart stops the host through launchd, marks the restart for workers and waits for the new host", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  fake.state.host!.sessions = 3;
  const progress = stages();
  const result = await restartSessionHost({
    plan: await plan(fake.ports, "session-host-restart"),
    ports: fake.ports,
    ...progress,
  });
  expect(result.host).toEqual({ pid: 4343, release: "fixture" });
  expect(result.previousHost).toEqual({ pid: 4242, release: "fixture", sessions: 3 });
  expect(result.detail).toContain("process 4242 on release fixture stopped with 3 hosted sessions");
  expect(result.detail).toContain("process 4343 on release fixture answers");
  expect(progress.reported).toEqual(["applying", "verifying"]);
  // The marker goes down before the signal and comes up again once the new host answers; the
  // plist and the job are untouched.
  expect(fake.state.calls).toEqual([
    `write ${MARKER}`,
    `launchctl kill SIGTERM gui/${UID}/${LABEL}`,
    `remove ${MARKER}`,
  ]);
  expect(fake.state.files.has(PLIST)).toBe(true);
  expect(fake.state.loaded).toMatchObject({ pid: 4343, runs: 2 });
});

test("a host that ignores the stop is killed once verified, and the restart still completes", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  fake.state.ignoresTerm = true;
  const result = await restartSessionHost({
    plan: await plan(fake.ports, "session-host-restart"),
    ports: fake.ports,
    reportStage: () => {},
  });
  expect(result.host).toEqual({ pid: 4343, release: "fixture" });
  expect(result.detail).toContain("by force after ignoring the stop");
  expect(fake.state.calls).toEqual([
    `write ${MARKER}`,
    `launchctl kill SIGTERM gui/${UID}/${LABEL}`,
    "kill 4242 SIGKILL",
    `remove ${MARKER}`,
  ]);
});

test("a restart whose new host never answers removes the marker and fails, leaving the job loaded", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  fake.state.starts = null;
  const started = fake.state.clock;
  await expect(
    restartSessionHost({
      plan: await plan(fake.ports, "session-host-restart"),
      ports: fake.ports,
      reportStage: () => {},
    }),
  ).rejects.toThrow("did not answer under a new process within 90 seconds");
  expect(fake.state.clock - started).toBeGreaterThanOrEqual(RESTART_ANSWER_DEADLINE_MS);
  expect(fake.state.files.has(MARKER)).toBe(false);
  expect(fake.state.files.has(PLIST)).toBe(true);
  expect(fake.state.loaded).not.toBeNull();
});

test("restart is refused without an installed, loaded job on a release with the session host", async () => {
  const fake = fakeInstallation();
  await expect(
    restartSessionHost({
      plan: await plan(fake.ports, "session-host-restart"),
      ports: fake.ports,
      reportStage: () => {},
    }),
  ).rejects.toThrow("not installed, so there is nothing to restart");
  await installed(fake);
  const restart = await plan(fake.ports, "session-host-restart");
  fake.state.entrypointPresent = false;
  await expect(
    restartSessionHost({ plan: restart, ports: fake.ports, reportStage: () => {} }),
  ).rejects.toThrow("has no session host");
  fake.state.entrypointPresent = true;
  fake.state.files.set(PLIST, Buffer.from("edited"));
  await expect(
    restartSessionHost({ plan: restart, ports: fake.ports, reportStage: () => {} }),
  ).rejects.toThrow("The session host plist changed.");
  expect(fake.state.calls).toEqual([]);
  expect(fake.state.host).toMatchObject({ pid: 4242 });
});

test("a silent host is stopped only after the workers' alive window, and the stop is recorded", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  fake.state.host!.answers = false;
  const remove = await plan(fake.ports, "session-host-remove");
  const started = fake.state.clock;
  let bootoutAt: number | null = null;
  const run = fake.ports.run!;
  fake.ports.run = async (file, args) => {
    if (args[0] === "bootout") bootoutAt = fake.state.clock;
    return run(file, args);
  };
  const result = await removeSessionHost({
    plan: remove,
    ports: fake.ports,
    reportStage: () => {},
  });
  expect(result.forced).toBe(true);
  expect(result.detail).toContain("did not answer for five minutes");
  expect(bootoutAt! - started).toBeGreaterThanOrEqual(FORCED_STOP_AFTER_MS);
  expect(fake.state.files.has(PLIST)).toBe(false);
});

test("a host that refuses the coordinator is alive, so it is never stopped by force", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  fake.state.host!.refuses = true;
  const started = fake.state.clock;
  await expect(
    removeSessionHost({
      plan: await plan(fake.ports, "session-host-remove"),
      ports: fake.ports,
      reportStage: () => {},
    }),
  ).rejects.toThrow("The session host keeps refusing connections and may still run sessions.");
  expect(fake.state.clock - started).toBeGreaterThanOrEqual(FORCED_STOP_AFTER_MS);
  expect(fake.state.calls).toEqual([]);
  expect(fake.state.files.has(PLIST)).toBe(true);
});

test("turning the setting on while a silent host is awaited keeps the job", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  fake.state.host!.answers = false;
  const remove = await plan(fake.ports, "session-host-remove");
  const started = fake.state.clock;
  fake.state.onSleep = () => {
    if (fake.state.clock - started >= 60_000) fake.state.setting = true;
  };
  await expect(
    removeSessionHost({ plan: remove, ports: fake.ports, reportStage: () => {} }),
  ).rejects.toThrow(
    "The durable sessions setting was turned on. The session host job was not removed.",
  );
  expect(fake.state.calls).toEqual([]);
  expect(fake.state.files.has(PLIST)).toBe(true);
});

test("a job whose host is gone is removed at once, even when launchd no longer lists it", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  fake.state.host = null;
  fake.state.loaded = null;
  const started = fake.state.clock;
  const result = await removeSessionHost({
    plan: await plan(fake.ports, "session-host-remove"),
    ports: fake.ports,
    reportStage: () => {},
  });
  expect(result.forced).toBe(false);
  expect(fake.state.clock).toBe(started);
  expect(fake.state.calls).toEqual([
    `launchctl bootout gui/${UID}/${LABEL}`,
    `remove ${PLIST}`,
    `remove ${HOME}/session-host/restarting`,
  ]);
});

test("a host that survives bootout is killed only after its command is verified", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  fake.state.host!.survivesBootout = true;
  const result = await removeSessionHost({
    plan: await plan(fake.ports, "session-host-remove"),
    ports: fake.ports,
    reportStage: () => {},
  });
  expect(result.forced).toBe(false);
  expect(fake.state.calls).toEqual([
    `launchctl bootout gui/${UID}/${LABEL}`,
    "kill 4242 SIGKILL",
    `remove ${PLIST}`,
    `remove ${HOME}/session-host/restarting`,
  ]);
});

test("an unverifiable lock holder is never killed and the plist is kept", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  fake.state.host!.survivesBootout = true;
  fake.state.commands.set(4242, "/usr/bin/some-other-program");
  await expect(
    removeSessionHost({
      plan: await plan(fake.ports, "session-host-remove"),
      ports: fake.ports,
      reportStage: () => {},
    }),
  ).rejects.toThrow("Nothing was killed.");
  expect(fake.state.calls).toEqual([`launchctl bootout gui/${UID}/${LABEL}`]);
  expect(fake.state.files.has(PLIST)).toBe(true);
});

test("status without detail never greets the host", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  const queries = fake.state.queries;
  await expect(
    inspectSessionHost({ config: testConfig(), ports: fake.ports, detail: false }),
  ).resolves.toEqual({ supported: true, installed: true });
  expect(fake.state.queries).toBe(queries);
});

test("status detail reports the plist, launchd's record, the host and the setting", async () => {
  const fake = fakeInstallation();
  await installed(fake);
  fake.state.host!.sessions = 3;
  fake.state.setting = true;
  const status = await inspectSessionHost({
    config: testConfig(),
    ports: fake.ports,
    detail: true,
  });
  expect(status).toEqual({
    supported: true,
    installed: true,
    detail: {
      label: LABEL,
      plist: "matching",
      loaded: true,
      pid: 4242,
      lastExitStatus: null,
      runs: 1,
      host: { pid: 4242, release: "fixture", sessions: 3 },
      settingEnabled: true,
      observedAt: new Date(fake.state.clock).toISOString(),
    },
  });
  fake.state.files.set(PLIST, Buffer.from("edited"));
  fake.state.entrypointPresent = false;
  const changed = await inspectSessionHost({
    config: testConfig(),
    ports: fake.ports,
    detail: true,
  });
  expect(changed).toMatchObject({ supported: false, detail: { plist: "different" } });
});

test("only a missing listener or a greeting that never arrives counts as silence", () => {
  for (const code of [
    "disconnected",
    "version",
    "unauthorized",
    "invalid_frame",
    "not_found",
  ] as const)
    expect(classifyQueryFailure(new SessionHostClientError(code, "live host")), code).toBe(
      "refused",
    );
  for (const code of ["unavailable", "timeout"] as const)
    expect(classifyQueryFailure(new SessionHostClientError(code, "silent")), code).toBeNull();
  expect(classifyQueryFailure(new Error("token unreadable"))).toBeNull();
});

/** A stand-in host on a real socket: greets with the given version, then ignores requests. */
function fakeHost(greeting: ((socket: net.Socket) => void) | null) {
  return net.createServer((socket) => {
    if (!greeting) {
      socket.destroy();
      return;
    }
    socket.once("data", () => greeting(socket));
  });
}

function greet(protocolVersion: number) {
  return (socket: net.Socket) =>
    socket.write(
      `${JSON.stringify({
        type: "hello",
        protocolVersion,
        host: { id: "fake-host", pid: process.pid, startedAt: new Date().toISOString() },
        mcpToken: "fake-tool-token",
      })}\n`,
    );
}

test.skipIf(process.getuid === undefined)(
  "the native status query treats every sign of a live host as a refusal",
  async () => {
    // Under /tmp so the socket path stays within the platform limit.
    const directory = realpathSync(mkdtempSync("/tmp/dshq-"));
    const home = path.join(directory, "home");
    const paths = sessionHostPaths(home);
    const ports = createNativeSessionHostPorts({ listTimeoutMs: 200 });
    const servers: net.Server[] = [];
    const serve = async (server: net.Server) => {
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(paths.socketPath, resolve));
    };
    const stop = (server: net.Server) =>
      new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await preparePrivateDirectory(paths.directory);
      await rotateSessionHostToken(paths);
      // Closing before the greeting is what a live host does at its connection limit.
      const closing = fakeHost(null);
      await serve(closing);
      expect(await ports.queryHost(home)).toBe("refused");
      await stop(closing);
      // A newer host greets with another protocol version: alive, though this client cannot talk.
      const newer = fakeHost(greet(999));
      await serve(newer);
      expect(await ports.queryHost(home)).toBe("refused");
      await stop(newer);
      // A host that greets but never lists its sessions is alive too, and the query still ends.
      const stalled = fakeHost(greet(1));
      await serve(stalled);
      expect(await ports.queryHost(home)).toBe("refused");
      await stop(stalled);
      // Nothing listening: no sign of life.
      expect(await ports.queryHost(home)).toBeNull();
    } finally {
      for (const server of servers) server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

/**
 * One real round trip through launchd and the built session host, run only on request because it
 * loads a job into the user's launchd domain. The label is a unique test label, HOME and
 * PASEO_HOME are temporary, and the job is always booted out. Build the server first.
 */
test.runIf(process.env.DURABLE_SESSIONS_LAUNCHD_E2E === "1" && process.platform === "darwin")(
  "a real session host job installs, answers and is removed cleanly",
  async () => {
    const serverRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    const entrypoint = path.join(serverRoot, "dist/scripts/session-host-entrypoint.js");
    if (!existsSync(entrypoint)) throw new Error("Build the server first.");
    // Under /tmp so the host socket path inside stays within the platform limit.
    const directory = realpathSync(mkdtempSync("/tmp/dshc-"));
    const home = path.join(directory, "home");
    mkdirSync(home, { mode: 0o700 });
    const label = `test.durable-sessions.${randomBytes(6).toString("hex")}`;
    const ports = createNativeSessionHostPorts();
    const base = {
      version: 1 as const,
      installationId: INSTALLATION_ID,
      label,
      serviceDomain: `gui/${ports.uid}`,
      plistPath: path.join(directory, `${label}.plist`),
      node: process.execPath,
      entrypoint,
      paseoHome: home,
      logPath: path.join(home, "session-host", "launchd.log"),
      workingDirectory: serverRoot,
      environment: { HOME: home, PATH: "/usr/bin:/bin" },
    };
    const unsigned: SessionHostPlan = {
      ...base,
      operation: "session-host-install",
      plistSha256: null,
    };
    const install = { ...unsigned, plistSha256: sha256(renderPlannedPlist(unsigned)) };
    const logs = () =>
      ["launchd.log", "host.log"]
        .map((name) => {
          const file = path.join(home, "session-host", name);
          return `--- ${name}\n${existsSync(file) ? readFileSync(file, "utf8").slice(-4000) : ""}`;
        })
        .join("\n");
    try {
      const result = await installSessionHost({
        plan: install,
        ports,
        reportStage: () => {},
      }).catch((error: unknown) => {
        throw new Error(`${String(error)}\n${logs()}`, { cause: error });
      });
      expect(await readLaunchdJob(label, ports)).toMatchObject({
        pid: result.host.pid,
        runs: 1,
      });
      const remove: SessionHostPlan = {
        ...base,
        operation: "session-host-remove",
        plistSha256: sha256(readFileSync(install.plistPath)),
      };
      await expect(
        removeSessionHost({ plan: remove, ports, reportStage: () => {} }),
      ).resolves.toEqual({ detail: "The session host job is removed.", forced: false });
      expect(await readLaunchdJob(label, ports)).toBeNull();
      expect(existsSync(install.plistPath)).toBe(false);
      expect((await ports.hostLock(home)).state).toBe("gone");
    } finally {
      await bootoutJob(label).catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
