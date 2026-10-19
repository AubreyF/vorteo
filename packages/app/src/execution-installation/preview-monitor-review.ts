import type { PreviewMonitorJob } from "@getpaseo/protocol/preview-monitor-maintenance";
export type MonitorAction = "approve" | "cancel";
export function monitorActionDisabledReason(
  job: Pick<PreviewMonitorJob, "status" | "stage">,
  action: MonitorAction,
  state: { busy: boolean; unlocked: boolean },
): string | null {
  if (state.busy) return "Wait for the current action, then refresh its result.";
  if (!state.unlocked) return "Unlock Installation controls to review this monitor request.";
  if (action === "cancel")
    return ["pending", "approved"].includes(job.status)
      ? null
      : "This request has dispatched or finished. Inspect its receipt.";
  return job.status === "pending" && job.stage === "prepared"
    ? null
    : "Approval requires the current prepared monitor request.";
}
export function monitorReviewSummary(job: Pick<PreviewMonitorJob, "status" | "stage">): string {
  if (job.stage === "recovery_required")
    return "Monitor outcome needs inspection. Retained bytes and receipt remain available. Never replay or roll back automatically.";
  if (job.status === "succeeded") return "The approved preview monitor is replaced and verified.";
  if (job.status === "running")
    return "Replacing and verifying the approved preview monitor. Host and Dev agents keep running.";
  if (job.status === "rejected") return "Preview monitor replacement canceled.";
  if (job.status === "failed")
    return "Preparation failed. Inspect the artifacts and prepare a new request.";
  return "Replace the Dev preview monitor with the reviewed bytes. Host and Dev agents keep running.";
}
