import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "./tooltip";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

const triggerStyle = { position: "absolute", top: 180, left: 220 } as const;

function Harness({ open }: { open?: boolean }) {
  return (
    <Tooltip open={open} enabledOnMobile>
      <TooltipTrigger asChild>
        <Pressable testID="tooltip-trigger" style={triggerStyle}>
          <Text>Details</Text>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent>
        <TooltipText label="Details" description="Conversation information" />
      </TooltipContent>
    </Tooltip>
  );
}

describe("Tooltip portal cleanup", () => {
  let root: Root;
  let container: HTMLDivElement;
  let interruptedAnimations: HTMLStyleElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // Suppress animationstart and animationend, as when an animation is removed
    // before it starts. Keep the real Reanimated surface and its DOM lifecycle.
    interruptedAnimations = document.createElement("style");
    interruptedAnimations.textContent = '[role="tooltip"] { animation: none !important; }';
    document.head.append(interruptedAnimations);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.replaceChildren();
    interruptedAnimations.remove();
  });

  async function expectVisible() {
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.textContent)
      .toBe("DetailsConversation information");
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.getBoundingClientRect().x)
      .toBeGreaterThanOrEqual(0);
  }

  async function expectRemoved() {
    await nextFrame();
    await expect.poll(() => document.querySelectorAll('[role="tooltip"]').length).toBe(0);
  }

  it("removes the entire tooltip when closing before a web animation can start", async () => {
    flushSync(() => root.render(<Harness open />));
    await expectVisible();
    flushSync(() => root.render(<Harness open={false} />));
    await expectRemoved();
  });

  it("removes the tooltip when its trigger unmounts during navigation", async () => {
    flushSync(() => root.render(<Harness open />));
    await expectVisible();
    flushSync(() => root.render(null));
    await expectRemoved();
  });

  it("does not accumulate floating shells across repeated open and close cycles", async () => {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      flushSync(() => root.render(<Harness open />));
      await expectVisible();
      expect(document.querySelectorAll('[role="tooltip"]').length).toBe(1);
      flushSync(() => root.render(<Harness open={false} />));
      await expectRemoved();
    }
  });

  it("preserves hover, Escape dismissal and keyboard focus without animation copies", async () => {
    interruptedAnimations.remove();
    flushSync(() => root.render(<Harness />));
    const trigger = container.querySelector<HTMLElement>('[data-testid="tooltip-trigger"]');
    if (!trigger) throw new Error("Tooltip trigger did not render");
    await userEvent.hover(trigger);
    await expectVisible();
    await userEvent.unhover(trigger);
    await expectRemoved();
    await userEvent.keyboard("{Tab}");
    await expectVisible();
    expect(document.activeElement).toBe(trigger);
    await userEvent.keyboard("{Escape}");
    await expectRemoved();
    expect(document.activeElement).toBe(trigger);
  });
});
