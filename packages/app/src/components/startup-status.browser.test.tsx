import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { StartupStatus } from "./startup-status";

// Expo Router needs its app bundler. Navigation is outside this loader test;
// fail any attempt rather than letting a routing stub conceal a route change.
vi.mock("expo-router", () => ({
  usePathname: () => "/",
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
  useRouter() {
    throw new Error("Unexpected navigation hook during startup diagnostics");
  },
  router: {
    push() {
      throw new Error("Unexpected navigation during startup diagnostics");
    },
    replace() {
      throw new Error("Unexpected navigation during startup diagnostics");
    },
    navigate() {
      throw new Error("Unexpected navigation during startup diagnostics");
    },
  },
}));

let mounted: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => mounted?.unmount());
  container?.remove();
  Reflect.deleteProperty(globalThis, "__VORTEO_EXECUTION_INSTALLATION__");
});

test.each([390, 1133])(
  "the delayed host loader makes the connection check and reload reachable at width %s",
  async (width) => {
    await page.viewport(width, 844);
    Reflect.set(globalThis, "__VORTEO_EXECUTION_INSTALLATION__", {
      version: 1,
      installationId: "00000000-0000-4000-8000-000000000001",
      origin: window.location.origin,
      environments: [
        { kind: "host", serverId: "host-test", endpoint: "127.0.0.1:44445", useTls: false },
        { kind: "container", serverId: "dev-test", endpoint: "127.0.0.1:44446", useTls: false },
      ],
    });
    container = document.createElement("div");
    container.style.cssText = "height:100vh;display:flex;align-items:center;justify-content:center";
    document.body.appendChild(container);
    mounted = createRoot(container);
    act(() => mounted?.render(<StartupStatus phase="host" />));
    expect(container.textContent).not.toContain("Check connection");
    await expect
      .poll(() => container?.textContent, { timeout: 15000 })
      .toContain("Interface assets: running");
    const check = page.getByRole("button", { name: "Check connection", exact: true });
    await expect.element(check).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
    expect(container.textContent).toContain("Host");
    expect(container.textContent).toContain("Dev");
    const reload = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (button) => button.textContent === "Reload",
    );
    if (!reload) throw new Error("Reload action missing");
    reload.scrollIntoView({ block: "nearest" });
    const viewport = container.querySelector('[data-testid="startup-diagnostics"]');
    if (!viewport) throw new Error("Scrollable diagnostics missing");
    expect(reload.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      viewport.getBoundingClientRect().bottom,
    );
    expect(reload.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      viewport.getBoundingClientRect().top,
    );
    expect(reload.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `startup-host-${width}.png` });
  },
  20000,
);
