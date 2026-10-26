import { useSyncExternalStore } from "react";
import { isWeb } from "@/constants/platform";

const eventName = "vorteo-data-saver-change";
const storageKey = "vorteo-data-saver-v1";

declare global {
  interface Window {
    __vorteoSetDataSaver?: (enabled: boolean, persist?: boolean) => boolean;
  }
}

export function readDataSaver(): boolean {
  return (
    isWeb &&
    typeof document !== "undefined" &&
    document.documentElement.dataset.vorteoDataSaver === "true"
  );
}

export function setDataSaver(enabled: boolean): boolean {
  if (!isWeb || typeof window === "undefined") return false;
  if (window.__vorteoSetDataSaver) return window.__vorteoSetDataSaver(enabled);
  let persisted = true;
  try {
    window.localStorage.setItem(storageKey, enabled ? "on" : "off");
  } catch {
    persisted = false;
  }
  document.documentElement.dataset.vorteoDataSaver = String(enabled);
  window.dispatchEvent(new Event(eventName));
  return persisted;
}

function subscribe(notify: () => void): () => void {
  if (!isWeb || typeof window === "undefined") return () => undefined;
  function storageChanged(event: StorageEvent) {
    if (event.key !== storageKey) return;
    const enabled = event.newValue === "on";
    if (window.__vorteoSetDataSaver) window.__vorteoSetDataSaver(enabled, false);
    else {
      document.documentElement.dataset.vorteoDataSaver = String(enabled);
      notify();
    }
  }
  window.addEventListener(eventName, notify);
  window.addEventListener("storage", storageChanged);
  return () => {
    window.removeEventListener(eventName, notify);
    window.removeEventListener("storage", storageChanged);
  };
}

export function useDataSaver(): boolean {
  return useSyncExternalStore(subscribe, readDataSaver, () => false);
}
