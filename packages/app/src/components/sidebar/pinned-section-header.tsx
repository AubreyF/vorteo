import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useVortonTouch } from "@/vorton-touch";
import { isNative } from "@/constants/platform";
import { SidebarCountBadge } from "./sidebar-count-badge";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});

export function PinnedSectionHeader({
  collapsed,
  onToggle,
  title,
  testID = "sidebar-pinned-section-header",
  count,
}: {
  collapsed: boolean;
  onToggle: () => void;
  title?: string;
  testID?: string;
  count?: number;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const touch = useVortonTouch();
  const showTouchControls = isCompact || touch;
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;

  const rowStyle = useMemo(() => [styles.header, touch && styles.touchHeader], [touch]);

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
          <Text style={styles.title}>{title ?? t("sidebar.pinned.title")}</Text>
          {collapsed && count !== undefined ? (
            <SidebarCountBadge
              label={String(count)}
              accessibilityLabel={`${title ?? t("sidebar.pinned.title")}: ${count}`}
              testID={`count-${testID}`}
            />
          ) : null}
          {hovered || isNative || showTouchControls ? (
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
  touchHeader: { minHeight: 44 },
  title: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
