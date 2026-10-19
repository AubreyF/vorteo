import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { connectSessionHost } from "./client.js";
import { readSessionHostToken, sessionHostPaths } from "./host-files.js";
import {
  bootoutJob,
  bootstrapJob,
  kickstartJob,
  LaunchctlError,
  LaunchdLabelError,
  printJob,
  renderSessionHostPlist,
  type CommandRunner,
  type SessionHostPlistInput,
} from "./launchd.js";
import { SESSION_HOST_TEST_CLIENT_MODULE_ENV } from "./service.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const uid = process.getuid!();
const TEST_LABEL = "test.durable-sessions.unit";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  // Under /tmp so a host socket path inside stays within the platform limit.
  const directory = mkdtempSync(`/tmp/${prefix}`);
  directories.push(directory);
  return directory;
}

function plistInput(overrides: Partial<SessionHostPlistInput> = {}): SessionHostPlistInput {
  return {
    label: TEST_LABEL,
    nodePath: "/opt/node/bin/node",
    entrypointPath: "/srv/vorteo/dist/scripts/session-host-entrypoint.js",
    paseoHome: "/Users/someone/.paseo",
    logPath: "/Users/someone/.paseo/session-host/launchd.log",
    workingDirectory: "/Users/someone",
    ...overrides,
  };
}

/** Converts a plist with the system parser, which proves the XML is valid and escaped. */
function parsePlist(xml: string): Record<string, unknown> {
  const file = path.join(temporaryDirectory("dsh-plist-"), "job.plist");
  writeFileSync(file, xml);
  return JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }),
  ) as Record<string, unknown>;
}

/** The job's stdout and the host log, for a failure message. */
function readLogs(directory: string, home: string): string {
  return [path.join(directory, "launchd.log"), path.join(home, "session-host/host.log")]
    .map((file) => {
      try {
        return `${file}:\n${readFileSync(file, "utf8").slice(-4_000)}`;
      } catch {
        return `${file}: missing`;
      }
    })
    .join("\n");
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Records commands instead of running them; returns the given label for plutil reads. */
function recordingRunner(label = TEST_LABEL): {
  run: CommandRunner;
  calls: [string, readonly string[]][];
} {
  const calls: [string, readonly string[]][] = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push([file, args]);
      return { stdout: file === "/usr/bin/plutil" ? `${label}\n` : "" };
    },
  };
}

test.skipIf(process.platform !== "darwin")(
  "renders a launchd job the system parser accepts",
  () => {
    const hostile = `a&b<c>"d"'e'`;
    const parsed = parsePlist(
      renderSessionHostPlist(
        plistInput({
          nodeArguments: ["--import", "file:///srv/tsx/loader.mjs"],
          entrypointPath: `/srv/${hostile}/entry.js`,
          // PASEO_HOME always comes from paseoHome, never from the extra variables.
          environment: { NODE_ENV: "production", PASEO_HOME: "/wrong", NOTE: hostile },
        }),
      ),
    );
    expect(parsed).toEqual({
      Label: TEST_LABEL,
      ProgramArguments: [
        "/opt/node/bin/node",
        "--import",
        "file:///srv/tsx/loader.mjs",
        `/srv/${hostile}/entry.js`,
      ],
      EnvironmentVariables: {
        NODE_ENV: "production",
        NOTE: hostile,
        PASEO_HOME: "/Users/someone/.paseo",
      },
      WorkingDirectory: "/Users/someone",
      StandardOutPath: "/Users/someone/.paseo/session-host/launchd.log",
      StandardErrorPath: "/Users/someone/.paseo/session-host/launchd.log",
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 5,
    });
    // Each would harm the providers the host runs: Background throttles every tool run, and a
    // Umask would make every file they create private.
    expect(parsed).not.toHaveProperty("ProcessType");
    expect(parsed).not.toHaveProperty("Umask");
  },
);

test("escapes markup and refuses characters XML cannot carry", () => {
  const xml = renderSessionHostPlist(plistInput({ environment: { NOTE: "</string><x>&" } }));
  expect(xml).toContain("<string>&lt;/string&gt;&lt;x&gt;&amp;</string>");
  expect(xml).not.toContain("<x>");
  expect(() => renderSessionHostPlist(plistInput({ environment: { NOTE: "a\u0001b" } }))).toThrow(
    /cannot represent/,
  );
  expect(() => renderSessionHostPlist(plistInput({ label: "test.durable-sessions.a/b" }))).toThrow(
    LaunchdLabelError,
  );
});

test("refuses every job outside the test label prefix without running launchctl", async () => {
  const { run, calls } = recordingRunner();
  for (const label of ["local.vorteo.session-host", "test.durable-sessions", "test.durable-x.a"]) {
    await expect(bootoutJob(label, { run })).rejects.toThrow(LaunchdLabelError);
    await expect(kickstartJob(label, { run, kill: true })).rejects.toThrow(LaunchdLabelError);
    await expect(printJob(label, { run })).rejects.toThrow(LaunchdLabelError);
  }
  // A test prefix cannot smuggle another domain path.
  await expect(bootoutJob("test.durable-sessions.x/../y", { run })).rejects.toThrow(
    LaunchdLabelError,
  );
  expect(calls).toEqual([]);

  // bootstrap guards the label launchd will load, read from the plist itself.
  const production = recordingRunner("local.vorteo.session-host");
  await expect(bootstrapJob("/tmp/job.plist", { run: production.run })).rejects.toThrow(
    LaunchdLabelError,
  );
  expect(production.calls.map(([file]) => file)).toEqual(["/usr/bin/plutil"]);
});

test("drives launchctl in the user's GUI domain", async () => {
  const { run, calls } = recordingRunner();
  await bootstrapJob("/tmp/job.plist", { run });
  await kickstartJob(TEST_LABEL, { run, kill: true });
  await kickstartJob(TEST_LABEL, { run });
  await bootoutJob(TEST_LABEL, { run });
  await printJob(TEST_LABEL, { run });
  const target = `gui/${uid}/${TEST_LABEL}`;
  expect(calls).toEqual([
    ["/usr/bin/plutil", ["-extract", "Label", "raw", "-o", "-", "/tmp/job.plist"]],
    ["/bin/launchctl", ["bootstrap", `gui/${uid}`, "/tmp/job.plist"]],
    ["/bin/launchctl", ["kickstart", "-k", target]],
    ["/bin/launchctl", ["kickstart", target]],
    ["/bin/launchctl", ["bootout", target]],
    ["/bin/launchctl", ["print", target]],
  ]);

  const missing: CommandRunner = async (_file, args) => {
    throw new LaunchctlError(args, 113, "Could not find service");
  };
  expect(await printJob(TEST_LABEL, { run: missing })).toBeNull();
});

/**
 * One real round trip through launchd, run only on request because it loads a job into the
 * user's launchd domain. The label is unique and the job is always booted out.
 */
test.runIf(process.env.DURABLE_SESSIONS_LAUNCHD_E2E === "1" && process.platform === "darwin")(
  "a launchd job restarts a killed host, takes its provider processes with it, and boots out",
  async () => {
    const label = `test.durable-sessions.${randomBytes(6).toString("hex")}`;
    const directory = temporaryDirectory("dsh-launchd-");
    const home = path.join(directory, "home");
    mkdirSync(home);
    const providerPidPath = path.join(directory, "provider.pid");
    // Stands in for the Claude CLI, which the provider spawns without detaching: a child in the
    // host's process group. It also keeps this source checkout from loading the Claude SDK.
    const fakeClientPath = path.join(directory, "fake-client.ts");
    writeFileSync(
      fakeClientPath,
      `import { spawn } from "node:child_process";\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `import { CONTROLLED_SESSION_CAPABILITIES, ControlledSession } from ${JSON.stringify(
          path.join(serverRoot, "src/server/test-utils/controlled-provider-session.ts"),
        )};\n` +
        `export function createClient() {\n` +
        `  return {\n` +
        `    provider: "claude",\n` +
        `    capabilities: CONTROLLED_SESSION_CAPABILITIES,\n` +
        `    async createSession(config) {\n` +
        `      const cli = spawn("/bin/sleep", ["600"], { stdio: "ignore" });\n` +
        `      writeFileSync(${JSON.stringify(providerPidPath)}, String(cli.pid));\n` +
        `      return new ControlledSession(config);\n` +
        `    },\n` +
        `  };\n` +
        `}\n`,
    );
    const plistPath = path.join(directory, `${label}.plist`);
    writeFileSync(
      plistPath,
      renderSessionHostPlist({
        label,
        nodePath: process.execPath,
        nodeArguments: [
          "--import",
          pathToFileURL(path.resolve(serverRoot, "../../node_modules/tsx/dist/loader.mjs")).href,
        ],
        entrypointPath: path.join(serverRoot, "scripts/session-host-entrypoint.ts"),
        paseoHome: home,
        logPath: path.join(directory, "launchd.log"),
        environment: { NODE_ENV: "test", [SESSION_HOST_TEST_CLIENT_MODULE_ENV]: fakeClientPath },
        workingDirectory: serverRoot,
      }),
    );
    const paths = sessionHostPaths(home);

    /** Connects to whichever host answers, other than the one given. */
    async function connectToHost(other: number | null) {
      const deadline = Date.now() + 45_000;
      for (;;) {
        try {
          const client = await connectSessionHost({
            socketPath: paths.socketPath,
            token: await readSessionHostToken(paths),
            connectTimeoutMs: 1_000,
          });
          if (client.host.pid !== other) return client;
          client.close();
        } catch (error) {
          if (Date.now() > deadline)
            throw new Error(`The launchd host never answered.\n${readLogs(directory, home)}`, {
              cause: error,
            });
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    let hostPid: number | null = null;
    let providerPid: number | null = null;
    try {
      await bootstrapJob(plistPath);
      const first = await connectToHost(null);
      const killedPid = first.host.pid;
      expect(await printJob(label)).toContain(`pid = ${killedPid}`);
      await first.open({
        sessionId: "launchd-e2e",
        provider: "claude",
        config: { kind: "create", config: { provider: "claude", cwd: directory } },
      });
      providerPid = Number(readFileSync(providerPidPath, "utf8"));
      expect(isAlive(providerPid)).toBe(true);
      first.close();

      // A lost host must not leave its provider running: the next worker resumes the
      // conversation locally, and a surviving CLI would be a second writer.
      process.kill(killedPid, "SIGKILL");
      await waitUntil(() => !isAlive(providerPid!), 10_000);
      expect(isAlive(providerPid)).toBe(false);

      // KeepAlive alone brings a new host up; nothing else has to be running.
      const second = await connectToHost(killedPid);
      hostPid = second.host.pid;
      expect(await second.list()).toEqual([]);
      second.close();
    } finally {
      await bootoutJob(label).catch(() => {});
      if (providerPid !== null && isAlive(providerPid)) process.kill(providerPid, "SIGKILL");
    }
    // bootout can return before launchd has finished unloading the job.
    await waitUntil(async () => (await printJob(label)) === null, 25_000);
    expect(await printJob(label)).toBeNull();
    // launchd sends SIGTERM; the host closes and exits well inside its shutdown deadline.
    await waitUntil(() => !isAlive(hostPid!), 25_000);
    expect(isAlive(hostPid!)).toBe(false);
  },
  120_000,
);
