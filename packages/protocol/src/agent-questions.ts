import { z } from "zod";

export const AgentQuestionStatusSchema = z.enum(["open", "answered", "withdrawn"]);

export const AgentQuestionSchema = z.object({
  id: z.string().uuid(),
  question: z.string().min(1).max(500),
  why: z.string().min(1).max(2000),
  blocks: z.array(z.string().min(1)).max(50).optional(),
  recommendedDefault: z.string().min(1).max(2000),
  defaultAppliesAfter: z.string().datetime().optional(),
  askedAt: z.string().datetime(),
  askedBy: z.string(),
  status: AgentQuestionStatusSchema,
  answer: z.string().optional(),
  answeredAt: z.string().datetime().optional(),
  answeredBy: z.string().optional(),
  answerDeliveredAt: z.string().datetime().optional(),
});
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;

const QuestionFields = {
  question: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("One short question the owner can answer without reading the conversation."),
  why: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Why this needs the owner and what stays blocked until it is answered."),
  recommendedDefault: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("The answer you recommend. The owner can accept it with one click."),
  blocks: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("IDs of this thread's checklist tasks that wait for the answer."),
  defaultAppliesAfter: z
    .string()
    .datetime()
    .optional()
    .describe(
      "Optional ISO time, at least 15 minutes ahead, after which you will proceed with the recommended default if the owner has not answered.",
    ),
};

export const QuestionMutationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("ask"),
      id: z
        .string()
        .uuid()
        .describe("A fresh UUID. Reuse it with identical fields when retrying a lost response."),
      ...QuestionFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("update"),
      id: z.string().uuid(),
      question: QuestionFields.question.optional(),
      why: QuestionFields.why.optional(),
      recommendedDefault: QuestionFields.recommendedDefault.optional(),
      blocks: QuestionFields.blocks,
      defaultAppliesAfter: z
        .string()
        .datetime()
        .nullable()
        .optional()
        .describe("A new time after which the default applies, or null to remove it."),
    })
    .strict(),
  z.object({ operation: z.literal("withdraw"), id: z.string().uuid() }).strict(),
]);
export type QuestionMutation = z.infer<typeof QuestionMutationSchema>;

export const QuestionAnswerRequestSchema = z.object({
  type: z.literal("agent.questions.answer.request"),
  agentId: z.string(),
  requestId: z.string(),
  questionId: z.string().uuid(),
  answer: z.string().min(1).max(4000),
});
export const QuestionAnswerResponseSchema = z.object({
  type: z.literal("agent.questions.answer.response"),
  payload: z.object({
    agentId: z.string(),
    requestId: z.string(),
    questions: z.array(AgentQuestionSchema).nullable(),
    error: z.string().nullable(),
  }),
});
