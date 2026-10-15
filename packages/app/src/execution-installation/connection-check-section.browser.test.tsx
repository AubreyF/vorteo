import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { afterEach, expect, inject, test } from "vitest";
import { page } from "vitest/browser";
import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import { InstallationConnectionCheckSection } from "./connection-check-section";
import type { ConnectionSession } from "./connection-check";

declare module "vitest" {
  interface ProvidedContext {
    passwordlessRelayUrl: string;
  }
}
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});
function sessionFor(id: string): ConnectionSession {
  return {
    state: id === "host-test" ? "offline" : "online",
    authentication: id === "host-test" ? "incorrect_password" : null,
    endpoint: "127.0.0.1:44445",
  };
}
function installationFixture(wrongIdentity: boolean): ExecutionInstallation {
  const origin = new URL(inject("passwordlessRelayUrl").replace("ws:", "http:")).origin;
  const installation: ExecutionInstallation = {
    version: 1,
    installationId: wrongIdentity
      ? "00000000-0000-4000-8000-000000000002"
      : "00000000-0000-4000-8000-000000000001",
    origin,
    environments: [
      { kind: "host", serverId: "host-test", endpoint: new URL(origin).host, useTls: false },
      { kind: "container", serverId: "dev-test", endpoint: new URL(origin).host, useTls: false },
    ],
  };
  return installation;
}

function render(wrongIdentity = false) {
  const installation = installationFixture(wrongIdentity);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() =>
    root.render(
      <InstallationConnectionCheckSection installation={installation} sessionFor={sessionFor} />,
    ),
  );
  return container;
}

test.each([390, 1133])(
  "the health button checks real HTTP and distinguishes authentication at width %s",
  async (width) => {
    await page.viewport(width, 1000);
    const container = render();
    await page.getByRole("button", { name: "Check connection" }).click();
    await expect.poll(() => container.textContent).toContain("saved password was rejected");
    for (const id of ["installation", "host", "container"]) {
      const row = container.querySelector(`[data-testid="connection-check-${id}"]`)!;
      expect(row.textContent).toContain("Reached");
      const bounds = row.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
    }
    expect(container.textContent).toContain("Authenticated app connection is online");
    expect(container.textContent).toContain("Checked");
    expect(container.textContent).not.toContain("Restart");
    const button = Array.from(container.querySelectorAll('[role="button"]')).find(
      (element) => element.textContent === "Check connection",
    )!;
    await expect.poll(() => button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    if (width === 390) await page.screenshot({ path: "connection-check-phone.png" });
  },
);

test("one failed installation identity does not hide the other connection results", async () => {
  const container = render(true);
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect
    .poll(() => container.textContent)
    .toContain("different or unrecognized installation");
  expect(
    container.querySelector('[data-testid="connection-check-installation"]')?.textContent,
  ).toContain("Failed");
  await expect
    .poll(() => container.querySelector('[data-testid="connection-check-host"]')?.textContent)
    .toContain("Reached");
});
