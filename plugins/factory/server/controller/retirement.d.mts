import type { FactoryRecordAuthority } from "./qualification-journal.mjs";
import type { githubRequest } from "./github-transport.mjs";

export interface FactoryRetirementIdentity {
  archiveSha256: string;
  attemptId: string;
  issueNumber: number;
  occurrenceId: string;
  repository: string;
  scheduleId: string;
  schedulerRunId: string;
}

export interface FactoryExternalCompletion {
  devCommit: string;
  mergeCommit: string;
  pullRequest: number;
}

export interface FactoryParkedPull {
  number: number;
  head: string;
}

export interface FactoryParkingCompletion {
  blockerSha256: string;
  commentId: number;
  commentSha256: string;
  pull: FactoryParkedPull | null;
}

export interface FactoryExternalRetirement extends FactoryRetirementIdentity {
  reason: "completed_elsewhere";
  completion: FactoryExternalCompletion;
}

export interface FactoryParkedRetirement extends FactoryRetirementIdentity {
  reason: "blocked";
  completion: FactoryParkingCompletion;
}

export type FactoryRetirementReceipt = FactoryExternalRetirement | FactoryParkedRetirement;

export interface FactoryExternalVerifierOptions {
  authority: FactoryRecordAuthority;
  request?: typeof githubRequest;
}

export interface FactoryParkingVerifierOptions extends FactoryExternalVerifierOptions {
  ownerId: number;
}

export interface FactoryRetirementVerifier {
  (receipt: FactoryRetirementReceipt): Promise<boolean>;
}

export function assertFactoryRetirement(value: unknown): asserts value is FactoryRetirementReceipt;
/** Read-only administrative reconciliation, never Factory shipment authentication. */
export function createFactoryExternalCompletionVerifier(
  input: FactoryExternalVerifierOptions,
): FactoryRetirementVerifier;
/** Parking retains a public hold and does not complete delivery. */
export function createFactoryParkingVerifier(
  input: FactoryParkingVerifierOptions,
): FactoryRetirementVerifier;
