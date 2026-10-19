import { createHash } from "node:crypto";
import type { AgentQuestion, QuestionMutation } from "@getpaseo/protocol/agent-questions";

const MAX_QUESTIONS = 200;
/** Closed questions beyond this many are pruned once answers are delivered. */
const RETAINED_CLOSED_QUESTIONS = 20;
const MIN_DEFAULT_WINDOW_MS = 15 * 60_000;

export class QuestionError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "QuestionError";
  }
}

export const QUESTION_GUIDANCE =
  "Ask the owner with update_questions only when a decision genuinely needs them and cannot be resolved from the request, code, or sensible defaults. Keep the question short, explain why it matters in why, list the checklist task IDs it blocks, and always give recommendedDefault. Continue independent work while waiting. The owner's answer arrives as a message in this thread. If defaultAppliesAfter passes without an answer, you may proceed with the recommended default; record that in the journal and leave the question open so the owner can still override it. Withdraw a question as soon as it no longer needs the owner. Never answer your own question.";

interface AskContext {
  askedBy: string;
  now: string;
  taskIds: ReadonlySet<string>;
}

interface OwnerAnswer {
  questionId: string;
  answer: string;
  answeredBy: string;
  now: string;
}

export interface AnsweredQuestions {
  questions: AgentQuestion[];
  answered: AgentQuestion;
}

function requireTasks(blocks: string[] | undefined, taskIds: ReadonlySet<string>): void {
  const missing = blocks?.find((id) => !taskIds.has(id));
  if (missing !== undefined)
    throw new QuestionError("invalid", `Checklist task ${missing} does not exist in this thread.`);
}

type AskedFields = Pick<
  AgentQuestion,
  "id" | "question" | "why" | "recommendedDefault" | "blocks" | "defaultAppliesAfter"
>;

/** Field order is fixed so retried asks compare by value. */
function askedFields(question: AskedFields): string {
  return JSON.stringify([
    question.id,
    question.question,
    question.why,
    question.recommendedDefault,
    question.blocks ?? [],
    question.defaultAppliesAfter ?? null,
  ]);
}

/** The owner needs a real chance to answer before an agent proceeds on its default. */
function requireDefaultWindow(defaultAppliesAfter: string | null | undefined, now: string): void {
  if (!defaultAppliesAfter) return;
  if (Date.parse(defaultAppliesAfter) - Date.parse(now) < MIN_DEFAULT_WINDOW_MS)
    throw new QuestionError(
      "invalid",
      "defaultAppliesAfter must be at least 15 minutes after the question is asked or updated.",
    );
}

function closedAt(question: AgentQuestion): string {
  return question.answeredAt ?? question.askedAt;
}

/** Keep open and undelivered questions, plus the newest closed ones. */
function retainQuestions(questions: AgentQuestion[]): AgentQuestion[] {
  const pending = (question: AgentQuestion) =>
    question.status === "open" || (question.status === "answered" && !question.answerDeliveredAt);
  const closed = questions.filter((question) => !pending(question));
  if (closed.length <= RETAINED_CLOSED_QUESTIONS) return questions;
  const kept = new Set(
    closed
      .sort((left, right) => closedAt(right).localeCompare(closedAt(left)))
      .slice(0, RETAINED_CLOSED_QUESTIONS),
  );
  return questions.filter((question) => pending(question) || kept.has(question));
}

/** Withdrawn questions need no owner, so snapshots omit them. */
export function snapshotQuestions(
  questions: AgentQuestion[] | undefined,
): AgentQuestion[] | undefined {
  return questions?.filter((question) => question.status !== "withdrawn");
}

function requireQuestion(questions: AgentQuestion[], id: string): AgentQuestion {
  const question = questions.find((item) => item.id === id);
  if (!question) throw new QuestionError("not_found", `Question ${id} does not exist.`);
  return question;
}

function replaceQuestion(questions: AgentQuestion[], next: AgentQuestion): AgentQuestion[] {
  return questions.map((item) => (item.id === next.id ? next : item));
}

/** Agents ask, revise, and withdraw. Only the owner's RPC can answer. */
export function mutateQuestions(
  questions: AgentQuestion[],
  mutation: QuestionMutation,
  context: AskContext,
): AgentQuestion[] {
  if (mutation.operation === "ask") {
    requireTasks(mutation.blocks, context.taskIds);
    const previous = questions.find((item) => item.id === mutation.id);
    if (previous) {
      if (askedFields(previous) !== askedFields(mutation))
        throw new QuestionError(
          "conflict",
          "This question ID was already used for a different question. Ask with a fresh UUID.",
        );
      return questions;
    }
    requireDefaultWindow(mutation.defaultAppliesAfter, context.now);
    if (questions.length >= MAX_QUESTIONS)
      throw new QuestionError("invalid", "This thread already has too many questions.");
    const asked: AgentQuestion = {
      id: mutation.id,
      question: mutation.question,
      why: mutation.why,
      recommendedDefault: mutation.recommendedDefault,
      ...(mutation.blocks ? { blocks: mutation.blocks } : {}),
      ...(mutation.defaultAppliesAfter
        ? { defaultAppliesAfter: mutation.defaultAppliesAfter }
        : {}),
      askedAt: context.now,
      askedBy: context.askedBy,
      status: "open",
    };
    return [...questions, asked];
  }
  const question = requireQuestion(questions, mutation.id);
  if (mutation.operation === "withdraw") {
    if (question.status === "withdrawn") return questions;
    if (question.status === "answered")
      throw new QuestionError("conflict", "The owner already answered this question.");
    return retainQuestions(replaceQuestion(questions, { ...question, status: "withdrawn" }));
  }
  if (question.status !== "open")
    throw new QuestionError(
      "conflict",
      `Only open questions can be updated; this one is ${question.status}.`,
    );
  requireTasks(mutation.blocks, context.taskIds);
  requireDefaultWindow(mutation.defaultAppliesAfter, context.now);
  const { defaultAppliesAfter: _previous, ...revisable } = question;
  const defaultAppliesAfter =
    mutation.defaultAppliesAfter === undefined
      ? question.defaultAppliesAfter
      : mutation.defaultAppliesAfter;
  const updated: AgentQuestion = {
    ...revisable,
    question: mutation.question ?? question.question,
    why: mutation.why ?? question.why,
    recommendedDefault: mutation.recommendedDefault ?? question.recommendedDefault,
    ...(mutation.blocks ? { blocks: mutation.blocks } : {}),
    ...(defaultAppliesAfter ? { defaultAppliesAfter } : {}),
  };
  return replaceQuestion(questions, updated);
}

/** Repeating the same answer is idempotent so a lost response can be retried. */
export function answerQuestion(questions: AgentQuestion[], input: OwnerAnswer): AnsweredQuestions {
  const question = requireQuestion(questions, input.questionId);
  if (question.status === "withdrawn")
    throw new QuestionError(
      "conflict",
      "The agent withdrew this question; it no longer needs an answer.",
    );
  if (question.status === "answered") {
    if (question.answer !== input.answer)
      throw new QuestionError("conflict", "This question was already answered.");
    return { questions, answered: question };
  }
  const answered: AgentQuestion = {
    ...question,
    status: "answered",
    answer: input.answer,
    answeredAt: input.now,
    answeredBy: input.answeredBy,
  };
  return { questions: replaceQuestion(questions, answered), answered };
}

/** Recorded only after the answer message is durably queued. */
export function markAnswerDelivered(
  questions: AgentQuestion[],
  questionId: string,
  now: string,
): AgentQuestion[] {
  const question = requireQuestion(questions, questionId);
  if (question.answerDeliveredAt) return questions;
  return retainQuestions(replaceQuestion(questions, { ...question, answerDeliveredAt: now }));
}

/** A stable journal entry ID makes answer retries append at most one entry. */
export function answerJournalEntryId(questionId: string): string {
  const hex = createHash("sha256").update(`question-answer:${questionId}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function answerMessage(question: AgentQuestion): string {
  return `The owner answered your open question.\n\nQuestion: ${question.question}\nAnswer: ${question.answer}\n\nContinue the work this question blocked, following this answer.`;
}

export function answerJournalText(question: AgentQuestion): string {
  return `Owner answered "${question.question}": ${question.answer}`;
}
