import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { RestartJobSchema, type RestartJob } from "@getpaseo/protocol/execution-installation";
import { InstallationRestarts, type RestartExecutor } from "./restarts.js";
import type { LifecycleJob } from "./lifecycle-journal.js";

function fixture() {
  const update = {
    baseCommit: "a".repeat(40),
    sourceCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    bytes: 100,
  };
  const original: RestartJob = {
    id: randomUUID(),
    revision: randomUUID(),
    target: "container-daemon",
    reason: "Retained source conflict",
    requestedBy: "container-agent",
    createdAt: new Date().toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z",
    status: "pending",
    detail: "Conflict",
    sourceBatch: {
      status: "conflict",
      contributions: [
        {
          id: randomUUID(),
          update,
          reason: "Original contribution",
          requestedBy: "container-agent",
          createdAt: new Date().toISOString(),
          status: "conflict",
          detail: "Ambiguous merge base",
        },
      ],
    },
  };
  let stored: LifecycleJob[] = [original];
  const journal = {
    read: () => structuredClone(stored),
    write: (jobs: LifecycleJob[]) => {
      stored = structuredClone(jobs);
    },
  };
  const prepared = {
    ...update,
    sourceCommit: "d".repeat(40),
    sha256: "e".repeat(64),
  };
  const prepare = vi.fn(async () => prepared);
  const restart = vi.fn(async () => "must not run");
  const executor: RestartExecutor = {
    restart,
    installUpdate: async () => "must not install",
    supportsUpdate: () => true,
    sourceBase: () => update.baseCommit,
    sourceWeb: () => update.baseCommit,
    captureDevRepair: () => ({
      hostReleaseDirectory: "/fixture/release",
      baseCommit: update.baseCommit,
      sourceCommit: prepared.sourceCommit,
      integrationRef: "refs/heads/installation-integration",
      contributionCommits: [update.sourceCommit],
    }),
    prepareDevRepair: prepare,
    prepareUpdate: async (contributions) => ({
      batch: {
        status: "conflict",
        contributions,
        webCommit: update.baseCommit,
      },
    }),
  };
  const queue = new InstallationRestarts(journal, executor);
  // Startup retries inert batch validation; restore the concrete conflict through that path.
  async function conflict() {
    await queue.prepareBatches();
    return queue.list()[0]!;
  }
  return {
    queue,
    journal,
    executor,
    original,
    prepared,
    prepare,
    restart,
    conflict,
  };
}

test("owner repair persists its capture, preserves contributions and requires a separate exact approval", async () => {
  const f = fixture();
  const conflict = await f.conflict();
  const repair = f.queue.requestDevRepair(conflict.id, conflict.revision);
  expect(RestartJobSchema.parse(f.journal.read()[0]).devRepairs?.[0]).toMatchObject({
    status: "preparing",
    capturedRevision: conflict.revision,
  });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(() => f.queue.decide(repair.id, repair.revision, "approve")).toThrow();
  await f.queue.prepareBatches();
  const result = f.queue.list()[0]!;
  expect(result.status).toBe("pending");
  expect(result.requireOwnerApproval).toBe(true);
  expect(result.devRepairs?.[0]?.status).toBe("prepared");
  expect(result.sourceBatch?.contributions[0]).toEqual(f.original.sourceBatch!.contributions[0]);
  expect(result.sourceBatch?.contributions[1]).toMatchObject({
    requestedBy: "owner",
    update: f.prepared,
    requireOwnerApproval: true,
  });
  expect(f.restart).not.toHaveBeenCalled();
});

test.each(["cancel", "upload"])(
  "late preparation cannot overwrite a concurrent %s",
  async (action) => {
    const f = fixture();
    const conflict = await f.conflict();
    let finish!: (value: typeof f.prepared) => void;
    f.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const repair = f.queue.requestDevRepair(conflict.id, conflict.revision);
    const pending = f.queue.prepareBatches();
    if (action === "cancel") f.queue.decide(repair.id, repair.revision, "reject");
    else
      f.queue.contribute(
        { target: "container-daemon", reason: "New source" },
        "container-agent",
        f.prepared,
        randomUUID(),
      );
    const before = f.journal.read();
    finish(f.prepared);
    await pending;
    expect(f.journal.read()).toEqual(before);
    expect(f.restart).not.toHaveBeenCalled();
  },
);

test("interrupted preparation is durable and never automatically replayed", async () => {
  const f = fixture();
  const conflict = await f.conflict();
  f.queue.requestDevRepair(conflict.id, conflict.revision);
  const resumed = new InstallationRestarts(f.journal, f.executor);
  expect(resumed.list()[0]?.devRepairs?.[0]).toMatchObject({
    status: "failed",
    detail: expect.stringContaining("interrupted"),
  });
  await resumed.prepareBatches();
  await resumed.prepareBatches();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.restart).not.toHaveBeenCalled();
});

test("failed preparation remains visible, does not retry, and retains history on a new capture", async () => {
  const f = fixture();
  const conflict = await f.conflict();
  f.prepare.mockRejectedValueOnce(new Error("Selected Host source changed"));
  f.queue.requestDevRepair(conflict.id, conflict.revision);
  await f.queue.prepareBatches();
  const failed = f.queue.list()[0]!;
  expect(failed.detail).toContain("Selected Host source changed");
  await f.queue.prepareBatches();
  expect(f.prepare).toHaveBeenCalledTimes(1);
  const retry = f.queue.requestDevRepair(failed.id, failed.revision);
  expect(retry.devRepairs).toHaveLength(2);
  expect(retry.devRepairs?.[0]?.status).toBe("failed");
});

test("stale revisions and failed journal writes cannot start preparation", async () => {
  const f = fixture();
  const conflict = await f.conflict();
  expect(() => f.queue.requestDevRepair(conflict.id, randomUUID())).toThrow("changed");
  f.journal.write = () => {
    throw new Error("disk full");
  };
  expect(() => f.queue.requestDevRepair(conflict.id, conflict.revision)).toThrow("disk full");
  expect(f.prepare).not.toHaveBeenCalled();
});
