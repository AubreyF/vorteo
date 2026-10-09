import { Circle, CircleCheck, CircleAlert } from "lucide-react-native";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusRing } from "@/components/status-ring";
import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";

const ThemedCircle = withUnistyles(Circle);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleAlert = withUnistyles(CircleAlert);

const extraMutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

function TaskStatusIcon({
  isCompleted,
  isRunning,
  isBlocked,
}: {
  isCompleted: boolean;
  isRunning: boolean;
  isBlocked: boolean;
}) {
  if (isCompleted) {
    return <ThemedCircleCheck size={16} uniProps={extraMutedIcon} />;
  }
  if (isRunning) {
    return <StatusRing variant="task" />;
  }
  if (isBlocked) return <ThemedCircleAlert size={16} uniProps={extraMutedIcon} />;
  // A pending task's ring is a status mark, not a checkbox. At the muted step it carries the
  // weight of an enabled control and invites a click that does nothing, so it sits one step back
  // from the text it marks.
  return <ThemedCircle size={16} uniProps={extraMutedIcon} />;
}

export const TaskListRow = memo(function TaskListRow({
  task,
  compact = false,
}: {
  task: TodoEntry;
  compact?: boolean;
}) {
  const isCompleted = task.completed || task.status === "completed";
  const isBlocked = !isCompleted && task.status === "blocked";
  const isRunning = !isCompleted && task.status === "in_progress";
  const text = isRunning && task.activeForm ? task.activeForm : task.text;

  return (
    <View style={styles.row} accessibilityLabel={text}>
      <TaskStatusIcon isCompleted={isCompleted} isRunning={isRunning} isBlocked={isBlocked} />
      <Text
        numberOfLines={1}
        style={[
          styles.text,
          compact && styles.compactText,
          isRunning && styles.runningText,
          isCompleted && styles.completedText,
        ]}
      >
        {text}
      </Text>
      {isBlocked ? <StatusBadge label="Blocked" variant="warning" size="xs" /> : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // Grows and shrinks, but keeps an `auto` basis: a zero-basis label reports no intrinsic width,
  // and a container that sizes itself to its content — the composer track panel — measures the
  // row as empty and truncates it against a surface that had room to spare.
  text: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  compactText: { fontSize: theme.fontSize.sm },
  runningText: {
    color: theme.colors.foreground,
  },
  completedText: {
    color: theme.colors.foregroundExtraMuted,
    textDecorationLine: "line-through",
  },
}));
