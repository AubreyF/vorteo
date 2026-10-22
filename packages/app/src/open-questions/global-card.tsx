import { ArrowUpRight } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { GlobalCard } from "@/components/sidebar/global-card-shell";
import { Button } from "@/components/ui/button";
import { selectPendingArchiveAgentIds, usePendingArchiveState } from "@/hooks/use-archive-agent";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { OpenQuestion, useQuestionAnswer } from "./card";
import {
  collectThreadQuestions,
  globalOpenQuestionCount,
  type QuestionHostInput,
  type ThreadQuestions,
} from "./global-model";

const HEADING_ICON = <TaskCardIcon kind="question" />;

/** Every thread's waiting questions on every connected host, answerable without opening it. */
function useThreadQuestions(): ThreadQuestions[] {
  const sessions = useSessionStore((state) => state.sessions);
  const hosts = useHosts();
  const pending = usePendingArchiveState();
  return useMemo(() => {
    const labels = new Map(hosts.map((host) => [host.serverId, host.label]));
    const inputs: QuestionHostInput[] = [];
    for (const [serverId, session] of Object.entries(sessions)) {
      if (!session?.serverInfo?.features?.agentQuestions) continue;
      inputs.push({
        serverId,
        hostLabel: labels.get(serverId) ?? serverId,
        agents: session.agents.values(),
        workspaces: session.workspaces,
        pendingArchive: selectPendingArchiveAgentIds(pending, serverId),
      });
    }
    return collectThreadQuestions(inputs);
  }, [hosts, pending, sessions]);
}

export function GlobalOpenQuestionsCard({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const threads = useThreadQuestions();
  const count = globalOpenQuestionCount(threads);
  if (count === 0) return null;
  return (
    <GlobalCard
      kind="globalQuestions"
      title="Open questions"
      icon={HEADING_ICON}
      count={count}
      countLabel={`${count} open ${count === 1 ? "question" : "questions"} across all threads`}
      testID="global-open-questions-card"
    >
      {threads.map((thread, index) => (
        <ThreadQuestionGroup
          key={thread.key}
          thread={thread}
          first={index === 0}
          onBeforeNavigate={onBeforeNavigate}
        />
      ))}
    </GlobalCard>
  );
}

function ThreadQuestionGroup({
  thread,
  first,
  onBeforeNavigate,
}: {
  thread: ThreadQuestions;
  first: boolean;
  onBeforeNavigate?: () => void;
}) {
  const { canAnswer, pendingId, failedId, error, answer } = useQuestionAnswer(
    thread.serverId,
    thread.agentId,
    false,
  );
  const openThread = useCallback(() => {
    onBeforeNavigate?.();
    navigateToAgent({ serverId: thread.serverId, agentId: thread.agentId });
  }, [onBeforeNavigate, thread.agentId, thread.serverId]);
  const origin = [thread.projectLabel, thread.hostLabel].filter(Boolean).join(" · ");
  const context = useMemo(
    () => (
      <View style={styles.origin}>
        <View style={styles.originText}>
          <Text style={styles.thread} numberOfLines={1}>
            {thread.threadTitle}
          </Text>
          {origin ? (
            <Text style={styles.project} numberOfLines={1}>
              {origin}
            </Text>
          ) : null}
        </View>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={ArrowUpRight}
          onPress={openThread}
          accessibilityLabel={`Open thread ${thread.threadTitle}`}
          testID={`global-open-question-thread-${thread.agentId}`}
        >
          Open
        </Button>
      </View>
    ),
    [openThread, origin, thread.agentId, thread.threadTitle],
  );
  return (
    <View
      style={!first && taskCardStyles.separator}
      testID={`global-open-questions-thread-${thread.agentId}`}
    >
      {thread.questions.map((question, index) => (
        <OpenQuestion
          key={question.id}
          question={question}
          tasks={thread.tasks}
          first={index === 0}
          canAnswer={canAnswer}
          pending={pendingId === question.id}
          error={failedId === question.id ? error : null}
          onAnswer={answer}
          onShowTasks={openThread}
          context={index === 0 ? context : undefined}
          testIDPrefix="global-open-question"
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  origin: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  originText: { flex: 1, minWidth: 0 },
  thread: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  project: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
}));
