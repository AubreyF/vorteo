import { expect, test } from "vitest";
import { z } from "zod";
import { QuestionMutationSchema, type AgentQuestion } from "@getpaseo/protocol/agent-questions";
import {
  answerJournalEntryId,
  answerQuestion,
  markAnswerDelivered,
  mutateQuestions,
  QuestionError,
  snapshotQuestions,
} from "./model.js";

const id = "11111111-1111-4111-8111-111111111111";
const context = { askedBy: "agent", now: "2026-10-18T10:00:00.000Z", taskIds: new Set(["api"]) };
const ask = {
  operation: "ask" as const,
  id,
  question: "Ship the beta tonight?",
  why: "Release notes wait for this decision.",
  recommendedDefault: "Ship tomorrow morning",
  blocks: ["api"],
};

function asked(): AgentQuestion[] {
  return mutateQuestions([], ask, context);
}

test("ask requires a recommended default and agents have no answer operation", () => {
  const { recommendedDefault: _omitted, ...withoutDefault } = ask;
  expect(QuestionMutationSchema.safeParse(withoutDefault).success).toBe(false);
  expect(QuestionMutationSchema.safeParse({ ...ask, recommendedDefault: " " }).success).toBe(false);
  expect(QuestionMutationSchema.safeParse({ operation: "answer", id, answer: "Yes" }).success).toBe(
    false,
  );
  expect(QuestionMutationSchema.safeParse({ ...ask, status: "answered" }).success).toBe(false);
});

test("ask records an open question and retries are idempotent", () => {
  const questions = asked();
  expect(questions).toEqual([
    {
      id,
      question: ask.question,
      why: ask.why,
      recommendedDefault: ask.recommendedDefault,
      blocks: ["api"],
      askedAt: context.now,
      askedBy: "agent",
      status: "open",
    },
  ]);
  expect(mutateQuestions(questions, ask, { ...context, now: "2026-10-18T11:00:00.000Z" })).toBe(
    questions,
  );
  expect(() => mutateQuestions(questions, { ...ask, question: "Different?" }, context)).toThrow(
    QuestionError,
  );
});

test("blocked tasks must exist in the thread checklist", () => {
  expect(() => mutateQuestions([], { ...ask, blocks: ["missing"] }, context)).toThrow(
    "Checklist task missing does not exist",
  );
});

test("agents update and withdraw open questions but cannot reopen answered ones", () => {
  const updated = mutateQuestions(
    asked(),
    { operation: "update", id, recommendedDefault: "Ship at noon" },
    context,
  );
  expect(updated[0]).toMatchObject({ recommendedDefault: "Ship at noon", question: ask.question });
  const withdrawn = mutateQuestions(updated, { operation: "withdraw", id }, context);
  expect(withdrawn[0]?.status).toBe("withdrawn");
  expect(mutateQuestions(withdrawn, { operation: "withdraw", id }, context)).toBe(withdrawn);
  expect(() =>
    mutateQuestions(withdrawn, { operation: "update", id, why: "Changed" }, context),
  ).toThrow("Only open questions can be updated");
  expect(() =>
    answerQuestion(withdrawn, { questionId: id, answer: "Yes", answeredBy: "owner", now: "x" }),
  ).toThrow("withdrew");
});

test("owner answers once; the same answer is idempotent and a different one conflicts", () => {
  const input = {
    questionId: id,
    answer: "Ship tomorrow morning",
    answeredBy: "owner",
    now: "2026-10-18T12:00:00.000Z",
  };
  const first = answerQuestion(asked(), input);
  expect(first.answered).toMatchObject({
    status: "answered",
    answer: input.answer,
    answeredAt: input.now,
    answeredBy: "owner",
  });
  expect(answerQuestion(first.questions, { ...input, now: "later" }).questions).toBe(
    first.questions,
  );
  expect(() => answerQuestion(first.questions, { ...input, answer: "Ship now" })).toThrow(
    "already answered",
  );
  expect(() => mutateQuestions(first.questions, { operation: "withdraw", id }, context)).toThrow(
    "already answered",
  );
});

test("answer journal entry IDs are stable valid UUIDs", () => {
  const entryId = answerJournalEntryId(id);
  expect(z.string().uuid().safeParse(entryId).success).toBe(true);
  expect(answerJournalEntryId(id)).toBe(entryId);
  expect(answerJournalEntryId("22222222-2222-4222-8222-222222222222")).not.toBe(entryId);
});

test("the default needs at least fifteen minutes and an update can clear it", () => {
  const soon = "2026-10-18T10:10:00.000Z";
  const later = "2026-10-18T10:15:00.000Z";
  expect(() => mutateQuestions([], { ...ask, defaultAppliesAfter: soon }, context)).toThrow(
    "at least 15 minutes",
  );
  const questions = mutateQuestions([], { ...ask, defaultAppliesAfter: later }, context);
  expect(questions[0]?.defaultAppliesAfter).toBe(later);
  expect(() =>
    mutateQuestions(questions, { operation: "update", id, defaultAppliesAfter: soon }, context),
  ).toThrow("at least 15 minutes");
  const cleared = mutateQuestions(
    questions,
    { operation: "update", id, defaultAppliesAfter: null },
    context,
  );
  expect(cleared[0]).not.toHaveProperty("defaultAppliesAfter");
  expect(
    QuestionMutationSchema.safeParse({ operation: "update", id, defaultAppliesAfter: null })
      .success,
  ).toBe(true);
});

test("delivered answers are marked once and old closed questions are pruned, never undelivered ones", () => {
  let questions: AgentQuestion[] = [];
  for (let index = 0; index < 23; index++) {
    const questionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    questions = mutateQuestions(questions, { ...ask, id: questionId }, context);
    questions = answerQuestion(questions, {
      questionId,
      answer: "Yes",
      answeredBy: "mobile:app",
      now: `2026-10-18T11:${String(index).padStart(2, "0")}:00.000Z`,
    }).questions;
  }
  const undelivered = questions[0]!.id;
  for (const question of questions.slice(1))
    questions = markAnswerDelivered(questions, question.id, "2026-10-18T12:00:00.000Z");
  expect(questions).toHaveLength(21);
  expect(questions[0]?.id).toBe(undelivered);
  const kept = questions.map((item) => item.id);
  expect(kept).not.toContain("00000000-0000-4000-8000-000000000001");
  expect(kept).not.toContain("00000000-0000-4000-8000-000000000002");
  const delivered = markAnswerDelivered(questions, undelivered, "2026-10-18T12:01:00.000Z");
  expect(delivered).toHaveLength(20);
  expect(markAnswerDelivered(delivered, delivered[0]!.id, "later")).toBe(delivered);
});

test("snapshots omit withdrawn questions", () => {
  const withdrawn = mutateQuestions(asked(), { operation: "withdraw", id }, context);
  expect(snapshotQuestions(withdrawn)).toEqual([]);
  expect(snapshotQuestions(asked())).toHaveLength(1);
  expect(snapshotQuestions(undefined)).toBeUndefined();
});
