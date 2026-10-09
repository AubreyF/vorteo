import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Check, Circle, ChevronDown, ChevronRight, Info, Plus } from "lucide-react-native";
import { useMutation } from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
import { StyleSheet } from "react-native-unistyles";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import type { ChecklistMutation } from "@getpaseo/protocol/task-checklist";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useVortonTouch } from "@/vorton-touch";
import { Button } from "@/components/ui/button";
import { CountBadge } from "@/components/ui/count-badge";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { ListDragHandle } from "@/components/list-drag-handle";
import { QueueDragScrollContext } from "@/message-queue/drag-scroll";
import { AgentTaskList } from "@/composer/task-list";
import { TaskCard } from "@/agent-stream/task-card";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { ChecklistProgressRing } from "./progress-ring";
import { checklistProgress } from "./progress";
import { ChecklistEditor } from "./editor";

interface ChecklistCardProps {
  serverId: string;
  agentId: string;
  tasks: AgentTaskItem[] | undefined;
}
type EditorState = { open: false } | { open: true; task: AgentTaskItem | null };
const EMPTY_TASKS: AgentTaskItem[] = [];
const taskKey = (task: AgentTaskItem, index: number) =>
  `${task.source ?? "provider"}:${task.id ?? index}`;

export function ChecklistCard({ serverId, agentId, tasks = EMPTY_TASKS }: ChecklistCardProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const touch = useVortonTouch();
  const [expanded, setExpanded] = useState(true);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const { supported, readOnly } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return {
        supported: session?.serverInfo?.features?.agentChecklistMutations === true,
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
  const { mutate: sendMutation, reset: resetMutation } = mutation;
  const canMutate = connected && !readOnly && !mutation.isPending;
  const progress = checklistProgress(tasks);
  const countBadge = useMemo(
    () => (
      <CountBadge
        label={`${progress.completed}/${progress.total}`}
        accessibilityLabel={t("message.todo.tasksProgress", {
          completed: progress.completed,
          total: progress.total,
        })}
        testID="checklist-count"
      />
    ),
    [progress.completed, progress.total, t],
  );
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  const error = mutation.error?.message ?? null;
  const open = useCallback(
    (task: AgentTaskItem | null) => {
      resetMutation();
      setEditor({ open: true, task });
    },
    [resetMutation],
  );
  const close = useCallback(() => setEditor({ open: false }), []);
  const add = useCallback(() => open(null), [open]);
  if (!supported) return <AgentTaskList inline tasks={tasks} />;
  return (
    <>
      <TaskCard testID="agent-task-progress-card">
        <View style={[taskCardStyles.header, touch && taskCardStyles.touchHeader]}>
          <ChecklistProgressRing {...progress} />
          <Button
            variant="ghost"
            size="sm"
            style={[taskCardStyles.accordionTrigger, touch && taskCardStyles.touchAccordionTrigger]}
            textStyle={taskCardStyles.heading}
            onPress={toggleExpanded}
            accessibilityLabel="Tasks"
            aria-expanded={expanded}
            accessibilityState={expandedState}
            testID="checklist-toggle"
            leftIcon={expanded ? ChevronDown : ChevronRight}
            trailing={countBadge}
          >
            Tasks
          </Button>
          <Button
            size="sm"
            variant="ghost"
            style={[taskCardStyles.iconAction, touch && taskCardStyles.touchAction]}
            disabled={!canMutate}
            onPress={add}
            testID="checklist-add"
            accessibilityLabel="Add task"
            leftIcon={Plus}
          />
        </View>
        {expanded && tasks.length > 0 ? (
          <ChecklistRows
            tasks={tasks}
            canMutate={canMutate}
            open={open}
            sendMutation={sendMutation}
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

function ChecklistRows({
  tasks,
  canMutate,
  open,
  sendMutation,
}: {
  tasks: AgentTaskItem[];
  canMutate: boolean;
  open: (task: AgentTaskItem) => void;
  sendMutation: (input: ChecklistMutation) => void;
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
        sendMutation({ operation: "reorder", ids });
      }
    },
    [release, canMutate, tasks, managed, sendMutation],
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
  const checkboxState = useMemo(
    () => ({ checked: completed, disabled: !managed || !canMutate }),
    [completed, managed, canMutate],
  );
  return (
    <View style={[styles.row, info.isActive && styles.active]} testID={`checklist-row-${task.id}`}>
      <Button
        variant="ghost"
        size="sm"
        style={iconStyle}
        accessibilityRole="checkbox"
        accessibilityState={checkboxState}
        accessibilityLabel={`${completed ? "Reopen" : "Complete"} ${task.text}`}
        disabled={!managed || !canMutate}
        onPress={toggle}
        leftIcon={completed ? Check : Circle}
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
        accessibilityLabel={`Details for ${task.text}`}
        onPress={details}
        leftIcon={Info}
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
