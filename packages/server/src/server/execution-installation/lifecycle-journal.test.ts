import { assertFrozenCoordinatorIdle } from "./coordinator-bootstrap.js";
import { expect, test } from "vitest";
import { z } from "zod";
import { RestartJobSchema } from "@getpaseo/protocol/execution-installation";
import { InstallationRestarts } from "./restarts.js";
import type { LifecycleJob } from "./lifecycle-journal.js";
import { parseLifecycleJournal } from "./lifecycle-journal.js";

const id = "00000000-0000-4000-8000-000000000001";
const date = "2026-10-09T00:00:00.000Z";
const digest = "a".repeat(64);
const restart = {
  id,
  revision: id,
  target: "host",
  requestedBy: "host-agent",
  reason: "Restart Host",
  createdAt: date,
  expiresAt: "9999-12-31T23:59:59.999Z",
  status: "pending",
  detail: "Review",
};
const file = { path: "/private/fixture/tool", sha256: digest };
const helper = {
  id: "00000000-0000-4000-8000-000000000002",
  revision: id,
  target: "native-helper",
  operation: "native-helper-install",
  requestedBy: "host-agent",
  reason: "Install helper",
  createdAt: date,
  status: "pending",
  detail: "Review",
  stage: "prepared",
  planSha256: digest,
  plan: {
    version: 1,
    operation: "native-helper-install",
    installationId: id,
    candidate: {
      sourceCommit: "b".repeat(40),
      directory: "/private/fixture/candidate.app",
      artifactSha256: digest,
      signingMode: "local",
      helperRequirement: "helper",
      clientRequirement: "client",
    },
    previous: null,
    retainedRollback: null,
    tooling: {
      sourceCommit: "b".repeat(40),
      directory: "/private/fixture/tooling",
      artifactSha256: digest,
      node: file,
      installer: file,
      dispatcher: file,
      invocationClient: file,
    },
    destination: {
      application: "/private/fixture/Helper.app",
      runtime: "/private/fixture/runtime",
    },
    expectedState: {
      configurationSha256: null,
      policySha256: null,
      installationReceiptSha256: null,
    },
  },
};

test("new journal reader preserves legacy daemon records without migration", () => {
  expect(parseLifecycleJournal([restart])).toEqual([restart]);
});

test("one lifecycle ledger retains helper and daemon records in their original order", () => {
  const records = [helper, restart];
  expect(parseLifecycleJournal(JSON.parse(JSON.stringify(records)))).toEqual(records);
});

test("legacy coordinator rejects helper records instead of approving them as Host restarts", () => {
  expect(() => z.array(RestartJobSchema).parse([restart, helper])).toThrow();
  expect(() => parseLifecycleJournal([{ ...helper, target: "host" }])).toThrow();
});

test("journal rejects duplicate identities and malformed entries without partial recovery", () => {
  expect(() => parseLifecycleJournal([restart, { ...helper, id }])).toThrow("duplicate");
  expect(() =>
    parseLifecycleJournal([restart, { ...helper, requestedBy: "container-agent" }]),
  ).toThrow();
  expect(() => parseLifecycleJournal([restart, { ...helper, plan: undefined }])).toThrow();
});

function queueFixture() {
  let records: LifecycleJob[] = [];
  const events: string[] = [];
  let validate = async () => {};
  const journal = {
    read: () => structuredClone(records),
    write: (next: LifecycleJob[]) => {
      records = structuredClone(next);
    },
  };
  const executor = {
    restart: async () => {
      events.push("daemon");
      return "ready";
    },
    validateHelperPlan: () => validate(),
    installHelper: async () => {
      events.push("helper");
      return "helper ready";
    },
  };
  const queue = new InstallationRestarts(journal, executor, () => Date.parse(date), {
    hostRequestsAfter: date,
  });
  const prepare = () =>
    queue.prepareHelper({ id: helper.id, reason: helper.reason, plan: helper.plan }, "host-agent");
  const decision = (
    job: Awaited<ReturnType<typeof prepare>>,
    action: "approve" | "cancel" = "approve",
  ) => ({
    operation: "native-helper-install",
    id: job.id,
    revision: job.revision,
    planSha256: job.planSha256,
    decision: action,
  });
  return {
    queue,
    journal,
    executor,
    events,
    prepare,
    decision,
    setValidate: (next: typeof validate) => {
      validate = next;
    },
  };
}

test("helper requests stay manual under Host automatic policy and never restart daemons", async () => {
  const f = queueFixture();
  const job = await f.prepare();
  await f.queue.drain();
  expect(f.events).toEqual([]);
  expect(() => f.queue.decide(job.id, job.revision, "approve")).toThrow();
  expect(() => f.queue.decideHelper({ ...f.decision(job), planSha256: "c".repeat(64) })).toThrow(
    "changed",
  );
  f.queue.decideHelper(f.decision(job));
  await Promise.all([f.queue.drain(), f.queue.drain()]);
  expect(f.events).toEqual(["helper"]);
  expect(f.queue.listHelpers()[0]).toMatchObject({ status: "succeeded", stage: "succeeded" });
});

test("helper cancellation during artifact preparation cannot be overwritten by late success", async () => {
  const f = queueFixture();
  let release!: () => void;
  f.setValidate(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.prepare();
  const job = f.queue.listHelpers()[0]!;
  expect(() => f.queue.decideHelper(f.decision(job))).toThrow("not ready");
  f.queue.decideHelper(f.decision(job, "cancel"));
  release();
  expect((await pending).status).toBe("rejected");
  await f.queue.drain();
  expect(f.events).toEqual([]);
});

test("helper dispatch revalidates artifacts and respects cancellation while rechecking", async () => {
  const f = queueFixture();
  const job = await f.prepare();
  f.queue.decideHelper(f.decision(job));
  let release!: () => void;
  f.setValidate(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const dispatch = f.queue.drain();
  f.queue.decideHelper(f.decision(job, "cancel"));
  release();
  await dispatch;
  expect(f.events).toEqual([]);
  expect(f.queue.listHelpers()[0]?.status).toBe("rejected");
});

test("helper recovery preserves daemon requests and refuses replay after interrupted approval", async () => {
  const f = queueFixture();
  const daemon = f.queue.request(
    { target: "host", reason: "Dev request stays manual" },
    "container-agent",
  );
  const job = await f.prepare();
  f.queue.decideHelper(f.decision(job));
  const recovered = new InstallationRestarts(f.journal, f.executor);
  await recovered.drain();
  expect(f.events).toEqual([]);
  expect(recovered.listHelpers()[0]).toMatchObject({
    status: "failed",
    stage: "recovery_required",
  });
  expect(recovered.list().find((item) => item.id === daemon.id)?.status).toBe("pending");
  expect(f.journal.read()).toHaveLength(2);
});

test("helper guest preparation and failed artifact checks never execute installation", async () => {
  const f = queueFixture();
  await expect(
    f.queue.prepareHelper(
      { id: helper.id, reason: helper.reason, plan: helper.plan },
      "container-agent",
    ),
  ).rejects.toThrow("Host access");
  const job = await f.prepare();
  f.queue.decideHelper(f.decision(job));
  f.setValidate(async () => {
    throw new Error("changed artifact");
  });
  await f.queue.drain();
  expect(f.queue.listHelpers()[0]?.status).toBe("failed");
  expect(f.events).toEqual([]);
});

test("coordinator handoff retains completed helper receipts but refuses unresolved helper work", () => {
  expect(() => assertFrozenCoordinatorIdle([helper], [])).not.toThrow();
  expect(() =>
    assertFrozenCoordinatorIdle([{ ...helper, status: "succeeded", stage: "succeeded" }], []),
  ).not.toThrow();
  for (const change of [
    { status: "approved" },
    { status: "running" },
    { stage: "preparing" },
    { status: "failed", stage: "recovery_required" },
  ])
    expect(() => assertFrozenCoordinatorIdle([{ ...helper, ...change }], [])).toThrow(
      "unresolved helper",
    );
});

test("canceled or failed helper preparation does not leave a coordinator maintenance hold", () => {
  for (const status of ["failed", "rejected"]) {
    expect(() =>
      assertFrozenCoordinatorIdle([{ ...helper, status, stage: "preparing" }], []),
    ).not.toThrow();
  }
});

test("persisted helper plan changes cannot reuse the reviewed digest", async () => {
  const f = queueFixture();
  const job = await f.prepare();
  const records = f.journal.read();
  for (const record of records) {
    if (record.target === "native-helper") record.plan.candidate.sourceCommit = "c".repeat(40);
  }
  f.journal.write(records);
  const recovered = new InstallationRestarts(f.journal, f.executor);
  expect(() => recovered.decideHelper(f.decision(job))).toThrow("plan changed");
  await recovered.drain();
  expect(f.events).toEqual([]);
  // A damaged pending request remains cancellable without approving its new plan.
  expect(recovered.decideHelper(f.decision(job, "cancel")).status).toBe("rejected");
});

test("artifact validation receives a copy and cannot change the approved installation plan", async () => {
  const f = queueFixture();
  const queue = new InstallationRestarts(f.journal, {
    ...f.executor,
    validateHelperPlan: async (plan) => {
      plan.candidate.sourceCommit = "c".repeat(40);
    },
    installHelper: async (job) => {
      expect(job.plan.candidate.sourceCommit).toBe(helper.plan.candidate.sourceCommit);
      return "ready";
    },
  });
  const job = await queue.prepareHelper(
    { id: helper.id, reason: helper.reason, plan: helper.plan },
    "host-agent",
  );
  expect(job.plan.candidate.sourceCommit).toBe(helper.plan.candidate.sourceCommit);
  queue.decideHelper(f.decision(job));
  await queue.drain();
  expect(queue.listHelpers()[0]?.status).toBe("succeeded");
});

test("ambiguous helper execution fences later helpers and daemon dispatch without losing requests", async () => {
  const f = queueFixture();
  const events: string[] = [];
  const queue = new InstallationRestarts(f.journal, {
    ...f.executor,
    installHelper: async () => {
      events.push("attempt");
      throw new Error("Readiness outcome unavailable");
    },
  });
  for (const requestId of [helper.id, "00000000-0000-4000-8000-000000000003"]) {
    const job = await queue.prepareHelper(
      { id: requestId, reason: helper.reason, plan: helper.plan },
      "host-agent",
    );
    queue.decideHelper(f.decision(job));
  }
  await queue.drain();
  expect(events).toEqual(["attempt"]);
  expect(queue.listHelpers().map((job) => job.status)).toEqual(["failed", "approved"]);
  const daemon = queue.request({ target: "host", reason: "Later work" }, "container-agent");
  queue.decide(daemon.id, daemon.revision, "approve");
  await queue.drain();
  expect(f.events).toEqual([]);
  expect(events).toEqual(["attempt"]);
  expect(queue.list()[0]?.status).toBe("approved");
  expect(f.journal.read()).toHaveLength(3);
});

test("helper executor receives durable dispatch ownership and persists its verification phase", async () => {
  const f = queueFixture();
  const stages: string[] = [];
  const queue = new InstallationRestarts(f.journal, {
    ...f.executor,
    installHelper: async (job, reportPhase, recordInstaller, _recordExit, recordPrevious) => {
      expect(job).toMatchObject({ status: "running", stage: "dispatch_pending" });
      expect(f.journal.read().find((item) => item.id === job.id)).toEqual(job);
      recordPrevious(null);
      expect(f.journal.read().find((item) => item.id === job.id)).toMatchObject({
        previousProcess: null,
      });
      expect(() => recordPrevious(null)).toThrow("before installation");
      recordInstaller(42);
      expect(f.journal.read().find((item) => item.id === job.id)).toMatchObject({
        installerPid: 42,
      });
      for (const stage of ["installing", "verifying"] as const) {
        reportPhase(stage);
        const durable = f.journal.read().find((item) => item.id === job.id);
        expect(durable).toMatchObject({ status: "running", stage });
        stages.push(stage);
      }
      return "verified";
    },
  });
  const job = await queue.prepareHelper(
    { id: helper.id, reason: helper.reason, plan: helper.plan },
    "host-agent",
  );
  queue.decideHelper(f.decision(job));
  await queue.drain();
  expect(stages).toEqual(["installing", "verifying"]);
  expect(queue.listHelpers()[0]).toMatchObject({ status: "succeeded", stage: "succeeded" });
});

test("helper phase regression fails without replay and retains the original approved plan", async () => {
  const f = queueFixture();
  const queue = new InstallationRestarts(f.journal, {
    ...f.executor,
    installHelper: async (_job, reportPhase) => {
      reportPhase("verifying");
      reportPhase("installing");
      return "must not succeed";
    },
  });
  const job = await queue.prepareHelper(
    { id: helper.id, reason: helper.reason, plan: helper.plan },
    "host-agent",
  );
  queue.decideHelper(f.decision(job));
  await queue.drain();
  expect(queue.listHelpers()[0]).toMatchObject({
    status: "failed",
    stage: "recovery_required",
    plan: job.plan,
    planSha256: job.planSha256,
  });
  await queue.drain();
  expect(queue.listHelpers()[0]?.status).toBe("failed");
});

test("failed journal writes after helper dispatch cannot allow another lifecycle operation", async () => {
  const f = queueFixture();
  const write = f.journal.write;
  let rejectOutcome = false;
  const journal = {
    read: f.journal.read,
    write: (records: LifecycleJob[]) => {
      if (rejectOutcome) throw new Error("fixture journal unavailable");
      write(records);
    },
  };
  let attempts = 0;
  const queue = new InstallationRestarts(journal, {
    ...f.executor,
    installHelper: async (_job, reportPhase) => {
      attempts++;
      rejectOutcome = true;
      reportPhase("verifying");
      return "must not succeed";
    },
  });
  const job = await queue.prepareHelper(
    { id: helper.id, reason: helper.reason, plan: helper.plan },
    "host-agent",
  );
  queue.decideHelper(f.decision(job));
  await expect(queue.drain()).rejects.toThrow("journal unavailable");
  expect(queue.listHelpers()[0]).toMatchObject({ status: "running", stage: "dispatch_pending" });
  rejectOutcome = false;
  const daemon = queue.request({ target: "host", reason: "later work" }, "container-agent");
  queue.decide(daemon.id, daemon.revision, "approve");
  await queue.drain();
  expect(attempts).toBe(1);
  expect(f.events).toEqual([]);
});

test("late installer exit is durable without clearing interrupted recovery", async () => {
  const f = queueFixture();
  let reportExit = (_exit: { code: number | null; signal: string | null }) => {
    throw new Error("installer not dispatched");
  };
  const queue = new InstallationRestarts(f.journal, {
    ...f.executor,
    installHelper: async (_job, _phase, recordInstaller, recordExit) => {
      recordInstaller(42);
      reportExit = recordExit;
      throw new Error("observation timed out");
    },
  });
  const job = await queue.prepareHelper(
    { id: helper.id, reason: helper.reason, plan: helper.plan },
    "host-agent",
  );
  queue.decideHelper(f.decision(job));
  await queue.drain();
  reportExit({ code: 0, signal: null });
  expect(queue.listHelpers()[0]).toMatchObject({
    status: "failed",
    stage: "recovery_required",
    installerExit: { code: 0, signal: null },
  });
  expect(f.journal.read().find((item) => item.id === job.id)).toMatchObject({
    installerExit: { code: 0, signal: null },
  });
  expect(() => reportExit({ code: 1, signal: null })).toThrow("no longer belongs");
});

test("verified recovery preserves failed history and fences dispatch until verification completes", async () => {
  const f = queueFixture();
  let release = (_detail: string): void => {};
  const verification = new Promise<string>((resolve) => {
    release = resolve;
  });
  const queue = new InstallationRestarts(f.journal, {
    ...f.executor,
    installHelper: async () => {
      throw new Error("interrupted");
    },
    verifyHelperRecovery: async () => verification,
  });
  const job = await queue.prepareHelper(
    { id: helper.id, reason: helper.reason, plan: helper.plan },
    "host-agent",
  );
  queue.decideHelper(f.decision(job));
  await queue.drain();
  const decision = {
    operation: "native-helper-verify-installed",
    id: job.id,
    revision: job.revision,
    planSha256: job.planSha256,
  };
  await expect(queue.verifyHelperRecovery({ ...decision, planSha256: digest })).rejects.toThrow(
    "request changed",
  );
  const daemon = queue.request({ target: "host", reason: "fixture restart" }, "host-agent");
  queue.decide(daemon.id, daemon.revision, "approve");
  const resolving = queue.verifyHelperRecovery(decision);
  await queue.drain();
  expect(f.events).toEqual([]);
  await expect(queue.verifyHelperRecovery(decision)).rejects.toThrow(
    "lifecycle operation is active",
  );
  release("Selected helper verified after interrupted observation");
  const recovered = await resolving;
  expect(recovered).toMatchObject({ status: "failed", stage: "recovered" });
  expect(recovered.recoveryVerifiedAt).toEqual(expect.any(String));
  expect(f.journal.read().find((item) => item.id === job.id)).toEqual(recovered);
  await queue.drain();
  expect(f.events).toEqual(["daemon"]);
  await expect(queue.verifyHelperRecovery(decision)).rejects.toThrow("request changed");
});

test("failed recovery verification retains the lifecycle fence", async () => {
  const f = queueFixture();
  const queue = new InstallationRestarts(f.journal, {
    ...f.executor,
    installHelper: async () => {
      throw new Error("interrupted");
    },
    verifyHelperRecovery: async () => {
      throw new Error("selected bytes changed");
    },
  });
  const job = await queue.prepareHelper(
    { id: helper.id, reason: helper.reason, plan: helper.plan },
    "host-agent",
  );
  queue.decideHelper(f.decision(job));
  await queue.drain();
  const before = f.journal.read();
  await expect(
    queue.verifyHelperRecovery({
      operation: "native-helper-verify-installed",
      id: job.id,
      revision: job.revision,
      planSha256: job.planSha256,
    }),
  ).rejects.toThrow("selected bytes changed");
  expect(f.journal.read()).toEqual(before);
  expect(queue.listHelpers()[0]).toMatchObject({ status: "failed", stage: "recovery_required" });
});

test("rollback requires its own operation in the exact owner decision", async () => {
  const f = queueFixture();
  const job = await f.queue.prepareHelper(
    {
      id: helper.id,
      reason: "Rollback fixture",
      plan: { ...helper.plan, operation: "native-helper-rollback" },
    },
    "host-agent",
  );
  expect(job.operation).toBe("native-helper-rollback");
  expect(() => f.queue.decideHelper(f.decision(job))).toThrow("request changed");
  f.queue.decideHelper({ ...f.decision(job), operation: "native-helper-rollback" });
  await f.queue.drain();
  expect(f.events).toEqual(["helper"]);
});

test.each([false, true])(
  "exact rollback resolves original failure, lost observation: %s",
  async (lostObservation) => {
    const f = queueFixture();
    const events: string[] = [];
    const queue = new InstallationRestarts(f.journal, {
      ...f.executor,
      validateHelperRollback: async () => {
        events.push("inspect");
      },
      verifyHelperRecovery: async () => "Selected rollback verified",
      installHelper: async (job) => {
        events.push(job.operation);
        if (job.operation === "native-helper-install") throw new Error("interrupted");
        if (lostObservation) throw new Error("rollback observation lost");
        return "rollback verified";
      },
    });
    const original = await queue.prepareHelper(
      {
        id: helper.id,
        reason: "upgrade",
        plan: { ...helper.plan, previous: helper.plan.candidate },
      },
      "host-agent",
    );
    queue.decideHelper(f.decision(original));
    await queue.drain();
    const rollback = await queue.prepareHelper(
      {
        id: "00000000-0000-4000-8000-000000000003",
        reason: "restore reviewed release",
        plan: {
          ...helper.plan,
          operation: "native-helper-rollback",
          recoveryOf: {
            id: original.id,
            revision: original.revision,
            planSha256: original.planSha256,
          },
        },
      },
      "host-agent",
    );
    const daemon = queue.request({ target: "host", reason: "waiting" }, "host-agent");
    queue.decide(daemon.id, daemon.revision, "approve");
    await queue.drain();
    expect(events).toEqual(["native-helper-install"]);
    expect(f.events).toEqual([]);
    queue.decideHelper({ ...f.decision(rollback), operation: "native-helper-rollback" });
    await queue.drain();
    expect(events).toEqual(["native-helper-install", "inspect", "native-helper-rollback"]);
    expect(f.events).toEqual([]);
    if (lostObservation) {
      const before = f.journal.read();
      await expect(
        queue.verifyHelperRecovery({
          operation: "native-helper-verify-installed",
          id: original.id,
          revision: original.revision,
          planSha256: original.planSha256,
        }),
      ).rejects.toThrow("latest failed recovery");
      expect(f.journal.read()).toEqual(before);
      await queue.verifyHelperRecovery({
        operation: "native-helper-verify-installed",
        id: rollback.id,
        revision: rollback.revision,
        planSha256: rollback.planSha256,
      });
    }
    expect(queue.listHelpers().find((job) => job.id === original.id)).toMatchObject({
      status: "failed",
      stage: "recovered",
      recoveredBy: rollback.id,
    });
    expect(queue.listHelpers().find((job) => job.id === rollback.id)).toMatchObject({
      status: lostObservation ? "failed" : "succeeded",
      stage: lostObservation ? "recovered" : "succeeded",
    });
    await queue.drain();
    expect(f.events).toEqual(["daemon"]);
  },
);

test("canceling rollback during recovery inspection preserves the failed receipt", async () => {
  const f = queueFixture();
  let release!: () => void;
  const operations: string[] = [];
  const queue = new InstallationRestarts(f.journal, {
    ...f.executor,
    validateHelperRollback: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    installHelper: async (job) => {
      operations.push(job.operation);
      throw new Error("fixture interrupted install");
    },
  });
  const original = await queue.prepareHelper(
    { id: helper.id, reason: "upgrade", plan: { ...helper.plan, previous: helper.plan.candidate } },
    "host-agent",
  );
  queue.decideHelper(f.decision(original));
  await queue.drain();
  const failed = queue.listHelpers()[0]!;
  const rollback = await queue.prepareHelper(
    {
      id: "00000000-0000-4000-8000-000000000003",
      reason: "restore retained release",
      plan: {
        ...helper.plan,
        operation: "native-helper-rollback",
        recoveryOf: {
          id: original.id,
          revision: original.revision,
          planSha256: original.planSha256,
        },
      },
    },
    "host-agent",
  );
  queue.decideHelper({ ...f.decision(rollback), operation: rollback.operation });
  const dispatch = queue.drain();
  queue.decideHelper({ ...f.decision(rollback, "cancel"), operation: rollback.operation });
  release();
  await dispatch;
  expect(operations).toEqual(["native-helper-install"]);
  expect(queue.listHelpers().find((job) => job.id === original.id)).toEqual(failed);
  expect(queue.listHelpers().find((job) => job.id === rollback.id)?.status).toBe("rejected");
  expect(f.journal.read()).toEqual(queue.listHelpers());
});

test("failed atomic rollback outcome keeps both recovery fences and never replays installation", async () => {
  const f = queueFixture();
  let rejectOutcome = false;
  const operations: string[] = [];
  const queue = new InstallationRestarts(
    {
      read: f.journal.read,
      write: (records) => {
        if (rejectOutcome) throw new Error("fixture journal unavailable");
        f.journal.write(records);
      },
    },
    {
      ...f.executor,
      validateHelperRollback: async () => {},
      installHelper: async (job) => {
        operations.push(job.operation);
        if (job.operation === "native-helper-install")
          throw new Error("fixture interrupted install");
        rejectOutcome = true;
        return "verified rollback";
      },
    },
  );
  const original = await queue.prepareHelper(
    { id: helper.id, reason: "upgrade", plan: { ...helper.plan, previous: helper.plan.candidate } },
    "host-agent",
  );
  queue.decideHelper(f.decision(original));
  await queue.drain();
  const failed = queue.listHelpers()[0]!;
  const rollback = await queue.prepareHelper(
    {
      id: "00000000-0000-4000-8000-000000000003",
      reason: "restore retained release",
      plan: {
        ...helper.plan,
        operation: "native-helper-rollback",
        recoveryOf: {
          id: original.id,
          revision: original.revision,
          planSha256: original.planSha256,
        },
      },
    },
    "host-agent",
  );
  queue.decideHelper({ ...f.decision(rollback), operation: rollback.operation });
  await expect(queue.drain()).rejects.toThrow("journal unavailable");
  expect(queue.listHelpers().find((job) => job.id === original.id)).toEqual(failed);
  expect(queue.listHelpers().find((job) => job.id === rollback.id)).toMatchObject({
    status: "running",
    stage: "dispatch_pending",
  });
  expect(f.journal.read()).toEqual(queue.listHelpers());
  rejectOutcome = false;
  const daemon = queue.request({ target: "host", reason: "later work" }, "container-agent");
  queue.decide(daemon.id, daemon.revision, "approve");
  await queue.drain();
  expect(operations).toEqual(["native-helper-install", "native-helper-rollback"]);
  expect(f.events).toEqual([]);
});

test("a newly approved recovery can resolve a failed rollback chain without replaying old requests", async () => {
  const f = queueFixture();
  const attempts: string[] = [];
  let fail = true;
  const queue = new InstallationRestarts(f.journal, {
    ...f.executor,
    validateHelperRollback: async () => {},
    installHelper: async (job) => {
      attempts.push(job.id);
      if (fail) throw new Error("fixture observation failure");
      return "verified replacement";
    },
  });
  const original = await queue.prepareHelper(
    { id: helper.id, reason: "upgrade", plan: { ...helper.plan, previous: helper.plan.candidate } },
    "host-agent",
  );
  queue.decideHelper(f.decision(original));
  await queue.drain();
  const first = await queue.prepareHelper(
    {
      id: "00000000-0000-4000-8000-000000000003",
      reason: "first recovery",
      plan: {
        ...helper.plan,
        operation: "native-helper-rollback",
        previous: helper.plan.candidate,
        recoveryOf: {
          id: original.id,
          revision: original.revision,
          planSha256: original.planSha256,
        },
      },
    },
    "host-agent",
  );
  queue.decideHelper({ ...f.decision(first), operation: first.operation });
  await queue.drain();
  const second = await queue.prepareHelper(
    {
      id: "00000000-0000-4000-8000-000000000004",
      reason: "second reviewed recovery",
      plan: {
        ...helper.plan,
        operation: "native-helper-rollback",
        recoveryOf: { id: first.id, revision: first.revision, planSha256: first.planSha256 },
      },
    },
    "host-agent",
  );
  const daemon = queue.request({ target: "host", reason: "waiting" }, "container-agent");
  queue.decide(daemon.id, daemon.revision, "approve");
  fail = false;
  await queue.drain();
  expect(attempts).toEqual([original.id, first.id]);
  expect(f.events).toEqual([]);
  queue.decideHelper({ ...f.decision(second), operation: second.operation });
  await queue.drain();
  expect(attempts).toEqual([original.id, first.id, second.id]);
  expect(
    queue.listHelpers().map(({ id: requestId, status, stage, recoveredBy }) => ({
      id: requestId,
      status,
      stage,
      recoveredBy,
    })),
  ).toEqual([
    { id: original.id, status: "failed", stage: "recovered", recoveredBy: second.id },
    { id: first.id, status: "failed", stage: "recovered", recoveredBy: second.id },
    { id: second.id, status: "succeeded", stage: "succeeded", recoveredBy: undefined },
  ]);
  expect(f.journal.read().filter((job) => job.target === "native-helper")).toEqual(
    queue.listHelpers(),
  );
  expect(f.events).toEqual([]);
  await queue.drain();
  expect(f.events).toEqual(["daemon"]);
});

test("linked rollback cannot clear an unrelated failed helper receipt", async () => {
  const f = queueFixture();
  const firstQueue = new InstallationRestarts(f.journal, {
    ...f.executor,
    installHelper: async () => {
      throw new Error("fixture failure");
    },
  });
  const original = await firstQueue.prepareHelper(
    { id: helper.id, reason: "upgrade", plan: { ...helper.plan, previous: helper.plan.candidate } },
    "host-agent",
  );
  firstQueue.decideHelper(f.decision(original));
  await firstQueue.drain();
  const failed = firstQueue.listHelpers()[0]!;
  const unrelated = { ...failed, id: "00000000-0000-4000-8000-000000000005" };
  f.journal.write([failed, unrelated]);
  const queue = new InstallationRestarts(f.journal, {
    ...f.executor,
    validateHelperRollback: async () => {},
  });
  const rollback = await queue.prepareHelper(
    {
      id: "00000000-0000-4000-8000-000000000003",
      reason: "linked recovery",
      plan: {
        ...helper.plan,
        operation: "native-helper-rollback",
        recoveryOf: {
          id: original.id,
          revision: original.revision,
          planSha256: original.planSha256,
        },
      },
    },
    "host-agent",
  );
  queue.decideHelper({ ...f.decision(rollback), operation: rollback.operation });
  await queue.drain();
  expect(f.events).toEqual([]);
  expect(queue.listHelpers().find((job) => job.id === original.id)).toEqual(failed);
  expect(queue.listHelpers().find((job) => job.id === unrelated.id)).toEqual(unrelated);
  expect(queue.listHelpers().find((job) => job.id === rollback.id)).toMatchObject({
    status: "failed",
    stage: "prepared",
  });
});
