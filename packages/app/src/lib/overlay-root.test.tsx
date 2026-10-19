// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchTopWebOverlayKeyDown,
  hasActiveWebOverlay,
  useWebOverlayRegistration,
} from "./overlay-root";

describe("useWebOverlayRegistration", () => {
  let opener: HTMLButtonElement;
  let input: HTMLInputElement;
  let scope: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    opener = document.createElement("button");
    input = document.createElement("input");
    scope = document.createElement("div");
    scope.tabIndex = -1;
    scope.append(input);
    document.body.append(opener, scope);
    opener.focus();
    expect(document.activeElement).toBe(opener);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("does not restore opener focus when an active overlay scope detaches", () => {
    const { result, unmount } = renderHook(() =>
      useWebOverlayRegistration({ active: true, layer: 20, onKeyDown: () => false }),
    );

    act(() => result.current(scope));
    const openerFocus = vi.spyOn(opener, "focus");
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => result.current(null));

    expect(openerFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    unmount();
  });

  it("restores opener focus when an overlay closes", () => {
    const { result, rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) =>
        useWebOverlayRegistration({ active, layer: 20, onKeyDown: () => false }),
      { initialProps: { active: true } },
    );

    act(() => result.current(scope));
    const openerFocus = vi.spyOn(opener, "focus");
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => rerender({ active: false }));

    expect(openerFocus).toHaveBeenCalled();
    unmount();
  });

  it("restores opener focus when an active overlay unmounts after its scope detaches", () => {
    const { result, unmount } = renderHook(() =>
      useWebOverlayRegistration({ active: true, layer: 20, onKeyDown: () => false }),
    );

    act(() => result.current(scope));
    const openerFocus = vi.spyOn(opener, "focus");
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => result.current(null));
    expect(openerFocus).not.toHaveBeenCalled();

    unmount();

    expect(openerFocus).toHaveBeenCalled();
  });

  it("leaves IME composition keys with the focused editor", () => {
    const event = new KeyboardEvent("keydown", { key: "Process", bubbles: true });
    expect(dispatchTopWebOverlayKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it("dismisses a tooltip before its dialog without moving or trapping focus in the tooltip", () => {
    const dialogKey = vi.fn(() => true);
    const tooltipKey = vi.fn((event: KeyboardEvent) => event.key === "Escape");
    const dialog = renderHook(() =>
      useWebOverlayRegistration({ active: true, layer: 20, onKeyDown: dialogKey }),
    );
    act(() => dialog.result.current(scope));
    input.focus();
    const tooltipScope = document.createElement("div");
    document.body.append(tooltipScope);
    const tooltip = renderHook(() =>
      useWebOverlayRegistration({
        active: true,
        layer: 20_000,
        onKeyDown: tooltipKey,
        focusBehavior: "none",
      }),
    );
    act(() => tooltip.result.current(tooltipScope));
    expect(document.activeElement).toBe(input);
    const escape = new KeyboardEvent("keydown", { key: "Escape" });
    expect(dispatchTopWebOverlayKeyDown(escape)).toBe(true);
    expect(tooltipKey).toHaveBeenCalledWith(escape);
    expect(dialogKey).not.toHaveBeenCalled();
    expect(dispatchTopWebOverlayKeyDown(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
    expect(dialogKey).toHaveBeenCalledTimes(1);
    const inputFocus = vi.spyOn(input, "focus");
    tooltip.unmount();
    expect(inputFocus).not.toHaveBeenCalled();
    dialog.unmount();
  });

  it("does not treat a tooltip alone as an interactive overlay or consume Tab", () => {
    const tooltip = renderHook(() =>
      useWebOverlayRegistration({
        active: true,
        layer: 20_000,
        onKeyDown: () => false,
        focusBehavior: "none",
      }),
    );
    act(() => tooltip.result.current(scope));
    expect(hasActiveWebOverlay()).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(dispatchTopWebOverlayKeyDown(new KeyboardEvent("keydown", { key: "Tab" }))).toBe(false);
    tooltip.unmount();
  });
});
