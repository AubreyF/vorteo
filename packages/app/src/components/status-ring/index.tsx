import { memo } from "react";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import {
  StatusRingFrame,
  type StatusRingProps,
  rotatorStyles,
  StatusRingArc,
} from "@/components/status-ring/frame";
import { useStatusRingRotation } from "@/components/status-ring/clock";

/**
 * Native running indicator. The rotation is published by one shared UI-thread clock rather than
 * per-instance timing, so a ring that mounts mid-flight is already in phase — see `clock.ts`.
 *
 * The rotated view carries no theme-tracked style; the coloured arc is nested inside it. Putting
 * a Unistyles style on a Reanimated view crashes on theme change (docs/unistyles.md).
 */
export const StatusRing = memo(function StatusRing({ backdrop, variant }: StatusRingProps) {
  const rotation = useStatusRingRotation();
  const rotatorStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <StatusRingFrame backdrop={backdrop} variant={variant}>
      <Animated.View style={[rotatorStyles.rotator, rotatorStyle]}>
        <StatusRingArc variant={variant} />
      </Animated.View>
    </StatusRingFrame>
  );
});
