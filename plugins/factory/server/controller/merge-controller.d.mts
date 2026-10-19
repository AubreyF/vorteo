import type { githubRequest } from "./github-transport.mjs";
import type { FactoryRecordAuthority } from "./qualification-journal.mjs";

export interface FactoryMergeCandidate {
  number: number;
  commit: string;
  branch: string;
  operationId: string;
  publicationOperationId: string;
}

export interface FactoryMergeReceipt {
  repository: string;
  number: number;
  head: string;
  mergeCommit: string;
  mergedAt: string;
  url: string;
}

export interface FactoryMergePullIdentity {
  number: number;
  head: string;
  branch: string;
  repository: string;
  base: string;
  title: string;
  body: string;
}

export interface FactoryMergeIntent {
  baseCommit: string;
  pull: FactoryMergePullIdentity;
  checksSha256: string;
  rulesSha256: string;
}

export interface FactoryMergeRecordCandidate extends FactoryMergeCandidate {
  repository: string;
}

export interface FactoryMergeState {
  candidate: FactoryMergeRecordCandidate;
  intent: FactoryMergeIntent | null;
  receipt: FactoryMergeReceipt | null;
}

export interface FactoryMergeJournal {
  read(): Promise<FactoryMergeState | null>;
  write(value: FactoryMergeState): Promise<void>;
}

export interface FactoryMergeRequiredCheck {
  name: string;
  appId: number;
}

export interface FactoryMergeCheckFailure {
  head: string;
  checkId: number;
  name: string;
  appId: number | null;
  conclusion: string;
}

export interface FactoryMergeBaseRepair {
  head: string;
  base: string;
}

export interface FactoryMergedOutcome {
  kind: "merged";
  receipt: FactoryMergeReceipt;
}

export interface FactoryMergeWaitingOutcome {
  kind: "waiting";
  reason: string;
}

export interface FactoryMergeHeldOutcome {
  kind: "held";
  reason: string;
  evidence?: FactoryMergeCheckFailure;
}

export interface FactoryMergeRepairOutcome {
  kind: "repair_required";
  reason: string;
  evidence: FactoryMergeCheckFailure | FactoryMergeBaseRepair;
}

export type FactoryMergeOutcome =
  | FactoryMergedOutcome
  | FactoryMergeWaitingOutcome
  | FactoryMergeHeldOutcome
  | FactoryMergeRepairOutcome;

export interface FactoryMergeControllerOptions {
  authority: FactoryRecordAuthority;
  repository: string;
  ownerId: number;
  requiredChecks: FactoryMergeRequiredCheck[];
  authorize(candidate: FactoryMergeCandidate): Promise<boolean>;
  verifyCandidate(candidate: FactoryMergeCandidate): Promise<boolean>;
  promote(candidate: FactoryMergeCandidate): Promise<void>;
  journal: FactoryMergeJournal;
  signal?: AbortSignal;
  request?: typeof githubRequest;
}

export interface FactoryMergeVerificationOptions {
  receipt: FactoryMergeReceipt;
  assertCurrent(): void;
  request?: typeof githubRequest;
}

export interface FactoryMergeWorkflowOperation {
  id: string;
  kind: string;
  mergeState?: FactoryMergeState;
}

export interface FactoryMergeClaimWorkflow {
  phase: string;
  operation: FactoryMergeWorkflowOperation | null;
}

export interface FactoryMergeClaimActive {
  attemptId: string;
  workflow?: FactoryMergeClaimWorkflow | null;
}

export interface FactoryMergeClaimState {
  active: FactoryMergeClaimActive | null;
}

export interface FactoryMergeClaimPort<State extends FactoryMergeClaimState> {
  current(): State;
  replace(previous: State, nextActive: State["active"]): void;
}

export interface FactoryClaimMergeJournalOptions<State extends FactoryMergeClaimState> {
  claims: FactoryMergeClaimPort<State>;
  attemptId: string;
  operationId: string;
}

export function assertFactoryMergeReceipt(value: unknown): asserts value is FactoryMergeReceipt;

export function verifyFactoryMergedReceipt(input: FactoryMergeVerificationOptions): Promise<true>;

export function createClaimMergeJournal<State extends FactoryMergeClaimState>(
  input: FactoryClaimMergeJournalOptions<State>,
): FactoryMergeJournal;

export function createFactoryMergeController(
  input: FactoryMergeControllerOptions,
): (candidate: FactoryMergeCandidate) => Promise<FactoryMergeOutcome>;
