import { createHash, randomUUID } from "node:crypto";
import {
  MaintenanceServiceJobSchema,
  MaintenanceServiceEvidenceRecordSchema,
  type MaintenanceServiceJob,
  type MaintenanceServiceReservation,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  FileBootstrapRequestJournal,
  type LifecycleWriteAdmission,
} from "./coordinator-bootstrap-journal.js";
import { inspectMaintenanceServiceExecution } from "./coordinator-bootstrap-maintenance-service-binding.js";
import { inspectMaintenanceRecoveryExecution } from "./coordinator-bootstrap-maintenance-recovery-binding.js";
import type { MaintenanceServiceNativeEvidence } from "./maintenance/service-execution.js";

/** Consumes the existing queue reservation, never creates a second work ledger.
 * Admission must re-read the standing grant under this same lock. A lost return
 * after the durable write leaves effectIntent present and permits observation
 * only. No process or service effect occurs in this function. */
export function claimMaintenanceServiceEffect(input: {
  stateDirectory: string;
  requestId: string;
  expectedRevision: string;
  reservation: MaintenanceServiceReservation;
  plan: unknown;
  account: { uid: number; home: string };
  executor: unknown;
  evidence: MaintenanceServiceNativeEvidence;
  admission: LifecycleWriteAdmission;
}): MaintenanceServiceJob {
  const executor = BootstrapProcessIdentitySchema.parse(input.executor);
  if (executor.pid !== process.pid || executor.uid !== process.getuid?.())
    throw new BootstrapRequestConflict("Maintenance effect must belong to this native executor");
  const { assertCurrent, evidenceSha256, ...value } = input.evidence;
  const record = MaintenanceServiceEvidenceRecordSchema.parse(value);
  const sha256 = createHash("sha256").update(JSON.stringify(record)).digest("hex");
  if (
    sha256 !== evidenceSha256 ||
    typeof assertCurrent !== "function" ||
    typeof input.admission !== "function"
  )
    throw new BootstrapRequestConflict("Maintenance effect requires independent native admission");
  const journal = new FileBootstrapRequestJournal(input.stateDirectory);
  let claimed: MaintenanceServiceJob | undefined;
  journal.mutateLifecycle((jobs) => {
    const retained = jobs.find((job) => job.id === input.requestId);
    if (!retained || retained.revision !== input.expectedRevision)
      throw new BootstrapRequestConflict("Maintenance effect request revision changed");
    const job = MaintenanceServiceJobSchema.parse(retained);
    const inspect =
      job.operation === "replacement"
        ? inspectMaintenanceServiceExecution
        : inspectMaintenanceRecoveryExecution;
    const inspected = inspect({
      retained,
      reservation: input.reservation,
      plan: input.plan,
      account: input.account,
    });
    const selected = "selected" in inspected ? inspected.selected : inspected.plan.candidate;
    const age = Date.now() - Date.parse(record.observedAt);
    if (
      record.requestId !== retained.id ||
      record.requestRevision !== retained.revision ||
      record.planSha256 !== inspected.planSha256 ||
      record.identitySha256 !== inspected.identitySha256 ||
      record.sourceCommit !== selected.sourceCommit ||
      record.artifactSha256 !== selected.artifactSha256 ||
      record.native.bootId !== executor.bootId ||
      age < 0 ||
      age >= 30_000 ||
      assertCurrent() !== undefined
    )
      throw new BootstrapRequestConflict("Maintenance effect native evidence changed");
    claimed = MaintenanceServiceJobSchema.parse({
      ...job,
      revision: randomUUID(),
      effectIntent: {
        id: randomUUID(),
        generation: input.reservation.generation,
        requestRevision: input.reservation.requestRevision,
        nativeEvidenceSha256: sha256,
        executor,
        consumedAt: new Date().toISOString(),
      },
      evidence: [...job.evidence, { sha256, record }],
    });
    const next = claimed;
    return jobs.map((item) => (item.id === next.id ? next : item));
  }, input.admission);
  if (!claimed) throw new BootstrapRequestConflict("Maintenance effect was not retained");
  return claimed;
}
