import type { FactoryClaimJournal, FactoryClaimAttempt } from "./claim-journal.mjs";
import type { FactoryQueuePolicy } from "./github-queue.mjs";
import type { FactoryQualifiedVerifier } from "./qualified-assignment.mjs";
import type { FactoryRecordAuthority } from "./qualification-journal.mjs";
import type { githubRequest } from "./github-transport.mjs";

export interface FactorySelectionProgress {
  stage: "working";
  message: string;
}
export interface FactorySelectionDelivery {
  /** Real publisher must reconcile an uncertain write using this retained claim. */
  writeProgress(attempt: FactoryClaimAttempt, progress: FactorySelectionProgress): Promise<unknown>;
}
export interface FactorySelectionOptions {
  authority: FactoryRecordAuthority;
  claims: Pick<FactoryClaimJournal, "current" | "reconcile" | "claimQualified" | "claimSelected">;
  policy: FactoryQueuePolicy;
  ownerId: number;
  excludedIssues: number[];
  delivery: FactorySelectionDelivery;
  /** Production standing-scope admission requires the verified qualified reader. */
  qualified?: Pick<FactoryQualifiedVerifier, "readQueue" | "admit">;
  request?: typeof githubRequest;
}
export interface FactorySelectionSchedule {
  id: string;
}
export interface FactorySelection {
  (schedule: FactorySelectionSchedule, scheduledFor: string): Promise<FactoryClaimAttempt | null>;
}
export function createFactorySelection(input: FactorySelectionOptions): FactorySelection;
