import React, { useEffect } from "react";
import { View, type ActivityIndicatorProps } from "react-native";
import Svg, { Circle } from "react-native-svg";
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

export function LoadingSpinner({ color, size = "small", style }: LoadingSpinnerProps) {
  const diameter = typeof size === "number" ? size : LOADING_INDICATOR[size];
  const stroke =
    diameter >= 32
      ? LOADING_INDICATOR.largeStroke
      : Math.min(LOADING_INDICATOR.smallStroke, diameter / 10);
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
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
      {/* Keep theme props off the animated carrier so native theme changes remain safe. */}
      <Animated.View style={[{ width: diameter, height: diameter }, animatedStyle]}>
        <Svg width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`}>
          <Circle
            cx={diameter / 2}
            cy={diameter / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            opacity={0.2}
          />
          <Circle
            cx={diameter / 2}
            cy={diameter / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference / 4} ${(circumference * 3) / 4}`}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}
