import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Check, Circle, CircleAlert, Pencil, Plus } from "lucide-react-native";
import { useMutation } from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
import { StyleSheet } from "react-native-unistyles";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import type { ChecklistMutation } from "@getpaseo/protocol/task-checklist";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useVortonTouch } from "@/vorton-touch";
import { StatusRing } from "@/components/status-ring";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { CountBadge } from "@/components/ui/count-badge";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { ListDragHandle } from "@/components/list-drag-handle";
import { QueueDragScrollContext } from "@/message-queue/drag-scroll";
import { AgentTaskList } from "@/composer/task-list";
import {
  TaskCard,
  TaskCardHeader,
  TaskCardAction,
  TaskCardActions,
} from "@/agent-stream/task-card";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { ChecklistProgressFlower } from "./progress-flower";
import { checklistProgress } from "./progress";
import { canClearTask, clearCompletedTasks } from "./clear-completed";
import { ChecklistEditor } from "./editor";

interface ChecklistCardProps {
  serverId: string;
  agentId: string;
  tasks: AgentTaskItem[] | undefined;
}
type EditorState = { open: false } | { open: true; task: AgentTaskItem | null };
const EMPTY_TASKS: AgentTaskItem[] = [];
const TASK_RUNNING_ICON = <StatusRing variant="task" />;
const taskKey = (task: AgentTaskItem, index: number) =>
  `${task.source ?? "provider"}:${task.id ?? index}`;

export function ChecklistCard({ serverId, agentId, tasks = EMPTY_TASKS }: ChecklistCardProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const [expanded, setExpanded] = useState(true);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const { supported, supportsBlocked, readOnly } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return {
        supported: session?.serverInfo?.features?.agentChecklistMutations === true,
        supportsBlocked: session?.serverInfo?.features?.checklistBlockedStatus === true,
        readOnly: !agent || agent.archivedAt != null,
      };
    }),
  );
  const mutation = useMutation({
    mutationFn: async (input: ChecklistMutation) => {
      if (!client || !connected || readOnly)
        throw new Error("Reconnect to an active thread before editing its checklist.");
      return client.mutateAgentChecklist(agentId, input);
    },
    retry: false,
  });
  const clearMutation = useMutation({
    mutationFn: async (snapshot: AgentTaskItem[]) => {
      if (!client || !connected || readOnly)
        throw new Error("Reconnect to an active thread before editing its checklist.");
      await clearCompletedTasks(snapshot, (input) => client.mutateAgentChecklist(agentId, input));
    },
    retry: false,
  });
  const { mutate: clearTasks, reset: resetClear } = clearMutation;
  const { mutate: sendMutation, reset: resetMutation } = mutation;
  const clearCompleted = useCallback(() => {
    resetMutation();
    clearTasks(tasks);
  }, [clearTasks, resetMutation, tasks]);
  const canMutate = connected && !readOnly && !mutation.isPending && !clearMutation.isPending;
  const progress = checklistProgress(tasks);
  const headingIcon = useMemo(
    () => (
      <ChecklistProgressFlower
        completed={progress.completed}
        active={progress.active}
        total={progress.total}
        testID="checklist-progress"
      />
    ),
    [progress.completed, progress.active, progress.total],
  );
  const countBadge = useMemo(
    () => (
      <CountBadge
        label={`${progress.completed} / ${progress.total}`}
        accessibilityLabel={t("message.todo.tasksProgress", {
          completed: progress.completed,
          total: progress.total,
        })}
        testID="checklist-count"
      />
    ),
    [progress.completed, progress.total, t],
  );
  const error = clearMutation.error?.message ?? mutation.error?.message ?? null;
  const open = useCallback(
    (task: AgentTaskItem | null) => {
      resetMutation();
      resetClear();
      setEditor({ open: true, task });
    },
    [resetMutation, resetClear],
  );
  const close = useCallback(() => setEditor({ open: false }), []);
  const add = useCallback(() => open(null), [open]);
  if (tasks.length === 0) return null;
  if (!supported) return <AgentTaskList inline tasks={tasks} />;
  return (
    <>
      <TaskCard testID="agent-task-progress-card" bodyVisible={expanded || !!error}>
        <TaskCardHeader>
          <CardDisclosure
            icon={headingIcon}
            title="Tasks"
            expanded={expanded}
            onPress={toggleExpanded}
            count={countBadge}
            testID="checklist-toggle"
          />
          <TaskCardActions>
            <TaskCardAction
              iconOnly
              disabled={!canMutate}
              onPress={add}
              testID="checklist-add"
              accessibilityLabel="Add task"
              leftIcon={Plus}
            />
            <ClearCompletedButton
              available={tasks.some(canClearTask)}
              pending={clearMutation.isPending}
              disabled={!canMutate}
              onPress={clearCompleted}
            />
          </TaskCardActions>
        </TaskCardHeader>

        {expanded && tasks.length > 0 ? (
          <ChecklistRows
            tasks={tasks}
            canMutate={canMutate}
            open={open}
            sendMutation={sendMutation}
            reorder={mutation.mutateAsync}
          />
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </TaskCard>
      {editor.open ? (
        <ChecklistEditor
          supportsBlocked={supportsBlocked}
          task={editor.task}
          tasks={tasks}
          canMutate={canMutate}
          pending={mutation.isPending}
          error={error}
          mutate={mutation.mutateAsync}
          onClose={close}
        />
      ) : null}
    </>
  );
}

function ClearCompletedButton({
  available,
  pending,
  disabled,
  onPress,
}: {
  available: boolean;
  pending: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  if (!available && !pending) return null;
  return (
    <TaskCardAction
      onPress={onPress}
      disabled={disabled}
      loading={pending}
      testID="checklist-clear-completed"
      accessibilityLabel="Clear completed tasks"
    >
      {pending ? "Clearing…" : "Clear completed"}
    </TaskCardAction>
  );
}

function ChecklistRows({
  tasks,
  canMutate,
  open,
  sendMutation,
  reorder,
}: {
  tasks: AgentTaskItem[];
  canMutate: boolean;
  open: (task: AgentTaskItem) => void;
  sendMutation: (input: ChecklistMutation) => void;
  reorder: (input: ChecklistMutation) => Promise<unknown>;
}) {
  const managed = useMemo(
    () => tasks.filter((task) => task.source === "vorteo" && task.id),
    [tasks],
  );
  const onDragActive = useContext(QueueDragScrollContext);
  const startedTasks = useRef(tasks);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const release = useCallback(() => onDragActive(false), [onDragActive]);
  useEffect(() => release, [release]);
  const begin = useCallback(() => {
    startedTasks.current = tasks;
    setReorderError(null);
    onDragActive(true);
  }, [tasks, onDragActive]);
  const drop = useCallback(
    (rows: AgentTaskItem[]) => {
      release();
      if (!canMutate) return;
      // Do not overwrite a newer order or membership received during the gesture.
      const before = startedTasks.current.map(taskKey).join("\n");
      if (tasks.map(taskKey).join("\n") !== before) {
        setReorderError("Tasks changed while dragging. Try again.");
        return;
      }
      const ids = rows
        .filter((task) => task.source === "vorteo")
        .flatMap((task) => (task.id ? [task.id] : []));
      if (ids.join("\n") !== managed.map((task) => task.id).join("\n")) {
        return reorder({ operation: "reorder", ids });
      }
    },
    [release, canMutate, tasks, managed, reorder],
  );
  const renderRow = useCallback(
    (info: DraggableRenderItemInfo<AgentTaskItem>) => (
      <ChecklistRow
        info={info}
        canMutate={canMutate}
        canReorder={canMutate && managed.length > 1}
        open={open}
        mutate={sendMutation}
      />
    ),
    [canMutate, managed.length, open, sendMutation],
  );

  return (
    <>
      <DraggableList
        data={tasks}
        keyExtractor={taskKey}
        renderItem={renderRow}
        onDragBegin={begin}
        onDragEnd={drop}
        onDragRelease={release}
        scrollEnabled={false}
        useDragHandle
        touchActivation="movement"
      />
      {reorderError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {reorderError}
        </Text>
      ) : null}
    </>
  );
}

function ChecklistRow({
  info,
  canMutate,
  canReorder,
  open,
  mutate,
}: {
  info: DraggableRenderItemInfo<AgentTaskItem>;
  canMutate: boolean;
  canReorder: boolean;
  open: (task: AgentTaskItem) => void;
  mutate: (input: ChecklistMutation) => void;
}) {
  const task = info.item;
  const touch = useVortonTouch();
  const completed = task.completed || task.status === "completed";
  const blocked = !completed && task.status === "blocked";
  const running = !completed && task.status === "in_progress";
  const title = running && task.activeForm ? task.activeForm : task.text;
  const managed = task.source === "vorteo" && Boolean(task.id);
  const toggle = useCallback(() => {
    if (!task.id) return;
    mutate({
      operation: "update",
      id: task.id,
      expectedTask: task,
      status: completed ? "pending" : "completed",
    });
  }, [task, completed, mutate]);
  const details = useCallback(() => open(task), [open, task]);
  const iconStyle = [taskCardStyles.iconAction, touch && taskCardStyles.touchAction];
  const inactiveIcon = blocked ? CircleAlert : Circle;
  const incompleteIcon = running ? TASK_RUNNING_ICON : inactiveIcon;
  const checkboxState = useMemo(
    () => ({ checked: completed, disabled: !managed || !canMutate }),
    [completed, managed, canMutate],
  );
  return (
    <View style={[styles.row, info.isActive && styles.active]} testID={`checklist-row-${task.id}`}>
      {managed ? (
        <ListDragHandle
          info={info}
          disabled={!canReorder}
          label={`Reorder ${task.text}`}
          testID={`checklist-drag-${task.id}`}
        />
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        style={iconStyle}
        accessibilityRole="checkbox"
        accessibilityState={checkboxState}
        accessibilityLabel={`${completed ? "Reopen" : "Complete"} ${task.text}`}
        disabled={!managed || !canMutate}
        onPress={toggle}
        leftIcon={completed ? Check : incompleteIcon}
      />
      <Text
        numberOfLines={1}
        style={[
          taskCardStyles.rowText,
          styles.title,
          running && styles.running,
          completed && styles.completed,
        ]}
      >
        {title}
      </Text>
      {blocked ? <StatusBadge label="Blocked" variant="warning" size="xs" /> : null}
      <Button
        variant="ghost"
        size="sm"
        style={iconStyle}
        accessibilityLabel={`Details for ${task.text}`}
        onPress={details}
        leftIcon={Pencil}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", minHeight: 40, gap: theme.spacing[1] },
  title: { flex: 1, minWidth: 0 },
  running: { color: theme.colors.foreground },
  completed: { color: theme.colors.foregroundExtraMuted, textDecorationLine: "line-through" },
  active: { backgroundColor: theme.colors.surface2 },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
}));
