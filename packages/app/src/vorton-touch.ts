import { useSyncExternalStore } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";

// Capability, not viewport width: a wide iPad can have both touch and a trackpad.
const TOUCH_QUERY = "(any-pointer: coarse)";
// One media query and one DOM listener serve every subscriber. A query and listener per
// component made thousands of mounted tabs freeze the page.
const listeners = new Set<() => void>();
let touchQuery: MediaQueryList | null = null;
function notify() {
  for (const listener of listeners) listener();
}
function getTouchQuery(): MediaQueryList {
  touchQuery ??= window.matchMedia(TOUCH_QUERY);
  return touchQuery;
}
function subscribe(listener: () => void) {
  if (!isWeb || typeof window === "undefined") return () => {};
  if (listeners.size === 0) getTouchQuery().addEventListener("change", notify);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) getTouchQuery().removeEventListener("change", notify);
  };
}
function getSnapshot() {
  return !isWeb || (typeof window !== "undefined" && getTouchQuery().matches);
}
function serverSnapshot() {
  return !isWeb;
}
export function useVortonTouch() {
  const compact = useIsCompactFormFactor();
  const touch = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
  // Narrow desktop windows need the same controls as phones, even with a mouse.
  return compact || touch;
}

export const VORTON_ACTION_SLOT = { vortonActionSlot: "true" };
