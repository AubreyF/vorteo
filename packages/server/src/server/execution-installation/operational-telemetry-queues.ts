import type { LifecycleJob } from "./lifecycle-journal.js";
import type { OperationalQueueObservation } from "./operational-telemetry-record.js";

/** Reads the coordinator's existing state only; never reconciles or reads a journal. */
export function summarizeOperationalQueues(
  jobs: readonly LifecycleJob[],
): OperationalQueueObservation {
  const result: OperationalQueueObservation = {
    hostPending: 0,
    hostRunning: 0,
    devPending: 0,
    devRunning: 0,
    sourceUpdatesRunning: 0,
    maintenancePending: 0,
    maintenanceRunning: 0,
  };
  for (const job of jobs) {
    const pending = job.status === "pending" || job.status === "approved";
    const running = job.status === "running";
    if (job.target === "host" || job.target === "container-daemon") {
      if (job.target === "host") {
        if (pending) result.hostPending++;
        if (running) result.hostRunning++;
      } else {
        if (pending) result.devPending++;
        if (running) result.devRunning++;
      }
      const active = pending || running;
      const preparing = active && job.sourceBatch?.status === "preparing";
      const installing = running && Boolean(job.update || job.sourceBatch);
      if (preparing || installing) result.sourceUpdatesRunning++;
    } else {
      if (pending) result.maintenancePending++;
      if (running) result.maintenanceRunning++;
    }
  }
  return result;
}
