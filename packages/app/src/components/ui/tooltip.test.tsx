import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const touchState = vi.hoisted(() => ({ enabled: false, compact: false }));
vi.mock("@/vorton-touch", () => ({ useVortonTouch: () => touchState.enabled }));
import { Tooltip, TooltipTrigger } from "./tooltip";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => touchState.compact,
}));

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@gorhom/bottom-sheet", () => ({
  useBottomSheetModalInternal: () => null,
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  FadeIn: {},
  FadeOut: {},
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
  },
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  touchState.enabled = false;
  touchState.compact = false;
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function renderTrigger({
  childDisabled,
  onPress,
}: {
  childDisabled: boolean;
  onPress: () => void;
}): void {
  act(() => {
    root?.render(
      <Tooltip>
        <TooltipTrigger asChild>
          <Pressable disabled={childDisabled} onPress={onPress} testID="trigger">
            <Text>Send</Text>
          </Pressable>
        </TooltipTrigger>
      </Tooltip>,
    );
  });
}

function pressTrigger(): void {
  const trigger = container?.querySelector('[data-testid="trigger"]');
  expect(trigger).not.toBeNull();

  act(() => {
    trigger?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

describe("TooltipTrigger", () => {
  it.each(["wide touch", "compact"])("keeps a tapped tooltip open on a %s screen", (mode) => {
    touchState.enabled = mode === "wide touch";
    touchState.compact = mode === "compact";
    const changed = vi.fn();
    act(() =>
      root?.render(
        <Tooltip enabledOnMobile onOpenChange={changed}>
          <TooltipTrigger asChild>
            <Pressable testID="trigger">
              <Text>Context usage</Text>
            </Pressable>
          </TooltipTrigger>
        </Tooltip>,
      ),
    );
    pressTrigger();
    expect(changed).toHaveBeenLastCalledWith(true);
    act(() => {
      container
        ?.querySelector('[data-testid="trigger"]')
        ?.dispatchEvent(new window.MouseEvent("pointerout", { bubbles: true }));
    });
    expect(changed).toHaveBeenLastCalledWith(true);
    pressTrigger();
    expect(changed).toHaveBeenLastCalledWith(false);
  });
  it("activates a Vorton touch control with one tap", () => {
    touchState.enabled = true;
    const onPress = vi.fn();
    renderTrigger({ childDisabled: false, onPress });
    pressTrigger();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
  it("keeps an asChild trigger disabled when the child is disabled", () => {
    const onPress = vi.fn();

    renderTrigger({ childDisabled: true, onPress });
    pressTrigger();

    expect(onPress).not.toHaveBeenCalled();
  });

  it("keeps an asChild trigger interactive when the child is not disabled", () => {
    const onPress = vi.fn();

    renderTrigger({ childDisabled: false, onPress });
    pressTrigger();

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
