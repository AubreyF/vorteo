import { useVortonMode } from "@/vorton-mode";
import { useMemo } from "react";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { resolveShortcutKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { getIsElectronRuntime } from "@/constants/layout";

/** `null` action ids are accepted so callers can keep the hook unconditional. */
export function useShortcutKeys(actionId: string | null): ShortcutKey[][] | null {
  const isVorton = useVortonMode();
  const { overrides } = useKeyboardShortcutOverrides();
  const isMac = getShortcutOs() === "mac";
  const isDesktopApp = getIsElectronRuntime();

  return useMemo(() => {
    if (actionId === null) return null;
    return resolveShortcutKeysForAction(actionId, overrides, {
      isMac,
      isVorton,
      isDesktop: isDesktopApp,
    });
  }, [actionId, overrides, isMac, isDesktopApp, isVorton]);
}
