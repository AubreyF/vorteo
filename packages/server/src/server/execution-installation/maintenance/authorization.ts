import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  InstallationEnrollmentApprovalSchema,
  InstallationEnrollmentManifestSchema,
  InstallationEnrollmentStateSchema,
  StandingMaintenanceProposalSchema,
  type EnrollmentStepProgress,
  type EnrollmentTarget,
  type InstallationEnrollmentApproval,
  type InstallationEnrollmentManifest,
  type InstallationActivation,
  type InstallationEnrollmentState,
  type InstallationStandingGrant,
  type StandingMaintenanceProposal,
} from "@getpaseo/protocol/installation-enrollment";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";

const MAX_ENROLLMENT_BYTES = 1024 * 1024;

export interface EnrollmentWriteFiles {
  open(file: string, flags: number, mode?: number): number;
  write(descriptor: number, data: string): void;
  sync(descriptor: number): void;
  close(descriptor: number): void;
  rename(previous: string, next: string): void;
  remove(file: string): void;
}

export const enrollmentWriteFiles: EnrollmentWriteFiles = {
  open: openSync,
  write: writeFileSync,
  sync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  remove: unlinkSync,
};

export function enrollmentManifestDigest(value: unknown): string {
  const manifest = InstallationEnrollmentManifestSchema.parse(value);
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new BootstrapRequestConflict(`Enrollment contains duplicate ${label}`);
}

/** Schema parsing stays structural; relationships are checked at the admission boundary. */
export function validateEnrollmentManifest(value: unknown): InstallationEnrollmentManifest {
  const manifest = InstallationEnrollmentManifestSchema.parse(value);
  requireUnique(
    manifest.targets.map((target) => target.target),
    "targets",
  );
  requireUnique(
    manifest.steps.map((step) => step.id),
    "steps",
  );
  requireUnique(manifest.trustedRepositories, "source repositories");
  const targets = new Map(manifest.targets.map((target) => [target.target, target]));
  if (!targets.has("maintenance-controller") || !targets.has("recovery-launcher"))
    throw new BootstrapRequestConflict(
      "Enrollment must cover its controller and recovery launcher",
    );
  const services = manifest.targets.filter((target) =>
    ["host", "container-daemon", "coordinator", "supervisor"].includes(target.target),
  );
  if (!services.length)
    throw new BootstrapRequestConflict("Enrollment must include an installation service");
  for (const target of manifest.targets) requireUnique(target.operations, "target operations");
  for (const repository of manifest.trustedRepositories) {
    const url = new URL(repository);
    const safe =
      url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    if (!safe)
      throw new BootstrapRequestConflict(
        "Enrollment source must be a credential-free HTTPS repository",
      );
  }
  const preceding = new Set<string>();
  for (const step of manifest.steps) {
    const target = targets.get(step.target);
    if (!target?.operations.includes(step.operation))
      throw new BootstrapRequestConflict("Activation step exceeds its enrolled target scope");
    requireUnique(step.dependsOn, "step dependencies");
    if (step.dependsOn.some((dependency) => !preceding.has(dependency)))
      throw new BootstrapRequestConflict(
        "Activation dependencies must precede their dependent step",
      );
    if (step.operation === "rollback" && step.previous === null)
      throw new BootstrapRequestConflict(
        "Activation rollback requires a retained compatible runtime",
      );
    preceding.add(step.id);
  }
  validateProvisioning(manifest);
  return manifest;
}

function validateProvisioning(manifest: InstallationEnrollmentManifest): void {
  if (manifest.provisioning === null) return;
  const stepId = manifest.provisioning.coordinatorStepId;
  const coordinator = manifest.steps.find((step) => step.id === stepId);
  if (
    !coordinator ||
    coordinator.target !== "coordinator" ||
    coordinator.operation !== "replacement"
  )
    throw new BootstrapRequestConflict(
      "Provisioning must bind the exact coordinator replacement step",
    );
}

function validateState(value: unknown): InstallationEnrollmentState {
  const state = InstallationEnrollmentStateSchema.parse(value);
  if (state.status === "absent") return state;
  const manifest = validateEnrollmentManifest(state.grant.manifest);
  const digest = enrollmentManifestDigest(manifest);
  if (
    state.grant.approval.manifestSha256 !== digest ||
    state.activation.manifestSha256 !== digest ||
    state.activation.steps.length !== manifest.steps.length
  )
    throw new BootstrapRequestConflict("Retained enrollment differs from its exact approval");
  for (const [index, step] of state.activation.steps.entries()) {
    if (step.id !== manifest.steps[index].id)
      throw new BootstrapRequestConflict("Retained activation step ordering changed");
  }
  requireUnique(
    state.activation.recoveries.map((recovery) => recovery.id),
    "recovery observations",
  );
  requireUnique(
    state.activation.recoveries.map((recovery) => recovery.failed.id),
    "recovered steps",
  );
  for (const recovery of state.activation.recoveries) {
    const current = state.activation.steps.find((step) => step.id === recovery.failed.id);
    if (
      !current ||
      current.status !== "succeeded" ||
      current.generation !== recovery.failed.generation ||
      current.grantRevision !== recovery.failed.grantRevision ||
      current.reservedAt !== recovery.failed.reservedAt ||
      current.observationSha256 !== recovery.observationSha256 ||
      current.observedAt !== recovery.observedAt
    )
      throw new BootstrapRequestConflict(
        "Retained recovery observation differs from its activation step",
      );
  }
  requireUnique(state.grant.disabledTargets, "disabled targets");
  if (
    state.grant.disabledTargets.some(
      (target) => !manifest.targets.some((item) => item.target === target),
    )
  )
    throw new BootstrapRequestConflict("Retained revocation names an unenrolled target");
  return state;
}

/** The same protected kernel lock serializes enrollment with existing lifecycle writers.
 * Native effects never run inside this journal transaction. */
export class FileEnrollmentJournal {
  private readonly bootstrap: FileBootstrapRequestJournal;
  private readonly file: string;

  constructor(
    private readonly directory: string,
    private readonly files: EnrollmentWriteFiles = enrollmentWriteFiles,
  ) {
    this.bootstrap = new FileBootstrapRequestJournal(directory);
    this.file = path.join(directory, "maintenance-enrollment.json");
  }

  read(): InstallationEnrollmentState {
    return this.bootstrap.withRecoveryTransaction(() => this.load());
  }

  /** Caller must already hold the shared bootstrap lifecycle transaction.
   * This avoids nested flock acquisition; it supplies no dispatch authority by itself. */
  readUnderLifecycleLock(): InstallationEnrollmentState {
    return this.load();
  }

  update(operation: (current: InstallationEnrollmentState) => InstallationEnrollmentState) {
    return this.bootstrap.withRecoveryTransaction(() => {
      const current = this.load();
      const next = validateState(operation(structuredClone(current)));
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_ENROLLMENT_BYTES)
        throw new BootstrapRequestConflict("Enrollment exceeds its bounded storage size");
      if (!isDeepStrictEqual(current, next)) this.persist(next);
      else if (next.status === "enrolled") {
        // Reconcile uncertain directory synchronization before an idempotent success.
        this.syncSelection();
      }
      return structuredClone(next);
    });
  }

  private syncSelection(): void {
    for (const target of [this.file, this.directory]) {
      const descriptor = this.files.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        this.files.sync(descriptor);
      } finally {
        this.files.close(descriptor);
      }
    }
  }

  private persist(state: InstallationEnrollmentState): void {
    const temporary = path.join(this.directory, `.maintenance-enrollment-${randomUUID()}.json`);
    try {
      const descriptor = this.files.open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        this.files.write(descriptor, JSON.stringify(state));
        // Publish only fully synchronized contents. A power loss before the
        // directory sync may lose selection, but cannot select half a grant.
        this.files.sync(descriptor);
      } finally {
        this.files.close(descriptor);
      }
      this.files.rename(temporary, this.file);
      this.syncSelection();
    } catch (error) {
      try {
        this.files.remove(temporary);
      } catch (cleanup) {
        if (!(cleanup instanceof Error && "code" in cleanup && cleanup.code === "ENOENT"))
          throw cleanup;
      }
      throw error;
    }
  }

  private load(): InstallationEnrollmentState {
    let descriptor: number;
    try {
      descriptor = openSync(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { version: 1, status: "absent" };
      throw error;
    }
    try {
      const stat = fstatSync(descriptor);
      const owned = process.getuid && stat.uid === process.getuid();
      if (
        !owned ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > MAX_ENROLLMENT_BYTES
      )
        throw new BootstrapRequestConflict(
          "Enrollment storage must be a bounded private owned file",
        );
      return validateState(JSON.parse(readFileSync(descriptor, "utf8")));
    } finally {
      closeSync(descriptor);
    }
  }
}

interface EnrollmentInput {
  manifest: InstallationEnrollmentManifest;
  // Supplied by the separate authenticated enrollment review, never a legacy approval.
  approval: InstallationEnrollmentApproval;
}

export function enrollInstallation(journal: FileEnrollmentJournal, input: EnrollmentInput) {
  const manifest = validateEnrollmentManifest(input.manifest);
  const approval = InstallationEnrollmentApprovalSchema.parse(input.approval);
  const digest = enrollmentManifestDigest(manifest);
  if (approval.manifestSha256 !== digest || approval.reviewRevision !== manifest.revision)
    throw new BootstrapRequestConflict("Enrollment approval no longer matches its manifest");
  if (Date.parse(approval.approvedAt) < Date.parse(manifest.createdAt))
    throw new BootstrapRequestConflict("Enrollment approval predates its reviewed manifest");
  return journal.update((current) => {
    if (current.status === "enrolled") {
      if (
        !isDeepStrictEqual(current.grant.approval, approval) ||
        !isDeepStrictEqual(current.grant.manifest, manifest)
      )
        throw new BootstrapRequestConflict("Installation already has a different enrollment");
      return current;
    }
    return {
      version: 1,
      status: "enrolled",
      grant: {
        id: randomUUID(),
        revision: randomUUID(),
        approval,
        manifest,
        paused: false,
        disabledTargets: [],
        revokedAt: null,
      },
      activation: {
        id: randomUUID(),
        manifestSha256: digest,
        steps: manifest.steps.map((step) => ({ id: step.id, status: "pending" })),
        recoveries: [],
      },
    };
  });
}

function requireGrant(
  state: InstallationEnrollmentState,
  revision: string,
): InstallationStandingGrant {
  if (state.status !== "enrolled")
    throw new BootstrapRequestConflict("Installation enrollment is not active");
  if (state.grant.revision !== revision)
    throw new BootstrapRequestConflict("Standing authority changed; refresh its current revision");
  return state.grant;
}

function requireTarget(grant: InstallationStandingGrant, target: EnrollmentTarget) {
  if (grant.revokedAt || grant.paused || grant.disabledTargets.includes(target))
    throw new BootstrapRequestConflict("Standing maintenance authority is paused or revoked");
  const binding = grant.manifest.targets.find((item) => item.target === target);
  if (!binding) throw new BootstrapRequestConflict("Maintenance target is not enrolled");
  return binding;
}

interface GrantChange {
  expectedRevision: string;
  paused: boolean;
  disabledTargets: EnrollmentTarget[];
  revoke: boolean;
}

/** Explicit revocation is permanent for this enrollment; lost activation replies cannot undo it. */
export function changeStandingGrant(journal: FileEnrollmentJournal, change: GrantChange) {
  return journal.update((current) => {
    const grant = requireGrant(current, change.expectedRevision);
    if (current.status !== "enrolled") throw new BootstrapRequestConflict("Enrollment is absent");
    if (grant.revokedAt) throw new BootstrapRequestConflict("Enrollment has already been revoked");
    return {
      ...current,
      grant: {
        ...grant,
        revision: randomUUID(),
        paused: change.paused,
        disabledTargets: change.disabledTargets,
        revokedAt: change.revoke ? new Date().toISOString() : null,
      },
    };
  });
}

interface ActivationReservation {
  grantRevision: string;
  stepId: string;
}

/** Reservation is the dispatch boundary. An uncertain reservation is observed, never replayed. */
export function reserveActivationStep(
  journal: FileEnrollmentJournal,
  input: ActivationReservation,
) {
  return journal.update((current) => {
    const grant = requireGrant(current, input.grantRevision);
    if (current.status !== "enrolled") throw new BootstrapRequestConflict("Enrollment is absent");
    const plan = grant.manifest.steps.find((step) => step.id === input.stepId);
    if (!plan)
      throw new BootstrapRequestConflict("Activation step is not in the reviewed manifest");
    requireTarget(grant, plan.target);
    if (
      current.activation.steps.some(
        (step) => step.status === "reserved" || step.status === "recovery_required",
      )
    )
      throw new BootstrapRequestConflict(
        "An activation effect requires reconciliation before dispatch",
      );
    const step = current.activation.steps.find((item) => item.id === input.stepId);
    if (step?.status !== "pending")
      throw new BootstrapRequestConflict("Activation step has already been dispatched");
    const ready = plan.dependsOn.every((dependency) =>
      current.activation.steps.some(
        (item) => item.id === dependency && item.status === "succeeded",
      ),
    );
    if (!ready) throw new BootstrapRequestConflict("Activation prerequisites are not verified");
    const reserved: EnrollmentStepProgress = {
      id: step.id,
      status: "reserved",
      generation: randomUUID(),
      grantRevision: grant.revision,
      reservedAt: new Date().toISOString(),
    };
    return {
      ...current,
      activation: {
        ...current.activation,
        steps: current.activation.steps.map((item) => (item.id === step.id ? reserved : item)),
      },
    };
  });
}

interface ActivationObservation {
  stepId: string;
  generation: string;
  outcome: "succeeded" | "recovery_required";
  observationSha256: string;
}

/** A verified observation may settle a dispatched effect after revocation, but grants no new work. */
export function observeActivationStep(
  journal: FileEnrollmentJournal,
  input: ActivationObservation,
) {
  return journal.update((current) => {
    if (current.status !== "enrolled") throw new BootstrapRequestConflict("Enrollment is absent");
    const step = current.activation.steps.find((item) => item.id === input.stepId);
    if (!step || step.status === "pending" || step.generation !== input.generation)
      throw new BootstrapRequestConflict("Activation observation does not match its dispatch");
    if (step.status !== "reserved") {
      if (step.status === input.outcome && step.observationSha256 === input.observationSha256)
        return current;
      throw new BootstrapRequestConflict("Activation result is already retained");
    }
    const observed: EnrollmentStepProgress = {
      ...step,
      status: input.outcome,
      observedAt: new Date().toISOString(),
      observationSha256: input.observationSha256,
    };
    return {
      ...current,
      activation: {
        ...current.activation,
        steps: current.activation.steps.map((item) => (item.id === step.id ? observed : item)),
      },
    };
  });
}

interface ActivationRecoveryObservation {
  id: string;
  stepId: string;
  generation: string;
  failedObservationSha256: string;
  observationSha256: string;
}

/** Only an independently verified candidate-readiness receipt completes recovery.
 * Preserve the failed generation verbatim; never return it to a replayable state. */
export function reconcileActivationStep(
  journal: FileEnrollmentJournal,
  input: ActivationRecoveryObservation,
) {
  return journal.update((current) => {
    if (current.status !== "enrolled") throw new BootstrapRequestConflict("Enrollment is absent");
    const retained = current.activation.recoveries.find((recovery) => recovery.id === input.id);
    if (retained) {
      const identical =
        retained.failed.id === input.stepId &&
        retained.failed.generation === input.generation &&
        retained.failed.observationSha256 === input.failedObservationSha256 &&
        retained.observationSha256 === input.observationSha256;
      if (!identical) throw new BootstrapRequestConflict("Recovery receipt identity changed");
      return current;
    }
    const failed = current.activation.steps.find((step) => step.id === input.stepId);
    if (
      !failed ||
      failed.status !== "recovery_required" ||
      failed.generation !== input.generation ||
      failed.observationSha256 !== input.failedObservationSha256
    )
      throw new BootstrapRequestConflict(
        "Recovery observation does not match the failed generation",
      );
    const observedAt = new Date().toISOString();
    const recovery: InstallationActivation["recoveries"][number] = {
      id: input.id,
      failed: { ...failed, status: "recovery_required" },
      observedAt,
      observationSha256: input.observationSha256,
    };
    const succeeded: EnrollmentStepProgress = {
      ...failed,
      status: "succeeded",
      observedAt,
      observationSha256: input.observationSha256,
    };
    return {
      ...current,
      activation: {
        ...current.activation,
        steps: current.activation.steps.map((step) => (step.id === failed.id ? succeeded : step)),
        recoveries: [...current.activation.recoveries, recovery],
      },
    };
  });
}

/** Policy evaluation only: dispatch must reread current authority under lifecycle exclusion.
 * Host validation supplies the proposal's exact bytes and target evidence separately.
 * Dev provenance is retained; this function never converts Dev into a Host requester. */
export function evaluateStandingProposal(input: {
  state: InstallationEnrollmentState;
  grantRevision: string;
  proposal: StandingMaintenanceProposal;
}) {
  const state = validateState(input.state);
  const grant = requireGrant(state, input.grantRevision);
  const proposal = StandingMaintenanceProposalSchema.parse(input.proposal);
  const target = requireTarget(grant, proposal.target);
  if (
    proposal.installationId !== grant.manifest.installationId ||
    proposal.identitySha256 !== target.identitySha256 ||
    !target.operations.includes(proposal.operation) ||
    !grant.manifest.trustedRepositories.includes(proposal.repository)
  )
    throw new BootstrapRequestConflict("Maintenance proposal exceeds its enrolled authority");
  return {
    grantId: grant.id,
    grantRevision: grant.revision,
    proposal: structuredClone(proposal),
    proposalSha256: createHash("sha256").update(JSON.stringify(proposal)).digest("hex"),
  };
}
