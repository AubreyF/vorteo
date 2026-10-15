import { openSync, closeSync, fsyncSync } from "node:fs";
import path from "node:path";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { PreviewMonitorJobSchema } from "@getpaseo/protocol/preview-monitor-maintenance";
import { z } from "zod";
import { RestartJobSchema } from "@getpaseo/protocol/execution-installation";
import { NativeHelperJobSchema } from "@getpaseo/protocol/native-helper-maintenance";
import { MaintenanceServiceJobSchema } from "@getpaseo/protocol/maintenance-service";

// The existing coordinator owns this single ledger. Legacy readers reject helper
// entries rather than dropping their operation and executing a daemon restart.
const LifecycleJobSchema = z.discriminatedUnion("target", [
  RestartJobSchema,
  NativeHelperJobSchema,
  PreviewMonitorJobSchema,
  MaintenanceServiceJobSchema,
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

/** Durable selection intent must precede a lifecycle effect, including directory rename. */
export function writeLifecycleReceipt(file: string, value: unknown): void {
  writePrivateFileAtomicSync(file, JSON.stringify(value));
  for (const target of [file, path.dirname(file)]) {
    const descriptor = openSync(target, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
