import { createContext, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent, View } from "react-native";
import { isWeb } from "@/constants/platform";

export type CardScrollHandler = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
export const ScrollDividerContext = createContext<(scrolled: boolean) => void>(() => {});

/** Update only when crossing the top edge, never once per scrolling pixel. */
export function useScrollDivider() {
  const ref = useRef<View>(null);
  const [scrolled, setScrolled] = useState(false);
  const onScroll = useCallback<CardScrollHandler>((event) => {
    setScrolled(event.nativeEvent.contentOffset.y > 0);
  }, []);
  useLayoutEffect(() => {
    if (!isWeb) return;
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;
    // Capture nested file trees and diff viewers as well as the card's own body.
    const handle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.getBoundingClientRect().width === 0) return;
      // Horizontal-only editor scrolling must not clear a vertical divider.
      if (target.scrollHeight <= target.clientHeight) return;
      setScrolled(target.scrollTop > 0);
    };
    node.addEventListener("scroll", handle, true);
    return () => node.removeEventListener("scroll", handle, true);
  }, []);
  return { ref, scrolled, onScroll, report: setScrolled };
}

export function useScrollReporter(onChange?: (scrolled: boolean) => void) {
  return useCallback<CardScrollHandler>(
    (event) => {
      onChange?.(event.nativeEvent.contentOffset.y > 0);
    },
    [onChange],
  );
}
