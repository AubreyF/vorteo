import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import type { Agent } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";

export interface QuestionGroups {
  open: AgentQuestion[];
  answered: AgentQuestion[];
}

export interface BlockedTask {
  id: string;
  text: string;
}

/** Open questions keep ask order; answered ones show the latest decision first. Withdrawn ones need no owner. */
export function groupQuestions(questions: readonly AgentQuestion[]): QuestionGroups {
  const open = questions.filter((question) => question.status === "open");
  const answered = questions
    .filter((question) => question.status === "answered")
    .sort((left, right) => (right.answeredAt ?? "").localeCompare(left.answeredAt ?? ""));
  return { open, answered };
}

/** Links resolve against this thread's Vorteo tasks; a deleted task simply drops out. */
export function blockedTasks(question: AgentQuestion, tasks: readonly TodoEntry[]): BlockedTask[] {
  const titles = new Map(
    tasks.flatMap((task) => (task.source === "vorteo" && task.id ? [[task.id, task.text]] : [])),
  );
  return (question.blocks ?? []).flatMap((id) => {
    const text = titles.get(id);
    return text === undefined ? [] : [{ id, text }];
  });
}

const ANSWER_SOURCES: Record<string, string> = {
  mobile: "the Vorteo app",
  browser: "a browser",
};

/** answeredBy is "<client type>:<client id>"; early daemons recorded only "owner". */
export function answeredFrom(answeredBy: string | undefined): string | null {
  const type = answeredBy?.split(":")[0];
  if (!type || type === "owner") return null;
  return ANSWER_SOURCES[type] ?? type;
}

export function openQuestionCount(questions: readonly AgentQuestion[] | undefined): number {
  return questions?.filter((question) => question.status === "open").length ?? 0;
}

export function workspaceOpenQuestionCount(
  agents: Iterable<Pick<Agent, "id" | "workspaceId" | "archivedAt" | "questions">>,
  workspaceId: string,
  pendingArchive: ReadonlySet<string>,
): number {
  let count = 0;
  for (const agent of agents) {
    if (agent.workspaceId !== workspaceId || agent.archivedAt || pendingArchive.has(agent.id))
      continue;
    count += openQuestionCount(agent.questions);
  }
  return count;
}
