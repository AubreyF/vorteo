import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const touchState = vi.hoisted(() => ({ enabled: false, compact: false }));
vi.mock("@/vorton-touch", () => ({ useVortonTouch: () => touchState.enabled }));
import { Tooltip, TooltipTrigger, TooltipContent, TooltipText } from "./tooltip";

vi.mock("./floating", async () => {
  const { View } = await import("react-native");
  return { FloatingSurface: View };
});

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
  FadeIn: { duration: () => ({ reduceMotion: () => undefined }) },
  FadeOut: { duration: () => ({ reduceMotion: () => undefined }) },
  ReduceMotion: { System: "system" },
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
  it("closes on Escape while leaving focus and activation with the trigger", async () => {
    const activate = vi.fn();
    await act(async () =>
      root?.render(
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Pressable testID="trigger" onPress={activate}>
              <Text>Info</Text>
            </Pressable>
          </TooltipTrigger>
          <TooltipContent>
            <TooltipText label="Info" description="Conversation details" />
          </TooltipContent>
        </Tooltip>,
      ),
    );
    const trigger = container?.querySelector<HTMLElement>('[data-testid="trigger"]');
    act(() => trigger?.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "InfoConversation details",
    );
    act(() =>
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      ),
    );
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(activate).not.toHaveBeenCalled();
    pressTrigger();
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("associates visible tooltip copy without replacing the control's existing description", async () => {
    const render = (open: boolean) => (
      <Tooltip open={open}>
        <TooltipTrigger asChild>
          <Pressable testID="trigger" aria-describedby="existing-help">
            <Text>Context usage</Text>
          </Pressable>
        </TooltipTrigger>
        <TooltipContent>
          <TooltipText label="Context usage" description="Tokens available for this conversation" />
        </TooltipContent>
      </Tooltip>
    );
    await act(async () => root?.render(render(true)));
    const trigger = container?.querySelector('[data-testid="trigger"]');
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe("Context usageTokens available for this conversation");
    expect(tooltip?.id).not.toBe("");
    expect(trigger?.getAttribute("aria-describedby")).toBe(`existing-help ${tooltip?.id}`);
    await act(async () => root?.render(render(false)));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(trigger?.getAttribute("aria-describedby")).toBe("existing-help");
  });

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
  it.each(["wide touch", "compact"])("shows pointer hover labels on a %s screen", (mode) => {
    touchState.enabled = mode === "wide touch";
    touchState.compact = mode === "compact";
    const changed = vi.fn();
    act(() =>
      root?.render(
        <Tooltip enabledOnMobile onOpenChange={changed}>
          <TooltipTrigger asChild passive>
            <Pressable testID="trigger">
              <Text>Tasks</Text>
            </Pressable>
          </TooltipTrigger>
        </Tooltip>,
      ),
    );
    const trigger = container?.querySelector('[data-testid="trigger"]');
    const pointer = (type: string, pointerType: string) => {
      const event = new window.MouseEvent(type, { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      act(() => trigger?.dispatchEvent(event));
    };
    pointer("pointerover", "touch");
    expect(changed).not.toHaveBeenCalled();
    pointer("pointerout", "touch");
    pointer("pointerover", "mouse");
    expect(changed).toHaveBeenLastCalledWith(true);
    pointer("pointerout", "mouse");
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
