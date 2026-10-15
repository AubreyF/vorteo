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
  const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
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
  const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
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
    const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
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
