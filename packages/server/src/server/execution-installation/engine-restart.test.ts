import { createHash } from "node:crypto";
import { chmodSync, readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { EngineRestartConfiguration } from "@getpaseo/protocol/execution-installation";
import {
  awaitEngineReadiness,
  engineRecoveryPlanDigest,
  engineRecoveryBudget,
  engineRecoveryPreflight,
  verifyFactoryAfterRecovery,
  engineRestartPlanDigest,
  engineRestartPreflight,
  restartDockerEngine,
  verifyFactoryAfterRestart,
  type EngineCommand,
} from "./engine-restart.js";

const ids = { dev: "a".repeat(64), gatewayTailscale: "b".repeat(64), gatewayCaddy: "c".repeat(64) };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function verifyScript(body = "#!/bin/sh\nexit 0\n") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "engine-restart-")));
  roots.push(root);
  const script = path.join(root, "verify.sh");
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return { script, sha256: createHash("sha256").update(body).digest("hex") };
}

function plan(factory = false): EngineRestartConfiguration {
  return {
    docker: process.execPath,
    socket: "/fixture/docker.sock",
    containers: ids,
    deadlineSeconds: 60,
    ...(factory
      ? { factoryVerify: { ...verifyScript(), lockInode: 3901122, ownerMode: "paused" as const } }
      : {}),
  };
}

/** A fake Docker: each container reports `state()`; the engine restart advances `boot`. */
function fakeDocker(options: { health?: () => string; epochs?: number[]; verifyFails?: string }) {
  const commands: string[] = [];
  let boot = 1;
  const epochs = [...(options.epochs ?? [40, 41])];
  const run: EngineCommand = async (file, args) => {
    const command = args.includes("desktop") ? "desktop restart" : (args[2] ?? args[0] ?? file);
    commands.push(command);
    if (args.includes("desktop")) {
      boot += 1;
      return { stdout: "" };
    }
    if (args[2] === "info") return { stdout: "29.8.0\n" };
    if (args[2] === "inspect") {
      const id = args.at(-1)!;
      const health = id === ids.dev ? (options.health?.() ?? "healthy") : "";
      return { stdout: `${id}|true|2026-10-23T0${boot}:00:00Z|${health}\n` };
    }
    if (args[0] === "--docker") {
      if (options.verifyFails) {
        const error = Object.assign(new Error("exit 1"), {
          stdout: `${JSON.stringify({ ok: false, check: options.verifyFails })}\n`,
        });
        throw error;
      }
      const facts = { ok: true, check: "all", epoch: epochs.shift(), supervisorPid: 20 + boot };
      return { stdout: `${JSON.stringify(facts)}\n` };
    }
    throw new Error(`unexpected command ${file} ${args.join(" ")}`);
  };
  return { run, commands };
}

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

test("the plan digest covers the exact plan and is withheld when an executable is unusable", () => {
  const base = plan(true);
  const digest = engineRestartPlanDigest(base);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(engineRestartPlanDigest({ ...base })).toBe(digest);
  expect(engineRestartPlanDigest({ ...base, deadlineSeconds: 120 })).not.toBe(digest);
  expect(engineRestartPlanDigest({ ...base, docker: "/fixture/missing-docker" })).toBeUndefined();
  writeFileSync(base.factoryVerify!.script, "#!/bin/sh\nexit 1\n");
  expect(engineRestartPlanDigest(base)).toBeUndefined();
  expect(engineRestartPlanDigest(undefined)).toBeUndefined();
});

test("preflight refuses an unhealthy Dev container before any effect", async () => {
  const docker = fakeDocker({ health: () => "starting" });
  await expect(engineRestartPreflight(plan(), { run: docker.run })).rejects.toThrow(
    "Dev container is not healthy. Nothing was restarted.",
  );
  expect(docker.commands).not.toContain("desktop restart");
});

test("preflight refuses when Factory's lock acceptance check fails now", async () => {
  const docker = fakeDocker({ verifyFails: "lock-identity-matches" });
  await expect(engineRestartPreflight(plan(true), { run: docker.run })).rejects.toThrow(
    'Factory lock acceptance check "lock-identity-matches" failed',
  );
  expect(docker.commands).not.toContain("desktop restart");
});

test("a restart passes only when every container restarted under its ID, Dev is healthy and Factory's epoch advanced", async () => {
  let healthy = false;
  const docker = fakeDocker({ health: () => (healthy ? "healthy" : "starting") });
  const configured = plan(true);
  healthy = true;
  const preflight = await engineRestartPreflight(configured, { run: docker.run });
  expect(preflight.factoryEpoch).toBe(40);
  healthy = false;
  await restartDockerEngine(configured, { run: docker.run });
  const time = clock();
  let polls = 0;
  const checks = await awaitEngineReadiness(configured, preflight, {
    run: async (file, args, timeout) => {
      if (args[2] === "info" && ++polls === 2) healthy = true;
      return docker.run(file, args, timeout);
    },
    ...time,
  });
  expect(checks).toContain("Dev container healthy");
  expect(checks).toContain("gateway Caddy container restarted under its pinned ID");
  expect(await verifyFactoryAfterRestart(configured, preflight, { run: docker.run })).toBe(
    "Factory accepted its lock (epoch 41)",
  );
  expect(docker.commands.filter((command) => command === "desktop restart")).toHaveLength(1);
});

test("readiness fails with the unmet check and never restarts again", async () => {
  const docker = fakeDocker({});
  const configured = plan();
  const preflight = await engineRestartPreflight(configured, { run: docker.run });
  // No restart happened, so every container keeps its old start time.
  await expect(
    awaitEngineReadiness(configured, preflight, { run: docker.run, ...clock() }),
  ).rejects.toThrow("the Dev container restarted was not met within 60 s");
  expect(docker.commands).not.toContain("desktop restart");
});

test("Factory verification fails when the controller epoch did not advance", async () => {
  const docker = fakeDocker({ epochs: [40, 40] });
  const configured = plan(true);
  const preflight = await engineRestartPreflight(configured, { run: docker.run });
  await expect(
    verifyFactoryAfterRestart(configured, preflight, { run: docker.run }),
  ).rejects.toThrow("epoch did not advance");
});

test("a failed Docker Desktop restart command is reported, not retried", async () => {
  let attempts = 0;
  await expect(
    restartDockerEngine(plan(), {
      run: async () => {
        attempts += 1;
        throw new Error("timeout");
      },
    }),
  ).rejects.toThrow("nothing will be retried");
  expect(attempts).toBe(1);
});

test("Factory verification fails when the supervisor did not change", async () => {
  // No restart happened, so the supervisor is the same process despite a higher epoch.
  const docker = fakeDocker({ epochs: [40, 41] });
  const configured = plan(true);
  const preflight = await engineRestartPreflight(configured, { run: docker.run });
  await expect(
    verifyFactoryAfterRestart(configured, preflight, { run: docker.run }),
  ).rejects.toThrow("supervisor did not change");
});

function recoveryPlan() {
  const base = plan(true);
  return {
    ...base,
    deadlineSeconds: 60,
    docker: realpathSync(base.docker),
    dockerSha256: createHash("sha256").update(readFileSync(base.docker)).digest("hex"),
    factoryVerify: { ...base.factoryVerify!, ownerMode: "paused" as const },
    baseline: {
      observedAt: "2026-10-23T01:00:00Z",
      evidenceSha256: "d".repeat(64),
      startedAt: {
        dev: "2026-10-23T01:00:00Z",
        gatewayTailscale: "2026-10-23T01:00:00Z",
        gatewayCaddy: "2026-10-23T01:00:00Z",
      },
      factory: {
        epoch: 40,
        supervisorPid: 21,
        ownerMode: "paused" as const,
        ownerSequence: 14,
        custodyCount: 454,
        custodyDigest: "c".repeat(64),
      },
    },
  };
}

test("degraded recovery requires its own executable and retained-evidence digest", () => {
  const configured = recoveryPlan();
  const digest = engineRecoveryPlanDigest(configured);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(digest).not.toBe(engineRestartPlanDigest(configured));
  expect(engineRecoveryPlanDigest({ ...configured, dockerSha256: "0".repeat(64) })).toBeUndefined();
  expect(
    engineRecoveryPlanDigest({
      ...configured,
      baseline: { ...configured.baseline, evidenceSha256: "e".repeat(64) },
    }),
  ).not.toBe(digest);
});

test("degraded preflight admits an unavailable engine without Dev calls, but rejects a responsive engine", async () => {
  const configured = recoveryPlan();
  const digest = engineRecoveryPlanDigest(configured)!;
  const commands: string[][] = [];
  const run: EngineCommand = async (_file, args, timeout) => {
    commands.push(args);
    expect(timeout).toBe(30000);
    throw new Error("engine timeout");
  };
  const preflight = await engineRecoveryPreflight(configured, digest, { run });
  expect(preflight.startedAt).toEqual(configured.baseline.startedAt);
  expect(commands).toEqual([
    ["--host", "unix:///fixture/docker.sock", "info", "--format", "{{.ServerVersion}}"],
  ]);
  await expect(
    engineRecoveryPreflight(configured, digest, { run: fakeDocker({}).run }),
  ).rejects.toThrow("Docker answers");
  await expect(engineRecoveryPreflight(configured, "f".repeat(64), { run })).rejects.toThrow(
    "changed",
  );
  expect(commands).toHaveLength(1);
});

test("degraded preflight refuses changed script bytes even if the engine observation failed", async () => {
  const configured = recoveryPlan();
  const digest = engineRecoveryPlanDigest(configured)!;
  await expect(
    engineRecoveryPreflight(configured, digest, {
      run: async () => {
        writeFileSync(configured.factoryVerify.script, "changed");
        throw new Error("timeout");
      },
    }),
  ).rejects.toThrow("changed during preflight");
});

test.each(["valid", "custody", "owner", "epoch", "supervisor", "failed check"])(
  "recovery independently verifies retained paused Factory evidence: %s",
  async (kind) => {
    const configured = recoveryPlan();
    const after = {
      ok: true,
      check: "all",
      ...configured.baseline.factory,
      epoch: 41,
      supervisorPid: 22,
    };
    if (kind === "custody") after.custodyDigest = "d".repeat(64);
    if (kind === "owner") after.ownerSequence++;
    if (kind === "epoch") after.epoch = 40;
    if (kind === "supervisor") after.supervisorPid = 21;
    if (kind === "failed check") after.ok = false;
    const verify = verifyFactoryAfterRecovery(configured, {
      run: async () => ({ stdout: JSON.stringify(after) }),
    });
    if (kind === "valid") await expect(verify).resolves.toContain("retained baseline");
    else await expect(verify).rejects.toThrow();
  },
);

test("recovery shares one monotonic budget and never starts a command after exhaustion", async () => {
  const configured = recoveryPlan();
  let now = 0;
  const timeouts: number[] = [];
  const bounded = engineRecoveryBudget(configured, {
    now: () => now,
    run: async (_file, _args, timeout) => {
      timeouts.push(timeout);
      now += timeout;
      return { stdout: "" };
    },
    sleep: async (ms) => {
      now += ms;
    },
  });
  await bounded.run!(configured.docker, ["info"], 30000);
  await bounded.run!(configured.docker, ["desktop", "restart"], 65000);
  expect(timeouts).toEqual([30000, 30000]);
  expect(() => bounded.run!(configured.docker, ["inspect"], 30000)).toThrow("budget exhausted");
  expect(timeouts).toHaveLength(2);
});
