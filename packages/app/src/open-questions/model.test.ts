import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import { expect, test } from "vitest";
import { answeredFrom, blockedTasks, groupQuestions, workspaceOpenQuestionCount } from "./model";

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

test("open questions keep ask order, answered ones show newest first and withdrawn ones are hidden", () => {
  const groups = groupQuestions([
    question("a", { status: "answered", answer: "Yes", answeredAt: "2026-10-18T11:00:00.000Z" }),
    question("b"),
    question("c", { status: "withdrawn" }),
    question("d", { status: "answered", answer: "No", answeredAt: "2026-10-18T12:00:00.000Z" }),
    question("e"),
  ]);
  expect(groups.open.map((item) => item.id)).toEqual(["b", "e"]);
  expect(groups.answered.map((item) => item.id)).toEqual(["d", "a"]);
});

test("blocked tasks resolve to this thread's Vorteo task titles and skip deleted ones", () => {
  const tasks = [
    { id: "api", text: "Build API", completed: false, source: "vorteo" as const },
    { id: "native", text: "Provider task", completed: false, source: "provider" as const },
  ];
  expect(blockedTasks(question("a", { blocks: ["api", "native", "gone"] }), tasks)).toEqual([
    { id: "api", text: "Build API" },
  ]);
});

test("workspace count sums open questions across active threads only", () => {
  const agents = [
    { id: "one", workspaceId: "w", archivedAt: null, questions: [question("a"), question("b")] },
    {
      id: "two",
      workspaceId: "w",
      archivedAt: null,
      questions: [question("c", { status: "answered" })],
    },
    { id: "archived", workspaceId: "w", archivedAt: new Date(), questions: [question("d")] },
    { id: "pending", workspaceId: "w", archivedAt: null, questions: [question("e")] },
    { id: "other", workspaceId: "x", archivedAt: null, questions: [question("f")] },
    { id: "legacy", workspaceId: "w", archivedAt: null },
  ];
  expect(workspaceOpenQuestionCount(agents, "w", new Set(["pending"]))).toBe(2);
});

test("answered rows name the interface that answered", () => {
  expect(answeredFrom("mobile:client-1")).toBe("the Vorteo app");
  expect(answeredFrom("browser:client-2")).toBe("a browser");
  expect(answeredFrom("owner")).toBeNull();
  expect(answeredFrom(undefined)).toBeNull();
});
