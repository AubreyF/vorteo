import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
import { StyleSheet } from "react-native-unistyles";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import type { ChecklistMutation } from "@getpaseo/protocol/task-checklist";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useVortonTouch } from "@/vorton-touch";
import { Button } from "@/components/ui/button";
import { TaskListRow } from "@/components/task-list-row";
import { AgentTaskList } from "@/composer/task-list";
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

export function ChecklistCard({ serverId, agentId, tasks = EMPTY_TASKS }: ChecklistCardProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const touch = useVortonTouch();
  const size = touch ? "md" : "sm";
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
  const error = mutation.error?.message ?? null;
  const open = useCallback(
    (task: AgentTaskItem | null) => {
      resetMutation();
      setEditor({ open: true, task });
    },
    [resetMutation],
  );
  const close = useCallback(() => {
    setEditor({ open: false });
  }, []);
  const moveUp = useCallback(
    (task: AgentTaskItem) => {
      const ids = tasks
        .filter((item) => item.source === "vorteo")
        .flatMap((item) => (item.id ? [item.id] : []));
      const index = ids.indexOf(task.id ?? "");
      if (index < 1) return;
      [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
      sendMutation({ operation: "reorder", ids });
    },
    [tasks, sendMutation],
  );
  const add = useCallback(() => open(null), [open]);
  const rows = useMemo(
    () =>
      tasks.map((task) => ({
        task,
        open: () => open(task),
        move: () => moveUp(task),
        toggle: () => {
          if (!task.id) return;
          sendMutation({
            operation: "update",
            id: task.id,
            expectedTask: task,
            status: task.completed ? "pending" : "completed",
          });
        },
      })),
    [tasks, open, moveUp, sendMutation],
  );
  if (!supported) return <AgentTaskList inline tasks={tasks} />;
  const firstManaged = tasks.find((task) => task.source === "vorteo");
  return (
    <View style={taskCardStyles.container} testID="agent-task-progress-card">
      <View style={[taskCardStyles.header, touch && taskCardStyles.touchHeader]}>
        <ChecklistProgressRing {...progress} />
        <Text style={[taskCardStyles.heading, styles.grow]}>
          {t("message.todo.tasksProgress", {
            completed: progress.completed,
            total: progress.total,
          })}
        </Text>
        <Button
          size={size}
          variant="ghost"
          disabled={!canMutate}
          onPress={add}
          testID="checklist-add"
        >
          Add task
        </Button>
      </View>
      {rows.map(({ task, open: openRow, move, toggle }, index) => (
        <View
          key={`${task.source ?? "provider"}:${task.id ?? index}`}
          style={[taskCardStyles.item, index > 0 && taskCardStyles.separator]}
        >
          <TaskListRow compact task={task} />
          {task.owner ? <Text style={styles.detail}>{task.owner}</Text> : null}
          {task.blockedBy?.length ? (
            <Text style={styles.detail}>
              Requires:{" "}
              {task.blockedBy
                .map(
                  (id) =>
                    tasks.find((item) => item.id === id && item.source === task.source)?.text ?? id,
                )
                .join(", ")}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              size={size}
              variant="ghost"
              onPress={openRow}
              accessibilityLabel={`Details for ${task.text}`}
            >
              Details
            </Button>
            {task.source === "vorteo" && task.id ? (
              <>
                <Button
                  size={size}
                  variant="ghost"
                  disabled={!canMutate}
                  onPress={toggle}
                  accessibilityLabel={`${task.completed ? "Reopen" : "Complete"} ${task.text}`}
                >
                  {task.completed ? "Reopen" : "Complete"}
                </Button>
                {task !== firstManaged ? (
                  <Button
                    size={size}
                    variant="ghost"
                    disabled={!canMutate}
                    onPress={move}
                    accessibilityLabel={`Move up ${task.text}`}
                  >
                    Move up
                  </Button>
                ) : null}
              </>
            ) : null}
          </View>
        </View>
      ))}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
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
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  grow: { flex: 1 },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
}));
