import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";

/** One host's threads, as the global card reads them from the session store. */
export interface QuestionHostInput {
  serverId: string;
  hostLabel: string;
  agents: Iterable<
    Pick<Agent, "id" | "title" | "workspaceId" | "archivedAt" | "questions" | "tasks">
  >;
  workspaces: ReadonlyMap<
    string,
    Pick<WorkspaceDescriptor, "name" | "title" | "projectDisplayName" | "projectCustomName">
  >;
  pendingArchive: ReadonlySet<string>;
}

/** A thread with questions waiting for the owner, labeled for display outside that thread. */
export interface ThreadQuestions {
  key: string;
  serverId: string;
  agentId: string;
  threadTitle: string;
  projectLabel: string | null;
  hostLabel: string | null;
  questions: AgentQuestion[];
  tasks: readonly TodoEntry[];
}

const EMPTY_TASKS: readonly TodoEntry[] = [];

/**
 * Every unanswered question across hosts and projects, grouped by the thread that asked.
 * Threads whose questions block the most tasks come first, then the longest-waiting. Archived
 * threads and threads being archived are left out, matching the sidebar's question badges.
 * Host labels appear only when more than one host has questions.
 */
export function collectThreadQuestions(hosts: readonly QuestionHostInput[]): ThreadQuestions[] {
  const threads: ThreadQuestions[] = [];
  for (const host of hosts) {
    for (const agent of host.agents) {
      if (agent.archivedAt || host.pendingArchive.has(agent.id)) continue;
      const questions = (agent.questions ?? []).filter((question) => question.status === "open");
      if (questions.length === 0) continue;
      const workspace = agent.workspaceId ? host.workspaces.get(agent.workspaceId) : undefined;
      threads.push({
        key: `${host.serverId}:${agent.id}`,
        serverId: host.serverId,
        agentId: agent.id,
        threadTitle: agent.title?.trim() || "Untitled thread",
        projectLabel: workspace ? projectLabel(workspace) : null,
        hostLabel: host.hostLabel,
        questions,
        tasks: agent.tasks ?? EMPTY_TASKS,
      });
    }
  }
  const hostsWithQuestions = new Set(threads.map((thread) => thread.serverId));
  if (hostsWithQuestions.size <= 1) {
    for (const thread of threads) thread.hostLabel = null;
  }
  return threads.sort(compareThreads);
}

export function globalOpenQuestionCount(threads: readonly ThreadQuestions[]): number {
  return threads.reduce((total, thread) => total + thread.questions.length, 0);
}

function projectLabel(
  workspace: Pick<
    WorkspaceDescriptor,
    "name" | "title" | "projectDisplayName" | "projectCustomName"
  >,
): string {
  const project = workspace.projectCustomName?.trim() || workspace.projectDisplayName;
  const name = workspace.title?.trim() || workspace.name;
  return name && name !== project ? `${project} · ${name}` : project;
}

function blockedCount(thread: ThreadQuestions): number {
  return thread.questions.reduce((total, question) => total + (question.blocks?.length ?? 0), 0);
}

function oldestAsk(thread: ThreadQuestions): string {
  return thread.questions.reduce(
    (oldest, question) => (question.askedAt < oldest ? question.askedAt : oldest),
    thread.questions[0]?.askedAt ?? "",
  );
}

function compareThreads(left: ThreadQuestions, right: ThreadQuestions): number {
  const blocked = blockedCount(right) - blockedCount(left);
  if (blocked !== 0) return blocked;
  return oldestAsk(left).localeCompare(oldestAsk(right));
}
