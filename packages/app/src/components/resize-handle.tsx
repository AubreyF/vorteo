import { usePointerResize } from "./use-pointer-resize";
import { SidebarResizeHandle } from "./sidebar-resize-handle";
import { useCallback, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { startResizeHandleDrag, type ResizeHandleDrag } from "@/components/resize-handle-drag";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";

export interface ResizeHandleProps {
  testID?: string;
  showDivider?: boolean;
  sidebar?: boolean;
  direction: "horizontal" | "vertical";
  hitAreaAlignment?: "center" | "end";
  groupId: string;
  index: number;
  sizes: number[];
  containerSize: number;
  onPreviewResizeSplit: (groupId: string, sizes: number[]) => void;
  onResizeSplit: (groupId: string, sizes: number[]) => void;
}

export function ResizeHandle({
  testID,
  showDivider = true,
  sidebar,
  direction,
  hitAreaAlignment = "center",
  groupId,
  index,
  sizes,
  containerSize,
  onPreviewResizeSplit,
  onResizeSplit,
}: ResizeHandleProps) {
  const { theme } = useUnistyles();
  const finePointer = useHasFinePointer();
  const touchDragRef = useRef<ResizeHandleDrag | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const highlighted = active || dragging;

  const beginPointerResize = useCallback(() => {
    if (containerSize <= 0) return null;
    const drag = startResizeHandleDrag({
      sizes,
      index,
      preview: (nextSizes) => onPreviewResizeSplit(groupId, nextSizes),
      commit: (nextSizes) => onResizeSplit(groupId, nextSizes),
    });
    return { move: (delta: number) => drag.move(delta / containerSize), finish: drag.finish };
  }, [containerSize, sizes, index, groupId, onPreviewResizeSplit, onResizeSplit]);
  const handlePointerDown = usePointerResize({
    direction,
    begin: beginPointerResize,
    onDraggingChange: setDragging,
  });

  const touchGesture = useMemo(() => {
    const gesture = Gesture.Pan()
      .runOnJS(true)
      .onBegin(() => setDragging(true))
      .onStart(() => {
        touchDragRef.current = startResizeHandleDrag({
          sizes,
          index,
          preview: (nextSizes) => onPreviewResizeSplit(groupId, nextSizes),
          commit: (nextSizes) => onResizeSplit(groupId, nextSizes),
        });
      })
      .onUpdate((event) => {
        if (containerSize <= 0) return;
        const translation = direction === "horizontal" ? event.translationX : event.translationY;
        touchDragRef.current?.move(translation / containerSize);
      })
      .onEnd(() => touchDragRef.current?.finish())
      .onFinalize(() => {
        touchDragRef.current = null;
        setDragging(false);
      });

    return direction === "horizontal"
      ? gesture
          .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
          .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
      : gesture
          .activeOffsetY([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
          .failOffsetX([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET]);
  }, [containerSize, direction, groupId, index, onPreviewResizeSplit, onResizeSplit, sizes]);

  const handlePointerEnter = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => {
      setActive(true);
    }, 150);
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setActive(false);
  }, []);

  const handleStyle = useMemo(
    () => [
      styles.handle,
      direction === "horizontal" ? styles.handleHorizontal : styles.handleVertical,
      { backgroundColor: showDivider ? theme.colors.border : "transparent" },
    ],
    [direction, showDivider, theme.colors.border],
  );
  const highlightStyle = useMemo(
    () => [
      styles.highlight,
      direction === "horizontal" ? styles.highlightHorizontal : styles.highlightVertical,
      { backgroundColor: theme.colors.accent },
    ],
    [direction, theme.colors.accent],
  );
  const hitAreaStyle = useMemo(
    () => [
      styles.hitArea,
      direction === "horizontal" ? styles.hitAreaHorizontal : styles.hitAreaVertical,
      {
        ...(direction === "horizontal"
          ? { left: hitAreaAlignment === "end" ? 0 : -5 }
          : { top: hitAreaAlignment === "end" ? 0 : -5 }),
        cursor: direction === "horizontal" ? "col-resize" : "row-resize",
        touchAction: "none",
      } as object,
    ],
    [direction, hitAreaAlignment],
  );
  const touchHitAreaStyle = useMemo(
    () => [
      styles.touchHitArea,
      direction === "horizontal" ? styles.touchHitAreaHorizontal : styles.touchHitAreaVertical,
      {
        ...(direction === "horizontal"
          ? { left: hitAreaAlignment === "end" ? 0 : -12 }
          : { top: hitAreaAlignment === "end" ? 0 : -12 }),
        touchAction: "none",
      } as object,
    ],
    [direction, hitAreaAlignment],
  );
  const touchGripStyle = useMemo(
    () => [
      styles.touchGrip,
      direction === "horizontal" ? styles.touchGripHorizontal : styles.touchGripVertical,
      highlighted ? styles.touchGripVisible : styles.touchGripHidden,
      { backgroundColor: theme.colors.foreground },
    ],
    [direction, highlighted, theme.colors.foreground],
  );

  if (sidebar)
    return (
      <SidebarResizeHandle
        edge="left"
        floating
        gesture={touchGesture}
        pressed={dragging}
        testID={testID ?? "sidebar-resize-handle"}
        onPointerDown={handlePointerDown}
      />
    );

  return (
    <View style={handleStyle} testID={testID}>
      {highlighted && (
        <View
          pointerEvents="none"
          style={highlightStyle}
          testID={testID ? `${testID}-highlight` : undefined}
        />
      )}
      {finePointer ? (
        <View
          role="separator"
          aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
          style={hitAreaStyle}
          onPointerDown={handlePointerDown}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        />
      ) : (
        <GestureDetector gesture={touchGesture}>
          <View
            role="separator"
            aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
            collapsable={false}
            style={touchHitAreaStyle}
          >
            <View pointerEvents="none" style={touchGripStyle} />
          </View>
        </GestureDetector>
      )}
    </View>
  );
}

const styles = StyleSheet.create((_theme) => ({
  handle: {
    position: "relative",
    flexShrink: 0,
    zIndex: 10,
  },
  handleHorizontal: {
    width: 1,
    alignSelf: "stretch",
  },
  handleVertical: {
    height: 1,
    width: "100%",
  },
  highlight: {
    position: "absolute",
    zIndex: 5,
  },
  highlightHorizontal: {
    top: 0,
    bottom: 0,
    width: 3,
    left: -1,
  },
  highlightVertical: {
    left: 0,
    right: 0,
    height: 3,
    top: -1,
  },
  hitArea: {
    position: "absolute",
    zIndex: 10,
  },
  hitAreaHorizontal: {
    top: 0,
    bottom: 0,
    width: 10,
  },
  hitAreaVertical: {
    left: 0,
    right: 0,
    height: 10,
  },
  touchHitArea: {
    position: "absolute",
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  touchHitAreaHorizontal: {
    top: "50%",
    width: 24,
    height: 88,
    transform: [{ translateY: -44 }],
  },
  touchHitAreaVertical: {
    left: "50%",
    width: 88,
    height: 24,
    transform: [{ translateX: -44 }],
  },
  touchGrip: {
    borderRadius: 2,
  },
  touchGripHorizontal: {
    width: 4,
    height: 36,
  },
  touchGripVertical: {
    width: 36,
    height: 4,
  },
  touchGripHidden: {
    opacity: 0.12,
  },
  touchGripVisible: {
    opacity: 0.3,
  },
}));
