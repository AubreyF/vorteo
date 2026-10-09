import { TaskCard } from "@/agent-stream/task-card";
import { ChecklistProgressFlower } from "@/task-checklist/progress-flower";
import { checklistProgress } from "@/task-checklist/progress";
import { useVortonTouch } from "@/vorton-touch";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { memo, useMemo, useState, useCallback } from "react";
import { View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { CountBadge } from "@/components/ui/count-badge";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { TaskListRow } from "@/components/task-list-row";
import type { TodoEntry } from "@/types/stream";

export const AgentTaskList = memo(function AgentTaskList({
  tasks,
  inline = false,
}: {
  inline?: boolean;
  tasks: TodoEntry[] | undefined;
}) {
  if (!tasks?.length) return null;
  return inline ? <TaskProgressCard tasks={tasks} /> : <TaskListCard tasks={tasks} />;
});

const TaskListCard = memo(function TaskListCard({ tasks }: { tasks: TodoEntry[] }) {
  const { t } = useTranslation();
  const completed = useMemo(
    () => tasks.filter((task) => task.completed || task.status === "completed").length,
    [tasks],
  );
  // Counts only. The active task used to ride along in the header, where it was the first thing
  // truncated on a phone; the panel shows it in full, in place, with the rest of the list.
  const label = t("message.todo.tasksProgress", { completed, total: tasks.length });
  const segments = useMemo(() => [{ bucket: null, text: label }], [label]);

  return (
    <ComposerTrackPill
      testID="agent-task-list-header"
      segments={segments}
      panelTitle={t("message.todo.title")}
    >
      {tasks.map((task, index) => (
        <ComposerTrackRow key={task.id ?? `${index}:${task.text}`}>
          <View style={styles.taskRow}>
            <TaskListRow task={task} />
          </View>
        </ComposerTrackRow>
      ))}
    </ComposerTrackPill>
  );
});

const styles = StyleSheet.create(() => ({
  // The task row draws its own icon and text; this only lets it span the shared row frame.
  // Basis stays `auto` so the text's width reaches the panel's measurement — see track.tsx.
  taskRow: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
  },
}));

/** Progress scrolls with the conversation, immediately before queued messages and goals. */
function TaskProgressCard({ tasks }: { tasks: TodoEntry[] }) {
  const { t } = useTranslation();
  const touch = useVortonTouch();
  const { completed, active, total } = checklistProgress(tasks);
  const [expanded, setExpanded] = useState(true);
  const countBadge = useMemo(
    () => (
      <CountBadge
        label={`${completed} / ${total}`}
        accessibilityLabel={t("message.todo.tasksProgress", { completed, total })}
      />
    ),
    [completed, total, t],
  );
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  return (
    <TaskCard testID="agent-task-progress-card">
      <View style={[taskCardStyles.header, touch && taskCardStyles.touchHeader]}>
        <ChecklistProgressFlower completed={completed} active={active} total={total} />
        <Button
          variant="ghost"
          size="sm"
          style={[taskCardStyles.accordionTrigger, touch && taskCardStyles.touchAccordionTrigger]}
          textStyle={taskCardStyles.heading}
          onPress={toggle}
          accessibilityLabel="Tasks"
          aria-expanded={expanded}
          accessibilityState={expandedState}
          trailing={countBadge}
          leftIcon={expanded ? ChevronDown : ChevronRight}
        >
          Tasks
        </Button>
      </View>
      {expanded ? (
        <View>
          {tasks.map((task, index) => (
            <View key={task.id ?? `${index}:${task.text}`} style={taskCardStyles.item}>
              <TaskListRow compact task={task} />
            </View>
          ))}
        </View>
      ) : null}
    </TaskCard>
  );
}
