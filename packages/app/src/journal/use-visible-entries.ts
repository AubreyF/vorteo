import { useEffect, useRef } from "react";
import { type ScrollView, type View, useWindowDimensions } from "react-native";
import { isWeb } from "@/constants/platform";
import { createSeenDwell } from "./seen-state";

interface VisibleEntriesOptions {
  enabled: boolean;
  entryIds: string;
  onSeen: (id: string) => void;
}

export function useVisibleEntries({ enabled, entryIds, onSeen }: VisibleEntriesOptions) {
  const timestamps = useRef(new Map<string, View>());
  const viewport = useRef<ScrollView>(null);
  const { width, height } = useWindowDimensions();
  useEffect(() => {
    if (!enabled) return;
    const dwell = createSeenDwell(onSeen);
    const nodes = timestamps.current;
    if (isWeb) {
      const visible = new Set<string>();
      const ids = new Map<Element, string>();
      const observer = new IntersectionObserver(
        (changes) => {
          for (const change of changes) {
            const id = ids.get(change.target);
            if (id === undefined) continue;
            const fullyVisible = change.isIntersecting && change.intersectionRatio >= 0.99;
            if (fullyVisible) visible.add(id);
            else visible.delete(id);
            dwell.update(id, fullyVisible, performance.now());
          }
        },
        { threshold: [0, 0.99, 1] },
      );
      for (const [id, node] of nodes) {
        if (!(node instanceof Element)) continue;
        ids.set(node, id);
        observer.observe(node);
      }
      const interval = setInterval(() => {
        for (const id of visible) dwell.update(id, true, performance.now());
      }, 100);
      return () => {
        clearInterval(interval);
        observer.disconnect();
      };
    }
    // Native has no IntersectionObserver. Measure the card's clipped scroll viewport,
    // not just the window, so entries below its fold remain unread.
    let disposed = false;
    function measure() {
      viewport.current
        ?.getNativeScrollRef()
        ?.measureInWindow((x, y, viewportWidth, viewportHeight) => {
          if (disposed) return;
          const left = Math.max(0, x);
          const top = Math.max(0, y);
          const right = Math.min(width, x + viewportWidth);
          const bottom = Math.min(height, y + viewportHeight);
          for (const [id, node] of nodes) {
            node.measureInWindow((rowX, rowY, rowWidth, rowHeight) => {
              if (disposed) return;
              const visible =
                viewportWidth > 0 &&
                viewportHeight > 0 &&
                rowWidth > 0 &&
                rowHeight > 0 &&
                rowX >= left &&
                rowY >= top &&
                rowX + rowWidth <= right &&
                rowY + rowHeight <= bottom;
              dwell.update(id, visible, performance.now());
            });
          }
        });
    }
    measure();
    const interval = setInterval(measure, 200);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [enabled, entryIds, onSeen, width, height]);
  return { timestamps, viewport };
}
