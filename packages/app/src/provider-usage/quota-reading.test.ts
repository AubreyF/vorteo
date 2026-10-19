import { expect, it } from "vitest";
import { quotaReading, limitingWindow } from "./quota-reading";
import { retainLastKnownUsage } from "./usage-cache";
import { selectedPresetPresentation } from "../agent-profiles/selected-preset-presentation";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";

const payload: ProviderUsageListPayload = {
  requestId: "test",
  fetchedAt: new Date(0).toISOString(),
  providers: [
    {
      providerId: "secondary",
      displayName: "Secondary",
      status: "available",
      planLabel: null,
      windows: [
        { id: "weekly", label: "Weekly", remainingPct: 82 },
        { id: "code_review", label: "Code review", remainingPct: 0 },
      ],
    },
  ],
};
const view: ProviderUsageView = { kind: "ready", payload, isRefreshing: false };

it.each([0, 300_001, 86_400_000])("keeps ring and menu aligned at age %s", (now) => {
  const row = quotaReading(view, "secondary", now);
  const ring = selectedPresetPresentation({
    view,
    now,
    selectedProfileId: "preset",
    definitions: [{ id: "preset", name: "Secondary", provider: "secondary" }],
  });
  expect(row.remaining).toBe(82);
  expect(ring.remaining).toBe(row.remaining);
  expect(ring.statusLabel).toBe(row.statusLabel);
  expect(ring.showRing).toBe(true);
});
it("labels cached data when disconnected", () => {
  expect(quotaReading({ ...view, refreshError: "Disconnected" }, "secondary", 1).statusLabel).toBe(
    "Last known usage; refresh unavailable",
  );
});
it("retains the account timestamp across failed refreshes and recovers", () => {
  const previous = retainLastKnownUsage(payload, undefined);
  const next = {
    ...payload,
    fetchedAt: new Date(600_000).toISOString(),
    providers: payload.providers.map((p) => ({ ...p, status: "error" as const, windows: [] })),
  };
  const failed = retainLastKnownUsage(next, previous);
  expect(failed.providers[0].fetchedAt).toBe(payload.fetchedAt);
  expect(quotaReading({ ...view, payload: failed }, "secondary", 600_000).remaining).toBe(82);
  const recovered = retainLastKnownUsage({ ...payload, fetchedAt: next.fetchedAt }, failed);
  expect(recovered.providers[0].refreshError).toBeUndefined();
  expect(recovered.providers[0].fetchedAt).toBe(next.fetchedAt);
  expect(retainLastKnownUsage({ ...next, providers: [] }, failed).providers).toEqual([]);
});
it("does not invent readings or transfer them between accounts", () => {
  expect(quotaReading(view, "primary", 0).remaining).toBeNull();
  expect(quotaReading({ kind: "loading" }, "secondary", 0).statusLabel).toBe("Loading usage");
  expect(
    limitingWindow({
      ...payload.providers[0],
      windows: [{ id: "weekly", label: "Weekly", remainingPct: NaN }],
    }),
  ).toBeNull();
});
it.each([0, 100])("preserves valid boundary value %s", (remainingPct) => {
  expect(
    limitingWindow({
      ...payload.providers[0],
      windows: [{ id: "weekly", label: "Weekly", remainingPct }],
    })?.remainingPct,
  ).toBe(remainingPct);
});

it("keeps cached readings through disconnect and refresh errors, then clears the warning", async () => {
  const { providerUsageView } = await import("./usage-view");
  const input = {
    hasHost: true,
    connected: true,
    supported: true,
    data: payload,
    fetching: false,
    error: undefined,
  };
  const offline = providerUsageView({ ...input, connected: false });
  expect(quotaReading(offline, "secondary", 1).remaining).toBe(82);
  expect(quotaReading(offline, "secondary", 1).statusLabel).toBe(
    "Last known usage; refresh unavailable",
  );
  const failed = providerUsageView({ ...input, error: new Error("Timeout") });
  expect(quotaReading(failed, "secondary", 1).remaining).toBe(82);
  expect(quotaReading(providerUsageView(input), "secondary", 1).statusLabel).toBeNull();
  expect(providerUsageView({ ...input, data: undefined }).kind).toBe("loading");
  expect(providerUsageView({ ...input, data: undefined, connected: false }).kind).toBe("error");
});

it("shows prepaid credits when either coding allowance is exhausted", () => {
  const prepaidView: ProviderUsageView = {
    ...view,
    payload: {
      ...payload,
      providers: [
        {
          ...payload.providers[0],
          windows: [
            { id: "session", label: "5-hour", remainingPct: 0 },
            { id: "weekly", label: "Weekly", remainingPct: 40 },
          ],
          balances: [{ id: "credits", label: "Credits", remaining: 12500, unit: "credits" }],
        },
      ],
    },
  };
  expect(quotaReading(prepaidView, "secondary", 1).prepaidLabel).toBe("12,500 credits left");
  expect(quotaReading(prepaidView, "secondary", 1).remaining).toBe(0);
});

it.each([
  { remainingPct: 1, balance: 12500, expected: null },
  { remainingPct: 0.1, balance: 12500, expected: null },
  { remainingPct: 0, balance: 0, expected: null },
  { remainingPct: 0, balance: -1, expected: null },
  { remainingPct: 0, balance: NaN, expected: null },
  { remainingPct: 0, balance: Infinity, expected: null },
  { remainingPct: 0, balance: undefined, expected: null },
  { remainingPct: 0, balance: 12.5, expected: "12.5 credits left" },
])(
  "uses actual exhaustion and a positive known balance: $remainingPct / $balance",
  ({ remainingPct, balance, expected }) => {
    const prepaidView: ProviderUsageView = {
      ...view,
      payload: {
        ...payload,
        providers: [
          {
            ...payload.providers[0],
            windows: [{ id: "weekly", label: "Weekly", remainingPct }],
            balances: [{ id: "credits", label: "Credits", remaining: balance, unit: "credits" }],
          },
        ],
      },
    };
    expect(quotaReading(prepaidView, "secondary", 1).prepaidLabel).toBe(expected);
  },
);

it("does not treat exhausted code review or another account as prepaid", () => {
  const prepaidView: ProviderUsageView = {
    ...view,
    payload: {
      ...payload,
      providers: [
        {
          ...payload.providers[0],
          balances: [{ id: "credits", label: "Credits", remaining: 12500, unit: "credits" }],
        },
      ],
    },
  };
  expect(quotaReading(prepaidView, "secondary", 1).prepaidLabel).toBeNull();
  expect(quotaReading(prepaidView, "missing", 1).prepaidLabel).toBeNull();
});

it.each([
  { providerId: "codex", unit: "usd" as const, expected: "12,500 credits left" },
  { providerId: "codex-account-example", unit: "usd" as const, expected: "12,500 credits left" },
  { providerId: "other", unit: "usd" as const, expected: "$12500.00 credit left" },
  { providerId: "other", unit: "tokens" as const, expected: "12,500 tokens left" },
])(
  "preserves provider units and corrects older credit reports: $providerId / $unit",
  ({ providerId, unit, expected }) => {
    const prepaidView: ProviderUsageView = {
      ...view,
      payload: {
        ...payload,
        providers: [
          {
            ...payload.providers[0],
            providerId,
            windows: [{ id: "weekly", label: "Weekly", remainingPct: 0 }],
            balances: [{ id: "credits", label: "Credits", remaining: 12500, unit }],
          },
        ],
      },
    };
    expect(quotaReading(prepaidView, providerId, 1).prepaidLabel).toBe(expected);
    expect(quotaReading(prepaidView, providerId, 600000).statusLabel).toBe("Last known usage");
  },
);

it("hides prepaid usage after authentication fails", () => {
  const disconnected: ProviderUsageView = {
    ...view,
    payload: {
      ...payload,
      providers: [
        {
          ...payload.providers[0],
          authRecovery: { instructions: "Sign in again." },
          windows: [{ id: "weekly", label: "Weekly", remainingPct: 0 }],
          balances: [{ id: "credits", label: "Credits", remaining: 12500, unit: "credits" }],
        },
      ],
    },
  };
  expect(quotaReading(disconnected, "secondary", 1).prepaidLabel).toBeNull();
});
