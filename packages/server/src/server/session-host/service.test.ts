import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { connectSessionHost, type SessionHostClient } from "./client.js";
import { readSessionHostToken, sessionHostPaths } from "./host-files.js";
import { SESSION_HOST_PROTOCOL_VERSION } from "./protocol.js";
import { DEFAULT_SHUTDOWN_DEADLINE_MS, SESSION_HOST_TEST_CLIENT_MODULE_ENV } from "./service.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const entrypointPath = path.join(serverRoot, "scripts/session-host-entrypoint.ts");
const controlledSessionPath = path.join(
  serverRoot,
  "src/server/test-utils/controlled-provider-session.ts",
);

/** A fake provider for the child: Claude-shaped sessions that log each close to a file. */
const FAKE_CLIENT_MODULE = `
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { CONTROLLED_SESSION_CAPABILITIES, ControlledSession } from ${JSON.stringify(controlledSessionPath)};
class LoggedSession extends ControlledSession {
  async close() {
    await super.close();
    appendFileSync(process.env.FAKE_CLOSE_LOG, "closed\\n");
  }
}
export function createClient() {
  return {
    provider: "claude",
    capabilities: CONTROLLED_SESSION_CAPABILITIES,
    async createSession(config) {
      // A provider's CLI and tools inherit the host's umask; record what they would see.
      appendFileSync(process.env.FAKE_UMASK_LOG, execFileSync("/bin/sh", ["-c", "umask"]));
      return new LoggedSession(config);
    },
    async resumeSession(_handle, overrides) {
      return new LoggedSession({ provider: "claude", cwd: "/", ...overrides });
    },
    async fetchCatalog() { return { models: [], modes: [] }; },
    async isAvailable() { return true; },
  };
}
`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

interface RunningHost {
  home: string;
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  client: SessionHostClient;
  token: string;
  closeLog: string;
}

async function waitFor<T>(attempt: () => Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

interface HostChild {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr(): string;
}

/** Runs the real entrypoint for home in a child on the fake provider. */
function spawnHost(home: string): HostChild {
  const fakeClientPath = path.join(home, "fake-client.ts");
  writeFileSync(fakeClientPath, FAKE_CLIENT_MODULE);
  // node with the tsx loader rather than the tsx wrapper, so signals reach the host directly.
  const child = spawn(process.execPath, ["--import", "tsx", entrypointPath], {
    cwd: serverRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      PASEO_HOME: home,
      [SESSION_HOST_TEST_CLIENT_MODULE_ENV]: fakeClientPath,
      FAKE_CLOSE_LOG: path.join(home, "closed.log"),
      FAKE_UMASK_LOG: path.join(home, "umask.log"),
    },
    stdio: ["ignore", "inherit", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { child, exited, stderr: () => stderr };
}

/** Starts the real entrypoint in a child on the fake provider and connects a worker client. */
async function startHost(existingHome?: string): Promise<RunningHost> {
  // Under /tmp, not the per-user temp directory, so the socket path stays within its limit.
  const home = existingHome ?? mkdtempSync("/tmp/dsh-svc-");
  if (!existingHome) cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const closeLog = path.join(home, "closed.log");
  const { child, exited } = spawnHost(home);
  const paths = sessionHostPaths(home);
  const { client, token } = await waitFor(async () => {
    const current = await readSessionHostToken(paths);
    const connected = await connectSessionHost({
      socketPath: paths.socketPath,
      token: current,
      connectTimeoutMs: 1_000,
    });
    return { client: connected, token: current };
  }, 20_000);
  cleanups.push(() => client.close());
  return { home, child, exited, client, token, closeLog };
}

function openFakeSession(host: RunningHost, sessionId: string) {
  return host.client.open({
    sessionId,
    provider: "claude",
    config: { kind: "create", config: { provider: "claude", cwd: host.home } },
  });
}

/** Says hello as a worker built for a newer protocol. */
function helloFromNewerWorker(host: RunningHost): Promise<void> {
  return helloWithVersion(host, SESSION_HOST_PROTOCOL_VERSION + 1);
}

function helloWithVersion(host: RunningHost, protocolVersion: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sessionHostPaths(host.home).socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "hello", protocolVersion, token: host.token })}\n`);
    });
    socket.once("data", () => {
      socket.destroy();
      resolve();
    });
  });
}

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

function auditEvents(host: RunningHost): { event: string; reason?: string }[] {
  return readFileSync(sessionHostPaths(host.home).auditLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; reason?: string });
}

test("keeps every host file private and serves sessions", async () => {
  const host = await startHost();
  const session = await openFakeSession(host, "private-files");
  expect(session.attach.provider).toBe("claude");
  expect(await host.client.list()).toEqual([
    expect.objectContaining({ sessionId: "private-files", attached: true }),
  ]);

  const paths = sessionHostPaths(host.home);
  expect(mode(paths.directory)).toBe(0o700);
  for (const file of [
    paths.socketPath,
    `${paths.socketPath}.lock`,
    paths.tokenPath,
    paths.auditLogPath,
    path.join(paths.directory, "host.log"),
  ])
    expect({ file: path.basename(file), mode: mode(file) }).toEqual({
      file: path.basename(file),
      mode: 0o600,
    });
  expect(readFileSync(path.join(paths.directory, "host.log"), "utf8")).toContain(
    "Session host started",
  );
}, 30_000);

test("closes its sessions and exits on SIGTERM within the shutdown deadline", async () => {
  const host = await startHost();
  await openFakeSession(host, "terminated");
  const startedAt = Date.now();
  host.child.kill("SIGTERM");
  expect(await host.exited).toEqual({ code: 0, signal: null });
  expect(Date.now() - startedAt).toBeLessThan(DEFAULT_SHUTDOWN_DEADLINE_MS);
  expect(readFileSync(host.closeLog, "utf8")).toBe("closed\n");
  expect(auditEvents(host).at(-1)?.event).toBe("host_stopped");
  // The next host starts cleanly: no lock or socket is left behind.
  expect(existsSync(`${sessionHostPaths(host.home).socketPath}.lock`)).toBe(false);
}, 30_000);

test("exits at once for a newer worker when no session runs", async () => {
  const host = await startHost();
  await helloFromNewerWorker(host);
  expect(await host.exited).toEqual({ code: 0, signal: null });
  expect(auditEvents(host)).toContainEqual(
    expect.objectContaining({ event: "hello_rejected", reason: "version" }),
  );
}, 30_000);

test("waits for a running session to close before exiting for a newer worker", async () => {
  const host = await startHost();
  const session = await openFakeSession(host, "long-turn");
  await helloFromNewerWorker(host);

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(host.child.exitCode).toBeNull();
  expect(host.child.signalCode).toBeNull();
  expect(existsSync(host.closeLog)).toBe(false);
  expect((await host.client.list()).map((summary) => summary.sessionId)).toEqual(["long-turn"]);

  await session.call({ method: "close" });
  expect(await host.exited).toEqual({ code: 0, signal: null });
  expect(readFileSync(host.closeLog, "utf8")).toBe("closed\n");
}, 30_000);

test("an older worker is refused without making the host exit", async () => {
  const host = await startHost();
  await helloWithVersion(host, SESSION_HOST_PROTOCOL_VERSION - 1);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(host.child.exitCode).toBeNull();
  expect(host.child.signalCode).toBeNull();
  expect(await host.client.list()).toEqual([]);
  expect(auditEvents(host)).toContainEqual(
    expect.objectContaining({
      event: "hello_rejected",
      reason: "version",
      protocolVersion: SESSION_HOST_PROTOCOL_VERSION - 1,
    }),
  );
}, 30_000);

test("providers inherit the host's own umask, not the private mask", async () => {
  const inherited = process.umask(0o022);
  process.umask(inherited);
  const host = await startHost();
  await openFakeSession(host, "umask");
  expect(readFileSync(path.join(host.home, "umask.log"), "utf8").trim()).toBe(
    inherited.toString(8).padStart(4, "0"),
  );
}, 30_000);

test("a second host fails while one runs and leaves the running host's token alone", async () => {
  const host = await startHost();
  const tokenPath = sessionHostPaths(host.home).tokenPath;
  const tokenBefore = readFileSync(tokenPath, "utf8");

  const second = spawnHost(host.home);
  expect(await second.exited).toEqual({ code: 1, signal: null });
  expect(second.stderr()).toContain("SessionHostAlreadyRunningError");
  expect(readFileSync(tokenPath, "utf8")).toBe(tokenBefore);
  // The running host still serves workers holding its token.
  expect(await host.client.list()).toEqual([]);
  const another = await connectSessionHost({
    socketPath: sessionHostPaths(host.home).socketPath,
    token: host.token,
  });
  another.close();
}, 30_000);

test("a provider process recorded by an earlier host is stopped before the new host serves", async () => {
  // Under /tmp, not the per-user temp directory, so the socket path stays within its limit.
  const home = mkdtempSync("/tmp/dsh-svc-");
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = sessionHostPaths(home);
  // Stands in for a detached Codex app-server left behind: its command line carries the marker.
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)", "app-server"], {
    stdio: "ignore",
  });
  cleanups.push(() => {
    if (orphan.exitCode === null && orphan.signalCode === null) orphan.kill("SIGKILL");
  });
  const orphanExited = new Promise<void>((resolve) => orphan.once("exit", () => resolve()));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(paths.directory, { mode: 0o700 });
  writeFileSync(
    path.join(paths.directory, "children.json"),
    JSON.stringify({
      version: 1,
      children: [
        {
          pid: orphan.pid,
          marker: "app-server",
          agentId: "agent-1",
          spawnedAt: "2026-10-22T00:00:00Z",
        },
        { pid: 999_999, marker: "app-server", spawnedAt: "2026-10-22T00:00:00Z" },
      ],
    }),
    { mode: 0o600 },
  );

  const host = await startHost(home);
  await orphanExited;
  expect(orphan.signalCode).toBe("SIGKILL");
  expect(
    JSON.parse(readFileSync(path.join(paths.directory, "children.json"), "utf8")).children,
  ).toEqual([]);
  expect(readFileSync(path.join(paths.directory, "host.log"), "utf8")).toContain(
    "Stopped provider processes left by an earlier session host",
  );
  expect(await host.client.list()).toEqual([]);
}, 30_000);
