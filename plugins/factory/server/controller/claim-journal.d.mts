import type { FactoryRecordAuthority } from "./qualification-journal.mjs";
import type { FactoryBaseAttempt, FactoryBaseRevision } from "./base-revision.mjs";
import type { FactoryApproval, FactoryAssignmentRecheck } from "./github-queue.mjs";
import type {
  FactoryQualificationBinding,
  FactoryQualifiedAssignment,
} from "./qualified-assignment.mjs";
import type { FactoryWorkflowState, FactoryWorkflowStageKind } from "./workflow.mjs";
import type { FactoryMergeReceipt } from "./merge-controller.mjs";
import type {
  FactoryExternalCompletion,
  FactoryExternalRetirement,
  FactoryParkingCompletion,
  FactoryParkedRetirement,
  FactoryRetirementReceipt,
  FactoryRetirementVerifier,
} from "./retirement.mjs";

export interface FactoryClaimAuthority extends FactoryRecordAuthority {
  root: string;
  identity: { installationId: string; epoch: number };
}

/** Projection of the existing native custody identity, verified by the settlement port. */
export interface FactoryCustodyIdentity {
  version: 1;
  executionId: string;
  authenticationGeneration: string;
  attemptId: string;
  ownershipGeneration: number;
  nonce: string;
}

export interface FactoryExecutionCustody {
  directory: string;
  identity: FactoryCustodyIdentity;
}

export interface FactoryWorkerBinding {
  account: { issuer: string; accountId: string };
  reservationId: string;
  providerId: string;
  stage: FactoryWorkflowStageKind;
  workspace: string;
  occurrenceId: string;
}

export interface FactoryHelperBinding {
  operationId: string;
  kind: "preparation" | "checkpoint" | "publication" | "merge";
  workspace: string;
}

export interface FactoryWorkerExecution extends FactoryExecutionCustody {
  binding: FactoryWorkerBinding;
}

export interface FactoryHelperExecution extends FactoryExecutionCustody {
  binding: FactoryHelperBinding;
}

export interface FactoryClaimAttempt extends FactoryBaseAttempt {
  controllerEpoch: number;
  scheduleId: string;
  occurrenceId: string;
  statusOperationId: string;
  publicationOperationId: string;
  schedulerRunId?: string;
  workflow?: FactoryWorkflowState;
  qualification?: FactoryQualificationBinding;
  baseRevision?: FactoryBaseRevision;
  executions: FactoryWorkerExecution[];
  helpers?: FactoryHelperExecution[];
}

export interface FactoryReleasedDelivery {
  repository: string;
  commit: string;
  draftNumber: number;
  draftUrl: string;
  mergeReceipt?: FactoryMergeReceipt;
}

export interface FactoryReleasedIdentity {
  attemptId: string;
  publicationOperationId: string;
  archiveSha256?: string;
  baseRevisionId?: string;
  delivery?: FactoryReleasedDelivery;
}

export interface FactoryReleasedSchedule {
  schedulerRunId: string;
  scheduleId: string;
  occurrenceId: string;
  issueNumber: number;
}

export interface FactoryLegacyReleasedSchedule {
  schedulerRunId?: never;
  scheduleId?: never;
  occurrenceId?: never;
  issueNumber?: never;
}

export type FactoryReleasedAttempt = FactoryReleasedIdentity &
  (FactoryReleasedSchedule | FactoryLegacyReleasedSchedule);

export interface FactoryClaimState {
  schemaVersion: 1;
  installationId: string;
  revision: number;
  active: FactoryClaimAttempt | null;
  lastReleased: FactoryReleasedAttempt | null;
  lastRetired?: FactoryRetirementReceipt;
}

export interface FactoryClaimInput {
  approval: FactoryApproval;
  approvalCommentId: number;
  scheduleId: string;
  occurrenceId: string;
  qualification?: FactoryQualificationBinding;
}

export interface FactorySelectedClaimInput extends FactoryAssignmentRecheck {
  scheduleId: string;
  occurrenceId: string;
}

export interface FactoryQualifiedClaimInput {
  qualification: FactoryQualificationBinding;
  verifyQualification(binding: FactoryQualificationBinding): Promise<FactoryQualifiedAssignment>;
  scheduleId: string;
  occurrenceId: string;
}

export interface FactorySettlementReader {
  /** Must verify genuine native receipt identity and throw while settlement is unknown. */
  (directory: string, identity: FactoryCustodyIdentity): Promise<unknown>;
}

export interface FactoryClaimEvidenceVerifier {
  (attempt: FactoryClaimAttempt): Promise<boolean>;
}

/** All writers require the retained exclusive owner; asynchronous controller calls are serial.
 * Failed persistence can have committed. Reconcile the same retained operation, never blind replay.
 */
export class FactoryClaimJournal {
  constructor(authority: FactoryClaimAuthority, readSettlement: FactorySettlementReader);
  readonly path: string;
  readonly custodyRoot: string;
  initialize(): void;
  current(): FactoryClaimState;
  assertUnchanged(state: FactoryClaimState, message?: string): void;
  replace(
    previous: FactoryClaimState,
    active: FactoryClaimAttempt | null,
    lastReleased?: FactoryReleasedAttempt | null,
    lastRetired?: FactoryRetirementReceipt,
  ): void;
  claim(input: FactoryClaimInput): Promise<FactoryClaimAttempt>;
  claimSelected(input: FactorySelectedClaimInput): Promise<FactoryClaimAttempt>;
  claimQualified(input: FactoryQualifiedClaimInput): Promise<FactoryClaimAttempt>;
  bindScheduleRun(attemptId: string, runId: string): FactoryClaimAttempt;
  updateWorkflow(
    attemptId: string,
    previous: FactoryWorkflowState | null,
    workflow: FactoryWorkflowState,
  ): void;
  bindExecution(
    attemptId: string,
    custody: FactoryExecutionCustody,
    binding: FactoryWorkerBinding,
  ): Promise<void>;
  bindHelperExecution(
    attemptId: string,
    custody: FactoryExecutionCustody,
    binding: FactoryHelperBinding,
  ): Promise<void>;
  bindPreparationExecution(
    attemptId: string,
    custody: FactoryExecutionCustody,
    workspace: string,
  ): Promise<void>;
  reconcile(): Promise<"resume_required" | "clear">;
  release(attemptId: string, verifyDelivery: FactoryClaimEvidenceVerifier): Promise<void>;
  retireCompletedElsewhere(
    attemptId: string,
    completion: FactoryExternalCompletion,
    verifyCompletion: FactoryRetirementVerifier,
    verifyAccount: FactoryClaimEvidenceVerifier,
  ): Promise<FactoryExternalRetirement>;
  parkBlocked(
    attemptId: string,
    audit: FactoryParkingCompletion,
    verifyParking: FactoryRetirementVerifier,
    verifyAccount: FactoryClaimEvidenceVerifier,
  ): Promise<FactoryParkedRetirement>;
  retire(
    attemptId: string,
    reason: FactoryRetirementReceipt["reason"],
    completion: FactoryExternalCompletion | FactoryParkingCompletion,
    verifyCompletion: FactoryRetirementVerifier,
    verifyAccount: FactoryClaimEvidenceVerifier,
  ): Promise<FactoryRetirementReceipt>;
  verifyRetirement(
    receipt: FactoryRetirementReceipt,
    verifyCompletion: FactoryRetirementVerifier,
    verifyAccount: FactoryClaimEvidenceVerifier,
  ): Promise<boolean>;
}
