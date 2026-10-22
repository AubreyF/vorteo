import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { PreviewMonitorJob } from "@getpaseo/protocol/preview-monitor-maintenance";
import { InstallationPanelModel } from "./panel-model";
import type { RestartDecision, RestartJob } from "@getpaseo/protocol/execution-installation";
import { confirmDialog } from "@/utils/confirm-dialog";
import { monitorReviewFixture } from "./preview-monitor-review.fixture";
import { InstallationControls, RestartActions } from "./panel";

const capture = vi.hoisted(() => ({
  model: undefined as InstallationPanelModel | undefined,
}));
vi.mock("./panel-model", async (original) => {
  const actual = await original<typeof import("./panel-model")>();
  return {
    ...actual,
    InstallationPanelModel: class extends actual.InstallationPanelModel {
      constructor(...args: ConstructorParameters<typeof actual.InstallationPanelModel>) {
        super(...args);
        capture.model = this;
      }
    },
  };
});
vi.mock("./client", () => ({
  InstallationClient: function InstallationClientFixture() {
    return client;
  },
  OwnerAccessExpired: class extends Error {},
  hasInstallationConnections: () => true,
  requestInstallationOwner: () => {
    throw new Error("Unexpected owner transport");
  },
}));
vi.mock("./policy", () => ({
  readExecutionInstallation: () => ({ environments: [] }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getHosts: () => [] }),
  useHostRegistryLoaded: () => true,
}));
vi.mock("expo-router", () => ({
  // The panel's plugin navigation imports these; a missing mock export hangs browser mode.
  router: { push: vi.fn(), replace: vi.fn(), navigate: vi.fn() },
  usePathname: () => "/settings/general",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
}));
vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => false),
}));

// Supply the native absolute-fill constant omitted by the shared style stub,
// so the disabled-action explanation overlay has its production hit rectangle.
vi.mock("react-native-unistyles", async (original) => {
  const actual = await original<typeof import("react-native-unistyles")>();
  return {
    ...actual,
    StyleSheet: {
      ...actual.StyleSheet,
      absoluteFillObject: {
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      },
    },
  };
});

const reviewJob: PreviewMonitorJob = {
  ...monitorReviewFixture,
  reason: "Replace the Dev preview monitor with the reviewed recovery-monitor candidate.",
};
let current: PreviewMonitorJob = reviewJob;
const forbidden = () => {
  throw new Error("No owner decisions or login in this fixture");
};
const client: ConstructorParameters<typeof InstallationPanelModel>[0] = {
  passwordFile: null,
  sessionsSupported: true,
  restoreSession: vi.fn(async () => true),
  unlock: vi.fn(forbidden),
  lock: vi.fn(async () => {}),
  restartSummary: vi.fn(async () => null),
  listRestarts: vi.fn(async () => []),
  listHelpers: vi.fn(async () => []),
  listMonitors: vi.fn(async () => [current]),
  profileSharingStatus: vi.fn(async () => null),
  resolveProfileConflict: vi.fn(forbidden),
  decide: vi.fn(forbidden),
  decideHelper: vi.fn(forbidden),
  decideMonitor: vi.fn(forbidden),
};

function assertUnclipped(card: HTMLElement, width: number) {
  const bounds = card.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  // Text ranges expose clipped long digests even when the containing card fits.
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects()) {
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      expect(rect.top).toBeGreaterThanOrEqual(bounds.top - 1);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    }
  }
  for (const button of card.querySelectorAll<HTMLElement>('[role="button"]')) {
    expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(width === 390 ? 44 : 32);
  }
}

test("production monitor review preserves exact evidence and manual gates at desktop and 390px", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  container.style.cssText = "max-width:720px;margin:0 auto;padding:16px;box-sizing:border-box";
  document.body.style.margin = "0";
  document.body.append(container);
  const root = createRoot(container);
  const render = (width: number) => act(() => root.render(<InstallationControls key={width} />));
  const button = (action: string) =>
    container.querySelector<HTMLElement>(`[data-testid="monitor-${current.id}-${action}"]`);
  try {
    for (const width of [1280, 390]) {
      await page.viewport(width, 900);
      expect(window.innerWidth).toBe(width);
      render(width);
      expect(container.textContent).toContain("Checking owner access...");
      expect(button("approve")).toBeNull();
      expect(button("cancel")).toBeNull();
      await page.screenshot({
        path: `../../../../output/playwright/monitor-${width}-checking.png`,
        fullPage: true,
      });
    }
    const model = capture.model!;
    await act(() => model.initialize());
    for (const width of [1280, 390]) {
      await page.viewport(width, 900);
      expect(window.innerWidth).toBe(width);
      render(width);
      for (const [status, stage] of [
        ["pending", "preparing"],
        ["pending", "prepared"],
        ["approved", "prepared"],
        ["running", "dispatch_pending"],
        ["failed", "recovery_required"],
      ] as const) {
        current = { ...reviewJob, status, stage };
        await act(() => model.refresh());
        const details = page.getByRole("button", {
          name: "Details",
          exact: true,
        });
        if (!container.textContent?.includes(`Candidate: ${current.plan.candidate.sha256}`)) {
          await act(async () => {
            await details.click();
          });
        }
        const card = container.querySelector<HTMLElement>(
          `[data-testid="monitor-request-${current.id}"]`,
        )!;
        expect(card.checkVisibility()).toBe(true);
        await expect.element(page.getByText(current.reason, { exact: true })).toBeVisible();
        for (const value of [
          current.reason,
          current.detail,
          `Container: ${current.plan.containerId}`,
          `Target: ${current.plan.destination}`,
          `Source: ${current.plan.sourceCommit}`,
          `Candidate: ${current.plan.candidate.sha256}`,
          `Retained before: ${current.plan.previous.sha256}`,
          `Ancestry: ${current.plan.ancestrySha256}`,
          `Plan: ${current.planSha256}`,
          "Owner: root:root, mode 0755",
        ]) {
          expect(card.textContent).toContain(value);
        }
        if (status === "pending" || status === "approved") {
          expect(button("approve")).not.toBeNull();
          expect(button("cancel")).not.toBeNull();
          expect(button("cancel")?.getAttribute("aria-disabled")).not.toBe("true");
          expect(button("approve")?.getAttribute("aria-disabled") === "true").toBe(
            status !== "pending" || stage !== "prepared",
          );
        } else {
          expect(button("approve")).toBeNull();
          expect(button("cancel")).toBeNull();
        }
        if (stage === "recovery_required") {
          expect(card.textContent).toContain("Never replay or roll back automatically.");
          expect(card.textContent).toContain("Needs inspection");
        }
        await page.screenshot({
          path: `../../../../output/playwright/monitor-${width}-${status}-${stage}.png`,
          fullPage: true,
        });
        assertUnclipped(card, width);
      }
    }
    await act(() => model.lock());
    for (const width of [1280, 390]) {
      await page.viewport(width, 900);
      expect(window.innerWidth).toBe(width);
      render(width);
      expect(container.textContent).toContain("Owner locked");
      expect(container.querySelector('[data-testid^="monitor-request-"]')).toBeNull();
      expect(button("approve")).toBeNull();
      expect(button("cancel")).toBeNull();
      await page.screenshot({
        path: `../../../../output/playwright/monitor-${width}-locked.png`,
        fullPage: true,
      });
    }
    for (const method of [
      client.unlock,
      client.decide,
      client.decideHelper,
      client.decideMonitor,
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
}, 30_000);

test.each([1280, 390])(
  "pending Host restart requires confirmation and sends only approve at %spx",
  async (width) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(width, 900);
    const job: RestartJob = {
      id: "host-service-restart",
      revision: "reviewed-revision",
      target: "host",
      requestedBy: "host-agent",
      reason: "Activate the selected Host service release.",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "9999-12-31T23:59:59.999Z",
      status: "pending",
      detail: "Approval required",
    };
    const decisions: Array<{ job: RestartJob; decision: RestartDecision }> = [];
    const model = new InstallationPanelModel({
      ...client,
      listRestarts: async () => [job],
      listMonitors: async () => [],
      decide: async (selected, decision) => {
        decisions.push({ job: selected, decision });
      },
    });
    const container = document.createElement("div");
    container.style.cssText = "max-width:720px;margin:0 auto;padding:16px;box-sizing:border-box";
    document.body.append(container);
    const root = createRoot(container);
    const render = (selected: RestartJob, busy = false, historical = false) =>
      act(() =>
        root.render(
          <RestartActions job={selected} model={model} busy={busy} historical={historical} />,
        ),
      );
    try {
      await model.initialize();
      render(job);
      const force = page.getByTestId(`restart-force-${job.id}`);
      await expect.element(force).toBeVisible();
      vi.mocked(confirmDialog).mockClear();
      vi.mocked(confirmDialog).mockResolvedValueOnce(false);
      await act(async () => {
        await force.click();
      });
      expect(confirmDialog).toHaveBeenLastCalledWith({
        title: "Force restart Host?",
        message: "Running tasks will be interrupted and terminals may disconnect.",
        confirmLabel: "Force restart now",
        destructive: true,
      });
      expect(decisions).toEqual([]);
      vi.mocked(confirmDialog).mockResolvedValueOnce(true);
      await act(async () => {
        await force.click();
      });
      await expect.poll(() => decisions).toEqual([{ job, decision: "approve" }]);
      await page.screenshot({ path: `host-service-restart-${width}.png`, fullPage: true });
      assertUnclipped(container, width);
      render(job, true);
      await expect.element(force).toBeDisabled();
      for (const excluded of [
        { ...job, target: "container-daemon" as const },
        {
          ...job,
          update: {
            sourceCommit: "a".repeat(40),
            baseCommit: "b".repeat(40),
            sha256: "c".repeat(64),
            bytes: 12,
          },
        },
        { ...job, sourceBatch: { status: "ready" as const, contributions: [] } },
        { ...job, supervisorPlanSha256: "d".repeat(64) },
        { ...job, factoryRuntimePlanSha256: "e".repeat(64) },
        { ...job, status: "approved" as const, whenIdle: true },
        { ...job, status: "succeeded" as const },
      ]) {
        render(excluded);
        expect(container.querySelector('[data-testid^="restart-force-"]')).toBeNull();
      }
      render(job, false, true);
      expect(container.querySelector('[data-testid^="restart-force-"]')).toBeNull();
      expect(decisions).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
