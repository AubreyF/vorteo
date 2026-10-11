import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type {
  CoordinatorBootstrapRequest,
  CoordinatorBootstrapDecision,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapPanelModel } from "./bootstrap-model";
import { BootstrapReview } from "./bootstrap-panel";

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
          await page.getByText("Installation coordinator", { exact: true }).hover();
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
