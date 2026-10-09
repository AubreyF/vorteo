import { memo } from "react";
import { Text, View } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import type { ChecklistProgress } from "./progress";
import { petalGeometry, taskPetals, type PetalStatus } from "./flower";

interface FlowerPalette {
  completed: string;
  active: string;
  pending: string;
}
const palette = (theme: Theme): FlowerPalette => ({
  completed: theme.colors.statusSuccess,
  active: theme.colors.statusDotRunning,
  pending: theme.colors.surface3,
});

function Flower({ petals, ...colors }: FlowerPalette & { petals: PetalStatus[] }) {
  const geometry = petalGeometry(petals.length);
  return (
    <Svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {petals.map((status, index) => {
        const angle = (index * 360) / petals.length;
        return (
          <G key={angle} rotation={angle} origin="12, 12">
            {status === "active" ? (
              <Path d={geometry.halo} fill="none" stroke={colors.active} strokeWidth={0.35} />
            ) : null}
            <Path d={geometry.path} fill={colors[status]} />
          </G>
        );
      })}
    </Svg>
  );
}
const ThemedFlower = withUnistyles(Flower);

export const ChecklistProgressFlower = memo(function ChecklistProgressFlower({
  completed,
  active,
  total,
  testID,
}: ChecklistProgress & { testID?: string }) {
  const { t } = useTranslation();
  if (total === 0) return null;
  const percent = Math.round((completed / total) * 100);
  const label = `${t("message.todo.tasksProgress", { completed, total })} (${percent}%)`;
  const detail = `${label} · ${t("message.todo.activeCount", { count: active })}`;
  const petals = taskPetals({ completed, active, total });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <View
          style={styles.frame}
          testID={testID}
          accessible
          tabIndex={0}
          accessibilityRole="progressbar"
          accessibilityLabel={detail}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completed}
          aria-valuetext={detail}
        >
          <ThemedFlower petals={petals} uniProps={palette} />
        </View>
      </TooltipTrigger>
      <TooltipContent>
        <Text style={styles.tooltip}>{detail}</Text>
      </TooltipContent>
    </Tooltip>
  );
});
const styles = StyleSheet.create((theme) => ({
  frame: { width: 20, height: 20, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  tooltip: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
