import { useEffect } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

function SparkShape({ color }: { color: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24">
      <Path
        d="M12 0C13.7 7.6 16.4 10.3 24 12C16.4 13.7 13.7 16.4 12 24C10.3 16.4 7.6 13.7 0 12C7.6 10.3 10.3 7.6 12 0Z"
        fill={color}
      />
    </Svg>
  );
}
const ThemedSpark = withUnistyles(SparkShape, (theme) => ({ color: theme.colors.statusDanger }));

export function JournalSpark({
  seen,
  entryId,
  animate,
}: {
  seen: boolean;
  entryId: string;
  animate: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(seen ? 1 : 0);
  useEffect(() => {
    const target = seen ? 1 : 0;
    progress.value = withTiming(target, {
      duration: reducedMotion || !animate ? 0 : 450,
      easing: Easing.out(Easing.cubic),
    });
    return () => cancelAnimation(progress);
  }, [seen, reducedMotion, progress, animate]);
  const sparkStyle = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [{ scale: 1 - progress.value * 0.8 }],
  }));
  const dotStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: Math.sin(progress.value * Math.PI) * 0.22,
    transform: [{ scale: 0.5 + progress.value }],
  }));
  return (
    <View
      testID={`journal-status-${entryId}`}
      accessibilityLabel={seen ? "Seen journal entry" : "Unread journal entry"}
      style={styles.frame}
    >
      <Animated.View style={[styles.layer, sparkStyle]}>
        <ThemedSpark />
      </Animated.View>
      <Animated.View style={[styles.layer, dotStyle]}>
        <View style={styles.dot} />
      </Animated.View>
      <Animated.View style={[styles.layer, haloStyle]}>
        <View style={styles.halo} />
      </Animated.View>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  frame: { width: 20, height: 20, flexShrink: 0, backgroundColor: theme.colors.surface1 },
  layer: { position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  halo: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.statusDanger,
  },
}));
