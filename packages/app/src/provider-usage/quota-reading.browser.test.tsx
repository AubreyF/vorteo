import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { AccountUsageBadge, AccountUsageDetails } from "../agent-profiles/account-usage";
import type { ProviderUsage, ProviderUsageView } from "./types";

// Browser-only navigation boundary; the actual usage components and stores run unchanged.
vi.mock("expo-router", () => ({
  router: { push: vi.fn(), replace: vi.fn() },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useLocalSearchParams: () => ({}),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let cache: QueryClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  cache?.clear();
  vi.unstubAllGlobals();
});

const marker = {
  id: "claude-setup-token",
  label: "Subscription",
  value: "Usage is not provided by this connection.",
};
const base: ProviderUsage = {
  providerId: "claude-fixture",
  displayName: "Claude 1",
  status: "unavailable",
  planLabel: null,
  windows: [],
  details: [marker],
};

const variants: Array<[string, ProviderUsage]> = [
  ["Setup-token connection", base],
  [
    "Explicit authentication rejection",
    { ...base, authRecovery: { instructions: "Sign in again." } },
  ],
  ["Ordinary usage failure", { ...base, details: [] }],
];
const rows = variants.map(([label, usage]) => ({
  label,
  providerId: usage.providerId,
  view: {
    kind: "ready",
    isRefreshing: false,
    payload: { requestId: "fixture", fetchedAt: "2026-10-12T00:00:00Z", providers: [usage] },
  } as ProviderUsageView,
}));
const surface: React.CSSProperties = {
  background: "#242321",
  color: "white",
  padding: 24,
  minHeight: 700,
  boxSizing: "border-box",
};
const title: React.CSSProperties = { fontFamily: "sans-serif", fontSize: 20 };
const caption: React.CSSProperties = { fontFamily: "sans-serif", fontSize: 14 };
const card: React.CSSProperties = {
  width: 260,
  maxWidth: "100%",
  border: "1px solid #666",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  boxSizing: "border-box",
};

for (const width of [1280, 390]) {
  test(`compact usage preserves unsupported, rejected and ordinary failure at ${width}px`, async () => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(width, 800);
    cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={cache!}>
          <div style={surface}>
            <h2 style={title}>Claude account usage</h2>
            {rows.map(({ label, providerId, view }) => (
              <section key={label} style={card}>
                <h3 style={caption}>{label}</h3>
                <AccountUsageBadge view={view} providerId={providerId} now={0} />
                <AccountUsageDetails
                  view={view}
                  providerId={providerId}
                  now={0}
                  serverId={null}
                  name="Claude 1"
                  resetLoading={false}
                />
              </section>
            ))}
          </div>
        </QueryClientProvider>,
      );
    });
    for (const label of ["Usage not provided", "Account disconnected", "Usage unavailable"]) {
      await expect.element(page.getByText(label, { exact: true })).toBeVisible();
    }
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).not.toContain("100%");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/claude-quota-${width}.png` });
  });
}
