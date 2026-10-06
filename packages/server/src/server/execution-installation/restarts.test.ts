import { expect, test, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createInstallationRestartExecutor } from "./daemon.js";
import type { InstallationConfig } from "./config.js";
import type { RestartImpact, RestartJob } from "@getpaseo/protocol/execution-installation";
import { InstallationRestarts, type RestartJournal } from "./restarts.js";

class MemoryJournal implements RestartJournal {
  jobs: RestartJob[] = [];
  failWrite = false;
  read() {
    return structuredClone(this.jobs);
  }
  write(jobs: RestartJob[]) {
    if (this.failWrite) throw new Error("disk unavailable");
    this.jobs = structuredClone(jobs);
  }
}

test("request-only callers cannot cause a restart, and approval is bound to the exact revision", async () => {
  const calls: string[] = [];
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: async (target) => {
      calls.push(target);
      return "ready";
    },
  });
  const request = queue.request(
    { target: "host", reason: "Install reviewed release" },
    "container-agent",
  );
  await queue.drain();
  expect(calls).toEqual([]);
  expect(() => queue.decide(request.id, "wrong-revision", "approve")).toThrow("changed");
  queue.decide(request.id, request.revision, "approve");
  await Promise.all([queue.drain(), queue.drain()]);
  expect(calls).toEqual(["host"]);
  expect(queue.list()[0]?.status).toBe("succeeded");
  expect(() => queue.decide(request.id, request.revision, "approve")).toThrow("already decided");
});

test("rejection and journal failure prevent dispatch; old requests remain approvable", async () => {
  let now = Date.now();
  const journal = new MemoryJournal();
  const calls: string[] = [];
  const queue = new InstallationRestarts(
    journal,
    {
      restart: async (target) => {
        calls.push(target);
        return "ready";
      },
    },
    () => now,
  );
  const expired = queue.request({ target: "host", reason: "Prepared" }, "host-agent");
  now += 7 * 24 * 60 * 60_000;
  expect(queue.list()[0]?.status).toBe("pending");
  queue.decide(expired.id, expired.revision, "reject");
  const rejected = queue.request(
    { target: "container-daemon", reason: "Prepared" },
    "container-agent",
  );
  queue.decide(rejected.id, rejected.revision, "reject");
  await queue.drain();
  const prepared = queue.request({ target: "host", reason: "Prepared again" }, "host-agent");
  journal.failWrite = true;
  expect(() => queue.decide(prepared.id, prepared.revision, "approve")).toThrow("disk unavailable");
  await queue.drain();
  expect(calls).toEqual([]);
});

test("a coordinator interruption never repeats an approved or running disruptive action", async () => {
  const journal = new MemoryJournal();
  const first = new InstallationRestarts(journal, { restart: async () => "ready" });
  const request = first.request({ target: "host", reason: "Prepared" }, "owner");
  first.decide(request.id, request.revision, "approve");
  const calls: string[] = [];
  const restored = new InstallationRestarts(journal, {
    restart: async (target) => {
      calls.push(target);
      return "ready";
    },
  });
  await restored.drain();
  expect(calls).toEqual([]);
  expect(restored.list()[0]?.status).toBe("failed");
  expect(restored.list()[0]?.detail).toContain("Inspect target");
});

test("readiness failure stays failed rather than retrying a restart", async () => {
  let calls = 0;
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: async () => {
      calls++;
      throw new Error("readiness deadline exceeded");
    },
  });
  const request = queue.request({ target: "container-daemon", reason: "Prepared" }, "owner");
  queue.decide(request.id, request.revision, "approve");
  await queue.drain();
  await queue.drain();
  expect(calls).toBe(1);
  expect(queue.list()[0]).toMatchObject({
    status: "failed",
    detail: "readiness deadline exceeded",
  });
});

test("each target has one active request across all requesters", async () => {
  const queue = new InstallationRestarts(new MemoryJournal(), { restart: async () => "ready" });
  const host = queue.request({ target: "host", reason: "Prepared" }, "host-agent");
  const container = queue.request(
    { target: "container-daemon", reason: "Prepared" },
    "container-agent",
  );
  expect(() => queue.request({ target: "host", reason: "Duplicate" }, "owner")).toThrow("already");
  expect(() =>
    queue.request({ target: "container-daemon", reason: "Duplicate" }, "host-agent"),
  ).toThrow("already");
  queue.decide(host.id, host.revision, "approve");
  expect(() =>
    queue.request({ target: "host", reason: "Duplicate approved" }, "container-agent"),
  ).toThrow("already");
  await queue.drain();
  expect(queue.request({ target: "host", reason: "Next maintenance" }, "owner").status).toBe(
    "pending",
  );
  expect(
    queue
      .list()
      .filter((job) => job.status === "pending")
      .map((job) => job.target),
  ).toEqual([container.target, "host"]);
});

test("old requests remain pending and duplicate legacy requests retain receipts", () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const journal = new MemoryJournal();
  const first = new InstallationRestarts(journal, { restart: async () => "ready" }, () => now);
  const expired = first.request({ target: "host", reason: "Prepared" }, "host-agent");
  now += 30 * 60_000;
  expect(first.list()[0]).toMatchObject({
    id: expired.id,
    status: "pending",
  });
  expect(journal.read()[0]?.status).toBe("pending");
  const original = first.request(
    { target: "container-daemon", reason: "Prepared again" },
    "host-agent",
  );
  journal.jobs.push({
    ...original,
    id: "legacy-duplicate",
    revision: "legacy-revision",
    requestedBy: "owner",
  });
  const restored = new InstallationRestarts(journal, { restart: async () => "ready" }, () => now);
  expect(restored.list().map((job) => [job.id, job.status])).toEqual([
    [expired.id, "pending"],
    [original.id, "rejected"],
    ["legacy-duplicate", "pending"],
  ]);
  expect(() => restored.decide(original.id, original.revision, "approve")).toThrow(
    "already decided",
  );
});

test("slow healthy status responses allow exactly one restart and require a replacement PID", async () => {
  const config = {
    public: { environments: [{ kind: "container", serverId: "test-container" }] },
    container: { endpoint: "127.0.0.1:1", password: "test-only" },
  } as unknown as InstallationConfig;
  const connect = vi.spyOn(DaemonClient.prototype, "connect").mockResolvedValue();
  const close = vi.spyOn(DaemonClient.prototype, "close").mockResolvedValue();
  let calls = 0;
  const status = vi.spyOn(DaemonClient.prototype, "getDaemonStatus").mockImplementation(
    (options) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearTimeout(response);
          reject(new Error("Status deadline exceeded"));
        }, options?.timeout);
        const response = setTimeout(() => {
          clearTimeout(timeout);
          resolve({ pid: ++calls === 1 ? 100 : 200 } as Awaited<
            ReturnType<DaemonClient["getDaemonStatus"]>
          >);
        }, 4000);
      }),
  );
  const restart = vi
    .spyOn(DaemonClient.prototype, "restartServer")
    .mockResolvedValue(undefined as never);
  try {
    await expect(
      createInstallationRestartExecutor(config).restart("container-daemon"),
    ).resolves.toContain("Replacement worker 200 is ready");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(3);
  } finally {
    connect.mockRestore();
    close.mockRestore();
    status.mockRestore();
    restart.mockRestore();
  }
}, 15_000);

function idleImpact(target: RestartJob["target"], busy = false): RestartImpact {
  return {
    target,
    checkedAt: new Date().toISOString(),
    agents: busy ? [{ id: "task", title: "Build provider settings", status: "running" }] : [],
    pendingStarts: 0,
    idleRestartSupported: true,
    error: null,
  };
}

test("idle approval survives six days and coordinator reload, then runs only when both checks are idle", async () => {
  const journal = new MemoryJournal();
  let now = Date.now();
  let busy = true;
  let finalCheckBusy = false;
  let restarts = 0;
  const executor = {
    restart: async () => {
      throw new Error("Unconditional restart forbidden");
    },
    inspect: async (target: RestartJob["target"]) => idleImpact(target, busy),
    restartWhenIdle: async () => {
      if (finalCheckBusy) return null;
      restarts++;
      return "replacement ready";
    },
  };
  let queue = new InstallationRestarts(journal, executor, () => now);
  const job = queue.request({ target: "host", reason: "Reviewed update" }, "host-agent");
  journal.jobs[0]!.expiresAt = new Date(now + 30 * 60_000).toISOString();
  now += 6 * 24 * 60 * 60_000;
  queue = new InstallationRestarts(journal, executor, () => now);
  expect(queue.list()[0]?.status).toBe("pending");
  queue.decide(job.id, job.revision, "approve-when-idle");
  await queue.drain();
  expect(restarts).toBe(0);
  queue = new InstallationRestarts(journal, executor, () => now);
  expect(queue.list()[0]?.status).toBe("approved");
  busy = false;
  finalCheckBusy = true;
  await queue.drain();
  expect(restarts).toBe(0);
  expect(queue.list()[0]?.status).toBe("approved");
  finalCheckBusy = false;
  await Promise.all([queue.drain(), queue.drain()]);
  expect(restarts).toBe(1);
  expect(queue.list()[0]?.status).toBe("succeeded");
});

test("an unreachable target waits without blocking another target; cancellation wins an in-flight inspection", async () => {
  const calls: string[] = [];
  let release!: (impact: RestartImpact) => void;
  let held = false;
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: async (target) => {
      calls.push(target);
      return "ready";
    },
    inspect: async () => {
      if (!held) throw new Error("offline");
      return new Promise<RestartImpact>((resolve) => {
        release = resolve;
      });
    },
    restartWhenIdle: async (target) => {
      calls.push(target);
      return "ready";
    },
  });
  const host = queue.request({ target: "host", reason: "Update" }, "owner");
  queue.decide(host.id, host.revision, "approve-when-idle");
  const container = queue.request({ target: "container-daemon", reason: "Update" }, "owner");
  queue.decide(container.id, container.revision, "approve");
  await queue.drain();
  expect(calls).toEqual(["container-daemon"]);
  expect(queue.list()[0]?.status).toBe("approved");
  held = true;
  const draining = queue.drain();
  queue.decide(host.id, host.revision, "cancel");
  release(idleImpact("host"));
  await draining;
  expect(calls).toEqual(["container-daemon"]);
  expect(queue.list()[0]?.status).toBe("rejected");
});
