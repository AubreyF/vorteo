import type { MaintenanceServiceJob } from "@getpaseo/protocol/maintenance-service";
import type { MaintenanceServiceView } from "@getpaseo/protocol/maintenance-service-status";

export function maintenanceServiceView(job: MaintenanceServiceJob): MaintenanceServiceView {
  return {
    id: job.id,
    revision: job.revision,
    target: job.target,
    operation: job.operation,
    reason: job.reason,
    createdAt: job.createdAt,
    status: job.status,
    detail: job.detail,
    cancelable: !job.reservation && (job.status === "pending" || job.status === "approved"),
    dispatchAfter: job.approval?.dispatchAfter ?? null,
    generation: job.reservation?.generation ?? null,
    outcome: job.observation?.outcome ?? null,
    observedAt: job.observation?.observedAt ?? null,
  };
}
