import { CountBadge } from "@/components/ui/count-badge";
import { useCardDisclosure } from "@/agent-stream/use-card-disclosure";
import { CardDisclosure, CollapsibleCardBody } from "@/agent-stream/card-disclosure";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import {
  TaskCard,
  TaskCardHeader,
  TaskCardActions,
  TaskCardAction,
} from "@/agent-stream/task-card";
import { useVortonTouch } from "@/vorton-touch";
import { useGoalElapsed } from "./use-goal-elapsed";
import { Text, View } from "react-native";
import { useCallback, useMemo } from "react";
import { Pause, Play, BrushCleaning, Pencil } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
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
  const [expanded, setExpanded] = useCardDisclosure("goal");
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  const elapsed = useGoalElapsed(control.state, control.connected);
  const notice = control.connected && !control.error ? queueNotice : null;
  const fixedNotice = useMemo(
    () => (
      <GoalQueueExplanation
        visible={expanded}
        notice={notice}
        onExpand={onExpand}
        onReviewMessages={onReviewMessages}
      />
    ),
    [expanded, notice, onExpand, onReviewMessages],
  );
  const hasGoal = !!control.state?.goal;
  const elapsedBadge = useMemo(
    () =>
      hasGoal ? (
        <CountBadge
          label={formatGoalElapsed(elapsed)}
          narrowLabel={formatGoalElapsed(elapsed, true)}
          accessibilityLabel={`Goal elapsed time: ${formatGoalElapsed(elapsed)}`}
          testID="agent-goal-elapsed"
        />
      ) : null,
    [hasGoal, elapsed],
  );
  if (!control.supported) return null;
  const goal = control.state?.goal;
  if (!goal && !control.error && !queueNotice) return null;
  const paused = !isGoalContinuationEnabled(control.state);
  const label = notice ? "Goal" : goalBarLabel(control);

  return (
    <TaskCard testID="agent-goal-bar" bodyVisible={expanded} notice={fixedNotice}>
      <TaskCardHeader>
        <CardDisclosure
          icon={HEADING_ICON}
          title={label}
          status={goalNoticeStatus(notice)}
          expanded={expanded}
          onPress={toggleExpanded}
          count={elapsedBadge}
          testID="agent-goal-toggle"
        />
        <GoalActions control={control} onExpand={onExpand} compact={compact} />
      </TaskCardHeader>

      <CollapsibleCardBody expanded={expanded} testID="agent-goal-body">
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

function goalNoticeStatus(notice: GoalQueueNotice | null | undefined) {
  return notice?.action ? notice.status : undefined;
}

function GoalQueueExplanation({
  visible,
  notice,
  onExpand,
  onReviewMessages,
}: {
  visible: boolean;
  notice: GoalQueueNotice | null | undefined;
  onExpand: () => void;
  onReviewMessages?: () => void;
}) {
  const touch = useVortonTouch();
  if (!visible || !notice) return null;
  return (
    <View testID="agent-goal-notice" style={[styles.errorRow, styles.notice]}>
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
  const goal = control.state?.goal;
  const paused = !isGoalContinuationEnabled(control.state);
  const action = paused ? "Resume goal" : "Pause goal";
  const pauseHint = "Prevents the goal from continuing automatically.";
  const mutate = control.mutate;
  const toggle = useCallback(() => {
    const status = isGoalContinuationEnabled(control.state) ? "paused" : "active";
    void mutate({ kind: "set", input: { status } }).catch(() => {});
  }, [mutate, control.state]);
  return (
    <TaskCardActions>
      {!compact ? <GoalClearAction control={control} /> : null}
      <TaskCardAction
        iconOnly
        accessibilityLabel="Edit goal"
        testID="agent-goal-expand"
        leftIcon={Pencil}
        onPress={onExpand}
      />
      <TaskCardAction
        iconOnly
        accessibilityLabel={action}
        accessibilityHint={paused ? "Allows the goal to continue automatically." : pauseHint}
        testID="agent-goal-pause-resume"
        leftIcon={paused ? Play : Pause}
        disabled={!control.canMutate || !goal}
        loading={control.pending}
        onPress={toggle}
      />
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
  const mutate = control.mutate;
  const clear = useCallback(() => {
    void mutate({ kind: "clear" }).catch(() => {});
  }, [mutate]);
  return (
    <TaskCardAction
      iconOnly={!labeled}
      accessibilityLabel="Clear goal"
      testID="agent-goal-clear"
      leftIcon={BrushCleaning}
      accessibilityHint="Removes the current goal and its automatic continuation. This cannot be undone."
      disabled={!control.canMutate || !control.state?.goal}
      onPress={clear}
    >
      {labeled ? "Clear goal" : null}
    </TaskCardAction>
  );
}

function goalBarLabel(control: AgentGoalControl): string {
  if (!control.connected) return "Goal offline";
  if (control.error) return "Goal needs attention";
  return goalStatusLabel(control.state);
}

const styles = StyleSheet.create((theme) => ({
  help: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  objective: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  touch: { minWidth: 44, minHeight: 44 },
  errorRow: { alignItems: "flex-start", gap: theme.spacing[1] },
  notice: { paddingHorizontal: 12, paddingBottom: 4 },
  recoveryAction: { alignSelf: "flex-end" },
  error: {
    alignSelf: "stretch",
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));

const HEADING_ICON = <TaskCardIcon kind="goal" />;
