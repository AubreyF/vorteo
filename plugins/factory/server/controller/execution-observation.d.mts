import type { QuotaGovernorPolicy, QuotaObservation } from "@getpaseo/protocol/quota-governor";
import type { FactoryExecutionObservationStore } from "@getpaseo/server/factory-stage-native";
import type { FactoryRecordAuthority } from "./qualification-journal.mjs";

export class FactoryExecutionObservationUncertainError extends Error {
  readonly writeAttempted: true;
  readonly cause: unknown;
}
export interface FactoryExecutionObservationOptions {
  authority: FactoryRecordAuthority;
  client: FactoryRecordAuthority;
  authentication: FactoryRecordAuthority & { authenticationGeneration: string };
  store: FactoryExecutionObservationStore;
  quotaPolicy: QuotaGovernorPolicy;
  readRawObservation(): Promise<QuotaObservation>;
}
/** Caller must already hold reconciled native account authority. No timer or sampler is created. */
export function createFactoryObservationReader(
  input: FactoryExecutionObservationOptions,
): () => Promise<QuotaObservation>;
