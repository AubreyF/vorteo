import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { AccountsFirstConnection } from "./model";
import { AccountsFirstScreen } from "./screen";

// The real buttons open the existing account sheets; here they report a created account.
vi.mock("@/provider-usage/add-account", async () => {
  const { useCallback } = await import("react");
  function Connect({
    onCreated,
    label,
  }: {
    onCreated?: (account: { providerId: string; name: string }) => void;
    label?: string;
  }) {
    const create = useCallback(
      () => onCreated?.({ providerId: "claude-2", name: "Claude 2" }),
      [onCreated],
    );
    return (
      <button type="button" onClick={create}>
        {label}
      </button>
    );
  }
  return { AddClaudeAccountButton: Connect, AddCodexAccountButton: Connect };
});
vi.mock("@/execution-installation/installation-name", () => ({
  useInstallationName: () => "Lab",
}));
// The logo reads appearance palettes the test theme does not define.
vi.mock("@/components/icons/paseo-logo", () => ({ VorteoLogo: () => null }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// Only the gate's hook reads these; the screen receives connections as props.
vi.mock("@/provider-usage/use-provider-usage", () => ({ useProviderUsage: vi.fn() }));
vi.mock("@/provider-usage/use-provider-login", () => ({ useInstallationConnectOnce: vi.fn() }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

const NOT_CONNECTED: AccountsFirstConnection[] = [
  { provider: "claude", enabled: true, connection: null },
  { provider: "codex", enabled: true, connection: null },
];

function mount(
  onDone = vi.fn(),
  onOpenAccounts = vi.fn(),
  connections = NOT_CONNECTED,
  codexConnectOnce = true,
) {
  container = document.createElement("div");
  container.style.height = "100vh";
  container.style.display = "flex";
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <AccountsFirstScreen
        serverId="host"
        connections={connections}
        codexConnectOnce={codexConnectOnce}
        onDone={onDone}
        onOpenAccounts={onOpenAccounts}
      />,
    ),
  );
  return { onDone, onOpenAccounts };
}

test.each([
  [1280, 800],
  [390, 844],
])(
  "offers both providers and Skip for now without horizontal overflow at %ipx",
  async (width, height) => {
    await page.viewport(width, height);
    const { onDone, onOpenAccounts } = mount();
    const screen = document.querySelector<HTMLElement>('[data-testid="accounts-first-screen"]')!;
    expect(screen.textContent).toContain("Connect your AI accounts");
    expect(screen.textContent).toContain("for Lab");
    for (const id of ["accounts-first-claude-status", "accounts-first-codex-status"])
      expect(document.querySelector(`[data-testid="${id}"]`)!.textContent).toBe(
        "Sign in once. Host and Dev share the connection.",
      );
    expect(screen.textContent).not.toContain("Dev still asks");
    for (const id of ["accounts-first-claude", "accounts-first-codex"]) {
      const row = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const done = document.querySelector<HTMLElement>('[data-testid="accounts-first-done"]')!;
    expect(done.textContent).toBe("Skip for now");
    act(() => done.click());
    expect(onDone).toHaveBeenCalledOnce();
    act(() =>
      document.querySelector<HTMLElement>('[data-testid="accounts-first-open-settings"]')!.click(),
    );
    expect(onOpenAccounts).toHaveBeenCalledOnce();
  },
);

test("connecting an account turns Skip for now into Continue", async () => {
  await page.viewport(1280, 800);
  mount();
  const connect = document.querySelector<HTMLElement>(
    '[data-testid="accounts-first-claude"] button',
  )!;
  act(() => connect.click());
  expect(
    document.querySelector<HTMLElement>('[data-testid="accounts-first-done"]')!.textContent,
  ).toBe("Continue");
});

function status(provider: string) {
  return document.querySelector<HTMLElement>(`[data-testid="accounts-first-${provider}-status"]`)!
    .textContent;
}
function rowButton(provider: string) {
  return document.querySelector<HTMLElement>(`[data-testid="accounts-first-${provider}"] button`)!
    .textContent;
}

test("shows each provider's real state: a Host sign-in and an added account read as connected", async () => {
  await page.viewport(1280, 800);
  mount(vi.fn(), vi.fn(), [
    {
      provider: "claude",
      enabled: true,
      connection: {
        providerId: "claude-account-1",
        name: "Claude 1",
        isDefault: false,
        setup: true,
        enabled: true,
        signedIn: false,
        plan: null,
      },
    },
    {
      provider: "codex",
      enabled: true,
      connection: {
        providerId: "codex",
        name: "Codex",
        isDefault: true,
        setup: false,
        enabled: true,
        signedIn: true,
        plan: "pro",
      },
    },
  ]);
  expect(status("claude")).toBe("Connected as Claude 1.");
  expect(status("codex")).toBe("Connected through the Host's Codex sign-in, pro plan.");
  expect(rowButton("claude")).toBe("Add another");
  expect(rowButton("codex")).toBe("Add another");
  expect(
    document.querySelector<HTMLElement>('[data-testid="accounts-first-done"]')!.textContent,
  ).toBe("Continue");
});

test("a disabled provider is not offered, and Codex says so when connect-once is off", async () => {
  await page.viewport(1280, 800);
  mount(
    vi.fn(),
    vi.fn(),
    [
      { provider: "claude", enabled: false, connection: null },
      { provider: "codex", enabled: true, connection: null },
    ],
    false,
  );
  expect(document.querySelector('[data-testid="accounts-first-claude"]')).toBeNull();
  expect(status("codex")).toBe(
    "Signs in on the Host. Dev needs its own sign-in until one-time Codex sign-in is on.",
  );
  expect(rowButton("codex")).toBe("Connect");
});
