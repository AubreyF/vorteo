import {
  QuotaConstructionCleanupError,
  type AgentSession,
  type CapturedQuotaExecutionClient,
  type QuotaGovernedSessionInput,
} from "../agent/agent-sdk-types.js";
import { LinuxQuotaProcessCustody } from "../agent/quota-reserve/linux-custody.js";
import {
  QuotaExecutionSupervisor,
  type QuotaSupervisorOptions,
} from "../agent/quota-reserve/governor-supervisor.js";
import type { QuotaGovernorStore } from "../agent/quota-reserve/governor-store.js";

export type FactoryRecoveryStore = Pick<
  QuotaGovernorStore,
  "recoverAbandonedAccountLock" | "reservationState" | "transition" | "finalize"
>;

export type FactoryExecutionObservationStore = Pick<QuotaGovernorStore, "observeEstimatedUsage">;

export type FactoryStageStore = Pick<QuotaGovernorStore, "execution" | "transition" | "finalize">;
export type FactoryStageCustody = Pick<
  LinuxQuotaProcessCustody,
  "directory" | "identity" | "spawn" | "settle"
>;
export type FactoryStageSession = Pick<AgentSession, "run" | "close" | "readQuotaObservation">;
export interface FactoryStageClient extends Pick<CapturedQuotaExecutionClient, "assertCurrent"> {
  openSession(input: QuotaGovernedSessionInput): Promise<FactoryStageSession>;
}
export type FactoryStageSupervisor = Pick<
  QuotaExecutionSupervisor,
  "guard" | "startMonitoring" | "freeze" | "reconcileFreeze" | "complete"
>;
export interface FactoryStageSupervisorOptions extends Omit<QuotaSupervisorOptions, "store"> {
  store: FactoryStageStore;
}
export interface FactoryStageNativeRuntime {
  store: FactoryStageStore;
  NativeCustody: {
    create(
      input: Parameters<typeof LinuxQuotaProcessCustody.create>[0],
    ): Promise<FactoryStageCustody>;
    readSettlement: typeof LinuxQuotaProcessCustody.readSettlement;
    readOutcome: typeof LinuxQuotaProcessCustody.readOutcome;
  };
  QuotaSupervisor: {
    prototype: Pick<QuotaExecutionSupervisor, "complete">;
    attach(input: FactoryStageSupervisorOptions): Promise<FactoryStageSupervisor>;
  };
  ConstructionCleanupError: typeof QuotaConstructionCleanupError;
}
export type { QuotaGovernedSessionInput } from "../agent/agent-sdk-types.js";
export type { QuotaExecutionSettlement } from "../agent/quota-reserve/governor-supervisor.js";

/** Supply constructors from this daemon build and its existing store, never a second governor. */
export function createFactoryStageNativeRuntime(
  store: QuotaGovernorStore,
): FactoryStageNativeRuntime {
  const attach = QuotaExecutionSupervisor.attach;
  return {
    store,
    NativeCustody: LinuxQuotaProcessCustody,
    ConstructionCleanupError: QuotaConstructionCleanupError,
    QuotaSupervisor: {
      prototype: QuotaExecutionSupervisor.prototype,
      async attach(input) {
        if (input.store !== store || QuotaExecutionSupervisor.attach !== attach)
          throw new Error("Factory native stage runtime changed.");
        return attach.call(QuotaExecutionSupervisor, { ...input, store });
      },
    },
  };
}
