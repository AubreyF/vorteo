import type { QuotaAccount, QuotaObservation } from "@getpaseo/protocol/quota-governor";
import type {
  FactoryStageNativeRuntime,
  FactoryStageClient,
  FactoryStageCustody,
  QuotaGovernedSessionInput,
  QuotaExecutionSettlement,
} from "@getpaseo/server/factory-stage-native";
import type { FactoryWorkflowStageOutcome, FactoryWorkflowStageKind } from "./workflow.mjs";

export interface FactoryGovernedStageCustodyBinding {
  custody: FactoryStageCustody;
  account: QuotaAccount;
  reservationId: string;
  providerId: string;
  occurrenceId: string;
  stage: FactoryWorkflowStageKind;
  workspace: string;
}
export interface FactoryGovernedStageOptions extends FactoryStageNativeRuntime {
  authority: { identity: { epoch: number }; assertCurrent(): void };
  client: FactoryStageClient;
  account: QuotaAccount;
  reservationId: string;
  providerId: string;
  occurrenceId: string;
  attemptId: string;
  stage: FactoryWorkflowStageKind;
  authenticationGeneration: string;
  assertAuthentication(): void;
  readObservation(): Promise<QuotaObservation>;
  recordCustody(input: FactoryGovernedStageCustodyBinding): Promise<void>;
  sessionConfig: QuotaGovernedSessionInput["config"];
  custodyOptions: Omit<
    Parameters<FactoryStageNativeRuntime["NativeCustody"]["create"]>[0],
    "identity"
  >;
  placement?: QuotaGovernedSessionInput["placement"];
  permissionProfile?: string;
  authentication?: {
    authenticationGeneration: string;
    assertCurrent(): void;
    readTokens: NonNullable<QuotaGovernedSessionInput["externalChatgptAuth"]>["readTokens"];
  };
  timeoutMs?: number;
  resume?: boolean;
  manualResume?: boolean;
}
export interface FactoryGovernedStageOutcome extends FactoryWorkflowStageOutcome {
  settlement: QuotaExecutionSettlement;
}
export interface FactoryGovernedStage {
  readonly executionId: string;
  stop(reason?: "manual" | "quota"): Promise<void>;
  reconcileStop(): Promise<void>;
  run(prompt: string): Promise<FactoryGovernedStageOutcome>;
}
export function createFactoryGovernedStage(
  options: FactoryGovernedStageOptions,
): FactoryGovernedStage;
