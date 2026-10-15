import type {
  MaintenanceServiceEvidenceRecord,
  MaintenanceServiceJob,
  MaintenanceServiceObservation,
  MaintenanceServiceReservation,
} from "@getpaseo/protocol/maintenance-service";

export interface MaintenanceServiceNativeEvidence extends MaintenanceServiceEvidenceRecord {
  evidenceSha256: string;
  /** Rechecks actual retained custody under the existing lifecycle lock. */
  assertCurrent(): void;
}

export interface MaintenanceServiceNativeObservation extends MaintenanceServiceObservation {
  /** Must hash to evidenceSha256. Unknown evidence never establishes readiness. */
  record: MaintenanceServiceEvidenceRecord;
  assertCurrent(): void;
}

/** Factory owns native execution. The visible existing queue owns approval,
 * cancellation and reservation. These ports create neither a worker nor a store. */
export interface MaintenanceServiceExecutor {
  inspect(request: MaintenanceServiceJob): Promise<MaintenanceServiceNativeEvidence>;
  /** Independently reads the matching retained reservation and consumes one
   * exclusive durable effect intent. Existing intent means observe only. */
  execute(
    request: MaintenanceServiceJob,
    reservation: MaintenanceServiceReservation,
  ): Promise<MaintenanceServiceNativeObservation>;
  observe(
    request: MaintenanceServiceJob,
    reservation: MaintenanceServiceReservation,
  ): Promise<MaintenanceServiceNativeObservation>;
}
