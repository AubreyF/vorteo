import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type {
  CoordinatorBootstrapRequest,
  CoordinatorBootstrapRequestView,
  CoordinatorBootstrapDecision,
  BootstrapClaimedRecoveryRequestView,
  BootstrapPreclaimRecoveryRequestView as BootstrapPreclaimRecoveryRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { MaintenanceProvisioning } from "./maintenance-provisioning";
import { ClaimedRepairProvisioning } from "./claimed-repair-provisioning";
import { BootstrapPanelModel } from "./bootstrap-model";
import {
  BootstrapHistory,
  BootstrapReview,
  PreclaimRecoveryReview,
  ClaimedRecoveryReview,
} from "./bootstrap-panel";

vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => null }),
}));
const repairInstallation = vi.hoisted(() => ({ enabled: false }));
vi.mock("./policy", () => ({
  readExecutionInstallation: () =>
    repairInstallation.enabled
      ? { installationId: "22222222-2222-4222-8222-222222222222", origin: window.location.origin }
      : null,
}));

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

test.each([1100, 390])(
  "automatic coordinator states remain readable with cancellation at %spx",
  async (width) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(width, 1000);
    const original = requestFixture();
    let current: CoordinatorBootstrapRequestView = {
      ...original,
      plan: {
        ...original.plan,
        sourceUpdateTooling: undefined,
        automaticRecovery: "restore-compatible",
        compatibleRecovery: original.plan.previous,
      },
      status: "approved",
      decisionAt: "2026-10-15T00:00:00Z",
      automaticStatus: {
        authorization: "host-policy",
        state: "cancellation-window",
        observedAt: "2026-10-15T00:00:00Z",
        dispatchAfter: "2026-10-15T00:00:30Z",
      },
    };
    const decisions: CoordinatorBootstrapDecision[] = [];
    const model = new BootstrapPanelModel(() => ({
      listCoordinatorBootstrapRequests: async () => [current],
      decideCoordinatorBootstrap: async (input) => {
        decisions.push(input);
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
      act(() => root.render(<BootstrapReview model={model} />));
      expect(container.textContent).toContain("Automatically approved; cancellation available");
      expect(container.textContent).toContain("Dispatch cannot begin before");
      expect(page.getByTestId("coordinator-cancellation-window").element().textContent).toBe(
        "Minimum wait before dispatch: 0s",
      );
      expect(page.getByTestId("bootstrap-cancel").element().getAttribute("aria-disabled")).toBe(
        "true",
      );
      await act(async () => {
        await page
          .getByLabelText("Coordinator maintenance owner password")
          .fill("fixture-owner-proof");
      });
      expect(page.getByTestId("bootstrap-cancel").element().getAttribute("aria-disabled")).not.toBe(
        "true",
      );
      current = {
        ...current,
        automaticStatus: { ...current.automaticStatus!, state: "review-required", attempt: 3 },
      };
      await act(() => model.refresh());
      expect(container.textContent).toContain("Automatic checks stopped; review required");
      expect(container.textContent).toContain("Automatic retries have stopped");
      current = {
        ...current,
        automaticStatus: { ...current.automaticStatus!, state: "launch-unconfirmed" },
      };
      await act(() => model.refresh());
      expect(container.textContent).toContain("Launch unconfirmed; recovery review required");
      expect(container.textContent).toContain("will not launch again automatically");
      expect(container.textContent).toContain("Since authorization");
      expect(container.textContent).not.toContain("Awaiting dispatch");
      const card = container.querySelector<HTMLElement>(
        `[data-testid="coordinator-bootstrap-${current.id}"]`,
      )!;
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../../output/playwright/coordinator-automatic-status-${width}.png`,
        fullPage: true,
      });
      expect(decisions).toEqual([]);
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

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
      bootRecovery: {
        requestId: "00000000-0000-4000-8000-000000000001",
        service:
          "gui/501/local.vorteo.fixture.installation-recovery-00000000-0000-4000-8000-000000000001",
        launcher: file,
        installedLauncher: "/protected/startup.plist",
        setup: file,
        ownerLauncher: file,
        node: file,
        entrypoint: file,
      },
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
  "source tooling and startup recovery review shows exact selection and manual decisions at %ipx",
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
      expect(container.textContent).toContain("Install independent recovery for this update");
      expect(container.textContent).toContain("It cannot recover before login or retry the update");
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
          // A canceled request leaves the review for history, so hover the container.
          await page.elementLocator(container).hover();
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
    // An earlier recovery whose cleanup was verified belongs in history only.
    const finished: BootstrapPreclaimRecoveryRequest = {
      ...current,
      id: "00000000-0000-4000-8000-000000000010",
      status: "approved",
      execution: {
        generation: "00000000-0000-4000-8000-000000000011",
        stage: "succeeded",
        updatedAt: "2026-10-11T20:05:00.000Z",
      },
    };
    const sent: CoordinatorBootstrapDecision[] = [];
    const model = new BootstrapPanelModel<BootstrapPreclaimRecoveryRequest>(() => ({
      listCoordinatorBootstrapRequests: async () => [finished, current],
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
      expect(container.querySelectorAll('[data-testid^="bootstrap-recovery-0000"]')).toHaveLength(
        1,
      );
      expect(
        container.querySelector(`[data-testid="bootstrap-recovery-${finished.id}"]`),
      ).toBeNull();
      expect(sent).toEqual([]);
      expect(
        page.getByTestId("bootstrap-recovery-approve").element().getAttribute("aria-disabled"),
      ).toBe("true");
      await act(async () => {
        await page.getByRole("button", { name: "Exact recovery details" }).click();
      });
      expect(container.textContent).toContain("This approval includes that escalation");
      expect(container.textContent).toContain(initial.planSha256);
      expect(container.textContent).toContain("Retained recovery service:");
      expect(container.textContent).toContain(initial.plan.original.plan.bootRecovery!.service);
      expect(container.textContent).toContain("does not authorize another original update launch");
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
      // A canceled recovery is finished: it leaves the review for the Installation history.
      expect(current.status).toBe("canceled");
      expect(
        container.querySelector(`[data-testid="bootstrap-recovery-${initial.id}"]`),
      ).toBeNull();
      expect(model.getState().hasPassword).toBe(false);
      expect(container.querySelector('[data-testid="bootstrap-recovery-approve"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

test.each([390, 1280])(
  "coordinator history stays nested without dispatch at %ipx",
  async (width) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(width, 1000);
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
        .poll(() => page.getByTestId("coordinator-elapsed").element().textContent, {
          timeout: 3000,
        })
        .not.toBe(elapsed);
      // Finished updates render in the Installation history, never in the review.
      act(() =>
        root.render(
          <>
            <BootstrapReview model={model} />
            <BootstrapHistory model={model} />
          </>,
        ),
      );
      expect(container.querySelectorAll('[data-testid^="coordinator-bootstrap-000"]')).toHaveLength(
        3,
      );
      expect(container.querySelectorAll('[data-testid="coordinator-elapsed"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-testid="bootstrap-cancel"]')).toHaveLength(1);
      const history = page.getByTestId("coordinator-history-content").element();
      expect(history.closest('[data-testid="coordinator-bootstrap-review"]')).toBeNull();
      expect(history.querySelectorAll('[data-testid^="coordinator-bootstrap-000"]')).toHaveLength(
        2,
      );
      for (const item of history.querySelectorAll('[data-testid^="coordinator-bootstrap-000"]')) {
        expect(getComputedStyle(item).borderTopWidth).toBe("0px");
      }
      expect(decide).not.toHaveBeenCalled();
      await page.screenshot({
        path: `../../../../output/playwright/coordinator-history-${width}.png`,
        fullPage: true,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

test.each([1280, 390])(
  "claimed recovery owner controls preserve exact decisions at %ipx",
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
    let current: BootstrapClaimedRecoveryRequestView = {
      ...requestFixture(),
      id: "00000000-0000-4000-8000-000000000004",
      execution: undefined,
      dispatch: { state: "no_receipt" },
      reason: "Recover the exact stalled preparation",
      plan: {
        version: 1,
        operation: "bootstrap-claimed-recovery",
        original,
        dispatchApprovalRevision: "00000000-0000-4000-8000-000000000019",
        retainedObservation: file,
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
    const model = new BootstrapPanelModel<BootstrapClaimedRecoveryRequestView>(() => ({
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
      act(() => root.render(<ClaimedRecoveryReview model={model} />));
      expect(sent).toEqual([]);
      expect(
        page.getByTestId("bootstrap-recovery-approve").element().getAttribute("aria-disabled"),
      ).toBe("true");
      await act(async () => {
        await page.getByRole("button", { name: "Exact recovery details" }).click();
      });
      expect(container.textContent).toContain("This approval includes that escalation");
      expect(container.textContent).toContain(
        "Preserve its original approval and recovery history",
      );
      expect(container.textContent).not.toContain("Cancel original operation");
      expect(container.textContent).toContain(initial.planSha256);
      expect(container.textContent).toContain(initial.plan.executor.identity.startIdentity);
      const card = container.querySelector<HTMLElement>(
        `[data-testid="bootstrap-recovery-${initial.id}"]`,
      )!;
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../../output/playwright/claimed-recovery-${width}-review.png`,
        fullPage: true,
      });
      await act(async () => {
        await page.getByLabelText("Recovery owner password").fill("incorrect");
        page
          .getByTestId("bootstrap-recovery-approve")
          .element()
          .scrollIntoView({ block: "center" });
        await page.screenshot({
          path: `../../../../output/playwright/claimed-recovery-${width}-controls.png`,
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
      // A canceled recovery is finished: it leaves the review for the Installation history.
      expect(current.status).toBe("canceled");
      expect(
        container.querySelector(`[data-testid="bootstrap-recovery-${initial.id}"]`),
      ).toBeNull();
      expect(model.getState().hasPassword).toBe(false);
      expect(container.querySelector('[data-testid="bootstrap-recovery-approve"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

test.each([1280, 390])(
  "repair provisioning remains separate from recovery at %ipx",
  async (width) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    repairInstallation.enabled = true;
    await page.viewport(width, 1100);
    const sent: unknown[] = [];
    let admitted = false;
    const proposal = {
      admissionSha256: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      artifactSha256: "c".repeat(64),
      originalId: "33333333-3333-4333-8333-333333333333",
    };
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/status"))
        return new Response(
          JSON.stringify({
            version: 1,
            installationId: "22222222-2222-4222-8222-222222222222",
            available: admitted,
            requests: admitted ? 1 : 0,
            ...(!admitted ? { provisioning: proposal } : {}),
          }),
          { headers: { "content-type": "application/json" } },
        );
      sent.push(JSON.parse(String(init.body)));
      expect(init.credentials).toBe("same-origin");
      expect(init.redirect).toBe("error");
      admitted = true;
      return new Response(JSON.stringify({ provisioned: true }), {
        headers: { "content-type": "application/json" },
      });
    });
    const container = document.createElement("div");
    container.style.cssText = "max-width:720px;margin:0 auto;padding:16px;box-sizing:border-box";
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ClaimedRepairProvisioning />));
      await expect
        .element(page.getByRole("button", { name: "Enable repair controls" }))
        .toBeVisible();
      expect(sent).toEqual([]);
      expect(
        page
          .getByRole("button", { name: "Enable repair controls" })
          .element()
          .getAttribute("aria-disabled"),
      ).toBe("true");
      await page.getByLabelText("Repair setup owner password").fill("fixture-owner");
      await page.screenshot({
        path: `../../../../output/playwright/repair-provision-${width}.png`,
      });
      await act(async () => page.getByRole("button", { name: "Enable repair controls" }).click());
      expect(sent).toEqual([
        {
          type: "installation.claimed_repair.provision.request",
          admissionSha256: proposal.admissionSha256,
          ownerPassword: "fixture-owner",
        },
      ]);
      await expect.element(page.getByTestId("claimed-repair-provisioning")).not.toBeInTheDocument();
    } finally {
      act(() => root.unmount());
      container.remove();
      repairInstallation.enabled = false;
      vi.unstubAllGlobals();
    }
  },
);

test.each([1280, 390])(
  "independent maintenance setup preserves exact review without dispatch at %ipx",
  async (width) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    repairInstallation.enabled = true;
    await page.viewport(width, 1000);
    const original = requestFixture();
    const request = {
      ...original,
      reason: "Fixture compatible coordinator maintenance",
      plan: {
        ...original.plan,
        installationId: "22222222-2222-4222-8222-222222222222",
        sourceUpdateTooling: undefined,
        compatibleRecovery: original.plan.previous,
        automaticRecovery: "restore-compatible" as const,
      },
    };
    let phase = "unprovisioned";
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sent: Record<string, unknown>[] = [];
    const proposal = {
      admissionSha256: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      artifactSha256: "c".repeat(64),
      requestId: request.id,
    };
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/status"))
        return json({
          version: 1,
          installationId: request.plan.installationId,
          available: phase === "ready",
          requests: phase === "ready" ? 1 : 0,
          phase,
          provisioning: proposal,
        });
      const message = JSON.parse(String(init.body));
      sent.push(message);
      if (message.type === "installation.maintenance.provision.request") {
        phase = "validating";
        entered.resolve();
        await release.promise;
        phase = "ready";
        return json({ provisioned: true });
      }
      if (message.type !== "installation.bootstrap.list_requests.request")
        throw new Error("Unexpected fixture lifecycle decision");
      return json({
        type: "installation.bootstrap.list_requests.response",
        payload: { requestId: message.requestId, requests: [request], error: null },
      });
    });
    const container = document.createElement("div");
    container.style.cssText = "max-width:720px;margin:0 auto;padding:16px;box-sizing:border-box";
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<MaintenanceProvisioning />));
      await expect
        .element(page.getByRole("button", { name: "Enable maintenance controls" }))
        .toBeVisible();
      expect(sent).toEqual([]);
      await page.getByLabelText("Maintenance setup owner password").fill("fixture-owner");
      await act(async () =>
        page.getByRole("button", { name: "Enable maintenance controls" }).click(),
      );
      await entered.promise;
      await expect
        .element(page.getByRole("button", { name: "Verifying maintenance runtime" }))
        .toBeDisabled();
      expect(sent).toHaveLength(1);
      await act(async () => {
        release.resolve();
      });
      await expect.element(page.getByTestId("coordinator-bootstrap-review")).toBeVisible();
      await expect.element(page.getByTestId("maintenance-provisioning")).not.toBeInTheDocument();
      expect(sent[0]).toMatchObject({
        type: "installation.maintenance.provision.request",
        admissionSha256: proposal.admissionSha256,
      });
      expect(
        sent.filter((message) => message.type !== "installation.bootstrap.list_requests.request"),
      ).toHaveLength(1);
      await act(async () => page.getByRole("button", { name: "Details", exact: true }).click());
      expect(container.textContent).toContain(request.reason);
      expect(container.textContent).toContain(request.id);
      expect(container.textContent).toContain(request.revision);
      await page.getByText("Installation coordinator", { exact: true }).hover();
      // Let hover overlays exit before removing their DOM targets.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await page.screenshot({
        path: `../../../../output/playwright/maintenance-review-${width}.png`,
        fullPage: true,
      });
    } finally {
      release.resolve();
      act(() => root.unmount());
      container.remove();
      repairInstallation.enabled = false;
      vi.unstubAllGlobals();
    }
  },
);
