import type { QuotaAccount, QuotaObservation } from "@getpaseo/protocol/quota-governor";
import type { FactoryRecoveryStore } from "@getpaseo/server/factory-stage-native";
import type { FactoryClaimAttempt, FactoryWorkerExecution } from "./claim-journal.mjs";
import type { FactoryRecordAuthority } from "./qualification-journal.mjs";

export type FactoryRecoveryAttempt = Pick<
  FactoryClaimAttempt,
  "scheduleId" | "occurrenceId" | "executions"
>;
export interface FactoryRecoveryRecords {
  current(): { active: FactoryRecoveryAttempt | null };
  reconcile(): Promise<unknown>;
}
export interface FactoryReleaseRecoveryOwner extends FactoryRecoveryAttempt {
  account: QuotaAccount;
  reservationId: string;
  providerId: string;
}
export interface FactoryAccountRecoveryOptions {
  authority: FactoryRecordAuthority;
  claims: FactoryRecoveryRecords;
  store: Pick<FactoryRecoveryStore, "recoverAbandonedAccountLock">;
  account: QuotaAccount;
  intake?: FactoryRecoveryRecords;
  releases?: { reconcileCustody(): Promise<FactoryReleaseRecoveryOwner[]> };
  providerId?: string;
}
export interface FactoryExecutionRecoveryOptions {
  authority: FactoryRecordAuthority;
  records: FactoryRecoveryRecords;
  store: Pick<FactoryRecoveryStore, "reservationState" | "transition" | "finalize">;
  readObservation(providerId: string): Promise<QuotaObservation>;
  authenticationGeneration(providerId: string): Promise<string>;
}
export interface FactoryRecoveredExecution extends FactoryWorkerExecution {
  kind: "finalized" | "manual_resume_required" | "resumable";
}
export type FactoryExecutionRecoveryResult =
  | { kind: "clear" }
  | {
      kind: "resume_required";
      attempt: FactoryRecoveryAttempt;
      executions: FactoryRecoveredExecution[];
    };
export class FactoryRecoveryUncertainError extends Error {
  readonly writeAttempted: true;
  readonly cause: unknown;
  readonly operation: string;
}
/** Requires startup exclusion of all account writers, not merely an assertion callback. */
export function recoverFactoryAccount(
  input: FactoryAccountRecoveryOptions,
): Promise<"absent" | "recovered">;
export function reconcileFactoryExecutionOwner(
  input: FactoryExecutionRecoveryOptions,
): Promise<FactoryExecutionRecoveryResult>;
export function reconcileFactoryAttempt(
  input: Omit<FactoryExecutionRecoveryOptions, "records"> & { claims: FactoryRecoveryRecords },
): Promise<FactoryExecutionRecoveryResult>;
