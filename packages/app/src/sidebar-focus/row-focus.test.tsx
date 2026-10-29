// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ touch: false, compact: false }));
vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => state.compact }));

import { SidebarFocusProvider, useSidebarRowFocus, type SidebarFocusController } from "./context";

const controller: SidebarFocusController = { focus: null, focusOn: vi.fn() };
const target = { kind: "folder", folderId: "work" } as const;

function wrapper({ children }: { children: ReactNode }) {
  return <SidebarFocusProvider value={controller}>{children}</SidebarFocusProvider>;
}

function rowFocus(isHovered: boolean) {
  return renderHook(() => useSidebarRowFocus({ target, isHovered }), { wrapper }).result.current;
}

beforeEach(() => {
  state.touch = false;
  state.compact = false;
  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() {
      return state.touch;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

describe("the row Focus button", () => {
  it("shows only on hover with a pointer", () => {
    expect(rowFocus(false).buttonAction).toBeNull();
    expect(rowFocus(true).buttonAction).toBeInstanceOf(Function);
    expect(rowFocus(true).hoverAction).toBeInstanceOf(Function);
  });

  it("shows permanently on touch devices, where the ⋮ menu is permanent too", () => {
    state.touch = true;
    expect(rowFocus(false).buttonAction).toBeInstanceOf(Function);
    // Rows without a ⋮ menu keep the hover-only button off touch layouts.
    expect(rowFocus(false).hoverAction).toBeNull();
  });

  it("shows permanently in compact layouts", () => {
    state.compact = true;
    expect(rowFocus(false).buttonAction).toBeInstanceOf(Function);
  });

  it("focuses the row's item", () => {
    rowFocus(true).buttonAction?.();
    expect(controller.focusOn).toHaveBeenCalledWith(target);
  });
});
