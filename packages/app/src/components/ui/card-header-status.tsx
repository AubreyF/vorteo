import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/** A stable, single-line heading slot. Mount it even while idle, before header actions. */
export function CardHeaderStatus({ text, testID }: { text?: string | null; testID?: string }) {
  return (
    <View style={styles.slot} testID={testID}>
      <Text
        style={styles.text}
        numberOfLines={1}
        ellipsizeMode="tail"
        accessibilityLiveRegion="polite"
        accessibilityLabel={text || undefined}
      >
        {text || ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: { flex: 1, minWidth: 0, height: 20, justifyContent: "center", overflow: "hidden" },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    textAlign: "right",
  },
}));
