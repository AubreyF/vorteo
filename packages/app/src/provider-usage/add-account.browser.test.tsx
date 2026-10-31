import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { ProviderUsage } from "./types";
import { AddClaudeAccountButton } from "./add-account";

const state = vi.hoisted(() => ({
  definitions: [] as unknown[],
  usage: [] as unknown[],
  entries: [] as unknown[],
}));

vi.mock("@/components/adaptive-modal-sheet", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AdaptiveModalSheet: ({
    header,
    children,
    footer,
  }: {
    header: { title: string };
    children: ReactNode;
    footer: ReactNode;
  }) => (
    <div data-testid="sheet">
      <h2>{header.title}</h2>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("./login-panel", () => ({ ProviderLoginPanel: () => null }));
vi.mock("@/execution-installation/policy", () => ({
  readExecutionInstallation: () => ({
    installationId: "installation",
    environments: [
      { kind: "host", serverId: "host", endpoint: "h.example.test", useTls: true },
      { kind: "container", serverId: "dev", endpoint: "d.example.test", useTls: true },
    ],
  }),
  installationHasDev: () => true,
}));
vi.mock("@/execution-installation/settings", () => ({
  requestInstallationSettings: vi.fn(),
  useInstallationSettings: () => ({
    data: { revision: 1, settings: { providerDefinitions: state.definitions } },
  }),
}));
vi.mock("./use-provider-usage", () => ({
  providerUsageQueryKey: (serverId: string) => ["providerUsage", serverId],
  useProviderUsage: () => ({
    view: { kind: "ready", payload: { providers: state.usage }, isRefreshing: false },
    canFetch: true,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  refreshAndApplyProvidersSnapshot: vi.fn(),
  useProvidersSnapshot: () => ({ entries: state.entries }),
}));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: { providers: {} } }),
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => true,
  useHostFeatureMap: () => new Map(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (value: unknown) => unknown) =>
    select({ sessions: { host: { serverInfo: { permissions: ["daemon.manage"] } } } }),
}));
vi.mock("./use-provider-login", () => ({ useSharedInstallationSignIn: () => true }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  await page.viewport(1280, 800);
  state.definitions = [];
  state.usage = [];
  state.entries = [];
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

const claudeDefault: InstallationProvider = {
  id: "claude",
  providerType: "claude",
  bindings: { host: "claude", dev: "claude" },
  policy: {},
};
const claudeUsage: ProviderUsage = {
  providerId: "claude",
  displayName: "Claude",
  status: "available",
  planLabel: "Max 20x",
  windows: [],
};

async function openSheet() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient();
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AddClaudeAccountButton serverId="host" />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    document.querySelector<HTMLElement>('[data-testid="add-claude-account"]')!.click();
  });
  return document.querySelector<HTMLElement>('[data-testid="sheet"]')!;
}

test("names the signed-in default connection before adding a second account", async () => {
  state.definitions = [claudeDefault];
  state.usage = [claudeUsage];
  const sheet = await openSheet();
  const notice = sheet.querySelector<HTMLElement>('[data-testid="claude-existing-connection"]')!;
  expect(notice.textContent).toContain("Claude is already connected: Host CLI sign-in (Max 20x).");
  expect(notice.textContent).toContain("second, separate Claude account");
  expect(sheet.querySelector("h2")!.textContent).toBe("Add another Claude account");
  expect(
    sheet.querySelector<HTMLElement>('[data-testid="claude-account-create"]')!.textContent,
  ).toBe("Create additional account");
});

test("a detected CLI and an added account both count as existing", async () => {
  state.definitions = [
    claudeDefault,
    {
      id: "claude-1",
      providerType: "claude",
      accountSetup: { provider: "claude", creationId: "11111111-1111-4111-8111-111111111111" },
      bindings: { host: "claude-account-1", dev: "claude-account-1" },
      policy: { label: "Claude 1" },
    },
  ];
  state.entries = [{ provider: "claude", status: "ready" }];
  const sheet = await openSheet();
  expect(
    sheet.querySelector<HTMLElement>('[data-testid="claude-existing-connection"]')!.textContent,
  ).toContain("Claude is already connected: Host CLI, sign-in not confirmed, Claude 1.");
});

test("with nothing connected the sheet adds the first account without a notice", async () => {
  state.definitions = [claudeDefault];
  const sheet = await openSheet();
  expect(sheet.querySelector('[data-testid="claude-existing-connection"]')).toBeNull();
  expect(sheet.querySelector("h2")!.textContent).toBe("Add Claude account");
  expect(
    sheet.querySelector<HTMLElement>('[data-testid="claude-account-create"]')!.textContent,
  ).toBe("Create account");
});
