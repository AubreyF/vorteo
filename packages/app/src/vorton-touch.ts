import { useSyncExternalStore } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";

// Capability, not viewport width: a wide iPad can have both touch and a trackpad.
const TOUCH_QUERY = "(any-pointer: coarse)";
function subscribe(listener: () => void) {
  if (!isWeb || typeof window === "undefined") return () => {};
  const query = window.matchMedia(TOUCH_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
function getSnapshot() {
  return !isWeb || (typeof window !== "undefined" && window.matchMedia(TOUCH_QUERY).matches);
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
