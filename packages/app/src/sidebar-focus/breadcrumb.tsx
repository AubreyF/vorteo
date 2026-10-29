import { Fragment, useCallback, useState, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SIDEBAR_ROW_INSET } from "@/components/sidebar/indent";
import type { Theme } from "@/styles/theme";
import { LIST_ROW_TOUCH_ACTION_SIZE } from "@/styles/list-row-metrics";
import { useVortonTouch } from "@/vorton-touch";
import { useSidebarFocus } from "./context";
import type { SidebarFocusCrumb, SidebarFocusTarget } from "./model";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function crumbTextStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.crumb, hovered && styles.crumbHovered];
}

function Crumb({
  crumb,
  onSelect,
}: {
  crumb: SidebarFocusCrumb;
  onSelect: (target: SidebarFocusTarget | null) => void;
}) {
  const touch = useVortonTouch();
  const handlePress = useCallback(() => onSelect(crumb.target), [onSelect, crumb.target]);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={crumb.label}
      onPress={handlePress}
      style={touch && styles.touchCrumb}
      testID={`sidebar-focus-crumb-${crumb.key}`}
    >
      {(state) => (
        <Text style={crumbTextStyle(state)} numberOfLines={1}>
          {crumb.label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * The path from All projects to the focused item. Every segment but the last focuses that
 * level; All projects leaves focus. There is deliberately no back button. The focused item's
 * own row is hidden, so its actions trail the last segment: on hover with a pointer, always
 * where rows cannot be hovered, exactly as row actions are.
 */
export function SidebarFocusBreadcrumb({
  trail,
  actions,
}: {
  trail: readonly SidebarFocusCrumb[];
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const controller = useSidebarFocus();
  const touch = useVortonTouch();
  const compact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => {
    if (!touch) setIsHovered(true);
  }, [touch]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const last = trail[trail.length - 1];

  if (!controller || !last) return null;
  const ancestors = trail.slice(0, -1);
  const actionsVisible = isHovered || touch || compact || isNative;
  return (
    <View
      role="navigation"
      accessibilityLabel={t("sidebar.focus.breadcrumb")}
      style={styles.container}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID="sidebar-focus-breadcrumb"
    >
      <View style={styles.trail}>
        {ancestors.map((crumb) => (
          <Fragment key={crumb.key}>
            <Crumb crumb={crumb} onSelect={controller.focusOn} />
            <ThemedChevronRight size={12} uniProps={mutedColorMapping} />
          </Fragment>
        ))}
        <Text
          style={styles.current}
          numberOfLines={1}
          accessibilityRole="header"
          testID="sidebar-focus-current"
        >
          {last.label}
        </Text>
      </View>
      {actions ? (
        <View
          style={[styles.actions, !actionsVisible && styles.actionsHidden]}
          pointerEvents={actionsVisible ? "auto" : "none"}
          testID="sidebar-focus-actions"
        >
          {actions}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    // Actions belong to the last segment, which ends the trail's last line.
    alignItems: "flex-end",
    gap: theme.spacing[2],
    paddingLeft: SIDEBAR_ROW_INSET,
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    marginBottom: theme.spacing[1],
  },
  trail: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: theme.spacing[1],
    rowGap: theme.spacing[0.5],
  },
  crumb: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  touchCrumb: {
    minWidth: LIST_ROW_TOUCH_ACTION_SIZE,
    minHeight: LIST_ROW_TOUCH_ACTION_SIZE,
    justifyContent: "center",
  },
  crumbHovered: {
    color: theme.colors.foreground,
    textDecorationLine: "underline",
  },
  current: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 18,
    flexShrink: 1,
  },
  actions: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  actionsHidden: { opacity: 0 },
}));
