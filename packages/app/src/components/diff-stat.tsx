import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatDiffCount } from "@/git/file-header-presentation";

interface DiffStatProps {
  additions: number;
  deletions: number;
  testID?: string;
  hideZero?: boolean;
}

export function DiffStat({ additions, deletions, testID, hideZero = false }: DiffStatProps) {
  if (hideZero && additions === 0 && deletions === 0) return null;
  return (
    <View style={styles.row} testID={testID}>
      {(!hideZero || additions !== 0) && (
        <Text style={styles.additions}>+{formatDiffCount(additions)}</Text>
      )}
      {(!hideZero || deletions !== 0) && (
        <Text style={styles.deletions}>-{formatDiffCount(deletions)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: 20,
    gap: 4,
    flexShrink: 0,
  },
  additions: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
  },
  deletions: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
  },
}));
