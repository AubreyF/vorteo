import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { ProviderLoginPanel } from "./login-panel";
import { useProviderLogin } from "./use-provider-login";
vi.mock("@/utils/copy-to-clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn() }));
vi.mock("./use-provider-login", () => ({ useProviderLogin: vi.fn() }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        host: {
          serverInfo: {
            features: { providerAccountLogin: true, claudeAccountCreation: true },
            permissions: ["daemon.manage"],
          },
        },
      },
    }),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  await page.viewport(1280, 800);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.resetAllMocks();
});

test("shared success shows pending delivery and allows renewal or installation-wide disconnect", async () => {
  const start = vi.fn();
  const signOut = vi.fn();
  vi.mocked(useProviderLogin).mockReturnValue({
    state: {
      status: "succeeded",
      attemptId: "11111111-1111-4111-8111-111111111111",
      accountLabel: null,
    },
    sharedClaude: true,
    synchronization: {
      connected: true,
      environments: [
        { serverId: "host", status: "ready" },
        { serverId: "dev", status: "pending" },
      ],
    },
    connected: true,
    busy: false,
    actionPending: false,
    readFailed: false,
    actionFailed: false,
    refreshing: false,
    start,
    signOut,
    cancel: vi.fn(),
    submitCode: vi.fn(),
    refresh: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ProviderLoginPanel
        serverId="host"
        providerId="claude-one"
        name="Claude"
        provider="claude"
      />,
    ),
  );
  expect(container.textContent).toContain("Connect Claude once");
  expect(container.textContent).toContain("Synchronization is pending");
  expect(container.textContent).not.toContain("Signed in as");
  await page.getByRole("button", { name: "Reconnect Claude subscription" }).click();
  expect(start).toHaveBeenCalledOnce();
  await page
    .getByRole("button", { name: "Disconnect subscription from this installation" })
    .click();
  expect(signOut).toHaveBeenCalledOnce();
  expect(vi.mocked(useProviderLogin)).toHaveBeenCalledWith("host", "claude-one", "claude");
});

test("disconnect does not hide an offline environment awaiting credential removal", () => {
  vi.mocked(useProviderLogin).mockReturnValue({
    state: { status: "idle" },
    sharedClaude: true,
    synchronization: {
      connected: false,
      environments: [{ serverId: "dev", status: "disconnecting" }],
    },
    connected: true,
    busy: false,
    actionPending: false,
    readFailed: false,
    actionFailed: false,
    refreshing: false,
    start: vi.fn(),
    signOut: vi.fn(),
    cancel: vi.fn(),
    submitCode: vi.fn(),
    refresh: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ProviderLoginPanel
        serverId="host"
        providerId="claude-one"
        name="Claude"
        provider="claude"
      />,
    ),
  );
  expect(container.textContent).toContain("Disconnecting.");
  expect(container.textContent).toContain(
    "Credential removal will finish automatically when connections return",
  );
});
