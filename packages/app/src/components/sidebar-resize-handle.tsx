import { useCallback, useMemo, useState } from "react";
import { View, type PointerEvent as RNPointerEvent } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import Animated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import {
  resolveSidebarResizeHandleGeometry,
  type SidebarResizeEdge,
} from "./sidebar-resize-handle-layout";
import { FLOATING_PANEL_INSET } from "@/styles/floating-panel";
import { isWeb } from "@/constants/platform";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";

interface SidebarResizeHandleProps {
  edge: SidebarResizeEdge;
  gesture: GestureType;
  pressed: boolean;
  testID: string;
  floating?: boolean;
  onPointerDown?: (event: RNPointerEvent) => void;
}

/** Freed's neutral gap indicator, shared by both sidebars and both input modes. */
export function SidebarResizeHandle({
  edge,
  gesture,
  pressed,
  testID,
  floating = false,
  onPointerDown,
}: SidebarResizeHandleProps) {
  const finePointer = useHasFinePointer();
  const [hovered, setHovered] = useState(false);
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const geometry = resolveSidebarResizeHandleGeometry(finePointer);
  // Browser pointer capture supports fingers and pens as well as a mouse.
  const usePointerEvents = isWeb && Boolean(onPointerDown);
  const targetStyle = useMemo(() => {
    // Web hit testing can reach the gutter; native targets must stay inside their parent.
    const edgeOffset = isWeb ? -geometry.width / 2 : geometry.edgeOffset;
    const offset = edgeOffset - (isWeb && floating ? FLOATING_PANEL_INSET / 2 : 0);
    return [
      styles.layer,
      { width: geometry.width },
      edge === "left" ? { left: offset } : { right: offset },
    ];
  }, [edge, floating, geometry.edgeOffset, geometry.width]);
  const hitStyle = useMemo(
    () => [
      styles.target,
      {
        width: geometry.width,
        height: isWeb ? "100%" : (geometry.height ?? "100%"),
      },
      isWeb ? ({ cursor: "col-resize", touchAction: "none" } as object) : null,
    ],
    [geometry.height, geometry.width],
  );
  let opacity = hovered && finePointer ? 0.22 * 0.82 : 0;
  if (pressed) opacity = 0.34;
  const highlightStyle = useAnimatedStyle(
    () => ({ opacity: withTiming(opacity, { duration: 180, reduceMotion: ReduceMotion.System }) }),
    [opacity],
  );
  const target = (
    <View
      testID={testID}
      role="separator"
      aria-orientation="vertical"
      accessibilityLabel="Resize sidebar"
      collapsable={false}
      style={hitStyle}
      onPointerDown={usePointerEvents ? onPointerDown : undefined}
      onPointerEnter={enter}
      onPointerLeave={leave}
    >
      <Animated.View
        pointerEvents="none"
        testID={`${testID}-highlight`}
        style={[styles.highlight, highlightStyle]}
      />
    </View>
  );
  return (
    <View pointerEvents="box-none" style={targetStyle}>
      {usePointerEvents ? target : <GestureDetector gesture={gesture}>{target}</GestureDetector>}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  layer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  target: { alignItems: "center", justifyContent: "center" },
  highlight: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    borderRadius: 999,
    backgroundColor: theme.colors.foreground,
  },
}));
