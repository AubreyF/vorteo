import { z } from "zod";
import {
  mkdtemp,
  writeFile,
  rm,
  mkdir,
  symlink,
  realpath,
  readFile,
  chmod,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { InstallationSourceUpdates } from "./source-updates.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createInstallationRestartExecutor, validateHostStartup } from "./daemon.js";
import type { InstallationConfig } from "./config.js";
import type { RestartImpact, RestartJob } from "@getpaseo/protocol/execution-installation";
import { InstallationRestarts, type RestartJournal, type RestartExecutor } from "./restarts.js";
import { factoryRuntimePlanDigest, runFactoryRuntimePhase } from "./factory-runtime-adoption.js";

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

test("Factory adoption requires its own exact approval and never shares a plain restart", async () => {
  const plan = "c".repeat(64);
  const calls: string[] = [];
  const queue = new InstallationRestarts(new MemoryJournal(), {
    factoryRuntimePlan: () => plan,
    adoptFactoryRuntime: async () => {
      calls.push("adopt");
      return "Factory startup verified";
    },
    restart: async () => {
      calls.push("plain");
      return "ready";
    },
  });
  const input = {
    target: "container-daemon" as const,
    reason: "Adopt the preserved Factory runtime",
    factoryRuntimePlanSha256: plan,
  };
  expect(() => queue.request(input, "container-agent")).toThrow("Host");
  const request = queue.request(input, "host-agent");
  await queue.drain();
  expect(calls).toEqual([]);
  expect(() => queue.request({ target: "container-daemon", reason: "Restart" }, "owner")).toThrow(
    "scope",
  );
  expect(() => queue.decide(request.id, request.revision, "approve")).toThrow("exact Factory");
  queue.decide(request.id, request.revision, "approve", undefined, undefined, plan);
  await queue.drain();
  await queue.drain();
  expect(calls).toEqual(["adopt"]);
  expect(queue.list()[0]?.status).toBe("succeeded");
});

test("Factory adoption is never automatically approved and changed plans cannot place a hold", async () => {
  let plan = "c".repeat(64);
  const calls: string[] = [];
  const queue = new InstallationRestarts(
    new MemoryJournal(),
    {
      factoryRuntimePlan: () => plan,
      adoptFactoryRuntime: async () => {
        calls.push("adopt");
        return "ready";
      },
      restart: async () => "wrong",
      restartWhenIdle: async () => "wrong",
      holdCurrentTurns: async () => {
        calls.push("hold");
      },
      releaseCurrentTurns: async () => {
        calls.push("release");
      },
      inspect: async () => ({
        target: "container-daemon",
        checkedAt: new Date().toISOString(),
        agents: [],
        pendingStarts: 0,
        idleRestartSupported: true,
        gracefulRestartSupported: true,
        error: null,
      }),
    },
    Date.now,
    { hostRequestsAfter: "2026-01-01T00:00:00Z" },
  );
  const job = queue.request(
    { target: "container-daemon", reason: "Adopt", factoryRuntimePlanSha256: plan },
    "host-agent",
  );
  await queue.drain();
  expect(queue.list()[0]?.status).toBe("pending");
  expect(calls).toEqual([]);
  queue.decide(job.id, job.revision, "finish-current-turns", undefined, undefined, plan);
  plan = "d".repeat(64);
  await queue.drain();
  expect(calls).toEqual([]);
  expect(queue.list()[0]?.status).toBe("failed");
});

test("Factory adoption can be cancelled during the visible finish-turns hold", async () => {
  const plan = "c".repeat(64);
  const calls: string[] = [];
  const queue = new InstallationRestarts(new MemoryJournal(), {
    factoryRuntimePlan: () => plan,
    adoptFactoryRuntime: async () => {
      calls.push("adopt");
      return "ready";
    },
    restart: async () => "wrong",
    restartWhenIdle: async () => "wrong",
    holdCurrentTurns: async () => {
      calls.push("hold");
    },
    releaseCurrentTurns: async () => {
      calls.push("release");
    },
    inspect: async () => ({
      target: "container-daemon",
      checkedAt: new Date().toISOString(),
      agents: [{ id: "busy", title: "Busy", status: "running" }],
      pendingStarts: 0,
      idleRestartSupported: true,
      gracefulRestartSupported: true,
      error: null,
    }),
  });
  const job = queue.request(
    { target: "container-daemon", reason: "Adopt", factoryRuntimePlanSha256: plan },
    "host-agent",
  );
  const approved = queue.decide(
    job.id,
    job.revision,
    "finish-current-turns",
    undefined,
    undefined,
    plan,
  );
  await queue.drain();
  expect(calls).toEqual(["hold"]);
  queue.decide(approved.id, approved.revision, "cancel");
  await queue.drain();
  expect(calls).toEqual(["hold", "release"]);
  expect(queue.list()[0]?.status).toBe("rejected");
});

test("Factory adoption failure and coordinator recovery never replay selected source", async () => {
  const journal = new MemoryJournal();
  const plan = "c".repeat(64);
  let attempts = 0;
  const plainRestart = vi.fn(async () => "must not run");
  const hold = vi.fn(async () => {});
  const executor: RestartExecutor = {
    factoryRuntimePlan: () => plan,
    adoptFactoryRuntime: async () => {
      attempts++;
      throw new Error("Verification failed after selection");
    },
    restart: plainRestart,
    restartWhenIdle: plainRestart,
    holdCurrentTurns: hold,
    releaseCurrentTurns: async () => {},
    inspect: async () => ({
      target: "container-daemon",
      checkedAt: new Date().toISOString(),
      agents: [],
      pendingStarts: 0,
      idleRestartSupported: true,
      gracefulRestartSupported: true,
    }),
  };
  const queue = new InstallationRestarts(journal, executor);
  const job = queue.request(
    { target: "container-daemon", reason: "Adopt", factoryRuntimePlanSha256: plan },
    "host-agent",
  );
  queue.decide(job.id, job.revision, "approve", undefined, undefined, plan);
  await queue.drain();
  await new InstallationRestarts(journal, executor).drain();
  expect(attempts).toBe(1);
  expect(journal.jobs[0]?.status).toBe("failed");
  expect(journal.jobs[0]?.factoryRuntimeRecoveryRequired).toBe(true);
  const recovered = new InstallationRestarts(journal, executor, Date.now, {
    hostRequestsAfter: "2026-01-01T00:00:00Z",
  });
  const plain = recovered.request(
    { target: "container-daemon", reason: "Later restart" },
    "host-agent",
  );
  await recovered.drain();
  expect(recovered.list().find((item) => item.id === plain.id)?.status).toBe("pending");
  expect(hold).not.toHaveBeenCalled();
  expect(() => recovered.decide(plain.id, plain.revision, "approve")).toThrow("reconciliation");
  await recovered.drain();
  expect(plainRestart).not.toHaveBeenCalled();
  expect(recovered.list().find((item) => item.id === plain.id)?.status).toBe("pending");
  // A crash after the durable running marker preserves the same fence.
  journal.write(
    journal.jobs.map((item) => (item.id === job.id ? { ...item, status: "running" } : item)),
  );
  const interrupted = new InstallationRestarts(journal, executor);
  await interrupted.drain();
  expect(
    interrupted.list().find((item) => item.id === job.id)?.factoryRuntimeRecoveryRequired,
  ).toBe(true);
  expect(plainRestart).not.toHaveBeenCalled();
});

test.each([false, true])(
  "Factory recovery cannot deadlock behind a source approval (held: %s)",
  async (held) => {
    const journal = new MemoryJournal();
    const plan = "e".repeat(64);
    let succeeds = false;
    const installUpdate = vi.fn(async () => "installed");
    const releaseCurrentTurns = vi.fn(async () => {});
    const executor: RestartExecutor = {
      factoryRuntimePlan: () => plan,
      adoptFactoryRuntime: async () => {
        if (!succeeds) throw new Error("verification failed");
        return "recovered";
      },
      restart: async () => "plain",
      installUpdate,
      supportsUpdate: () => true,
      releaseCurrentTurns,
    };
    const queue = new InstallationRestarts(journal, executor);
    const input = {
      target: "container-daemon" as const,
      reason: "Adopt",
      factoryRuntimePlanSha256: plan,
    };
    const adoption = queue.request(input, "host-agent");
    queue.decide(adoption.id, adoption.revision, "approve", undefined, undefined, plan);
    await queue.drain();
    const update = {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: "c".repeat(64),
      bytes: 42,
    };
    const source = queue.request(
      { target: "container-daemon", reason: "Update source" },
      "host-agent",
      update,
    );
    expect(() => queue.decide(source.id, source.revision, "approve", update.sha256)).toThrow(
      "reconciliation",
    );
    expect(queue.list().find((job) => job.id === source.id)?.status).toBe("pending");
    const recovery = queue.request(
      { ...input, factoryRuntimeRecoveryOf: adoption.id },
      "host-agent",
    );
    queue.decide(recovery.id, recovery.revision, "reject");
    // Simulate an approval retained by the prior coordinator, including a durable
    // finish-turns hold. Neither kind may monopolize the recovery target.
    journal.write(
      journal.jobs.map((job) =>
        job.id === source.id
          ? {
              ...job,
              status: "approved",
              whenIdle: held,
              finishCurrentTurns: held,
            }
          : job,
      ),
    );
    const restored = new InstallationRestarts(journal, executor);
    const revoked = restored.list().find((job) => job.id === source.id);
    expect(revoked?.status).toBe("failed");
    expect(revoked?.update).toEqual(update);
    const retry = restored.request(
      { ...input, factoryRuntimeRecoveryOf: adoption.id },
      "host-agent",
    );
    restored.decide(retry.id, retry.revision, "approve", undefined, undefined, plan);
    succeeds = true;
    await restored.drain();
    expect(restored.list().find((job) => job.id === retry.id)?.status).toBe("succeeded");
    expect(restored.list().some((job) => job.factoryRuntimeRecoveryRequired)).toBe(false);
    expect(installUpdate).not.toHaveBeenCalled();
    if (held) expect(releaseCurrentTurns).toHaveBeenCalledWith("container-daemon", source.id);
    else expect(releaseCurrentTurns).not.toHaveBeenCalled();
  },
);

test("Factory recovery requires fresh exact approval and clears only a verified failure chain", async () => {
  const journal = new MemoryJournal();
  const plan = "d".repeat(64);
  let succeeds = false;
  const executions: string[] = [];
  const executor: RestartExecutor = {
    factoryRuntimePlan: () => plan,
    adoptFactoryRuntime: async (job) => {
      expect(journal.jobs.find((item) => item.id === job.id)?.factoryRuntimeRecoveryRequired).toBe(
        true,
      );
      executions.push(job.id);
      if (!succeeds)
        throw Object.assign(new Error("private timeout diagnostics"), { code: "ETIMEDOUT" });
      return "Verified reviewed selection and replacement";
    },
    restart: async () => "plain",
  };
  const queue = new InstallationRestarts(journal, executor);
  const input = {
    target: "container-daemon" as const,
    reason: "Adoption",
    factoryRuntimePlanSha256: plan,
  };
  const first = queue.request(input, "host-agent");
  queue.decide(first.id, first.revision, "approve", undefined, undefined, plan);
  await queue.drain();
  expect(queue.list()[0]?.detail).not.toContain("private");
  expect(() => queue.request(input, "host-agent")).toThrow("latest unresolved");
  expect(() =>
    queue.request({ ...input, factoryRuntimeRecoveryOf: crypto.randomUUID() }, "host-agent"),
  ).toThrow("missing or changed");
  const second = queue.request({ ...input, factoryRuntimeRecoveryOf: first.id }, "host-agent");
  await queue.drain();
  expect(executions).toEqual([first.id]);
  expect(() =>
    queue.decide(second.id, first.revision, "approve", undefined, undefined, plan),
  ).toThrow("missing or changed");
  queue.decide(second.id, second.revision, "approve", undefined, undefined, plan);
  await queue.drain();
  expect(queue.list().filter((item) => item.factoryRuntimeRecoveryRequired)).toHaveLength(2);
  expect(() =>
    queue.request({ ...input, factoryRuntimeRecoveryOf: first.id }, "host-agent"),
  ).toThrow("latest unresolved");
  const recovered = new InstallationRestarts(journal, executor);
  const third = recovered.request({ ...input, factoryRuntimeRecoveryOf: second.id }, "host-agent");
  succeeds = true;
  recovered.decide(third.id, third.revision, "approve", undefined, undefined, plan);
  await recovered.drain();
  expect(executions).toEqual([first.id, second.id, third.id]);
  expect(recovered.list().filter((item) => item.factoryRuntimeRecoveryRequired)).toHaveLength(0);
  for (const id of [first.id, second.id])
    expect(recovered.list().find((item) => item.id === id)).toMatchObject({
      status: "failed",
      factoryRuntimeRecoveredBy: third.id,
    });
  expect(recovered.list().find((item) => item.id === third.id)?.status).toBe("succeeded");
});

test.skipIf(process.platform === "win32")(
  "Factory adoption executes pinned physical source and verifies phase receipts",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "factory-adoption-")));
    try {
      const script = path.join(root, "plan.mjs");
      const code = `const e = process.env;
      process.stdout.write(JSON.stringify({requestId:e.VORTEO_FACTORY_ADOPTION_REQUEST_ID,
        planSha256:e.VORTEO_FACTORY_ADOPTION_PLAN_SHA256, phase:e.VORTEO_FACTORY_ADOPTION_PHASE,
        serverId:e.VORTEO_FACTORY_ADOPTION_SERVER_ID, previousPid:Number(e.VORTEO_FACTORY_ADOPTION_PREVIOUS_PID),
        replacementPid:e.VORTEO_FACTORY_ADOPTION_REPLACEMENT_PID ? Number(e.VORTEO_FACTORY_ADOPTION_REPLACEMENT_PID) : null}));`;
      await writeFile(script, code, { mode: 0o600 });
      const plan = {
        node: process.execPath,
        script,
        sha256: createHash("sha256").update(code).digest("hex"),
      };
      const queue = new InstallationRestarts(new MemoryJournal(), {
        factoryRuntimePlan: () => plan.sha256,
        adoptFactoryRuntime: async () => "unused",
        restart: async () => "unused",
      });
      const job = queue.request(
        { target: "container-daemon", reason: "Fixture", factoryRuntimePlanSha256: plan.sha256 },
        "host-agent",
      );
      const input = { plan, job, serverId: "expected-dev", previousPid: 12 };
      expect(factoryRuntimePlanDigest(plan)).toBe(plan.sha256);
      await runFactoryRuntimePhase({ ...input, phase: "stage", replacementPid: null });
      await runFactoryRuntimePhase({ ...input, phase: "verify", replacementPid: 13 });
      await chmod(script, 0o666);
      expect(factoryRuntimePlanDigest(plan)).toBeUndefined();
      await expect(
        runFactoryRuntimePhase({ ...input, phase: "stage", replacementPid: null }),
      ).rejects.toThrow("physical plan");
      await chmod(script, 0o600);
      await writeFile(script, code + "\n// changed");
      expect(factoryRuntimePlanDigest(plan)).toBeUndefined();
      await expect(
        runFactoryRuntimePhase({ ...input, phase: "stage", replacementPid: null }),
      ).rejects.toThrow("changed");
      const failing =
        'console.error("private-stderr-sentinel"); throw new Error("private-source-sentinel");';
      await writeFile(script, failing);
      const failurePlan = { ...plan, sha256: createHash("sha256").update(failing).digest("hex") };
      const failure = await runFactoryRuntimePhase({
        ...input,
        plan: failurePlan,
        job: { ...job, factoryRuntimePlanSha256: failurePlan.sha256 },
        phase: "stage",
        replacementPid: null,
      }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("stage execution failed");
      expect(String(failure)).not.toContain("sentinel");
      expect(String(failure)).not.toContain("--eval");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
  expect(queue.request({ target: "host", reason: "Another prepared update" }, "owner")).toEqual(
    host,
  );
  expect(
    queue.request({ target: "container-daemon", reason: "Another update" }, "host-agent"),
  ).toEqual(container);
  const approved = queue.decide(host.id, host.revision, "approve");
  expect(
    queue.request({ target: "host", reason: "Latest prepared update" }, "container-agent"),
  ).toEqual(approved);
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

test("host preflight refuses a failing release before connecting or dispatching", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "restart-preflight-"));
  const entrypoint = path.join(root, "validator.mjs");
  await writeFile(
    entrypoint,
    'process.stderr.write("Invalid configuration fields: agents.providers.retired.extends"); process.exit(1);',
  );
  const config = restartTestConfig(root, entrypoint);
  const connect = vi.spyOn(DaemonClient.prototype, "connect");
  try {
    await expect(createInstallationRestartExecutor(config).restart("host")).rejects.toThrow(
      "No restart was dispatched. Invalid fields: agents.providers.retired.extends.",
    );
    expect(connect).not.toHaveBeenCalled();
    await writeFile(entrypoint, 'process.stderr.write("private-value"); process.exit(1);');
    await expect(validateHostStartup(config)).rejects.toThrow(
      "Repair configuration or restore a validated backup",
    );
    await writeFile(entrypoint, "process.exit(0);");
    await expect(validateHostStartup(config)).resolves.toBeUndefined();
  } finally {
    connect.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("source installation requires approval of the bundle digest and cannot use an idle restart", async () => {
  const restart = vi.fn(async () => "ready");
  const installUpdate = vi.fn(async () => "installed and ready");
  const queue = new InstallationRestarts(new MemoryJournal(), { restart, installUpdate });
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    bytes: 42,
  };
  const job = queue.request(
    { target: "host", reason: "Install reviewed source" },
    "container-agent",
    update,
  );
  await queue.drain();
  expect(installUpdate).not.toHaveBeenCalled();
  expect(() => queue.decide(job.id, job.revision, "approve")).toThrow("exact source update");
  expect(() => queue.decide(job.id, job.revision, "approve", "d".repeat(64))).toThrow(
    "exact source update",
  );
  expect(() => queue.decide(job.id, job.revision, "approve-when-idle", update.sha256)).toThrow(
    "Idle updates",
  );
  expect(() => queue.decide(job.id, job.revision, "finish-current-turns", update.sha256)).toThrow(
    "Idle updates",
  );
  expect(() => queue.decide(job.id, job.revision, "request-again", update.sha256)).toThrow(
    "exact source update",
  );
  expect(queue.list()[0]?.status).toBe("pending");
  queue.decide(job.id, job.revision, "approve", update.sha256);
  await queue.drain();
  expect(installUpdate).toHaveBeenCalledOnce();
  expect(restart).not.toHaveBeenCalled();
  expect(queue.list()[0]?.status).toBe("succeeded");
});

test("unavailable source installers refuse requests and interrupted updates never replay", async () => {
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    bytes: 42,
  };
  const journal = new MemoryJournal();
  const installUpdate = vi.fn(async () => "ready");
  const restart = vi.fn(async () => "ready");
  const unavailable = new InstallationRestarts(journal, { restart });
  expect(() =>
    unavailable.request({ target: "host", reason: "Update" }, "container-agent", update),
  ).toThrow("unavailable");
  const queue = new InstallationRestarts(journal, { restart, installUpdate });
  const job = queue.request({ target: "host", reason: "Update" }, "container-agent", update);
  queue.decide(job.id, job.revision, "approve", update.sha256);
  const recovered = new InstallationRestarts(journal, { restart, installUpdate });
  await recovered.drain();
  expect(recovered.list()[0]?.status).toBe("failed");
  expect(installUpdate).not.toHaveBeenCalled();
});

function restartTestConfig(root: string, entrypoint: string): InstallationConfig {
  return {
    public: {
      version: 1,
      installationId: "00000000-0000-4000-8000-000000000001",
      origin: "https://installation.example",
      environments: [
        { kind: "host", serverId: "host", endpoint: "host.example", useTls: true },
        { kind: "container", serverId: "container", endpoint: "container.example", useTls: true },
      ],
    },
    listenPort: 6770,
    webDistDir: root,
    stateDir: root,
    ownerPasswordHash: "$2-test",
    hostAgentTokenHash: "0".repeat(64),
    containerAgentTokenHash: "1".repeat(64),
    container: { endpoint: "127.0.0.1:6768", password: "container-test" },
    host: {
      endpoint: "127.0.0.1:6771",
      password: "host-test",
      launchdService: "gui/501/local.vorteo.test.host",
      startupValidation: { node: process.execPath, entrypoint, home: root },
    },
  };
}

test("source builds fail before activation, failed readiness restores selection, and publication follows readiness", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "source-activation-")));
  try {
    const previous = path.join(root, "previous");
    await mkdir(previous);
    const baseCommit = "b".repeat(40);
    await writeFile(
      path.join(previous, ".installation-source.json"),
      JSON.stringify({ sourceCommit: baseCommit }),
    );
    await writeFile(path.join(root, "release.json"), JSON.stringify({ sourceCommit: baseCommit }));
    await writeFile(path.join(root, "index.html"), "old interface");
    const link = path.join(root, "current");
    await symlink(previous, link);
    const config = restartTestConfig(
      root,
      path.join(link, "packages/server/dist/scripts/supervisor-entrypoint.js"),
    );
    config.sourceUpdates = {
      sourceRepository: root,
      releaseRoot: root,
      currentReleaseLink: link,
      webDirectory: root,
      toolingDirectory: root,
      integrationRef: "refs/heads/main",
    };
    const updates = new InstallationSourceUpdates(config);
    const bundle = Buffer.from("approved inert source");
    const update = {
      sourceCommit: "a".repeat(40),
      baseCommit,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      bytes: bundle.length,
    };
    expect(() => updates.stage(update, Buffer.from("changed"))).toThrow("digest");
    updates.stage(update, bundle);
    const restart = vi.fn(async (): Promise<string> => {
      throw new Error("replacement did not become ready");
    });
    const queue = new InstallationRestarts(new MemoryJournal(), {
      restart,
      installUpdate: (job) => updates.install(job, restart),
    });
    const dispatch = async () => {
      const job = queue.request(
        { target: "host", reason: "Install fixture" },
        "container-agent",
        update,
      );
      queue.decide(job.id, job.revision, "approve", update.sha256);
      await queue.drain();
      return queue.list().find((item) => item.id === job.id);
    };
    const prepareScript = path.join(root, "prepare-installation-update.mjs");
    await writeFile(prepareScript, 'throw new Error("build failed")');
    expect((await dispatch())?.status).toBe("failed");
    expect(await realpath(link)).toBe(previous);
    expect(restart).not.toHaveBeenCalled();
    await writeFile(
      prepareScript,
      `import fs from 'node:fs/promises'; import path from 'node:path';
      const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
      const release = path.join(input.work, 'release'); const exported = path.join(release, 'web-export');
      const scripts = path.join(release, 'packages/server/dist/scripts');
      await fs.mkdir(scripts, {recursive:true}); await fs.mkdir(exported);
      await fs.writeFile(path.join(scripts, 'supervisor-entrypoint.js'), 'process.exit(0)');
      await fs.writeFile(path.join(release, '.installation-source.json'), JSON.stringify({sourceCommit: input.update.sourceCommit}));
      await fs.writeFile(input.resultFile, JSON.stringify({release,exported}));`,
    );
    await writeFile(
      path.join(root, "publish-instance-web.mjs"),
      `import fs from 'node:fs/promises'; import path from 'node:path'; await fs.writeFile(path.join(process.argv[3], 'published'), 'yes');`,
    );
    const validPrepareScript = await readFile(prepareScript, "utf8");
    await writeFile(
      prepareScript,
      validPrepareScript +
        "\nawait fs.writeFile(path.join(input.webDirectory, 'index.html'), 'concurrent publication');",
    );
    expect((await dispatch())?.detail).toContain("changed during the build");
    expect(await realpath(link)).toBe(previous);
    expect(restart).not.toHaveBeenCalled();
    await writeFile(prepareScript, validPrepareScript);
    await writeFile(path.join(root, "index.html"), "old interface");
    expect((await dispatch())?.detail).toContain("Previous launcher restored");
    expect(await realpath(link)).toBe(previous);
    await expect(readFile(path.join(root, "published"))).rejects.toThrow();
    restart.mockImplementation(async () => {
      expect(await realpath(link)).not.toBe(previous);
      await expect(readFile(path.join(root, "published"))).rejects.toThrow();
      return "ready";
    });
    expect((await dispatch())?.status).toBe("succeeded");
    expect(await readFile(path.join(root, "published"), "utf8")).toBe("yes");
    expect(updates.source().baseCommit).toBe(update.sourceCommit);
    expect(restart).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finishing current turns holds admission before inspection and restarts only after idle", async () => {
  const events: string[] = [];
  let busy = true;
  const journal = new MemoryJournal();
  const executor = {
    restart: async () => {
      throw new Error("Immediate restart must not run");
    },
    holdCurrentTurns: async () => {
      events.push("hold");
    },
    releaseCurrentTurns: async () => {
      events.push("release");
    },
    inspect: async (target: RestartJob["target"]) => {
      events.push("inspect");
      return idleImpact(target, busy);
    },
    restartWhenIdle: async () => {
      events.push("restart");
      return "ready";
    },
  };
  const queue = new InstallationRestarts(journal, executor);
  const job = queue.request({ target: "host", reason: "Activate shared settings." }, "owner");
  const approved = queue.decide(job.id, job.revision, "finish-current-turns");
  await queue.drain();
  expect(events).toEqual(["hold", "inspect"]);
  expect(queue.list()[0]).toMatchObject({ status: "approved", finishCurrentTurns: true });
  const recovered = new InstallationRestarts(journal, executor);
  busy = false;
  await recovered.drain();
  expect(events).toEqual(["hold", "inspect", "hold", "inspect", "restart"]);
  expect(recovered.list()[0]?.status).toBe("succeeded");
  expect(approved.revision).not.toBe(job.revision);
});

test("queued restart upgrades, cancellation releases its hold, and request again needs approval", async () => {
  const released: string[] = [];
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: async () => "ready",
    restartWhenIdle: async () => "ready",
    inspect: async (target) => idleImpact(target, true),
    holdCurrentTurns: async () => {},
    releaseCurrentTurns: async (_target, id) => {
      released.push(id);
    },
  });
  const job = queue.request({ target: "host", reason: "Activate shared settings." }, "owner");
  queue.decide(job.id, job.revision, "approve-when-idle");
  const upgraded = queue.decide(job.id, job.revision, "finish-current-turns");
  await queue.drain();
  expect(() => queue.decide(job.id, job.revision, "cancel")).toThrow();
  queue.decide(job.id, upgraded.revision, "cancel");
  await queue.drain();
  expect(released).toEqual([job.id]);
  const retry = queue.decide(job.id, upgraded.revision, "request-again");
  expect(retry.id).not.toBe(job.id);
  expect(retry).toMatchObject({ status: "pending", reason: job.reason });
  expect(retry.finishCurrentTurns).toBeUndefined();
  expect(queue.decide(job.id, upgraded.revision, "request-again")).toEqual(retry);
});

test("cancel during hold setup cannot dispatch, and release failures remain retryable", async () => {
  let finishHold!: () => void;
  const held = new Promise<void>((resolve) => {
    finishHold = resolve;
  });
  let releaseFails = true;
  let restarts = 0;
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: async () => "ready",
    inspect: async (target) => idleImpact(target),
    holdCurrentTurns: async () => held,
    releaseCurrentTurns: async () => {
      if (releaseFails) throw new Error("offline");
    },
    restartWhenIdle: async () => {
      restarts++;
      return "ready";
    },
  });
  const job = queue.request({ target: "host", reason: "Activate settings." }, "owner");
  const approved = queue.decide(job.id, job.revision, "finish-current-turns");
  const drain = queue.drain();
  queue.decide(job.id, approved.revision, "cancel");
  finishHold();
  await drain;
  await queue.drain();
  expect(restarts).toBe(0);
  expect(queue.list()[0]).toMatchObject({ status: "rejected" });
  expect(queue.list()[0]?.holdReleased).not.toBe(true);
  releaseFails = false;
  await queue.drain();
  expect(queue.list()[0]?.holdReleased).toBe(true);
});

test("a graceful restart can only be forced by another explicit decision", async () => {
  let forced = 0;
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: async () => {
      forced++;
      return "ready";
    },
    restartWhenIdle: async () => null,
    inspect: async (target) => idleImpact(target, true),
    holdCurrentTurns: async () => {},
    releaseCurrentTurns: async () => {},
  });
  const job = queue.request({ target: "host", reason: "Activate settings." }, "owner");
  const approved = queue.decide(job.id, job.revision, "finish-current-turns");
  await queue.drain();
  expect(forced).toBe(0);
  queue.decide(job.id, approved.revision, "approve");
  await queue.drain();
  expect(forced).toBe(1);
});

test.each(["approve-when-idle", "finish-current-turns"] as const)(
  "later prepared updates share %s approval and activate the latest staged release once",
  async (decision) => {
    const journal = new MemoryJournal();
    let release = "first";
    let busy = true;
    const activated: string[] = [];
    const executor = {
      restart: async () => "ready",
      inspect: async (target: RestartJob["target"]) => idleImpact(target, busy),
      restartWhenIdle: async () => {
        activated.push(release);
        return "ready";
      },
      holdCurrentTurns: async () => {},
      releaseCurrentTurns: async () => {},
    };
    const queue = new InstallationRestarts(journal, executor);
    const initial = queue.request({ target: "host", reason: "First update" }, "host-agent");
    const approved = queue.decide(initial.id, initial.revision, decision);
    await queue.drain();
    release = "combined updates";
    const joined = queue.request(
      { target: "host", reason: "Complementary update" },
      "container-agent",
    );
    expect(joined).toMatchObject({
      id: initial.id,
      revision: approved.revision,
      status: "approved",
      approvedAt: approved.approvedAt,
      whenIdle: true,
    });
    expect(joined.finishCurrentTurns).toBe(approved.finishCurrentTurns);
    expect(queue.list()).toHaveLength(1);
    busy = false;
    const recovered = new InstallationRestarts(journal, executor);
    await recovered.drain();
    await recovered.drain();
    expect(activated).toEqual(["combined updates"]);
    expect(recovered.list()[0]?.status).toBe("succeeded");
  },
);

test("new requests cannot join a restart after dispatch starts", async () => {
  let complete!: (detail: string) => void;
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  });
  const initial = queue.request({ target: "host", reason: "First update" }, "host-agent");
  queue.decide(initial.id, initial.revision, "approve");
  const draining = queue.drain();
  expect(() => queue.request({ target: "host", reason: "Too late" }, "container-agent")).toThrow(
    "already restarting",
  );
  complete("ready");
  await draining;
  expect(queue.request({ target: "host", reason: "Next update" }, "container-agent").status).toBe(
    "pending",
  );
});

test("source batches invalidate stale approvals, freeze at approval, and preserve contribution receipts", async () => {
  const journal = new MemoryJournal();
  let base = "b".repeat(40);
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: base,
    sha256: "a".repeat(64),
    bytes: 100,
  };
  const install = vi.fn(async (job: RestartJob) => {
    base = job.update!.sourceCommit;
    return "installed";
  });
  const executor = {
    restart: vi.fn(async () => "plain"),
    installUpdate: install,
    sourceBase: () => base,
    prepareUpdate: async (
      contributions: import("@getpaseo/protocol/execution-installation").SourceContribution[],
    ) => ({
      batch: {
        status: "ready" as const,
        contributions: contributions.map((item) => ({ ...item, status: "included" as const })),
      },
      update: { ...update, baseCommit: base, sha256: String(contributions.length).repeat(64) },
    }),
  };
  const queue = new InstallationRestarts(journal, executor);
  const input = { target: "host" as const, reason: "First" };
  const firstId = crypto.randomUUID();
  const first = queue.contribute(input, "container-agent", update, firstId);
  await queue.prepareBatches();
  const ready = queue.contribution(firstId)!.batch;
  expect(ready.sourceBatch?.status).toBe("ready");
  expect(() => queue.request(input, "owner")).toThrow("source update");
  const secondId = crypto.randomUUID();
  const second = queue.contribute({ ...input, reason: "Second" }, "host-agent", update, secondId);
  expect(second.batch.id).toBe(first.batch.id);
  expect(() => queue.decide(ready.id, ready.revision, "approve", ready.update!.sha256)).toThrow(
    "changed",
  );
  expect(() => queue.decide(second.batch.id, second.batch.revision, "approve-when-idle")).toThrow(
    "exact source",
  );
  expect(queue.contribute(input, "container-agent", update, firstId).contribution).toMatchObject({
    id: firstId,
    update,
    reason: input.reason,
  });
  expect(() =>
    queue.contribute({ ...input, reason: "Changed" }, "container-agent", update, firstId),
  ).toThrow("different submission");
  await queue.prepareBatches();
  const combined = queue.contribution(firstId)!.batch;
  expect(() => queue.decide(combined.id, combined.revision, "approve", update.sha256)).toThrow(
    "exact source",
  );
  queue.decide(combined.id, combined.revision, "approve", combined.update!.sha256);
  const next = queue.contribute(input, "container-agent", update, crypto.randomUUID());
  expect(next.batch.id).not.toBe(combined.id);
  await queue.prepareBatches();
  expect(queue.contribution(next.contribution.id)!.batch.sourceBatch?.status).toBe("waiting");
  await queue.drain();
  expect(install).toHaveBeenCalledOnce();
  expect(install.mock.calls[0]![0].update).toEqual(combined.update);
  expect(executor.restart).not.toHaveBeenCalled();
  await queue.prepareBatches();
  const nextReady = queue.contribution(next.contribution.id)!.batch;
  expect(nextReady.update?.baseCommit).toBe(base);
  expect(nextReady.status).toBe("pending");
  expect(queue.contribution(firstId)!.contribution.update).toEqual(update);
  const recovered = new InstallationRestarts(journal, executor);
  await recovered.drain();
  expect(install).toHaveBeenCalledOnce();
});

test("interrupted or racing batch preparation cannot publish stale source; conflicts require explicit replacement", async () => {
  const journal = new MemoryJournal();
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    sha256: "a".repeat(64),
    bytes: 10,
  };
  let complete!: () => void;
  const executor = {
    restart: async () => "ready",
    installUpdate: async () => "installed",
    sourceBase: () => update.baseCommit,
    prepareUpdate: async (
      contributions: import("@getpaseo/protocol/execution-installation").SourceContribution[],
    ) => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return {
        batch: {
          status: "conflict" as const,
          contributions: contributions.map((item) => ({
            ...item,
            status: "conflict" as const,
            detail: "same.txt",
          })),
        },
      };
    },
  };
  const queue = new InstallationRestarts(journal, executor);
  const input = { target: "host" as const, reason: "Contribution" };
  const first = queue.contribute(input, "container-agent", update, crypto.randomUUID());
  const preparing = queue.prepareBatches();
  const second = queue.contribute(input, "host-agent", update, crypto.randomUUID());
  complete();
  await preparing;
  expect(queue.contribution(first.contribution.id)!.batch.sourceBatch?.contributions).toHaveLength(
    2,
  );
  expect(queue.contribution(first.contribution.id)!.batch.sourceBatch?.status).toBe("preparing");
  const recovered = new InstallationRestarts(journal, executor);
  const retry = recovered.prepareBatches();
  complete();
  await retry;
  expect(recovered.contribution(first.contribution.id)!.batch.sourceBatch?.status).toBe("conflict");
  expect(() =>
    recovered.contribute(input, "host-agent", update, crypto.randomUUID(), first.contribution.id),
  ).toThrow("Only your");
  const replacement = recovered.contribute(
    input,
    "container-agent",
    update,
    crypto.randomUUID(),
    first.contribution.id,
  );
  expect(recovered.contribution(first.contribution.id)!.contribution).toMatchObject({
    status: "superseded",
    supersededBy: replacement.contribution.id,
    update,
  });
  expect(recovered.contribution(second.contribution.id)).not.toBeNull();
  recovered.decide(replacement.batch.id, replacement.batch.revision, "reject");
  expect(recovered.contribution(first.contribution.id)!.batch.status).toBe("rejected");
});

test("inert Git batching combines old-base deltas, retains conflicts, and ignores executable Git configuration", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { prepareSourceBatch } = await import("./source-batches.js");
  const root = await mkdtemp(path.join(tmpdir(), "source-batch-test-"));
  const repository = path.join(root, "repo");
  const directory = path.join(root, "bundles");
  await mkdir(repository);
  await mkdir(directory);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@localhost",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@localhost",
      },
    }).trim();
  const sentinel = path.join(root, "executed");
  const savedCount = process.env.GIT_CONFIG_COUNT;
  const savedKey = process.env.GIT_CONFIG_KEY_0;
  const savedValue = process.env.GIT_CONFIG_VALUE_0;
  try {
    git("init", "--initial-branch=integration");
    await writeFile(path.join(repository, "same.txt"), "base\n");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    async function contribution(files: Record<string, string>) {
      git("checkout", "-B", "integration", base);
      for (const [name, text] of Object.entries(files))
        await writeFile(path.join(repository, name), text);
      git("add", ".");
      git("commit", "-m", "contribution");
      const sourceCommit = git("rev-parse", "HEAD");
      const file = path.join(root, `${sourceCommit}.bundle`);
      git("bundle", "create", file, `${base}..refs/heads/integration`);
      const bundle = await readFile(file);
      const update = {
        sourceCommit,
        baseCommit: base,
        sha256: createHash("sha256").update(bundle).digest("hex"),
        bytes: bundle.length,
      };
      await writeFile(path.join(directory, `${update.sha256}.bundle`), bundle);
      return {
        id: crypto.randomUUID(),
        update,
        reason: "Change",
        requestedBy: "container-agent" as const,
        createdAt: new Date().toISOString(),
        status: "queued" as const,
        detail: "",
      };
    }
    const first = await contribution({ "first.txt": "first\n", "same.txt": "one\n" });
    const second = await contribution({
      "second.txt": "second\n",
      ".gitattributes": "same.txt merge=hostile\n",
    });
    const conflict = await contribution({ "same.txt": "two\n" });
    const firstBundle = await readFile(path.join(directory, `${first.update.sha256}.bundle`));
    // This inherited command would run if preparation reused the caller's Git config.
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "merge.hostile.driver";
    process.env.GIT_CONFIG_VALUE_0 = `touch ${sentinel}`;
    let combinedBundle: Buffer | undefined;
    const input = {
      directory,
      repository,
      integrationRef: "refs/heads/integration",
      baseCommit: base,
      webCommit: base,
      contributions: [first, second],
      stage: (_update: unknown, bundle: Buffer) => {
        combinedBundle = bundle;
      },
    };
    const result = await prepareSourceBatch(input);
    expect(result.batch.status).toBe("ready");
    expect(result.batch.contributions.map((item) => item.status)).toEqual(["included", "included"]);
    expect(combinedBundle).toBeDefined();
    // Import the inert output into the test repository to inspect tree and ancestry.
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
    const combinedFile = path.join(root, "combined.bundle");
    await writeFile(combinedFile, combinedBundle!);
    git("fetch", combinedFile, "refs/heads/integration:refs/heads/combined");
    const combined = result.update!.sourceCommit;
    expect(git("show", `${combined}:first.txt`)).toBe("first");
    expect(git("show", `${combined}:second.txt`)).toBe("second");
    expect(git("show", `${combined}:same.txt`)).toBe("one");
    git("merge-base", "--is-ancestor", first.update.sourceCommit, combined);
    git("merge-base", "--is-ancestor", second.update.sourceCommit, combined);
    expect(git("log", "--format=%B", combined)).toContain(first.id);
    const late = await contribution({ "late.txt": "late\n" });
    const next = await prepareSourceBatch({
      ...input,
      baseCommit: combined,
      webCommit: combined,
      contributions: [late],
    });
    expect(next.batch.status).toBe("ready");
    await writeFile(combinedFile, combinedBundle!);
    git("fetch", combinedFile, "refs/heads/integration:refs/heads/next");
    expect(git("show", `${next.update!.sourceCommit}:first.txt`)).toBe("first");
    expect(git("show", `${next.update!.sourceCommit}:late.txt`)).toBe("late");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "merge.hostile.driver";
    process.env.GIT_CONFIG_VALUE_0 = `touch ${sentinel}`;
    const blocked = await prepareSourceBatch({
      ...input,
      contributions: [first, second, conflict],
    });
    expect(blocked.batch.status).toBe("conflict");
    expect(blocked.update).toBeUndefined();
    expect(blocked.batch.contributions[2]).toMatchObject({ status: "conflict" });
    expect(blocked.batch.contributions[2]!.detail).toContain("same.txt");
    expect(existsSync(sentinel)).toBe(false);
    expect(await readFile(path.join(directory, `${first.update.sha256}.bundle`))).toEqual(
      firstBundle,
    );
    const corrupted = await prepareSourceBatch({
      ...input,
      contributions: [{ ...first, update: { ...first.update, bytes: 1 } }],
    });
    expect(corrupted.batch.contributions[0]?.status).toBe("invalid");
  } finally {
    for (const [key, value] of Object.entries({
      GIT_CONFIG_COUNT: savedCount,
      GIT_CONFIG_KEY_0: savedKey,
      GIT_CONFIG_VALUE_0: savedValue,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("repo-shaped batching reconciles generated versions and every note while preserving deployed web source", async () => {
  const { execFileSync } = await import("node:child_process");
  const { prepareSourceBatch } = await import("./source-batches.js");
  const root = await mkdtemp(path.join(tmpdir(), "release-batch-test-"));
  const repository = path.join(root, "repo");
  const directory = path.join(root, "bundles");
  await mkdir(repository);
  await mkdir(directory);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@localhost",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@localhost",
      },
    }).trim();
  const baseNotes =
    "# Vorteo changelog\n\n## 0.11.0-beta.3.vorteo.177 - 2026-10-07\n\n### Fixed\n\n- Existing note\n";
  // Use the repository's real workspace manifests and full lock, including its size.
  const sourceRoot = path.resolve(import.meta.dirname, "../../../../..");
  const templateRoot = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  const templateLock = JSON.parse(
    await readFile(path.join(sourceRoot, "package-lock.json"), "utf8"),
  );
  const templatePackages = new Map<string, Record<string, unknown>>();
  for (const file of [
    "package.json",
    ...templateRoot.workspaces.map((dir: string) => `${dir}/package.json`),
  ]) {
    templatePackages.set(file, JSON.parse(await readFile(path.join(sourceRoot, file), "utf8")));
    await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
  }
  async function metadata(counter: number, note: string, dependency = "1.0.0") {
    const version = `0.11.0-beta.3.vorteo.${counter}`;
    const packages = structuredClone(templatePackages);
    const lock = structuredClone(templateLock);
    const names = new Set([...packages.values()].map((pkg) => pkg.name));
    for (const [file, pkg] of packages) {
      const key = file === "package.json" ? "" : file.slice(0, -"/package.json".length);
      pkg.version = version;
      lock.packages[key].version = version;
      for (const section of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const pins = z.record(z.string(), z.string()).parse(pkg[section] ?? {});
        for (const name of Object.keys(pins))
          if (names.has(name) && name !== pkg.name) pins[name] = pkg.private ? "*" : version;
        if (file === "packages/client/package.json" && section === "dependencies")
          pins.external = dependency;
        if (pkg[section]) {
          pkg[section] = pins;
          lock.packages[key][section] = pins;
        }
      }
      await writeFile(path.join(repository, file), JSON.stringify(pkg, null, 2) + "\n");
    }
    lock.version = version;
    lock.packages["node_modules/external"] = {
      version: dependency,
      resolved: `https://example.invalid/${dependency}`,
      integrity: "test",
    };
    await writeFile(
      path.join(repository, "package-lock.json"),
      JSON.stringify(lock, null, 2) + "\n",
    );
    await writeFile(
      path.join(repository, "VORTEO_CHANGELOG.md"),
      note
        ? baseNotes.replace("## ", `## ${version} - 2026-10-07\n\n### Fixed\n\n- ${note}\n\n## `)
        : baseNotes,
    );
  }
  try {
    git("init", "--initial-branch=integration");
    await metadata(177, "");
    await writeFile(path.join(repository, "feature.txt"), "base\n");
    await mkdir(path.join(repository, "docs"));
    await writeFile(path.join(repository, "docs/vorteo-customizations.md"), "Inventory baseline\n");
    git("add", ".");
    git("commit", "-m", "deployed runtime");
    const base = git("rev-parse", "HEAD");
    await metadata(178, "Published web-only improvement");
    await writeFile(path.join(repository, "web.txt"), "published\n");
    git("add", ".");
    git("commit", "-m", "deployed web");
    const web = git("rev-parse", "HEAD");
    async function contribution(
      name: string,
      version: number,
      dependency = "1.0.0",
      feature?: string,
    ) {
      git("checkout", "-B", "integration", base);
      await metadata(version, name, dependency);
      await writeFile(path.join(repository, `${name}.txt`), name);
      if (feature) {
        await writeFile(path.join(repository, "feature.txt"), feature);
        await writeFile(path.join(repository, "docs/vorteo-customizations.md"), feature);
      }
      git("add", ".");
      git("commit", "-m", name);
      const sourceCommit = git("rev-parse", "HEAD");
      const file = path.join(root, `${sourceCommit}.bundle`);
      git("bundle", "create", file, `${base}..refs/heads/integration`);
      const bundle = await readFile(file);
      const sha256 = createHash("sha256").update(bundle).digest("hex");
      await writeFile(path.join(directory, `${sha256}.bundle`), bundle);
      return {
        id: crypto.randomUUID(),
        update: { sourceCommit, baseCommit: base, sha256, bytes: bundle.length },
        reason: name,
        requestedBy: "container-agent" as const,
        createdAt: "2026-10-07T00:00:00.000Z",
        status: "queued" as const,
        detail: "",
      };
    }
    const first = await contribution("First feature note", 179);
    const second = await contribution("Second feature note", 178);
    let output: Buffer | undefined;
    const input = {
      directory,
      repository,
      integrationRef: "refs/heads/integration",
      baseCommit: base,
      webCommit: web,
      contributions: [first, second],
      stage: (_update: unknown, bundle: Buffer) => {
        output = bundle;
      },
    };
    input.contributions.push({ ...first, id: crypto.randomUUID() });
    const result = await prepareSourceBatch(input);
    expect(result.batch.status, JSON.stringify(result.batch)).toBe("ready");
    expect(result.batch.webCommit).toBe(web);
    expect(result.batch.contributions[2]?.detail).toMatch(/^Already included/);
    const file = path.join(root, "result.bundle");
    await writeFile(file, output!);
    git("fetch", file, "refs/heads/integration:refs/heads/combined");
    const head = result.update!.sourceCommit;
    const manifest = JSON.parse(git("show", `${head}:package.json`));
    const library = JSON.parse(git("show", `${head}:packages/client/package.json`));
    const lock = JSON.parse(git("show", `${head}:package-lock.json`));
    expect(manifest.version).toBe("0.11.0-beta.3.vorteo.180");
    expect(library.version).toBe(manifest.version);
    expect(library.dependencies["@getpaseo/protocol"]).toBe(manifest.version);
    expect(lock.packages["packages/client"].dependencies["@getpaseo/protocol"]).toBe(
      manifest.version,
    );
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages["packages/client"].version).toBe(manifest.version);
    expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
    expect(git("show", `${head}:web.txt`)).toBe("published");
    git("merge-base", "--is-ancestor", web, head);
    const notes = git("show", `${head}:VORTEO_CHANGELOG.md`);
    for (const note of [
      "Existing note",
      "Published web-only improvement",
      "First feature note",
      "Second feature note",
    ])
      expect(notes).toContain(note);
    expect(notes.split(/^## /m)[1]).toMatch(/^0\.11\.0-beta\.3\.vorteo\.180 -/);
    expect(git("log", "-1", "--format=%B", head)).toContain(first.id);
    expect(git("log", "-1", "--format=%B", head)).toContain(second.id);
    const dependentOne = await contribution("Dependency one", 178, "2.0.0");
    const dependentTwo = await contribution("Dependency two", 179, "3.0.0");
    const blocked = await prepareSourceBatch({
      ...input,
      contributions: [dependentOne, dependentTwo],
    });
    expect(blocked.batch.status).toBe("conflict");
    expect(blocked.update).toBeUndefined();
    expect(blocked.batch.contributions[1]?.detail).toContain("package");
    const featureOne = await contribution("Same feature one", 178, "1.0.0", "one\n");
    const featureTwo = await contribution("Same feature two", 179, "1.0.0", "two\n");
    const featureConflict = await prepareSourceBatch({
      ...input,
      contributions: [featureOne, featureTwo],
    });
    expect(featureConflict.batch.status).toBe("conflict");
    expect(featureConflict.batch.contributions[1]?.detail).toContain("feature.txt");
    expect(featureConflict.batch.contributions[1]?.detail).toContain("vorteo-customizations.md");
    const overLimit = await prepareSourceBatch({
      ...input,
      contributions: [first, second].map((item) =>
        Object.assign({}, item, {
          update: Object.assign({}, item.update, { bytes: 70 * 1024 * 1024 }),
        }),
      ),
    });
    expect(overLimit.batch.status).toBe("conflict");
    expect(overLimit.batch.contributions[0]?.detail).toContain("128 MiB");

    // A published interface may already contain deliberately reconciled historical
    // notes. An explicitly integrated descendant must not merge that history again.
    git("checkout", "-B", "integration", web);
    const reviewedNotes = (
      await readFile(path.join(repository, "VORTEO_CHANGELOG.md"), "utf8")
    ).replace("Existing note", "Reviewed historical note");
    await writeFile(path.join(repository, "VORTEO_CHANGELOG.md"), reviewedNotes);
    git("commit", "-am", "reconcile published history");
    const reviewedWeb = git("rev-parse", "HEAD");
    await metadata(179, "Integrated feature");
    await writeFile(
      path.join(repository, "VORTEO_CHANGELOG.md"),
      reviewedNotes.replace(
        "## ",
        "## 0.11.0-beta.3.vorteo.179 - 2026-10-07\n\n### Fixed\n\n- Integrated feature\n\n## ",
      ),
    );
    await writeFile(path.join(repository, "integrated.txt"), "reviewed\n");
    git("add", ".");
    git("commit", "-m", "integrate current published source");
    const integratedCommit = git("rev-parse", "HEAD");
    const integratedFile = path.join(root, "integrated.bundle");
    git("bundle", "create", integratedFile, `${base}..refs/heads/integration`);
    const integratedBundle = await readFile(integratedFile);
    const digest = createHash("sha256").update(integratedBundle).digest("hex");
    await writeFile(path.join(directory, `${digest}.bundle`), integratedBundle);
    const integrated = await prepareSourceBatch({
      ...input,
      webCommit: reviewedWeb,
      contributions: [
        {
          ...first,
          id: crypto.randomUUID(),
          update: {
            sourceCommit: integratedCommit,
            baseCommit: base,
            sha256: digest,
            bytes: integratedBundle.length,
          },
        },
      ],
    });
    expect(integrated.batch.status, JSON.stringify(integrated.batch)).toBe("ready");
    await writeFile(file, output!);
    git("fetch", file, "refs/heads/integration:refs/heads/integrated-result");
    expect(git("show", `${integrated.update!.sourceCommit}:integrated.txt`)).toBe("reviewed");
    expect(git("show", `${integrated.update!.sourceCommit}:VORTEO_CHANGELOG.md`)).toContain(
      "Reviewed historical note",
    );
    git("merge-base", "--is-ancestor", integratedCommit, integrated.update!.sourceCommit);
    const stillDivergent = await prepareSourceBatch({
      ...input,
      webCommit: reviewedWeb,
      contributions: [first],
    });
    expect(stillDivergent.batch.status).toBe("conflict");
    expect(stillDivergent.batch.contributions[0]?.detail).toContain(
      "Existing release notes were edited",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("preparation cannot inherit approval or overwrite cancellation, and a newer web publication invalidates approval", async () => {
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    bytes: 1,
  };
  let web = "b".repeat(40);
  let release!: () => void;
  const install = vi.fn(async () => "installed");
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: async () => "plain",
    installUpdate: install,
    sourceBase: () => update.baseCommit,
    sourceWeb: () => web,
    prepareUpdate: async (contributions) => {
      const preparedWeb = web;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { batch: { status: "ready", webCommit: preparedWeb, contributions }, update };
    },
  });
  const receipt = queue.contribute(
    { target: "host", reason: "Work" },
    "host-agent",
    update,
    crypto.randomUUID(),
  );
  const preparing = queue.prepareBatches();
  const inFlight = queue.contribution(receipt.contribution.id)!.batch;
  expect(() => queue.decide(inFlight.id, inFlight.revision, "approve", update.sha256)).toThrow(
    "exact source",
  );
  queue.decide(inFlight.id, inFlight.revision, "reject");
  release();
  await preparing;
  expect(queue.contribution(receipt.contribution.id)!.batch.status).toBe("rejected");
  const next = queue.contribute(
    { target: "host", reason: "Retry" },
    "host-agent",
    update,
    crypto.randomUUID(),
  );
  const retry = queue.prepareBatches();
  release();
  await retry;
  const ready = queue.contribution(next.contribution.id)!.batch;
  web = "d".repeat(40);
  expect(() => queue.decide(ready.id, ready.revision, "approve", update.sha256)).toThrow(
    "Combined source changed",
  );
  const refresh = queue.prepareBatches();
  release();
  await refresh;
  const refreshed = queue.contribution(next.contribution.id)!.batch;
  expect(refreshed.sourceBatch?.webCommit).toBe(web);
  expect(refreshed.revision).not.toBe(ready.revision);
  expect(refreshed.status).toBe("pending");
  expect(install).not.toHaveBeenCalled();
});

test("Host and Dev contributions have separate batches and exact target approvals", async () => {
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    bytes: 20,
  };
  const installs: string[] = [];
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: async () => {
      throw new Error("An update cannot become a plain restart");
    },
    supportsUpdate: () => true,
    sourceBase: () => update.baseCommit,
    prepareUpdate: async (contributions) => ({ batch: { status: "ready", contributions }, update }),
    installUpdate: async (job) => {
      installs.push(job.target);
      return "installed";
    },
  });
  const host = queue.contribute(
    { target: "host", reason: "Host build" },
    "container-agent",
    update,
    crypto.randomUUID(),
  );
  const devInput = { target: "container-daemon" as const, reason: "Dev build" };
  const devId = crypto.randomUUID();
  const dev = queue.contribute(devInput, "container-agent", update, devId);
  expect(dev.batch.id).not.toBe(host.batch.id);
  expect(() =>
    queue.contribute({ ...devInput, target: "host" }, "container-agent", update, devId),
  ).toThrow("different submission");
  await queue.prepareBatches();
  const ready = queue.contribution(devId)!.batch;
  expect(ready.sourceBatch?.status).toBe("ready");
  expect(queue.contribution(host.contribution.id)!.batch.status).toBe("pending");
  await queue.drain();
  expect(installs).toEqual([]);
  expect(() => queue.decide(ready.id, ready.revision, "approve", "d".repeat(64))).toThrow(
    "exact source",
  );
  queue.decide(ready.id, ready.revision, "approve", update.sha256);
  await queue.drain();
  expect(installs).toEqual(["container-daemon"]);
  expect(queue.contribution(host.contribution.id)!.batch.status).toBe("pending");
});

test("supervisor maintenance requires exact review and stays visible and cancellable", async () => {
  const sha = "a".repeat(64);
  const journal = new MemoryJournal();
  const calls: string[] = [];
  const queue = new InstallationRestarts(journal, {
    supervisorPlan: () => sha,
    restartSupervisor: async () => {
      calls.push("supervisor");
      return "ready";
    },
    restart: async () => {
      calls.push("worker");
      return "wrong";
    },
    restartWhenIdle: async () => "wrong",
    holdCurrentTurns: async () => {
      calls.push("hold");
    },
    releaseCurrentTurns: async () => {
      calls.push("release");
    },
    inspect: async () => ({
      target: "container-daemon",
      checkedAt: new Date().toISOString(),
      agents: [{ id: "busy", title: "Busy", status: "running" }],
      pendingStarts: 0,
      idleRestartSupported: true,
      gracefulRestartSupported: true,
      error: null,
    }),
  });
  const request = queue.request(
    { target: "container-daemon", reason: "Repair launcher", supervisorPlanSha256: sha },
    "host-agent",
  );
  expect(queue.list()[0]?.status).toBe("pending");
  await queue.drain();
  expect(calls).toEqual([]);
  expect(() => queue.decide(request.id, request.revision, "finish-current-turns")).toThrow(
    "exact supervisor",
  );
  expect(() =>
    queue.decide(request.id, request.revision, "approve-when-idle", undefined, sha),
  ).toThrow("Finish turns");
  expect(() =>
    queue.request({ target: "container-daemon", reason: "Worker" }, "host-agent"),
  ).toThrow("different");
  const approved = queue.decide(
    request.id,
    request.revision,
    "finish-current-turns",
    undefined,
    sha,
  );
  await queue.drain();
  expect(calls).toEqual(["hold"]);
  expect(queue.list()[0]?.status).toBe("approved");
  queue.decide(approved.id, approved.revision, "cancel");
  await queue.drain();
  expect(calls).toEqual(["hold", "release"]);
  expect(queue.list()[0]?.status).toBe("rejected");
});

test("supervisor requests reject guest submission and changed plans before dispatch", async () => {
  let sha = "a".repeat(64);
  const journal = new MemoryJournal();
  const calls: string[] = [];
  const queue = new InstallationRestarts(journal, {
    supervisorPlan: () => sha,
    restartSupervisor: async () => {
      calls.push("supervisor");
      return "ready";
    },
    restart: async () => "worker",
  });
  const input = {
    target: "container-daemon" as const,
    reason: "Repair launcher",
    supervisorPlanSha256: sha,
  };
  expect(() => queue.request(input, "container-agent")).toThrow("Host");
  const job = queue.request(input, "host-agent");
  queue.decide(job.id, job.revision, "approve", undefined, sha);
  sha = "b".repeat(64);
  await queue.drain();
  expect(calls).toEqual([]);
  expect(queue.list()[0]?.status).toBe("failed");
});

test("supervisor maintenance dispatches once after held turns finish and never replays an interrupted dispatch", async () => {
  const sha = "a".repeat(64);
  const journal = new MemoryJournal();
  const calls: string[] = [];
  let busy = true;
  const executor: RestartExecutor = {
    supervisorPlan: () => sha,
    restartSupervisor: async () => {
      calls.push("supervisor");
      return "Supervisor ready";
    },
    restart: async () => {
      throw new Error("Worker restart cannot execute supervisor maintenance");
    },
    restartWhenIdle: async () => {
      throw new Error("Worker restart cannot execute supervisor maintenance");
    },
    holdCurrentTurns: async () => {
      calls.push("hold");
    },
    releaseCurrentTurns: async () => {
      calls.push("release");
    },
    inspect: async () => ({
      target: "container-daemon",
      checkedAt: new Date().toISOString(),
      agents: busy ? [{ id: "active", title: "Active", status: "running" }] : [],
      pendingStarts: 0,
      idleRestartSupported: true,
      gracefulRestartSupported: true,
      error: null,
    }),
  };
  const queue = new InstallationRestarts(journal, executor);
  const job = queue.request(
    { target: "container-daemon", reason: "Repair launcher", supervisorPlanSha256: sha },
    "host-agent",
  );
  queue.decide(job.id, job.revision, "finish-current-turns", undefined, sha);
  await queue.drain();
  expect(calls).toEqual(["hold"]);
  busy = false;
  await queue.drain();
  expect(queue.list()[0]?.status).toBe("succeeded");
  expect(calls.filter((call) => call === "supervisor")).toHaveLength(1);
  await new InstallationRestarts(journal, executor).drain();
  expect(calls.filter((call) => call === "supervisor")).toHaveLength(1);
  const interrupted = queue.list();
  for (const entry of interrupted) entry.status = "running";
  journal.write(interrupted);
  const recovered = new InstallationRestarts(journal, executor);
  await recovered.drain();
  expect(recovered.list()[0]?.status).toBe("failed");
  expect(calls.filter((call) => call === "supervisor")).toHaveLength(1);
});

test("supervisor repair preserves a pending source batch and serializes both approvals", async () => {
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    bytes: 1,
  };
  const sha = "d".repeat(64);
  const queue = new InstallationRestarts(new MemoryJournal(), {
    supervisorPlan: () => sha,
    restartSupervisor: async () => "repaired",
    restart: async () => "plain",
    supportsUpdate: () => true,
    installUpdate: async () => "installed",
    sourceBase: () => update.baseCommit,
    prepareUpdate: async (contributions) => ({ batch: { status: "ready", contributions }, update }),
  });
  const receipt = queue.contribute(
    { target: "container-daemon", reason: "Retain another task" },
    "container-agent",
    update,
    crypto.randomUUID(),
  );
  await queue.prepareBatches();
  const batch = queue.contribution(receipt.contribution.id)!.batch;
  const job = queue.request(
    { target: "container-daemon", reason: "Repair launcher", supervisorPlanSha256: sha },
    "host-agent",
  );
  expect(job.id).not.toBe(batch.id);
  expect(queue.contribution(receipt.contribution.id)!.batch).toEqual(batch);
  queue.decide(job.id, job.revision, "approve", undefined, sha);
  expect(() => queue.decide(batch.id, batch.revision, "approve", update.sha256)).toThrow(
    "earlier request",
  );
  await queue.drain();
  expect(queue.contribution(receipt.contribution.id)!.batch.status).toBe("pending");
  expect(queue.list().find((entry) => entry.id === job.id)?.status).toBe("succeeded");
});

test("release notes preserve interleaved history and reject edits or missing duplicates", async () => {
  const { reconcileReleaseNotes } = await import("./source-release-metadata.js");
  const prefix = "# Vorteo changelog\n\n";
  const old = "## 0.11.0-beta.3.vorteo.177 - 2026-10-07\n\n- Existing note";
  const older = "## 0.11.0-beta.3.vorteo.176 - 2026-10-07\n\n- Earlier note";
  const added = "## 0.11.0-beta.3.vorteo.178 - 2026-10-07\n\n- New note";
  const other = "## 0.11.0-beta.3.vorteo.178 - 2026-10-07\n\n- Concurrent note";
  const base = `${prefix}${old}\n\n${older}\n`;
  const accepted = `${prefix}${old}\n\n${added}\n\n${older}\n`;
  const incoming = `${prefix}${other}\n\n${old}\n\n${older}\n`;
  const result = reconcileReleaseNotes(base, accepted, incoming);
  expect(result).toBe(`${prefix}${other}\n\n${accepted.slice(prefix.length)}`);
  expect(reconcileReleaseNotes(base, result, incoming)).toBe(result);
  expect(reconcileReleaseNotes(base.replace(prefix, prefix + "\n"), accepted, incoming)).toBe(
    result,
  );
  expect(() =>
    reconcileReleaseNotes(base, accepted, incoming.replace("Existing note", "Edited")),
  ).toThrow("Existing release notes were edited");
  expect(() => reconcileReleaseNotes(base, accepted, `${prefix}${old}\n`)).toThrow(
    "Existing release notes were edited",
  );
  const duplicate = `${prefix}${old}\n\n${old}\n`;
  expect(() => reconcileReleaseNotes(duplicate, duplicate, `${prefix}${old}\n`)).toThrow(
    "Existing release notes were edited",
  );
  expect(() =>
    reconcileReleaseNotes(base, accepted, incoming.replace("# Vorteo changelog", "# Changed")),
  ).toThrow("introduction changed");
});

test("coordinator recovery revalidates pending conflicts without approving or installing", async () => {
  const journal = new MemoryJournal();
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    bytes: 1,
  };
  const contribution = {
    id: crypto.randomUUID(),
    update,
    reason: "Feature",
    requestedBy: "container-agent" as const,
    createdAt: new Date().toISOString(),
    status: "invalid" as const,
    detail: "Existing release notes were edited; resolve explicitly",
  };
  journal.jobs = [
    {
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      target: "host",
      requestedBy: "container-agent",
      reason: "Feature",
      createdAt: contribution.createdAt,
      expiresAt: "9999-12-31T23:59:59.999Z",
      status: "pending",
      detail: "Needs correction",
      sourceBatch: { status: "conflict", contributions: [contribution] },
    },
  ];
  const previous = structuredClone(journal.jobs[0]!);
  let preparations = 0;
  let installations = 0;
  const queue = new InstallationRestarts(journal, {
    restart: async () => {
      installations++;
      return "unexpected";
    },
    sourceBase: () => update.baseCommit,
    sourceWeb: () => update.baseCommit,
    prepareUpdate: async (contributions) => {
      preparations++;
      return {
        batch: {
          status: "ready",
          webCommit: update.baseCommit,
          contributions: contributions.map((item) => ({
            ...item,
            status: "included",
            detail: "Included",
          })),
        },
        update,
      };
    },
  });
  expect(queue.list()[0]?.revision).not.toBe(previous.revision);
  await queue.prepareBatches();
  await queue.prepareBatches();
  expect(preparations).toBe(1);
  expect(installations).toBe(0);
  expect(queue.list()[0]).toMatchObject({
    id: previous.id,
    status: "pending",
    sourceBatch: { status: "ready", contributions: [{ id: contribution.id, update }] },
  });
  expect(() => queue.decide(previous.id, previous.revision, "approve")).toThrow("changed");
});

test("source batching uses shared ancestry instead of replaying the bundle prerequisite", async () => {
  const { execFileSync } = await import("node:child_process");
  const { prepareSourceBatch } = await import("./source-batches.js");
  const root = await mkdtemp(path.join(tmpdir(), "batch-ancestry-"));
  const repository = path.join(root, "repository");
  const directory = path.join(root, "bundles");
  await mkdir(repository);
  await mkdir(directory);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@localhost",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@localhost",
      },
    }).trim();
  try {
    git("init", "--initial-branch=integration");
    await writeFile(path.join(repository, "feature.txt"), "original\n");
    git("add", ".");
    git("commit", "-m", "installed prerequisite");
    const baseCommit = git("rev-parse", "HEAD");
    await writeFile(path.join(repository, "feature.txt"), "shared implementation\n");
    git("commit", "-am", "shared feature");
    const common = git("rev-parse", "HEAD");
    await writeFile(path.join(repository, "feature.txt"), "accepted refinement\n");
    git("commit", "-am", "live refinement");
    const webCommit = git("rev-parse", "HEAD");
    git("checkout", "-B", "integration", common);
    await writeFile(path.join(repository, "new.txt"), "new feature\n");
    git("add", ".");
    git("commit", "-m", "parallel feature");
    const sourceCommit = git("rev-parse", "HEAD");
    const bundleFile = path.join(root, "incoming.bundle");
    git("bundle", "create", bundleFile, `${baseCommit}..refs/heads/integration`);
    const bundle = await readFile(bundleFile);
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    await writeFile(path.join(directory, `${sha256}.bundle`), bundle);
    let combined: Buffer | undefined;
    const result = await prepareSourceBatch({
      repository,
      directory,
      integrationRef: "refs/heads/integration",
      baseCommit,
      webCommit,
      contributions: [
        {
          id: crypto.randomUUID(),
          requestedBy: "container-agent",
          createdAt: new Date().toISOString(),
          reason: "Parallel feature",
          status: "queued",
          detail: "",
          update: { sourceCommit, baseCommit, sha256, bytes: bundle.length },
        },
      ],
      stage: (_update, bytes) => {
        combined = bytes;
      },
    });
    expect(result.batch.status, JSON.stringify(result.batch)).toBe("ready");
    const output = path.join(root, "combined.bundle");
    await writeFile(output, combined!);
    git("fetch", output, "refs/heads/integration:refs/heads/combined");
    expect(git("show", "combined:feature.txt")).toBe("accepted refinement");
    expect(git("show", "combined:new.txt")).toBe("new feature");
    git("merge-base", "--is-ancestor", webCommit, "combined");
    git("merge-base", "--is-ancestor", sourceCommit, "combined");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted Host policy finishes turns and persists approval before automatic dispatch", async () => {
  const journal = new MemoryJournal();
  const events: string[] = [];
  let active = true;
  const queue = new InstallationRestarts(
    journal,
    {
      restart: async () => {
        throw new Error("Immediate restart must not run");
      },
      holdCurrentTurns: async () => {
        expect(journal.jobs[0]?.status).toBe("approved");
        events.push("hold");
      },
      releaseCurrentTurns: async () => {
        events.push("release");
      },
      inspect: async (target) => ({
        target,
        checkedAt: new Date(2000).toISOString(),
        error: null,
        idleRestartSupported: true,
        pendingStarts: 0,
        agents: active ? [{ id: "active-thread", title: "Task", status: "running" }] : [],
      }),
      restartWhenIdle: async () => {
        events.push("restart");
        return "ready";
      },
    },
    () => 2000,
    { hostRequestsAfter: new Date(1000).toISOString() },
  );
  const request = queue.request(
    { target: "container-daemon", reason: "Validated update" },
    "host-agent",
  );
  await queue.drain();
  expect(queue.list()[0]).toMatchObject({ status: "approved", finishCurrentTurns: true });
  expect(events).toEqual(["hold"]);
  active = false;
  await queue.drain();
  await queue.drain();
  expect(events).toEqual(["hold", "hold", "restart", "release"]);
  expect(queue.list()[0]).toMatchObject({
    id: request.id,
    status: "succeeded",
    holdReleased: true,
  });
});

function automaticFixture() {
  const journal = new MemoryJournal();
  const events: string[] = [];
  let active = true;
  const executor: RestartExecutor = {
    restart: async () => {
      throw new Error("Unexpected immediate restart");
    },
    holdCurrentTurns: async () => {
      events.push("hold");
    },
    releaseCurrentTurns: async () => {
      events.push("release");
    },
    inspect: async (target) => ({
      target,
      checkedAt: new Date(2000).toISOString(),
      error: null,
      idleRestartSupported: true,
      pendingStarts: 0,
      agents: active ? [{ id: "work", title: "Work", status: "running" }] : [],
    }),
    restartWhenIdle: async () => {
      events.push("restart");
      return "ready";
    },
    supportsUpdate: () => true,
    sourceBase: () => "b".repeat(40),
    sourceWeb: () => "b".repeat(40),
    installUpdate: async () => {
      events.push("install");
      return "installed";
    },
    prepareUpdate: async (contributions) => ({
      batch: {
        status: "ready",
        webCommit: "b".repeat(40),
        contributions: contributions.map((item) => ({
          ...item,
          status: "included",
          detail: "Included",
        })),
      },
      update: {
        sourceCommit: "a".repeat(40),
        baseCommit: "b".repeat(40),
        sha256: "c".repeat(64),
        bytes: 12,
      },
    }),
  };
  const policy = { hostRequestsAfter: new Date(1000).toISOString() };
  const queue = new InstallationRestarts(journal, executor, () => 2000, policy);
  return {
    queue,
    journal,
    events,
    executor,
    policy,
    idle: () => {
      active = false;
    },
  };
}

test("automatic Host policy cannot approve a Dev request or a mixed source batch", async () => {
  const f = automaticFixture();
  const plain = f.queue.request(
    { target: "host", reason: "Dev request", requester: "host-agent" },
    "container-agent",
  );
  await f.queue.drain();
  expect(f.queue.list()[0]?.status).toBe("pending");
  f.queue.decide(plain.id, plain.revision, "reject");
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    bytes: 12,
  };
  f.queue.contribute(
    { target: "host", reason: "Host changes" },
    "host-agent",
    update,
    "10000000-0000-4000-8000-000000000001",
  );
  f.queue.contribute(
    { target: "host", reason: "Dev changes" },
    "container-agent",
    update,
    "10000000-0000-4000-8000-000000000002",
  );
  await f.queue.drain();
  expect(f.queue.list().at(-1)).toMatchObject({
    status: "pending",
    sourceBatch: { status: "ready" },
  });
  expect(f.events).toEqual([]);
});

test("automatic source approval binds its prepared digest and remains cancellable before dispatch", async () => {
  const f = automaticFixture();
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    bytes: 12,
  };
  f.queue.contribute(
    { target: "host", reason: "Host changes" },
    "host-agent",
    update,
    "10000000-0000-4000-8000-000000000003",
  );
  await f.queue.drain();
  const approved = f.queue.list()[0]!;
  expect(approved).toMatchObject({
    status: "approved",
    automaticApproval: {
      policyActivatedAt: f.policy.hostRequestsAfter,
      requestRevision: approved.revision,
      sourceSha256: update.sha256,
    },
  });
  f.queue.decide(approved.id, approved.revision, "cancel");
  f.idle();
  await f.queue.drain();
  expect(f.events).toEqual(["hold", "release"]);
  expect(f.queue.list()[0]?.status).toBe("rejected");
});

test("automatic approval does not retroactively authorize older Host requests", async () => {
  const f = automaticFixture();
  const old = new InstallationRestarts(f.journal, f.executor, () => 500, f.policy);
  old.request({ target: "host", reason: "Old manual request" }, "host-agent");
  await old.drain();
  expect(old.list()[0]?.status).toBe("pending");
  expect(f.events).toEqual([]);
});

test("an automatically approved wait survives coordinator recovery without replaying completed restarts", async () => {
  const f = automaticFixture();
  f.queue.request({ target: "container-daemon", reason: "Prepared" }, "host-agent");
  await f.queue.drain();
  const recovered = new InstallationRestarts(f.journal, f.executor, () => 3000, f.policy);
  f.idle();
  await recovered.drain();
  await recovered.drain();
  const again = new InstallationRestarts(f.journal, f.executor, () => 4000, f.policy);
  await again.drain();
  expect(f.events.filter((event) => event === "restart")).toHaveLength(1);
  expect(again.list()[0]).toMatchObject({ status: "succeeded", holdReleased: true });
});

test("automatic Host approvals survive three replacement cycles without replay or Dev promotion", async () => {
  const f = automaticFixture();
  let queue = f.queue;
  const pending = queue.request(
    { target: "host", reason: "Dev request remains manual" },
    "container-agent",
  );
  f.idle();
  const completed: string[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const job = queue.request(
      { target: "container-daemon", reason: `Host cycle ${cycle}` },
      "host-agent",
    );
    await queue.drain();
    // Reopen the journal before the release pass, as after coordinator replacement.
    queue = new InstallationRestarts(f.journal, f.executor, () => 3000 + cycle, f.policy);
    await queue.drain();
    completed.push(job.id);
    expect(queue.list().find((item) => item.id === job.id)).toMatchObject({
      status: "succeeded",
      holdReleased: true,
    });
    expect(queue.list().find((item) => item.id === pending.id)?.status).toBe("pending");
    expect(f.events.filter((event) => event === "restart")).toHaveLength(cycle + 1);
    expect(f.events.filter((event) => event === "release")).toHaveLength(cycle + 1);
  }
  expect(new Set(completed).size).toBe(3);
  await queue.drain();
  expect(f.events.filter((event) => event === "restart")).toHaveLength(3);
});

test("automatic approval refuses changed source after recovering an approved wait", async () => {
  const f = automaticFixture();
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    bytes: 12,
  };
  f.queue.contribute(
    { target: "host", reason: "Prepared source" },
    "host-agent",
    update,
    crypto.randomUUID(),
  );
  await f.queue.drain();
  const record = f.journal.jobs[0]!;
  f.journal.jobs[0] = { ...record, update: { ...update, sha256: "d".repeat(64) } };
  const recovered = new InstallationRestarts(f.journal, f.executor, () => 3000, f.policy);
  f.idle();
  await recovered.drain();
  await recovered.drain();
  expect(recovered.list()[0]).toMatchObject({ status: "failed", holdReleased: true });
  expect(f.events).not.toContain("install");
  expect(f.events).not.toContain("restart");
});

test("automatic policy leaves requests pending when safe activity inspection is unavailable", async () => {
  const f = automaticFixture();
  f.executor.inspect = undefined;
  f.queue.request({ target: "host", reason: "Prepared" }, "host-agent");
  await f.queue.drain();
  expect(f.queue.list()[0]?.status).toBe("pending");
  expect(f.events).toEqual([]);
});

test("bootstrap startup fence preserves journal and prevents reconciliation and dispatch until release", async () => {
  const journal = new MemoryJournal();
  const existing = new InstallationRestarts(journal, {
    restart: async () => "unused",
    restartWhenIdle: async () => null,
  });
  const request = existing.request(
    { target: "host", reason: "Keep pending work" },
    "container-agent",
  );
  existing.decide(request.id, request.revision, "approve-when-idle");
  const before = journal.read();
  const write = vi.spyOn(journal, "write");
  const restart = vi.fn(async () => "ready");
  const inspect = vi.fn();
  const prepareUpdate = vi.fn();
  const queue = new InstallationRestarts(
    journal,
    { restart, inspect, prepareUpdate },
    Date.now,
    {},
    { fenced: true },
  );
  expect(queue.list()[0]?.status).toBe("approved");
  await queue.drain();
  await queue.prepareBatches();
  await queue.refreshImpacts();
  await expect(queue.impacts()).rejects.toThrow("fenced");
  expect(() => queue.request({ target: "host", reason: "Disallowed" }, "host-agent")).toThrow(
    "fenced",
  );
  expect(() => queue.decide(request.id, before[0]!.revision, "cancel")).toThrow("fenced");
  expect(journal.read()).toEqual(before);
  expect(write).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  expect(prepareUpdate).not.toHaveBeenCalled();
  queue.activate();
  expect(write).toHaveBeenCalledTimes(1);
  queue.activate();
  expect(write).toHaveBeenCalledTimes(1);
  expect(queue.list()[0]?.status).toBe("approved");
});

test("bootstrap startup refuses release after external journal change or failed persistence", () => {
  const journal = new MemoryJournal();
  const queue = new InstallationRestarts(
    journal,
    { restart: async () => "unused" },
    Date.now,
    {},
    { fenced: true },
  );
  journal.failWrite = true;
  expect(() => queue.activate()).toThrow("disk unavailable");
  expect(() => queue.request({ target: "host", reason: "No release" }, "host-agent")).toThrow(
    "fenced",
  );
  journal.failWrite = false;
  const external = new InstallationRestarts(journal, { restart: async () => "unused" });
  external.request({ target: "host", reason: "External change" }, "container-agent");
  expect(() => queue.activate()).toThrow("changed while startup was fenced");
  expect(journal.jobs).toHaveLength(1);
});
