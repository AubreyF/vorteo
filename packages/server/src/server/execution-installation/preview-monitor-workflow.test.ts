import { createInstallationServer } from "./server.js";
import { hashDaemonPassword } from "../auth.js";
import pino from "pino";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import {
  RestartJobSchema,
  RestartDecisionSchema,
  RestartRequestSchema,
} from "@getpaseo/protocol/execution-installation";
import type {
  PreviewMonitorPlan,
  PreviewMonitorJob,
} from "@getpaseo/protocol/preview-monitor-maintenance";
import { InstallationRestarts, type RestartExecutor, type RestartJournal } from "./restarts.js";
import { parseLifecycleJournal, type LifecycleJob } from "./lifecycle-journal.js";
import { assertFrozenCoordinatorIdle } from "./coordinator-bootstrap.js";
const plan = (): PreviewMonitorPlan => ({
  version: 1,
  operation: "preview-monitor-replace",
  installationId: randomUUID(),
  sourceCommit: "a".repeat(40),
  containerId: "b".repeat(64),
  destination: "/home/paseo/.local/bin/paseo-preview",
  candidate: { path: "/protected/next", sha256: "c".repeat(64) },
  previous: { path: "/protected/before", sha256: "d".repeat(64) },
  expected: { sha256: "d".repeat(64), uid: 0, gid: 0, mode: 0o755 },
  ancestrySha256: "e".repeat(64),
});
function fixture(extras: Partial<RestartExecutor> = {}) {
  let records: LifecycleJob[] = [];
  const journal: RestartJournal = {
    read: () => structuredClone(records),
    write: (jobs) => {
      records = parseLifecycleJournal(jobs);
    },
  };
  const install = vi.fn(async () => "verified");
  const executor: RestartExecutor = {
    restart: vi.fn(async () => "ready"),
    validateMonitorPlan: vi.fn(async () => {}),
    installMonitor: install,
    monitorCompatible: async () => true,
    ...extras,
  };
  const queue = new InstallationRestarts(journal, executor, Date.now, {
    hostRequestsAfter: "2026-01-01T00:00:00.000Z",
  });
  return {
    queue,
    journal,
    executor,
    install,
    prepare: () =>
      queue.prepareMonitor({ id: randomUUID(), reason: "Monitor", plan: plan() }, "host-agent"),
  };
}
const decision = (job: PreviewMonitorJob, action: "approve" | "cancel" = "approve") => ({
  id: job.id,
  revision: job.revision,
  planSha256: job.planSha256,
  operation: job.operation,
  decision: action,
});
test("manual exact monitor approval, never daemon auto policy", async () => {
  const f = fixture();
  const j = await f.prepare();
  await f.queue.drain();
  expect(f.install).not.toHaveBeenCalled();
  for (const change of [
    { revision: randomUUID() },
    { planSha256: "f".repeat(64) },
    { operation: "native-helper-install" },
  ])
    expect(() => f.queue.decideMonitor({ ...decision(j), ...change })).toThrow();
  expect(() => f.queue.decide(j.id, j.revision, "approve")).toThrow();
  f.queue.decideMonitor(decision(j));
  await f.queue.drain();
  await f.queue.drain();
  expect(f.install).toHaveBeenCalledTimes(1);
  expect(f.queue.listMonitors()[0]?.status).toBe("succeeded");
  expect(f.executor.restart).not.toHaveBeenCalled();
});
test("legacy schemas reject monitor target, decision and job", async () => {
  const f = fixture();
  const j = await f.prepare();
  expect(() => RestartRequestSchema.parse({ target: j.target, reason: j.reason })).toThrow();
  expect(() => RestartDecisionSchema.parse(decision(j))).toThrow();
  expect(() => RestartJobSchema.parse(j)).toThrow();
  expect(parseLifecycleJournal([j])).toEqual([j]);
  expect(() => parseLifecycleJournal([j, j])).toThrow("duplicate");
});
test("Host access and compatible recovery required", async () => {
  const f = fixture({ monitorCompatible: async () => false });
  await expect(f.prepare()).rejects.toThrow("compatible");
  await expect(f.queue.prepareMonitor({}, "container-agent")).rejects.toThrow("Host");
  expect(f.journal.read()).toEqual([]);
});
test("cancel during predispatch validation prevents executor", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => (entered = r));
  let n = 0;
  const f = fixture({
    validateMonitorPlan: async () => {
      if (++n === 2) {
        entered();
        await new Promise<void>((r) => (release = r));
      }
    },
  });
  const j = await f.prepare();
  f.queue.decideMonitor(decision(j));
  const running = f.queue.drain();
  await waiting;
  f.queue.decideMonitor(decision(j, "cancel"));
  release();
  await running;
  expect(f.install).not.toHaveBeenCalled();
  expect(f.queue.listMonitors()[0]?.status).toBe("rejected");
});
test("cancel during preparation is retained", async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    validateMonitorPlan: async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  const preparing = f.prepare();
  await ready;
  const j = f.queue.listMonitors()[0]!;
  f.queue.decideMonitor(decision(j, "cancel"));
  release();
  await preparing;
  expect(f.queue.listMonitors()[0]?.status).toBe("rejected");
});
test("durable dispatch precedes writes and ends cancellation", async () => {
  const f = fixture({
    installMonitor: async (j) => {
      expect(f.journal.read().find((x) => x.id === j.id)?.status).toBe("running");
      expect(() => f.queue.decideMonitor(decision(j, "cancel"))).toThrow("dispatched");
      return "verified";
    },
  });
  const j = await f.prepare();
  f.queue.decideMonitor(decision(j));
  await f.queue.drain();
  expect(f.queue.listMonitors()[0]?.status).toBe("succeeded");
});
test("uncertain execution fences lifecycle and survives coordinator crash without replay", async () => {
  const f = fixture({
    installMonitor: async () => {
      throw Error("lost");
    },
  });
  const j = await f.prepare();
  f.queue.decideMonitor(decision(j));
  await f.queue.drain();
  expect(f.queue.listMonitors()[0]?.stage).toBe("recovery_required");
  const d = f.queue.request({ target: "host", reason: "x" }, "owner");
  f.queue.decide(d.id, d.revision, "approve");
  await f.queue.drain();
  const resumed = new InstallationRestarts(f.journal, f.executor);
  await resumed.drain();
  expect(f.executor.restart).not.toHaveBeenCalled();
  expect(resumed.listMonitors()[0]?.stage).toBe("recovery_required");
  expect(() => assertFrozenCoordinatorIdle(f.journal.read(), [])).toThrow("unresolved");
});
test.each(["approved", "running"] as const)("startup never replays %s monitor", async (status) => {
  const f = fixture();
  const j = await f.prepare();
  f.journal.write([
    {
      ...j,
      status,
      stage: status === "running" ? "dispatch_pending" : "prepared",
    },
  ]);
  const resumed = new InstallationRestarts(f.journal, f.executor);
  await resumed.drain();
  expect(f.install).not.toHaveBeenCalled();
  expect(resumed.listMonitors()[0]?.stage).toBe("recovery_required");
});
test("Factory uncertainty blocks monitor and keeps Factory fence", async () => {
  const f = fixture({
    factoryRuntimePlan: () => "f".repeat(64),
    adoptFactoryRuntime: async () => "ready",
  });
  const j = await f.prepare();
  f.queue.decideMonitor(decision(j));
  const factory = f.queue.request(
    {
      target: "container-daemon",
      reason: "Factory",
      factoryRuntimePlanSha256: "f".repeat(64),
    },
    "host-agent",
  );
  f.journal.write([
    ...f.journal.read().filter((x) => x.id !== factory.id),
    { ...factory, status: "failed", factoryRuntimeRecoveryRequired: true },
  ]);
  const resumed = new InstallationRestarts(f.journal, f.executor);
  await resumed.drain();
  expect(f.install).not.toHaveBeenCalled();
  expect(resumed.list()[0]?.factoryRuntimeRecoveryRequired).toBe(true);
});
test("idempotent preparation binds exact plan and reason", async () => {
  const f = fixture();
  const input = { id: randomUUID(), reason: "Monitor", plan: plan() };
  const j = await f.queue.prepareMonitor(input, "host-agent");
  expect(await f.queue.prepareMonitor(input, "host-agent")).toEqual(j);
  await expect(f.queue.prepareMonitor({ ...input, reason: "Other" }, "host-agent")).rejects.toThrow(
    "different",
  );
});

test("real HTTP routes isolate Host request access from owner-only exact buttons", async () => {
  const { mkdtemp, rm, writeFile, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createHash } = await import("node:crypto");
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "monitor-http-")));
  await writeFile(path.join(dir, "index.html"), "<html><head></head></html>");
  const digest = (s: string) => createHash("sha256").update(s).digest("hex");
  const installationId = randomUUID();
  const install = vi.fn(async () => "verified monitor");
  const config: import("./config.js").InstallationConfig = {
    public: {
      version: 1,
      installationId,
      origin: "https://owner.example.test",
      environments: [
        { kind: "host", serverId: "host", endpoint: "host.example.test", useTls: true },
        { kind: "container", serverId: "dev", endpoint: "dev.example.test", useTls: true },
      ],
    },
    listenPort: 6770,
    webDistDir: dir,
    stateDir: dir,
    ownerPasswordHash: hashDaemonPassword("owner"),
    hostAgentTokenHash: digest("host"),
    containerAgentTokenHash: digest("guest"),
    host: {
      endpoint: "127.0.0.1:6771",
      password: "host-pass",
      launchdService: "gui/501/local.vorteo.test.host",
    },
    container: { endpoint: "127.0.0.1:6768", password: "dev-pass" },
  };
  const app = createInstallationServer(
    config,
    {
      restart: async () => {
        throw Error("No daemon restart");
      },
      monitorCompatible: async () => true,
      validateMonitorPlan: async () => {},
      installMonitor: install,
    },
    pino({ level: "silent" }),
  );
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => listener.once("listening", r));
  const address = listener.address();
  if (!address || typeof address === "string") throw Error("Missing test address");
  config.listenPort = address.port;
  const request = (
    route: string,
    token?: string,
    body?: unknown,
    origin = "https://owner.example.test",
  ) =>
    fetch(`http://127.0.0.1:${address.port}/api/installation/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        origin,
        Host: "owner.example.test",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const input = { id: randomUUID(), reason: "Monitor", plan: { ...plan(), installationId } };
    expect((await request("monitor-requests", "guest", input)).status).toBe(401);
    expect((await request("owner/monitors/query", "host", {})).status).toBe(401);
    const capability = await (await request("capabilities", "host")).json();
    expect(capability.previewMonitor).toEqual({ available: true, ownerApprovalRequired: true });
    const guestCapability = await (await request("capabilities", "guest")).json();
    expect(guestCapability.previewMonitor.available).toBe(false);
    const submitted = await request("monitor-requests", "host", input);
    expect(submitted.status).toBe(201);
    const job = (await submitted.json()) as PreviewMonitorJob;
    expect(job.stage).toBe("prepared");
    const summary = await (await request("restart-summary")).json();
    expect(summary.previewMonitor.requested).toBe(1);
    expect(summary).not.toHaveProperty("jobs");
    expect((await request(`monitor-requests/${job.id}`, "guest")).status).toBe(401);
    expect((await request("owner/monitors/decision", "host", decision(job))).status).toBe(401);
    expect(
      (
        await request(
          "owner/monitors/decision",
          "owner",
          decision(job),
          "https://foreign.example.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request("owner/monitors/decision", "owner", {
          ...decision(job),
          revision: randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(install).not.toHaveBeenCalled();
    const approved = await request("owner/monitors/decision", "owner", decision(job));
    expect(approved.status).toBe(200);
    await app.drainRestarts();
    expect(install).toHaveBeenCalledTimes(1);
    expect((await (await request(`monitor-requests/${job.id}`, "host")).json()).status).toBe(
      "succeeded",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
