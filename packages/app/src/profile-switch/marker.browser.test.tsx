import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import type { ProfileSwitchItem } from "@/types/stream";
import { ProfileSwitchMarker } from "./marker";

// Account labels come from the host's provider catalog; supply it as a fixture.
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: [
      { provider: "claude-account-1", label: "Claude 1", enabled: true, status: "ready" },
      { provider: "codex-account-2", label: "Codex 2", enabled: true, status: "ready" },
    ],
  }),
}));

let root: Root;
let container: HTMLDivElement;
const item: ProfileSwitchItem = {
  kind: "profile_switch",
  id: "profile_switch_switch-1",
  switchId: "switch-1",
  reason: "quota",
  from: { provider: "claude-account-1", model: "claude-opus-4-7", profileName: "Deep work" },
  to: { provider: "codex-account-2", model: "gpt-5.5", profileName: "Fast fixes" },
  carriedContextChars: 12345,
  timestamp: new Date("2026-10-22T12:00:00Z"),
};
const uncataloguedItem: ProfileSwitchItem = {
  ...item,
  reason: "manual",
  from: { provider: "claude" },
  to: { provider: "codex", model: null },
};

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  container.style.maxWidth = "720px";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("names both accounts and explains the carried context", async () => {
  act(() => root.render(<ProfileSwitchMarker item={item} serverId="server-1" />));
  const caption = "Switched from Claude 1 · claude-opus-4-7 to Codex 2 · gpt-5.5 after quota limit";
  expect(container.querySelector('[data-testid="profile-switch-detail"]')).toBeNull();
  await page.getByRole("button", { name: caption, exact: true }).click();
  const detail = container.querySelector('[data-testid="profile-switch-detail"]');
  expect(detail?.textContent).toContain("Previous profile: Deep work");
  expect(detail?.textContent).toContain("New profile: Fast fixes");
  expect(detail?.textContent).toContain(
    `Carried ${(12345).toLocaleString()} characters of recent conversation as context.`,
  );
});

test("falls back to provider ids for accounts the catalog does not list", async () => {
  act(() => root.render(<ProfileSwitchMarker item={uncataloguedItem} serverId="server-1" />));
  await expect
    .element(page.getByRole("button", { name: "Switched from claude to codex", exact: true }))
    .toBeVisible();
});
