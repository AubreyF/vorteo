import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { QuotaGovernorPolicy, QuotaObservation } from "@getpaseo/protocol/quota-governor";
import { QuotaGovernorStore } from "./governor-store.js";
import { createFactoryPrepaidPolicyApplication } from "../../factory/apply-prepaid-policy.js";
import {
  createAccountingContract,
  satisfiesAccountingContract,
} from "./governor-accounting-contract.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const nowMs = Date.parse("2026-09-14T12:00:00Z");
let clockNow = nowMs;
beforeEach(() => {
  clockNow = nowMs;
});
const clock = { nowMs: () => clockNow };

const policy: QuotaGovernorPolicy = {
  version: 1,
  account: { issuer: "test", accountId: "account" },
  requiredWindows: [{ bucketId: "coding", windowId: "weekly", durationMinutes: 10080 }],
  launchFloorPercent: 30,
  freezeFloorPercent: 25,
  maxObservationAgeSeconds: 120,
  consumptionLimits: [
    {
      meterId: "gross",
      bucketId: "coding",
      revision: "original",
      unit: "weekly_quota_points",
      period: { kind: "calendar_day", timezone: "UTC" },
      throttleAt: 25,
      holdAt: 30,
      freezeAt: 35,
    },
  ],
  recovery: "automatic_after_reconciliation",
};
const observation: QuotaObservation = {
  status: "available",
  account: policy.account,
  observedAt: new Date(nowMs).toISOString(),
  windows: [
    { ...policy.requiredWindows[0]!, usedPercent: 10, resetsAt: null, semantics: "unknown" },
  ],
  consumptionMeters: [
    {
      meterId: "gross",
      bucketId: "coding",
      revision: "original",
      unit: "weekly_quota_points",
      quality: "authoritative",
      coverageStart: "2026-09-12T00:00:00Z",
      coverageEnd: new Date(nowMs).toISOString(),
      intervals: [],
    },
  ],
};
const input = {
  policy,
  observation,
  nowMs,
  scheduleId: "first",
  occurrenceId: "first",
  providerId: "alias",
};
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "account-contract-"));
  dirs.push(dir);
  return { dir, store: new QuotaGovernorStore(dir, clock) };
}

const prepaidAuthorization = {
  bucketId: "coding",
  windowId: "weekly",
  startsAt: "2026-09-14T00:00:00Z",
  expiresAt: "2026-09-15T00:00:00Z",
};
const applicationOperationId = "10391555-2afc-4b91-aaed-6927e67fc350";

it("applies an owner prepaid grant through the existing store without changing parent limits", async () => {
  const { store } = await setup();
  const initial = await store.configureAccountPolicy({
    policy,
    expectedRevision: null,
    readObservation: async () => observation,
  });
  if (initial.kind !== "configured") throw Error("Expected parent configuration");
  let reads = 0;
  const apply = createFactoryPrepaidPolicyApplication({
    store,
    policy,
    authorization: prepaidAuthorization,
    assertCurrent() {},
    async assertReconciled() {},
    nowMs: clock.nowMs,
    async readObservation() {
      reads++;
      return observation;
    },
  });
  const result = await apply({
    operationId: applicationOperationId,
    expectedRevision: initial.contract.revision,
  });
  expect(result.kind).toBe("applied");
  expect(result.operationId).toBe(applicationOperationId);
  expect((await store.accountingContract(policy.account))?.envelope).toEqual({
    ...policy,
    prepaidAuthorization,
  });
  expect(reads).toBe(1);
});

async function setupPrepaidApplication() {
  const { store } = await setup();
  const initial = await store.configureAccountPolicy({
    policy,
    expectedRevision: null,
    readObservation: async () => observation,
  });
  if (initial.kind !== "configured") throw Error("Expected parent configuration");
  let reads = 0;
  const applicationInput = {
    store,
    policy: structuredClone(policy),
    authorization: structuredClone(prepaidAuthorization),
    assertCurrent() {},
    async assertReconciled() {},
    nowMs: clock.nowMs,
    async readObservation() {
      reads++;
      return observation;
    },
  };
  const request = {
    operationId: applicationOperationId,
    expectedRevision: initial.contract.revision,
  };
  return { store, initial: initial.contract, applicationInput, request, reads: () => reads };
}

it("refuses a stale parent revision or unreconciled custody before reading account telemetry", async () => {
  const fixture = await setupPrepaidApplication();
  const apply = createFactoryPrepaidPolicyApplication(fixture.applicationInput);
  await expect(apply({ ...fixture.request, expectedRevision: "stale" })).rejects.toMatchObject({
    state: "refused",
  });
  expect(fixture.reads()).toBe(0);
  fixture.applicationInput.assertReconciled = async () => {
    throw Error("Custody held");
  };
  const held = createFactoryPrepaidPolicyApplication(fixture.applicationInput);
  await expect(held(fixture.request)).rejects.toMatchObject({
    state: "refused",
    cause: { message: "Custody held" },
  });
  expect(await fixture.store.accountingContract(policy.account)).toEqual(fixture.initial);
});

it("preserves a different parent envelope instead of replacing its consumption thresholds", async () => {
  const fixture = await setupPrepaidApplication();
  const changed = structuredClone(policy);
  changed.consumptionLimits[0]!.holdAt = 29;
  const parent = await fixture.store.configureAccountPolicy({
    policy: changed,
    expectedRevision: fixture.initial.revision,
    readObservation: async () => observation,
  });
  if (parent.kind !== "configured") throw Error("Expected changed parent");
  const apply = createFactoryPrepaidPolicyApplication(fixture.applicationInput);
  await expect(
    apply({ ...fixture.request, expectedRevision: parent.contract.revision }),
  ).rejects.toMatchObject({ state: "refused" });
  expect((await fixture.store.accountingContract(policy.account))?.envelope).toEqual(changed);
  expect(fixture.reads()).toBe(0);
});

it("refuses owner loss during reconciliation before native policy dispatch", async () => {
  const fixture = await setupPrepaidApplication();
  let owned = true;
  fixture.applicationInput.assertCurrent = () => {
    if (!owned) throw Error("Owner lost");
  };
  fixture.applicationInput.assertReconciled = async () => {
    owned = false;
  };
  const apply = createFactoryPrepaidPolicyApplication(fixture.applicationInput);
  await expect(apply(fixture.request)).rejects.toMatchObject({
    state: "refused",
    cause: { message: "Owner lost" },
  });
  expect(await fixture.store.accountingContract(policy.account)).toEqual(fixture.initial);
  expect(fixture.reads()).toBe(0);
});

it("keeps the original operation and revision when the caller changes its request during reconciliation", async () => {
  const fixture = await setupPrepaidApplication();
  fixture.applicationInput.assertReconciled = async () => {
    fixture.request.operationId = "88a2e0d8-224d-478b-b9a5-5dfc7aefb32e";
    fixture.request.expectedRevision = "not-the-dispatched-revision";
  };
  const apply = createFactoryPrepaidPolicyApplication(fixture.applicationInput);
  expect(await apply(fixture.request)).toMatchObject({
    kind: "applied",
    operationId: applicationOperationId,
  });
  expect(fixture.reads()).toBe(1);
});

it("holds an account with a live native reservation without changing the parent policy", async () => {
  const fixture = await setupPrepaidApplication();
  expect((await fixture.store.reserve(input)).kind).toBe("admitted");
  const apply = createFactoryPrepaidPolicyApplication(fixture.applicationInput);
  expect(await apply(fixture.request)).toEqual({
    kind: "held",
    operationId: applicationOperationId,
    reason: "account_busy",
  });
  expect(await fixture.store.accountingContract(policy.account)).toEqual(fixture.initial);
  expect(fixture.reads()).toBe(0);
});

it("refuses callback replacement before native persistence and holds the original dispatched operation", async () => {
  const fixture = await setupPrepaidApplication();
  fixture.applicationInput.readObservation = async () => {
    fixture.applicationInput.readObservation = async () => observation;
    return observation;
  };
  const apply = createFactoryPrepaidPolicyApplication(fixture.applicationInput);
  await expect(apply(fixture.request)).rejects.toMatchObject({
    state: "uncertain",
    operationId: applicationOperationId,
  });
  await expect(
    apply({ ...fixture.request, operationId: "88a2e0d8-224d-478b-b9a5-5dfc7aefb32e" }),
  ).rejects.toMatchObject({ state: "uncertain", operationId: applicationOperationId });
  expect(await fixture.store.accountingContract(policy.account)).toEqual(fixture.initial);
});

it("expires the original grant during observation without writing or refreshing its deadline", async () => {
  const fixture = await setupPrepaidApplication();
  fixture.applicationInput.readObservation = async () => {
    clockNow = Date.parse(prepaidAuthorization.expiresAt);
    return observation;
  };
  const apply = createFactoryPrepaidPolicyApplication(fixture.applicationInput);
  await expect(apply(fixture.request)).rejects.toMatchObject({
    state: "uncertain",
    cause: { message: "Factory prepaid owner authorization is inactive." },
  });
  expect(await fixture.store.accountingContract(policy.account)).toEqual(fixture.initial);
});

it("retains typed uncertainty and the committed native parent policy after owner loss", async () => {
  const fixture = await setupPrepaidApplication();
  let owned = true;
  const applicationInput = {
    ...fixture.applicationInput,
    store: {
      accountingContract: fixture.store.accountingContract.bind(fixture.store),
      async configureAccountPolicy(
        request: Parameters<QuotaGovernorStore["configureAccountPolicy"]>[0],
      ) {
        const result = await fixture.store.configureAccountPolicy(request);
        owned = false;
        return result;
      },
    },
    assertCurrent() {
      if (!owned) throw Error("Owner lost");
    },
  };
  const apply = createFactoryPrepaidPolicyApplication(applicationInput);
  await expect(apply(fixture.request)).rejects.toMatchObject({
    state: "uncertain",
    operationId: applicationOperationId,
    cause: { message: "Owner lost" },
  });
  expect((await fixture.store.accountingContract(policy.account))?.envelope).toEqual({
    ...policy,
    prepaidAuthorization,
  });
  await expect(
    apply({ ...fixture.request, operationId: "88a2e0d8-224d-478b-b9a5-5dfc7aefb32e" }),
  ).rejects.toMatchObject({ state: "uncertain", operationId: applicationOperationId });
});

it("refuses a concurrent application instead of queueing a second parent write", async () => {
  const fixture = await setupPrepaidApplication();
  let reconcile!: () => void;
  fixture.applicationInput.assertReconciled = () =>
    new Promise<void>((resolve) => {
      reconcile = resolve;
    });
  const apply = createFactoryPrepaidPolicyApplication(fixture.applicationInput);
  const first = apply(fixture.request);
  await expect(
    apply({ ...fixture.request, operationId: "88a2e0d8-224d-478b-b9a5-5dfc7aefb32e" }),
  ).rejects.toMatchObject({ state: "refused" });
  reconcile();
  expect(await first).toMatchObject({ kind: "applied", operationId: applicationOperationId });
  expect(fixture.reads()).toBe(1);
});

it("canonicalizes timezone aliases while preserving meter definition and account identity", () => {
  const contract = createAccountingContract(policy);
  const changed = structuredClone(policy);
  changed.consumptionLimits[0]!.period = { kind: "calendar_day", timezone: "Etc/UTC" };
  changed.consumptionLimits[0]!.holdAt = 29;
  expect(satisfiesAccountingContract(contract, changed)).toBe(true);
  changed.consumptionLimits[0]!.revision = "new-denominator";
  expect(satisfiesAccountingContract(contract, changed)).toBe(false);
  expect(satisfiesAccountingContract(contract, { ...policy, consumptionLimits: [] })).toBe(false);
  expect(
    satisfiesAccountingContract(contract, {
      ...policy,
      account: { ...policy.account, accountId: "other" },
    }),
  ).toBe(false);
});

it("requires explicit initial configuration and compare-and-swap without granting missing usage", async () => {
  const { store } = await setup();
  expect(await store.reserve(input)).toEqual({
    kind: "deferred",
    reason: "accounting_contract_missing",
  });
  const configured = await store.configureAccountingContract({ policy, expectedRevision: null });
  expect(configured.kind).toBe("configured");
  await expect(
    store.configureAccountingContract({ policy, expectedRevision: null }),
  ).rejects.toThrow("contract changed");
  const contract = await store.accountingContract(policy.account);
  expect(contract).not.toBeNull();
  const changed = structuredClone(policy);
  changed.consumptionLimits[0]!.holdAt = 29;
  expect(
    await store.configureAccountingContract({
      policy: changed,
      expectedRevision: contract!.revision,
    }),
  ).toEqual({ kind: "configured", contract });
  expect(
    await store.reserve({ ...input, observation: { ...observation, consumptionMeters: [] } }),
  ).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { reasons: [{ code: "meter_unavailable" }] },
  });
});

it("retains the account contract across completion, alias changes and restart", async () => {
  const { store, dir } = await setup();
  await store.configureAccountingContract({ policy, expectedRevision: null });
  const admitted = await store.reserve(input);
  if (admitted.kind !== "admitted") throw Error("Expected admission");
  const binding = {
    account: policy.account,
    reservationId: admitted.reservation.id,
    nowMs,
    observation,
  };
  await store.transition({
    ...binding,
    expectedGeneration: 0,
    event: { type: "start", executionId: "execution", authenticationGeneration: "auth" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 1,
    event: { type: "complete", executionId: "execution", settlementId: "exit" },
  });
  clockNow = nowMs + 1;
  const at = new Date(nowMs + 1).toISOString();
  const meters = structuredClone(observation.consumptionMeters);
  for (const meter of meters) meter.coverageEnd = at;
  const settled = {
    ...observation,
    observedAt: at,
    consumptionMeters: meters,
    settledExecutions: [
      { executionId: "execution", authenticationGeneration: "auth", accountedAt: at },
    ],
  };
  expect(await store.finalize({ ...binding, observation: settled })).toEqual({
    kind: "finalized",
  });
  const reopened = new QuotaGovernorStore(dir, clock);
  const next = {
    ...input,
    observation: settled,

    scheduleId: "other",
    occurrenceId: "other",
    providerId: "other-alias",
  };
  const changed = structuredClone(policy);
  changed.consumptionLimits[0]!.period = { kind: "calendar_day", timezone: "America/Los_Angeles" };
  expect(await reopened.reserve({ ...next, policy: changed })).toEqual({
    kind: "deferred",
    reason: "accounting_migration_required",
  });
  const contract = await reopened.accountingContract(policy.account);
  expect(
    await reopened.configureAccountingContract({
      policy: changed,
      expectedRevision: contract!.revision,
    }),
  ).toEqual({ kind: "deferred", reason: "accounting_migration_required" });
  expect((await reopened.reserve(next)).kind).toBe("admitted");
});

it("fails closed on corrupt saved contract rather than bootstrapping fresh semantics", async () => {
  const { store } = await setup();
  await writeFile(`${store.accountPath(policy.account)}.contract`, "null");
  await expect(store.reserve(input)).rejects.toThrow();
});

it.each([false, true])(
  "does not bootstrap strict configuration from floor-only history (legacy=%s)",
  async (legacy) => {
    const { store, dir } = await setup();
    const admitted = await store.reserve({
      ...input,
      policy: { ...policy, consumptionLimits: [] },
    });
    if (admitted.kind !== "admitted") throw Error("Expected floor admission");
    const binding = {
      account: policy.account,
      reservationId: admitted.reservation.id,
      nowMs,
      observation,
    };
    await store.transition({
      ...binding,
      expectedGeneration: 0,
      event: { type: "start", executionId: "execution", authenticationGeneration: "auth" },
    });
    await store.transition({
      ...binding,
      expectedGeneration: 1,
      event: { type: "complete", executionId: "execution", settlementId: "exit" },
    });
    clockNow = nowMs + 1;
    const at = new Date(nowMs + 1).toISOString();
    const settled = structuredClone(observation);
    settled.observedAt = at;
    for (const meter of settled.consumptionMeters) meter.coverageEnd = at;
    settled.settledExecutions = [
      { executionId: "execution", authenticationGeneration: "auth", accountedAt: at },
    ];
    expect(await store.finalize({ ...binding, observation: settled })).toEqual({
      kind: "finalized",
    });
    if (legacy) {
      const path = store.accountPath(policy.account);
      const old = JSON.parse(await readFile(path, "utf8"));
      delete old.accountingContractRevision;
      await writeFile(path, JSON.stringify(old));
    }
    const reopened = new QuotaGovernorStore(dir, clock);
    expect(
      await reopened.reserve({
        ...input,
        observation: settled,

        occurrenceId: "strict",
      }),
    ).toEqual({ kind: "deferred", reason: "accounting_contract_missing" });
    expect(await reopened.configureAccountingContract({ policy, expectedRevision: null })).toEqual({
      kind: "deferred",
      reason: "accounting_migration_required",
    });
  },
);

it("imports actual legacy strict semantics and records migration provenance", async () => {
  const { store } = await setup();
  await store.configureAccountingContract({ policy, expectedRevision: null });
  await store.reserve(input);
  const path = store.accountPath(policy.account);
  const old = JSON.parse(await readFile(path, "utf8"));
  delete old.accountingContractRevision;
  await writeFile(path, JSON.stringify(old));
  await rm(`${path}.contract`);
  await rm(`${path}.contract-required`);
  const legacy = await store.accountingContract(policy.account);
  expect(legacy?.revision).toMatch(/^legacy:/);
  expect(satisfiesAccountingContract(legacy!, policy)).toBe(true);
  expect((await store.reserve(input)).kind).toBe("admitted");
  await rm(`${path}.contract`);
  await expect(store.accountingContract(policy.account)).rejects.toThrow("contract is missing");
});

it("does not recreate a missing configured contract even before first admission", async () => {
  const { store } = await setup();
  await store.configureAccountingContract({ policy, expectedRevision: null });
  await rm(`${store.accountPath(policy.account)}.contract`);
  await expect(store.reserve(input)).rejects.toThrow("contract is missing");
  await expect(
    store.configureAccountingContract({ policy, expectedRevision: null }),
  ).rejects.toThrow("contract is missing");
});

it("enforces account floors and consumption obligations across aliases after restart", async () => {
  const { dir } = await setup();
  const store = new QuotaGovernorStore(dir, { nowMs: () => nowMs });
  const configured = await store.configureAccountPolicy({
    policy,
    expectedRevision: null,
    readObservation: async () => observation,
  });
  expect(configured.kind).toBe("configured");
  const reopened = new QuotaGovernorStore(dir, { nowMs: () => nowMs });
  const weak = { ...policy, launchFloorPercent: 5, freezeFloorPercent: 0, consumptionLimits: [] };
  const low = structuredClone(observation);
  low.windows[0]!.usedPercent = 75;
  expect(
    await reopened.reserve({ ...input, policy: weak, observation: low, providerId: "other-alias" }),
  ).toMatchObject({ kind: "deferred", reason: "quota", decision: { action: "freeze" } });
  expect(
    await reopened.reserve({
      ...input,
      policy: weak,
      observation: { ...observation, consumptionMeters: [] },
    }),
  ).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { reasons: [{ code: "meter_unavailable" }] },
  });
  const admitted = await reopened.reserve({ ...input, policy: weak, providerId: "other-alias" });
  if (admitted.kind !== "admitted") throw new Error("Expected governed admission");
  expect(admitted.reservation.policy).toEqual(policy);
  expect((await reopened.executionContext(policy.account, admitted.reservation.id)).policy).toEqual(
    policy,
  );
  const contract = await reopened.accountingContract(policy.account);
  expect(
    await reopened.configureAccountPolicy({
      policy: weak,
      expectedRevision: contract!.revision,
      readObservation: async () => observation,
    }),
  ).toEqual({ kind: "deferred", reason: "account_busy" });
});

it("binds management changes to fresh observed identity and rotates configuration revisions", async () => {
  const { dir } = await setup();
  const store = new QuotaGovernorStore(dir, { nowMs: () => nowMs });
  const configure = (seen: QuotaObservation) =>
    store.configureAccountPolicy({
      policy,
      expectedRevision: null,
      readObservation: async () => seen,
    });
  await expect(
    configure({ ...observation, account: { ...policy.account, accountId: "wrong" } }),
  ).rejects.toThrow("authenticated account");
  await expect(
    configure({ ...observation, observedAt: new Date(nowMs - 120_001).toISOString() }),
  ).rejects.toThrow("authenticated account");
  expect(await store.accountingContract(policy.account)).toBeNull();
  const first = await configure({ ...observation, consumptionMeters: [] });
  if (first.kind !== "configured") throw new Error("Expected configuration");
  const next = await store.configureAccountPolicy({
    policy: { ...policy, launchFloorPercent: 40 },
    expectedRevision: first.contract.revision,
    readObservation: async () => observation,
  });
  if (next.kind !== "configured") throw new Error("Expected configuration update");
  expect(next.contract.revision).not.toBe(first.contract.revision);
  await expect(
    store.configureAccountPolicy({
      policy,
      expectedRevision: first.contract.revision,
      readObservation: async () => observation,
    }),
  ).rejects.toThrow("contract changed");
});

it("rejects child prepaid authority until the trusted account envelope carries it", async () => {
  const { store } = await setup();
  const prepaidPolicy = {
    ...policy,
    prepaidAuthorization: {
      bucketId: "coding",
      windowId: "weekly",
      startsAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 3_600_000).toISOString(),
    },
  };
  const spent = { ...observation, windows: [{ ...observation.windows[0]!, usedPercent: 100 }] };
  const request = { ...input, policy: prepaidPolicy, observation: spent };
  expect(await store.reserve(request)).toEqual({
    kind: "deferred",
    reason: "accounting_migration_required",
  });
  const ordinary = await store.configureAccountPolicy({
    policy,
    expectedRevision: null,
    readObservation: async () => spent,
  });
  if (ordinary.kind !== "configured") throw new Error("Expected account configuration");
  expect(await store.reserve(request)).toEqual({
    kind: "deferred",
    reason: "accounting_migration_required",
  });
  const configured = await store.configureAccountPolicy({
    policy: prepaidPolicy,
    expectedRevision: ordinary.contract.revision,
    readObservation: async () => spent,
  });
  if (configured.kind !== "configured") throw new Error("Expected prepaid configuration");
  expect(await store.reserve({ ...request, policy })).toMatchObject({
    kind: "deferred",
    reason: "quota",
  });
  const reserved = await store.reserve(request);
  if (reserved.kind !== "admitted") throw new Error("Expected prepaid admission");
  expect(reserved.reservation.policy.prepaidAuthorization).toEqual(
    prepaidPolicy.prepaidAuthorization,
  );
  expect(
    await store.reserve({ ...request, occurrenceId: "second", scheduleId: "second" }),
  ).toMatchObject({
    kind: "deferred",
    reason: "account_busy",
  });
  const binding = { account: policy.account, reservationId: reserved.reservation.id };
  await store.transition({
    ...binding,
    expectedGeneration: 0,
    observation: spent,
    event: { type: "start", executionId: "execution", authenticationGeneration: "auth" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 1,
    event: { type: "started", executionId: "execution" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 2,
    event: { type: "complete", executionId: "execution", settlementId: "settled" },
  });
  clockNow = nowMs + 3_600_001;
  const observedAt = new Date(clockNow).toISOString();
  const consumptionMeters = structuredClone(spent.consumptionMeters);
  for (const meter of consumptionMeters) meter.coverageEnd = observedAt;
  const settled: QuotaObservation = {
    ...spent,
    observedAt,
    consumptionMeters,
    settledExecutions: [
      { executionId: "execution", authenticationGeneration: "auth", accountedAt: observedAt },
    ],
  };
  expect(
    await store.finalize({ ...binding, observation: { ...settled, consumptionMeters: [] } }),
  ).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: {
      reasons: [
        { code: "prepaid_authorization_inactive" },
        { code: "meter_unavailable", meterId: "gross" },
      ],
    },
  });
  expect(
    await store.finalize({ ...binding, observation: { ...settled, settledExecutions: undefined } }),
  ).toEqual({ kind: "deferred", reason: "charge_settlement_unavailable" });
  expect(await store.finalize({ ...binding, observation: settled })).toEqual({ kind: "finalized" });
  expect(
    await store.reserve({ ...request, occurrenceId: "after-expiry", observation: settled }),
  ).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { reasons: [{ code: "prepaid_authorization_inactive" }] },
  });
});
