import { z } from "zod";
import { RestartJobSchema } from "@getpaseo/protocol/execution-installation";
import { NativeHelperJobSchema } from "@getpaseo/protocol/native-helper-maintenance";

// The existing coordinator owns this single ledger. Legacy readers reject helper
// entries rather than dropping their operation and executing a daemon restart.
const LifecycleJobSchema = z.discriminatedUnion("target", [
  RestartJobSchema,
  NativeHelperJobSchema,
]);
const LifecycleJournalSchema = z.array(LifecycleJobSchema);
export type LifecycleJob = z.infer<typeof LifecycleJobSchema>;

export function parseLifecycleJournal(input: unknown): LifecycleJob[] {
  const jobs = LifecycleJournalSchema.parse(input);
  const identities = new Set<string>();
  for (const job of jobs) {
    if (identities.has(job.id)) throw new Error("Installation journal contains duplicate requests");
    identities.add(job.id);
  }
  return jobs;
}
