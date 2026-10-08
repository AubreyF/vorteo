export interface DevReleaseStatus {
  lastSuccessfulAt: string | null;
  dueAt: string | null;
  due: boolean;
  state: "blocked" | "in-progress" | "due" | "current";
  active: { id: string; productCommit: string; phase: string } | null;
}

export interface DevReleaseInputs {
  repository: string;
  /** The producer independently verifies delivery; completedAt is publication time. */
  lastSuccess: unknown;
  active: unknown;
  now?: number;
}

export interface DevReleasePlanningInputs extends DevReleaseInputs {
  source: unknown;
  authorization: unknown;
  leadTimeMs?: number;
}

export type DevReleasePlan =
  | { kind: "reconcile"; status: DevReleaseStatus }
  | { kind: "wait"; status: DevReleaseStatus; requestAt: string }
  | { kind: "held"; status: DevReleaseStatus; reason: string }
  | { kind: "review"; status: DevReleaseStatus; requestAt: string | null; candidate: unknown }
  | {
      kind: "prepare";
      status: DevReleaseStatus;
      requestAt: string | null;
      candidate: {
        repository: string;
        channel: "dev";
        productCommit: string;
        validationReceiptSha256: string;
        authorityReference: string;
      };
    };

export function devReleaseStatus(input: DevReleaseInputs): DevReleaseStatus;
export function planDevRelease(input: DevReleasePlanningInputs): DevReleasePlan;
export function planDevSourceReview(input: DevReleasePlanningInputs): DevReleasePlan;
