import type { RestartSummary } from "@getpaseo/protocol/execution-installation";
import type { NativeHelperJob } from "@getpaseo/protocol/native-helper-maintenance";

export type HelperReviewAction = "approve" | "cancel" | "verify-installed";

interface HelperReviewState {
  busy: boolean;
  unlocked: boolean;
}

type HelperReviewJob = Pick<NativeHelperJob, "status" | "stage">;

/** Shared by buttons and their explanations; cancellation remains available while preparing. */
export function helperActionDisabledReason(
  job: HelperReviewJob,
  action: HelperReviewAction,
  state: HelperReviewState,
): string | null {
  if (state.busy) return "Wait for the current action to finish, then refresh its result.";
  if (!state.unlocked) return "Unlock Installation controls to review this helper request.";
  if (action === "cancel") {
    if (job.status === "pending" || job.status === "approved") return null;
    return "This request has dispatched or finished. Inspect its result before preparing recovery.";
  }
  if (action === "verify-installed") {
    if (job.status === "failed" && job.stage === "recovery_required") return null;
    return "Verification is available only for an interrupted installation that needs recovery.";
  }
  if (job.status === "pending" && job.stage === "preparing")
    return "Artifact checks are still running. Approval becomes available when they pass.";
  if (job.status !== "pending" || job.stage !== "prepared")
    return "This request is no longer awaiting approval. Refresh its status and review any replacement request.";
  return null;
}

export function helperReviewSummary(
  job: Pick<NativeHelperJob, "operation" | "status" | "stage">,
): string {
  if (job.stage === "recovery_required")
    return "Helper installation needs recovery. Verify the installed helper before requesting another change.";
  if (job.stage === "recovered")
    return "The installed helper is verified. The earlier failure remains in history.";
  if (job.status === "running")
    return "Installing and verifying the approved helper. Host and Dev agents keep running.";
  if (job.status === "succeeded") return "The approved helper is installed and verified.";
  if (job.status === "rejected") return "Helper installation was canceled.";
  if (job.status === "failed")
    return "Preparation failed. Correct the artifact and submit a new request.";
  if (job.operation === "native-helper-rollback")
    return "Restore the reviewed helper release. Host and Dev agents keep running; browser permissions stay unchanged.";
  return "Install the reviewed helper. Host and Dev agents keep running; browser permissions stay unchanged.";
}

export function lockedMaintenanceSummary(summary: RestartSummary): string | null {
  const helper = summary.nativeHelper;
  const helperCount = helper
    ? helper.requested + helper.queued + helper.running + helper.recovery
    : 0;
  if (!summary.requested && !summary.queued && !summary.running && !helperCount) return null;
  let description = `${summary.requested} requested · ${summary.queued} queued · ${summary.running} restarting.`;
  if (helperCount) description += ` ${helperCount} helper maintenance requests need attention.`;
  return description + " Unlock controls to review details.";
}

export function helperRollbackSummary(plan: Pick<NativeHelperJob["plan"], "previous">): string {
  if (!plan.previous)
    return "First installation: no previous helper release is available for rollback.";
  return `Retained rollback source: ${plan.previous.sourceCommit}\nRollback artifact: ${plan.previous.artifactSha256}`;
}
