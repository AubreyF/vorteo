import { expect, it } from "vitest";
import type { QuotaGovernorPolicy } from "@getpaseo/protocol/quota-governor";
import { combineQuotaPolicies } from "./governor-policy.js";

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
      revision: "v1",
      unit: "weekly_quota_points",
      period: { kind: "calendar_day", timezone: "UTC" },
      throttleAt: 25,
      holdAt: 30,
      freezeAt: 35,
    },
  ],
  recovery: "automatic_after_reconciliation",
};

it("combines account, group and schedule restrictions without counting the same consumption twice", () => {
  const group = structuredClone(policy);
  group.launchFloorPercent = 40;
  group.consumptionLimits[0]!.holdAt = 28;
  group.consumptionLimits[0]!.period = { kind: "calendar_day", timezone: "Etc/UTC" };
  const schedule = structuredClone(policy);
  schedule.maxObservationAgeSeconds = 60;
  schedule.consumptionLimits[0]!.freezeAt = 32;
  schedule.requiredWindows.push({ bucketId: "coding", windowId: "short", durationMinutes: 300 });
  const combined = combineQuotaPolicies(combineQuotaPolicies(policy, group), schedule);
  expect(combined).toMatchObject({
    launchFloorPercent: 40,
    freezeFloorPercent: 25,
    maxObservationAgeSeconds: 60,
  });
  expect(combined.requiredWindows).toHaveLength(2);
  expect(combined.consumptionLimits).toEqual([
    { ...policy.consumptionLimits[0]!, holdAt: 28, freezeAt: 32 },
  ]);
});

it("refuses incompatible account, window, meter denomination and calendar definitions", () => {
  const account = structuredClone(policy);
  account.account.accountId = "other";
  expect(() => combineQuotaPolicies(policy, account)).toThrow("account mismatch");
  const window = structuredClone(policy);
  window.requiredWindows[0]!.durationMinutes = 60;
  expect(() => combineQuotaPolicies(policy, window)).toThrow("window semantics");
  for (const patch of [
    { revision: "v2" },
    { unit: "tokens" as const },
    { period: { kind: "calendar_day" as const, timezone: "America/Los_Angeles" } },
  ]) {
    const changed = structuredClone(policy);
    Object.assign(changed.consumptionLimits[0]!, patch);
    expect(() => combineQuotaPolicies(policy, changed)).toThrow("consumption semantics");
  }
});

it("requires prepaid authority in both parent and child and intersects their time bounds", () => {
  const prepaid = {
    ...policy,
    prepaidAuthorization: {
      bucketId: "coding",
      windowId: "weekly",
      startsAt: "2026-09-14T08:00:00Z",
      expiresAt: "2026-09-14T12:00:00Z",
    },
  };
  expect(combineQuotaPolicies(policy, prepaid).prepaidAuthorization).toBeUndefined();
  expect(combineQuotaPolicies(prepaid, policy).prepaidAuthorization).toBeUndefined();
  const child = {
    ...prepaid,
    prepaidAuthorization: {
      ...prepaid.prepaidAuthorization,
      startsAt: "2026-09-14T09:00:00Z",
      expiresAt: "2026-09-14T13:00:00Z",
    },
  };
  expect(combineQuotaPolicies(prepaid, child).prepaidAuthorization).toEqual({
    bucketId: "coding",
    windowId: "weekly",
    startsAt: "2026-09-14T09:00:00.000Z",
    expiresAt: "2026-09-14T12:00:00.000Z",
  });
  expect(combineQuotaPolicies(prepaid, child).consumptionLimits).toEqual(policy.consumptionLimits);
  child.prepaidAuthorization.startsAt = "2026-09-14T12:00:00Z";
  expect(() => combineQuotaPolicies(prepaid, child)).toThrow("do not overlap");
});
