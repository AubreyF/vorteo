import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import { expect, test } from "vitest";
import {
  collectThreadQuestions,
  globalOpenQuestionCount,
  type QuestionHostInput,
} from "./global-model";

function question(id: string, overrides: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    id,
    question: `Question ${id}`,
    why: "It blocks the release.",
    recommendedDefault: "Ship tomorrow",
    askedAt: "2026-10-18T10:00:00.000Z",
    askedBy: "agent",
    status: "open",
    ...overrides,
  };
}

const workspaces = new Map([
  ["w1", { name: "main", title: null, projectDisplayName: "Vorteo", projectCustomName: null }],
  [
    "w2",
    {
      name: "Solon",
      title: "Brand",
      projectDisplayName: "Solon",
      projectCustomName: "Solon Energy",
    },
  ],
]);

function host(
  serverId: string,
  agents: QuestionHostInput["agents"],
  pendingArchive: ReadonlySet<string> = new Set(),
): QuestionHostInput {
  return { serverId, hostLabel: serverId.toUpperCase(), agents, workspaces, pendingArchive };
}

test("lists only open questions from active threads, labeled by project", () => {
  const threads = collectThreadQuestions([
    host(
      "host",
      [
        {
          id: "a",
          title: "Fix cards",
          workspaceId: "w1",
          archivedAt: null,
          questions: [question("q1"), question("q2", { status: "answered", answer: "No" })],
        },
        {
          id: "b",
          title: "Old",
          workspaceId: "w1",
          archivedAt: new Date(),
          questions: [question("q3")],
        },
        {
          id: "c",
          title: "Leaving",
          workspaceId: "w1",
          archivedAt: null,
          questions: [question("q4")],
        },
        { id: "d", title: "Quiet", workspaceId: "w1", archivedAt: null, questions: [] },
        { id: "e", title: "  ", workspaceId: "w2", archivedAt: null, questions: [question("q5")] },
      ],
      new Set(["c"]),
    ),
  ]);
  expect(
    threads.map((thread) => [thread.agentId, thread.questions.map((item) => item.id)]),
  ).toEqual([
    ["a", ["q1"]],
    ["e", ["q5"]],
  ]);
  expect(threads[0]).toMatchObject({ threadTitle: "Fix cards", projectLabel: "Vorteo · main" });
  expect(threads[1]).toMatchObject({
    threadTitle: "Untitled thread",
    projectLabel: "Solon Energy · Brand",
  });
  expect(threads.every((thread) => thread.hostLabel === null)).toBe(true);
  expect(globalOpenQuestionCount(threads)).toBe(2);
});

test("puts threads blocking the most tasks first, then the longest waiting", () => {
  const threads = collectThreadQuestions([
    host("host", [
      {
        id: "recent",
        title: "Recent",
        workspaceId: "w1",
        archivedAt: null,
        questions: [question("r", { askedAt: "2026-10-19T10:00:00.000Z" })],
      },
      {
        id: "blocking",
        title: "Blocking",
        workspaceId: "w1",
        archivedAt: null,
        questions: [question("b", { blocks: ["t1", "t2"], askedAt: "2026-10-20T10:00:00.000Z" })],
      },
      {
        id: "waiting",
        title: "Waiting",
        workspaceId: "w1",
        archivedAt: null,
        questions: [question("w", { askedAt: "2026-10-17T10:00:00.000Z" })],
      },
    ]),
  ]);
  expect(threads.map((thread) => thread.agentId)).toEqual(["blocking", "waiting", "recent"]);
});

test("names hosts only when questions come from more than one", () => {
  const thread = (id: string) => ({
    id,
    title: id,
    workspaceId: "w1",
    archivedAt: null,
    questions: [question(id)],
  });
  const threads = collectThreadQuestions([host("host", [thread("a")]), host("dev", [thread("b")])]);
  expect(threads.map((item) => item.hostLabel).sort()).toEqual(["DEV", "HOST"]);
  expect(new Set(threads.map((item) => item.key)).size).toBe(2);
});
