import { createContext, useContext } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export const CompactCountBadgeContext = createContext({ compact: false, narrow: false });

export function CountBadge({
  label,
  narrowLabel,
  count,
  accessibilityLabel,
  testID,
  compact: compactProp,
}: {
  label: string;
  narrowLabel?: string;
  /** Total items when the label contains progress or unread metadata. */
  count?: number;
  accessibilityLabel: string;
  testID?: string;
  compact?: boolean;
}) {
  const layout = useContext(CompactCountBadgeContext);
  const compact = compactProp ?? layout.compact;
  const visibleLabel = layout.narrow ? (narrowLabel ?? label) : label;
  if (count === 0 || label === "0") return null;
  return (
    <View style={[styles.badge, compact && styles.compact]} testID={testID}>
      <Text
        style={[styles.text, compact && styles.compactText]}
        accessibilityLabel={accessibilityLabel}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {visibleLabel}
      </Text>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  badge: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    minWidth: 20,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[0.5],
    alignItems: "center",
    flexShrink: 0,
  },
  compact: {
    maxWidth: "100%",
    minWidth: 0,
    flexShrink: 1,
    paddingHorizontal: 0,
    paddingVertical: 0,
    backgroundColor: "transparent",
  },
  compactText: { textAlign: "center", flexShrink: 1 },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
