import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { isDemoSession, resetDemo, exitDemo } from "./mode";

export function DemoControls() {
  if (!isDemoSession()) return null;
  return (
    <View style={styles.row} testID="demo-controls">
      <Text style={styles.label}>Demo</Text>
      <Button variant="ghost" size="sm" onPress={resetDemo} testID="demo-reset">
        Reset
      </Button>
      <Button variant="ghost" size="sm" onPress={exitDemo} testID="demo-exit">
        Exit
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12 },
  label: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
