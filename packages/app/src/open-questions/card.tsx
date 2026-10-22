import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ListTodo } from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { TaskCard, TaskCardHeader } from "@/agent-stream/task-card";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { useCardDisclosure } from "@/agent-stream/use-card-disclosure";
import { Button } from "@/components/ui/button";
import { CountBadge } from "@/components/ui/count-badge";
import { FormTextInput } from "@/components/ui/form-field";
import { useReportActionError } from "@/hooks/use-action-error";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";
import { formatMessageTimestamp, formatTimeAgo } from "@/utils/time";
import { useVortonTouch } from "@/vorton-touch";
import { answeredFrom, blockedTasks, groupQuestions } from "./model";

const EMPTY_QUESTIONS: AgentQuestion[] = [];
const EMPTY_TASKS: TodoEntry[] = [];
const HEADING_ICON = <TaskCardIcon kind="question" />;

export interface AnswerInput {
  questionId: string;
  answer: string;
}

export function OpenQuestionsCard({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { supported, questions, tasks, readOnly } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agentDetails.get(agentId) ?? session?.agents.get(agentId);
      return {
        supported: session?.serverInfo?.features?.agentQuestions === true,
        questions: agent?.questions ?? EMPTY_QUESTIONS,
        tasks: agent?.tasks ?? EMPTY_TASKS,
        readOnly: !agent || agent.archivedAt != null,
      };
    }),
  );
  const groups = useMemo(() => groupQuestions(questions), [questions]);
  if (!supported || groups.open.length + groups.answered.length === 0) return null;
  return (
    <OpenQuestionsContent
      serverId={serverId}
      agentId={agentId}
      open={groups.open}
      answered={groups.answered}
      tasks={tasks}
      readOnly={readOnly}
    />
  );
}

function OpenQuestionsContent({
  serverId,
  agentId,
  open,
  answered,
  tasks,
  readOnly,
}: {
  serverId: string;
  agentId: string;
  open: AgentQuestion[];
  answered: AgentQuestion[];
  tasks: TodoEntry[];
  readOnly: boolean;
}) {
  const [expanded, setExpanded] = useCardDisclosure("questions");
  const toggle = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  const [showAnswered, setShowAnswered] = useState(false);
  const toggleAnswered = useCallback(() => setShowAnswered((value) => !value), []);
  const { canAnswer, pendingId, answer } = useQuestionAnswer(serverId, agentId, readOnly);
  const badge = useMemo(
    () => (
      <CountBadge
        count={open.length}
        label={String(open.length)}
        accessibilityLabel={`${open.length} open questions`}
        testID="open-questions-count"
      />
    ),
    [open.length],
  );
  return (
    <TaskCard flushBody testID="open-questions-card" bodyVisible={expanded}>
      <TaskCardHeader>
        <CardDisclosure
          icon={HEADING_ICON}
          title="Open questions"
          expanded={expanded}
          onPress={toggle}
          count={badge}
          testID="open-questions-toggle"
        />
      </TaskCardHeader>
      {expanded ? (
        <View>
          {open.map((question, index) => (
            <OpenQuestion
              key={question.id}
              question={question}
              tasks={tasks}
              first={index === 0}
              canAnswer={canAnswer}
              pending={pendingId === question.id}
              onAnswer={answer}
            />
          ))}
          {open.length === 0 ? (
            <Text style={[styles.muted, styles.empty, taskCardStyles.proseInset]}>
              No questions are waiting for you.
            </Text>
          ) : null}
          {answered.length > 0 ? (
            <AnsweredQuestions
              answered={answered}
              visible={showAnswered}
              onToggle={toggleAnswered}
            />
          ) : null}
        </View>
      ) : null}
    </TaskCard>
  );
}

/**
 * Answers go to the thread that asked; one answer per thread is in flight at a time. A failed
 * answer is reported as a toast and the typed draft stays in place for a retry.
 */
export function useQuestionAnswer(serverId: string, agentId: string, readOnly: boolean) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const reportError = useReportActionError();
  const mutation = useMutation({
    mutationFn: async ({ questionId, answer }: AnswerInput) => {
      if (!client || !connected || readOnly)
        throw new Error("Reconnect to an active thread before answering.");
      return client.answerAgentQuestion(agentId, questionId, answer);
    },
    onError: reportError,
    retry: false,
  });
  return {
    canAnswer: connected && !readOnly && !mutation.isPending,
    pendingId: mutation.isPending ? mutation.variables?.questionId : undefined,
    answer: mutation.mutate,
  };
}

export function OpenQuestion({
  question,
  tasks,
  first,
  canAnswer,
  pending,
  onAnswer,
  onShowTasks,
  context,
  testIDPrefix = "open-question",
}: {
  question: AgentQuestion;
  tasks: readonly TodoEntry[];
  first: boolean;
  canAnswer: boolean;
  pending: boolean;
  onAnswer: (input: AnswerInput) => void;
  /** Where a blocked task leads; by default, this thread's Tasks card. */
  onShowTasks?: () => void;
  /** Shown above the question when it is listed outside its own thread. */
  context?: ReactNode;
  /** Keeps test IDs unique when the same question also shows in its thread's card. */
  testIDPrefix?: string;
}) {
  const touch = useVortonTouch();
  const size = touch ? "md" : "sm";
  const [draft, setDraft] = useState("");
  const blocks = useMemo(() => blockedTasks(question, tasks), [question, tasks]);
  const useRecommended = useCallback(
    () => onAnswer({ questionId: question.id, answer: question.recommendedDefault }),
    [onAnswer, question.id, question.recommendedDefault],
  );
  const answer = draft.trim();
  const send = useCallback(() => {
    if (answer) onAnswer({ questionId: question.id, answer });
  }, [answer, onAnswer, question.id]);
  const askedAt = new Date(question.askedAt);
  const defaultAt = question.defaultAppliesAfter
    ? formatMessageTimestamp(new Date(question.defaultAppliesAfter))
    : null;
  return (
    <View
      style={[styles.question, taskCardStyles.proseInset, !first && taskCardStyles.separator]}
      testID={`${testIDPrefix}-${question.id}`}
    >
      {context}
      <Text style={styles.title}>{question.question}</Text>
      <Text style={styles.muted}>{question.why}</Text>
      {blocks.length > 0 ? (
        <BlockedTasks blocks={blocks} onShowTasks={onShowTasks} testIDPrefix={testIDPrefix} />
      ) : null}
      <Text style={styles.meta}>
        {`Asked ${formatTimeAgo(askedAt)}`}
        {defaultAt ? ` · Recommended default applies after ${defaultAt}` : ""}
      </Text>
      <View style={styles.answerRow}>
        <View style={styles.recommendation}>
          <Text style={styles.recommendationText}>
            <Text style={styles.label}>Recommended: </Text>
            {question.recommendedDefault}
          </Text>
        </View>
        <Button
          variant="default"
          size={size}
          disabled={!canAnswer}
          loading={pending}
          onPress={useRecommended}
          accessibilityLabel={`Use recommended answer: ${question.recommendedDefault}`}
          testID={`${testIDPrefix}-use-recommended-${question.id}`}
        >
          Yes
        </Button>
      </View>
      <View style={styles.answerRow}>
        <View style={styles.answerInput}>
          <FormTextInput
            size={size}
            initialValue=""
            onChangeText={setDraft}
            onSubmitEditing={send}
            editable={canAnswer}
            maxLength={4000}
            placeholder="Or type your answer"
            accessibilityLabel={`Answer: ${question.question}`}
            testID={`${testIDPrefix}-answer-${question.id}`}
          />
        </View>
        <Button
          variant="secondary"
          size={size}
          disabled={!canAnswer || !answer}
          onPress={send}
          testID={`${testIDPrefix}-send-${question.id}`}
        >
          Answer
        </Button>
      </View>
    </View>
  );
}

function BlockedTasks({
  blocks,
  onShowTasks,
  testIDPrefix,
}: {
  blocks: { id: string; text: string }[];
  onShowTasks?: () => void;
  testIDPrefix: string;
}) {
  const [, setTasksExpanded] = useCardDisclosure("tasks");
  const expandTasks = useCallback(() => setTasksExpanded(true), [setTasksExpanded]);
  const showTasks = onShowTasks ?? expandTasks;
  return (
    <View style={styles.blocks}>
      <Text style={styles.meta}>Blocks</Text>
      {blocks.map((task) => (
        <Button
          key={task.id}
          variant="outline"
          size="xs"
          leftIcon={ListTodo}
          onPress={showTasks}
          accessibilityHint={onShowTasks ? "Opens the thread" : "Opens the Tasks card"}
          testID={`${testIDPrefix}-task-${task.id}`}
        >
          {task.text}
        </Button>
      ))}
    </View>
  );
}

function AnsweredQuestions({
  answered,
  visible,
  onToggle,
}: {
  answered: AgentQuestion[];
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={styles.answered}>
      <Button
        variant="ghost"
        size="xs"
        leftIcon={visible ? ChevronDown : ChevronRight}
        onPress={onToggle}
        style={styles.answeredToggle}
        aria-expanded={visible}
        testID="open-questions-answered-toggle"
      >
        {`Answered (${answered.length})`}
      </Button>
      {visible
        ? answered.map((question) => (
            <View
              key={question.id}
              style={[styles.question, taskCardStyles.proseInset]}
              testID={`answered-question-${question.id}`}
            >
              <Text style={styles.answeredTitle}>{question.question}</Text>
              <Text style={styles.muted}>
                <Text style={styles.label}>Answer: </Text>
                {question.answer}
              </Text>
              {question.answeredAt ? (
                <Text style={styles.meta}>{answeredMeta(question)}</Text>
              ) : null}
            </View>
          ))
        : null}
    </View>
  );
}

function answeredMeta(question: AgentQuestion): string {
  const when = `Answered ${formatTimeAgo(new Date(question.answeredAt ?? question.askedAt))}`;
  const source = answeredFrom(question.answeredBy);
  return source ? `${when} from ${source}` : when;
}

const styles = StyleSheet.create((theme) => ({
  question: { gap: theme.spacing[1.5], paddingVertical: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  answeredTitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  meta: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  label: { color: theme.colors.foregroundMuted, fontWeight: theme.fontWeight.medium },
  empty: { paddingVertical: theme.spacing[2] },
  blocks: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  recommendation: {
    flex: 1,
    minWidth: 0,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  recommendationText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  answerRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  answerInput: { flex: 1, minWidth: 0 },
  answered: { paddingTop: theme.spacing[1], alignItems: "flex-start" },
  answeredToggle: { marginLeft: theme.spacing[1] },
}));
