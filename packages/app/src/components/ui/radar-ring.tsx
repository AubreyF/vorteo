import { useId } from "react";
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";

/** Clockwise sweep: its bright end leads, with a dim tail 120 degrees behind. */
export function RadarRing({
  size,
  strokeWidth,
  color,
  trackOpacity = 0.2,
  headOpacity = 1,
}: {
  size: number;
  strokeWidth: number;
  color: string;
  trackOpacity?: number;
  headOpacity?: number;
}) {
  const gradientId = `radar-${useId().replace(/:/g, "")}`;
  const center = size / 2;
  const radius = (size - strokeWidth) / 2;
  const tailX = center - radius / 2;
  const tailY = center - (Math.sqrt(3) * radius) / 2;
  const headX = center + radius;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Defs>
        <LinearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={tailX}
          y1={tailY}
          x2={headX}
          y2={center}
        >
          <Stop offset="0" stopColor={color} stopOpacity={0.07 * headOpacity} />
          <Stop offset="1" stopColor={color} stopOpacity={headOpacity} />
        </LinearGradient>
      </Defs>
      <Circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        opacity={trackOpacity}
      />
      <Path
        d={`M ${tailX} ${tailY} A ${radius} ${radius} 0 0 1 ${headX} ${center}`}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={strokeWidth}
      />
    </Svg>
  );
}
