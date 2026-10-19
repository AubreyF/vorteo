import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { taskProgressDescription, taskProgressSummary } from "./task-progress-summary";

export function TaskProgressDetails({ task }: { task: AgentTaskItem }) {
  const summary = taskProgressSummary(task);
  if (!summary) return null;
  const description = taskProgressDescription(summary);
  return (
    <View style={styles.root} testID="checklist-progress-details">
      <View
        style={styles.track}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={description}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={summary.percent}
      >
        <View
          style={[styles.fill, inlineUnistylesStyle({ width: `${summary.percent}%` as const })]}
        />
      </View>
      <Text style={styles.caption}>{description}</Text>
      {(task.checks ?? []).map((check) => (
        <Text
          key={check.text}
          style={[styles.check, check.done && styles.checkDone]}
          accessibilityLabel={`${check.done ? "Passed" : "Not yet passed"}: ${check.text}`}
        >
          {check.done ? "✓ " : "○ "}
          {check.text}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[1] },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
    backgroundColor: theme.colors.border,
  },
  fill: { height: "100%", backgroundColor: theme.colors.foregroundMuted },
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  check: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  checkDone: { color: theme.colors.foregroundMuted },
}));
