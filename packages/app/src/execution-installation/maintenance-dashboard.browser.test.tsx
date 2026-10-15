import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import type { InstallationEnrollmentStatus } from "@getpaseo/protocol/installation-enrollment";
import { MaintenanceDashboard } from "./maintenance-dashboard";
import {
  MaintenanceServiceQueue,
  type MaintenanceServiceQueueProps,
} from "./maintenance-service-queue";
import type { MaintenanceServiceView } from "@getpaseo/protocol/maintenance-service-status";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let refreshCount = 0;
function recordRefresh() {
  refreshCount++;
}
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function status(): InstallationEnrollmentStatus {
  return {
    version: 1,
    installationId: "00000000-0000-4000-8000-000000000001",
    checkedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    authority: "active",
    grantRevision: "00000000-0000-4000-8000-000000000002",
    activation: "verified",
    completedSteps: 2,
    totalSteps: 2,
    services: [
      {
        target: "host",
        enabled: true,
        readiness: "ready",
        reason: "Host identity and readiness verified.",
        observedAt: "2026-10-15T12:00:00.000Z",
        selectedSource: "a".repeat(40),
      },
      {
        target: "container-daemon",
        enabled: true,
        readiness: "unknown",
        reason: "Current service readiness has not been verified.",
        observedAt: null,
        selectedSource: null,
      },
    ],
    steps: [],
  };
}

function renderDashboard(input: { status: InstallationEnrollmentStatus; error?: string }) {
  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.maxWidth = "760px";
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  refreshCount = 0;
  act(() =>
    root.render(
      <MaintenanceDashboard
        status={input.status}
        error={input.error ?? null}
        refreshing={false}
        onRefresh={recordRefresh}
      />,
    ),
  );
  return { container, refreshes: () => refreshCount };
}

test.each([390, 1133])(
  "readiness stays distinct from recorded activation at width %s",
  async (width) => {
    await page.viewport(width, 900);
    const view = renderDashboard({ status: status() });
    const headline = view.container.querySelector('[data-testid="installation-health-headline"]');
    expect(headline?.textContent).toContain("Readiness unverified");
    expect(view.container.textContent).toContain("2 of 2 steps verified");
    expect(view.container.textContent).toContain("Current service readiness has not been verified");
    const rows = view.container.querySelectorAll('[data-testid^="maintenance-service-"]');
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
    }
    await page.getByRole("button", { name: "Refresh status" }).click();
    expect(view.refreshes()).toBe(1);
    expect(view.container.textContent).not.toContain("Approve");
  },
);

test("an unconfirmed effect is never presented as a running or completed update", () => {
  const current = status();
  current.activation = "unconfirmed";
  current.completedSteps = 1;
  const view = renderDashboard({ status: current });
  expect(view.container.textContent).toContain("Verifying outcome");
  expect(view.container.textContent).toContain("will not be dispatched again");
  expect(view.container.textContent).toContain("1 of 2 steps verified");
});

test("a refresh failure marks retained health as last known instead of ready", () => {
  const current = status();
  current.services[1].readiness = "ready";
  const view = renderDashboard({
    status: current,
    error: "Maintenance service could not be reached.",
  });
  const headline = view.container.querySelector('[data-testid="installation-health-headline"]');
  expect(headline?.textContent).toContain("Status unavailable");
  expect(headline?.textContent).not.toContain("Ready");
  expect(view.container.textContent).toContain("Last known status is shown");
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
    "could not be reached",
  );
});

test("cached readiness expires without a server response", async () => {
  const current = status();
  current.services[1].readiness = "ready";
  current.validUntil = new Date(Date.now() + 200).toISOString();
  const view = renderDashboard({ status: current });
  const headline = view.container.querySelector('[data-testid="installation-health-headline"]');
  expect(headline?.textContent).toContain("Ready");
  await expect.poll(() => headline?.textContent).toContain("Readiness unverified");
  expect(view.container.textContent).toContain("Last known observation has expired");
});

test.each([390, 1133])(
  "maintenance requests show durable uncertainty and cancellation at width %s",
  async (width) => {
    await page.viewport(width, 900);
    const job: MaintenanceServiceView = {
      id: "00000000-0000-4000-8000-000000000001",
      revision: "00000000-0000-4000-8000-000000000002",
      target: "maintenance-controller",
      operation: "replacement",
      reason: "Update maintenance controller",
      createdAt: "2026-10-15T20:00:00.000Z",
      status: "approved",
      detail: "Cancellation remains available before dispatch.",
      cancelable: true,
      dispatchAfter: "2026-10-15T20:00:30.000Z",
      generation: null,
      outcome: null,
      observedAt: null,
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    let cancelled: MaintenanceServiceView | null = null;
    function recordCancel(value: MaintenanceServiceView) {
      cancelled = value;
    }
    function render(error: string | null, current = job) {
      const queueStatus = { installationId: job.id, available: true, jobs: [current] };
      renderServiceQueue(root, {
        status: queueStatus,
        error,
        refreshing: false,
        busy: false,
        onRefresh: recordRefresh,
        onCancel: recordCancel,
      });
    }
    render(null);
    await page.getByRole("button", { name: "Cancel maintenance" }).click();
    expect(cancelled).toEqual(job);
    render("Connection lost during cancellation. Refresh before another attempt.");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
    await expect.element(page.getByRole("button", { name: "Cancel maintenance" })).toBeDisabled();
    render(null, {
      ...job,
      status: "running",
      cancelable: false,
      detail: "Retained generation will only be observed.",
      outcome: "unknown",
      observedAt: "2026-10-15T20:01:00.000Z",
    });
    expect(container.textContent).toContain("Outcome unverified");
    expect(container.textContent).toContain("Last checked");
    expect(container.textContent).not.toContain("Last verified");
    expect(container.textContent).not.toContain("Candidate verified");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    const bounds = container
      .querySelector('[data-testid="maintenance-request-queue"]')!
      .getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    if (width === 390) await page.screenshot({ path: "maintenance-requests-phone.png" });
  },
);

function renderServiceQueue(root: Root, props: MaintenanceServiceQueueProps) {
  act(() => root.render(<MaintenanceServiceQueue {...props} />));
}
