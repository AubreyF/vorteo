import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { EngineRestartConfiguration } from "@getpaseo/protocol/execution-installation";
import {
  awaitEngineReadiness,
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
