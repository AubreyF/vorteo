import { expect, it } from "vitest";
import { constrainedCount, quotaRows } from "./global-quota";
import type { ProviderUsage, ProviderUsageView } from "./types";

const fetchedAt = new Date(0).toISOString();

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
    windows: remainingPct === undefined ? [] : [{ id: "weekly", label: "Weekly", remainingPct }],
    ...overrides,
  };
}

function view(providers: ProviderUsage[]): ProviderUsageView {
  return {
    kind: "ready",
    isRefreshing: false,
    payload: { requestId: "test", fetchedAt, providers },
  };
}

it("lists failing accounts first, then the least remaining, and skips silent providers", () => {
  const rows = quotaRows(
    view([
      provider("Claude 1", {}, 80),
      provider("Claude 2", {}, 9),
      provider("Codex", { status: "error", error: "Rate limited" }),
      provider("OpenCode", { status: "unavailable" }),
      provider("Claude 3", { authRecovery: { instructions: "Sign in again" } }, 50),
    ]),
    0,
  );
  expect(rows.map((row) => row.providerId)).toEqual(["Claude 3", "Codex", "Claude 2", "Claude 1"]);
  expect(rows[0]).toMatchObject({ failing: true, status: "Account disconnected" });
  expect(rows[2]).toMatchObject({ failing: false, remaining: 9, summary: "9%" });
  expect(constrainedCount(rows)).toBe(3);
});

it("shows nothing until usage has loaded", () => {
  expect(quotaRows({ kind: "loading" }, 0)).toEqual([]);
  expect(quotaRows({ kind: "error", message: "Offline" }, 0)).toEqual([]);
});
