import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type {
  CoordinatorBootstrapRequest,
  CoordinatorBootstrapDecision,
  BootstrapPreclaimRecoveryRequestView as BootstrapPreclaimRecoveryRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapPanelModel } from "./bootstrap-model";
import { BootstrapReview, PreclaimRecoveryReview } from "./bootstrap-panel";

vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => null }),
}));
vi.mock("./policy", () => ({ readExecutionInstallation: () => null }));

// Match the existing monitor review fixture: the shared Unistyles stub omits this native constant.
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

function requestFixture(): CoordinatorBootstrapRequest {
  const file = { path: "/protected/file", sha256: "a".repeat(64) };
  const release = {
    sourceCommit: "b".repeat(40),
    directory: "/protected/immutable-candidate",
    artifactSha256: "c".repeat(64),
    node: file,
    entrypoint: file,
    configuration: file,
    launcher: file,
  };
  return {
    id: "00000000-0000-4000-8000-000000000001",
    revision: "00000000-0000-4000-8000-000000000002",
    planSha256: "d".repeat(64),
    requestedBy: "host-agent",
    status: "pending",
    reason: "Select reviewed source update tooling",
    createdAt: "2026-10-11T20:00:00.000Z",
    plan: {
      version: 1,
      operation: "coordinator-bootstrap",
      installationId: "00000000-0000-4000-8000-000000000003",
      service: "gui/501/local.vorteo.fixture.installation",
      sourceUpdateTooling: true,
      hostRequestsAfter: null,
      previous: release,
      candidate: release,
      expectedProcess: {
        pid: 123,
        bootId: "fixture",
        startIdentity: "fixture",
        argumentsSha256: "e".repeat(64),
      },
      state: {
        directory: "/protected/state",
        restartJournal: "/protected/state/restarts.json",
        ownerSessions: "/protected/state/owners.json",
      },
    },
  };
}

test.each([1280, 390])(
  "source tooling owner review shows exact immutable selection and manual decisions at %ipx",
  async (width) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(width, 1000);
    const initial = requestFixture();
    let current = initial;
    const decide = vi.fn(async (input: CoordinatorBootstrapDecision, password: string) => {
      expect(password).toBe("disposable-owner-proof");
      current = { ...current, status: input.decision === "approve" ? "approved" : "canceled" };
      return [current];
    });
    const model = new BootstrapPanelModel(() => ({
      listCoordinatorBootstrapRequests: async () => [current],
      decideCoordinatorBootstrap: decide,
    }));
    const container = document.createElement("div");
    container.style.cssText = "max-width:720px;margin:0 auto;padding:16px;box-sizing:border-box";
    document.body.style.margin = "0";
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() => model.refresh());
      act(() => root.render(<BootstrapReview model={model} />));
      expect(decide).not.toHaveBeenCalled();
      const approve = page.getByTestId("bootstrap-approve");
      const cancel = page.getByTestId("bootstrap-cancel");
      expect(approve.element().getAttribute("aria-disabled")).toBe("true");
      expect(cancel.element().getAttribute("aria-disabled")).toBe("true");
      await act(async () => {
        await page.getByRole("button", { name: "Details", exact: true }).click();
      });
      expect(container.textContent).toContain("/protected/immutable-candidate/scripts");
      expect(container.textContent).toContain("Binding setup remains separate");
      expect(container.textContent).toContain(initial.plan.candidate.sourceCommit);
      expect(container.textContent).toContain(initial.plan.candidate.artifactSha256);
      expect(container.textContent).toContain(initial.planSha256);
      expect(container.textContent).toContain(initial.revision);
      const card = container.querySelector<HTMLElement>(
        `[data-testid="coordinator-bootstrap-${initial.id}"]`,
      )!;
      expect(card.checkVisibility()).toBe(true);
      expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      await page.screenshot({
        path: `../../../../output/playwright/source-update-tooling-${width}-review.png`,
        fullPage: true,
      });
      for (const action of ["approve", "cancel"] as const) {
        current = initial;
        await act(() => model.refresh());
        await act(async () => {
          await page
            .getByLabelText("Coordinator maintenance owner password")
            .fill("disposable-owner-proof");
        });
        expect(decide).toHaveBeenCalledTimes(action === "approve" ? 0 : 1);
        await act(async () => {
          await page.getByTestId(`bootstrap-${action}`).click();
          // Move off the disabled decision wrapper before it can open a hover tooltip.
          await page.getByTestId("coordinator-bootstrap-review").hover();
        });
        expect(decide).toHaveBeenLastCalledWith(
          {
            id: initial.id,
            revision: initial.revision,
            planSha256: initial.planSha256,
            decision: action,
          },
          "disposable-owner-proof",
        );
        expect(current.status).toBe(action === "approve" ? "approved" : "canceled");
      }
      expect(decide).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

// Browser rendering with an explicit review-client port. This does not exercise
// native lifecycle admission or establish an installed recovery receipt.
test.each([1280, 390])(
  "recovery owner controls preserve exact decisions at %ipx",
  async (width) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(width, 1100);
    const original = {
      ...requestFixture(),
      status: "approved" as const,
      decisionAt: "2026-10-11T20:01:00.000Z",
    };
    const file = original.plan.candidate.configuration;
    const identity = {
      ...original.plan.expectedProcess,
      parentPid: 1,
      uid: 501,
      executable: file.path,
    };
    let current: BootstrapPreclaimRecoveryRequest = {
      ...requestFixture(),
      id: "00000000-0000-4000-8000-000000000004",
      execution: undefined,
      dispatch: { state: "no_receipt" },
      reason: "Recover the exact stalled preparation",
      plan: {
        version: 1,
        operation: "bootstrap-preclaim-recovery",
        original,
        canceled: {
          ...original,
          revision: "00000000-0000-4000-8000-000000000009",
          status: "canceled",
        },
        executor: { identity, auditToken: [501, 501, 20, 501, 20, identity.pid, 1, 2] },
        hostProcess: identity,
        coordinatorProcess: identity,
        setup: file,
        ownerLauncher: file,
        runner: original.plan.candidate,
        executorEntrypoint: file,
        selectedLauncher: file,
        selectedConfiguration: file,
        executionLock: { path: "/protected/state/lock", device: "1", inode: "2" },
        signalPolicy: { terminate: "SIGTERM", escalation: "SIGKILL", graceSeconds: 10 },
      },
    };
    const initial = current;
    const sent: CoordinatorBootstrapDecision[] = [];
    const model = new BootstrapPanelModel<BootstrapPreclaimRecoveryRequest>(() => ({
      listCoordinatorBootstrapRequests: async () => [current],
      decideCoordinatorBootstrap: async (input, password) => {
        sent.push(input);
        if (password !== "disposable-owner-proof")
          throw new Error("fixture authentication refused");
        current = {
          ...current,
          status: input.decision === "approve" ? "approved" : "canceled",
          revision:
            input.decision === "approve"
              ? "00000000-0000-4000-8000-000000000007"
              : "00000000-0000-4000-8000-000000000008",
        };
        return [current];
      },
    }));
    const container = document.createElement("div");
    container.style.cssText = "max-width:720px;margin:0 auto;padding:16px;box-sizing:border-box";
    document.body.style.margin = "0";
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() => model.refresh());
      act(() => root.render(<PreclaimRecoveryReview model={model} />));
      expect(sent).toEqual([]);
      expect(
        page.getByTestId("bootstrap-recovery-approve").element().getAttribute("aria-disabled"),
      ).toBe("true");
      await act(async () => {
        await page.getByRole("button", { name: "Exact recovery details" }).click();
      });
      expect(container.textContent).toContain("This approval includes that escalation");
      expect(container.textContent).toContain(initial.planSha256);
      expect(container.textContent).toContain(initial.plan.executor.identity.startIdentity);
      const card = container.querySelector<HTMLElement>(
        `[data-testid="bootstrap-recovery-${initial.id}"]`,
      )!;
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../../output/playwright/preclaim-recovery-${width}-review.png`,
        fullPage: true,
      });
      await act(async () => {
        await page.getByLabelText("Recovery owner password").fill("incorrect");
        page
          .getByTestId("bootstrap-recovery-approve")
          .element()
          .scrollIntoView({ block: "center" });
        await page.screenshot({
          path: `../../../../output/playwright/preclaim-recovery-${width}-controls.png`,
          fullPage: true,
        });
        await page.getByTestId("bootstrap-recovery-approve").click();
      });
      expect(container.textContent).toContain("Decision unconfirmed");
      expect(current).toEqual(initial);
      expect(model.getState().hasPassword).toBe(false);
      for (const action of ["approve", "cancel"] as const) {
        const reviewed = current;
        await act(async () => {
          await page.getByLabelText("Recovery owner password").fill("disposable-owner-proof");
          await page.getByTestId(`bootstrap-recovery-${action}`).click();
        });
        expect(sent.at(-1)).toEqual({
          id: reviewed.id,
          revision: reviewed.revision,
          planSha256: reviewed.planSha256,
          decision: action,
        });
      }
      expect(container.textContent).toContain("Canceled");
      expect(model.getState().hasPassword).toBe(false);
      expect(container.querySelector('[data-testid="bootstrap-recovery-approve"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

test("coordinator review separates history and counts active waiting without dispatch", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(390, 1000);
  const active = {
    ...requestFixture(),
    status: "approved" as const,
    decisionAt: new Date(Date.now() - 65000).toISOString(),
  };
  const completed = {
    ...requestFixture(),
    id: "00000000-0000-4000-8000-000000000004",
    execution: {
      generation: "00000000-0000-4000-8000-000000000005",
      stage: "succeeded" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  const canceled = {
    ...requestFixture(),
    id: "00000000-0000-4000-8000-000000000006",
    status: "canceled" as const,
  };
  const decide = vi.fn();
  const model = new BootstrapPanelModel(() => ({
    listCoordinatorBootstrapRequests: async () => [completed, active, canceled],
    decideCoordinatorBootstrap: decide,
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => model.refresh());
    act(() => root.render(<BootstrapReview model={model} />));
    expect(container.querySelectorAll('[data-testid^="coordinator-bootstrap-000"]')).toHaveLength(
      1,
    );
    expect(page.getByTestId("coordinator-elapsed").element().textContent).toContain(
      "Awaiting dispatch: 0h 1m",
    );
    const elapsed = page.getByTestId("coordinator-elapsed").element().textContent;
    await expect
      .poll(() => page.getByTestId("coordinator-elapsed").element().textContent)
      .not.toBe(elapsed);
    await act(async () => {
      await page.getByRole("button", { name: "Show coordinator history (2)" }).click();
    });
    expect(container.querySelectorAll('[data-testid^="coordinator-bootstrap-000"]')).toHaveLength(
      3,
    );
    expect(container.querySelectorAll('[data-testid="coordinator-elapsed"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="bootstrap-cancel"]')).toHaveLength(1);
    expect(decide).not.toHaveBeenCalled();
    await page.screenshot({
      path: "../../../../output/playwright/coordinator-history-phone.png",
      fullPage: true,
    });
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
