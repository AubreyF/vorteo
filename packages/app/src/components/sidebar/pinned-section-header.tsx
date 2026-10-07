import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useVortonTouch } from "@/vorton-touch";
import { isNative } from "@/constants/platform";
import { useSidebarRowDensity } from "./use-sidebar-row-density";
import { StatusBadge } from "@/components/ui/status-badge";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function PinnedSectionHeader({
  collapsed,
  onToggle,
  title,
  testID = "sidebar-pinned-section-header",
  indented = false,
  count,
}: {
  collapsed: boolean;
  onToggle: () => void;
  title?: string;
  testID?: string;
  indented?: boolean;
  count?: number;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const touch = useVortonTouch();
  const density = useSidebarRowDensity();
  const showTouchControls = isCompact || touch;
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;

  const rowStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
      styles.header,
      indented && styles.indented,
      indented && density,
      touch && styles.touchHeader,
      indented && hovered && styles.hovered,
      indented && pressed && styles.pressed,
    ],
    [indented, density, touch],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={onToggle}
      style={rowStyle}
      testID={testID}
    >
      {({ hovered }) => (
        <>
          {indented ? (
            <View style={styles.chevron}>
              <Chevron size={12} uniProps={foregroundMutedColorMapping} />
            </View>
          ) : null}
          <Text style={[styles.title, indented && styles.workspaceTitle]}>
            {title ?? t("sidebar.pinned.title")}
          </Text>
          {collapsed && count !== undefined ? (
            <StatusBadge label={String(count)} size="xs" shape="row" />
          ) : null}
          {!indented && (hovered || isNative || showTouchControls) ? (
            <Chevron size={12} uniProps={foregroundMutedColorMapping} />
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    userSelect: "none",
    borderRadius: theme.borderRadius.lg,
  },
  hovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  pressed: { backgroundColor: theme.colors.surface2 },
  chevron: { position: "absolute", left: theme.spacing[2] },
  indented: {
    alignSelf: "stretch",
    // Match the filled dot inside the grouped workspace row’s centered icon slot.
    paddingLeft: theme.spacing[2] * 2 + (theme.iconSize.md - STATUS_INDICATOR_FILLED_DOT_SIZE) / 2,
  },
  workspaceTitle: { fontSize: theme.fontSize.base, lineHeight: 20 },
  touchHeader: { minHeight: 44 },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
