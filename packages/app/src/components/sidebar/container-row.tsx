import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useVortonTouch } from "@/vorton-touch";
import { sidebarIndentStyle } from "./indent";
import { SidebarCountBadge } from "./sidebar-count-badge";
import { SidebarFolderIcon, SidebarLeadingSlot, type SidebarDisclosure } from "./leading-slot";
import { useSidebarRowDensity } from "./use-sidebar-row-density";

/** Geometry shared by folder-like rows: sidebar folders, Standing and Factory. */
export const sidebarContainerRowStyles = StyleSheet.create((theme) => ({
  row: {
    position: "relative",
    minHeight: 36,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  rowPressed: { backgroundColor: theme.colors.surface2 },
  main: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

function collapsibleChevron(collapsible: boolean, collapsed: boolean): SidebarDisclosure {
  if (!collapsible) return null;
  return collapsed ? "expand" : "collapse";
}

/**
 * A project's Standing or Factory heading. It reads as a folder: folder icon, hover arrow and
 * the same indent as the project's other direct children.
 */
export function SidebarSectionRow({
  title,
  count,
  collapsed,
  collapsible = true,
  onToggle,
  level,
  testID,
  trailing,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  /** False for a focused top level, which shows its icon without an arrow. */
  collapsible?: boolean;
  onToggle: () => void;
  level: number;
  testID: string;
  /** Rendered after the title, such as the focus button; receives the hover state. */
  trailing?: (isHovered: boolean) => ReactNode;
}) {
  const density = useSidebarRowDensity();
  const touch = useVortonTouch();
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const handlePointerEnter = useCallback(() => {
    if (!touch) setIsHovered(true);
  }, [touch]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePressIn = useCallback(() => setIsPressed(true), []);
  const handlePressOut = useCallback(() => setIsPressed(false), []);
  const rowStyle = useMemo(
    () => [
      sidebarContainerRowStyles.row,
      density,
      sidebarIndentStyle(level),
      isHovered && sidebarContainerRowStyles.rowHovered,
      isPressed && sidebarContainerRowStyles.rowPressed,
    ],
    [density, level, isHovered, isPressed],
  );
  const countLabel = String(count);

  return (
    <View
      style={rowStyle}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={testID}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={accessibilityState}
        onPress={collapsible ? onToggle : undefined}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={sidebarContainerRowStyles.main}
        testID={`${testID}-toggle`}
      >
        <SidebarLeadingSlot
          chevron={collapsibleChevron(collapsible, collapsed)}
          revealChevron={isHovered || touch}
        >
          <SidebarFolderIcon />
        </SidebarLeadingSlot>
        <Text style={sidebarContainerRowStyles.title} numberOfLines={1}>
          {title}
        </Text>
        {collapsed ? (
          <SidebarCountBadge
            label={countLabel}
            accessibilityLabel={`${title}: ${countLabel}`}
            testID={`count-${testID}`}
          />
        ) : null}
      </Pressable>
      {trailing?.(isHovered)}
    </View>
  );
}
