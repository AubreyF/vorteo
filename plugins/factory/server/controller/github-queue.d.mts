import type { QualificationIssue } from "./qualification.mjs";

export interface FactoryQueueLabel {
  name: string;
}
export interface FactoryQueueIssue extends QualificationIssue {
  labels: FactoryQueueLabel[];
}
export interface FactoryQueueComment {
  id?: number;
  user?: { id: number };
  body?: string | null;
  created_at?: string;
  updated_at?: string;
}
export interface FactoryQueueDependency {
  state: "open" | "closed";
}
export interface FactoryQueueTimeline {
  event: string;
  source?: { issue?: { pull_request?: unknown } };
}
export interface FactoryQueueIssuePolicy {
  requiredLabels: string[];
  excludedLabels: string[];
  priorityLabels: string[];
}
export interface FactoryQueueConfig {
  repository: string;
  issues: FactoryQueueIssuePolicy;
}
export interface FactoryQueuePolicy {
  trustedCommit: string;
  configSha256: string;
  config: FactoryQueueConfig;
}
export interface FactoryApproval {
  schemaVersion: 1;
  action: "approve" | "revoke";
  repository: string;
  issueNumber: number;
  issueContentSha256: string;
  baseCommit: string;
  configSha256: string;
  host: "linux-container";
  delivery: "reviewed-draft-only";
  scope: string;
}
export interface FactoryApprovedComment extends FactoryQueueComment {
  id: number;
  user: { id: number };
  body: string;
  created_at: string;
}
export interface FactoryApprovalAccepted {
  reason?: never;
  approval: FactoryApproval;
  comment: FactoryApprovedComment;
}
export interface FactoryApprovalHeld {
  reason: string;
  approval?: never;
  comment?: never;
}
export type FactoryApprovalResult = FactoryApprovalAccepted | FactoryApprovalHeld;
export interface FactoryQueueHold {
  issueNumber: number;
  reason: string;
}
export interface FactoryApprovedIssue {
  issueNumber: number;
  title: string;
  body: string;
  approval: FactoryApproval;
  approvalCommentId: number;
  approvedAt: string;
  priority: number;
}
export interface FactoryApprovedQueue {
  eligible: FactoryApprovedIssue[];
  held: FactoryQueueHold[];
}
export interface FactoryApprovedQueueSelection {
  policy: FactoryQueuePolicy;
  ownerId: number;
  issues: FactoryQueueIssue[];
  commentsByIssue: Map<number, FactoryQueueComment[]>;
  dependenciesByIssue: Map<number, FactoryQueueDependency[]>;
  timelinesByIssue?: Map<number, FactoryQueueTimeline[]>;
  excludedIssues?: number[];
}
export interface FactoryApprovedQueueReader {
  policy: FactoryQueuePolicy;
  ownerId: number;
  excludedIssues?: number[];
  api?(endpoint: string): Promise<unknown>;
}
export interface FactoryAssignmentRecheck extends FactoryApprovedQueueReader {
  selected: FactoryApprovedIssue;
  readIssue?(endpoint: string): Promise<unknown>;
}

export function issueContentDigest(issue: Pick<QualificationIssue, "title" | "body">): string;
export function approvalComment(record: unknown): string;
export function approvalFor(
  issue: Pick<QualificationIssue, "number">,
  comments: FactoryQueueComment[],
  ownerId: number,
): FactoryApprovalResult;
/** Compatibility path for genuine owner comments; labels alone never grant authority. */
export function selectApprovedIssues(input: FactoryApprovedQueueSelection): FactoryApprovedQueue;
export function readApprovedFactoryQueue(
  input: FactoryApprovedQueueReader,
): Promise<FactoryApprovedQueue>;
export function recheckFactoryAssignment(
  input: FactoryAssignmentRecheck,
): Promise<FactoryApprovedIssue>;
