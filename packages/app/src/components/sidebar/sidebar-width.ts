import { COMPACT_SIDEBAR_WIDTH, SIDEBAR_COMPACT_SNAP_WIDTH } from "@/stores/panel-store/state";
import { createContext, useContext } from "react";

// Measured panel width also follows an in-progress drag, without changing preferences.
export const SidebarWidthContext = createContext(Infinity);
export function useSidebarWidth() {
  return useContext(SidebarWidthContext);
}

/** Rerender rows only when their available controls change, not on every drag pixel. */
export function sidebarPresentationWidth(width: number) {
  if (width <= SIDEBAR_COMPACT_SNAP_WIDTH) return COMPACT_SIDEBAR_WIDTH;
  if (width < 260) return 220;
  if (width < 280) return 270;
  if (width < 300) return 290;
  if (width < 340) return 320;
  return 360;
}
