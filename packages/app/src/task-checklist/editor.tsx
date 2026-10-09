import {
  ActionFooter,
  ActionFooterLeading,
  ActionFooterTrailing,
} from "@/components/ui/action-footer";
import { useCallback, useMemo, useReducer } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import type { ChecklistMutation } from "@getpaseo/protocol/task-checklist";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openChecklistForm, updateChecklistForm, checklistFormMutation } from "./form-model";

interface ChecklistEditorProps {
  task: AgentTaskItem | null;
  tasks: AgentTaskItem[];
  canMutate: boolean;
  pending: boolean;
  error: string | null;
  mutate: (mutation: ChecklistMutation) => Promise<unknown>;
  onClose: () => void;
}

const statuses = ["pending", "in_progress", "completed"] as const;
const statusLabels = { pending: "Pending", in_progress: "In progress", completed: "Completed" };

export function ChecklistEditor({
  task,
  tasks,
  canMutate,
  pending,
  error,
  mutate,
  onClose,
}: ChecklistEditorProps) {
  const [form, dispatch] = useReducer(updateChecklistForm, task, openChecklistForm);
  const active = useRetainedPanelActive();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const readOnly = task !== null && task.source !== "vorteo";
  const disabled = !canMutate || readOnly;
  const header = useMemo(() => ({ title: task ? "Task details" : "New task" }), [task]);
  const save = useCallback(async () => {
    try {
      await mutate(checklistFormMutation(form));
      onClose();
    } catch {
      /* The shared mutation error remains visible and the draft is retained. */
    }
  }, [mutate, form, onClose]);
  const remove = useCallback(async () => {
    if (!task?.id) return;
    const confirmed = await confirmDialog({
      title: "Delete task?",
      message: task.text,
      confirmLabel: "Delete task",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await mutate({ operation: "delete", id: task.id, expectedTask: task });
      onClose();
    } catch {
      /* Keep the failed operation visible in this editor. */
    }
  }, [task, mutate, onClose]);
  const setters = useMemo(
    () => ({
      text: (value: string) => dispatch({ field: "text", value }),
      description: (value: string) => dispatch({ field: "description", value }),
      owner: (value: string) => dispatch({ field: "owner", value }),
      activeForm: (value: string) => dispatch({ field: "activeForm", value }),
    }),
    [],
  );
  const statusChoices = useMemo(
    () =>
      statuses.map((status) => ({
        status,
        onPress: () => dispatch({ field: "status", value: status }),
      })),
    [],
  );
  const dependencySource = task ? (task.source ?? "provider") : "vorteo";
  const dependencies = useMemo(
    () =>
      tasks
        .filter((item) => (item.source ?? "provider") === dependencySource && item.id !== task?.id)
        .map((item) => ({
          item,
          onPress: () => dispatch({ field: "dependency", value: item.id ?? "" }),
        })),
    [tasks, task, dependencySource],
  );
  return (
    <AdaptiveModalSheet visible={active} onClose={onClose} header={header} desktopMaxWidth={620}>
      <View style={styles.body} testID="checklist-editor">
        <Field label="Task">
          <FormTextInput
            size={size}
            initialValue={form.text}
            onChangeText={setters.text}
            editable={!disabled}
            maxLength={1000}
            accessibilityLabel="Task title"
            testID="checklist-title"
          />
        </Field>
        <Field label="Completion criteria">
          <FormTextInput
            size={size}
            initialValue={form.description}
            onChangeText={setters.description}
            editable={!disabled}
            multiline
            maxLength={20000}
            accessibilityLabel="Completion criteria"
            testID="checklist-description"
          />
        </Field>
        <Field label="Owner">
          <FormTextInput
            size={size}
            initialValue={form.owner}
            onChangeText={setters.owner}
            editable={!disabled}
            maxLength={200}
            accessibilityLabel="Task owner"
          />
        </Field>
        <Field label="Progress label">
          <FormTextInput
            size={size}
            initialValue={form.activeForm}
            onChangeText={setters.activeForm}
            editable={!disabled}
            maxLength={1000}
            accessibilityLabel="Progress label"
          />
        </Field>
        {task ? (
          <Field label="Status">
            <View style={styles.actions}>
              {statusChoices.map(({ status, onPress }) => (
                <Button
                  key={status}
                  size={size}
                  variant={form.status === status ? "secondary" : "ghost"}
                  disabled={disabled}
                  onPress={onPress}
                >
                  {statusLabels[status]}
                </Button>
              ))}
            </View>
          </Field>
        ) : null}
        <Field label="Prerequisites">
          <View style={styles.dependencies}>
            {dependencies.map(({ item, onPress }) => (
              <Button
                key={item.id}
                size={size}
                variant={form.blockedBy.includes(item.id ?? "") ? "secondary" : "ghost"}
                disabled={disabled || !item.id}
                onPress={onPress}
              >
                {form.blockedBy.includes(item.id ?? "") ? "✓ " : ""}
                {item.text}
              </Button>
            ))}
          </View>
        </Field>
        {readOnly ? <Text style={styles.hint}>Managed by native agent task tools</Text> : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        <ActionFooter style={styles.actions} testID="checklist-editor-actions">
          {task && !readOnly ? (
            <ActionFooterLeading>
              <Button size={size} variant="destructive" disabled={disabled} onPress={remove}>
                Delete task
              </Button>
            </ActionFooterLeading>
          ) : null}
          <ActionFooterTrailing>
            <Button size={size} variant="ghost" onPress={onClose}>
              Close
            </Button>
            {!readOnly ? (
              <Button
                size={size}
                variant="default"
                disabled={disabled || !form.text.trim()}
                loading={pending}
                onPress={save}
                testID="checklist-save"
              >
                Save task
              </Button>
            ) : null}
          </ActionFooterTrailing>
        </ActionFooter>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4], padding: theme.spacing[4] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  dependencies: { gap: theme.spacing[1] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
