import { useId } from "react";
import { StyleSheet } from "react-native";
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";
import type { AppearanceId } from "@/styles/appearance-catalog";

// Native rendering of the catalog's Freed/Vorton preview gradients. SVG keeps
// the artwork independent of the selected interface palette and text layout.
const stops: Record<AppearanceId, readonly [string, string, string]> = {
  "starship-light": ["#fbffff", "#e9f8ff", "#aabcf6"],
  "starship-dark": ["#07090d", "#171a24", "#28405e"],
  scriptorium: ["#f4ead7", "#d8c4a1", "#86684a"],
  midas: ["#7c5c38", "#b08a48", "#5f4a32"],
  ember: ["#7a2f1f", "#c15a2e", "#5b1711"],
  neon: ["#3b82f6", "#8b5cf6", "#06b6d4"],
};

export function ThemePreviewArtwork({
  appearance,
  width,
  height,
}: {
  appearance: AppearanceId;
  width: number;
  height: number;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [first, middle, last] = stops[appearance];
  const light = appearance === "starship-light";
  const dark = appearance === "starship-dark";
  const colors = light ? [first, middle, "#c9e6ff", last] : [first, middle, last];
  const offsets = light ? [0, 0.35, 0.68, 1] : [0, 0.55, 1];
  return (
    <Svg
      width="100%"
      height="100%"
      style={StyleSheet.absoluteFillObject}
      viewBox={`0 0 ${width} ${height}`}
      pointerEvents="none"
      accessibilityElementsHidden
    >
      <Defs>
        <LinearGradient id={`${id}base`} x1="0%" y1="0%" x2={light ? "0%" : "100%"} y2="100%">
          {colors.map((color, index) => (
            <Stop key={color} offset={offsets[index]} stopColor={color} />
          ))}
        </LinearGradient>
        <RadialGradient id={`${id}planet`} cx="50%" cy="112%" rx="82%" ry="58%">
          <Stop offset="0%" stopColor="#77f1ff" />
          <Stop offset="30%" stopColor="#3a8ee8" />
          <Stop offset="68%" stopColor="#3644b8" />
          <Stop offset="100%" stopColor="#211c72" />
        </RadialGradient>
      </Defs>
      <Rect width={width} height={height} fill={`url(#${id}base)`} />
      {light && <Rect width={width} height={height} fill={`url(#${id}planet)`} />}
      {light && (
        <Circle
          cx={width * 0.71}
          cy={height * 0.22}
          r={width * 0.075}
          fill="#8beaff"
          fillOpacity={0.34}
        />
      )}
      {(light || dark) && (
        <Circle
          cx={width * (light ? 0.71 : 0.72)}
          cy={height * (light ? 0.22 : 0.28)}
          r={width * (light ? 0.04 : 0.025)}
          fill={light ? "#faffff" : "#d8f7ff"}
        />
      )}
    </Svg>
  );
}
