import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";

/**
 * The 2026-10-19 incident: under a restart continuation hold the worker froze in
 * graceful shutdown, launchd killed its supervisor about 4 s after SIGTERM, and the
 * orphaned worker held the listen port for ten hours. A mock agent whose close()
 * blocks the event loop stands in for the frozen teardown.
 */

const serverRoot = path.resolve(import.meta.dirname, "../../..");
const supervisorPath = path.join(serverRoot, "scripts/supervisor-entrypoint.ts");
// Run the supervisor in this node process directly: the tsx CLI is a wrapper that
// relays signals, so killing it would leave the real supervisor alive.
const tsxLoader = path.resolve(serverRoot, "../../node_modules/tsx/dist/loader.mjs");
/** Worker shutdown budget (10 s) plus the watchdog margin (5 s), plus slack for a loaded host. */
const OLD_WORKER_EXIT_DEADLINE_MS = 25_000;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function isolatedHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "orphaned-worker-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ version: 1, agents: { providers: { mock: { label: "Mock" } } } }),
  );
  return home;
}

/** Starts a supervisor and resolves with the pid of the worker once it is listening. */
async function startSupervisor(
  home: string,
  port: number,
): Promise<{ supervisor: ChildProcess; workerPid: number }> {
  const supervisor = spawn(
    process.execPath,
    ["--import", tsxLoader, supervisorPath, "--dev", "--no-relay"],
    {
      env: {
        ...process.env,
        PASEO_HOME: home,
        PASEO_LISTEN: `127.0.0.1:${port}`,
        PASEO_DICTATION_ENABLED: "0",
        PASEO_VOICE_MODE_ENABLED: "0",
        PASEO_LOG_FORMAT: "json",
        PASEO_NODE_ENV: "development",
        PASEO_NODE_INSPECT: "0",
        OPENAI_API_KEY: "",
        VORTEO_INSTALLATION_CLIENT_CONFIG: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  cleanup.push(() => {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
  });
  supervisor.stderr?.resume();
  const workerPid = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for a listening worker")),
      90_000,
    );
    let buffered = "";
    supervisor.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as { msg?: string; pid?: number };
          if (record.msg?.startsWith("Server listening") && record.pid) {
            clearTimeout(timeout);
            resolve(record.pid);
          }
        } catch {
          // Not a log record.
        }
      }
    });
    supervisor.once("exit", () => reject(new Error("supervisor exited before listening")));
  });
  cleanup.push(() => {
    if (alive(workerPid)) process.kill(workerPid, "SIGKILL");
  });
  return { supervisor, workerPid };
}

/** A running turn under a continuation capture, whose agent freezes the worker when closed. */
async function holdRestartWithFrozenTurn(home: string, port: number): Promise<void> {
  const client = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws`, appVersion: "0.7.2" });
  await client.connect();
  try {
    const agent = await client.createAgent({
      config: {
        provider: "mock",
        cwd: home,
        model: "thirty-minute-stream",
        title: "frozen teardown",
        featureValues: { mockBlockingCloseMs: 10 * 60_000 },
      },
      initialPrompt: "keep running",
    });
    const deadline = Date.now() + 30_000;
    while ((await client.fetchAgent({ agentId: agent.id }))?.agent.status !== "running") {
      if (Date.now() > deadline) throw new Error("mock turn never started");
      await delay(250);
    }
    const cause = randomUUID();
    const captured = await client.restartServer(undefined, undefined, {
      timeout: 5000,
      idleMode: "drain",
      restartDrainId: cause,
      restartContinuation: "capture",
    });
    expect(captured.accepted).toBe(true);
    // The drain cannot finish while the turn runs, so the hold is still active at SIGTERM.
    const held = await client.restartServer(undefined, undefined, {
      timeout: 5000,
      idleMode: "drain",
      restartDrainId: cause,
    });
    expect(held.accepted).toBe(true);
  } finally {
    await client.close().catch(() => {});
  }
}

/** launchd `kickstart -k` as observed: SIGTERM, then the supervisor is gone 4 s later. */
async function killSupervisorLikeLaunchd(supervisor: ChildProcess): Promise<number> {
  const sentAt = Date.now();
  supervisor.kill("SIGTERM");
  await delay(4000);
  if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
  return sentAt;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await delay(250);
  }
  return !alive(pid);
}

test("a worker frozen in shutdown under a restart hold dies within its deadline after its supervisor is killed", async () => {
  const home = await isolatedHome();
  const port = await availablePort();
  const first = await startSupervisor(home, port);
  await holdRestartWithFrozenTurn(home, port);

  const sentAt = await killSupervisorLikeLaunchd(first.supervisor);
  expect(
    await waitForExit(first.workerPid, OLD_WORKER_EXIT_DEADLINE_MS - (Date.now() - sentAt)),
  ).toBe(true);
  const watchdogRecord = (await readFile(path.join(home, "daemon.log"), "utf8"))
    .split("\n")
    .filter((line) => line.includes('"module":"worker-watchdog"'))
    .map((line) => JSON.parse(line) as { pid: number; time: number; step: string; reason: string })
    .find((record) => record.pid === first.workerPid);
  expect(watchdogRecord).toMatchObject({
    reason: "shutdown_deadline_expired",
    step: "close agents",
  });
  // Killed at the shutdown deadline (15 s), not left for the supervisor-loss grace.
  expect(watchdogRecord!.time - sentAt).toBeLessThan(18_000);

  const second = await startSupervisor(home, port);
  expect(second.workerPid).not.toBe(first.workerPid);
}, 240_000);

test("a replacement started while the frozen worker still holds the port binds it", async () => {
  const home = await isolatedHome();
  const port = await availablePort();
  const first = await startSupervisor(home, port);
  await holdRestartWithFrozenTurn(home, port);

  const sentAt = await killSupervisorLikeLaunchd(first.supervisor);
  // launchd starts the replacement as soon as the job exits.
  const second = await startSupervisor(home, port);
  expect(second.workerPid).not.toBe(first.workerPid);
  expect(alive(first.workerPid)).toBe(false);
  expect(Date.now() - sentAt).toBeLessThan(120_000);
}, 240_000);
