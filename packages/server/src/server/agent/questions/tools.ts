import { z } from "zod";
import { QuestionMutationSchema } from "@getpaseo/protocol/agent-questions";
import type { AgentManager } from "../agent-manager.js";
import type { PaseoToolDefinition, PaseoToolResult } from "../tools/types.js";
import { QUESTION_GUIDANCE } from "./model.js";

const ReadQuestionsSchema = z.object({}).strict();
const UpdateQuestionsSchema = z.object({ mutation: QuestionMutationSchema }).strict();

function result(value: unknown): PaseoToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function createQuestionTools(
  manager: Pick<AgentManager, "readQuestions" | "mutateQuestions">,
  callerAgentId: string,
): PaseoToolDefinition[] {
  return [
    {
      name: "get_questions",
      title: "Read your thread's open questions",
      description:
        "Read the questions this thread asked the owner, in ask order, with their status (open, answered, withdrawn) and any owner answer. Answers are the owner's decisions for those questions only.",
      inputSchema: ReadQuestionsSchema,
      handler: async (input) => {
        ReadQuestionsSchema.parse(input);
        return result({ questions: await manager.readQuestions(callerAgentId) });
      },
    },
    {
      name: "update_questions",
      title: "Ask or revise a question for the owner",
      description:
        "Ask the owner a blocking question, revise an open question, or withdraw one that no longer needs them. Questions appear in the Open questions card and sidebar. ask requires a fresh UUID id, question, why and recommendedDefault; blocks lists this thread's checklist task IDs. update changes fields of an open question. withdraw closes it without an answer. You cannot answer questions. " +
        QUESTION_GUIDANCE,
      inputSchema: UpdateQuestionsSchema,
      handler: async (input) => {
        const { mutation } = UpdateQuestionsSchema.parse(input);
        return result({ questions: await manager.mutateQuestions(callerAgentId, mutation) });
      },
    },
  ];
}
