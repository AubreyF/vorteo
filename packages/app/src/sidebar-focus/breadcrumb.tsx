import { Fragment, useCallback, useState, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
} from "react-native";
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
import {
  sidebarBreadcrumbActionsVisible,
  type SidebarFocusCrumb,
  type SidebarFocusTarget,
} from "./model";

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
 * own row is hidden, so its actions trail the last segment: on hover with a pointer, while
 * keyboard focus is inside them, and always where rows cannot be hovered.
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
  // Hidden actions stay mounted and reachable by Tab, so keyboard focus reveals them too.
  const [hasFocusWithin, setHasFocusWithin] = useState(false);
  const handleFocus = useCallback(() => setHasFocusWithin(true), []);
  const handleBlur = useCallback((event: NativeSyntheticEvent<unknown>) => {
    const group = event.currentTarget as unknown as { contains?: (node: unknown) => boolean };
    const next = (event.nativeEvent as { relatedTarget?: unknown } | undefined)?.relatedTarget;
    // Moving between the group's own buttons keeps it revealed.
    if (next && group.contains?.(next)) return;
    setHasFocusWithin(false);
  }, []);
  const last = trail[trail.length - 1];

  if (!controller || !last) return null;
  const ancestors = trail.slice(0, -1);
  const actionsVisible = sidebarBreadcrumbActionsVisible({
    isHovered,
    hasFocusWithin,
    hoverUnavailable: touch || compact || isNative,
  });
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
            <ThemedChevronRight size={14} uniProps={mutedColorMapping} />
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
          onFocus={handleFocus}
          onBlur={handleBlur}
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
    columnGap: theme.spacing[1.5],
    rowGap: theme.spacing[0.5],
  },
  crumb: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
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
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 20,
    flexShrink: 1,
  },
  actions: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  actionsHidden: { opacity: 0 },
}));
