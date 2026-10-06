import { Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

const circumference = 2 * Math.PI * 12;
function Ring({
  remaining,
  stale,
  green,
  gray,
}: {
  remaining: number | null;
  stale: boolean;
  green: string;
  gray: string;
}) {
  const percentSign = Math.round(remaining ?? 0) === 100 ? "" : "%";
  return (
    <View
      style={styles.ring}
      testID="preset-remaining-ring"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.svg} pointerEvents="none">
        <Svg width={28} height={28} viewBox="0 0 28 28">
          <Circle cx={14} cy={14} r={12} fill="none" stroke={gray} strokeWidth={2.5} />
          {remaining !== null && remaining > 0 ? (
            <Circle
              cx={14}
              cy={14}
              r={12}
              fill="none"
              stroke={green}
              strokeWidth={2.5}
              strokeDasharray={`${(circumference * remaining) / 100} ${circumference * (1 - remaining / 100)}`}
              rotation={-90}
              origin="14, 14"
            />
          ) : null}
        </Svg>
      </View>
      <Text style={styles.value}>
        {remaining === null ? "?" : `${Math.round(remaining)}${percentSign}${stale ? "*" : ""}`}
      </Text>
    </View>
  );
}
const ThemedRing = withUnistyles(Ring);
const palette = (theme: Theme) => ({
  green: theme.colors.statusSuccess,
  gray: theme.colors.foregroundExtraMuted,
});
export function RemainingRing({ remaining, stale }: { remaining: number | null; stale: boolean }) {
  return <ThemedRing remaining={remaining} stale={stale} uniProps={palette} />;
}
const styles = StyleSheet.create((theme) => ({
  ring: { width: 28, height: 28, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  svg: { position: "absolute", top: 0, left: 0, width: 28, height: 28 },
  value: { color: theme.colors.foregroundMuted, fontSize: 8, fontWeight: "500" },
}));
