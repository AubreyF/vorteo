import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import type { ChecklistProgress } from "./progress";

const radius = 7;
const circumference = 2 * Math.PI * radius;
const palette = (theme: Theme) => ({
  track: theme.colors.surface3,
  progress: theme.colors.statusSuccess,
});

function Ring({
  fraction,
  track,
  progress,
}: {
  fraction: number;
  track: string;
  progress: string;
}) {
  return (
    <Svg
      width={18}
      height={18}
      viewBox="0 0 18 18"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Circle cx={9} cy={9} r={radius} fill="none" stroke={track} strokeWidth={3} />
      {fraction > 0 ? (
        <Circle
          cx={9}
          cy={9}
          r={radius}
          fill="none"
          stroke={progress}
          strokeWidth={3}
          strokeDasharray={`${circumference * fraction} ${circumference * (1 - fraction)}`}
          rotation={-90}
          origin="9, 9"
        />
      ) : null}
    </Svg>
  );
}
const ThemedRing = withUnistyles(Ring);

export function ChecklistProgressRing({
  completed,
  total,
  testID,
}: ChecklistProgress & { testID?: string }) {
  const { t } = useTranslation();
  if (total === 0) return null;
  const percent = Math.round((completed / total) * 100);
  const label = `${t("message.todo.tasksProgress", { completed, total })} (${percent}%)`;
  return (
    <View
      style={styles.frame}
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      aria-valuetext={label}
    >
      <ThemedRing fraction={completed / total} uniProps={palette} />
    </View>
  );
}
const styles = StyleSheet.create(() => ({
  frame: { width: 20, height: 20, flexShrink: 0, alignItems: "center", justifyContent: "center" },
}));
