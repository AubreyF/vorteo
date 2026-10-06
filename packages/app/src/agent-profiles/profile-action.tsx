import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";

function ProfileActionBase({
  visible,
  disabled,
  onPress,
  label,
  height,
}: {
  visible: boolean;
  disabled: boolean;
  onPress: () => void;
  label: string;
  height: number;
}) {
  const reducedMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: reducedMotion ? 0 : 180,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, progress, reducedMotion]);
  const viewport = useMemo(
    () => ({
      height: progress.interpolate({ inputRange: [0, 1], outputRange: [0, height] }),
    }),
    [progress, height],
  );
  const slide = useMemo(
    () => ({
      transform: [
        { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) },
      ],
    }),
    [progress, height],
  );
  return (
    <Animated.View
      style={[styles.viewport, viewport]}
      testID="preset-action-area"
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
    >
      {mounted ? (
        <Animated.View style={[styles.content, slide]}>
          <Button
            variant="default"
            size="md"
            disabled={disabled || !visible}
            onPress={onPress}
            testID="preset-use-profile"
          >
            {label}
          </Button>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

export const ProfileAction = withUnistyles(ProfileActionBase, (theme) => ({
  height: CONTROL_HEIGHTS.field + theme.spacing[2] * 2,
}));

const styles = StyleSheet.create((theme) => ({
  viewport: { overflow: "hidden", flexShrink: 0 },
  content: { padding: theme.spacing[2] },
}));
