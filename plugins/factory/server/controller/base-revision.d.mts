import type { FactoryApproval } from "./github-queue.mjs";
import type { FactoryWorkflowState } from "./workflow.mjs";

export interface FactoryBaseRevisionPrevious {
  approval: FactoryApproval;
  approvalCommentId: number;
  workflow: FactoryWorkflowState;
  executionsCount: number;
  executionsSha256: string;
  helpersCount: number;
  helpersSha256: string;
}

export interface FactoryBaseRevision {
  version: 1;
  id: string;
  receiptSha256: string;
  previous: FactoryBaseRevisionPrevious;
}

export interface FactoryBaseAttempt {
  attemptId: string;
  schedulerRunId?: string | null;
  approval: FactoryApproval;
  approvalCommentId: number;
  workflow?: FactoryWorkflowState | null;
  executions: unknown[];
  helpers?: unknown[];
  baseRevision?: FactoryBaseRevision;
}

export interface FactoryBaseRevisionInput {
  id: string;
  receiptSha256: string;
  approval: FactoryApproval;
  approvalCommentId: number;
}

export type FactoryRevisedAttempt<Attempt extends FactoryBaseAttempt> = Omit<
  Attempt,
  "workflow" | "baseRevision"
> & { baseRevision: FactoryBaseRevision };

/** Consistency validation only. The receipt is not an owner or settlement grant. */
export function assertFactoryBaseRevision(attempt: FactoryBaseAttempt): void;
/** Caller first verifies stopped ownership, pristine delivery and native settlement. */
export function createPristineBaseRevision<Attempt extends FactoryBaseAttempt>(
  attempt: Attempt,
  input: FactoryBaseRevisionInput,
): FactoryRevisedAttempt<Attempt>;
export function factoryPreparationKey(attempt: FactoryBaseAttempt): string;
export function factoryPreparationOperationId(attempt: FactoryBaseAttempt): string;
export function factoryPublicationBranch(
  attemptId: string,
  issueNumber: number,
  revisionId?: string,
): string;
export function hasOnlyPriorRevisionExecutions(attempt: FactoryBaseAttempt): boolean;
