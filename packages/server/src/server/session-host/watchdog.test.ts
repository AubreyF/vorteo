import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const watchdogPath = path.join(serverRoot, "src/server/session-host/watchdog.ts");
const hostPath = path.join(serverRoot, "src/server/session-host/host.ts");
const hostFilesPath = path.join(serverRoot, "src/server/session-host/host-files.ts");
const HANG_TIMEOUT_MS = 1_000;
const PROBE_INTERVAL_MS = 200;
const PROBE_WINDOW_MS = 1_000;
const POLL_MS = 100;
/** Covers one poll, process teardown and a busy test machine. */
const KILL_MARGIN_MS = 2_000;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** From the child's "ready" line to its exit. */
  elapsedMs: number;
  log: string;
}

/**
 * Runs a script that starts the watchdog, prints "ready", then does whatever body says. Timing
 * starts at "ready" so tsx compilation does not count against the watchdog.
 */
function runChild(body: string): Promise<ChildOutcome> {
  const directory = mkdtempSync("/tmp/dsh-watchdog-");
  directories.push(directory);
  const logPath = path.join(directory, "host.log");
  const scriptPath = path.join(directory, "child.ts");
  writeFileSync(
    scriptPath,
    `import { startSessionHostWatchdog } from ${JSON.stringify(watchdogPath)};\n` +
      `const watchdog = startSessionHostWatchdog({ logPath: ${JSON.stringify(logPath)}, ` +
      `hangTimeoutMs: ${HANG_TIMEOUT_MS}, heartbeatMs: 200, pollMs: ${POLL_MS} });\n` +
      `void watchdog;\nprocess.stdout.write("ready\\n");\n${body}\n`,
  );
  return runScript(scriptPath, logPath);
}

/**
 * Runs a real session host with a probing watchdog: short probe intervals, and a hang timeout
 * long enough that only the probe can fire. body runs after "ready" with `host`, `paths` and
 * `rotateSessionHostToken` in scope.
 */
function runHostChild(body: string): Promise<ChildOutcome> {
  const directory = mkdtempSync("/tmp/dsh-probe-");
  directories.push(directory);
  const logPath = path.join(directory, "host.log");
  // .mts so the top-level await runs as ESM outside any package.
  const scriptPath = path.join(directory, "child.mts");
  writeFileSync(
    scriptPath,
    `import { startSessionHostWatchdog } from ${JSON.stringify(watchdogPath)};\n` +
      `import { startSessionHost } from ${JSON.stringify(hostPath)};\n` +
      `import { rotateSessionHostToken, sessionHostPaths } from ${JSON.stringify(hostFilesPath)};\n` +
      `const paths = sessionHostPaths(${JSON.stringify(directory)});\n` +
      `const watchdog = startSessionHostWatchdog({ logPath: ${JSON.stringify(logPath)}, ` +
      `hangTimeoutMs: 60_000, pollMs: ${POLL_MS}, probe: { socketPath: paths.socketPath, ` +
      `tokenPath: paths.tokenPath, intervalMs: ${PROBE_INTERVAL_MS}, timeoutMs: 300, ` +
      `failureWindowMs: ${PROBE_WINDOW_MS}, minFailures: 3 } });\n` +
      `const host = await startSessionHost({ socketPath: paths.socketPath, ` +
      `token: () => rotateSessionHostToken(paths), mcpToken: "probe-test", ` +
      `openSession: async () => { throw new Error("unused"); } });\n` +
      `watchdog.markListening();\nprocess.stdout.write("ready\\n");\n${body}\n`,
  );
  return runScript(scriptPath, logPath);
}

function runScript(scriptPath: string, logPath: string): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    // node with the tsx loader rather than the tsx wrapper, which hides the kill signal.
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: serverRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let readyAt: number | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      if (readyAt === null && chunk.toString().includes("ready")) readyAt = Date.now();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      let log = "";
      try {
        log = readFileSync(logPath, "utf8");
      } catch {
        // No log line means the watchdog never fired.
      }
      resolve({ code, signal, elapsedMs: Date.now() - (readyAt ?? Date.now()), log });
    });
  });
}

test("kills a child whose main thread blocks", async () => {
  const outcome = await runChild("setTimeout(() => { for (;;) {} }, 100);");
  expect(outcome.signal).toBe("SIGKILL");
  // The last heartbeat may precede "ready" by up to one heartbeat interval.
  expect(outcome.elapsedMs).toBeGreaterThanOrEqual(HANG_TIMEOUT_MS - 200);
  expect(outcome.elapsedMs).toBeLessThan(HANG_TIMEOUT_MS + KILL_MARGIN_MS);
  const record = JSON.parse(outcome.log.trim()) as { reason: string; module: string };
  expect(record).toMatchObject({ reason: "hang", module: "session-host-watchdog" });
}, 20_000);

test("leaves a healthy child alone and never keeps it alive", async () => {
  // Busy but responsive for three hang timeouts, then nothing left to do.
  const outcome = await runChild(
    "const busy = setInterval(() => { const end = Date.now() + 50; while (Date.now() < end) {} }, 100);\n" +
      `setTimeout(() => clearInterval(busy), ${3 * HANG_TIMEOUT_MS});`,
  );
  expect(outcome).toMatchObject({ code: 0, signal: null, log: "" });
  expect(outcome.elapsedMs).toBeGreaterThanOrEqual(3 * HANG_TIMEOUT_MS);
}, 20_000);

test("kills a child that has not exited by its shutdown deadline", async () => {
  const outcome = await runChild(
    "watchdog.armDeadline(Date.now() + 500);\n" +
      // Only ever moves earlier, so this later deadline is ignored.
      "watchdog.armDeadline(Date.now() + 60_000);\n" +
      "setInterval(() => {}, 100);",
  );
  expect(outcome.signal).toBe("SIGKILL");
  expect(outcome.elapsedMs).toBeLessThan(500 + KILL_MARGIN_MS);
  expect(JSON.parse(outcome.log.trim())).toMatchObject({ reason: "shutdown_deadline" });
}, 20_000);

test("kills a host whose socket file is gone, though its main thread is fine", async () => {
  const outcome = await runHostChild(
    'import("node:fs").then(({ unlinkSync }) => unlinkSync(paths.socketPath));\n' +
      "setInterval(() => {}, 100);",
  );
  expect(outcome.signal).toBe("SIGKILL");
  expect(outcome.elapsedMs).toBeLessThan(PROBE_WINDOW_MS + KILL_MARGIN_MS);
  expect(JSON.parse(outcome.log.trim())).toMatchObject({
    reason: "probe",
    lastFailure: expect.stringContaining("ENOENT"),
  });
}, 20_000);

test("kills a host whose token file no longer matches it", async () => {
  // A new token on disk is what a second host would leave; workers could no longer get in.
  const outcome = await runHostChild(
    "void rotateSessionHostToken(paths);\nsetInterval(() => {}, 100);",
  );
  expect(outcome.signal).toBe("SIGKILL");
  expect(outcome.elapsedMs).toBeLessThan(PROBE_WINDOW_MS + KILL_MARGIN_MS);
  expect(JSON.parse(outcome.log.trim())).toMatchObject({
    reason: "probe",
    lastFailure: expect.stringContaining("unauthorized"),
  });
}, 20_000);

test("a healthy host answers every probe and is left alone", async () => {
  // Several failure windows' worth of probes, then a normal shutdown.
  const outcome = await runHostChild(
    `setTimeout(() => void host.close().then(() => process.exit(0)), ${4 * PROBE_WINDOW_MS});`,
  );
  expect(outcome).toMatchObject({ code: 0, signal: null, log: "" });
  expect(outcome.elapsedMs).toBeGreaterThanOrEqual(4 * PROBE_WINDOW_MS);
}, 20_000);
