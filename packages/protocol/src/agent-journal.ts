import { z } from "zod";

export const AgentJournalEntrySchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  text: z.string().min(1).max(8000),
  machineContext: z.string().max(32000).optional(),
});
export type AgentJournalEntry = z.infer<typeof AgentJournalEntrySchema>;

export const AppendJournalSchema = z
  .object({
    entryId: z.string().uuid(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(8000)
      .describe(
        "Human-facing summary: at most three short sentences and fewer than 60 words. No IDs, raw paths or logs.",
      ),
    machineContext: z
      .string()
      .max(32000)
      .optional()
      .describe(
        "Agent-only reference details, IDs, paths and recovery notes. Not rendered in the journal card. Never include secrets.",
      ),
  })
  .strict();
export type AppendJournalInput = z.infer<typeof AppendJournalSchema>;
