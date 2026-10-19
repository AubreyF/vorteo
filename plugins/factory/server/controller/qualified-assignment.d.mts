import type { QualificationDecision } from "./qualification.mjs";
import type { FactoryRecordAuthority } from "./qualification-journal.mjs";
import type { QualificationPublisherPorts } from "./qualification-publisher.mjs";
import type { FactoryApproval, FactoryQueuePolicy, FactoryQueueHold } from "./github-queue.mjs";
import type { githubRequest } from "./github-transport.mjs";

export interface FactoryIntakeSelection {
  issueNumber: number;
}
export interface FactoryIntakeSelectorOptions {
  authority: FactoryRecordAuthority;
  ownerId: number;
  excludedIssues?: number[];
  readyLabel?: string;
  request?: typeof githubRequest;
  now?(): number;
}
export interface FactoryQualificationBinding extends QualificationDecision {
  commentId: number;
}
export interface FactoryQualifiedIssue {
  issueNumber: number;
  qualification: FactoryQualificationBinding;
  approvedAt: string;
  priority: number;
}
export interface FactoryQualifiedQueue {
  eligible: FactoryQualifiedIssue[];
  held: FactoryQueueHold[];
}
export interface FactoryQualifiedAttempt {
  approval: FactoryApproval;
  approvalCommentId: number;
  qualification: FactoryQualificationBinding;
}
export interface FactoryQualifiedAssignment extends FactoryQualifiedAttempt {
  /** Original JSON needs validation by any consumer of additional GitHub fields. */
  issue: unknown;
  comments: unknown[];
}
export interface FactoryQualifiedVerifier {
  readQueue(): Promise<FactoryQualifiedQueue>;
  admit(binding: FactoryQualificationBinding): Promise<FactoryQualifiedAssignment>;
  ongoing(attempt: FactoryQualifiedAttempt): Promise<FactoryQualifiedAssignment>;
}
export interface FactoryQualifiedVerifierOptions extends Pick<
  QualificationPublisherPorts,
  "authority" | "ownerId" | "authorize" | "readInputs" | "now"
> {
  policy: FactoryQueuePolicy;
  excludedIssues?: number[];
  request?: typeof githubRequest;
}
export function createFactoryIntakeSelector(
  input: FactoryIntakeSelectorOptions,
): (policy: FactoryQueuePolicy) => Promise<FactoryIntakeSelection | null>;
export function createQualifiedAssignmentVerifier(
  input: FactoryQualifiedVerifierOptions,
): FactoryQualifiedVerifier;
