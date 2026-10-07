import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function CountBadge({
  label,
  accessibilityLabel,
  testID,
}: {
  label: string;
  accessibilityLabel: string;
  testID?: string;
}) {
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
