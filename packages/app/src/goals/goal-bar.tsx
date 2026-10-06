import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { useGoalElapsed } from "./use-goal-elapsed";
import { Text, View } from "react-native";
import { useCallback } from "react";
import { Pause, Play, Trash2, Pencil } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useVortonTouch } from "@/vorton-touch";
import { goalStatusLabel, isGoalContinuationEnabled, formatGoalElapsed } from "./goal-presentation";
import type { AgentGoalControl } from "./use-agent-goal";
import { queueGoalRecoveryMessage } from "@/message-queue/goal-error";

interface GoalBarProps {
  control: AgentGoalControl;
  onExpand: () => void;
  queueError?: string | null;
}

export function GoalBar({ control, onExpand, queueError }: GoalBarProps) {
  const touch = useVortonTouch();
  const iconStyle = [taskCardStyles.iconAction, touch && taskCardStyles.touchAction];
  const mutate = control.mutate;
  const toggle = useCallback(() => {
    const status = isGoalContinuationEnabled(control.state) ? "paused" : "active";
    void mutate({ kind: "set", input: { status } }).catch(() => {});
  }, [mutate, control.state]);
  const clear = useCallback(() => {
    void mutate({ kind: "clear" }).catch(() => {});
  }, [mutate]);
  const elapsed = useGoalElapsed(control.state, control.connected);
  if (!control.supported) return null;
  const goal = control.state?.goal;
  if (!goal && !control.error && !queueError) return null;
  const paused = !isGoalContinuationEnabled(control.state);
  const action = paused ? "Resume goal" : "Pause goal";
  const label = goalBarLabel(control);

  return (
    <View style={taskCardStyles.container} testID="agent-goal-bar">
      <View
        style={[
          taskCardStyles.header,
          touch && taskCardStyles.touchHeader,
          !touch && styles.actionInset,
        ]}
      >
        <View style={styles.copy}>
          <Text style={taskCardStyles.heading}>{label}</Text>
        </View>
        {goal ? <Text style={styles.elapsed}>{formatGoalElapsed(elapsed)}</Text> : null}
        <View style={taskCardStyles.actions}>
          <Button
            variant="ghost"
            size="sm"
            style={iconStyle}
            accessibilityLabel="Clear goal"
            testID="agent-goal-clear"
            leftIcon={trashIcon}
            disabled={!control.canMutate || !goal}
            onPress={clear}
          />
          <Button
            variant="ghost"
            size="sm"
            style={iconStyle}
            accessibilityLabel="Edit goal"
            testID="agent-goal-expand"
            leftIcon={editIcon}
            onPress={onExpand}
          />
          <Button
            variant="ghost"
            size="sm"
            style={iconStyle}
            accessibilityLabel={action}
            testID="agent-goal-pause-resume"
            leftIcon={paused ? playIcon : pauseIcon}
            disabled={!control.canMutate || !goal}
            loading={control.pending}
            onPress={toggle}
          />
        </View>
      </View>
      <Text style={styles.objective} numberOfLines={2} selectable>
        {goal?.objective}
      </Text>
      {queueError ? (
        <View style={styles.errorRow}>
          <Text accessibilityRole="alert" style={styles.error}>
            {queueGoalRecoveryMessage(queueError)}
          </Text>
          <Button
            variant="default"
            size="sm"
            style={[styles.recoveryAction, touch && styles.touch]}
            testID="agent-goal-review"
            onPress={onExpand}
          >
            Review goal
          </Button>
        </View>
      ) : null}
      {control.error ? (
        <View style={styles.errorRow}>
          <Text accessibilityRole="alert" style={styles.error}>
            {control.error}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            disabled={!control.connected || control.refreshing}
            onPress={control.refresh}
          >
            Refresh
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function goalBarLabel(control: AgentGoalControl): string {
  if (!control.connected) return "Goal offline";
  return goalStatusLabel(control.state);
}

function pauseIcon(color: string) {
  return <Pause size={16} color={color} />;
}
function playIcon(color: string) {
  return <Play size={16} color={color} />;
}
function trashIcon(color: string) {
  return <Trash2 size={16} color={color} />;
}
function editIcon(color: string) {
  return <Pencil size={16} color={color} />;
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  copy: { flex: 1, minWidth: 0 },
  objective: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  elapsed: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  touch: { minWidth: 44, minHeight: 44 },
  actionInset: { paddingRight: theme.spacing[1] },
  errorRow: { alignItems: "flex-start", gap: theme.spacing[1] },
  recoveryAction: { alignSelf: "flex-end" },
  error: { alignSelf: "stretch", color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
