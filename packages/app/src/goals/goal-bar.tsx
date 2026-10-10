import { CardDisclosure, CollapsibleCardBody } from "@/agent-stream/card-disclosure";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { TaskCard, TaskCardHeader, TaskCardActions } from "@/agent-stream/task-card";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { useGoalElapsed } from "./use-goal-elapsed";
import { Text, View } from "react-native";
import { useCallback, useState } from "react";
import { Pause, Play, Trash2, Pencil } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useVortonTouch } from "@/vorton-touch";
import { goalStatusLabel, isGoalContinuationEnabled, formatGoalElapsed } from "./goal-presentation";
import type { AgentGoalControl } from "./use-agent-goal";
import type { GoalQueueNotice } from "./goal-presentation";

interface GoalBarProps {
  control: AgentGoalControl;
  onExpand: () => void;
  queueNotice?: GoalQueueNotice | null;
  onReviewMessages?: () => void;
}

export function GoalBar({ control, onExpand, queueNotice, onReviewMessages }: GoalBarProps) {
  const compact = useIsCompactFormFactor();
  const [expanded, setExpanded] = useState(true);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const elapsed = useGoalElapsed(control.state, control.connected);
  if (!control.supported) return null;
  const goal = control.state?.goal;
  if (!goal && !control.error && !queueNotice) return null;
  const paused = !isGoalContinuationEnabled(control.state);
  const notice = control.connected && !control.error ? queueNotice : null;
  const label = notice ? "Goal" : goalBarLabel(control);

  return (
    <TaskCard testID="agent-goal-bar" bodyVisible={expanded}>
      <TaskCardHeader>
        <CardDisclosure
          icon={HEADING_ICON}
          title={label}
          status={notice?.status}
          expanded={expanded}
          onPress={toggleExpanded}
          testID="agent-goal-toggle"
        />
        {goal && !compact ? (
          <Text style={styles.elapsed} numberOfLines={1}>
            Goal time: {formatGoalElapsed(elapsed)}
          </Text>
        ) : null}
        <GoalActions control={control} onExpand={onExpand} compact={compact} />
      </TaskCardHeader>

      <CollapsibleCardBody expanded={expanded} testID="agent-goal-body">
        {goal && compact ? (
          <Text style={styles.elapsed}>Goal time: {formatGoalElapsed(elapsed)}</Text>
        ) : null}
        <GoalQueueExplanation
          notice={notice}
          onExpand={onExpand}
          onReviewMessages={onReviewMessages}
        />
        {goal && !paused ? (
          <Text style={styles.help}>
            Pause goal prevents the goal from continuing automatically.
          </Text>
        ) : null}
        <Text style={styles.objective} selectable>
          {goal?.objective}
        </Text>
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
        {compact ? <GoalClearAction control={control} labeled /> : null}
      </CollapsibleCardBody>
    </TaskCard>
  );
}

function GoalQueueExplanation({
  notice,
  onExpand,
  onReviewMessages,
}: {
  notice: GoalQueueNotice | null | undefined;
  onExpand: () => void;
  onReviewMessages?: () => void;
}) {
  const touch = useVortonTouch();
  if (!notice) return null;
  return (
    <View style={styles.errorRow}>
      <Text
        accessibilityRole={notice.action ? "alert" : undefined}
        style={notice.action ? styles.error : styles.help}
      >
        {notice.message}
      </Text>
      {notice.action ? (
        <Button
          variant="ghost"
          size="sm"
          style={[styles.recoveryAction, touch && styles.touch]}
          testID="agent-goal-review"
          onPress={notice.action === "goal" ? onExpand : onReviewMessages}
        >
          {notice.action === "goal" ? "Review goal" : "Review queued messages"}
        </Button>
      ) : null}
    </View>
  );
}

function GoalActions({
  control,
  onExpand,
  compact,
}: Pick<GoalBarProps, "control" | "onExpand"> & { compact: boolean }) {
  const touch = useVortonTouch();
  const goal = control.state?.goal;
  const paused = !isGoalContinuationEnabled(control.state);
  const action = paused ? "Resume goal" : "Pause goal";
  const pauseHint = "Prevents the goal from continuing automatically.";
  const iconStyle = [taskCardStyles.iconAction, touch && taskCardStyles.touchAction];
  const mutate = control.mutate;
  const toggle = useCallback(() => {
    const status = isGoalContinuationEnabled(control.state) ? "paused" : "active";
    void mutate({ kind: "set", input: { status } }).catch(() => {});
  }, [mutate, control.state]);
  return (
    <TaskCardActions>
      {!compact ? <GoalClearAction control={control} /> : null}
      <Button
        variant="ghost"
        size="sm"
        style={iconStyle}
        accessibilityLabel="Edit goal"
        testID="agent-goal-expand"
        leftIcon={editIcon}
        onPress={onExpand}
      />
      <Tooltip enabledOnDesktop={!touch}>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            style={iconStyle}
            accessibilityLabel={action}
            accessibilityHint={paused ? "Allows the goal to continue automatically." : pauseHint}
            testID="agent-goal-pause-resume"
            leftIcon={paused ? playIcon : pauseIcon}
            disabled={!control.canMutate || !goal}
            loading={control.pending}
            onPress={toggle}
          />
        </TooltipTrigger>
        <TooltipContent>
          <Text style={styles.help}>
            {action}
            {paused ? "" : `. ${pauseHint}`}
          </Text>
        </TooltipContent>
      </Tooltip>
    </TaskCardActions>
  );
}

function GoalClearAction({
  control,
  labeled = false,
}: {
  control: AgentGoalControl;
  labeled?: boolean;
}) {
  const touch = useVortonTouch();
  const mutate = control.mutate;
  const clear = useCallback(() => {
    void mutate({ kind: "clear" }).catch(() => {});
  }, [mutate]);
  return (
    <Button
      variant="ghost"
      size="sm"
      style={
        labeled
          ? [styles.recoveryAction, touch && styles.touch]
          : [taskCardStyles.iconAction, touch && taskCardStyles.touchAction]
      }
      accessibilityLabel="Clear goal"
      testID="agent-goal-clear"
      leftIcon={trashIcon}
      disabled={!control.canMutate || !control.state?.goal}
      onPress={clear}
    >
      {labeled ? "Clear goal" : null}
    </Button>
  );
}

function goalBarLabel(control: AgentGoalControl): string {
  if (!control.connected) return "Goal offline";
  if (control.error) return "Goal needs attention";
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
  help: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  objective: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  elapsed: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  touch: { minWidth: 44, minHeight: 44 },
  errorRow: { alignItems: "flex-start", gap: theme.spacing[1] },
  recoveryAction: { alignSelf: "flex-end" },
  error: { alignSelf: "stretch", color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));

const HEADING_ICON = <TaskCardIcon kind="goal" />;
