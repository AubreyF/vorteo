import { ActionFooter } from "@/components/ui/action-footer";
import { useGoalElapsed } from "./use-goal-elapsed";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openGoalForm, goalIdentity } from "./goal-form-model";
import { formatGoalElapsed, GOAL_STATUS_LABELS } from "./goal-presentation";
import type { AgentGoalControl } from "./use-agent-goal";

interface GoalDetailsProps {
  control: AgentGoalControl;
  draft: string;
  onClose: () => void;
  onCreated: (draft: string) => void;
}

// Mount a fresh editor per opening. Live goal notifications must not replace an
// in-progress objective, including while tokens and elapsed accounting change.
export function GoalDetails({ control, draft, onClose, onCreated }: GoalDetailsProps) {
  const elapsed = useGoalElapsed(control.state, control.connected);
  const goal = control.state?.goal ?? null;
  const [initialDraft] = useState(draft);
  const [initialIdentity] = useState(() => goalIdentity(goal));
  const [model] = useState(() => openGoalForm({ goal, draft }));
  useEffect(() => () => model.close(), [model]);
  const form = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const changedElsewhere = initialIdentity !== goalIdentity(goal);
  const mutate = control.mutate;
  const disabled = !control.canMutate || !form.input || changedElsewhere;
  const save = useCallback(async () => {
    if (disabled || !form.input) return;
    try {
      await mutate({ kind: "set", input: form.input });
      if (!goal) onCreated(initialDraft);
      onClose();
    } catch {
      // The shared control renders the mutation error and preserves this draft.
    }
  }, [disabled, form.input, mutate, goal, onCreated, onClose, initialDraft]);
  const title = goal ? "Goal details" : "New goal";
  const submitLabel = goal ? "Save goal" : "Start goal";
  const header = useMemo(() => ({ title }), [title]);
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} desktopMaxWidth={620}>
      <View style={styles.body} testID="agent-goal-details">
        {goal ? (
          <Text style={styles.hint} selectable>
            {GOAL_STATUS_LABELS[goal.status]} · {formatGoalElapsed(elapsed)} ·{" "}
            {goal.tokensUsed.toLocaleString()} tokens used
            {goal.tokenBudget === null
              ? " · No token budget"
              : ` / ${goal.tokenBudget.toLocaleString()} budget`}
          </Text>
        ) : null}
        <Field label="Objective">
          <FormTextInput
            size={size}
            initialValue={model.initialObjective}
            onChangeText={model.setObjective}
            multiline
            maxLength={4000}
            editable={!control.pending}
            style={styles.objective}
            accessibilityLabel="Goal objective"
            testID="agent-goal-objective"
          />
        </Field>
        <Field
          label="Token budget"
          hint="Leave empty for no token budget. Usage measures effort, not task completion."
        >
          <FormTextInput
            size={size}
            initialValue={model.initialBudget}
            onChangeText={model.setBudget}
            keyboardType="numeric"
            editable={!control.pending}
            accessibilityLabel="Goal token budget"
            testID="agent-goal-budget"
          />
        </Field>
        <Text style={styles.hint}>
          Pause stops automatic continuation. The current turn can finish; use Stop in the composer
          to interrupt it.
        </Text>
        {form.replacesGoal ? (
          <Text style={styles.hint}>
            Changing the objective replaces the goal and can reset its usage accounting.
          </Text>
        ) : null}
        {changedElsewhere && !control.pending ? (
          <Text accessibilityRole="alert" style={styles.error}>
            The goal changed while this editor was open. Your draft is retained. Close and reopen to
            edit the current goal.
          </Text>
        ) : null}
        {form.error ? <Text style={styles.hint}>{form.error}</Text> : null}
        {control.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {control.error}
          </Text>
        ) : null}
        {control.readOnly ? (
          <Text style={styles.hint}>Restore this agent to change its goal.</Text>
        ) : null}
        {!control.connected ? (
          <Text style={styles.hint}>Reconnect to the host to change this goal.</Text>
        ) : null}
        <ActionFooter style={styles.actions}>
          <Button
            variant="ghost"
            onPress={control.refresh}
            disabled={!control.connected || control.refreshing}
          >
            Refresh
          </Button>
          <Button
            variant="default"
            onPress={save}
            disabled={disabled}
            loading={control.pending}
            testID="agent-goal-save"
          >
            {submitLabel}
          </Button>
        </ActionFooter>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[4] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  objective: { minHeight: 100, textAlignVertical: "top" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
