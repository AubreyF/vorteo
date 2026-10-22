import { useCallback, useEffect, useState, type ReactNode } from "react";
import { StyleSheet, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const LAUNCH_EASING = Easing.out(Easing.cubic);
const LAUNCH_PICKER_COLLAPSE_MS = 260;
const MESSAGE_ENTRANCE_MS = 320;
const MESSAGE_ENTRANCE_DELAY_MS = 60;
const MESSAGE_ENTRANCE_OFFSET = 14;

/**
 * Tucks the new-agent launch picker into the composer once the first message
 * is submitted, and brings it back if creation fails. The picker and the
 * submitted conversation must never be visible together.
 *
 * Collapsing uses negative margins instead of an explicit height so the
 * expanded picker keeps its natural, content-driven layout. `stackGap` cancels
 * the parent stack's gap so the composer settles flush.
 */
export function LaunchPickerCollapse({
  collapsed,
  stackGap,
  children,
}: {
  collapsed: boolean;
  stackGap: number;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  // A picker that starts collapsed, such as a draft opened mid-launch, never renders.
  const [mounted, setMounted] = useState(!collapsed);
  const progress = useSharedValue(collapsed ? 0 : 1);
  const height = useSharedValue(0);

  useEffect(() => {
    if (!collapsed) setMounted(true);
    const target = collapsed ? 0 : 1;
    if (reducedMotion) {
      progress.value = target;
      if (collapsed) setMounted(false);
      return;
    }
    progress.value = withTiming(
      target,
      { duration: LAUNCH_PICKER_COLLAPSE_MS, easing: LAUNCH_EASING },
      (finished) => {
        if (finished && collapsed) scheduleOnRN(setMounted, false);
      },
    );
  }, [collapsed, progress, reducedMotion]);

  const outerStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    marginBottom: -stackGap * (1 - progress.value),
  }));
  const innerStyle = useAnimatedStyle(() => ({
    marginTop: -height.value * (1 - progress.value),
    transform: [{ scale: 0.98 + 0.02 * progress.value }],
  }));

  const measure = useCallback(
    (event: LayoutChangeEvent) => {
      height.value = event.nativeEvent.layout.height;
    },
    [height],
  );

  if (!mounted) return null;
  return (
    <Animated.View
      style={[styles.clip, outerStyle]}
      pointerEvents={collapsed ? "none" : "auto"}
      aria-hidden={collapsed}
      testID="launch-picker-collapse"
    >
      <Animated.View style={innerStyle} onLayout={measure}>
        {children}
      </Animated.View>
    </Animated.View>
  );
}

/** Fades the first submitted message up into place as the picker tucks away. */
export function LaunchMessageEntrance({ children }: { children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(reducedMotion ? 1 : 0);
  useEffect(() => {
    if (reducedMotion) return;
    progress.value = withDelay(
      MESSAGE_ENTRANCE_DELAY_MS,
      withTiming(1, { duration: MESSAGE_ENTRANCE_MS, easing: LAUNCH_EASING }),
    );
  }, [progress, reducedMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: MESSAGE_ENTRANCE_OFFSET * (1 - progress.value) }],
  }));
  return <Animated.View style={[styles.fill, style]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  clip: { width: "100%", overflow: "hidden" },
  fill: { flex: 1 },
});
