import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { VORTEO_INSTALL_COMMAND } from "@/execution-installation/install-command";
import { LegacyInstallationCard } from "./legacy-installation-card";

vi.mock("@/utils/copy-to-clipboard", () => ({ copyToClipboard: vi.fn() }));

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

function mount(copy: (text: string) => Promise<unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<LegacyInstallationCard copy={copy} />));
}

test.each([1280, 390])("explains the one command and copies it at %ipx", async (width) => {
  await page.viewport(width, 800);
  const copy = vi.fn(async () => undefined);
  mount(copy);
  const card = document.querySelector<HTMLElement>('[data-testid="vorton-legacy-installation"]')!;
  expect(card.textContent).toContain("predates Host environments");
  expect(card.textContent).toContain("computer that runs Docker");
  expect(card.textContent).toContain("keeps this Dev environment, its agents and files");
  expect(card.textContent).not.toContain("Connect this installation's host environment");
  expect(
    document.querySelector('[data-testid="vorton-legacy-install-command-text"]')!.textContent,
  ).toBe(
    "curl -fsSL https://github.com/terran-labs/vorteo/releases/latest/download/install.sh | bash",
  );
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const button = document.querySelector<HTMLElement>(
    '[data-testid="vorton-legacy-install-command-copy"]',
  )!;
  await act(async () => button.click());
  expect(copy).toHaveBeenCalledWith(VORTEO_INSTALL_COMMAND);
  expect(button.textContent).toBe("Copied");
});

test("a refused copy asks the owner to copy the command manually", async () => {
  await page.viewport(1280, 800);
  mount(async () => {
    throw new Error("denied");
  });
  await act(async () =>
    document
      .querySelector<HTMLElement>('[data-testid="vorton-legacy-install-command-copy"]')!
      .click(),
  );
  expect(document.querySelector('[role="alert"]')!.textContent).toContain("copy it manually");
});
