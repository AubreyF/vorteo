import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { afterEach, expect, inject, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import { InstallationConnectionCheckSection } from "./connection-check-section";
import type { ConnectionSession } from "./connection-check";
import {
  diagnoseConnection,
  inspectConnectionDevice,
  probeDiagnosticSocket,
} from "./connection-diagnostics";

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
      await expect.poll(() => row.textContent).toContain("Reached");
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

test("real WebSocket transport and device diagnostics appear in the selectable report", async () => {
  const container = render();
  await page.getByRole("button", { name: "Check connection", exact: true }).click();
  await expect.poll(() => container.textContent).toContain("WebSocket handshake accepted");
  await page.getByRole("button", { name: "Show report", exact: true }).click();
  const report = container.querySelector('[data-testid="connection-diagnostic-report"]')!;
  expect(report.textContent).toContain("vorteo-connection-diagnostics-v1");
  expect(report.textContent).toContain('"websocket"');
  expect(report.textContent).toContain('"browser"');
  expect(report.textContent).toContain('"authentication"');
  expect(container.textContent).toContain("Browser local-network permission");
});
test("cross-origin rejection retains uncertainty while WebSocket proves transport access", async () => {
  const origin = new URL(inject("passwordlessRelayUrl").replace("ws:", "http:")).origin;
  const result = await diagnoseConnection(
    { id: "host", label: "Host", url: `${origin}/cors-restricted-health`, serverId: "host-test" },
    sessionFor,
    new AbortController().signal,
  );
  expect(result.failure).toBe("network");
  expect(result.crossOrigin?.state).toBe("unknown");
  expect(result.socket?.state).toBe("passed");
});
test("cancelled socket checks finish and release their connection", async () => {
  const abort = new AbortController();
  abort.abort();
  const result = await probeDiagnosticSocket(inject("passwordlessRelayUrl"), abort.signal);
  expect(result.state).toBe("unknown");
  expect(result.detail).toBe("Check cancelled");
  expect((await inspectConnectionDevice()).secureContext).toBe(true);
});

test("clipboard denial shows a selectable report without losing diagnostic results", async () => {
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  try {
    const container = render();
    await page.getByRole("button", { name: "Check connection", exact: true }).click();
    await expect.poll(() => container.textContent).toContain("WebSocket handshake accepted");
    await page.getByRole("button", { name: "Copy diagnostic report", exact: true }).click();
    await expect.poll(() => container.textContent).toContain("Clipboard access failed");
    expect(
      container.querySelector('[data-testid="connection-diagnostic-report"]')?.textContent,
    ).toContain("vorteo-connection-diagnostics-v1");
    expect(container.textContent).toContain("Reached");
  } finally {
    write.mockRestore();
  }
});

test.each(["report", "enforce"] as const)(
  "only enforced browser policy is reported as a block: %s",
  async (disposition) => {
    const origin = new URL(inject("passwordlessRelayUrl").replace("ws:", "http:")).origin;
    const pending = diagnoseConnection(
      { id: "host", label: "Host", url: `${origin}/api/health`, serverId: "host-test" },
      sessionFor,
      new AbortController().signal,
    );
    window.dispatchEvent(
      new SecurityPolicyViolationEvent("securitypolicyviolation", {
        blockedURI: origin,
        effectiveDirective: "connect-src",
        disposition,
      }),
    );
    const result = await pending;
    expect(result.policy).toEqual(disposition === "enforce" ? ["connect-src"] : []);
  },
);
