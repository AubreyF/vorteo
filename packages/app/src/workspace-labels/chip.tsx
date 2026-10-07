import { useCallback, type ReactElement } from "react";
import { Text, View, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tag } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import {
  WORKSPACE_LABEL_COLORS,
  type WorkspaceLabelColor,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { identityForeground, identityTint } from "@/styles/identity-colors";
import { SPACING } from "@/styles/theme";
import { workspaceLabelDisplayName } from "./display-name";

/**
 * How far the ground extends past the name on each side.
 *
 * Exported because it is the chip's optical offset as much as its padding: a caller that puts a
 * chip at the head of a line has to hang the ground by this much to land the name on the rail.
 * A static number from the spacing scale, not a theme read — see docs/unistyles.md.
 */
export const WORKSPACE_LABEL_CHIP_INSET = SPACING[1.5];
const LabelIcon = withUnistyles(Tag);

/** Custom labels share the compact title-row geometry while retaining their identity colors. */
export function WorkspaceLabelChip({ label }: { label: WorkspaceLabelDefinition }): ReactElement {
  const iconColor = useCallback(
    (theme: Theme) => ({ color: identityForeground(label.color, theme.colorScheme) }),
    [label.color],
  );
  return (
    <View
      style={[styles.chip, CHIP_GROUNDS[label.color]]}
      testID={`workspace-label-chip-${label.name}`}
    >
      <View style={styles.icon}>
        <LabelIcon size={12} uniProps={iconColor} />
      </View>
      <Text style={[styles.name, nameColorStyle(label.color)]} numberOfLines={1}>
        {workspaceLabelDisplayName(label.name)}
      </Text>
    </View>
  );
}

// `identityTint` is theme-independent — one hex per name at 10% alpha — so unlike the text color
// these can be built once at module load. There is no Unistyles proxy here to freeze against
// whichever theme happened to be active first.
const CHIP_GROUNDS: Record<WorkspaceLabelColor, ViewStyle> = Object.fromEntries(
  WORKSPACE_LABEL_COLORS.map((color) => [color, { backgroundColor: identityTint(color) }]),
) as Record<WorkspaceLabelColor, ViewStyle>;

const styles = StyleSheet.create((theme) => ({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    overflow: "hidden",
    // Yields space the way the host badge does, so a long label truncates instead of pushing
    // the change request and its checks off the line.
    flexShrink: 1,
    minWidth: 0,
    paddingHorizontal: WORKSPACE_LABEL_CHIP_INSET,
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.lg,
  },
  icon: { flexShrink: 0 },
  name: {
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    minWidth: 0,
  },
  // Text has no `color` prop to hand a mapping to, so the name's color has to come from a
  // registered style — one per color, picked at render time. See docs/unistyles.md.
  nameViolet: { color: identityForeground("violet", theme.colorScheme) },
  nameSky: { color: identityForeground("sky", theme.colorScheme) },
  nameEmerald: { color: identityForeground("emerald", theme.colorScheme) },
  nameOrange: { color: identityForeground("orange", theme.colorScheme) },
  namePink: { color: identityForeground("pink", theme.colorScheme) },
  nameIndigo: { color: identityForeground("indigo", theme.colorScheme) },
  nameTeal: { color: identityForeground("teal", theme.colorScheme) },
  nameRed: { color: identityForeground("red", theme.colorScheme) },
  nameAmber: { color: identityForeground("amber", theme.colorScheme) },
  nameBlue: { color: identityForeground("blue", theme.colorScheme) },
}));

function nameColorStyle(color: WorkspaceLabelColor) {
  switch (color) {
    case "violet":
      return styles.nameViolet;
    case "sky":
      return styles.nameSky;
    case "emerald":
      return styles.nameEmerald;
    case "orange":
      return styles.nameOrange;
    case "pink":
      return styles.namePink;
    case "indigo":
      return styles.nameIndigo;
    case "teal":
      return styles.nameTeal;
    case "red":
      return styles.nameRed;
    case "amber":
      return styles.nameAmber;
    case "blue":
      return styles.nameBlue;
  }
}
