import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";

const tsxLoader = path.resolve(import.meta.dirname, "../../../../node_modules/tsx/dist/loader.mjs");
const watchdogModule = pathToFileURL(path.join(import.meta.dirname, "worker-watchdog.ts")).href;
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

/** A process whose main thread blocks forever, as the incident worker's did. */
function blockedWorker(input: { supervisorPid: number; logPath: string; armAfterMs?: number }) {
  const script = `
    const { startWorkerWatchdog } = await import(${JSON.stringify(watchdogModule)});
    const watchdog = startWorkerWatchdog({
      supervisorPid: ${input.supervisorPid},
      logPath: ${JSON.stringify(input.logPath)},
      supervisorLossGraceMs: 1000,
      pollMs: 100,
    });
    watchdog.step("close agents");
    ${input.armAfterMs === undefined ? "" : `watchdog.armDeadline(Date.now() + ${input.armAfterMs});`}
    // Let the step message reach the watchdog thread, then block the event loop.
    setTimeout(() => {
      process.stdout.write("blocked\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
    }, 100);
  `;
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, "--input-type=module", "-e", script],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  cleanup.push(() => child.kill("SIGKILL"));
  return child;
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
}

function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.stdout?.once("data", () => resolve()));
}

function temporaryLog(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-watchdog-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "daemon.log");
}

test("a worker with a blocked event loop is killed at its shutdown deadline and names the step", async () => {
  const logPath = temporaryLog();
  const worker = blockedWorker({ supervisorPid: process.pid, logPath, armAfterMs: 1500 });
  const exit = exited(worker);
  await started(worker);
  const startedAt = Date.now();
  expect(await exit).toBe("SIGKILL");
  expect(Date.now() - startedAt).toBeLessThan(5000);
  const record = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").at(-1)!);
  expect(record).toMatchObject({ reason: "shutdown_deadline_expired", step: "close agents" });
});

test("a worker that outlives its supervisor is killed even while its event loop is blocked", async () => {
  const logPath = temporaryLog();
  const supervisor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"]);
  cleanup.push(() => supervisor.kill("SIGKILL"));
  const worker = blockedWorker({ supervisorPid: supervisor.pid!, logPath });
  const exit = exited(worker);
  await started(worker);
  supervisor.kill("SIGKILL");
  const startedAt = Date.now();
  expect(await exit).toBe("SIGKILL");
  expect(Date.now() - startedAt).toBeLessThan(5000);
  expect(readFileSync(logPath, "utf8")).toContain('"reason":"supervisor_lost"');
});

test("an unarmed watchdog leaves a healthy process alone", async () => {
  const logPath = temporaryLog();
  const script = `
    const { startWorkerWatchdog } = await import(${JSON.stringify(watchdogModule)});
    startWorkerWatchdog({ supervisorPid: ${process.pid}, logPath: ${JSON.stringify(logPath)}, supervisorLossGraceMs: 1000, pollMs: 100 });
    setTimeout(() => process.exit(7), 800);
  `;
  const child = spawn(process.execPath, [
    "--import",
    tsxLoader,
    "--input-type=module",
    "-e",
    script,
  ]);
  cleanup.push(() => child.kill("SIGKILL"));
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", (value) => resolve(value)),
  );
  expect(code).toBe(7);
});
