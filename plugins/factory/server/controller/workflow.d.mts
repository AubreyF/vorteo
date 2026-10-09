import type { FactoryApproval } from "./github-queue.mjs";
import type { QualificationIssue } from "./qualification.mjs";
import type { FactoryRecordAuthority } from "./qualification-journal.mjs";
import type {
  FactoryMergeReceipt,
  FactoryMergeState,
  FactoryMergeRepairOutcome,
} from "./merge-controller.mjs";

export type FactoryWorkflowPhase =
  | "implementation"
  | "checkpoint"
  | "validation"
  | "review"
  | "publication"
  | "release"
  | "blocked";

export type FactoryWorkflowStageKind = "implementation" | "repair" | "validation" | "review";
export type FactoryWorkflowOperationKind =
  | FactoryWorkflowStageKind
  | "checkpoint"
  | "publication"
  | "merge";

export interface FactoryValidationCommand {
  argv: string[];
  timeoutSeconds: number;
}

export interface FactoryWorkflowOperation {
  id: string;
  phase: FactoryWorkflowPhase;
  kind: string;
  mergeState?: FactoryMergeState;
}

export interface FactoryWorkflowValidation {
  commit: string;
  executionId: string;
  operationId: string;
  command: FactoryValidationCommand;
  exitCode: 0;
}

export interface FactoryWorkflowReview {
  commit: string;
  executionId: string;
  operationId: string;
  approved: boolean;
  findings: string[];
}

export interface FactoryWorkflowDraft {
  number: number;
  url: string;
  commit?: string;
  publicationSha256?: string;
  mergeReceipt?: FactoryMergeReceipt;
}

export interface FactoryWorkflowState {
  version: 1;
  phase: FactoryWorkflowPhase;
  repairAttempts: number;
  commit: string | null;
  validations: FactoryWorkflowValidation[];
  review: FactoryWorkflowReview | null;
  operation: FactoryWorkflowOperation | null;
  draft: FactoryWorkflowDraft | null;
  blocker: string | null;
}

export interface FactoryWorkflowExecution {
  identity: { executionId: string };
  binding: { stage: string; occurrenceId: string };
}

export interface FactoryWorkflowAttempt {
  attemptId: string;
  approval: FactoryApproval;
  occurrenceId: string;
  workflow?: FactoryWorkflowState | null;
  executions: FactoryWorkflowExecution[];
}

export interface FactoryWorkflowClaimState {
  active: FactoryWorkflowAttempt | null;
}

export interface FactoryWorkflowClaims {
  /** Reads must detach records; production mutations require retained exclusive ownership. */
  current(): FactoryWorkflowClaimState;
  updateWorkflow(
    attemptId: string,
    previous: FactoryWorkflowState | null,
    next: FactoryWorkflowState,
  ): void;
  /** Reject unsettled custody; the engine does not consume native reconciliation metadata. */
  reconcile(): Promise<unknown>;
  release(
    attemptId: string,
    verifyDelivery: (attempt: FactoryWorkflowAttempt) => Promise<boolean>,
  ): Promise<unknown>;
}

export interface FactoryWorkflowConfig {
  repository: string;
  maxRepairAttempts?: number;
  validation: FactoryValidationCommand[];
}

export interface FactoryWorkflowPolicy {
  trustedCommit: string;
  configSha256: string;
  config: FactoryWorkflowConfig;
}

export interface FactoryStageValidationResult {
  command?: FactoryValidationCommand;
  exitCode: number | null;
  timedOut: boolean;
  signal: string | null;
}

export interface FactoryWorkflowStageResult {
  validation?: FactoryStageValidationResult;
  finalText?: string;
}

export interface FactoryWorkflowStageOutcome {
  executionId: string;
  result: FactoryWorkflowStageResult;
}

export interface FactoryWorkflowStage {
  stop(reason: "manual"): Promise<void>;
  run(prompt: string): Promise<FactoryWorkflowStageOutcome>;
}

export interface FactoryWorkflowStageInput {
  kind: FactoryWorkflowStageKind;
  operation: FactoryWorkflowOperation;
  command?: FactoryValidationCommand;
  commit: string | null;
}

export interface FactoryWorkflowPublication {
  attempt: FactoryWorkflowAttempt;
  commit: string;
  review: FactoryWorkflowReview;
  validations: FactoryWorkflowValidation[];
  issue: QualificationIssue;
  operation: FactoryWorkflowOperation;
  signal: AbortSignal;
}

export interface FactoryWorkflowPublishedDraft {
  number: number;
  html_url: string;
  title?: string;
  body?: string;
}

export interface FactoryWorkflowMergeInput {
  attempt: FactoryWorkflowAttempt;
  state: FactoryWorkflowState;
  operation: FactoryWorkflowOperation;
  signal: AbortSignal;
}

export interface FactoryWorkflowMergedInput {
  attemptId: string;
  receipt: FactoryMergeReceipt;
}

export interface FactoryWorkflowOptions {
  authority: FactoryRecordAuthority;
  claims: FactoryWorkflowClaims;
  policy: FactoryWorkflowPolicy;
  attemptId: string;
  createStage(input: FactoryWorkflowStageInput): Promise<FactoryWorkflowStage>;
  checkpoint(
    attempt: FactoryWorkflowAttempt,
    operation: FactoryWorkflowOperation,
    signal: AbortSignal,
  ): Promise<string>;
  assertCheckpoint(commit: string): Promise<void>;
  publish(input: FactoryWorkflowPublication): Promise<FactoryWorkflowPublishedDraft>;
  verifyDelivery(attempt: FactoryWorkflowAttempt, state: FactoryWorkflowState): Promise<boolean>;
  merge?(
    input: FactoryWorkflowMergeInput,
  ): Promise<FactoryMergeReceipt | FactoryMergeRepairOutcome>;
  onMerged?(input: FactoryWorkflowMergedInput): Promise<void>;
  onBlocked?(attempt: FactoryWorkflowAttempt): Promise<unknown>;
  progress?(attempt: FactoryWorkflowAttempt, phase: FactoryWorkflowPhase): Promise<void>;
}

export interface FactoryWorkflowPublishedOutcome {
  kind: "published" | "merged";
  commit: string;
  draft: FactoryWorkflowDraft;
}

export interface FactoryWorkflowBlockedOutcome {
  kind: "blocked";
  reason: string | null;
}

export interface FactoryWorkflowParkedOutcome {
  kind: "parked";
  receipt: unknown;
}

export type FactoryWorkflowOutcome =
  | FactoryWorkflowPublishedOutcome
  | FactoryWorkflowBlockedOutcome
  | FactoryWorkflowParkedOutcome;

export type FactoryWorkflowRecoveryDecision = "retry" | "repeat" | "held";
export interface FactoryWorkflowReconciler {
  (
    operation: FactoryWorkflowOperation,
    attempt: FactoryWorkflowAttempt,
  ): Promise<FactoryWorkflowRecoveryDecision>;
}

export function initialFactoryWorkflow(): FactoryWorkflowState;
export function assertFactoryWorkflow(value: unknown): FactoryWorkflowState;

export class FactoryWorkflow {
  constructor(input: FactoryWorkflowOptions);
  helperAbort: AbortController;
  run(issue: QualificationIssue): Promise<FactoryWorkflowOutcome>;
  stop(): Promise<void>;
  recover(reconcileOperation: FactoryWorkflowReconciler): Promise<void>;
}
