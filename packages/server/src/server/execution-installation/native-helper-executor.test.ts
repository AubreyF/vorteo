import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile, cp, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  NativeHelperPlanSchema,
  NativeHelperJobSchema,
} from "@getpaseo/protocol/native-helper-maintenance";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import { createNativeHelperExecutor } from "./native-helper-executor.js";
import { inspectNativeHelperRecovery } from "./native-helper-recovery.js";
import { runNativeHelperCommand } from "./native-helper-command.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "helper-executor-")));
  roots.push(home);
  const candidate = path.join(home, "candidate.app"),
    tooling = path.join(home, "tooling");
  await mkdir(candidate, { mode: 0o700 });
  await mkdir(tooling, { mode: 0o700 });
  await writeFile(path.join(candidate, "bundle"), "signed fixture bytes", { mode: 0o600 });
  async function tool(name: string, content: string, mode = 0o600) {
    const file = path.join(tooling, name);
    await writeFile(file, content, { mode });
    return { path: file, sha256: createHash("sha256").update(content).digest("hex") };
  }
  const sourceCommit = "a".repeat(40),
    leaf = 'certificate leaf = H"' + "a".repeat(40) + '"';
  const helperRequirement = 'identifier "com.vorteo.macos-helper" and ' + leaf,
    clientRequirement = 'identifier "com.vorteo.macos-helper.client" and ' + leaf;
  const node = await tool("node", "fixture node", 0o700),
    installer = await tool("install.mjs", "fixture installer"),
    dispatcher = await tool("dispatch.mjs", "fixture dispatch"),
    invocationClient = await tool("dispatch-cli.mjs", "fixture cli");
  await tool(".installation-source.json", JSON.stringify({ sourceCommit }));
  const installationId = "00000000-0000-4000-8000-000000000001";
  const plan = NativeHelperPlanSchema.parse({
    version: 1,
    operation: "native-helper-install",
    installationId,
    candidate: {
      sourceCommit,
      directory: candidate,
      artifactSha256: await digestBootstrapArtifact(candidate),
      signingMode: "local",
      helperRequirement,
      clientRequirement,
    },
    previous: null,
    retainedRollback: null,
    tooling: {
      sourceCommit,
      directory: tooling,
      artifactSha256: await digestBootstrapArtifact(tooling),
      node,
      installer,
      dispatcher,
      invocationClient,
    },
    destination: {
      application: path.join(home, "Applications/Vorteo Permission Helper.app"),
      runtime: path.join(home, ".local/share/vorteo-macos-helper"),
    },
    expectedState: {
      configurationSha256: null,
      policySha256: null,
      installationReceiptSha256: null,
    },
  });
  const events: string[] = [];
  let corruptPolicy = false;
  let generation = 0;
  let keepOldInstance = false;
  let changeTokenDuringReadiness = false;
  const tools = {
    signatures: {
      run(command: string, args: string[]) {
        const client = args.at(-1)?.endsWith("/vorteo-helper-client");
        let stdout = "";
        if (command === "/usr/bin/plutil")
          stdout = JSON.stringify({ "com.apple.security.automation.apple-events": true });
        else if (command === "/usr/libexec/PlistBuddy")
          stdout = args.includes("Print :CFBundleIdentifier")
            ? "com.vorteo.macos-helper"
            : "VorteoPermissionHelper";
        else if (args.includes("-dv"))
          stdout = `Identifier=com.vorteo.macos-helper${client ? ".client" : ""}\nflags=0x10000(runtime)\nTeamIdentifier=fixture\n`;
        else if (args.includes("-dr"))
          stdout = `designated => ${client ? clientRequirement : helperRequirement}`;
        else if (args.includes("--entitlements")) stdout = "fixture plist";
        return { status: 0, stdout, stderr: "" };
      },
    },
    inspectProcess: async (pid: number) => ({
      pid,
      uid: process.getuid!(),
      executable: path.join(plan.destination.application, "Contents/MacOS/VorteoPermissionHelper"),
      startedAt: "fixture-start",
    }),
    command: async (input: Parameters<typeof runNativeHelperCommand>[0]) => {
      events.push(input.operation);
      if (input.operation === "status") {
        if (changeTokenDuringReadiness) {
          const configPath = path.join(plan.destination.runtime, "config.json");
          const config = JSON.parse(await readFile(configPath, "utf8"));
          config.token = "b".repeat(64);
          await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
        }
        return JSON.stringify({
          ok: true,
          code: "safari_permission_-1743",
          protocolVersion: 2,
          process: {
            pid: 76 + generation,
            executable: path.join(
              plan.destination.application,
              "Contents/MacOS/VorteoPermissionHelper",
            ),
            instanceId: "00000000-0000-4000-8000-" + String(generation).padStart(12, "0"),
          },
        });
      }
      input.recordInstaller(42);
      if (input.plan.operation === "native-helper-rollback") {
        const app = input.plan.destination.application;
        await rename(app, app + ".staged");
        await rename(app + ".previous", app);
        await rename(app + ".staged", app + ".previous");
        generation++;
        input.recordInstallerExit({ code: 0, signal: null });
        return "fixture rolled back";
      }
      await mkdir(path.dirname(plan.destination.application), { recursive: true });
      if (input.plan.previous) {
        await cp(plan.destination.application, plan.destination.application + ".previous", {
          recursive: true,
        });
        await rm(plan.destination.application, { recursive: true });
      }
      await cp(candidate, plan.destination.application, { recursive: true });
      if (!keepOldInstance) generation++;
      await mkdir(plan.destination.runtime, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(plan.destination.runtime, "config.json"),
        JSON.stringify({ token: "a".repeat(64), helperRequirement, clientRequirement }),
        { mode: 0o600 },
      );
      await cp(dispatcher.path, path.join(plan.destination.runtime, "host.mjs"));
      await cp(invocationClient.path, path.join(plan.destination.runtime, "invoke.mjs"));
      await writeFile(
        path.join(plan.destination.runtime, "installation.json"),
        JSON.stringify({ preview: false, app: plan.destination.application }),
        { mode: 0o600 },
      );
      if (corruptPolicy)
        await writeFile(path.join(plan.destination.runtime, "browser-policy.json"), "{}", {
          mode: 0o600,
        });
      return "fixture installed";
    },
  };
  const executor = createNativeHelperExecutor(
    { home, installationId, writableMountRoots: async () => [] },
    tools,
  );
  const job = NativeHelperJobSchema.parse({
    id: installationId,
    revision: installationId,
    target: "native-helper",
    operation: "native-helper-install",
    requestedBy: "host-agent",
    reason: "fixture",
    createdAt: "2026-10-09T00:00:00.000Z",
    plan,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    status: "running",
    stage: "dispatch_pending",
    detail: "fixture",
  });
  return {
    plan,
    job,
    events,
    executor,
    changeToken: () => {
      changeTokenDuringReadiness = true;
    },
    keepOld: () => {
      keepOldInstance = true;
    },
    replacement: async () => {
      const retained = path.join(home, "retained.app");
      await cp(plan.destination.application, retained, { recursive: true });
      plan.previous = { ...plan.candidate, directory: retained };
      for (const [key, name] of [
        ["configurationSha256", "config.json"],
        ["installationReceiptSha256", "installation.json"],
      ] as const) {
        plan.expectedState[key] = createHash("sha256")
          .update(await readFile(path.join(plan.destination.runtime, name)))
          .digest("hex");
      }
      await writeFile(path.join(candidate, "bundle"), "replacement signed fixture bytes");
      plan.candidate.artifactSha256 = await digestBootstrapArtifact(candidate);
      return {
        ...job,
        plan: structuredClone(plan),
        planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
      };
    },
    corrupt: () => {
      corruptPolicy = true;
    },
  };
}

test("helper preparation stays inert and dispatched execution verifies the whole resulting selection", async () => {
  const f = await fixture();
  await f.executor.validateHelperPlan(f.plan);
  expect(f.events).toEqual([]);
  const phases: string[] = [],
    pids: number[] = [];
  await expect(
    f.executor.installHelper(
      f.job,
      (stage) => phases.push(stage),
      (pid) => pids.push(pid),
      () => {},
      () => {},
    ),
  ).resolves.toContain("PID 77");
  expect(f.events).toEqual(["install", "status", "status"]);
  expect(phases).toEqual(["installing", "verifying"]);
  expect(pids).toEqual([42]);
});
test("helper executor refuses undispatched work and changed artifacts before invoking code", async () => {
  const f = await fixture();
  await expect(
    f.executor.installHelper(
      { ...f.job, status: "approved" },
      () => {},
      () => {},
      () => {},
      () => {},
    ),
  ).rejects.toThrow("exact dispatched");
  await writeFile(path.join(f.plan.candidate.directory, "bundle"), "changed");
  await expect(
    f.executor.installHelper(
      f.job,
      () => {},
      () => {},
      () => {},
      () => {},
    ),
  ).rejects.toThrow("application changed");
  expect(f.events).toEqual([]);
});
test("helper executor treats unexpected private state as failed acceptance without retry or rollback", async () => {
  const f = await fixture();
  f.corrupt();
  await expect(
    f.executor.installHelper(
      f.job,
      () => {},
      () => {},
      () => {},
      () => {},
    ),
  ).rejects.toThrow("appeared after preparation");
  expect(f.events).toEqual(["install"]);
});

test("helper replacement preserves old bytes and requires a new running instance", async () => {
  for (const keepOld of [false, true]) {
    const f = await fixture();
    await f.executor.installHelper(
      f.job,
      () => {},
      () => {},
      () => {},
      () => {},
    );
    const replacement = await f.replacement();
    if (keepOld) f.keepOld();
    const outcome = f.executor.installHelper(
      replacement,
      () => {},
      () => {},
      () => {},
      () => {},
    );
    if (keepOld) await expect(outcome).rejects.toThrow("Previous helper instance");
    else await expect(outcome).resolves.toContain("PID 78");
    expect(await digestBootstrapArtifact(f.plan.destination.application + ".previous")).toBe(
      f.plan.previous?.artifactSha256,
    );
    expect(f.events.filter((event) => event === "install")).toHaveLength(2);
  }
});

test("initial helper installation refuses a capability change during readiness", async () => {
  const f = await fixture();
  f.changeToken();
  await expect(
    f.executor.installHelper(
      f.job,
      () => {},
      () => {},
      () => {},
      () => {},
    ),
  ).rejects.toThrow("Helper configuration changed during readiness");
  expect(f.events.filter((event) => event === "install")).toEqual(["install"]);
});

test("interrupted helper inspection preserves locks and private state without running commands", async () => {
  const f = await fixture();
  await mkdir(path.dirname(f.plan.destination.application), { recursive: true });
  await mkdir(f.plan.destination.application + ".install-lock", { mode: 0o700 });
  await mkdir(f.plan.destination.runtime, { recursive: true, mode: 0o700 });
  const privateFile = path.join(f.plan.destination.runtime, "config.json");
  const secret = "private fixture value never returned";
  await writeFile(privateFile, secret, { mode: 0o600 });
  const job = {
    ...f.job,
    status: "failed" as const,
    stage: "recovery_required" as const,
    installerPid: 42,
  };
  const admission = {
    home: path.dirname(f.plan.candidate.directory),
    installationId: f.plan.installationId,
    writableMountRoots: [],
  };
  const result = await inspectNativeHelperRecovery(job, admission);
  expect(result.application).toEqual({ state: "absent" });
  expect(result.lock).toEqual({ state: "present" });
  expect(result.configuration).toEqual({
    state: "present",
    sha256: createHash("sha256").update(secret).digest("hex"),
  });
  expect(result.installerState).toBe("unverified");
  expect(result.installerPid).toBe(42);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(await readFile(privateFile, "utf8")).toBe(secret);
  expect(f.events).toEqual([]);
  await expect(
    inspectNativeHelperRecovery({ ...job, planSha256: "0".repeat(64) }, admission),
  ).rejects.toThrow("exact interrupted");
  await expect(inspectNativeHelperRecovery(f.job, admission)).rejects.toThrow("exact interrupted");
});

test("recovery verifies an installed candidate without replay and reports replacement limits", async () => {
  const f = await fixture();
  await f.executor.installHelper(
    f.job,
    () => {},
    () => {},
    () => {},
    () => {},
  );
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "spawn");
  const installerPid = child.pid!;
  await once(child, "exit");
  const recovered = {
    ...f.job,
    status: "failed" as const,
    stage: "recovery_required" as const,
    installerPid,
    installerExit: { code: 0, signal: null },
    previousProcess: null,
  };
  const result = await f.executor.inspectRecoveredSelection(recovered);
  expect(result.replacementVerified).toBe(true);
  expect(result.detail).toContain("PID 77");
  expect(f.events.filter((event) => event === "install")).toHaveLength(1);
  await mkdir(f.plan.destination.application + ".staged", { mode: 0o700 });
  await expect(f.executor.inspectRecoveredSelection(recovered)).rejects.toThrow(
    "further recovery inspection",
  );
  expect(f.events.filter((event) => event === "install")).toHaveLength(1);
});

test("recovery cannot infer completion from a missing exit receipt", async () => {
  const f = await fixture();
  await expect(
    f.executor.inspectRecoveredSelection({
      ...f.job,
      status: "failed",
      stage: "recovery_required",
    }),
  ).rejects.toThrow("further recovery inspection");
  expect(f.events).toEqual([]);
});

test("failure to persist predecessor identity prevents installer execution", async () => {
  const f = await fixture();
  await expect(
    f.executor.installHelper(
      f.job,
      () => {},
      () => {},
      () => {},
      () => {
        throw new Error("journal unavailable");
      },
    ),
  ).rejects.toThrow("journal unavailable");
  expect(f.events).toEqual([]);
});

test("recovered upgrades compare the running helper with the durable predecessor", async () => {
  const f = await fixture();
  await f.executor.installHelper(
    f.job,
    () => {},
    () => {},
    () => {},
    () => {},
  );
  const replacement = await f.replacement();
  const recovery = NativeHelperJobSchema.parse({
    ...replacement,
    status: "failed",
    stage: "recovery_required",
    installerExit: { code: 0, signal: null },
  });
  await f.executor.installHelper(
    replacement,
    () => {},
    () => {},
    () => {},
    (previous) => {
      recovery.previousProcess = previous;
    },
  );
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "spawn");
  recovery.installerPid = child.pid!;
  await once(child, "exit");
  await expect(f.executor.inspectRecoveredSelection(recovery)).resolves.toMatchObject({
    replacementVerified: true,
  });
  expect(recovery.previousProcess?.instanceId).toBe("00000000-0000-4000-8000-000000000001");
  recovery.previousProcess = {
    pid: 78,
    executable: path.join(f.plan.destination.application, "Contents/MacOS/VorteoPermissionHelper"),
    instanceId: "00000000-0000-4000-8000-000000000002",
  };
  await expect(f.executor.inspectRecoveredSelection(recovery)).rejects.toThrow(
    "Previous helper instance",
  );
  expect(f.events.filter((event) => event === "install")).toHaveLength(2);
});

test("helper rollback restores retained bytes and preserves configuration policy and both releases", async () => {
  const f = await fixture();
  const noop = () => {};
  await f.executor.installHelper(f.job, noop, noop, noop, noop);
  const originalDigest = await digestBootstrapArtifact(f.plan.destination.application);
  const upgrade = await f.replacement();
  await f.executor.installHelper(upgrade, noop, noop, noop, noop);
  const app = f.plan.destination.application;
  const home = path.dirname(f.plan.candidate.directory);
  const retainedCurrent = path.join(home, "rollback-current.app");
  const retainedTarget = path.join(home, "rollback-target.app");
  await cp(app, retainedCurrent, { recursive: true });
  await cp(app + ".previous", retainedTarget, { recursive: true });
  const configuration = await readFile(path.join(f.plan.destination.runtime, "config.json"));
  const receipt = await readFile(path.join(f.plan.destination.runtime, "installation.json"));
  const policy = Buffer.from('{"approved":"fixture-scope"}');
  await writeFile(path.join(f.plan.destination.runtime, "browser-policy.json"), policy, {
    mode: 0o600,
  });
  const plan = structuredClone(f.plan);
  plan.operation = "native-helper-rollback";
  plan.previous = {
    ...plan.candidate,
    directory: retainedCurrent,
    artifactSha256: await digestBootstrapArtifact(retainedCurrent),
  };
  plan.candidate = {
    ...plan.candidate,
    sourceCommit: "b".repeat(40),
    directory: retainedTarget,
    artifactSha256: originalDigest,
  };
  plan.retainedRollback = { directory: retainedTarget, artifactSha256: originalDigest };
  plan.expectedState = {
    configurationSha256: createHash("sha256").update(configuration).digest("hex"),
    policySha256: createHash("sha256").update(policy).digest("hex"),
    installationReceiptSha256: createHash("sha256").update(receipt).digest("hex"),
  };
  const rollback = NativeHelperJobSchema.parse({
    ...f.job,
    operation: plan.operation,
    plan,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  });
  await expect(f.executor.installHelper(rollback, noop, noop, noop, noop)).resolves.toContain(
    "PID 79",
  );
  expect(await digestBootstrapArtifact(app)).toBe(originalDigest);
  expect(await digestBootstrapArtifact(app + ".previous")).toBe(plan.previous.artifactSha256);
  expect(await readFile(path.join(plan.destination.runtime, "config.json"))).toEqual(configuration);
  expect(await readFile(path.join(plan.destination.runtime, "browser-policy.json"))).toEqual(
    policy,
  );
  expect(await readFile(path.join(plan.destination.runtime, "installation.json"))).toEqual(receipt);
  expect(await digestBootstrapArtifact(retainedCurrent)).toBe(plan.previous.artifactSha256);
  expect(await digestBootstrapArtifact(retainedTarget)).toBe(originalDigest);
});
