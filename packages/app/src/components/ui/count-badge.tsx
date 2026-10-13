import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function CountBadge({
  label,
  count,
  accessibilityLabel,
  testID,
}: {
  label: string;
  /** Total items when the label contains progress or unread metadata. */
  count?: number;
  accessibilityLabel: string;
  testID?: string;
}) {
  if (count === 0 || label === "0") return null;
  return (
    <View style={styles.badge} testID={testID}>
      <Text style={styles.text} accessibilityLabel={accessibilityLabel}>
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
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
