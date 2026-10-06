import { useMemo, type ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ComboboxItem } from "@/components/ui/combobox";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

export const ProfileLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
}));

export function ProfileLoading({ label }: { label: string }) {
  return (
    <View style={profileTileStyles.loading}>
      <ProfileLoadingSpinner />
      <Text style={profileTileStyles.subtitle}>{label}</Text>
    </View>
  );
}

export function ProfileSelectorTile({
  label,
  subtitle,
  leading,
  badge,
  selected,
  disabled,
  onPress,
  testID,
  style,
}: {
  label: string;
  subtitle: ReactNode;
  leading?: ReactNode;
  badge?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
  style?: StyleProp<ViewStyle>;
}) {
  const labelContent = useMemo(
    () => (
      <View style={profileTileStyles.lines}>
        <View style={profileTileStyles.line}>
          <Text style={profileTileStyles.title} numberOfLines={1}>
            {label}
          </Text>
          {badge}
        </View>
        <View style={profileTileStyles.line}>
          {typeof subtitle === "string" ? (
            <Text style={profileTileStyles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )}
        </View>
      </View>
    ),
    [label, badge, subtitle],
  );
  return (
    <ComboboxItem
      label={label}
      selected={selected}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      selectionPlacement="none"
      leadingSlot={leading}
      style={[profileTileStyles.tile, selected && profileTileStyles.selected, style]}
      interactionStyle={
        selected ? profileTileStyles.selectedInteraction : profileTileStyles.interaction
      }
      labelSlot={labelContent}
    />
  );
}

export const profileTileStyles = StyleSheet.create((theme) => ({
  tile: {
    height: Math.ceil(theme.fontSize.base * 1.25) * 2 + theme.spacing[1] + theme.spacing[3] * 2 + 2,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1.5],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: "transparent",
  },
  selected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSubtle },
  interaction: { backgroundColor: theme.colors.surface3 },
  selectedInteraction: { backgroundColor: theme.colors.accentSubtleHovered },
  lines: { gap: theme.spacing[1], minWidth: 0 },
  line: {
    height: Math.ceil(theme.fontSize.base * 1.25),
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    lineHeight: Math.ceil(theme.fontSize.base * 1.25),
  },
  subtitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.ceil(theme.fontSize.base * 1.25),
  },
  loading: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
}));
