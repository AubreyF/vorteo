import { useLayoutEffect, useState, type ReactNode } from "react";
import { Text, View, StyleSheet as NativeStyleSheet } from "react-native";
import Svg, { Circle } from "react-native-svg";
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVortonTouch } from "@/vorton-touch";
import type { OutboxRecord } from "./outbox-record";

const rotation = makeMutable(0);
const subscribers = makeMutable(0);
let nextListenerId = 1;

function subscribeOrbit(local: SharedValue<number>, listenerId: number): void {
  "worklet";
  local.value = rotation.value;
  rotation.addListener(listenerId, (value) => {
    local.value = value;
  });
  subscribers.value += 1;
  if (subscribers.value === 1) {
    rotation.value = 0;
    rotation.value = withRepeat(withTiming(360, { duration: 2400, easing: Easing.linear }), -1);
  }
}

function unsubscribeOrbit(listenerId: number): void {
  "worklet";
  rotation.removeListener(listenerId);
  subscribers.value -= 1;
  if (subscribers.value === 0) cancelAnimation(rotation);
}

function Orbit({ spinning, color }: { spinning: boolean; color: string }) {
  const angle = useSharedValue(0);
  const [listenerId] = useState(() => nextListenerId++);
  useLayoutEffect(() => {
    if (!spinning) return;
    scheduleOnUI(subscribeOrbit, angle, listenerId);
    return () => scheduleOnUI(unsubscribeOrbit, listenerId);
  }, [angle, listenerId, spinning]);
  const rotationStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value}deg` }] }));
  return (
    <Animated.View style={[animationStyles.glyph, rotationStyle]} testID="queue-orbit-rotation">
      <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
        <Circle cx={12} cy={12} r={8} stroke={color} strokeWidth={1.7} opacity={0.22} />
        <Circle cx={12} cy={4} r={2} fill={color} />
      </Svg>
    </Animated.View>
  );
}
const ThemedOrbit = withUnistyles(Orbit, (theme) => ({ color: theme.colors.foregroundMuted }));

export function QueueMessageIndicator({
  record,
  children,
}: {
  record: OutboxRecord | null;
  children?: ReactNode;
}) {
  const local = record !== null;
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const touch = useVortonTouch();
  const [showOrbit, setShowOrbit] = useState(local);
  const orbitOpacity = useSharedValue(0);
  const initialHandleOpacity = !local && reduceMotion ? 1 : 0;
  const handleOpacity = useSharedValue(initialHandleOpacity);
  const status = record?.dismissed ? "Kept on this device" : "Queued on this device";
  const spinning = active && !reduceMotion && !record?.dismissed && !record?.error;

  useLayoutEffect(() => {
    cancelAnimation(orbitOpacity);
    cancelAnimation(handleOpacity);
    if (!active || reduceMotion) {
      orbitOpacity.value = local ? 1 : 0;
      handleOpacity.value = local ? 0 : 1;
      setShowOrbit(local);
    } else if (local) {
      setShowOrbit(true);
      handleOpacity.value = 0;
      orbitOpacity.value = withDelay(
        100,
        withTiming(1, { duration: 450, easing: Easing.inOut(Easing.ease) }),
      );
    } else {
      // An acknowledgement during entrance fades only the opacity reached so far.
      const exitDuration = 180 * orbitOpacity.value;
      orbitOpacity.value = withTiming(0, { duration: exitDuration }, (finished) => {
        if (finished) scheduleOnRN(setShowOrbit, false);
      });
      handleOpacity.value = withDelay(exitDuration, withTiming(1, { duration: 220 }));
    }
    return () => {
      cancelAnimation(orbitOpacity);
      cancelAnimation(handleOpacity);
    };
  }, [active, handleOpacity, local, orbitOpacity, reduceMotion]);

  const orbitStyle = useAnimatedStyle(() => ({ opacity: orbitOpacity.value }));
  const handleStyle = useAnimatedStyle(() => ({ opacity: handleOpacity.value }));
  return (
    <View style={[styles.slot, touch && styles.touch]}>
      {showOrbit ? (
        <Animated.View
          style={[animationStyles.overlay, orbitStyle]}
          pointerEvents={local ? "auto" : "none"}
          aria-hidden={!local}
          accessibilityElementsHidden={!local}
          testID="queue-local-indicator"
        >
          <Tooltip enabledOnDesktop={local} enabledOnMobile={local}>
            <TooltipTrigger
              accessibilityRole="button"
              accessibilityLabel={status}
              style={[styles.slot, touch && styles.touch]}
            >
              <ThemedOrbit spinning={spinning} />
            </TooltipTrigger>
            <TooltipContent side="top">
              <Text style={styles.tooltipText}>{status}</Text>
            </TooltipContent>
          </Tooltip>
        </Animated.View>
      ) : null}
      <Animated.View style={handleStyle} testID="queue-handle-indicator">
        {children}
      </Animated.View>
    </View>
  );
}

const animationStyles = NativeStyleSheet.create({
  glyph: { width: 14, height: 14 },
  overlay: { position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" },
});
const styles = StyleSheet.create((theme) => ({
  slot: { width: 24, minHeight: 32, alignItems: "center", justifyContent: "center" },
  touch: { minWidth: 44, minHeight: 44 },
  tooltipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
