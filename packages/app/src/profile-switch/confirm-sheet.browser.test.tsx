import React, { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import { ProfileSwitchSheet } from "./confirm-sheet";

// The sheet's overlay layers belong to the shared component; this suite covers the
// switch states rendered inside it.
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    header,
    children,
    footer,
  }: {
    header: { title: string };
    children: React.ReactNode;
    footer: React.ReactNode;
  }) => (
    <div role="dialog" aria-label={header.title}>
      <h2>{header.title}</h2>
      {children}
      {footer}
    </div>
  ),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  await page.viewport(1280, 800);
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Deferred {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Mirrors the picker: the sheet closes only after the daemon accepts the switch. */
function Harness({ switches, onNewTask }: { switches: Deferred[]; onNewTask: () => void }) {
  const [open, setOpen] = useState(true);
  const close = useCallback(() => setOpen(false), []);
  const switchThread = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        switches.push({ resolve, reject });
      }).then(close),
    [close, switches],
  );
  if (!open) return <span>Sheet closed</span>;
  return (
    <ProfileSwitchSheet
      profileName="Codex 2"
      onSwitch={switchThread}
      onNewTask={onNewTask}
      onClose={close}
    />
  );
}

function mount(switches: Deferred[], onNewTask = vi.fn()) {
  act(() => root.render(<Harness switches={switches} onNewTask={onNewTask} />));
  return onNewTask;
}

const switchButton = () => page.getByTestId("profile-switch-confirm");

test("shows progress while switching and closes when the daemon accepts", async () => {
  const switches: Deferred[] = [];
  mount(switches);
  await expect.element(page.getByText("Switch to Codex 2", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("starts a new session there", { exact: false }))
    .toBeVisible();
  await switchButton().click();
  await expect.element(page.getByText("Switching...", { exact: true })).toBeVisible();
  await expect.element(page.getByTestId("profile-switch-new-task")).toBeDisabled();
  expect(switches).toHaveLength(1);
  await act(async () => switches[0].resolve());
  await expect.element(page.getByText("Sheet closed", { exact: true })).toBeVisible();
});

test("keeps the daemon's refusal visible and lets the user retry", async () => {
  const switches: Deferred[] = [];
  mount(switches);
  await switchButton().click();
  await act(async () => switches[0].reject(new Error("Stop the running turn before switching.")));
  await expect
    .element(page.getByText("Stop the running turn before switching.", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("Switch in this thread", { exact: true })).toBeVisible();
  await switchButton().click();
  expect(switches).toHaveLength(2);
  await act(async () => switches[1].resolve());
  await expect.element(page.getByText("Sheet closed", { exact: true })).toBeVisible();
});

test("offers the successor flow instead", async () => {
  const onNewTask = mount([]);
  await page.getByTestId("profile-switch-new-task").click();
  expect(onNewTask).toHaveBeenCalledTimes(1);
});
