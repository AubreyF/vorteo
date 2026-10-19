import type {
  FactoryClaimJournal,
  FactoryClaimAttempt,
  FactoryExecutionCustody,
  FactoryReleasedAttempt,
} from "./claim-journal.mjs";
import type { FactoryRecordAuthority } from "./qualification-journal.mjs";
import type { FactoryQualifiedVerifier } from "./qualified-assignment.mjs";
import type {
  FactoryWorkflowPolicy,
  FactoryWorkflowConfig,
  FactoryWorkflowReview,
  FactoryWorkflowValidation,
} from "./workflow.mjs";
import type { githubRequest } from "./github-transport.mjs";

export interface FactoryDeliveryConfig extends FactoryWorkflowConfig {
  baseBranch: string;
}
export interface FactoryDeliveryPolicy extends FactoryWorkflowPolicy {
  config: FactoryDeliveryConfig;
}
export interface FactoryDeliveryProgress {
  stage: "working" | "reviewing" | "draft published" | "blocked";
  commit?: string;
  branch?: string;
  pr?: string;
  message?: string;
}
export interface FactoryDeliveryComment {
  id: number;
  url: string;
}
export interface FactoryDeliveryPullHead {
  sha: string;
  ref: string;
  repo: { full_name: string };
}
export interface FactoryDeliveryPull {
  number: number;
  html_url: string;
  user: { id: number };
  state: "open" | "closed";
  draft: boolean;
  auto_merge: unknown;
  title: string;
  body: string;
  head: FactoryDeliveryPullHead;
  base: { ref: string };
  merged?: unknown;
}
export interface FactoryDeliveryCandidate {
  number: number;
  commit: string;
}
export interface FactoryDeliveryNativePublication {
  attemptId: string;
  operationId: string;
  repository: string;
  commit: string;
  expectedBase: string;
  title: string;
  body: string;
  branch: string;
  base: string;
  draft: boolean;
  expectedRemote: string;
  signal?: AbortSignal;
  assertCurrent(): void;
  verifyRemote(): Promise<void>;
  /** The trusted native helper retains custody before launching. */
  retainHelper(custody: FactoryExecutionCustody, workspace: string): Promise<void>;
}
export interface FactoryDeliveryNativeCheckpoint extends Omit<
  FactoryDeliveryNativePublication,
  "body" | "draft" | "expectedRemote" | "verifyRemote"
> {}
export interface FactoryDeliveryPublisher {
  (input: FactoryDeliveryNativePublication): Promise<unknown>;
}
export interface FactoryDeliveryCheckpointPublisher {
  (input: FactoryDeliveryNativeCheckpoint): Promise<unknown>;
}
export interface FactoryDeliveryOptions {
  authority: FactoryRecordAuthority;
  claims: Pick<FactoryClaimJournal, "current" | "reconcile" | "bindHelperExecution">;
  policy: FactoryDeliveryPolicy;
  ownerId: number;
  request?: typeof githubRequest;
  publish?: FactoryDeliveryPublisher;
  checkpointPublisher?: FactoryDeliveryCheckpointPublisher;
  /** Required whenever the retained claim carries standing qualification. */
  verifyQualified?: FactoryQualifiedVerifier["ongoing"];
}
export interface FactoryDraftPublication {
  attempt: FactoryClaimAttempt;
  commit: string;
  title: string;
  summary: string;
  review: FactoryWorkflowReview;
  validations: FactoryWorkflowValidation[];
  signal?: AbortSignal;
}
export interface FactoryDeliveryPromotion {
  attempt: FactoryClaimAttempt;
  candidate: FactoryDeliveryCandidate;
  signal?: AbortSignal;
}
export interface FactoryDeliveryCheckpoint {
  attempt: FactoryClaimAttempt;
  commit: string;
  signal?: AbortSignal;
}
export interface FactoryGitHubDelivery {
  writeProgress(
    attempt: FactoryClaimAttempt,
    progress: FactoryDeliveryProgress,
  ): Promise<FactoryDeliveryComment>;
  branch(attempt: FactoryClaimAttempt): string;
  findOwnedPull(
    attempt: FactoryClaimAttempt,
    allowMerged?: boolean,
  ): Promise<FactoryDeliveryPull | null>;
  findDraft(attempt: FactoryClaimAttempt, commit: string): Promise<FactoryDeliveryPull | null>;
  publishDraft(input: FactoryDraftPublication): Promise<FactoryDeliveryPull>;
  verifyPublication(
    attempt: FactoryClaimAttempt,
    candidate: FactoryDeliveryCandidate,
  ): Promise<FactoryDeliveryPull>;
  promoteReviewed(input: FactoryDeliveryPromotion): Promise<FactoryDeliveryPull>;
  verifyRemoteCheckpoint(attempt: FactoryClaimAttempt, commit: string): Promise<true>;
  pushCheckpoint(input: FactoryDeliveryCheckpoint): Promise<string>;
}
export interface FactoryReleasedDeliveryVerifier {
  authority: FactoryRecordAuthority;
  claims: Pick<FactoryClaimJournal, "current">;
  receipt: FactoryReleasedAttempt;
  ownerId: number;
  baseBranch: string;
  request?: typeof githubRequest;
}
export function createFactoryGitHubDelivery(input: FactoryDeliveryOptions): FactoryGitHubDelivery;
export function verifyFactoryReleasedDelivery(
  input: FactoryReleasedDeliveryVerifier,
): Promise<string>;
export { githubRequest } from "./github-transport.mjs";
