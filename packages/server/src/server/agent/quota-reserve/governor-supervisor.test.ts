import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { QuotaGovernorPolicy, QuotaObservation } from "@getpaseo/protocol/quota-governor";
import { QuotaGovernorStore } from "./governor-store.js";
import { QuotaExecutionSupervisor, type QuotaExecutionSettlement } from "./governor-supervisor.js";

const directories: string[] = [];
const active: QuotaExecutionSupervisor[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(active.splice(0).map((supervisor) => supervisor.freeze("quota")));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(estimated = false, prepaidMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), "quota-supervision-"));
  directories.push(directory);
  let now = Date.parse("2026-09-14T08:00:00Z");
  const policy: QuotaGovernorPolicy = {
    version: 1,
    account: { issuer: "openai", accountId: "account" },
    launchFloorPercent: 30,
    freezeFloorPercent: 25,
    maxObservationAgeSeconds: 120,
    requiredWindows: [{ bucketId: "coding", windowId: "primary", durationMinutes: 10080 }],
    consumptionLimits: [],
    recovery: "automatic_after_reconciliation",
    ...(prepaidMs === undefined
      ? {}
      : {
          prepaidAuthorization: {
            bucketId: "coding",
            windowId: "primary",
            startsAt: new Date(now).toISOString(),
            expiresAt: new Date(now + prepaidMs).toISOString(),
          },
        }),
    ...(estimated
      ? { estimatedHourly: { bucketId: "coding", windowId: "primary", maxConsumedPoints: 10 } }
      : {}),
  };
  const sample = (usedPercent = 20): QuotaObservation => ({
    status: "available",
    account: policy.account,
    observedAt: new Date(now).toISOString(),
    windows: [
      {
        bucketId: "coding",
        windowId: "primary",
        durationMinutes: 10080,
        usedPercent,
        resetsAt: null,
        semantics: "unknown",
      },
    ],
    consumptionMeters: [],
  });
  let observation = sample();
  const store = new QuotaGovernorStore(directory, { nowMs: () => now });
  if (prepaidMs !== undefined) {
    await store.configureAccountPolicy({
      policy,
      expectedRevision: null,
      readObservation: async () => observation,
    });
  }
  if (estimated) {
    await store.configureAccountingContract({ policy, expectedRevision: null });
    for (let minute = 0; minute <= 60; minute++) {
      if (minute > 0) now += 60_000;
      observation = await store.observeEstimatedUsage({
        observation: sample(),
        authenticationGeneration: "auth",
        bucketId: "coding",
        windowId: "primary",
        maxObservationAgeSeconds: 120,
      });
    }
  }
  const reserved = await store.reserve({
    policy,
    observation,
    scheduleId: "schedule",
    occurrenceId: "occurrence",
    providerId: "account-alias",
  });
  if (reserved.kind !== "admitted") throw new Error("Fixture admission failed");
  const reservationId = reserved.reservation.id;
  await store.transition({
    account: policy.account,
    reservationId,
    expectedGeneration: 0,
    event: { type: "start", executionId: "execution", authenticationGeneration: "auth" },
    observation,
  });
  await store.transition({
    account: policy.account,
    reservationId,
    expectedGeneration: 1,
    event: { type: "started", executionId: "execution" },
  });
  const receipt = {
    executionId: "execution",
    authenticationGeneration: "auth",
    settlementId: "settled",
  };
  const readObservation = vi.fn(async () => observation);
  const freezeAndSettle = vi.fn(async () => receipt);
  const options = {
    store,
    account: policy.account,
    reservationId,
    executionId: "execution",
    authenticationGeneration: "auth",
    readObservation,
    freezeAndSettle,
    assertAuthority: vi.fn(),
    onFailure: vi.fn(),
    nowMs: () => now,
  };
  const supervisor = await QuotaExecutionSupervisor.attach(options);
  active.push(supervisor);
  return {
    store,
    supervisor,
    options,
    sample,
    receipt,
    execution: () => store.execution(policy.account, reservationId),
    observe(usedPercent: number) {
      now += 1;
      observation = sample(usedPercent);
      return observation;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

it("prepaid expiry invalidates dispatch before the normal one-second permit deadline", async () => {
  const f = await fixture(false, 500);
  const permit = await f.supervisor.guard({
    observation: f.sample(),
    operation: "start",
    threadId: null,
    nativeTurnId: null,
  });
  permit.assertValidForDispatch();
  f.advance(500);
  expect(() => permit.assertValidForDispatch()).toThrow("expired");
  await f.supervisor.checkNow();
  expect(await f.execution()).toMatchObject({ state: "frozen" });
  expect(f.options.freezeAndSettle).toHaveBeenCalledTimes(1);
});

it("prepaid expiry freezes despite a stalled poll and never overrides manual pause", async () => {
  const f = await fixture(false, 500);
  vi.useFakeTimers();
  const entered = deferred<void>();
  const read = deferred<QuotaObservation>();
  f.options.readObservation.mockImplementation(async () => {
    entered.resolve();
    return read.promise;
  });
  const poll = f.supervisor.checkNow();
  await entered.promise;
  f.advance(500);
  await vi.advanceTimersByTimeAsync(500);
  await vi.waitFor(() => expect(f.options.freezeAndSettle).toHaveBeenCalledTimes(1));
  await f.supervisor.freeze("manual");
  expect(await f.execution()).toMatchObject({ state: "frozen", pauseReason: "manual" });
  read.resolve(f.sample());
  await poll;
  await expect(
    f.supervisor.guard({
      observation: f.sample(),
      operation: "start",
      threadId: null,
      nativeTurnId: null,
    }),
  ).rejects.toThrow("revoked");
  expect(f.options.freezeAndSettle).toHaveBeenCalledTimes(1);
});

it("completion drains pending telemetry before settlement and revokes existing permits", async () => {
  const f = await fixture();
  const permit = await f.supervisor.guard({
    observation: f.sample(),
    operation: "start",
    threadId: null,
    nativeTurnId: null,
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  f.options.readObservation.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("Pending transport read failed");
  });
  const poll = f.supervisor.checkNow();
  await entered.promise;
  const completion = f.supervisor.complete();
  expect(() => permit.assertValidForDispatch()).toThrow("revoked");
  expect(f.options.freezeAndSettle).not.toHaveBeenCalled();
  release.resolve();
  await poll;
  expect(await completion).toMatchObject({ state: "completed", settlementId: "settled" });
  expect(f.options.freezeAndSettle).toHaveBeenCalledTimes(1);
  expect(f.options.onFailure).not.toHaveBeenCalled();
  expect(await f.execution()).toMatchObject({ state: "completed" });
});

it.each(["manual", "quota"] as const)(
  "%s freeze wins while completion waits for settlement",
  async (reason) => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<QuotaExecutionSettlement>();
    f.options.freezeAndSettle.mockImplementation(async () => {
      entered.resolve();
      return release.promise;
    });
    const completion = f.supervisor.complete();
    const rejected = expect(completion).rejects.toThrow("cancelled");
    await entered.promise;
    const frozen = f.supervisor.freeze(reason);
    release.resolve(f.receipt);
    await rejected;
    expect(await frozen).toMatchObject({
      state: "frozen",
      settlementId: "settled",
      pauseReason: reason,
    });
    expect(f.options.freezeAndSettle).toHaveBeenCalledTimes(1);
  },
);

it("completion rejects mismatched settlement without recording success", async () => {
  const f = await fixture();
  f.options.freezeAndSettle.mockResolvedValue({ ...f.receipt, executionId: "other" });
  await expect(f.supervisor.complete()).rejects.toThrow("identity mismatch");
  expect(await f.execution()).toMatchObject({ state: "running" });
});

it("persists a freeze and preserves ownership until exact settlement arrives", async () => {
  const f = await fixture();
  const entered = deferred<void>();
  const settlement = deferred<QuotaExecutionSettlement>();
  f.options.freezeAndSettle.mockImplementation(async () => {
    entered.resolve();
    return settlement.promise;
  });
  f.observe(76);
  const check = f.supervisor.checkNow();
  await entered.promise;
  settlement.resolve(f.receipt);
  await check;
  expect(await f.execution()).toMatchObject({
    state: "frozen",
    settlementId: "settled",
    pauseReason: "quota",
  });
  expect(f.options.freezeAndSettle).toHaveBeenCalledExactlyOnceWith("execution");
});

it("monitors the persisted hourly estimate outside the native turn and freezes at ten points", async () => {
  const f = await fixture(true);
  f.observe(29);
  await f.supervisor.checkNow();
  expect(f.options.freezeAndSettle).not.toHaveBeenCalled();
  f.observe(30);
  await f.supervisor.checkNow();
  expect(f.options.freezeAndSettle).toHaveBeenCalledExactlyOnceWith("execution");
  expect(await f.execution()).toMatchObject({ state: "frozen", settlementId: "settled" });
});

it("rejects a mismatched settlement and retains the freezing state", async () => {
  const f = await fixture();
  f.options.freezeAndSettle.mockResolvedValue({ ...f.receipt, executionId: "other" });
  await expect(f.supervisor.freeze("quota")).rejects.toThrow("settlement identity mismatch");
  expect(await f.execution()).toMatchObject({ state: "freezing", settlementId: null });
});

it("reconciles failed settlement once through retained custody without restarting work", async () => {
  const f = await fixture();
  f.options.freezeAndSettle.mockRejectedValueOnce(new Error("Custody proof unavailable"));
  await expect(f.supervisor.freeze("manual")).rejects.toThrow("Custody proof unavailable");
  expect(await f.execution()).toMatchObject({ state: "freezing", pauseReason: "manual" });
  const first = f.supervisor.reconcileFreeze();
  expect(f.supervisor.reconcileFreeze()).toBe(first);
  expect(await first).toMatchObject({
    state: "frozen",
    executionId: "execution",
    pauseReason: "manual",
  });
  await f.supervisor.reconcileFreeze();
  expect(f.options.freezeAndSettle).toHaveBeenCalledTimes(2);
  expect(await f.execution()).toMatchObject({
    executionId: "execution",
    authenticationGeneration: "auth",
  });
});

it("reconciliation waits for a live stop request instead of issuing a second one", async () => {
  const f = await fixture();
  const entered = deferred<void>();
  const receipt = deferred<QuotaExecutionSettlement>();
  f.options.freezeAndSettle.mockImplementation(async () => {
    entered.resolve();
    return receipt.promise;
  });
  const freeze = f.supervisor.freeze("quota");
  await entered.promise;
  const reconcile = f.supervisor.reconcileFreeze();
  expect(f.options.freezeAndSettle).toHaveBeenCalledTimes(1);
  receipt.resolve(f.receipt);
  await Promise.all([freeze, reconcile]);
  expect(f.options.freezeAndSettle).toHaveBeenCalledTimes(1);
  expect(await f.execution()).toMatchObject({ state: "frozen" });
});

it("reconciliation returns the current manual pause after a successful quota freeze", async () => {
  const f = await fixture();
  await f.supervisor.freeze("quota");
  await f.supervisor.freeze("manual");
  expect(await f.supervisor.reconcileFreeze()).toMatchObject({
    state: "frozen",
    pauseReason: "manual",
  });
  expect(f.options.freezeAndSettle).toHaveBeenCalledTimes(1);
});

it("keeps manual pause sticky when it arrives during quota settlement", async () => {
  const f = await fixture();
  const entered = deferred<void>();
  const settlement = deferred<QuotaExecutionSettlement>();
  f.options.freezeAndSettle.mockImplementation(async () => {
    entered.resolve();
    return settlement.promise;
  });
  const freezing = f.supervisor.freeze("quota");
  await entered.promise;
  const manual = f.supervisor.freeze("manual");
  settlement.resolve(f.receipt);
  await Promise.all([freezing, manual]);
  expect(await f.execution()).toMatchObject({ state: "frozen", pauseReason: "manual" });
  expect(f.options.freezeAndSettle).toHaveBeenCalledTimes(1);
});

it("a newer healthy monitor sample preserves a permit without extending its deadline", async () => {
  const f = await fixture();
  const permit = await f.supervisor.guard({
    observation: f.sample(),
    operation: "start",
    threadId: null,
    nativeTurnId: null,
  });
  f.observe(21);
  await f.supervisor.checkNow();
  expect(() => permit.assertValidForDispatch()).not.toThrow();
  f.advance(999);
  expect(() => permit.assertValidForDispatch()).toThrow("expired");
});

it.each([70, 72])(
  "revokes an existing permit when newer usage reaches %s percent",
  async (usedPercent) => {
    const f = await fixture();
    const old = f.sample();
    const permit = await f.supervisor.guard({
      observation: old,
      operation: "start",
      threadId: "thread",
      nativeTurnId: null,
    });
    permit.assertValidForDispatch();
    f.observe(usedPercent);
    await f.supervisor.checkNow();
    expect(() => permit.assertValidForDispatch()).toThrow("revoked");
    await expect(
      f.supervisor.guard({
        observation: old,
        operation: "steer",
        threadId: "thread",
        nativeTurnId: "turn",
      }),
    ).rejects.toThrow("regressed");
    expect(f.options.freezeAndSettle).not.toHaveBeenCalled();
  },
);

it("missing admission telemetry freezes active work without awaiting its own native start", async () => {
  const f = await fixture();
  const settlement = deferred<QuotaExecutionSettlement>();
  f.options.freezeAndSettle.mockImplementation(async () => settlement.promise);
  await expect(
    f.supervisor.guard({
      observation: { status: "unavailable", reason: "read_failed" },
      operation: "steer",
      threadId: "thread",
      nativeTurnId: "turn",
    }),
  ).rejects.toThrow("requires freeze");
  settlement.resolve(f.receipt);
  await f.supervisor.freeze("quota");
  expect(await f.execution()).toMatchObject({ state: "frozen" });
});

it("a telemetry deadline freezes independently of a stalled poll and ignores its late result", async () => {
  const f = await fixture();
  f.advance(119_000);
  vi.useFakeTimers();
  const entered = deferred<void>();
  const observation = deferred<QuotaObservation>();
  f.options.readObservation.mockImplementation(async () => {
    entered.resolve();
    return observation.promise;
  });
  const check = f.supervisor.checkNow();
  await entered.promise;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.options.freezeAndSettle).toHaveBeenCalledExactlyOnceWith("execution");
  observation.resolve(f.sample());
  await check;
  await f.supervisor.freeze("quota");
  expect(await f.execution()).toMatchObject({ state: "frozen" });
});

it("prevents duplicate supervision and retires verified completion without another interruption", async () => {
  const f = await fixture();
  await expect(QuotaExecutionSupervisor.attach(f.options)).rejects.toThrow(
    "already has a supervisor",
  );
  const current = await f.execution();
  await f.store.transition({
    account: f.options.account,
    reservationId: f.options.reservationId,
    expectedGeneration: current.generation,
    event: { type: "complete", executionId: "execution", settlementId: "completed" },
  });
  await f.supervisor.checkNow();
  expect(f.options.freezeAndSettle).not.toHaveBeenCalled();
  expect(f.options.onFailure).not.toHaveBeenCalled();
  active.splice(active.indexOf(f.supervisor), 1);
});

it("expiry requests the captured stop even while ledger reads are stalled", async () => {
  const f = await fixture();
  const before = await f.execution();
  const ledger = deferred<typeof before>();
  const entered = deferred<void>();
  const read = vi.spyOn(f.store, "execution").mockImplementation(async () => {
    entered.resolve();
    return ledger.promise;
  });
  f.advance(119_000);
  vi.useFakeTimers();
  const checking = f.supervisor.checkNow();
  await entered.promise;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.options.freezeAndSettle).toHaveBeenCalledExactlyOnceWith("execution");
  read.mockRestore();
  ledger.resolve(before);
  await checking;
  await f.supervisor.freeze("quota");
  expect(await f.execution()).toMatchObject({ state: "frozen" });
});

it("a permit expires even when its quota snapshot remains healthy", async () => {
  const f = await fixture();
  const permit = await f.supervisor.guard({
    observation: f.sample(),
    operation: "start",
    threadId: "thread",
    nativeTurnId: null,
  });
  f.advance(1_000);
  expect(() => permit.assertValidForDispatch()).toThrow("expired");
});

it.each(["monitor", "admission"] as const)(
  "conflicting same-timestamp evidence revokes permits through %s",
  async (source) => {
    const f = await fixture();
    const permit = await f.supervisor.guard({
      observation: f.sample(),
      operation: "start",
      threadId: "thread",
      nativeTurnId: null,
    });
    const conflict = f.sample(80);
    if (source === "monitor") {
      f.options.readObservation.mockResolvedValue(conflict);
      await f.supervisor.checkNow();
    } else {
      await expect(
        f.supervisor.guard({
          observation: conflict,
          operation: "steer",
          threadId: "thread",
          nativeTurnId: "turn",
        }),
      ).rejects.toThrow("conflicts");
    }
    expect(() => permit.assertValidForDispatch()).toThrow("revoked");
    await f.supervisor.freeze("quota");
    expect(f.options.freezeAndSettle).toHaveBeenCalledExactlyOnceWith("execution");
  },
);
