import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { CodexQuotaProvider } from "./codex.js";
import { evaluateQuotaReserve } from "../../../server/agent/quota-reserve/evaluate.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it.each([
  {
    name: "single coding window with an explicitly absent secondary",
    limits: { primary_window: { used_percent: 20 }, secondary_window: null },
    ids: ["session"],
    evaluation: "ready",
  },
  {
    name: "secondary coding limit crossing Redline",
    limits: { primary_window: { used_percent: 20 }, secondary_window: { used_percent: 90 } },
    ids: ["session", "weekly"],
    evaluation: "redline",
  },
  {
    name: "applicable secondary with missing utilization",
    limits: { primary_window: { used_percent: 20 }, secondary_window: {} },
    ids: ["session", "weekly"],
    evaluation: "unavailable",
  },
  {
    name: "omitted secondary applicability",
    limits: { primary_window: { used_percent: 20 } },
    ids: undefined,
    evaluation: "unavailable",
  },
  {
    name: "no coding allowances",
    limits: { primary_window: null, secondary_window: null },
    ids: [],
    evaluation: "unavailable",
  },
  {
    name: "missing rate-limit response",
    limits: null,
    ids: undefined,
    evaluation: "unavailable",
  },
])("declares reserve applicability for $name", async ({ limits, ids, evaluation }) => {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-reserve-"));
  homes.push(home);
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "test" } }));
  const provider = new CodexQuotaProvider({
    logger: pino({ level: "silent" }),
    codexHome: home,
    strictCodexHome: true,
    fetch: async () =>
      Response.json({
        rate_limit: limits,
        code_review_rate_limit: { primary_window: { used_percent: 100 } },
        credits: { balance: 100 },
      }),
  });
  const usage = await provider.fetchUsage();
  expect(usage.balances).toEqual([
    expect.objectContaining({ id: "credits", remaining: 100, unit: "credits" }),
  ]);
  expect(usage.reserveWindowIds).toEqual(ids);
  expect(
    evaluateQuotaReserve({
      policy: { kind: "protected", cruisePct: 15, redlinePct: 10 },
      windows: usage.windows,
      requiredWindowIds: usage.reserveWindowIds ?? [],
      observedAtMs: 1000,
      nowMs: 1001,
      maxAgeMs: 30000,
      recovering: false,
    }).kind,
  ).toBe(evaluation);
});

it.each([
  { seconds: 604800, label: "Weekly" },
  { seconds: 18000, label: "5-hour" },
  { seconds: 86400, label: "1-day" },
  { seconds: 900, label: "15-minute" },
  { seconds: 30, label: "30-second" },
  { seconds: undefined, label: "Session" },
])("labels a primary allowance lasting $seconds seconds as $label", async ({ seconds, label }) => {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-window-"));
  homes.push(home);
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "test" } }));
  const provider = new CodexQuotaProvider({
    logger: pino({ level: "silent" }),
    codexHome: home,
    strictCodexHome: true,
    fetch: async () =>
      Response.json({
        rate_limit: {
          primary_window: { used_percent: 91, limit_window_seconds: seconds },
          secondary_window: null,
        },
      }),
  });

  const usage = await provider.fetchUsage();

  expect(usage.windows).toEqual([
    {
      id: "session",
      label,
      usedPct: 91,
      remainingPct: 9,
      resetsAt: null,
      tone: "danger",
    },
  ]);
});
