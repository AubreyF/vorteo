import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type {
  SessionHostJob,
  SessionHostOperation,
} from "@getpaseo/protocol/session-host-maintenance";
import type { InstallationPanelModel } from "./panel-model";
import type { RestartSummary } from "@getpaseo/protocol/execution-installation";
import { InstallationControls, InstallationRestartBanner } from "./panel";
import { sessionHostJobFixture, sessionHostStatusFixture } from "./session-host-review.fixture";
import type { SessionHostAction, SessionHostOverview } from "./session-host-review";

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
// Supply the absolute-fill constant the shared style stub omits, for disabled-action overlays.
vi.mock("react-native-unistyles", async (original) => {
  const actual = await original<typeof import("react-native-unistyles")>();
  return {
    ...actual,
    StyleSheet: {
      ...actual.StyleSheet,
      absoluteFillObject: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
    },
  };
});

let overview: SessionHostOverview | null = { jobs: [], status: sessionHostStatusFixture };
let summary: RestartSummary | null = null;
const requests: { operation: SessionHostOperation; reason: string }[] = [];
const decisions: { job: SessionHostJob; decision: SessionHostAction }[] = [];
const forbidden = () => {
  throw new Error("No restart decisions or login in this fixture");
};
const client: ConstructorParameters<typeof InstallationPanelModel>[0] = {
  passwordFile: null,
  sessionsSupported: true,
  restoreSession: vi.fn(async () => true),
  unlock: vi.fn(forbidden),
  lock: vi.fn(async () => {}),
  restartSummary: vi.fn(async () => summary),
  listRestarts: vi.fn(async () => []),
  listHelpers: vi.fn(async () => []),
  listMonitors: vi.fn(async () => []),
  profileSharingStatus: vi.fn(async () => null),
  resolveProfileConflict: vi.fn(forbidden),
  decide: vi.fn(forbidden),
  decideHelper: vi.fn(forbidden),
  sessionHost: vi.fn(async () => overview),
  requestSessionHost: vi.fn(async (operation: SessionHostOperation, reason: string) => {
    requests.push({ operation, reason });
    const job: SessionHostJob = {
      ...sessionHostJobFixture,
      operation,
      plan: { ...sessionHostJobFixture.plan, operation },
    };
    overview = { ...overview!, jobs: [job] };
    return job;
  }),
  decideSessionHost: vi.fn(async (job: SessionHostJob, decision: SessionHostAction) => {
    decisions.push({ job, decision });
    const result: SessionHostJob = {
      ...job,
      status: decision === "approve" ? "approved" : "rejected",
      stage: decision === "approve" ? "dispatch_pending" : "prepared",
    };
    overview = { ...overview!, jobs: [result] };
    return result;
  }),
};

function assertUnclipped(card: HTMLElement, width: number) {
  const bounds = card.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  // Text ranges expose clipped long paths and digests even when the card itself fits.
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects()) {
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    }
  }
  for (const button of card.querySelectorAll<HTMLElement>('[role="button"]')) {
    expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(width === 390 ? 44 : 32);
  }
}

test("the session host card requests, reviews and decides exact plans at desktop and 390px", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  container.style.cssText = "max-width:720px;margin:0 auto;padding:16px;box-sizing:border-box";
  document.body.style.margin = "0";
  document.body.append(container);
  const root = createRoot(container);
  const render = (width: number) => act(() => root.render(<InstallationControls key={width} />));
  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const disabled = (id: string) => byTestId(id)?.getAttribute("aria-disabled") === "true";
  const press = async (id: string) => {
    await act(async () => {
      await page.getByTestId(id).click();
    });
  };
  try {
    render(1280);
    const model = await vi.waitFor(() => {
      expect(capture.model).toBeDefined();
      return capture.model!;
    });
    await act(() => model.initialize());

    for (const width of [1280, 390]) {
      overview = { jobs: [], status: sessionHostStatusFixture };
      requests.length = 0;
      decisions.length = 0;
      await page.viewport(width, 900);
      render(width);
      await act(() => model.refresh());

      const card = byTestId("session-host-card")!;
      expect(card.checkVisibility()).toBe(true);
      for (const line of [
        "Installed: no",
        "Loaded: no",
        "Process: none",
        "Last exit: none",
        "Runs: unknown",
        "Host release: not answering",
        "Hosted sessions: unknown",
        "Durable sessions setting: off",
      ])
        expect(card.textContent).toContain(line);
      expect(disabled("session-host-install")).toBe(false);
      expect(disabled("session-host-remove")).toBe(true);
      assertUnclipped(card, width);

      // Install only prepares a plan; nothing is approved yet.
      await press("session-host-install");
      expect(requests).toEqual([
        {
          operation: "session-host-install",
          reason: "Requested by the owner from Installation controls.",
        },
      ]);
      expect(decisions).toEqual([]);
      const job = overview!.jobs[0]!;
      const row = byTestId(`session-host-request-${job.id}`)!;
      expect(row.textContent).toContain("Install the session host job");
      for (const line of [
        `Label: ${job.plan.label}`,
        `Plist: ${job.plan.plistPath}`,
        `Node: ${job.plan.node}`,
        `Entrypoint: ${job.plan.entrypoint}`,
        `Working directory: ${job.plan.workingDirectory}`,
        `PASEO_HOME: ${job.plan.paseoHome}`,
        `HOME: ${job.plan.environment.HOME}`,
        `PATH: ${job.plan.environment.PATH}`,
        `Log: ${job.plan.logPath}`,
        `Plist SHA-256: ${job.plan.plistSha256}`,
        `Plan: ${job.planSha256}`,
      ])
        expect(row.textContent).toContain(line);
      // A second request cannot be opened while this one awaits a decision.
      expect(disabled("session-host-install")).toBe(true);
      expect(disabled(`session-host-${job.id}-approve`)).toBe(false);
      expect(disabled(`session-host-${job.id}-cancel`)).toBe(false);
      await page.screenshot({
        path: `../../../../output/playwright/session-host-${width}-pending.png`,
        fullPage: true,
      });
      assertUnclipped(row, width);

      await press(`session-host-${job.id}-approve`);
      expect(decisions).toEqual([{ job, decision: "approve" }]);
      // Approved and waiting for dispatch: no second approval, cancellation still possible.
      expect(disabled(`session-host-${job.id}-approve`)).toBe(true);
      expect(disabled(`session-host-${job.id}-cancel`)).toBe(false);
    }

    // A coordinator without session host jobs: the card disappears.
    overview = null;
    await act(() => model.refresh());
    expect(byTestId("session-host-card")).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
}, 60_000);

test("removal is refused in the card while durable sessions are on or sessions run", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const installed = {
    ...sessionHostStatusFixture.detail!,
    plist: "matching" as const,
    loaded: true,
    pid: 4242,
    lastExitStatus: 0,
    runs: 1,
    host: { pid: 4242, release: "0.11.0-beta.3.vorteo.707", sessions: 1 },
    settingEnabled: true,
  };
  overview = { jobs: [], status: { supported: true, installed: true, detail: installed } };
  try {
    act(() => root.render(<InstallationControls key="removal" />));
    const model = await vi.waitFor(() => {
      expect(capture.model).toBeDefined();
      return capture.model!;
    });
    await act(() => model.initialize());
    await act(() => model.refresh());
    const remove = container.querySelector<HTMLElement>('[data-testid="session-host-remove"]')!;
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("Process: 4242");
    expect(container.textContent).toContain("Durable sessions setting: on");
    // The model refuses even if a stale button is pressed, and explains why.
    requests.length = 0;
    await act(() => model.requestSessionHost("session-host-remove"));
    expect(requests).toEqual([]);
    expect(container.textContent).toContain("Turn off durable sessions first");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

test("an uninspectable session host keeps its jobs reviewable and blocks new requests", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const job = sessionHostJobFixture;
  overview = { jobs: [job], status: null };
  try {
    act(() => root.render(<InstallationControls key="unavailable" />));
    const model = await vi.waitFor(() => {
      expect(capture.model).toBeDefined();
      return capture.model!;
    });
    await act(() => model.initialize());
    await act(() => model.refresh());
    const attribute = (id: string) =>
      container.querySelector(`[data-testid="${id}"]`)?.getAttribute("aria-disabled");
    expect(container.querySelector('[data-testid="session-host-status"]')?.textContent).toBe(
      "Status unavailable",
    );
    expect(attribute("session-host-install")).toBe("true");
    expect(attribute("session-host-remove")).toBe("true");
    expect(container.textContent).toContain(`Plan: ${job.planSha256}`);
    expect(attribute(`session-host-${job.id}-approve`)).not.toBe("true");
    expect(attribute(`session-host-${job.id}-cancel`)).not.toBe("true");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

// Last: it locks the shared panel model.
test("a pending session host request raises the floating notice while controls are locked", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const idle = { requested: 0, queued: 0, running: 0 };
  try {
    act(() => root.render(<InstallationControls key="banner" />));
    const model = await vi.waitFor(() => {
      expect(capture.model).toBeDefined();
      return capture.model!;
    });
    await act(() => model.initialize());
    await act(() => model.lock());
    act(() => root.render(<InstallationRestartBanner placement="floating" />));
    const banner = () =>
      container.querySelector<HTMLElement>('[data-testid="installation-restart-banner"]');

    summary = { ...idle, sessionHost: { requested: 1, queued: 0, running: 0 } };
    await act(() => model.refresh());
    expect(banner()?.textContent).toContain("1 session host requests need attention.");
    expect(banner()?.textContent).toContain("Review restart");

    // Queued or running work is reported in the sidebar row, not as a floating call to action.
    summary = { ...idle, sessionHost: { requested: 0, queued: 1, running: 0 } };
    await act(() => model.refresh());
    expect(banner()?.textContent ?? "").not.toContain("session host requests");

    summary = { ...idle, sessionHost: { requested: 0, queued: 0, running: 0 } };
    await act(() => model.refresh());
    expect(banner()?.textContent ?? "").not.toContain("session host requests");
  } finally {
    summary = null;
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
