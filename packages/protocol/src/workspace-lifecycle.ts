import type { ScheduleSummary } from "./schedule/types.js";

export interface WorkspaceArchiveProtection {
  protected?: boolean;
  scheduled?: boolean;
}

export const WORKSPACE_ARCHIVE_PROTECTED_MESSAGE = "Unprotect to archive";

export function workspaceArchiveBlockReason(
  workspace: WorkspaceArchiveProtection | null | undefined,
): string | null {
  if (workspace?.scheduled) {
    return workspace.protected
      ? "Unprotect and remove schedules to archive"
      : "Remove schedules to archive";
  }
  return workspace?.protected ? WORKSPACE_ARCHIVE_PROTECTED_MESSAGE : null;
}

export function isStandingSchedule(
  schedule: Pick<ScheduleSummary, "status" | "expiresAt">,
  now: number,
): boolean {
  return (
    schedule.status !== "completed" &&
    !(schedule.expiresAt !== null && Date.parse(schedule.expiresAt) <= now)
  );
}
