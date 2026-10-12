import { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

/** Shared inset follows the panel itself, including cards moved into the center column. */
export function usePanelSpacing() {
  const [inset, setInset] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    // Retained hidden panels must keep their last real spacing.
    if (width <= 0) return;
    setInset(Math.round(Math.max(0, Math.min(8, (width - 300) / 15))));
  }, []);
  return { inset, onLayout };
}
