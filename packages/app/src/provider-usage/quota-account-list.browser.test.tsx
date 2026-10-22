import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { usePanelStore } from "@/stores/panel-store";
import { QuotaAccountList } from "./quota-account-list";
import { quotaAccounts } from "./global-quota";
import type { ProviderUsage, ProviderUsageView } from "./types";

// Browser-only navigation boundary; the actual usage components and stores run unchanged.
vi.mock("expo-router", () => ({
  router: { push: vi.fn(), replace: vi.fn() },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useLocalSearchParams: () => ({}),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let cache: QueryClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  cache?.clear();
  usePanelStore.setState({ quotaAccountExpanded: {} });
  vi.unstubAllGlobals();
});

const now = Date.now();
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const fetchedAt = at(-2);

const providers: ProviderUsage[] = [
  {
    providerId: "codex-2",
    displayName: "Codex 2",
    status: "available",
    planLabel: "Pro",
    sourceLabel: "ChatGPT sign-in",
    fetchedAt,
    windows: [
      {
        id: "session",
        label: "5-hour",
        usedPct: 94,
        resetsAt: at(107),
        runsOutAt: at(38),
        shortfallPct: 40,
      },
      { id: "weekly", label: "Weekly", usedPct: 71, resetsAt: at(57 * 60) },
      { id: "code_review", label: "Code review", usedPct: 12, resetsAt: at(57 * 60) },
    ],
    balances: [{ id: "credits", label: "Credits", remaining: 0, unit: "credits" }],
  },
  {
    providerId: "codex-3",
    displayName: "Codex 3 (Christian)",
    status: "unavailable",
    authRecovery: { instructions: "Sign in again." },
    planLabel: "Plus",
    fetchedAt: at(-200),
    windows: [
      { id: "session", label: "5-hour", usedPct: 40, resetsAt: at(-20) },
      { id: "weekly", label: "Weekly", usedPct: 22, resetsAt: at(122 * 60) },
    ],
  },
  {
    providerId: "claude-1",
    displayName: "Claude 1",
    status: "available",
    planLabel: "Max 20x",
    fetchedAt,
    windows: [
      { id: "five_hour", label: "Session", usedPct: 23, resetsAt: at(243) },
      { id: "weekly", label: "Weekly", usedPct: 48, resetsAt: at(43 * 60) },
      { id: "weekly_model_opus", label: "Weekly · Opus", usedPct: 64, resetsAt: at(43 * 60) },
    ],
    details: [{ id: "extra_usage", label: "Extra usage", value: "Enabled" }],
  },
];

const view: ProviderUsageView = {
  kind: "ready",
  isRefreshing: false,
  payload: {
    requestId: "fixture",
    fetchedAt,
    providers,
    workerActivity: { checkedAt: fetchedAt, runningByProvider: { "codex-2": 3, "claude-1": 4 } },
  },
};

const surface: React.CSSProperties = {
  background: "#18181b",
  color: "white",
  width: 288,
  padding: 8,
  boxSizing: "border-box",
};

async function render(width: number) {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(width, 1000);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={cache!}>
        <div style={surface}>
          <QuotaAccountList
            accounts={quotaAccounts(view, now)}
            serverId={null}
            view={view}
            now={now}
          />
        </div>
      </QueryClientProvider>,
    );
  });
}

for (const width of [1280, 390]) {
  test(`quota accounts show every window with absolute resets at ${width}px`, async () => {
    await render(width);
    // Accounts needing attention open with one bar per window, the pace warning included.
    for (const id of ["session", "weekly", "code_review"]) {
      await expect.element(page.getByTestId(`global-quota-window-codex-2-${id}`)).toBeVisible();
    }
    await expect.element(page.getByTestId("global-quota-pace-codex-2-session")).toBeVisible();
    await expect.element(page.getByText("separate", { exact: true })).toBeVisible();
    expect(container!.textContent).not.toContain("Usage unavailable");
    await expect.element(page.getByText("Account disconnected.", { exact: false })).toBeVisible();
    expect(container!.querySelectorAll('[role="progressbar"]').length).toBe(5);

    // Every reset names its zone: "Resets Thu Oct 22, 5:29 AM PDT · 1h 47m".
    const resets = [...container!.querySelectorAll("div, span")]
      .map((node) => node.textContent ?? "")
      .filter((text) => /^Resets \w{3} \w{3} \d{1,2}, \d{1,2}:\d{2}/.test(text));
    expect(resets.length).toBeGreaterThan(0);
    expect(container!.textContent).not.toContain("Updated");
    expect(container!.textContent).not.toContain("next check");

    // A healthy account starts as one summary line and remembers being opened.
    await expect.element(page.getByTestId("global-quota-summary-claude-1")).toBeVisible();
    expect(page.getByTestId("global-quota-window-claude-1-weekly").query()).toBeNull();
    await page.getByTestId("global-quota-toggle-claude-1").click();
    await expect
      .element(page.getByTestId("global-quota-window-claude-1-weekly_model_opus"))
      .toBeVisible();
    expect(usePanelStore.getState().quotaAccountExpanded["claude-1"]).toBe(true);

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `.vitest-screenshots/global-quota-card-${width}.png` });
  });
}
