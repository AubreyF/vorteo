export type QualificationCriterion =
  | "outcome"
  | "scope"
  | "acceptance"
  | "verification"
  | "dependencies"
  | "duplicates"
  | "ownership"
  | "authority";
export interface CriterionAssessment {
  verdict: "pass" | "blocked" | "unknown";
  reason: string;
  evidence: string[];
}
export interface QualificationAssessment {
  issueNumber: number;
  decision: "ready" | "needs-information" | "blocked" | "duplicate" | "out-of-scope";
  summary: string;
  criteria: Record<QualificationCriterion, CriterionAssessment>;
}
export interface QualificationDependency {
  repository: string;
  number: number;
  state: "open" | "closed";
}
export interface QualificationPull {
  number: number;
  state: "open" | "closed";
  head: string;
}
export interface QualificationSource {
  path: string;
  blob: string | null;
}
export interface QualificationEvidence {
  id: string;
  sha256: string;
}
export interface QualificationAssignee {
  id: number;
}
export interface QualificationIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  assignees: QualificationAssignee[];
  pull_request?: unknown;
}
export interface QualificationInputs {
  repository: string;
  policySha256: string;
  permitted: boolean;
  issue: QualificationIssue;
  dependencies: QualificationDependency[];
  relatedPulls: QualificationPull[];
  sourceInputs: QualificationSource[];
  evidence: QualificationEvidence[];
}
export interface QualificationSnapshot extends Omit<QualificationInputs, "issue"> {
  issue: Omit<QualificationIssue, "body" | "assignees" | "pull_request"> & {
    body: string;
    assignees: number[];
  };
}
export interface QualificationReceipt {
  version: 1;
  executionId: string;
  reviewedAt: string;
  validUntil: string;
  inputSha256: string;
  snapshot: QualificationSnapshot;
  assessment: QualificationAssessment;
}
export interface QualificationDecision {
  receipt: QualificationReceipt;
  receiptSha256: string;
}
export interface QualificationPreparation {
  input: QualificationInputs;
  /** Model output is validated, never trusted as execution authority. */
  assessment: unknown;
  executionId: string;
  reviewedAt: string;
  validUntil: string;
}
export function qualificationSnapshot(input: QualificationInputs): QualificationSnapshot;
export function prepareQualification(input: QualificationPreparation): QualificationDecision;
export function assertQualificationCurrent(input: {
  receipt: unknown;
  receiptSha256: string;
  input: QualificationInputs;
  now?: number;
}): QualificationReceipt;
export function qualificationAuditBody(input: QualificationDecision): string;
