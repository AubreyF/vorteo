import { z } from "zod";

export const AgentJournalEntrySchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  text: z.string().min(1).max(8000),
});
export type AgentJournalEntry = z.infer<typeof AgentJournalEntrySchema>;

export const AppendJournalSchema = z
  .object({
    entryId: z.string().uuid(),
    text: z.string().trim().min(1).max(8000),
  })
  .strict();
export type AppendJournalInput = z.infer<typeof AppendJournalSchema>;
