import {
  createGatedSupervisorMaintenance,
  type GatedSupervisorMaintenanceInput,
  type GatedSupervisorSpawn,
} from "./supervisor-maintenance-gated.js";
import { test, expect, vi, afterEach } from "vitest";
import { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
vi.mock(
  "@getpaseo/protocol/execution-installation",
  () => import("../../../../protocol/src/execution-installation.js"),
);
import type {
  SupervisorEffect,
  SupervisorEffectExecutor,
} from "@getpaseo/protocol/execution-installation";
import type { DevRegistrationExecutionPreflight } from "./maintenance/dev-registration-execution.js";
import { DEV_REGISTRATION_GATE_PREFIX } from "./maintenance/dev-registration-provisioner.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RestartJobSchema } from "@getpaseo/protocol/execution-installation";
import { runSupervisorMaintenance, supervisorPlanDigest } from "./supervisor-maintenance.js";

test("supervisor execution binds reviewed bytes and fails before changed code can run", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "supervisor-plan-"));
  try {
    const script = path.join(root, "plan.mjs");
    const receipt = path.join(root, "receipt.json");
    const source = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({id:process.env.VORTEO_RESTART_JOB_ID,force:process.env.VORTEO_RESTART_FORCE}));`;
    writeFileSync(script, source);
    const sha256 = createHash("sha256").update(source).digest("hex");
    const plan = { node: process.execPath, script, sha256 };
    expect(supervisorPlanDigest(plan)).toBe(sha256);
    expect(
      supervisorPlanDigest({ ...plan, node: path.join(root, "missing-node") }),
    ).toBeUndefined();
    const job = RestartJobSchema.parse({
      id: randomUUID(),
      revision: randomUUID(),
      target: "container-daemon",
      reason: "Isolated launcher repair",
      requestedBy: "host-agent",
      status: "running",
      detail: "Executing reviewed fixture",
      createdAt: new Date().toISOString(),
      expiresAt: "9999-12-31T23:59:59.999Z",
      supervisorPlanSha256: sha256,
      whenIdle: true,
    });
    await expect(
      runSupervisorMaintenance(plan, { ...job, supervisorPlanSha256: "b".repeat(64) }),
    ).rejects.toThrow("changed");
    expect(existsSync(receipt)).toBe(false);
    writeFileSync(script, source + "\n// changed");
    expect(supervisorPlanDigest(plan)).toBeUndefined();
    await expect(runSupervisorMaintenance(plan, job)).rejects.toThrow("no restart dispatched");
    expect(existsSync(receipt)).toBe(false);
    writeFileSync(script, source);
    await runSupervisorMaintenance(plan, job);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ id: job.id, force: "0" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const gatedRoots: string[] = [];
afterEach(() => {
  for (const root of gatedRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function gatedFixture(source?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "gated-supervisor-source-"));
  gatedRoots.push(root);
  const script = path.join(root, "script.mjs");
  const buffer =
    source ?? DEV_REGISTRATION_GATE_PREFIX + "throw Error('Source fixture must never execute');\n";
  writeFileSync(script, buffer);
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const scriptSha = createHash("sha256").update(buffer).digest("hex");
  const plan = { node: "/protected/host-node", script, sha256: scriptSha };
  const job = RestartJobSchema.parse({
    id: randomUUID(),
    revision: randomUUID(),
    target: "container-daemon",
    reason: "Gated source fixture",
    requestedBy: "host-agent",
    status: "running",
    detail: "Source fixture",
    createdAt: "2026-10-17T00:00:00.000Z",
    expiresAt: "9999-12-31T23:59:59.999Z",
    approvedAt: "2026-10-17T00:00:01.000Z",
    supervisorPlanSha256: scriptSha,
    whenIdle: true,
  });
  const uid = process.getuid!(),
    pid = process.pid + 10000;
  const executor: SupervisorEffectExecutor = {
    pid,
    parentPid: process.pid,
    uid,
    bootId: randomUUID(),
    startIdentity: "100:1",
    argumentsSha256: sha([plan.node, "--input-type=module", "--eval", buffer]),
    auditToken: [0, uid, 0, 0, 0, pid, 0, 1],
    executable: { path: plan.node, sha256: "a".repeat(64) },
    entrypoint: { path: script, sha256: scriptSha },
    artifactSha256: "b".repeat(64),
  };
  const controller = { ...structuredClone(executor), pid: process.pid, parentPid: 1 };
  controller.auditToken[5] = process.pid;
  const preflight: DevRegistrationExecutionPreflight = {
    controller,
    nativeIdentitySha256: "c".repeat(64),
    preconditionSha256: "d".repeat(64),
    settlementSha256: "e".repeat(64),
    assertCurrent() {},
  };
  const reservation: SupervisorEffect = {
    phase: "reserved",
    reservedAt: "2026-10-17T00:00:02.000Z",
    binding: {
      requestId: job.id,
      requestRevision: job.revision,
      approvedAt: job.approvedAt!,
      decisionSha256: "1".repeat(64),
      requestPlanSha256: "2".repeat(64),
      supervisorPlanSha256: scriptSha,
      registrationPlanSha256: "3".repeat(64),
      operation: "replace",
      preparationNonce: randomUUID(),
      original: null,
      generation: randomUUID(),
      candidateSha256: "4".repeat(64),
      grantId: randomUUID(),
      grantRevision: randomUUID(),
      manifestSha256: "5".repeat(64),
      stepId: randomUUID(),
      activationGeneration: randomUUID(),
      sourceCommit: "6".repeat(40),
      artifactSha256: "7".repeat(64),
      nativeIdentitySha256: preflight.nativeIdentitySha256,
      preconditionSha256: preflight.preconditionSha256,
      settlementSha256: preflight.settlementSha256,
      controller: structuredClone(controller),
    },
  };
  const attestation = { executor, assertCurrent() {} };
  let hostCheck: () => void = () => {};
  const input: GatedSupervisorMaintenanceInput = {
    plan,
    job,
    host: {
      node: { ...executor.executable },
      artifactSha256: executor.artifactSha256,
      assertCurrent() {
        hostCheck();
      },
    },
    attestChild: vi.fn(async (actualPid) => {
      expect(actualPid).toBe(pid);
      return attestation;
    }),
    now: () => "2026-10-17T00:00:03.000Z",
  };
  // Inert ChildProcess/streams only. No OS process is spawned by these cases.
  const child = new ChildProcess(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const writes: Buffer[] = [];
  let holdWrites = false;
  const gate = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      if (!holdWrites) callback();
    },
  });
  Object.defineProperties(child, {
    pid: { value: pid, writable: true },
    stdout: { value: stdout },
    stderr: { value: stderr },
    stdio: { value: [null, stdout, stderr, gate] },
  });
  const spawnChild = vi.fn<GatedSupervisorSpawn>(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const arrangement = createGatedSupervisorMaintenance(input, spawnChild);
  function consumed(proof: Awaited<ReturnType<typeof arrangement.launch>>): SupervisorEffect {
    return {
      ...reservation,
      phase: "consumed",
      consumedAt: "2026-10-17T00:00:04.000Z",
      child: structuredClone(proof.claim),
    };
  }
  return {
    input,
    plan,
    job,
    reservation,
    preflight,
    attestation,
    child,
    stdout,
    stderr,
    gate,
    writes,
    spawnChild,
    arrangement,
    consumed,
    buffer,
    holdWrites() {
      holdWrites = true;
    },
    setHostCheck(check: () => void) {
      hostCheck = check;
    },
  };
}

test("gated supervisor queues once to the exact retained child with whole argv and minimal environment", async () => {
  const f = gatedFixture();
  const proof = await f.arrangement.launch(f.reservation, f.preflight);
  expect(f.spawnChild).toHaveBeenCalledExactlyOnceWith(
    f.plan.node,
    ["--input-type=module", "--eval", f.buffer],
    {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", VORTEO_RESTART_JOB_ID: f.job.id, VORTEO_RESTART_FORCE: "0" },
    },
  );
  expect(f.child.listenerCount("error")).toBe(1);
  expect(f.child.listenerCount("exit")).toBe(1);
  expect(f.gate.listenerCount("error")).toBe(1);
  expect(f.writes).toEqual([]);
  f.arrangement.invoke(f.consumed(proof), proof);
  expect(f.writes).toEqual([Buffer.from([1])]);
  expect(f.arrangement.snapshot()).toMatchObject({
    launchAttempted: true,
    releaseAttempted: true,
    delivery: "unknown",
  });
  expect(() => f.arrangement.invoke(f.consumed(proof), proof)).toThrow("already attempted");
  await expect(f.arrangement.launch(f.reservation, f.preflight)).rejects.toThrow(
    "already attempted",
  );
  expect(f.spawnChild).toHaveBeenCalledTimes(1);
});
test.each(["throw", "error", "exit", "close"])(
  "gated supervisor spawn %s permanently fences another launch",
  async (mode) => {
    const f = gatedFixture();
    f.spawnChild.mockImplementation(() => {
      expect(f.arrangement.snapshot().launchAttempted).toBe(true);
      if (mode === "throw") throw Error("spawn failed");
      queueMicrotask(() => f.child.emit(mode, new Error("spawn unconfirmed")));
      return f.child;
    });
    await expect(f.arrangement.launch(f.reservation, f.preflight)).rejects.toThrow();
    await expect(f.arrangement.launch(f.reservation, f.preflight)).rejects.toThrow(
      "already attempted",
    );
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
    expect(f.writes).toEqual([]);
  },
);
test("gated supervisor retains all handlers and drains bounded output while attestation is pending", async () => {
  const f = gatedFixture();
  let finish: ((value: typeof f.attestation) => void) | undefined;
  f.input.attestChild = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const launching = f.arrangement.launch(f.reservation, f.preflight);
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.stdout.write(Buffer.alloc(12000, 65));
  f.stderr.write(Buffer.alloc(12000, 66));
  f.stdout.write("drained");
  f.stderr.write("drained");
  expect(f.arrangement.snapshot()).toMatchObject({
    truncated: { stdout: true, stderr: true },
    delivery: "unknown",
  });
  expect(Buffer.byteLength(f.arrangement.snapshot().stdout)).toBe(8192);
  expect(Buffer.byteLength(f.arrangement.snapshot().stderr)).toBe(8192);
  if (!finish) throw Error("Attestation did not start");
  finish(f.attestation);
  await launching;
  expect(f.stdout.listenerCount("data")).toBe(1);
  expect(f.stderr.listenerCount("data")).toBe(1);
});
test.each(["sync", "lost-ack"])(
  "gated supervisor %s attestation failure retains the same child without a second spawn",
  async (mode) => {
    const f = gatedFixture();
    f.input.attestChild = () => {
      if (mode === "sync") throw Error("lost ack");
      return Promise.reject(Error("lost ack"));
    };
    await expect(f.arrangement.launch(f.reservation, f.preflight)).rejects.toThrow("lost ack");
    expect(f.arrangement.snapshot()).toMatchObject({
      pid: f.child.pid,
      releaseAttempted: false,
      child: null,
    });
    await expect(f.arrangement.launch(f.reservation, f.preflight)).rejects.toThrow(
      "already attempted",
    );
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
    expect(f.writes).toEqual([]);
  },
);
test.each(["parent", "node", "argv", "audit", "script", "boot", "uid", "artifact", "pid"])(
  "gated supervisor refuses independent %s substitution",
  async (field) => {
    const f = gatedFixture(),
      e = f.attestation.executor;
    if (field === "pid") e.pid++;
    if (field === "boot") e.bootId = randomUUID();
    if (field === "uid") e.uid++;
    if (field === "artifact") e.artifactSha256 = "0".repeat(64);
    if (field === "parent") e.parentPid++;
    if (field === "node") e.executable.sha256 = "0".repeat(64);
    if (field === "argv") e.argumentsSha256 = "0".repeat(64);
    if (field === "audit") e.auditToken[5]++;
    if (field === "script") e.entrypoint.sha256 = "0".repeat(64);
    await expect(f.arrangement.launch(f.reservation, f.preflight)).rejects.toThrow(
      "identity differs",
    );
    expect(f.writes).toEqual([]);
  },
);
test.each(["host", "controller", "reservation", "child"])(
  "gated supervisor detects %s mutation after custody callback",
  async (field) => {
    const f = gatedFixture();
    f.attestation.assertCurrent = () => {
      if (field === "host") f.input.host.node.sha256 = "0".repeat(64);
      if (field === "controller") f.preflight.controller.startIdentity = "changed";
      if (field === "reservation") f.reservation.binding.generation = randomUUID();
      if (field === "child") f.attestation.executor.startIdentity = "changed";
    };
    await expect(f.arrangement.launch(f.reservation, f.preflight)).rejects.toThrow();
    expect(f.writes).toEqual([]);
    await expect(f.arrangement.launch(f.reservation, f.preflight)).rejects.toThrow(
      "already attempted",
    );
  },
);
test.each(["callback", "claim", "effect", "exit", "gate-error", "queue-throw"])(
  "gated supervisor %s failure never retries a release",
  async (field) => {
    const f = gatedFixture();
    let changedEffect: SupervisorEffect | null = null;
    f.attestation.assertCurrent = () => {
      if (!changedEffect) return;
      if (field === "callback") throw Error("custody unavailable");
      if (field === "effect") changedEffect.binding.generation = randomUUID();
    };
    const proof = await f.arrangement.launch(f.reservation, f.preflight),
      effect = f.consumed(proof);
    changedEffect = effect;
    if (field === "claim") proof.claim.executor.pid++;
    if (field === "exit") f.child.emit("exit", 1, null);
    if (field === "gate-error") f.gate.emit("error", Error("gate unavailable"));
    if (field === "queue-throw")
      vi.spyOn(f.gate, "end").mockImplementation(() => {
        expect(f.arrangement.snapshot().releaseAttempted).toBe(true);
        throw Error("lost queue reply");
      });
    expect(() => f.arrangement.invoke(effect, proof)).toThrow();
    expect(f.arrangement.snapshot().releaseAttempted).toBe(true);
    expect(() => f.arrangement.invoke(effect, proof)).toThrow("already attempted");
    expect(f.writes).toEqual([]);
  },
);
test("gated supervisor callback success or later stream errors never proves delivery or settlement", async () => {
  const f = gatedFixture(),
    proof = await f.arrangement.launch(f.reservation, f.preflight);
  f.arrangement.invoke(f.consumed(proof), proof);
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.gate.emit("error", Error("late stream error"));
  f.child.emit("exit", 0, null);
  expect(f.arrangement.snapshot()).toMatchObject({
    queueCallback: true,
    delivery: "unknown",
    childExited: true,
    errors: ["gate"],
  });
  expect(f.arrangement.snapshot()).not.toHaveProperty("settled");
});

test.each(["stdout", "stderr", "gate-close"])(
  "gated supervisor retains %s failure before release",
  async (kind) => {
    const f = gatedFixture(),
      proof = await f.arrangement.launch(f.reservation, f.preflight);
    if (kind === "gate-close") f.gate.emit("close");
    else if (kind === "stdout") f.stdout.emit("error", Error("stream unavailable"));
    else f.stderr.emit("error", Error("stream unavailable"));
    expect(() => f.arrangement.invoke(f.consumed(proof), proof)).toThrow("unavailable");
    expect(f.writes).toEqual([]);
    expect(f.arrangement.snapshot().releaseAttempted).toBe(true);
  },
);
test("gated supervisor rechecks public child claim immediately after Host custody callback", async () => {
  const f = gatedFixture();
  let returnedProof: Awaited<ReturnType<typeof f.arrangement.launch>> | null = null;
  f.setHostCheck(() => {
    if (returnedProof) returnedProof.claim.executor.pid++;
  });
  const proof = await f.arrangement.launch(f.reservation, f.preflight),
    effect = f.consumed(proof);
  returnedProof = proof;
  expect(() => f.arrangement.invoke(effect, proof)).toThrow("custody changed");
  expect(f.writes).toEqual([]);
});
test("gated supervisor retains its private custody callback when public proof method is replaced", async () => {
  const f = gatedFixture(),
    proof = await f.arrangement.launch(f.reservation, f.preflight),
    effect = f.consumed(proof);
  proof.assertCurrent = () => {};
  f.attestation.executor.startIdentity = "substituted";
  expect(() => f.arrangement.invoke(effect, proof)).toThrow("custody changed");
  expect(f.writes).toEqual([]);
});
test.each(["ungated", "changed"])(
  "gated supervisor refuses %s buffer without spawning",
  async (kind) => {
    const f = kind === "ungated" ? gatedFixture("void 0;\n") : gatedFixture();
    if (kind === "changed") writeFileSync(f.plan.script, f.buffer + "\n");
    await expect(f.arrangement.launch(f.reservation, f.preflight)).rejects.toThrow(
      "whole gated script",
    );
    expect(f.spawnChild).not.toHaveBeenCalled();
    expect(f.arrangement.snapshot().launchAttempted).toBe(true);
  },
);

test("gated supervisor lost queue acknowledgement cannot enqueue a second token", async () => {
  const f = gatedFixture(),
    proof = await f.arrangement.launch(f.reservation, f.preflight),
    effect = f.consumed(proof);
  vi.spyOn(f.gate, "end").mockImplementation(() => {
    f.gate.write(Buffer.from([1]));
    throw Error("lost queue acknowledgement");
  });
  expect(() => f.arrangement.invoke(effect, proof)).toThrow("lost queue acknowledgement");
  expect(() => f.arrangement.invoke(effect, proof)).toThrow("already attempted");
  expect(f.writes).toEqual([Buffer.from([1])]);
  expect(f.arrangement.snapshot().delivery).toBe("unknown");
});
test("gated supervisor pending stream write returns only a local queue attempt", async () => {
  const f = gatedFixture(),
    proof = await f.arrangement.launch(f.reservation, f.preflight);
  f.holdWrites();
  expect(f.arrangement.invoke(f.consumed(proof), proof)).toBeUndefined();
  expect(f.arrangement.snapshot()).toMatchObject({
    releaseAttempted: true,
    queueCallback: false,
    delivery: "unknown",
  });
  expect(() => f.arrangement.invoke(f.consumed(proof), proof)).toThrow("already attempted");
});

test("gated supervisor extraction preserves preflight refusal before any process attempt", async () => {
  const f = gatedFixture();
  f.preflight.assertCurrent = () => {
    throw Error("Admission unavailable");
  };
  await expect(f.arrangement.launch(f.reservation, f.preflight)).rejects.toThrow(
    "Admission unavailable",
  );
  expect(f.spawnChild).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
  expect(f.arrangement.snapshot()).toMatchObject({
    launchAttempted: true,
    spawnObserved: false,
    pid: null,
    errors: ["launch"],
  });
});

test("gated supervisor extraction cannot release with a reconstructed child proof", async () => {
  const f = gatedFixture();
  const original = await f.arrangement.launch(f.reservation, f.preflight);
  const copied = { claim: structuredClone(original.claim), assertCurrent: original.assertCurrent };
  expect(() => f.arrangement.invoke(f.consumed(original), copied)).toThrow(
    "retained consumed child",
  );
  expect(f.writes).toEqual([]);
  expect(f.arrangement.snapshot().releaseAttempted).toBe(true);
  expect(() => f.arrangement.invoke(f.consumed(original), original)).toThrow("already attempted");
});
