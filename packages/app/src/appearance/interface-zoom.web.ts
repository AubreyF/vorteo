import { useEffect, useSyncExternalStore } from "react";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { getShortcutOs } from "@/utils/shortcut-platform";

export const INTERFACE_ZOOM_MIN = 75;
export const INTERFACE_ZOOM_MAX = 200;
export const INTERFACE_ZOOM_STEP = 5;
const KEY = "vorteo-interface-zoom";
const EVENT = "vorteo-interface-zoom-change";
let current: number | undefined;

export function normalizeInterfaceZoom(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed)
    ? Math.min(INTERFACE_ZOOM_MAX, Math.max(INTERFACE_ZOOM_MIN, Math.round(parsed / 5) * 5))
    : 100;
}
function readZoom(): number {
  if (typeof window === "undefined") return 100;
  if (current !== undefined) return current;
  try {
    current = normalizeInterfaceZoom(localStorage.getItem(KEY));
  } catch {
    current = 100;
  }
  return current;
}
export function getInterfaceScale(): number {
  return typeof document === "undefined"
    ? 1
    : Number(document.documentElement.dataset.interfaceZoom ?? 100) / 100;
}
function applyZoom(zoom: number) {
  const root = document.documentElement;
  root.dataset.interfaceZoom = String(zoom);
  root.style.setProperty("zoom", String(zoom / 100));
  root.style.setProperty("--interface-scale", String(zoom / 100));
  window.dispatchEvent(new Event("resize"));
}
function subscribe(callback: () => void) {
  const update = () => callback();
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) {
      current = undefined;
      update();
    }
  };
  window.addEventListener(EVENT, update);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(EVENT, update);
    window.removeEventListener("storage", storage);
  };
}
function setZoom(value: number) {
  current = normalizeInterfaceZoom(value);
  try {
    localStorage.setItem(KEY, String(current));
  } catch {
    /* Keep the session usable when storage is unavailable. */
  }
  applyZoom(current);
  window.dispatchEvent(new Event(EVENT));
}
/** Step buttons and shortcuts move to the next multiple of 10 in either direction. */
export function stepInterfaceZoom(value: number, direction: -1 | 1): number {
  const zoom = normalizeInterfaceZoom(value);
  return normalizeInterfaceZoom(
    direction < 0 ? Math.ceil(zoom / 10) * 10 - 10 : Math.floor(zoom / 10) * 10 + 10,
  );
}

/**
 * Maps the browser zoom keys to interface zoom. Returns the new zoom, or null
 * when the event is not a zoom key and should continue to other handlers.
 */
export function interfaceZoomForKey(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">,
  zoom: number,
  isMac: boolean,
): number | null {
  if (event.altKey || !(isMac ? event.metaKey : event.ctrlKey)) return null;
  if (event.key === "=" || event.key === "+" || event.code === "NumpadAdd") {
    return stepInterfaceZoom(zoom, 1);
  }
  if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") {
    return stepInterfaceZoom(zoom, -1);
  }
  if (event.key === "0" || event.code === "Numpad0") return 100;
  return null;
}

function handleZoomKey(event: KeyboardEvent) {
  if (event.defaultPrevented || useKeyboardShortcutsStore.getState().capturingShortcut) return;
  const next = interfaceZoomForKey(event, readZoom(), getShortcutOs() === "mac");
  if (next === null) return;
  // Without this the browser scales the page too, cropping toolbars twice.
  event.preventDefault();
  event.stopPropagation();
  setZoom(next);
}

export function useInterfaceZoom(): [number, (value: number) => void] {
  return [useSyncExternalStore(subscribe, readZoom, () => 100), setZoom];
}
export function useApplyInterfaceZoom(): void {
  const [zoom] = useInterfaceZoom();
  useEffect(() => {
    applyZoom(zoom);
  }, [zoom]);
  useEffect(() => {
    window.addEventListener("keydown", handleZoomKey, true);
    return () => window.removeEventListener("keydown", handleZoomKey, true);
  }, []);
}
