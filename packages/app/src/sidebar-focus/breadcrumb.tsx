import { Fragment, useCallback, useEffect, useRef } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { Shortcut } from "@/components/ui/shortcut";
import { SIDEBAR_ROW_INSET } from "@/components/sidebar/indent";
import type { Theme } from "@/styles/theme";
import { LIST_ROW_TOUCH_ACTION_SIZE } from "@/styles/list-row-metrics";
import { useVortonTouch } from "@/vorton-touch";
import { useSidebarFocus } from "./context";
import type { SidebarFocusCrumb, SidebarFocusTarget } from "./model";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ESCAPE_KEYS = ["Esc"];

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
 * level; All projects leaves focus. There is deliberately no back button.
 */
export function SidebarFocusBreadcrumb({ trail }: { trail: readonly SidebarFocusCrumb[] }) {
  const { t } = useTranslation();
  const controller = useSidebarFocus();
  const containerRef = useRef<View>(null);
  const last = trail[trail.length - 1];
  const lastKey = last?.key;

  // After a click moves focus, keep keyboard focus in the sidebar so Escape can leave it.
  useEffect(() => {
    if (!isWeb || !controller?.takeKeyboardFocusRequest()) return;
    const element = containerRef.current as unknown as HTMLElement | null;
    element?.focus({ preventScroll: true });
  }, [controller, lastKey]);

  if (!controller || !last) return null;
  const ancestors = trail.slice(0, -1);
  return (
    <View
      ref={containerRef}
      tabIndex={-1}
      role="navigation"
      accessibilityLabel={t("sidebar.focus.breadcrumb")}
      style={styles.container}
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
      <Shortcut keys={ESCAPE_KEYS} style={styles.escapeHint} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
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
  escapeHint: {
    flexShrink: 0,
  },
}));
