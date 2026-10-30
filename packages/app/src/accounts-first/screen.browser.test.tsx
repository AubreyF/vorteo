import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { AccountsFirstScreen } from "./screen";

// The real buttons open the existing account sheets; here they report a created account.
vi.mock("@/provider-usage/add-account", async () => {
  const { useCallback } = await import("react");
  function Connect({
    onCreated,
  }: {
    onCreated?: (account: { providerId: string; name: string }) => void;
  }) {
    const create = useCallback(
      () => onCreated?.({ providerId: "claude-2", name: "Claude 2" }),
      [onCreated],
    );
    return (
      <button type="button" onClick={create}>
        Connect
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

function mount(onDone = vi.fn(), onOpenAccounts = vi.fn()) {
  container = document.createElement("div");
  container.style.height = "100vh";
  container.style.display = "flex";
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <AccountsFirstScreen serverId="host" onDone={onDone} onOpenAccounts={onOpenAccounts} />,
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
    expect(screen.textContent).toContain("Host and Dev share the connection");
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
