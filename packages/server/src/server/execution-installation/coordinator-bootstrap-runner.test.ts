import { createBootstrapRunnerEvidence } from "./coordinator-bootstrap-evidence.js";
import { mkdtempSync, realpathSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  observeBootstrapExecutorExit,
  observeBootstrapReadiness,
} from "./coordinator-bootstrap-runner.js";

test.each([false, true])("dispatch notification survives a closed observer: %s", async (closed) => {
  const moduleUrl = new URL("./coordinator-bootstrap-runner.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { acknowledgeBootstrapDispatch } from ${JSON.stringify(moduleUrl)};
       process.stdin.once('data', () => {
         acknowledgeBootstrapDispatch();
         setTimeout(() => { process.stderr.write('continued'); process.exit(0); }, 50);
       });
       process.stderr.write('ready');`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(child, "close");
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (errors += chunk.toString()));
  try {
    await once(child.stderr, "data");
    expect(errors).toBe("ready");
    if (closed) {
      const disconnected = once(child.stdout, "close");
      child.stdout.destroy();
      await disconnected;
    }
    child.stdin.end("go");
    expect(await exited).toEqual([0, null]);
    expect(errors).toBe("readycontinued");
    expect(output).toBe(closed ? "" : "dispatched\n");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

test("exit observation has a durable three-attempt budget and never repeats an exhausted probe", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "exit-observation-"));
  let now = 1000;
  let attempts = 0;
  const delays: number[] = [];
  const input = {
    file: path.join(root, "observation.json"),
    now: () => now,
    wait: async (milliseconds: number) => {
      delays.push(milliseconds);
      now += milliseconds;
    },
    verifyExited: async () => {
      attempts++;
      throw new Error("uncertain");
    },
  };
  try {
    await expect(observeBootstrapExecutorExit(input)).rejects.toThrow("three observations");
    expect(delays).toEqual([5000, 15000, 45000]);
    expect(attempts).toBe(3);
    expect(JSON.parse(readFileSync(input.file, "utf8")).attempts).toBe(3);
    await expect(observeBootstrapExecutorExit(input)).rejects.toThrow("three observations");
    expect(attempts).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit observation resumes a consumed attempt after interruption without resetting its delay", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "exit-interruption-"));
  let now = 1000;
  let probes = 0;
  let waits = 0;
  const file = path.join(root, "observation.json");
  try {
    await expect(
      observeBootstrapExecutorExit({
        file,
        now: () => now,
        wait: async (milliseconds) => {
          if (++waits === 2) throw new Error("observer stopped");
          now += milliseconds;
        },
        verifyExited: async () => {
          probes++;
          throw new Error("still present");
        },
      }),
    ).rejects.toThrow("observer stopped");
    expect(JSON.parse(readFileSync(file, "utf8")).attempts).toBe(1);
    now += 4000;
    const resumedDelays: number[] = [];
    await observeBootstrapExecutorExit({
      file,
      now: () => now,
      wait: async (milliseconds) => {
        resumedDelays.push(milliseconds);
        now += milliseconds;
      },
      verifyExited: async () => {
        probes++;
      },
    });
    expect(resumedDelays).toEqual([11000]);
    expect(probes).toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8")).attempts).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([true, false])(
  "startup dependency observation is bounded across observer restarts: %s",
  async (becomesReady) => {
    const root = mkdtempSync(path.join(tmpdir(), "startup-observation-"));
    const file = path.join(root, "readiness.json");
    let now = 1000;
    let observations = 0;
    const waits: number[] = [];
    const input = {
      file,
      now: () => now,
      wait: async (milliseconds: number) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      inspect: async () => {
        observations++;
        if (!becomesReady || observations < 3) throw new Error("Dependency is starting");
      },
    };
    try {
      if (becomesReady) await observeBootstrapReadiness(input);
      else
        await expect(observeBootstrapReadiness(input)).rejects.toThrow(
          "Startup dependencies were unavailable",
        );
      expect(waits).toEqual([5000, 15000, 45000]);
      expect(observations).toBe(3);
      expect(JSON.parse(readFileSync(file, "utf8")).attempts).toBe(3);
      await expect(observeBootstrapReadiness(input)).rejects.toThrow("three observations");
      expect(observations).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("runner evidence survives a pending validation and retains sanitized failure without granting authority", async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runner-evidence-")));
  const request = { id: randomUUID(), revision: randomUUID(), planSha256: "a".repeat(64) };
  const evidence = createBootstrapRunnerEvidence({ directory, request, role: "executor" });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failure = new Error("PRIVATE TOKEN AND CONFIGURATION");
  const run = evidence.run("runner", () =>
    evidence.run("renewal-validation", async () => {
      await pending;
      throw failure;
    }),
  );
  const rejected = expect(run).rejects.toBe(failure);
  try {
    const active = JSON.parse(readFileSync(evidence.file, "utf8"));
    expect(active).toMatchObject({
      authority: "diagnostic-only",
      requestId: request.id,
      outcome: "running",
    });
    expect(active.active.map((entry: { phase: string }) => entry.phase)).toEqual([
      "runner",
      "renewal-validation",
    ]);
    expect(statSync(evidence.file).mode & 0o777).toBe(0o600);
    const second = createBootstrapRunnerEvidence({ directory, request, role: "executor" });
    expect(second.file).not.toBe(evidence.file);
    expect(JSON.parse(readFileSync(evidence.file, "utf8"))).toEqual(active);
    release();
    await rejected;
    const retained = readFileSync(evidence.file, "utf8");
    expect(JSON.parse(retained)).toMatchObject({
      outcome: "failed",
      active: [],
      failure: { phase: "renewal-validation", category: "error" },
    });
    expect(retained).not.toContain("PRIVATE TOKEN");
    expect(retained).not.toContain("CONFIGURATION");
  } finally {
    release();
    await rejected;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runner evidence stays bounded and refuses a different approved plan", async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runner-history-")));
  const request = { id: randomUUID(), revision: randomUUID(), planSha256: "a".repeat(64) };
  const evidence = createBootstrapRunnerEvidence({ directory, request, role: "executor" });
  try {
    const revision = randomUUID();
    evidence.bind({ ...request, revision });
    for (let index = 0; index < 40; index++) {
      expect(await evidence.run("ownership-lock", async () => index)).toBe(index);
    }
    const retained = JSON.parse(readFileSync(evidence.file, "utf8"));
    expect(retained).toMatchObject({ revision, sequence: 40, outcome: "completed", active: [] });
    expect(retained.recent).toHaveLength(32);
    expect(() => evidence.bind({ ...request, planSha256: "b".repeat(64) })).toThrow(
      "different request",
    );
    expect(JSON.parse(readFileSync(evidence.file, "utf8"))).toEqual(retained);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([true, false])(
  "unavailable runner storage cannot prevent recovery or mask its error: %s",
  async (initiallyAvailable) => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runner-storage-")));
    const request = { id: randomUUID(), revision: randomUUID(), planSha256: "a".repeat(64) };
    if (!initiallyAvailable) rmSync(directory, { recursive: true });
    const evidence = createBootstrapRunnerEvidence({ directory, request, role: "executor" });
    if (initiallyAvailable) rmSync(directory, { recursive: true });
    const failure = new Error("original operation failure");
    expect(await evidence.run("recovery", async () => "restored")).toBe("restored");
    await expect(
      evidence.run("recovery", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(() => statSync(directory)).toThrow();
  },
);

test("an interrupted runner leaves phase evidence without claiming failure or liveness", async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runner-interrupted-")));
  const moduleUrl = new URL("./coordinator-bootstrap-evidence.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { createBootstrapRunnerEvidence } from ${JSON.stringify(moduleUrl)};
    const evidence = createBootstrapRunnerEvidence({
      directory: ${JSON.stringify(directory)},
      request: { id: ${JSON.stringify(randomUUID())}, revision: ${JSON.stringify(randomUUID())}, planSha256: 'a'.repeat(64) },
      role: 'executor',
    });
    evidence.run('renewal-validation', () => new Promise(() => {}));
    process.stdout.write(evidence.file);
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "close");
  try {
    const [chunk] = await once(child.stdout, "data");
    const file = chunk.toString();
    const before = readFileSync(file, "utf8");
    child.kill("SIGKILL");
    await exited;
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(before)).toMatchObject({
      authority: "diagnostic-only",
      outcome: "running",
      failure: null,
      active: [{ phase: "renewal-validation" }],
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
