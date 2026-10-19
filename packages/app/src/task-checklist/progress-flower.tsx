import { memo, useId } from "react";
import { Text, View } from "react-native";
import Svg, { Defs, G, LinearGradient, Path, Stop } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import { checklistPercent, type ChecklistProgress } from "./progress";
import { petalFills, petalGeometry, taskPetals, type PetalStatus } from "./flower";

interface FlowerPalette {
  completed: string;
  active: string;
  pending: string;
}
const palette = (theme: Theme): FlowerPalette => ({
  completed: theme.colors.foregroundExtraMuted,
  active: theme.colors.foreground,
  pending: theme.colors.border,
});
const decorativeSvgProps = isWeb
  ? { "aria-hidden": true as const }
  : {
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants" as const,
    };

function Flower({
  petals,
  fills,
  ...colors
}: FlowerPalette & { petals: PetalStatus[]; fills: number[] }) {
  const geometry = petalGeometry(petals.length);
  const gradientPrefix = useId().replace(/:/g, "");
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" {...decorativeSvgProps}>
      {/* A partly done petal fills from the flower's center toward its tip with a hard edge. */}
      <Defs>
        {petals.map((status, index) => {
          const fill = fills[index] ?? 0;
          if (status === "completed" || fill <= 0 || fill >= 1) return null;
          const angle = (index * 360) / petals.length;
          return (
            <LinearGradient
              key={angle}
              id={`${gradientPrefix}-petal-${index}`}
              x1="0"
              y1="1"
              x2="0"
              y2="0"
            >
              <Stop offset={fill} stopColor={colors.completed} />
              <Stop offset={fill} stopColor={colors[status]} />
            </LinearGradient>
          );
        })}
      </Defs>
      {petals.map((status, index) => {
        const angle = (index * 360) / petals.length;
        const fill = fills[index] ?? 0;
        const paint = petalPaint({
          status,
          fill,
          colors,
          gradient: `${gradientPrefix}-petal-${index}`,
        });
        return (
          <G key={angle} transform={`rotate(${angle} 12 12)`}>
            <Path d={geometry.path} fill={paint} />
          </G>
        );
      })}
    </Svg>
  );
}
function petalPaint(input: {
  status: PetalStatus;
  fill: number;
  colors: FlowerPalette;
  gradient: string;
}): string {
  if (input.status === "completed" || input.fill >= 1) return input.colors.completed;
  if (input.fill > 0) return `url(#${input.gradient})`;
  return input.colors[input.status];
}

const ThemedFlower = withUnistyles(Flower);

export const ChecklistProgressFlower = memo(function ChecklistProgressFlower({
  completed,
  active,
  blocked,
  credit,
  total,
  testID,
  tooltip = true,
}: ChecklistProgress & { testID?: string; tooltip?: boolean }) {
  const { t } = useTranslation();
  if (total === 0) return null;
  const progress = { completed, active, blocked, credit, total };
  const percent = checklistPercent(progress);
  const label = `${t("message.todo.tasksProgress", { completed, total })} (${percent}%)`;
  const parts = [label, t("message.todo.activeCount", { count: active })];
  if (blocked > 0) parts.push(t("message.todo.blockedCount", { count: blocked }));
  const detail = parts.join(" · ");
  const petals = taskPetals(progress);
  const fills = petalFills(progress);
  return (
    <Tooltip enabledOnDesktop={tooltip}>
      <TooltipTrigger asChild>
        <View
          style={styles.frame}
          testID={testID}
          accessible
          tabIndex={tooltip ? 0 : -1}
          accessibilityRole="progressbar"
          accessibilityLabel={detail}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={detail}
        >
          <ThemedFlower petals={petals} fills={fills} uniProps={palette} />
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
