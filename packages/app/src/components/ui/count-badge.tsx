import { createContext, useContext } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export const CompactCountBadgeContext = createContext(false);

export function CountBadge({
  label,
  count,
  accessibilityLabel,
  testID,
  compact: compactProp,
}: {
  label: string;
  /** Total items when the label contains progress or unread metadata. */
  count?: number;
  accessibilityLabel: string;
  testID?: string;
  compact?: boolean;
}) {
  const inheritedCompact = useContext(CompactCountBadgeContext);
  const compact = compactProp ?? inheritedCompact;
  if (count === 0 || label === "0") return null;
  return (
    <View style={[styles.badge, compact && styles.compact]} testID={testID}>
      <Text
        style={[styles.text, compact && styles.compactText]}
        accessibilityLabel={accessibilityLabel}
      >
        {label}
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
  compact: { maxWidth: "100%", minWidth: 0, flexShrink: 1, paddingHorizontal: 2 },
  compactText: { textAlign: "center", flexShrink: 1 },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
