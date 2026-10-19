import type {
  QualificationDecision,
  QualificationInputs,
  QualificationSnapshot,
} from "./qualification.mjs";
import type {
  FactoryPrivateRecord,
  FactoryRecordAuthority,
  QualificationPublicationState,
} from "./qualification-journal.mjs";
import type { githubRequest } from "./github-transport.mjs";

export interface QualificationPublicationGrantInput {
  repository: string;
  issueNumber: number;
  receiptSha256: string;
}

export interface QualificationPublicationReceipt {
  receiptSha256: string;
  commentId: number;
}

export interface QualificationPublisherPorts {
  authority: FactoryRecordAuthority;
  /** Installation verifies genuine execution/standing authority; a hash is not a grant. */
  authorize(input: QualificationPublicationGrantInput): Promise<boolean>;
  readInputs(snapshot: QualificationSnapshot): Promise<QualificationInputs>;
  request: typeof githubRequest;
  ownerId: number;
  readyLabel?: string;
  now?(): number;
}

export interface QualificationPublicationOptions extends QualificationPublisherPorts {
  decision: QualificationDecision;
  journal: FactoryPrivateRecord<QualificationPublicationState>;
}

export interface FactoryQualificationPublisherOptions extends QualificationPublisherPorts {
  root: string;
}

export function publishQualification(
  input: QualificationPublicationOptions,
): Promise<QualificationPublicationReceipt>;

export function createFactoryQualificationPublisher(
  input: FactoryQualificationPublisherOptions,
): (decision: QualificationDecision) => Promise<QualificationPublicationReceipt>;
