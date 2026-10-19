import { expect, it } from "vitest";
import {
  parseQuotaGovernorPolicy,
  type QuotaGovernorPolicy,
  type QuotaObservation,
} from "@getpaseo/protocol/quota-governor";
import { evaluateQuotaGovernor } from "./governor-evaluate.js";

const now = Date.parse("2026-09-14T08:00:00Z");
const policy: QuotaGovernorPolicy = {
  version: 1,
  account: { issuer: "openai", accountId: "a" },
  launchFloorPercent: 25,
  freezeFloorPercent: 20,
  maxObservationAgeSeconds: 120,
  requiredWindows: [{ bucketId: "coding", windowId: "primary", durationMinutes: 10080 }],
  consumptionLimits: [],
  recovery: "automatic_after_reconciliation",
};
const observation: QuotaObservation = {
  status: "available",
  account: policy.account,
  observedAt: new Date(now).toISOString(),
  windows: [
    {
      bucketId: "coding",
      windowId: "primary",
      durationMinutes: 10080,
      usedPercent: 40,
      resetsAt: null,
      semantics: "unknown",
    },
  ],
  consumptionMeters: [],
};

it("admits prepaid-authorized weekly exhaustion without treating occupancy as prepaid spending", () => {
  const prepaidPolicy = {
    ...policy,
    prepaidAuthorization: {
      bucketId: "coding",
      windowId: "primary",
      startsAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
    },
    estimatedHourly: { bucketId: "coding", windowId: "primary", maxConsumedPoints: 10 },
  };
  expect(
    evaluateQuotaGovernor({
      policy: prepaidPolicy,
      observation: {
        ...observation,
        windows: [{ ...observation.windows[0], usedPercent: 100 }],
      },
      nowMs: now,
      phase: "admission",
    }),
  ).toEqual({ action: "admit", reasons: [] });
});

const prepaidAuthorization = {
  bucketId: "coding",
  windowId: "primary",
  startsAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 3_600_000).toISOString(),
};

it.each(["admission", "active"] as const)(
  "refuses inactive prepaid authorization at exact boundaries during %s",
  (phase) => {
    for (const clock of [now - 1, now + 3_600_000]) {
      expect(
        evaluateQuotaGovernor({
          policy: { ...policy, prepaidAuthorization },
          observation: { ...observation, observedAt: new Date(clock).toISOString() },
          nowMs: clock,
          phase,
        }),
      ).toEqual({
        action: phase === "active" ? "freeze" : "hold",
        reasons: [{ code: "prepaid_authorization_inactive" }],
      });
    }
  },
);

it("prepaid authorization preserves short-window, account, freshness and missing-window holds", () => {
  const prepaidPolicy = { ...policy, prepaidAuthorization };
  const evaluate = (sample: QuotaObservation) =>
    evaluateQuotaGovernor({
      policy: prepaidPolicy,
      observation: sample,
      nowMs: now,
      phase: "active",
    });
  expect(
    evaluate({
      ...observation,
      windows: [
        { ...observation.windows[0], usedPercent: 100 },
        { ...observation.windows[0], windowId: "short", durationMinutes: 300, usedPercent: 100 },
      ],
    }),
  ).toEqual({
    action: "freeze",
    reasons: [{ code: "freeze_floor", bucketId: "coding", windowId: "short" }],
  });
  expect(
    evaluate({ ...observation, account: { ...policy.account, accountId: "other" } }).reasons,
  ).toEqual([{ code: "account_changed" }]);
  expect(
    evaluate({ ...observation, observedAt: new Date(now - 120_001).toISOString() }).reasons,
  ).toEqual([{ code: "telemetry_stale" }]);
  expect(
    evaluate({ ...observation, windows: [{ ...observation.windows[0], windowId: "other" }] })
      .reasons,
  ).toEqual([{ code: "required_window_unavailable", bucketId: "coding", windowId: "primary" }]);
  expect(evaluate({ status: "unavailable", reason: "read_failed" }).reasons).toEqual([
    { code: "telemetry_unavailable" },
  ]);
  expect(
    evaluate({ ...observation, windows: [...observation.windows, ...observation.windows] }).reasons,
  ).toEqual([{ code: "invalid_observation" }]);
});

it("prepaid authorization cannot remove a configured consumption meter", () => {
  expect(
    evaluateQuotaGovernor({
      policy: {
        ...policy,
        prepaidAuthorization,
        consumptionLimits: [
          {
            meterId: "paid",
            bucketId: "coding",
            revision: "1",
            unit: "credits",
            period: { kind: "trailing_hour" },
            throttleAt: 5,
            holdAt: 10,
            freezeAt: 15,
          },
        ],
      },
      observation,
      nowMs: now,
      phase: "active",
    }),
  ).toEqual({ action: "freeze", reasons: [{ code: "meter_unavailable", meterId: "paid" }] });
});

it.each([
  { startsAt: new Date(now + 1).toISOString(), expiresAt: new Date(now).toISOString() },
  { expiresAt: new Date(now).toISOString() },
  { expiresAt: new Date(now + 86_400_001).toISOString() },
  { bucketId: "unmapped" },
  { windowId: "short" },
])("rejects invalid prepaid authorization scope or duration %j", (patch) => {
  expect(() =>
    parseQuotaGovernorPolicy({
      ...policy,
      prepaidAuthorization: { ...prepaidAuthorization, ...patch },
    }),
  ).toThrow("Prepaid authorization");
});

it.each([
  [74, "admit"],
  [75, "hold"],
  [79, "hold"],
  [80, "freeze"],
  [100, "freeze"],
] as const)(
  "evaluates %i percent used at exact launch and freeze boundaries",
  (usedPercent, action) => {
    expect(
      evaluateQuotaGovernor({
        policy,
        observation: {
          ...observation,
          windows: [{ ...observation.windows[0], usedPercent }],
        },
        nowMs: now,
        phase: "admission",
      }).action,
    ).toBe(action);
  },
);

it.each(["admission", "active"] as const)(
  "zero reserves still enforce exhaustion and freshness during %s",
  (phase) => {
    const zeroPolicy = {
      ...policy,
      launchFloorPercent: 0,
      freezeFloorPercent: 0,
    };
    for (const [usedPercent, expected] of [
      [99, "admit"],
      [100, "freeze"],
    ] as const) {
      expect(
        evaluateQuotaGovernor({
          policy: zeroPolicy,
          observation: {
            ...observation,
            windows: [{ ...observation.windows[0], usedPercent }],
          },
          nowMs: now,
          phase,
        }).action,
      ).toBe(expected);
    }
    expect(
      evaluateQuotaGovernor({
        policy: zeroPolicy,
        observation,
        nowMs: now + 121000,
        phase,
      }).action,
    ).not.toBe("admit");
  },
);

it("freezes active work when a required daily meter is unavailable, even with token diagnostics", () => {
  const strict: QuotaGovernorPolicy = {
    ...policy,
    consumptionLimits: [
      {
        meterId: "weekly-consumption",
        bucketId: "coding",
        revision: "1",
        unit: "weekly_quota_points",
        period: { kind: "calendar_day", timezone: "America/Los_Angeles" },
        throttleAt: 25,
        holdAt: 30,
        freezeAt: 35,
      },
    ],
  };
  expect(
    evaluateQuotaGovernor({
      policy: strict,
      observation: {
        ...observation,
        tokenActivity: {
          lifetimeTokens: 200,
          dailyBuckets: [{ date: "2026-09-14", tokens: 100 }],
        },
      },
      nowMs: now,
      phase: "active",
    }),
  ).toEqual({
    action: "freeze",
    reasons: [{ code: "meter_unavailable", meterId: "weekly-consumption" }],
  });
});

it("does not allow a healthy weekly window to override an exhausted short window", () => {
  expect(
    evaluateQuotaGovernor({
      policy,
      observation: {
        ...observation,
        windows: [
          ...observation.windows,
          {
            ...observation.windows[0],
            windowId: "secondary",
            durationMinutes: 300,
            usedPercent: 90,
          },
        ],
      },
      nowMs: now,
      phase: "admission",
    }),
  ).toEqual({
    action: "freeze",
    reasons: [{ code: "freeze_floor", bucketId: "coding", windowId: "secondary" }],
  });
});

it("holds stale admission and freezes stale active work", () => {
  for (const phase of ["admission", "active"] as const) {
    expect(evaluateQuotaGovernor({ policy, observation, nowMs: now + 120001, phase })).toEqual({
      action: phase === "active" ? "freeze" : "hold",
      reasons: [{ code: "telemetry_stale" }],
    });
  }
});

it("ignores exhausted unrelated model buckets while retaining coding short-window limits", () => {
  expect(
    evaluateQuotaGovernor({
      policy,
      observation: {
        ...observation,
        windows: [
          ...observation.windows,
          {
            ...observation.windows[0],
            bucketId: "other-model",
            usedPercent: 100,
          },
        ],
      },
      nowMs: now,
      phase: "admission",
    }),
  ).toEqual({ action: "admit", reasons: [] });
});

it("cannot borrow another account's headroom", () => {
  expect(
    evaluateQuotaGovernor({
      policy,
      observation: {
        ...observation,
        account: { issuer: "openai", accountId: "other" },
      },
      nowMs: now,
      phase: "active",
    }),
  ).toEqual({
    action: "freeze",
    reasons: [{ code: "account_changed" }],
  });
});

it("counts an interval crossing the hourly boundary in full instead of prorating unknown usage", () => {
  const hourly: QuotaGovernorPolicy = {
    ...policy,
    consumptionLimits: [
      {
        meterId: "m",
        bucketId: "coding",
        revision: "1",
        unit: "tokens",
        period: { kind: "trailing_hour" },
        throttleAt: 5,
        holdAt: 10,
        freezeAt: 15,
      },
    ],
  };
  expect(
    evaluateQuotaGovernor({
      policy: hourly,
      observation: {
        ...observation,
        consumptionMeters: [
          {
            meterId: "m",
            bucketId: "coding",
            unit: "tokens",
            quality: "authoritative",
            revision: "1",
            coverageStart: "2026-09-14T06:00:00Z",
            coverageEnd: "2026-09-14T08:00:00Z",
            intervals: [
              {
                startsAt: "2026-09-14T06:30:00Z",
                endsAt: "2026-09-14T07:30:00Z",
                consumed: 15,
              },
            ],
          },
        ],
      },
      nowMs: now,
      phase: "active",
    }),
  ).toEqual({
    action: "freeze",
    reasons: [{ code: "consumption_freeze", meterId: "m", consumed: 15 }],
  });
});

it("uses local midnight, not UTC midnight, for a calendar budget", () => {
  const daily: QuotaGovernorPolicy = {
    ...policy,
    consumptionLimits: [
      {
        meterId: "m",
        bucketId: "coding",
        revision: "1",
        unit: "tokens",
        period: { kind: "calendar_day", timezone: "America/Los_Angeles" },
        throttleAt: 5,
        holdAt: 10,
        freezeAt: 15,
      },
    ],
  };
  expect(
    evaluateQuotaGovernor({
      policy: daily,
      observation: {
        ...observation,
        consumptionMeters: [
          {
            meterId: "m",
            bucketId: "coding",
            unit: "tokens",
            quality: "authoritative",
            revision: "1",
            coverageStart: "2026-09-14T00:00:00Z",
            coverageEnd: "2026-09-14T08:00:00Z",
            intervals: [
              {
                startsAt: "2026-09-14T00:00:00Z",
                endsAt: "2026-09-14T06:00:00Z",
                consumed: 100,
              },
            ],
          },
        ],
      },
      nowMs: now,
      phase: "admission",
    }),
  ).toEqual({ action: "admit", reasons: [] });
});

it("freezes when a required short window disappears from otherwise healthy telemetry", () => {
  const required = {
    bucketId: "coding",
    windowId: "secondary",
    durationMinutes: 300,
  };
  expect(
    evaluateQuotaGovernor({
      policy: {
        ...policy,
        requiredWindows: [...policy.requiredWindows, required],
      },
      observation,
      nowMs: now,
      phase: "active",
    }),
  ).toEqual({
    action: "freeze",
    reasons: [
      {
        code: "required_window_unavailable",
        bucketId: "coding",
        windowId: "secondary",
      },
    ],
  });
});

it.each([
  { bucketId: "unrelated", revision: "1" },
  { bucketId: "coding", revision: "new-allowance-denominator" },
])("rejects a meter whose definition changed: %j", (definition) => {
  const limit = {
    meterId: "m",
    bucketId: "coding",
    revision: "1",
    unit: "weekly_quota_points" as const,
    period: { kind: "trailing_hour" as const },
    throttleAt: 25,
    holdAt: 30,
    freezeAt: 35,
  };
  expect(
    evaluateQuotaGovernor({
      policy: { ...policy, consumptionLimits: [limit] },
      observation: {
        ...observation,
        consumptionMeters: [
          {
            meterId: "m",
            ...definition,
            unit: "weekly_quota_points",
            quality: "authoritative",
            coverageStart: "2026-09-14T00:00:00Z",
            coverageEnd: "2026-09-14T08:00:00Z",
            intervals: [],
          },
        ],
      },
      nowMs: now,
      phase: "admission",
    }),
  ).toEqual({
    action: "hold",
    reasons: [{ code: "meter_unavailable", meterId: "m" }],
  });
});
