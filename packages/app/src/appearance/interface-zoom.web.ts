import { useEffect, useSyncExternalStore } from "react";

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
export function useInterfaceZoom(): [number, (value: number) => void] {
  return [useSyncExternalStore(subscribe, readZoom, () => 100), setZoom];
}
export function useApplyInterfaceZoom(): void {
  const [zoom] = useInterfaceZoom();
  useEffect(() => {
    applyZoom(zoom);
  }, [zoom]);
}
