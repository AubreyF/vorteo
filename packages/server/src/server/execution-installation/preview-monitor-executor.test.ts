import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  createPreviewMonitorExecutor,
  monitorCommand,
  type MonitorCommand,
} from "./preview-monitor-executor.js";
import type {
  PreviewMonitorJob,
  PreviewMonitorPlan,
} from "@getpaseo/protocol/preview-monitor-maintenance";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
async function fixture(change: (command: MonitorCommand) => string | undefined = () => undefined) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "monitor-executor-")));
  const file = async (name: string, bytes: string) => {
    const p = path.join(dir, name);
    await writeFile(p, bytes, { mode: name === "node" ? 0o700 : 0o600 });
    return { path: p, sha256: sha(bytes) };
  };
  const candidate = await file("candidate", "next"),
    previous = await file("previous", "before");
  const config = {
    docker: "/protected/docker",
    socket: "/protected/docker.sock",
    containerId: "a".repeat(64),
    home: "/home/paseo" as const,
    worker: await file("worker.py", "# reviewed filesystem worker"),
    recovery: {
      node: await file("node", "node bytes"),
      journal: await file("journal.mjs", "parser bytes"),
      queue: await file("queue.mjs", "queue bytes"),
    },
  };
  const plan: PreviewMonitorPlan = {
    version: 1,
    operation: "preview-monitor-replace",
    installationId: randomUUID(),
    sourceCommit: "b".repeat(40),
    containerId: config.containerId,
    destination: "/home/paseo/.local/bin/paseo-preview",
    candidate,
    previous,
    expected: { sha256: previous.sha256, uid: 0, gid: 0, mode: 0o755 },
    ancestrySha256: "c".repeat(64),
  };
  const job: PreviewMonitorJob = {
    id: randomUUID(),
    revision: randomUUID(),
    target: "preview-monitor",
    operation: plan.operation,
    plan,
    planSha256: sha(JSON.stringify(plan)),
    reason: "Monitor",
    createdAt: new Date().toISOString(),
    requestedBy: "host-agent",
    status: "running",
    stage: "dispatch_pending",
    detail: "Dispatch",
  };
  const calls: MonitorCommand[] = [];
  let selected = previous.sha256;
  const command = async (c: MonitorCommand) => {
    calls.push(c);
    const override = change(c);
    if (override !== undefined) return override;
    if (c.executable === config.recovery.node.path) return "monitor-journal-v1";
    if (c.args.includes("inspect")) return config.containerId + "\n";
    const input = JSON.parse(c.input!);
    if (input.operation === "inspect")
      return JSON.stringify({
        ok: true,
        result: {
          containerId: config.containerId,
          destination: plan.destination,
          canonicalPath: plan.destination,
          sha256: selected,
          uid: 0,
          gid: 0,
          mode: 0o755,
          regularFile: true,
          links: 1,
          ancestrySha256: plan.ancestrySha256,
        },
      });
    const request = input.request;
    selected = candidate.sha256;
    return JSON.stringify({
      ok: true,
      result: {
        ...request,
        displacedSha256: previous.sha256,
        displacedPath: `/home/paseo/.local/bin/.paseo-preview.${request.id}.staged`,
        status: "installed",
        phase: "verified",
      },
    });
  };
  return {
    dir,
    calls,
    config,
    plan,
    job,
    executor: createPreviewMonitorExecutor(
      {
        installationId: plan.installationId,
        configuration: config,
        writableMountRoots: async () => [],
      },
      { command },
    ),
  };
}
test("exact immutable root transport, retained bytes and postcommit selection inspection", async () => {
  const f = await fixture();
  try {
    await expect(f.executor.installMonitor(f.job)).resolves.toContain("verified");
    const writes = f.calls.filter((c) => c.input && JSON.parse(c.input).operation === "replace");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args.slice(0, 9)).toEqual([
      "--host",
      "unix:///protected/docker.sock",
      "exec",
      "--user",
      "0:0",
      "-i",
      f.config.containerId,
      "/usr/bin/python3",
      "-I",
    ]);
    expect(JSON.parse(writes[0]!.input!).request).toMatchObject({
      candidateBase64: Buffer.from("next").toString("base64"),
      previousBase64: Buffer.from("before").toString("base64"),
      ancestrySha256: f.plan.ancestrySha256,
    });
    expect(
      f.calls.some((c) => c.args.some((a) => /^(launchctl|supervisorctl|restart|hold)$/.test(a))),
    ).toBe(false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("recovery executable must actually parse monitor journal", async () => {
  const f = await fixture((c) =>
    c.args.includes("--input-type=module") ? "legacy reader" : undefined,
  );
  try {
    expect(await f.executor.monitorCompatible()).toBe(false);
    await expect(f.executor.installMonitor(f.job)).rejects.toThrow("readers");
    expect(f.calls.some((c) => c.input)).toBe(false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("immutable container mismatch never dispatches", async () => {
  const f = await fixture((c) => (c.args.includes("inspect") ? "d".repeat(64) : undefined));
  try {
    await expect(f.executor.installMonitor(f.job)).rejects.toThrow("container");
    expect(f.calls.some((c) => c.input)).toBe(false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("candidate changed after review fails before root write", async () => {
  const f = await fixture();
  try {
    await writeFile(f.plan.candidate.path, "substituted");
    await expect(f.executor.installMonitor(f.job)).rejects.toThrow();
    expect(f.calls.some((c) => c.input && JSON.parse(c.input).operation === "replace")).toBe(false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("worker changed after review fails compatibility without executing it", async () => {
  const f = await fixture();
  try {
    await writeFile(f.config.worker.path, "substituted");
    expect(await f.executor.monitorCompatible()).toBe(false);
    expect(f.calls).toEqual([]);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("missing ancestry and unapproved/changed job cannot execute", async () => {
  const f = await fixture();
  try {
    await expect(f.executor.installMonitor({ ...f.job, status: "approved" })).rejects.toThrow(
      "dispatched",
    );
    await expect(
      f.executor.installMonitor({ ...f.job, planSha256: "f".repeat(64) }),
    ).rejects.toThrow("dispatched");
    await expect(f.executor.validateMonitorPlan({ ...f.plan, ancestrySha256: "" })).rejects.toThrow(
      "ancestry",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("uncertainty receipt cannot be promoted to installed success", async () => {
  const f = await fixture((c) =>
    c.input && JSON.parse(c.input).operation === "replace"
      ? JSON.stringify({
          ok: false,
          uncertain: true,
          receipt: { status: "uncertain" },
        })
      : undefined,
  );
  try {
    await expect(f.executor.installMonitor(f.job)).rejects.toThrow("uncertain");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("real retained Node executable and built readers parse monitor in fenced memory", async () => {
  const f = await fixture();
  const { readFile } = await import("node:fs/promises");
  try {
    // Retain a private copy, as the installer does: a shared toolchain directory such as
    // the CI tool cache cannot satisfy the recovery executable's custody checks.
    const executable = path.join(await realpath(f.dir), "retained-node");
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o755);
    const dist = path.resolve(
      import.meta.dirname,
      "../../../dist/server/server/execution-installation",
    );
    const protectedFile = async (file: string) => ({
      path: file,
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    });
    const config = {
      ...f.config,
      recovery: {
        node: await protectedFile(executable),
        journal: await protectedFile(path.join(dist, "lifecycle-journal.js")),
        queue: await protectedFile(path.join(dist, "restarts.js")),
      },
    };
    const executor = createPreviewMonitorExecutor(
      {
        installationId: f.plan.installationId,
        configuration: config,
        writableMountRoots: async () => [],
      },
      { command: monitorCommand },
    );
    expect(await executor.monitorCompatible()).toBe(true);
    const old = path.join(f.dir, "old-reader.mjs");
    await writeFile(
      old,
      'export function parseLifecycleJournal(){throw Error("unsupported monitor target")}',
    );
    const legacy = createPreviewMonitorExecutor(
      {
        installationId: f.plan.installationId,
        configuration: {
          ...config,
          recovery: { ...config.recovery, journal: await protectedFile(old) },
        },
        writableMountRoots: async () => [],
      },
      { command: monitorCommand },
    );
    expect(await legacy.monitorCompatible()).toBe(false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
