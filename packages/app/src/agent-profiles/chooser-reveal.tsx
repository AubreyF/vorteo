import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Animated, Easing, type StyleProp, type ViewStyle } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { isNative } from "@/constants/platform";

/** Key by the selected environment/account, never by usage snapshots. */
export function ChooserReveal({
  children,
  index = 0,
  sweep = false,
  style,
  testID,
}: {
  children: ReactNode;
  index?: number;
  sweep?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const reducedMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 240,
      delay: Math.min(index, 5) * 35 + (sweep ? 55 : 0),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: isNative,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reducedMotion, index, sweep]);
  const revealStyle = useMemo(
    () => ({
      opacity: progress,
      transform: [
        {
          translateX: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [sweep ? 10 : 0, 0],
          }),
        },
        {
          translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [sweep ? 0 : 6, 0] }),
        },
      ],
    }),
    [progress, sweep],
  );
  return (
    <Animated.View style={[style, revealStyle]} testID={testID}>
      {children}
    </Animated.View>
  );
}
