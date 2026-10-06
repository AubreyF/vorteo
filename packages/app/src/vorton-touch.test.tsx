// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ touch: false, compact: false }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => state.compact }));
import { useVortonTouch } from "./vorton-touch";
import { useSidebarRowDensity } from "./components/sidebar/use-sidebar-row-density";
import { useSidebarActionSize } from "./components/sidebar/use-sidebar-action-size";
import { applyVortonWeb } from "./appearance/vorton-web.web";
let change: () => void;
const remove = vi.fn();
beforeEach(() => {
  state.touch = false;
  state.compact = false;
  remove.mockClear();
  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() {
      return state.touch;
    },
    addEventListener: (_: string, listener: () => void) => {
      change = listener;
    },
    removeEventListener: remove,
  }));
});
afterEach(() => {
  document.body.innerHTML = "";
});
describe("Vorteo touch controls", () => {
  it("uses touch controls for wide touch devices and compact mouse windows", () => {
    const { result, rerender, unmount } = renderHook(useVortonTouch);
    expect(result.current).toBe(false);
    act(() => {
      state.touch = true;
      change();
    });
    expect(result.current).toBe(true);
    act(() => {
      state.touch = false;
      change();
    });
    state.compact = true;
    rerender();
    expect(result.current).toBe(true);
    state.compact = false;
    rerender();
    expect(result.current).toBe(false);
    unmount();
    expect(remove).toHaveBeenCalled();
  });
  it("preserves desktop density and enlarges sidebar actions on touch", () => {
    const { result, rerender } = renderHook(() => ({
      row: useSidebarRowDensity(),
      action: useSidebarActionSize(),
    }));
    expect(result.current.row.minHeight).toBe(32);
    expect(result.current.action.width).toBe(24);
    state.compact = true;
    rerender();
    expect(result.current.row.minHeight).toBe(44);
    expect(result.current.action.width).toBe(44);
    state.compact = false;
    state.touch = true;
    rerender();
    expect(result.current.row.minHeight).toBe(44);
    expect(result.current.action.width).toBe(44);
  });
  it("enlarges all touch actions without a compact product switch exemption", () => {
    const action = document.createElement("button");
    const slot = document.createElement("div");
    slot.dataset.vortonActionSlot = "true";
    slot.append(action);
    document.body.append(slot);
    const stop = applyVortonWeb(true);
    expect(getComputedStyle(action).minHeight).toBe("44px");
    expect(getComputedStyle(slot).minHeight).toBe("44px");
    stop();
    expect(document.head.querySelector("[data-vorton-styles]")).toBeNull();
    expect(document.documentElement.hasAttribute("data-vorton-mode")).toBe(false);
  });
  it("leaves Home Screen top spacing to safe-area shells and restores status bar metadata", () => {
    const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    const meta = document.createElement("meta");
    meta.name = "apple-mobile-web-app-status-bar-style";
    meta.content = "black-translucent";
    document.head.append(meta);
    const stop = applyVortonWeb(true);
    expect(getComputedStyle(root).paddingTop).toBe("");
    expect(getComputedStyle(root).boxSizing).toBe("border-box");
    expect(meta.content).toBe("default");
    stop();
    expect(meta.content).toBe("black-translucent");
    expect(document.documentElement.hasAttribute("data-vorton-ios-standalone")).toBe(false);
    meta.remove();
    Reflect.deleteProperty(navigator, "standalone");
    agent.mockRestore();
  });
});
