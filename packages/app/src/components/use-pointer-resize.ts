import { getInterfaceScale } from "@/appearance/interface-zoom";
import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as RNPointerEvent } from "react-native";

interface PointerResizeSession {
  move: (delta: number) => void;
  finish: () => void;
}

/** One pointer lifecycle for sidebar and split resizing, including cancellation and unmount. */
export function usePointerResize({
  direction,
  begin,
  onDraggingChange,
}: {
  direction: "horizontal" | "vertical";
  begin: () => PointerResizeSession | null;
  onDraggingChange: (active: boolean) => void;
}) {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  return useCallback(
    (event: RNPointerEvent) => {
      if (cleanupRef.current || (event.nativeEvent.button ?? 0) !== 0) return;
      const session = begin();
      if (!session) return;
      const element = event.currentTarget as unknown as HTMLElement;
      const { pointerId } = event.nativeEvent;
      const start =
        direction === "horizontal" ? event.nativeEvent.clientX : event.nativeEvent.clientY;
      const previousCursor = document.body.style.cursor;
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      event.preventDefault();
      event.stopPropagation();
      element.setPointerCapture?.(pointerId);
      onDraggingChange(true);
      const clampScroll = () => {
        if (window.scrollX !== 0) window.scrollTo(0, window.scrollY);
      };
      const move = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        next.preventDefault();
        clampScroll();
        session.move(
          ((direction === "horizontal" ? next.clientX : next.clientY) - start) /
            getInterfaceScale(),
        );
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
        document.body.style.cursor = previousCursor;
        cleanupRef.current = null;
        clampScroll();
      };
      const finish = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        session.finish();
        cleanup();
        onDraggingChange(false);
      };
      cleanupRef.current = cleanup;
      clampScroll();
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [begin, direction, onDraggingChange],
  );
}
