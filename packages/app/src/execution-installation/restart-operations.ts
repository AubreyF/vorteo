import type { RestartJob } from "@getpaseo/protocol/execution-installation";

type PlanField =
  | "supervisorPlanSha256"
  | "factoryRuntimePlanSha256"
  | "engineRestartPlanSha256"
  | "engineRecoveryPlanSha256"
  | "hostLauncherPlanSha256";

interface RestartOperationView {
  field: PlanField;
  /** What the restart replaces, in status lines and cards. Absent means the daemon. */
  target?: string;
  /** The card's target label when it differs from `target`. */
  cardTarget?: string;
  /** The finish-turns button, when it differs from "Finish turns and restart". */
  finishLabel?: string;
  /** Review text shown with the exact plan digest. */
  detail(sha256: string): string;
}

/** Reviewed plan-bound restart operations, matching the coordinator's registry. */
export const RESTART_OPERATION_VIEWS: readonly RestartOperationView[] = [
  {
    field: "supervisorPlanSha256",
    target: "Dev supervisor",
    detail: (sha256) => `Reviewed supervisor plan: ${sha256}`,
  },
  {
    field: "factoryRuntimePlanSha256",
    cardTarget: "Factory startup on Dev",
    finishLabel: "Finish turns and adopt Factory startup",
    detail: (sha256) =>
      `Select the reviewed Factory runtime and restart Dev. Existing Factory state is retained. Reviewed adoption plan: ${sha256}`,
  },
  {
    field: "engineRestartPlanSha256",
    target: "Docker for Dev",
    finishLabel: "Finish turns and restart Docker",
    detail: (sha256) =>
      `Restart Docker Desktop. Dev, its Tailscale and the private-domain gateway stop until Docker returns; each must come back under the same container. Reviewed plan: ${sha256}`,
  },
  {
    field: "engineRecoveryPlanSha256",
    target: "Degraded Docker engine",
    detail: (sha256) =>
      `Restart Docker Desktop once even though current work cannot be inspected. Volatile Dev work may be interrupted. Retained containers, paused Factory custody and authenticated readiness must verify afterward. No automatic retry. Reviewed recovery plan: ${sha256}`,
  },
  {
    field: "hostLauncherPlanSha256",
    target: "Host launcher",
    finishLabel: "Finish turns and update the Host launcher",
    detail: (sha256) =>
      `Add the managed release link and root to the Host launch settings and restart the whole Host once, so later restarts always load the selected build. The previous settings are kept and restored if the check fails. Reviewed plan: ${sha256}`,
  },
];

/** The single reviewed operation a job is bound to, if any. */
export function restartOperationView(job: RestartJob): RestartOperationView | undefined {
  return RESTART_OPERATION_VIEWS.find((view) => job[view.field]);
}

/** The exact plan digests a decision must name, one per bound operation. */
export function restartPlanBindings(job: RestartJob): Partial<Record<PlanField, string>> {
  const bindings: Partial<Record<PlanField, string>> = {};
  for (const view of RESTART_OPERATION_VIEWS) {
    const sha256 = job[view.field];
    if (sha256) bindings[view.field] = sha256;
  }
  return bindings;
}
