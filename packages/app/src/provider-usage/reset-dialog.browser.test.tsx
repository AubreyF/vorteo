import React, { act, useCallback, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { ProviderResetView } from "@getpaseo/protocol/provider-reset";
import { ResetDialogContent, ResetDialogActions } from "./reset-dialog";
import { initialResetFlow, resetFlowReducer, type ResetFlow } from "./reset-flow";
import { CompactAccountButton } from "./compact-account-button";
import { applyVortonWeb } from "@/appearance/vorton-web.web";
import { Text } from "react-native";
import { selectableResetCredits } from "./reset-state";

const credits = [
  { id: "later", title: "Later reset", grantedAt: 200, expiresAt: 4102444800 },
  { id: "first", title: "First reset", grantedAt: 100, expiresAt: 4070908800 },
].map((credit) => ({
  id: credit.id,
  title: credit.title,
  grantedAt: credit.grantedAt,
  expiresAt: credit.expiresAt,
  description: null,
  status: "available",
  resetType: "full",
}));
const view: ProviderResetView = {
  providerId: "example",
  fetchedAt: "2026-09-18T00:00:00Z",
  canRedeem: true,
  canSelectCredit: true,
  operation: null,
  snapshot: {
    status: "available",
    accountId: "account",
    accountLabel: "person@example.com",
    availableCount: 2,
    credits,
  },
};
function noop() {}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(1280, 800);
});

let root: Root;
let container: HTMLDivElement;
let submissions: string[];
let settle: (() => void) | undefined;

function Harness({
  initial = initialResetFlow,
  source = view,
}: {
  initial?: ResetFlow;
  source?: ProviderResetView;
}) {
  const [flow, dispatch] = useReducer(resetFlowReducer, initial);
  const selectedCreditId = flow.selection?.creditId ?? selectableResetCredits(source)[0]?.id;
  const actOnReset = useCallback(() => {
    if (flow.stage === "browse") {
      const credit = credits.find((entry) => entry.id === selectedCreditId) ?? null;
      dispatch({
        type: "prepared",
        view: {
          ...source,
          operation: {
            operationId: "00000000-0000-4000-8000-000000000001",
            state: "prepared",
            outcome: null,
            credit,
          },
        },
      });
    } else {
      submissions.push(flow.preparation!.operation!.credit!.id);
      dispatch({ type: "start" });
      settle = () => {
        dispatch({
          type: "result",
          result: { outcome: "reset", view: source, refreshError: null },
          notice: "Reset applied. No task was resumed.",
        });
        dispatch({ type: "settled" });
      };
    }
  }, [flow, source, selectedCreditId]);
  const select = useCallback(
    (creditId: string) => dispatch({ type: "select", accountId: "account", creditId }),
    [],
  );
  const back = useCallback(() => dispatch({ type: "back" }), []);
  const props = {
    name: "Example account",
    view: source,
    flow,
    selectedCreditId,
    selectionSupported: true,
    enabled: true,
    connected: true,
    readFailed: false,
    onSelect: select,
    onBack: back,
    onClose: noop,
    onRefresh: noop,
    onAct: actOnReset,
  };
  return (
    <>
      <ResetDialogContent {...props} />
      <ResetDialogActions {...props} />
    </>
  );
}

function mount(props: React.ComponentProps<typeof Harness> = {}) {
  submissions = [];
  container = document.createElement("div");
  container.style.maxWidth = "480px";
  container.style.margin = "0 auto";
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness {...props} />));
}
function click(label: string) {
  const button = Array.from(container.querySelectorAll<HTMLElement>('[role="button"],button')).find(
    (element) => element.textContent === label,
  );
  expect(button, label).toBeDefined();
  act(() => button!.click());
}
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("review replaces the list with the exact selected credit, and submission has its own states", async () => {
  mount();
  expect(
    container
      .querySelector('[data-testid="provider-reset-select-first"]')
      ?.getAttribute("aria-selected"),
  ).toBe("true");
  click("Select");
  click("Review reset");
  expect(container.textContent).toContain("Will be used");
  expect(container.textContent).toContain("Later reset");
  expect(container.textContent).not.toContain("First reset");
  expect(container.textContent).not.toContain("Refresh");
  expect(container.textContent).not.toContain("2 resets available");
  await page.screenshot({ path: ".vitest-screenshots/reset-confirmation-desktop.png" });
  click("Back");
  expect(
    container
      .querySelector('[data-testid="provider-reset-select-later"]')
      ?.getAttribute("aria-selected"),
  ).toBe("true");
  click("Review reset");
  click("Use 1 reset credit");
  expect(container.textContent).toContain("Applying reset…");
  click("Applying reset…");
  expect(submissions).toEqual(["later"]);
  act(() => settle!());
  expect(container.textContent).toContain("Reset applied");
  expect(container.textContent).not.toContain("Will be used");
  expect(container.textContent).not.toContain("Use 1 reset credit");
});

test("compact confirmation fits and its actions have touch targets", async () => {
  await page.viewport(375, 750);
  mount();
  click("Review reset");
  for (const element of container.querySelectorAll<HTMLElement>('[role="button"],button')) {
    expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
  expect(container.getBoundingClientRect().right).toBeLessThanOrEqual(375);
  await page.screenshot({ path: ".vitest-screenshots/reset-confirmation-touch.png" });
  await page.viewport(1280, 720);
});

test("provider selection is explicit when no credit is bound", () => {
  mount({ source: { ...view, canSelectCredit: false } });
  click("Review reset");
  expect(container.textContent).toContain("Provider chooses the credit");
  expect(container.textContent).not.toContain("Will be used");
});

test("an uncertain result offers the same reset and keeps the error visible", () => {
  mount({
    initial: {
      ...initialResetFlow,
      stage: "review",
      uncertain: true,
      notice: "Response lost. Retry this same reset.",
      preparation: {
        ...view,
        operation: {
          operationId: "00000000-0000-4000-8000-000000000001",
          state: "pending",
          outcome: null,
          credit: credits[0],
        },
      },
    },
  });
  expect(container.textContent).toContain("Previously submitted");
  expect(container.textContent).toContain("Response lost");
  click("Retry same reset");
  expect(submissions).toEqual(["later"]);
});

const resetBadgeTextStyle = { fontSize: 12, lineHeight: 16 };
for (const width of [390, 1133]) {
  test(`reset badges center their label and outline in touch targets at ${width}px`, async () => {
    await page.viewport(width, 800);
    mount();
    const stop = applyVortonWeb(true);
    try {
      act(() =>
        root.render(
          <CompactAccountButton dense testID="reset-alignment" textStyle={resetBadgeTextStyle}>
            <Text>2 resets</Text>
          </CompactAccountButton>,
        ),
      );
      const button = container.querySelector<HTMLElement>('[data-testid="reset-alignment"]')!;
      const outline = container.querySelector<HTMLElement>(
        '[data-testid="reset-alignment-outline"]',
      )!;
      const target = button.getBoundingClientRect();
      const border = outline.getBoundingClientRect();
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(border.y + border.height / 2 - target.y - target.height / 2)).toBeLessThan(1);
      const text = button.firstElementChild!.getBoundingClientRect();
      expect(Math.abs(text.y + text.height / 2 - border.y - border.height / 2)).toBeLessThan(1);
      await page.screenshot({ path: `.vitest-screenshots/reset-alignment-${width}.png` });
    } finally {
      stop();
    }
  });
}
