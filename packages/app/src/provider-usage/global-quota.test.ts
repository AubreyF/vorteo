import { expect, it } from "vitest";
import { attentionCount, quotaAccounts, summaryLabel } from "./global-quota";
import type { ProviderUsage, ProviderUsageView } from "./types";

const now = Date.parse("2026-10-22T12:00:00.000Z");
const fetchedAt = new Date(now).toISOString();
const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

function provider(
  providerId: string,
  overrides: Partial<ProviderUsage> = {},
  remainingPct?: number,
): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: null,
    fetchedAt,
    windows:
      remainingPct === undefined
        ? []
        : [{ id: "weekly", label: "Weekly", remainingPct, resetsAt: inHours(30) }],
    ...overrides,
  };
}

function view(
  providers: ProviderUsage[],
  runningByProvider: Record<string, number> = {},
): ProviderUsageView {
  return {
    kind: "ready",
    isRefreshing: false,
    payload: {
      requestId: "test",
      fetchedAt,
      providers,
      workerActivity: { checkedAt: fetchedAt, runningByProvider },
    },
  };
}

it("lists failing accounts first, then those needing attention, and skips silent providers", () => {
  const accounts = quotaAccounts(
    view([
      provider("Claude 1", {}, 80),
      provider("Claude 2", {}, 9),
      provider("Codex", { status: "error", error: "Rate limited" }),
      provider("OpenCode", { status: "unavailable" }),
      provider("Claude 3", { authRecovery: { instructions: "Sign in again" } }, 50),
    ]),
    now,
  );
  expect(accounts.map((account) => account.providerId)).toEqual([
    "Claude 3",
    "Codex",
    "Claude 2",
    "Claude 1",
  ]);
  expect(accounts[0]).toMatchObject({
    failing: true,
    disconnected: true,
    status: "Account disconnected",
  });
  // A disconnected account keeps its last known windows on display.
  expect(accounts[0]?.windows[0]?.remaining).toBe(50);
  expect(accounts[2]).toMatchObject({ failing: false, attention: true, remaining: 9 });
  expect(attentionCount(accounts)).toBe(3);
});

it("draws every window separately and marks the one that limits work", () => {
  const [codex] = quotaAccounts(
    view(
      [
        provider("codex-1", {
          planLabel: "Pro",
          sourceLabel: "ChatGPT sign-in",
          windows: [
            { id: "session", label: "5-hour", usedPct: 62, resetsAt: inHours(3) },
            {
              id: "weekly",
              label: "Weekly",
              usedPct: 41,
              remainingPct: 59,
              resetsAt: inHours(76),
            },
            { id: "code_review", label: "Code review", usedPct: 95, resetsAt: inHours(76) },
          ],
          balances: [{ id: "credits", label: "Credits", remaining: 1240, unit: "credits" }],
        }),
      ],
      { "codex-1": 2 },
    ),
    now,
  );
  expect(codex).toMatchObject({ plan: "Pro", source: "ChatGPT sign-in", running: 2 });
  expect(codex?.windows.map((window) => [window.id, window.remaining, window.limiting])).toEqual([
    ["session", 38, true],
    ["weekly", 59, false],
    ["code_review", 5, false],
  ]);
  // Code review is a separate allowance: nearly spent, yet neither limiting nor urgent.
  expect(codex?.windows[2]?.separate).toBe(true);
  expect(codex).toMatchObject({ remaining: 38, attention: false, nextResetAt: inHours(3) });
  expect(codex?.balances).toEqual([
    {
      id: "credits",
      label: "Credits",
      unit: "credits",
      remaining: 1240,
      limit: null,
      resetsAt: null,
    },
  ]);
});

it("treats a pace that runs out before the reset as needing attention", () => {
  const [account] = quotaAccounts(
    view([
      provider("claude-1", {
        windows: [
          {
            id: "five_hour",
            label: "Session",
            usedPct: 60,
            resetsAt: inHours(3),
            runsOutAt: inHours(1),
            shortfallPct: 50,
          },
        ],
      }),
    ]),
    now,
  );
  expect(account).toMatchObject({ remaining: 40, attention: true });
  expect(account?.windows[0]?.runsOutAt).toBe(inHours(1));
});

it("drops a pace projection that has already passed", () => {
  const [account] = quotaAccounts(
    view([
      provider("claude-1", {
        windows: [
          {
            id: "five_hour",
            label: "Session",
            usedPct: 60,
            resetsAt: inHours(3),
            runsOutAt: inHours(-1),
          },
        ],
      }),
    ]),
    now,
  );
  expect(account?.windows[0]?.runsOutAt).toBeNull();
  expect(account?.attention).toBe(false);
});

it("derives capped balances and ranks balance-only accounts by them", () => {
  const [cursor] = quotaAccounts(
    view([
      provider("cursor", {
        balances: [
          {
            id: "plan",
            label: "Plan usage",
            used: 18,
            limit: 20,
            unit: "usd",
            resetsAt: inHours(200),
          },
        ],
      }),
    ]),
    now,
  );
  expect(cursor?.balances[0]).toMatchObject({ remaining: 2, limit: 20, resetsAt: inHours(200) });
  expect(cursor).toMatchObject({ remaining: 10, attention: true });
});

it("shortens window names for the collapsed line", () => {
  expect(summaryLabel({ label: "5-hour" })).toBe("5h");
  expect(summaryLabel({ label: "Weekly" })).toBe("Week");
  expect(summaryLabel({ label: "Weekly · Opus" })).toBe("Opus");
  expect(summaryLabel({ label: "Session" })).toBe("Session");
  expect(summaryLabel({ label: "Weekly", shortLabel: "wk" })).toBe("wk");
});

it("shows nothing until usage has loaded", () => {
  expect(quotaAccounts({ kind: "loading" }, now)).toEqual([]);
  expect(quotaAccounts({ kind: "error", message: "Offline" }, now)).toEqual([]);
});
