import React, { useEffect } from "react";
import { View, type ActivityIndicatorProps } from "react-native";
import { VorteoLogo } from "@/components/icons/paseo-logo";
import { RadarRing } from "./radar-ring";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { LOADING_INDICATOR } from "@/styles/theme";

interface LoadingSpinnerProps {
  color: string;
  size?: ActivityIndicatorProps["size"];
  style?: ActivityIndicatorProps["style"];
}

const brandMarkStyle = {
  position: "absolute" as const,
  width: LOADING_INDICATOR.large * 0.9,
  height: LOADING_INDICATOR.large * 0.9,
};

export function LoadingSpinner({ color, size = "small", style }: LoadingSpinnerProps) {
  const baseDiameter = typeof size === "number" ? size : LOADING_INDICATOR[size];
  const diameter = size === "large" ? baseDiameter * 1.25 : baseDiameter;
  const stroke =
    diameter >= 32
      ? LOADING_INDICATOR.largeStroke
      : Math.min(LOADING_INDICATOR.smallStroke, diameter / 10);
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1);
    return () => cancelAnimation(rotation);
  }, [rotation]);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  return (
    <View
      role="progressbar"
      accessibilityLabel="Loading"
      style={[{ alignItems: "center", justifyContent: "center" }, style]}
    >
      {size === "large" ? (
        <View testID="loading-brand-mark" style={brandMarkStyle}>
          <VorteoLogo size={LOADING_INDICATOR.large * 0.9} />
        </View>
      ) : null}
      {/* Keep theme props off the animated carrier so native theme changes remain safe. */}
      <Animated.View style={[{ width: diameter, height: diameter }, animatedStyle]}>
        <RadarRing size={diameter} strokeWidth={stroke} color={color} />
      </Animated.View>
    </View>
  );
}
