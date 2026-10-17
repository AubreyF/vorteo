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
  HostContinuationSchema,
  HostContinuationBindingSchema,
  HostRestorationEvidenceSchema,
  HostCandidateEvidenceSchema,
  type HostContinuation,
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
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  inspectInitialHostSupervisorMigrationPlan,
  InitialHostMigrationIntentSchema,
  InitialHostMigrationClaimSchema,
} from "./host-supervisor-contract.js";
import {
  classifyInitialHostPublication,
  type InitialHostRecoveryImage,
} from "./host-supervisor-recovery.js";

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
  validateHostContinuations(state);
  requireUnique(state.grant.disabledTargets, "disabled targets");
  if (
    state.grant.disabledTargets.some(
      (target) => !manifest.targets.some((item) => item.target === target),
    )
  )
    throw new BootstrapRequestConflict("Retained revocation names an unenrolled target");
  return state;
}

type EnrolledState = Extract<InstallationEnrollmentState, { status: "enrolled" }>;
type HostRole = "restoration" | "candidate";
type HostChild = HostContinuation["restoration"] | NonNullable<HostContinuation["candidate"]>;

function hostDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hostRequire(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(`Host continuation: ${message}`);
}

function hostChild(lineage: HostContinuation, role: HostRole): HostChild {
  const child = role === "restoration" ? lineage.restoration : lineage.candidate;
  hostRequire(child, "candidate is not reserved");
  return child;
}

function childReservation(child: HostChild) {
  return {
    generation: child.generation,
    grantRevision: child.grantRevision,
    reservedAt: child.reservedAt,
    evidence: child.evidence,
  };
}

/** Address of the one-use child claim, not proof of its native execution. */
export function hostContinuationReservationDigest(value: HostContinuation, role: HostRole): string {
  const lineage = HostContinuationSchema.parse(value);
  return hostDigest({
    stepId: lineage.stepId,
    binding: lineage.binding,
    original: lineage.original,
    role,
    reservation: childReservation(hostChild(lineage, role)),
  });
}

function candidateProgress(lineage: HostContinuation): EnrollmentStepProgress {
  const child = lineage.candidate;
  hostRequire(child, "candidate is not reserved");
  const reservation = {
    id: lineage.stepId,
    generation: child.generation,
    grantRevision: child.grantRevision,
    reservedAt: child.reservedAt,
  };
  if (!child.observation) return { ...reservation, status: "reserved" };
  return {
    ...reservation,
    status: child.observation.outcome === "candidate-ready" ? "succeeded" : "recovery_required",
    observedAt: child.observation.observedAt,
    observationSha256: child.observation.observationSha256,
  };
}

function validateHostChild(lineage: HostContinuation, role: HostRole) {
  const child = hostChild(lineage, role);
  if (child.claim) {
    hostRequire(
      child.claim.reservationSha256 === hostContinuationReservationDigest(lineage, role),
      "claim differs from its reservation",
    );
    hostRequire(
      Date.parse(child.claim.consumedAt) >= Date.parse(child.reservedAt),
      "claim predates reservation",
    );
  }
  if (child.observation) {
    hostRequire(child.claim, "observation has no consumed child");
    hostRequire(
      child.observation.outcome === "recovery_required" ||
        child.observation.outcome ===
          (role === "restoration" ? "legacy-restored" : "candidate-ready"),
      "observation names the wrong slot",
    );
    hostRequire(
      Date.parse(child.observation.observedAt) >= Date.parse(child.claim.consumedAt),
      "observation predates consumption",
    );
  }
}

function validateHostLineageBinding(state: EnrolledState, lineage: HostContinuation) {
  const step = state.grant.manifest.steps.find((item) => item.id === lineage.stepId);
  const target = state.grant.manifest.targets.find((item) => item.target === "host");
  hostRequire(
    step && step.target === "host" && step.operation === "replacement" && step.previous && target,
    "lineage is not an initial Host replacement",
  );
  hostRequire(
    lineage.original.failed.id === step.id &&
      lineage.original.grantId === state.grant.id &&
      lineage.original.manifestSha256 === state.activation.manifestSha256 &&
      lineage.binding.planSha256 === step.planSha256 &&
      lineage.binding.identitySha256 === target.identitySha256 &&
      isDeepStrictEqual(lineage.binding.candidate, step.candidate) &&
      isDeepStrictEqual(lineage.binding.previous, step.previous) &&
      isDeepStrictEqual(lineage.binding.interruption, state.grant.manifest.interruption),
    "retained reviewed binding changed",
  );
  hostRequire(
    !state.activation.recoveries.some((item) => item.failed.id === step.id),
    "ordinary recovery cannot coexist with a continuation",
  );
  return step;
}

function validateHostContinuations(state: EnrolledState) {
  const lineages = state.activation.hostContinuations ?? [];
  requireUnique(
    lineages.map((lineage) => lineage.stepId),
    "Host continuation steps",
  );
  const generations: string[] = [];
  for (const lineage of lineages) {
    const step = validateHostLineageBinding(state, lineage);
    generations.push(lineage.original.failed.generation, lineage.restoration.generation);
    const executors = [lineage.original.executorSha256];
    const claims = [lineage.original.claimSha256];
    for (const role of ["restoration", "candidate"] as const) {
      if (role === "candidate" && !lineage.candidate) continue;
      validateHostChild(lineage, role);
      const claim = hostChild(lineage, role).claim;
      if (claim) {
        executors.push(claim.executorSha256);
        claims.push(claim.claimSha256);
      }
    }
    requireUnique(executors, "Host child executor lifetimes");
    requireUnique(claims, "Host child claims");
    const current = state.activation.steps.find((item) => item.id === step.id);
    if (lineage.candidate) {
      const child = lineage.candidate;
      const restored = lineage.restoration.observation;
      hostRequire(
        restored?.outcome === "legacy-restored" &&
          child.evidence.restorationGeneration === lineage.restoration.generation &&
          child.evidence.restorationObservationSha256 === restored.observationSha256 &&
          child.evidence.restorationChildExitSha256 === restored.childExitSha256,
        "candidate has no exact settled restoration",
      );
      generations.push(child.generation);
      hostRequire(
        isDeepStrictEqual(current, candidateProgress(lineage)),
        "logical step differs from its active candidate",
      );
    } else
      hostRequire(
        isDeepStrictEqual(current, lineage.original.failed),
        "legacy restoration changed the failed logical step",
      );
  }
  requireUnique(generations, "Host continuation generations");
  const outstanding = unresolvedHostContinuations(state);
  if (outstanding.length) {
    hostRequire(outstanding.length === 1, "only one unresolved Host lineage may hold exclusion");
    const owner = outstanding[0].stepId;
    hostRequire(
      !state.activation.steps.some(
        (step) =>
          step.id !== owner && (step.status === "reserved" || step.status === "recovery_required"),
      ),
      "another activation conflicts with the unresolved Host child",
    );
  }
}

/** All unresolved children fence competitors, even if a caller inspects only a
 * logical step's status. The exception must identify the exact active lineage. */
export function unresolvedHostContinuations(state: InstallationEnrollmentState) {
  if (state.status !== "enrolled") return [];
  return (state.activation.hostContinuations ?? []).filter(
    (lineage) => lineage.candidate?.observation?.outcome !== "candidate-ready",
  );
}

export function assertHostContinuationExclusion(
  state: InstallationEnrollmentState,
  own?: { stepId: string; generation: string },
) {
  for (const lineage of unresolvedHostContinuations(state)) {
    const active = lineage.candidate ?? lineage.restoration;
    hostRequire(
      own && own.stepId === lineage.stepId && own.generation === active.generation,
      "an unresolved child retains lifecycle exclusion",
    );
  }
}

// Generic journal writers cannot create, erase or rewrite continuation history.
// Only this module's locked transitions may advance it; this is not native proof.
const hostMutations = new WeakSet<Function>();
function updateHost(
  journal: FileEnrollmentJournal,
  operation: (state: InstallationEnrollmentState) => InstallationEnrollmentState,
) {
  hostMutations.add(operation);
  try {
    return journal.update(operation);
  } finally {
    hostMutations.delete(operation);
  }
}

function guardHostChild(before: HostChild, after: HostChild) {
  hostRequire(
    isDeepStrictEqual(childReservation(before), childReservation(after)),
    "child reservation is immutable",
  );
  if (before.claim)
    hostRequire(isDeepStrictEqual(before.claim, after.claim), "child claim is immutable");
  if (before.observation)
    hostRequire(
      isDeepStrictEqual(before.observation, after.observation),
      "child result is immutable",
    );
}

function guardHostHistory(
  previous: InstallationEnrollmentState,
  next: InstallationEnrollmentState,
  permitted: boolean,
) {
  if (previous.status !== "enrolled") {
    hostRequire(
      next.status !== "enrolled" || !next.activation.hostContinuations?.length,
      "new enrollment cannot import continuation history",
    );
    return;
  }
  const retained = previous.activation.hostContinuations ?? [];
  if (!retained.length && next.status !== "enrolled") return;
  hostRequire(next.status === "enrolled", "retained enrollment cannot be erased");
  const proposed = next.activation.hostContinuations ?? [];
  if (!permitted) {
    hostRequire(isDeepStrictEqual(retained, proposed), "use the locked continuation transition");
    for (const item of retained)
      hostRequire(
        isDeepStrictEqual(
          previous.activation.steps.find((step) => step.id === item.stepId),
          next.activation.steps.find((step) => step.id === item.stepId),
        ),
        "ordinary observation is fenced by continuation reservation",
      );
    return;
  }
  hostRequire(proposed.length >= retained.length, "history cannot be removed");
  for (const [index, before] of retained.entries()) {
    const after = proposed[index];
    hostRequire(
      after &&
        before.stepId === after.stepId &&
        isDeepStrictEqual(before.binding, after.binding) &&
        isDeepStrictEqual(before.original, after.original),
      "original history is immutable",
    );
    for (const role of ["restoration", "candidate"] as const) {
      const oldChild = role === "restoration" ? before.restoration : before.candidate;
      if (!oldChild) continue;
      guardHostChild(oldChild, hostChild(after, role));
    }
  }
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

  /** Binds pure captured artifact addresses to this existing ledger namespace. */
  get stateDirectory(): string {
    return this.directory;
  }

  read(): InstallationEnrollmentState {
    return this.bootstrap.withRecoveryTransaction(() => this.load());
  }

  /** Atomic selection snapshot for policy evaluation only. Dispatch must reread
   * under shared lifecycle exclusion before its durable reservation. */
  readPolicySnapshot(): InstallationEnrollmentState {
    return this.load();
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
      guardHostHistory(current, next, hostMutations.has(operation));
      if (!isDeepStrictEqual(this.load(), current))
        throw new BootstrapRequestConflict(
          "Enrollment changed during locked custody; refresh current state",
        );
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
  /** Native launch owners recheck custody before the durable reservation. */
  assertCurrent?(): void;
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
    assertHostContinuationExclusion(current);
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
    if (input.assertCurrent && input.assertCurrent() !== undefined)
      throw new BootstrapRequestConflict("Activation reservation custody must be synchronous");
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
  /** Native observers recheck custody while the journal lock is held. */
  assertCurrent?(): void;
}

/** A verified observation may settle a dispatched effect after revocation, but grants no new work. */
export function observeActivationStep(
  journal: FileEnrollmentJournal,
  input: ActivationObservation,
) {
  return journal.update((current) => {
    if (current.status !== "enrolled") throw new BootstrapRequestConflict("Enrollment is absent");

    hostRequire(
      !current.activation.hostContinuations?.some((lineage) => lineage.stepId === input.stepId),
      "ordinary observation is fenced by continuation reservation",
    );
    if (input.assertCurrent && input.assertCurrent() !== undefined)
      throw new BootstrapRequestConflict("Activation observation custody must be synchronous");
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
  assertCurrent?(): void;
}

/** Only an independently verified candidate-readiness receipt completes recovery.
 * Preserve the failed generation verbatim; never return it to a replayable state. */
export function reconcileActivationStep(
  journal: FileEnrollmentJournal,
  input: ActivationRecoveryObservation,
) {
  return journal.update((current) => {
    if (current.status !== "enrolled") throw new BootstrapRequestConflict("Enrollment is absent");
    hostRequire(
      !current.activation.hostContinuations?.some((lineage) => lineage.stepId === input.stepId),
      "ordinary recovery is fenced by continuation reservation",
    );
    if (input.assertCurrent && input.assertCurrent() !== undefined)
      throw new BootstrapRequestConflict("Activation recovery custody must be synchronous");
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

export interface HostContinuationCustody {
  state: EnrolledState;
  plan: ReturnType<typeof inspectInitialHostSupervisorMigrationPlan>["plan"];
  lineage: HostContinuation;
  role: HostRole;
  child: HostChild;
  publication: ReturnType<typeof classifyInitialHostPublication> | null;
}

interface HostEffectPorts {
  /** Existing native owner verifies the exact retained proof/artifacts. No
   * production factory or native authority is supplied by this ledger. */
  assertCurrent(context: HostContinuationCustody): void;
  /** Required caller proof for the existing coordinator/restart/service stores,
   * invoked inside this journal's shared lifecycle lock. */
  assertExclusive(context: HostContinuationCustody): void;
}

function assertHostPublication(
  lineage: HostContinuation,
  publication: ReturnType<typeof classifyInitialHostPublication>,
) {
  const binding = publication.snapshot.binding;
  hostRequire(
    binding.stepId === lineage.stepId &&
      binding.generation === lineage.original.failed.generation &&
      binding.planSha256 === lineage.binding.planSha256 &&
      binding.intentSha256 === lineage.original.intentSha256 &&
      binding.claimSha256 === lineage.original.claimSha256 &&
      publication.snapshotSha256 === lineage.restoration.evidence.publicationSnapshotSha256,
    "classified publication differs from the exact failed claim or captured snapshot",
  );
}

function hostBinding(plan: HostContinuationCustody["plan"]) {
  return HostContinuationBindingSchema.parse({
    planSha256: hostDigest(plan),
    identitySha256: plan.identitySha256,
    candidate: {
      sourceCommit: plan.candidate.sourceCommit,
      artifactSha256: plan.candidate.artifactSha256,
    },
    previous: {
      sourceCommit: plan.fallback.sourceCommit,
      artifactSha256: plan.fallback.artifactSha256,
    },
    interruption: plan.interruption,
  });
}

function requireHostEffect(
  state: InstallationEnrollmentState,
  revision: string,
  stepId: string,
  role: HostRole,
  plan: HostContinuationCustody["plan"],
) {
  const grant = requireGrant(state, revision);
  hostRequire(state.status === "enrolled", "enrollment is absent");
  const target = requireTarget(grant, "host");
  const operations =
    role === "restoration"
      ? (["rollback", "recovery"] as const)
      : (["replacement", "recovery"] as const);
  hostRequire(
    operations.every((operation) => target.operations.includes(operation)),
    "explicit rollback/recovery/replacement authority is required",
  );
  const step = grant.manifest.steps.find((item) => item.id === stepId);
  const binding = hostBinding(plan);
  hostRequire(
    step &&
      step.target === "host" &&
      step.operation === "replacement" &&
      step.previous &&
      grant.manifest.installationId === plan.installationId &&
      step.planSha256 === binding.planSha256 &&
      target.identitySha256 === binding.identitySha256 &&
      isDeepStrictEqual(step.candidate, binding.candidate) &&
      isDeepStrictEqual(step.previous, binding.previous) &&
      isDeepStrictEqual(grant.manifest.interruption, binding.interruption),
    "plan, target, releases or interruption differ from enrollment",
  );
  hostRequire(
    step.dependsOn.every((id) =>
      state.activation.steps.some((item) => item.id === id && item.status === "succeeded"),
    ),
    "activation prerequisites are not verified",
  );
  hostRequire(
    !state.activation.steps.some(
      (item) =>
        item.id !== stepId && (item.status === "reserved" || item.status === "recovery_required"),
    ),
    "another activation effect retains exclusion",
  );
  const own = state.activation.hostContinuations?.find((item) => item.stepId === stepId);
  assertHostContinuationExclusion(
    state,
    own ? { stepId, generation: (own.candidate ?? own.restoration).generation } : undefined,
  );
  return state;
}

function runHostEffectCustody(
  journal: FileEnrollmentJournal,
  context: HostContinuationCustody,
  ports: HostEffectPorts,
  revision: string,
) {
  hostRequire(
    typeof ports.assertCurrent === "function" && typeof ports.assertExclusive === "function",
    "retained custody and lock-held global exclusion are required",
  );
  const captured = hostDigest(context);
  hostRequire(ports.assertExclusive(context) === undefined, "global exclusion must be synchronous");
  hostRequire(hostDigest(context) === captured, "exclusion mutated admitted bindings");
  hostRequire(ports.assertCurrent(context) === undefined, "retained custody must be synchronous");
  hostRequire(hostDigest(context) === captured, "custody mutated admitted bindings");
  const fresh = requireHostEffect(
    journal.readUnderLifecycleLock(),
    revision,
    context.lineage.stepId,
    context.role,
    context.plan,
  );
  hostRequire(isDeepStrictEqual(fresh, context.state), "grant or ledger changed during custody");
}

export interface HostRestorationReservation extends HostEffectPorts {
  grantRevision: string;
  stepId: string;
  plan: unknown;
  originalIntent: unknown;
  originalClaim: unknown;
  publication: InitialHostRecoveryImage;
  evidence: HostContinuation["restoration"]["evidence"];
}

/** One reservation fences the original observer immediately. Repeating this
 * exact request recovers its generation, but never consumes a native effect.
 * Every return is bookkeeping only, including the first. Before constructing a
 * child, the existing native owner must exclusively create its addressed launch
 * intent/arrangement. Two callers may receive this same generation; neither is
 * elected to spawn by this return. This ledger supplies no launch election. */
export function reserveHostRestoration(
  journal: FileEnrollmentJournal,
  input: HostRestorationReservation,
) {
  const { plan } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const intent = InitialHostMigrationIntentSchema.parse(input.originalIntent);
  const claim = InitialHostMigrationClaimSchema.parse(input.originalClaim);
  const evidence = HostRestorationEvidenceSchema.parse(input.evidence);
  const publication = classifyInitialHostPublication(input.publication);
  hostRequire(
    publication.snapshot.enrollmentStateDirectory === journal.stateDirectory,
    "publication namespace differs from enrollment journal",
  );
  const { grantRevision, stepId, assertCurrent, assertExclusive } = input;
  return updateHost(journal, (current) => {
    const state = requireHostEffect(current, grantRevision, stepId, "restoration", plan);
    const binding = hostBinding(plan);
    hostRequire(
      intent.stepId === stepId &&
        intent.grantId === state.grant.id &&
        intent.manifestSha256 === state.activation.manifestSha256 &&
        intent.planSha256 === binding.planSha256 &&
        intent.identitySha256 === binding.identitySha256 &&
        intent.preconditionSha256 === plan.preconditionSha256 &&
        claim.intentId === intent.id &&
        claim.intentSha256 === hostDigest(intent) &&
        claim.stepId === stepId &&
        claim.planSha256 === binding.planSha256 &&
        claim.generation === intent.generation,
      "original intent or claim differs from reviewed failure",
    );
    const retained = state.activation.hostContinuations?.find((item) => item.stepId === stepId);
    if (retained) {
      assertHostPublication(retained, publication);
      hostRequire(
        isDeepStrictEqual(retained.binding, binding) &&
          retained.original.intentSha256 === hostDigest(intent) &&
          retained.original.claimSha256 === hostDigest(claim) &&
          isDeepStrictEqual(retained.restoration.evidence, evidence),
        "restoration request changed; observe the retained generation",
      );
      return state;
    }
    const failed = state.activation.steps.find((item) => item.id === stepId);
    hostRequire(
      failed?.status === "recovery_required" &&
        failed.generation === claim.generation &&
        failed.grantRevision === intent.grantRevision,
      "original failed generation is not retained",
    );
    const lineage = HostContinuationSchema.parse({
      stepId,
      binding,
      original: {
        failed,
        grantId: state.grant.id,
        manifestSha256: state.activation.manifestSha256,
        intentSha256: hostDigest(intent),
        claimSha256: hostDigest(claim),
        executorSha256: hostDigest(claim.executor),
      },
      restoration: {
        generation: randomUUID(),
        grantRevision,
        reservedAt: new Date().toISOString(),
        evidence,
      },
    });
    assertHostPublication(lineage, publication);
    const proposed = structuredClone(lineage);
    runHostEffectCustody(
      journal,
      {
        state: structuredClone(state),
        plan: structuredClone(plan),
        lineage: proposed,
        role: "restoration",
        child: proposed.restoration,
        publication: structuredClone(publication),
      },
      { assertCurrent, assertExclusive },
      grantRevision,
    );
    return {
      ...state,
      activation: {
        ...state.activation,
        hostContinuations: [...(state.activation.hostContinuations ?? []), lineage],
      },
    };
  });
}

export interface HostCandidateReservation extends HostEffectPorts {
  grantRevision: string;
  stepId: string;
  plan: unknown;
  evidence: NonNullable<HostContinuation["candidate"]>["evidence"];
}

/** A restored legacy runtime is not activation success. The single candidate
 * child gets its own native predecessor binding and fresh logical generation.
 * A returned reservation never authorizes construction. The existing executor's
 * exclusive addressed native launch arrangement must elect that constructor. */
export function reserveHostCandidateContinuation(
  journal: FileEnrollmentJournal,
  input: HostCandidateReservation,
) {
  const { plan } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const evidence = HostCandidateEvidenceSchema.parse(input.evidence);
  const { grantRevision, stepId, assertCurrent, assertExclusive } = input;
  return updateHost(journal, (current) => {
    const state = requireHostEffect(current, grantRevision, stepId, "candidate", plan);
    const lineage = state.activation.hostContinuations?.find((item) => item.stepId === stepId);
    hostRequire(
      lineage && isDeepStrictEqual(lineage.binding, hostBinding(plan)),
      "restoration lineage is not retained",
    );
    if (lineage.candidate) {
      hostRequire(
        isDeepStrictEqual(lineage.candidate.evidence, evidence),
        "candidate request changed; observe retained generation",
      );
      return state;
    }
    const restored = lineage.restoration.observation;
    hostRequire(
      restored?.outcome === "legacy-restored" &&
        evidence.restorationGeneration === lineage.restoration.generation &&
        evidence.restorationObservationSha256 === restored.observationSha256 &&
        evidence.restorationChildExitSha256 === restored.childExitSha256 &&
        evidence.preconditionSha256 !== plan.preconditionSha256,
      "candidate requires the exact restored predecessor and its settled child",
    );
    const next = HostContinuationSchema.parse({
      ...lineage,
      candidate: {
        generation: randomUUID(),
        grantRevision,
        reservedAt: new Date().toISOString(),
        evidence,
      },
    });
    const proposed = structuredClone(next);
    runHostEffectCustody(
      journal,
      {
        state: structuredClone(state),
        plan: structuredClone(plan),
        lineage: proposed,
        role: "candidate",
        child: hostChild(proposed, "candidate"),
        publication: null,
      },
      { assertCurrent, assertExclusive },
      grantRevision,
    );
    return {
      ...state,
      activation: {
        ...state.activation,
        steps: state.activation.steps.map((item) =>
          item.id === stepId ? candidateProgress(next) : item,
        ),
        hostContinuations: state.activation.hostContinuations?.map((item) =>
          item.stepId === stepId ? next : item,
        ),
      },
    };
  });
}

export interface HostContinuationConsumption extends HostEffectPorts {
  grantRevision: string;
  stepId: string;
  generation: string;
  role: HostRole;
  plan: unknown;
  reservationSha256: string;
  intentSha256: string;
  claimSha256: string;
  executor: unknown;
  publication: InitialHostRecoveryImage | null;
}

/** Persist before native invocation. An existing or uncertain claim has no
 * redispatch path, even when all fields match a repeated caller request.
 * The actual gated child already exists when its identity is consumed here.
 * This post-birth claim cannot elect its constructor; an independently exclusive
 * native launch arrangement is a required integration prerequisite. */
export function consumeHostContinuation(
  journal: FileEnrollmentJournal,
  input: HostContinuationConsumption,
) {
  const { plan } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const executor = BootstrapProcessIdentitySchema.parse(input.executor);
  const publication =
    input.publication === null ? null : classifyInitialHostPublication(input.publication);
  hostRequire(
    publication === null ||
      publication.snapshot.enrollmentStateDirectory === journal.stateDirectory,
    "publication namespace differs from enrollment journal",
  );
  const {
    grantRevision,
    stepId,
    generation,
    role,
    reservationSha256,
    intentSha256,
    claimSha256,
    assertCurrent,
    assertExclusive,
  } = input;
  return updateHost(journal, (current) => {
    const state = requireHostEffect(current, grantRevision, stepId, role, plan);
    const lineage = state.activation.hostContinuations?.find((item) => item.stepId === stepId);
    hostRequire(
      lineage && isDeepStrictEqual(lineage.binding, hostBinding(plan)),
      "lineage binding changed",
    );
    hostRequire(
      role !== "restoration" || !lineage.candidate,
      "historical restoration cannot dispatch",
    );
    const child = hostChild(lineage, role);
    if (role === "restoration") {
      hostRequire(publication, "restoration requires the retained publication image");
      assertHostPublication(lineage, publication);
    } else
      hostRequire(
        publication === null,
        "candidate uses its exact restoration receipt, not an original image",
      );
    hostRequire(
      child.generation === generation &&
        child.grantRevision === grantRevision &&
        hostContinuationReservationDigest(lineage, role) === reservationSha256,
      "claim does not match current child reservation",
    );
    hostRequire(
      !child.claim && !child.observation,
      "child is already consumed or uncertain; observe only",
    );
    const next = HostContinuationSchema.parse({
      ...lineage,
      [role]: {
        ...child,
        claim: {
          reservationSha256,
          intentSha256,
          claimSha256,
          executorSha256: hostDigest(executor),
          consumedAt: new Date().toISOString(),
        },
      },
    });
    const proposed = structuredClone(next);
    runHostEffectCustody(
      journal,
      {
        state: structuredClone(state),
        plan: structuredClone(plan),
        lineage: proposed,
        role,
        child: hostChild(proposed, role),
        publication: structuredClone(publication),
      },
      { assertCurrent, assertExclusive },
      grantRevision,
    );
    return {
      ...state,
      activation: {
        ...state.activation,
        hostContinuations: state.activation.hostContinuations?.map((item) =>
          item.stepId === stepId ? next : item,
        ),
      },
    };
  });
}

/** Rechecks one already-consumed, active child under the shared lifecycle lock.
 * The action owns its addressed one-use publication/dispatch fences; this API
 * never elects a constructor or makes a consumed claim replayable. Native
 * commands and asynchronous work remain outside this synchronous boundary. */
export function withHostContinuationAdmission(
  journal: FileEnrollmentJournal,
  input: HostContinuationConsumption,
  action: (context: HostContinuationCustody, assertCurrent: () => void) => void,
) {
  const { plan } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const executor = BootstrapProcessIdentitySchema.parse(input.executor);
  const publication =
    input.publication === null ? null : classifyInitialHostPublication(input.publication);
  const {
    grantRevision,
    stepId,
    generation,
    role,
    reservationSha256,
    intentSha256,
    claimSha256,
    assertCurrent,
    assertExclusive,
  } = input;
  hostRequire(
    publication === null ||
      publication.snapshot.enrollmentStateDirectory === journal.stateDirectory,
    "publication namespace differs from enrollment journal",
  );
  return journal.update((current) => {
    const state = requireHostEffect(current, grantRevision, stepId, role, plan);
    const lineage = state.activation.hostContinuations?.find((item) => item.stepId === stepId);
    hostRequire(
      lineage && isDeepStrictEqual(lineage.binding, hostBinding(plan)),
      "lineage binding changed",
    );
    hostRequire(
      role !== "restoration" || !lineage.candidate,
      "historical restoration cannot dispatch",
    );
    const child = hostChild(lineage, role);
    hostRequire(
      child.generation === generation &&
        child.grantRevision === grantRevision &&
        hostContinuationReservationDigest(lineage, role) === reservationSha256,
      "admission does not match current child reservation",
    );
    hostRequire(
      child.claim && !child.observation,
      "admission requires an unobserved consumed child",
    );
    hostRequire(
      child.claim.reservationSha256 === reservationSha256 &&
        child.claim.intentSha256 === intentSha256 &&
        child.claim.claimSha256 === claimSha256 &&
        child.claim.executorSha256 === hostDigest(executor),
      "admission differs from the consumed child",
    );
    if (role === "restoration") {
      hostRequire(publication, "restoration requires the retained publication image");
      assertHostPublication(lineage, publication);
    } else
      hostRequire(
        publication === null,
        "candidate uses its exact restoration receipt, not an original image",
      );
    const context: HostContinuationCustody = structuredClone({
      state,
      plan,
      lineage,
      role,
      child,
      publication,
    });
    const captured = hostDigest(context);
    let active = true;
    const check = () => {
      hostRequire(active, "admission callback is no longer active");
      hostRequire(hostDigest(context) === captured, "action mutated admitted bindings");
      runHostEffectCustody(journal, context, { assertCurrent, assertExclusive }, grantRevision);
    };
    try {
      check();
      hostRequire(action(context, check) === undefined, "admitted action must be synchronous");
      check();
      return state;
    } finally {
      active = false;
    }
  });
}

export interface HostContinuationObservation {
  stepId: string;
  generation: string;
  role: HostRole;
  claimSha256: string;
  executor: unknown;
  outcome: "legacy-restored" | "candidate-ready" | "recovery_required";
  observationSha256: string;
  childExitSha256: string;
  /** Verifies exact child exit and the requested slot's retained readiness or
   * unresolved receipt. It must not publish, reset or issue commands. */
  assertCurrent(context: {
    state: EnrolledState;
    lineage: HostContinuation;
    child: HostChild;
    executor: ReturnType<typeof BootstrapProcessIdentitySchema.parse>;
  }): void;
}

/** Observation after revocation carries no effect port. A settled failed child
 * stays fenced; this bounded lineage never retries it or rewrites its result. */
export function observeHostContinuation(
  journal: FileEnrollmentJournal,
  input: HostContinuationObservation,
) {
  const executor = BootstrapProcessIdentitySchema.parse(input.executor);
  const {
    stepId,
    generation,
    role,
    claimSha256,
    outcome,
    observationSha256,
    childExitSha256,
    assertCurrent,
  } = input;
  return updateHost(journal, (current) => {
    hostRequire(current.status === "enrolled", "enrollment is absent");
    const lineage = current.activation.hostContinuations?.find((item) => item.stepId === stepId);
    hostRequire(lineage, "lineage is not retained");
    hostRequire(
      role !== "restoration" || !lineage.candidate,
      "historical observer cannot alter a successor",
    );
    const child = hostChild(lineage, role);
    hostRequire(
      child.generation === generation &&
        child.claim?.claimSha256 === claimSha256 &&
        child.claim.executorSha256 === hostDigest(executor),
      "observation differs from the consumed child lifetime",
    );
    hostRequire(
      outcome === "recovery_required" ||
        outcome === (role === "restoration" ? "legacy-restored" : "candidate-ready"),
      "readiness names the wrong slot",
    );
    const context = structuredClone({ state: current, lineage, child, executor });
    const captured = hostDigest(context);
    hostRequire(
      typeof assertCurrent === "function" && assertCurrent(context) === undefined,
      "observation custody must be synchronous",
    );
    hostRequire(hostDigest(context) === captured, "observer mutated retained bindings");
    if (child.observation) {
      hostRequire(
        child.observation.outcome === outcome &&
          child.observation.observationSha256 === observationSha256 &&
          child.observation.childExitSha256 === childExitSha256,
        "child result is immutable",
      );
      return current;
    }
    const next = HostContinuationSchema.parse({
      ...lineage,
      [role]: {
        ...child,
        observation: {
          outcome,
          observationSha256,
          childExitSha256,
          observedAt: new Date().toISOString(),
        },
      },
    });
    return {
      ...current,
      activation: {
        ...current.activation,
        steps: current.activation.steps.map((item) =>
          role === "candidate" && item.id === stepId ? candidateProgress(next) : item,
        ),
        hostContinuations: current.activation.hostContinuations?.map((item) =>
          item.stepId === stepId ? next : item,
        ),
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
  assertHostContinuationExclusion(state);
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
