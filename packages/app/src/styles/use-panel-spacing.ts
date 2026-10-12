import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

export function panelSpacingForWidth(width: number): number {
  if (width < 340) return 2;
  if (width < 400) return 4;
  return 8;
}

/** Shared inset follows the panel itself, including cards moved into the center column. */
export function usePanelSpacing() {
  const [inset, setInset] = useState(2);
  const [target, setTarget] = useState<number | null>(null);
  const current = useRef(2);
  const measured = useRef(false);
  const reduceMotion = useReducedMotion();
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    // Retained hidden panels must keep their last real spacing.
    if (width <= 0) return;
    setTarget(panelSpacingForWidth(width));
  }, []);
  useLayoutEffect(() => {
    if (target === null) return;
    // First measurement settles immediately; retained cards must not replay
    // their entrance spacing when switching workspaces.
    if (!measured.current || reduceMotion) {
      measured.current = true;
      current.current = target;
      setInset(target);
      return;
    }
    if (current.current === target) return;
    const from = current.current;
    let start: number | null = null;
    let frame = 0;
    const tick = (now: number) => {
      start ??= now;
      const progress = Math.min(1, (now - start) / 180);
      // Retarget from the visible value if a drag crosses another threshold.
      // Always write the exact tier at completion, never a rounded fraction.
      current.current =
        progress === 1 ? target : from + (target - from) * (1 - (1 - progress) ** 3);
      setInset(current.current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, reduceMotion]);
  return { inset, onLayout };
}
