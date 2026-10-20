import { useEffect } from "react";
import { isWeb } from "@/constants/platform";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * "/" focuses settings search on web, unless the reader is already typing.
 * Other shortcuts keep their meaning, so Command/Ctrl+F still finds in page.
 */
export function useSettingsSearchShortcut(): void {
  useEffect(() => {
    if (!isWeb || typeof document === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditable(event.target)) return;
      const input = document.querySelector<HTMLElement>('[data-testid="settings-search-input"]');
      if (!input) return;
      event.preventDefault();
      input.focus();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
}
