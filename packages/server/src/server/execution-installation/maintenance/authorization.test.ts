import { inspectInitialHostFallbackCopy } from "./host-supervisor-fallback.js";
import {
  assertMaintenanceEnrollmentClaim,
  unresolvedMaintenanceActivations,
} from "../coordinator-bootstrap-maintenance-enrollment.js";
import { inspectLifecycleActivationChild } from "../coordinator-bootstrap-maintenance-child.js";
import {
  reconcileInitialHostActivation,
  reconcileNativeInitialHostActivation,
} from "./host-supervisor-activation.js";
import {
  executeInitialHostMigrationTransition,
  observeInitialHostMigrationTransition,
  inspectInitialHostCandidatePublication,
} from "./host-supervisor-execution.js";
import { digestBootstrapArtifact } from "../coordinator-bootstrap-artifact.js";
import { InitialHostSupervisorPreconditionSchema } from "./native-daemon-inspection.js";
import {
  CoordinatorBootstrapPlanSchema,
  CoordinatorBootstrapRequestSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import {
  InitialHostSupervisorMigrationPlanSchema,
  InitialHostMigrationIntentSchema,
  InitialHostMigrationClaimSchema,
  initialHostPublicationRecords,
  inspectInitialHostSupervisorMigrationPlan,
  inspectInitialHostMigrationEnrollment,
  reserveInitialHostMigrationIntent,
  claimInitialHostMigration,
  publishInitialHostMigrationSelection,
  verifyInitialHostMigrationLaunchers,
} from "./host-supervisor-migration.js";
import type { LifecycleJob } from "../lifecycle-journal.js";
import {
  approveServiceJob,
  observeServiceJob,
  reserveServiceJob,
  retainServiceRecoveryObservation,
} from "./service-progress.js";
import {
  maintenanceRecoveryAncestors,
  assertUnclaimedMaintenanceServiceAbsent,
  assertMaintenanceRecoveryExclusion,
} from "./service-recovery.js";
import type {
  MaintenanceServiceExecutor,
  MaintenanceServiceNativeObservation,
} from "./service-execution.js";
import { InstallationRestarts } from "../restarts.js";
import { createInstallationRestartExecutor } from "../daemon.js";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { inspectStandingSourceProvenance } from "./source-provenance.js";
import {
  maintenanceServiceEvidenceDigest,
  maintenanceServiceProposalDigest,
  type MaintenanceServiceAdmissionEvidence,
} from "./service-admission.js";
import {
  MaintenanceServiceEvidenceRecordSchema,
  MaintenanceServiceJobSchema,
  MaintenanceServiceExecutorEvidenceSchema,
} from "@getpaseo/protocol/maintenance-service";
import type {
  MaintenanceServiceJob,
  MaintenanceServiceEvidenceRecord,
} from "@getpaseo/protocol/maintenance-service";
import { createDaemonStandingRuntime } from "./daemon-standing-runtime.js";
import type { InstallationConfig } from "../config.js";
import { execFileSync } from "node:child_process";
import { createStandingRestartAdapter } from "./restart-adapter.js";
import {
  readEnrollmentNativeIdentity,
  retainEnrollmentNativeIdentity,
} from "./native-registration.js";
import {
  assertStandingRestartAdmission,
  evaluateStandingRestart,
  standingRestartPlanDigest,
} from "./restart-admission.js";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import { existsSync } from "node:fs";
import { DaemonAutomation } from "../daemon-automation.js";
import { enrollmentNativeIdentityDigest } from "./native-identity.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  fstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  lstatSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  InstallationEnrollmentApprovalSchema,
  type InstallationEnrollmentManifest,
  type InstallationEnrollmentState,
  type StandingMaintenanceProposal,
} from "@getpaseo/protocol/installation-enrollment";
import {
  FileEnrollmentJournal,
  enrollmentWriteFiles,
  type EnrollmentWriteFiles,
  evaluateStandingProposal,
  changeStandingGrant,
  enrollInstallation,
  enrollmentManifestDigest,
  observeActivationStep,
  reconcileActivationStep,
  reserveActivationStep,
  validateEnrollmentManifest,
  reserveHostRestoration,
  reserveHostCandidateContinuation,
  consumeHostContinuation,
  observeHostContinuation,
  hostContinuationReservationDigest,
  assertHostContinuationExclusion,
  type HostContinuationCustody,
} from "./authorization.js";
import {
  classifyInitialHostPublication,
  type InitialHostRecoveryImage,
} from "./host-supervisor-recovery.js";
import {
  projectEnrollmentStatus,
  readMaintenanceServiceObservations,
  type EnrollmentServiceObservation,
} from "./status.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";

const directories: string[] = [];

function failingEnrollmentFiles(
  stage: "before-write" | "file-sync" | "before-rename" | "after-rename" | "directory-sync",
): EnrollmentWriteFiles {
  return {
    ...enrollmentWriteFiles,
    write(descriptor, data) {
      if (stage === "before-write") throw new Error("Injected write failure");
      enrollmentWriteFiles.write(descriptor, data);
    },
    sync(descriptor) {
      const directory = fstatSync(descriptor).isDirectory();
      if (stage === "directory-sync" && directory)
        throw new Error("Injected directory synchronization failure");
      if (stage === "file-sync" && !directory)
        throw new Error("Injected file synchronization failure");
      enrollmentWriteFiles.sync(descriptor);
    },
    rename(previous, next) {
      if (stage === "before-rename") throw new Error("Injected rename failure");
      enrollmentWriteFiles.rename(previous, next);
      if (stage === "after-rename") throw new Error("Injected lost rename response");
    },
  };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "enrollment-test-")));
  directories.push(directory);
  chmodSync(directory, 0o700);
  const journal = new FileEnrollmentJournal(directory);
  const first = randomUUID();
  const second = randomUUID();
  const manifest: InstallationEnrollmentManifest = {
    version: 1,
    operation: "installation-enrollment",
    installationId: randomUUID(),
    revision: randomUUID(),
    createdAt: "2026-10-15T00:00:00.000Z",
    targets: [
      {
        target: "maintenance-controller",
        identitySha256: "a".repeat(64),
        operations: ["replacement", "recovery", "rollback"],
      },
      {
        target: "recovery-launcher",
        identitySha256: "b".repeat(64),
        operations: ["replacement", "recovery"],
      },
      {
        target: "container-daemon",
        identitySha256: "c".repeat(64),
        operations: ["source-update", "restart", "recovery"],
      },
    ],
    trustedRepositories: ["https://github.com/example/installation.git"],
    provisioning: null,
    interruption: { finishTurnsSeconds: 600, terminateGraceSeconds: 30 },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    steps: [
      {
        id: first,
        target: "recovery-launcher",
        operation: "replacement",
        planSha256: "a".repeat(64),
        candidate: { sourceCommit: "d".repeat(40), artifactSha256: "e".repeat(64) },
        previous: null,
        dependsOn: [],
      },
      {
        id: second,
        target: "maintenance-controller",
        operation: "replacement",
        planSha256: "f".repeat(64),
        candidate: { sourceCommit: "d".repeat(40), artifactSha256: "e".repeat(64) },
        previous: { sourceCommit: "e".repeat(40), artifactSha256: "f".repeat(64) },
        dependsOn: [first],
      },
    ],
  };
  const approval = {
    operation: "installation-enrollment" as const,
    requestId: randomUUID(),
    reviewRevision: manifest.revision,
    manifestSha256: enrollmentManifestDigest(manifest),
    approvedAt: "2026-10-15T01:00:00.000Z",
  };
  function enroll() {
    return enrollInstallation(journal, { manifest, approval });
  }
  return { directory, journal, manifest, approval, enroll, first, second };
}

function enrolled(state: InstallationEnrollmentState) {
  if (state.status !== "enrolled") throw new Error("Fixture was not enrolled");
  return state;
}

function hostContinuationFixture(
  operations: InstallationEnrollmentManifest["targets"][number]["operations"] = [
    "replacement",
    "rollback",
    "recovery",
  ],
) {
  const launcherBytes = Buffer.from("Retained original Host launcher");
  const f = initialHostPlanFixture((plan) => {
    plan.precondition.launcher.sha256 = createHash("sha256").update(launcherBytes).digest("hex");
    plan.fallback.launcher.sha256 = plan.precondition.launcher.sha256;
    plan.candidate.launcher.sha256 = createHash("sha256")
      .update("Candidate Host launcher")
      .digest("hex");
  }, operations);
  const failedState = enrolled(
    observeActivationStep(f.journal, {
      stepId: f.second,
      generation: f.input.generation,
      outcome: "recovery_required",
      observationSha256: "9".repeat(64),
    }),
  );
  const failed = failedState.activation.steps[1];
  if (failed.status !== "recovery_required") throw new Error("Expected failed Host step");
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const intent = InitialHostMigrationIntentSchema.parse({
    version: 1,
    id: randomUUID(),
    operation: "initial-host-supervisor-migration",
    grantId: failedState.grant.id,
    grantRevision: failed.grantRevision,
    manifestSha256: failedState.activation.manifestSha256,
    stepId: f.second,
    generation: failed.generation,
    planSha256: f.manifest.steps[1].planSha256,
    identitySha256: f.plan.identitySha256,
    preconditionSha256: f.plan.preconditionSha256,
    observedAt: failed.reservedAt,
    createdAt: failed.reservedAt,
  });
  const originalClaim = InitialHostMigrationClaimSchema.parse({
    version: 1,
    operation: "initial-host-supervisor-migration",
    intentId: intent.id,
    intentSha256: digest(intent),
    stepId: f.second,
    generation: failed.generation,
    planSha256: intent.planSha256,
    executor: f.plan.precondition.supervisor,
    consumedAt: failed.reservedAt,
  });
  const ports = {
    assertCurrent: vi.fn(() => undefined),
    assertExclusive: vi.fn(() => {
      expect(() =>
        new FileBootstrapRequestJournal(f.directory).withRecoveryTransaction(() => undefined),
      ).toThrow("storage is busy");
    }),
  };
  const records = initialHostPublicationRecords({
    plan: f.plan,
    intent,
    claim: originalClaim,
    enrollmentStateDirectory: f.directory,
  });
  const publication: InitialHostRecoveryImage = {
    enrollmentStateDirectory: f.directory,
    plan: {
      path: path.join(f.directory, "initial-host-migrations", "plans", `${intent.planSha256}.json`),
      state: "present",
      bytes: Buffer.from(JSON.stringify(f.plan, null, 2)),
    },
    intent: {
      path: path.join(f.directory, `initial-host-${f.second}-${failed.generation}.json`),
      state: "present",
      bytes: Buffer.from(JSON.stringify(intent)),
    },
    claim: {
      path: path.join(f.directory, `initial-host-claim-${f.second}-${failed.generation}.json`),
      state: "present",
      bytes: Buffer.from(JSON.stringify(originalClaim)),
    },
    launcher: { path: records.launcher.path, state: "present", bytes: launcherBytes },
    phase: { path: records.phase.file, state: "absent" },
    launcherAttempt: { path: records.launcherAttempt.file, state: "absent" },
    selectorAttempt: { path: records.selectorAttempt.file, state: "absent" },
    selector: {
      path: records.selector.path,
      state: "present",
      text: records.selector.original,
      resolvedTarget: records.selector.original,
    },
  };
  const restoreInput = {
    grantRevision: failedState.grant.revision,
    stepId: f.second,
    plan: f.plan,
    originalIntent: intent,
    originalClaim,
    publication,
    evidence: {
      failedChildExitSha256: "1".repeat(64),
      publicationSnapshotSha256: classifyInitialHostPublication(publication).snapshotSha256,
      targetAbsenceSha256: "3".repeat(64),
    },
    ...ports,
  };
  function lineage() {
    const value = enrolled(f.journal.read()).activation.hostContinuations?.[0];
    if (!value) throw new Error("Expected retained lineage");
    return value;
  }
  function consume(role: "restoration" | "candidate", journal = f.journal) {
    const retained = lineage();
    const child = role === "restoration" ? retained.restoration : retained.candidate;
    if (!child) throw new Error("Child is not reserved");
    const executor = {
      ...f.plan.precondition.supervisor,
      pid: role === "restoration" ? 401 : 402,
      startIdentity: role === "restoration" ? "401:1" : "402:1",
    };
    const input = {
      grantRevision: enrolled(f.journal.read()).grant.revision,
      stepId: f.second,
      generation: child.generation,
      role,
      plan: f.plan,
      reservationSha256: hostContinuationReservationDigest(retained, role),
      intentSha256: (role === "restoration" ? "4" : "5").repeat(64),
      claimSha256: (role === "restoration" ? "6" : "7").repeat(64),
      executor,
      publication: role === "restoration" ? publication : null,
      ...ports,
    };
    const state = consumeHostContinuation(journal, input);
    return { input, state };
  }
  function observe(
    role: "restoration" | "candidate",
    outcome: "legacy-restored" | "candidate-ready" | "recovery_required" = role === "restoration"
      ? "legacy-restored"
      : "candidate-ready",
  ) {
    const retained = lineage();
    const child = role === "restoration" ? retained.restoration : retained.candidate;
    if (!child?.claim) throw new Error("Child is not consumed");
    const executor = {
      ...f.plan.precondition.supervisor,
      pid: role === "restoration" ? 401 : 402,
      startIdentity: role === "restoration" ? "401:1" : "402:1",
    };
    const input = {
      stepId: f.second,
      generation: child.generation,
      role,
      claimSha256: child.claim.claimSha256,
      executor,
      outcome,
      observationSha256: (role === "restoration" ? "8" : "a").repeat(64),
      childExitSha256: (role === "restoration" ? "b" : "c").repeat(64),
      assertCurrent: vi.fn(() => undefined),
    };
    return { input, state: observeHostContinuation(f.journal, input) };
  }
  function candidateInput() {
    const retained = lineage();
    const restored = retained.restoration.observation;
    if (!restored) throw new Error("Restoration is not observed");
    return {
      grantRevision: enrolled(f.journal.read()).grant.revision,
      stepId: f.second,
      plan: f.plan,
      evidence: {
        restorationGeneration: retained.restoration.generation,
        restorationObservationSha256: restored.observationSha256,
        restorationChildExitSha256: restored.childExitSha256,
        publicationSnapshotSha256: "d".repeat(64),
        preconditionSha256: "e".repeat(64),
      },
      ...ports,
    };
  }
  function restore() {
    reserveHostRestoration(f.journal, restoreInput);
    consume("restoration");
    return observe("restoration");
  }
  return {
    ...f,
    failed,
    failedState,
    intent,
    originalClaim,
    ports,
    restoreInput,
    lineage,
    consume,
    observe,
    candidateInput,
    restore,
  };
}

test.each(["reserved", "consumed", "legacy-restored", "candidate-reserved", "candidate-ready"])(
  "Host continuation integration retains cross-ledger exclusion through %s",
  (phase) => {
    const f = hostContinuationFixture();
    reserveHostRestoration(f.journal, f.restoreInput);
    if (phase !== "reserved") f.consume("restoration");
    if (["legacy-restored", "candidate-reserved", "candidate-ready"].includes(phase))
      f.observe("restoration");
    if (["candidate-reserved", "candidate-ready"].includes(phase))
      reserveHostCandidateContinuation(f.journal, f.candidateInput());
    if (phase === "candidate-ready") {
      f.consume("candidate");
      f.observe("candidate");
    }
    const state = enrolled(f.journal.read());
    const projection = structuredClone(state);
    projection.activation.steps[1] = { ...f.failed, status: "succeeded" };
    const settled = phase === "candidate-ready";
    expect(unresolvedMaintenanceActivations(projection).some((step) => step.id === f.second)).toBe(
      !settled,
    );
    const lifecycle = new FileBootstrapRequestJournal(f.directory);
    expect(lifecycle.lifecycleAdmissionAvailable()).toBe(settled);
    const job: RestartJob = {
      id: randomUUID(),
      revision: randomUUID(),
      target: "host",
      requestedBy: "host-agent",
      reason: "Competing installation operation",
      whenIdle: false,
      status: "approved",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      detail: "Prepared competing operation",
      approvedAt: new Date().toISOString(),
    };
    const before = readFileSync(path.join(f.directory, "maintenance-enrollment.json"));
    if (settled) expect(() => lifecycle.writeLifecycle([job])).not.toThrow();
    else {
      expect(() => lifecycle.writeLifecycle([job])).toThrow(/activation must be reconciled/);
      expect(lifecycle.readLifecycle()).toEqual([]);
    }
    expect(readFileSync(path.join(f.directory, "maintenance-enrollment.json"))).toEqual(before);
  },
);

test("Host continuation integration rejects ordinary activation-child and coordinator claim exceptions", () => {
  const f = hostContinuationFixture();
  reserveHostRestoration(f.journal, f.restoreInput);
  const state = enrolled(f.journal.read());
  expect(() =>
    inspectLifecycleActivationChild(
      {
        grantId: state.grant.id,
        grantRevision: state.grant.revision,
        manifestSha256: state.activation.manifestSha256,
        stepId: f.second,
        generation: f.lineage().restoration.generation,
        requestId: randomUUID(),
        requestRevision: randomUUID(),
        planSha256: f.restoreInput.originalIntent.planSha256,
        target: "host",
      },
      state,
      [],
    ),
  ).toThrow(/unresolved child/);
  // A structurally valid coordinator request must still fail the Host fence
  // before its ordinary enrollment exception could be considered.
  const process = f.plan.precondition.supervisor;
  const plan = CoordinatorBootstrapPlanSchema.parse({
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: f.plan.installationId,
    service: `gui/${process.uid}/local.vorteo.fixture.installation`,
    expectedProcess: {
      pid: process.pid,
      bootId: process.bootId,
      startIdentity: process.startIdentity,
      argumentsSha256: process.argumentsSha256,
    },
    previous: f.plan.fallback,
    candidate: f.plan.candidate,
    state: {
      directory: f.directory,
      restartJournal: path.join(f.directory, "restart-jobs.json"),
      ownerSessions: path.join(f.directory, "owner-sessions.json"),
    },
    hostRequestsAfter: null,
  });
  const request = CoordinatorBootstrapRequestSchema.parse({
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Coordinator enrollment exclusion",
    createdAt: new Date().toISOString(),
    plan,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    status: "approved",
    decisionAt: new Date().toISOString(),
  });
  expect(() => assertMaintenanceEnrollmentClaim(request, state)).toThrow(/unresolved child/);
});

test("Host continuation reserves once and fences old completion before consumption", () => {
  const f = hostContinuationFixture();
  const first = reserveHostRestoration(f.journal, f.restoreInput);
  const retained = f.lineage();
  expect(retained.original.failed).toEqual(f.failed);
  expect(retained.restoration.generation).not.toBe(f.failed.generation);
  expect(reserveHostRestoration(f.journal, f.restoreInput)).toEqual(first);
  expect(f.ports.assertCurrent).toHaveBeenCalledTimes(1);
  expect(() =>
    observeActivationStep(f.journal, {
      stepId: f.second,
      generation: f.failed.generation,
      outcome: "succeeded",
      observationSha256: "f".repeat(64),
    }),
  ).toThrow("fenced");
  expect(() =>
    reconcileActivationStep(f.journal, {
      id: randomUUID(),
      stepId: f.second,
      generation: f.failed.generation,
      failedObservationSha256: f.failed.observationSha256,
      observationSha256: "f".repeat(64),
    }),
  ).toThrow("fenced");
  expect(f.journal.read()).toEqual(first);
});

test("Host continuation legacy restoration cannot complete activation or release dependents", () => {
  const f = hostContinuationFixture();
  f.restore();
  const state = enrolled(f.journal.read());
  expect(state.activation.steps[1]).toEqual(f.failed);
  expect(f.lineage().restoration.observation?.outcome).toBe("legacy-restored");
  expect(() =>
    reserveActivationStep(f.journal, {
      grantRevision: state.grant.revision,
      stepId: f.followingId,
    }),
  ).toThrow();
  expect(() => assertHostContinuationExclusion(state)).toThrow("unresolved child");
  const counterfeitRootStatus = structuredClone(state);
  counterfeitRootStatus.activation.steps[1] = { ...f.failed, status: "succeeded" };
  expect(() => assertHostContinuationExclusion(counterfeitRootStatus)).toThrow("unresolved child");
});

test("Host continuation completes only its one fresh linked candidate generation", () => {
  const f = hostContinuationFixture();
  f.restore();
  const original = f.lineage().original;
  const input = f.candidateInput();
  const reserved = reserveHostCandidateContinuation(f.journal, input);
  const child = f.lineage().candidate;
  expect(child).toBeDefined();
  expect(
    new Set([f.failed.generation, f.lineage().restoration.generation, child?.generation]).size,
  ).toBe(3);
  expect(reserveHostCandidateContinuation(f.journal, input)).toEqual(reserved);
  expect(() => f.observe("candidate")).toThrow("not consumed");
  f.consume("candidate");
  f.observe("candidate");
  const state = enrolled(f.journal.read());
  expect(state.activation.steps[1]).toMatchObject({
    status: "succeeded",
    generation: child?.generation,
  });
  expect(f.lineage().original).toEqual(original);
  expect(() => assertHostContinuationExclusion(state)).not.toThrow();
  expect(
    enrolled(
      reserveActivationStep(f.journal, {
        grantRevision: state.grant.revision,
        stepId: f.followingId,
      }),
    ).activation.steps[2].status,
  ).toBe("reserved");
});

test.each(["restoration", "candidate"] as const)(
  "Host continuation %s consumption has no redispatch path",
  (role) => {
    const f = hostContinuationFixture();
    if (role === "candidate") {
      f.restore();
      reserveHostCandidateContinuation(f.journal, f.candidateInput());
    } else reserveHostRestoration(f.journal, f.restoreInput);
    const consumed = f.consume(role);
    expect(() => consumeHostContinuation(f.journal, consumed.input)).toThrow("observe only");
    expect(f.journal.read()).toEqual(consumed.state);
  },
);

test.each(["after-rename", "directory-sync"] as const)(
  "Host continuation uncertain reservation survives %s without another generation",
  (stage) => {
    const f = hostContinuationFixture();
    const uncertain = new FileEnrollmentJournal(f.directory, failingEnrollmentFiles(stage));
    expect(() => reserveHostRestoration(uncertain, f.restoreInput)).toThrow();
    const generation = f.lineage().restoration.generation;
    reserveHostRestoration(f.journal, f.restoreInput);
    expect(f.lineage().restoration.generation).toBe(generation);
  },
);

test("Host continuation uncertain consumption retains claim and refuses another executor", () => {
  const f = hostContinuationFixture();
  reserveHostRestoration(f.journal, f.restoreInput);
  expect(() =>
    f.consume(
      "restoration",
      new FileEnrollmentJournal(f.directory, failingEnrollmentFiles("after-rename")),
    ),
  ).toThrow();
  expect(f.lineage().restoration.claim).toBeDefined();
  expect(() => f.consume("restoration")).toThrow("observe only");
});

test.each(["restoration", "candidate"] as const)(
  "Host continuation failed %s remains fenced without recursive retries",
  (role) => {
    const f = hostContinuationFixture();
    if (role === "candidate") {
      f.restore();
      reserveHostCandidateContinuation(f.journal, f.candidateInput());
    } else reserveHostRestoration(f.journal, f.restoreInput);
    f.consume(role);
    f.observe(role, "recovery_required");
    const state = f.journal.read();
    expect(() => assertHostContinuationExclusion(state)).toThrow();
    expect(() => f.observe(role)).toThrow("immutable");
    if (role === "restoration")
      expect(() => reserveHostCandidateContinuation(f.journal, f.candidateInput())).toThrow();
    else {
      reserveHostCandidateContinuation(f.journal, f.candidateInput());
      expect(f.journal.read()).toEqual(state);
    }
    expect(() => f.consume(role)).toThrow("observe only");
  },
);

test("Host continuation observes exact consumed readiness after revocation without effects", () => {
  const f = hostContinuationFixture();
  reserveHostRestoration(f.journal, f.restoreInput);
  f.consume("restoration");
  changeStandingGrant(f.journal, {
    expectedRevision: f.restoreInput.grantRevision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const observed = f.observe("restoration");
  expect(observeHostContinuation(f.journal, observed.input)).toEqual(observed.state);
  expect(() => reserveHostCandidateContinuation(f.journal, f.candidateInput())).toThrow(
    "paused or revoked",
  );
});

test.each(["rollback", "recovery"] as const)(
  "Host continuation restoration requires explicit %s authority",
  (missing) => {
    const f = hostContinuationFixture([
      "replacement",
      ...(["rollback", "recovery"] as const).filter((operation) => operation !== missing),
    ]);
    expect(() => reserveHostRestoration(f.journal, f.restoreInput)).toThrow("explicit");
    expect(enrolled(f.journal.read()).activation.hostContinuations).toBeUndefined();
  },
);

test.each(["assertCurrent", "assertExclusive"] as const)(
  "Host continuation %s must be synchronous and preserve exact bindings",
  (port) => {
    const f = hostContinuationFixture();
    const before = f.journal.read();
    // oxlint-disable-next-line unicorn/no-thenable -- Deliberate invalid synchronous proof return.
    for (const callback of [() => Promise.resolve(), () => ({ then() {} })]) {
      expect(() =>
        reserveHostRestoration(f.journal, { ...f.restoreInput, [port]: callback }),
      ).toThrow("synchronous");
    }
    expect(() =>
      reserveHostRestoration(f.journal, {
        ...f.restoreInput,
        [port]: (context: HostContinuationCustody) => {
          context.lineage.binding.candidate.sourceCommit = "f".repeat(40);
        },
      }),
    ).toThrow("mutated");
    expect(f.journal.read()).toEqual(before);
  },
);

test("Host continuation requires caller lock-held global exclusion, not a default allow port", () => {
  const f = hostContinuationFixture();
  const input = { ...f.restoreInput };
  Reflect.deleteProperty(input, "assertExclusive");
  expect(() => reserveHostRestoration(f.journal, input)).toThrow("global exclusion");
  expect(() =>
    reserveHostRestoration(f.journal, {
      ...f.restoreInput,
      assertExclusive() {
        throw new Error("Coordinator execution is running");
      },
    }),
  ).toThrow("Coordinator execution");
  expect(enrolled(f.journal.read()).activation.hostContinuations).toBeUndefined();
});

test.each(["assertCurrent", "assertExclusive"] as const)(
  "Host continuation rereads grant revocation after %s",
  (port) => {
    const f = hostContinuationFixture();
    expect(() =>
      reserveHostRestoration(f.journal, {
        ...f.restoreInput,
        [port]: () => {
          const state = enrolled(f.journal.readUnderLifecycleLock());
          state.grant.revision = randomUUID();
          state.grant.revokedAt = new Date().toISOString();
          writeFileSync(
            path.join(f.directory, "maintenance-enrollment.json"),
            JSON.stringify(state),
          );
        },
      }),
    ).toThrow();
    const state = enrolled(f.journal.read());
    expect(state.grant.revokedAt).not.toBeNull();
    expect(state.activation.hostContinuations).toBeUndefined();
  },
);

test("Host continuation detects a competing activation introduced during custody", () => {
  const f = hostContinuationFixture();
  expect(() =>
    reserveHostRestoration(f.journal, {
      ...f.restoreInput,
      assertCurrent() {
        const state = enrolled(f.journal.readUnderLifecycleLock());
        state.activation.steps[2] = {
          id: f.followingId,
          status: "reserved",
          generation: randomUUID(),
          grantRevision: state.grant.revision,
          reservedAt: new Date().toISOString(),
        };
        writeFileSync(path.join(f.directory, "maintenance-enrollment.json"), JSON.stringify(state));
      },
    }),
  ).toThrow("another activation");
  expect(enrolled(f.journal.read()).activation.hostContinuations).toBeUndefined();
});

test.each(["interruption", "candidate", "fallback", "identity", "generation"] as const)(
  "Host continuation rejects substituted original %s before reservation",
  (changed) => {
    const f = hostContinuationFixture();
    const input = structuredClone({
      plan: f.restoreInput.plan,
      originalIntent: f.intent,
      originalClaim: f.originalClaim,
    });
    if (changed === "interruption") input.plan.interruption.terminateGraceSeconds++;
    if (changed === "candidate") input.plan.candidate.sourceCommit = "0".repeat(40);
    if (changed === "fallback") input.plan.fallback.artifactSha256 = "0".repeat(64);
    if (changed === "identity") input.originalIntent.identitySha256 = "0".repeat(64);
    if (changed === "generation") input.originalClaim.generation = randomUUID();
    expect(() => reserveHostRestoration(f.journal, { ...f.restoreInput, ...input })).toThrow();
    expect(enrolled(f.journal.read()).activation.hostContinuations).toBeUndefined();
  },
);

test.each([
  "restorationGeneration",
  "restorationObservationSha256",
  "restorationChildExitSha256",
  "preconditionSha256",
] as const)("Host continuation candidate rejects stale %s", (changed) => {
  const f = hostContinuationFixture();
  f.restore();
  const input = f.candidateInput();
  input.evidence[changed] = changed === "restorationGeneration" ? randomUUID() : "0".repeat(64);
  if (changed === "preconditionSha256")
    input.evidence.preconditionSha256 = f.plan.preconditionSha256;
  expect(() => reserveHostCandidateContinuation(f.journal, input)).toThrow(
    "exact restored predecessor",
  );
  expect(f.lineage().candidate).toBeUndefined();
});

test.each(["pid", "parentPid", "uid", "bootId", "startIdentity"] as const)(
  "Host continuation observation refuses changed executor %s",
  (changed) => {
    const f = hostContinuationFixture();
    reserveHostRestoration(f.journal, f.restoreInput);
    f.consume("restoration");
    const observed = f.observe("restoration");
    const executor = { ...observed.input.executor };
    if (changed === "pid" || changed === "parentPid" || changed === "uid") executor[changed]++;
    if (changed === "bootId") executor.bootId = randomUUID();
    if (changed === "startIdentity") executor.startIdentity = "999:1";
    expect(() => observeHostContinuation(f.journal, { ...observed.input, executor })).toThrow(
      "lifetime",
    );
    expect(f.journal.read()).toEqual(observed.state);
  },
);

test("Host continuation observer must retain exact exit and readiness custody", () => {
  const f = hostContinuationFixture();
  reserveHostRestoration(f.journal, f.restoreInput);
  f.consume("restoration");
  const observed = f.observe("restoration");
  expect(() =>
    observeHostContinuation(f.journal, {
      ...observed.input,
      assertCurrent() {
        throw new Error("Child exit is unproven");
      },
    }),
  ).toThrow("exit is unproven");
  expect(() =>
    // oxlint-disable-next-line unicorn/no-thenable -- Deliberate invalid observer return.
    observeHostContinuation(f.journal, { ...observed.input, assertCurrent: () => ({ then() {} }) }),
  ).toThrow("synchronous");
});

test("Host continuation historical observer and stale whole-state write cannot alter successor", () => {
  const f = hostContinuationFixture();
  const old = f.restore();
  const stale = f.journal.read();
  reserveHostCandidateContinuation(f.journal, f.candidateInput());
  const current = f.journal.read();
  expect(() => observeHostContinuation(f.journal, old.input)).toThrow("historical observer");
  expect(() => f.journal.update(() => stale)).toThrow();
  expect(() =>
    f.journal.update((state) => {
      if (state.status === "enrolled") delete state.activation.hostContinuations;
      return state;
    }),
  ).toThrow();
  expect(f.journal.read()).toEqual(current);
});

test("Host continuation generic writes cannot rewrite archived failure or active generation", () => {
  const f = hostContinuationFixture();
  f.restore();
  for (const change of ["failure", "generation"] as const) {
    expect(() =>
      f.journal.update((state) => {
        if (state.status !== "enrolled" || !state.activation.hostContinuations)
          throw new Error("Missing lineage");
        const lineage = state.activation.hostContinuations[0];
        if (change === "failure") {
          lineage.original.failed.observationSha256 = "0".repeat(64);
          state.activation.steps[1] = lineage.original.failed;
        } else lineage.restoration.generation = randomUUID();
        return state;
      }),
    ).toThrow();
  }
});

test("Host continuation grant revision changes prevent unconsumed child dispatch", () => {
  const f = hostContinuationFixture();
  reserveHostRestoration(f.journal, f.restoreInput);
  changeStandingGrant(f.journal, {
    expectedRevision: f.restoreInput.grantRevision,
    paused: false,
    disabledTargets: [],
    revoke: false,
  });
  expect(() => f.consume("restoration")).toThrow("current child reservation");
  expect(f.lineage().restoration.claim).toBeUndefined();
});

test("Host continuation binds the classifier snapshot and original claim before custody", () => {
  const f = hostContinuationFixture();
  const before = f.journal.read();
  expect(() =>
    reserveHostRestoration(f.journal, {
      ...f.restoreInput,
      evidence: { ...f.restoreInput.evidence, publicationSnapshotSha256: "0".repeat(64) },
    }),
  ).toThrow("classified publication");
  const substituted = structuredClone(f.restoreInput.publication);
  if (substituted.selector.state !== "present") throw new Error("Expected selector");
  substituted.selector.text += "/.";
  expect(() =>
    reserveHostRestoration(f.journal, { ...f.restoreInput, publication: substituted }),
  ).toThrow("classified publication");
  expect(f.ports.assertCurrent).not.toHaveBeenCalled();
  expect(f.journal.read()).toEqual(before);
});

test("Host continuation refuses an inconclusive publication read before reservation", () => {
  const f = hostContinuationFixture();
  expect(() =>
    reserveHostRestoration(f.journal, {
      ...f.restoreInput,
      publication: {
        ...f.restoreInput.publication,
        phase: { path: f.restoreInput.publication.phase.path, state: "inconclusive" },
      },
    }),
  ).toThrow("inconclusive");
  expect(enrolled(f.journal.read()).activation.hostContinuations).toBeUndefined();
});

test("Host continuation consumption rechecks publication bytes and prevents reused executor lifetimes", () => {
  const f = hostContinuationFixture();
  reserveHostRestoration(f.journal, f.restoreInput);
  const child = f.lineage().restoration;
  const input = {
    grantRevision: f.restoreInput.grantRevision,
    stepId: f.second,
    generation: child.generation,
    role: "restoration" as const,
    plan: f.plan,
    reservationSha256: hostContinuationReservationDigest(f.lineage(), "restoration"),
    intentSha256: "4".repeat(64),
    claimSha256: "6".repeat(64),
    executor: f.originalClaim.executor,
    publication: f.restoreInput.publication,
    ...f.ports,
  };
  expect(() => consumeHostContinuation(f.journal, input)).toThrow("executor lifetimes");
  const changed = structuredClone(f.restoreInput.publication);
  if (changed.launcher.state !== "present") throw new Error("Expected launcher");
  changed.launcher.bytes = Buffer.from("Foreign launcher");
  expect(() => consumeHostContinuation(f.journal, { ...input, publication: changed })).toThrow(
    "launcher bytes",
  );
  expect(f.lineage().restoration.claim).toBeUndefined();
});

test("Host continuation observation lost reply reopens its immutable receipt after revocation", () => {
  const f = hostContinuationFixture();
  reserveHostRestoration(f.journal, f.restoreInput);
  f.consume("restoration");
  const observed = f.observe("restoration");
  // Reuse the exact consumed identity with a distinct fresh fixture so the
  // observation's first publication loses its rename response.
  const g = hostContinuationFixture();
  reserveHostRestoration(g.journal, g.restoreInput);
  const consumed = g.consume("restoration");
  const input = {
    ...observed.input,
    stepId: g.second,
    generation: g.lineage().restoration.generation,
    claimSha256: consumed.input.claimSha256,
    executor: consumed.input.executor,
  };
  expect(() =>
    observeHostContinuation(
      new FileEnrollmentJournal(g.directory, failingEnrollmentFiles("after-rename")),
      input,
    ),
  ).toThrow("lost rename response");
  const receipt = g.lineage().restoration.observation;
  changeStandingGrant(g.journal, {
    expectedRevision: g.restoreInput.grantRevision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  observeHostContinuation(g.journal, input);
  expect(g.lineage().restoration.observation).toEqual(receipt);
});

test("Host continuation state validation rejects an active candidate generation mismatch", () => {
  const f = hostContinuationFixture();
  f.restore();
  reserveHostCandidateContinuation(f.journal, f.candidateInput());
  const before = f.journal.read();
  expect(() =>
    f.journal.update((state) => {
      if (state.status === "enrolled") {
        const step = state.activation.steps[1];
        if (step.status !== "pending") step.generation = randomUUID();
      }
      return state;
    }),
  ).toThrow("logical step");
  expect(f.journal.read()).toEqual(before);
});

test("Host continuation shared journal rejects a combined unrelated activation reservation", () => {
  const f = hostContinuationFixture();
  reserveHostRestoration(f.journal, f.restoreInput);
  const before = f.journal.read();
  expect(() =>
    f.journal.update((state) => {
      if (state.status === "enrolled")
        state.activation.steps[2] = {
          id: f.followingId,
          status: "reserved",
          generation: randomUUID(),
          grantRevision: state.grant.revision,
          reservedAt: new Date().toISOString(),
        };
      return state;
    }),
  ).toThrow("another activation");
  expect(f.journal.read()).toEqual(before);
});

test.each(["valid", "changed", "async"] as const)(
  "activation reservation rechecks native custody under exclusion: %s",
  (mode) => {
    const f = fixture();
    const before = enrolled(f.enroll());
    const assertCurrent = () => {
      expect(() =>
        new FileBootstrapRequestJournal(f.directory).withRecoveryTransaction(() => undefined),
      ).toThrow("storage is busy");
      if (mode === "changed") throw new Error("Native parent changed");
      if (mode === "async") return Promise.resolve();
    };
    const apply = () =>
      reserveActivationStep(f.journal, {
        grantRevision: before.grant.revision,
        stepId: f.first,
        assertCurrent,
      });
    if (mode !== "valid") {
      expect(apply).toThrow();
      expect(f.journal.read()).toEqual(before);
      return;
    }
    const current = enrolled(apply());
    expect(current.activation.steps[0].status).toBe("reserved");
    expect(current.grant).toEqual(before.grant);
    expect(apply).toThrow("requires reconciliation");
  },
);

test.each([
  ["observation", "valid"],
  ["observation", "changed"],
  ["observation", "async"],
  ["recovery", "valid"],
  ["recovery", "changed"],
  ["recovery", "async"],
])("activation %s rechecks native custody under exclusion: %s", (operation, mode) => {
  const f = fixture();
  const grant = enrolled(f.enroll()).grant;
  const reserved = enrolled(
    reserveActivationStep(f.journal, {
      grantRevision: grant.revision,
      stepId: f.first,
    }),
  );
  const step = reserved.activation.steps[0];
  if (step.status !== "reserved") throw new Error("Fixture reservation absent");
  if (operation === "recovery")
    observeActivationStep(f.journal, {
      stepId: f.first,
      generation: step.generation,
      outcome: "recovery_required",
      observationSha256: "a".repeat(64),
    });
  const before = f.journal.read();
  const assertCurrent =
    mode === "async"
      ? async () => {}
      : () => {
          expect(() =>
            new FileBootstrapRequestJournal(f.directory).withRecoveryTransaction(() => undefined),
          ).toThrow("storage is busy");
          if (mode === "changed") throw new Error("Native observation changed");
        };
  const apply = () =>
    operation === "recovery"
      ? reconcileActivationStep(f.journal, {
          id: randomUUID(),
          stepId: f.first,
          generation: step.generation,
          failedObservationSha256: "a".repeat(64),
          observationSha256: "b".repeat(64),
          assertCurrent,
        })
      : observeActivationStep(f.journal, {
          stepId: f.first,
          generation: step.generation,
          outcome: "succeeded",
          observationSha256: "b".repeat(64),
          assertCurrent,
        });
  if (mode !== "valid") {
    expect(apply).toThrow();
    expect(f.journal.read()).toEqual(before);
    return;
  }
  const result = enrolled(apply());
  expect(result.activation.steps[0].status).toBe("succeeded");
  expect(result.grant).toEqual(grant);
  if (operation === "recovery")
    expect(result.activation.recoveries[0].failed).toEqual(enrolled(before).activation.steps[0]);
});

function proposal(manifest: InstallationEnrollmentManifest): StandingMaintenanceProposal {
  return {
    id: randomUUID(),
    installationId: manifest.installationId,
    requestedBy: "container-agent",
    target: "container-daemon",
    identitySha256: "c".repeat(64),
    operation: "source-update",
    planSha256: "d".repeat(64),
    repository: manifest.trustedRepositories[0],
    sourceCommit: "e".repeat(40),
    artifactSha256: "f".repeat(64),
  };
}

test("one exact review durably records both authority and ordered activation, without browser state", () => {
  const f = fixture();
  expect(f.journal.read()).toEqual({ version: 1, status: "absent" });
  const saved = enrolled(f.enroll());
  expect(saved.grant.approval).toEqual(f.approval);
  expect(saved.activation.steps).toEqual([
    { id: f.first, status: "pending" },
    { id: f.second, status: "pending" },
  ]);
  expect(new FileEnrollmentJournal(f.directory).read()).toEqual(saved);
  expect(f.enroll()).toEqual(saved);
});

test("a legacy operation approval cannot be supplied as enrollment consent", () => {
  const f = fixture();
  expect(
    InstallationEnrollmentApprovalSchema.safeParse({
      ...f.approval,
      operation: "coordinator-bootstrap",
    }).success,
  ).toBe(false);
  expect(() =>
    enrollInstallation(f.journal, {
      manifest: f.manifest,
      approval: { ...f.approval, manifestSha256: "0".repeat(64) },
    }),
  ).toThrow("no longer matches");
  expect(f.journal.read().status).toBe("absent");
});

test("approval binds target, source bytes, rollback selection and interruption limits", () => {
  const f = fixture();
  const variants = [
    { ...f.manifest, interruption: { ...f.manifest.interruption, finishTurnsSeconds: 601 } },
    {
      ...f.manifest,
      steps: f.manifest.steps.map((step) => ({
        ...step,
        candidate: { ...step.candidate, artifactSha256: "1".repeat(64) },
      })),
    },
    {
      ...f.manifest,
      steps: f.manifest.steps.map((step) => ({
        ...step,
        previous: { sourceCommit: "1".repeat(40), artifactSha256: "2".repeat(64) },
      })),
    },
    {
      ...f.manifest,
      targets: f.manifest.targets.map((target) => ({ ...target, identitySha256: "1".repeat(64) })),
    },
  ];
  for (const manifest of variants)
    expect(() => enrollInstallation(f.journal, { manifest, approval: f.approval })).toThrow(
      "no longer matches",
    );
  expect(f.journal.read().status).toBe("absent");
});

test("fresh container-only installations need no fabricated Host service but must enroll recovery infrastructure", () => {
  const f = fixture();
  expect(validateEnrollmentManifest(f.manifest)).toEqual(f.manifest);
  const missingLauncher = structuredClone(f.manifest);
  missingLauncher.targets[1].target = "host";
  expect(() => validateEnrollmentManifest(missingLauncher)).toThrow(
    "controller and recovery launcher",
  );
});

test("cyclic, forward, missing and duplicated dependencies are rejected before consent", () => {
  const f = fixture();
  for (const dependsOn of [[f.second], [f.first], [randomUUID()], [f.second, f.second]]) {
    expect(() =>
      validateEnrollmentManifest({
        ...f.manifest,
        steps: [{ ...f.manifest.steps[0], dependsOn }, f.manifest.steps[1]],
      }),
    ).toThrow();
  }
  expect(() =>
    validateEnrollmentManifest({
      ...f.manifest,
      steps: [f.manifest.steps[0], f.manifest.steps[0]],
    }),
  ).toThrow("duplicate steps");
});

test("unsafe source origins and embedded credentials cannot enter the standing grant", () => {
  const f = fixture();
  for (const repository of [
    "http://example.test/repo",
    "https://owner:secret@example.test/repo",
    "https://example.test/repo?token=secret",
    "https://example.test/repo#branch",
  ])
    expect(() =>
      validateEnrollmentManifest({ ...f.manifest, trustedRepositories: [repository] }),
    ).toThrow("credential-free");
});

test("one activation effect is reserved at a time and dependencies require verified completion", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const grantRevision = state.grant.revision;
  expect(() => reserveActivationStep(f.journal, { grantRevision, stepId: f.second })).toThrow(
    "prerequisites",
  );
  const reserved = enrolled(reserveActivationStep(f.journal, { grantRevision, stepId: f.first }));
  const first = reserved.activation.steps[0];
  if (first.status !== "reserved") throw new Error("Reservation missing");
  expect(() => reserveActivationStep(f.journal, { grantRevision, stepId: f.first })).toThrow(
    "reconciliation",
  );
  expect(() => reserveActivationStep(f.journal, { grantRevision, stepId: f.second })).toThrow(
    "reconciliation",
  );
  observeActivationStep(f.journal, {
    stepId: f.first,
    generation: first.generation,
    outcome: "succeeded",
    observationSha256: "a".repeat(64),
  });
  expect(
    enrolled(reserveActivationStep(f.journal, { grantRevision, stepId: f.second })).activation
      .steps[1].status,
  ).toBe("reserved");
});

test("crash or lost response after reservation cannot launch the same activation effect again", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const input = { grantRevision: state.grant.revision, stepId: f.first };
  const reserved = reserveActivationStep(f.journal, input);
  const recovered = new FileEnrollmentJournal(f.directory);
  expect(recovered.read()).toEqual(reserved);
  expect(() => reserveActivationStep(recovered, input)).toThrow("reconciliation");
  expect(f.enroll()).toEqual(reserved);
});

test("revocation after dispatch permits observation, and blocks all further activation", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const reserved = enrolled(
    reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: f.first }),
  );
  const first = reserved.activation.steps[0];
  if (first.status !== "reserved") throw new Error("Reservation missing");
  const revoked = enrolled(
    changeStandingGrant(f.journal, {
      expectedRevision: state.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    }),
  );
  observeActivationStep(f.journal, {
    stepId: f.first,
    generation: first.generation,
    outcome: "succeeded",
    observationSha256: "a".repeat(64),
  });
  expect(() =>
    reserveActivationStep(f.journal, { grantRevision: revoked.grant.revision, stepId: f.second }),
  ).toThrow("paused or revoked");
  expect(enrolled(f.enroll()).grant.revokedAt).toBe(revoked.grant.revokedAt);
  expect(() =>
    changeStandingGrant(f.journal, {
      expectedRevision: revoked.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: false,
    }),
  ).toThrow("already been revoked");
});

test("stale changes cannot undo revocation and scoped disable leaves other enrolled targets usable", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const changed = enrolled(
    changeStandingGrant(f.journal, {
      expectedRevision: state.grant.revision,
      paused: false,
      disabledTargets: ["container-daemon"],
      revoke: false,
    }),
  );
  expect(() =>
    changeStandingGrant(f.journal, {
      expectedRevision: state.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: false,
    }),
  ).toThrow("authority changed");
  expect(() =>
    evaluateStandingProposal({
      state: changed,
      grantRevision: changed.grant.revision,
      proposal: proposal(f.manifest),
    }),
  ).toThrow("paused or revoked");
  expect(
    enrolled(
      reserveActivationStep(f.journal, { grantRevision: changed.grant.revision, stepId: f.first }),
    ).activation.steps[0].status,
  ).toBe("reserved");
});

test("verified Dev proposals retain their origin and cannot select another installation, source or target", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const submitted = proposal(f.manifest);
  const result = evaluateStandingProposal({
    state,
    grantRevision: state.grant.revision,
    proposal: submitted,
  });
  expect(result.proposal.requestedBy).toBe("container-agent");
  expect(result.proposal).toEqual(submitted);
  const variants = [
    { ...submitted, installationId: randomUUID() },
    { ...submitted, repository: "https://attacker.test/repo" },
    { ...submitted, identitySha256: "0".repeat(64) },
    { ...submitted, operation: "credential-renewal" as const },
  ];
  for (const changed of variants)
    expect(() =>
      evaluateStandingProposal({ state, grantRevision: state.grant.revision, proposal: changed }),
    ).toThrow("exceeds");
  expect(() =>
    evaluateStandingProposal({ state, grantRevision: randomUUID(), proposal: submitted }),
  ).toThrow("authority changed");
});

test("wrong generations, altered observations and uncertain completion cannot advance dependent work", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const reserved = enrolled(
    reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: f.first }),
  );
  const step = reserved.activation.steps[0];
  if (step.status !== "reserved") throw new Error("Reservation missing");
  expect(() =>
    observeActivationStep(f.journal, {
      stepId: f.first,
      generation: randomUUID(),
      outcome: "succeeded",
      observationSha256: "a".repeat(64),
    }),
  ).toThrow("does not match");
  const input = {
    stepId: f.first,
    generation: step.generation,
    outcome: "recovery_required" as const,
    observationSha256: "a".repeat(64),
  };
  const retained = observeActivationStep(f.journal, input);
  expect(observeActivationStep(f.journal, input)).toEqual(retained);
  expect(() => observeActivationStep(f.journal, { ...input, outcome: "succeeded" })).toThrow(
    "already retained",
  );
  expect(() =>
    reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: f.second }),
  ).toThrow("reconciliation");
});

test("corrupt, incomplete and publicly readable enrollment cannot manufacture authority", () => {
  const f = fixture();
  f.enroll();
  const file = path.join(f.directory, "maintenance-enrollment.json");
  const bytes = readFileSync(file, "utf8");
  writeFileSync(file, bytes.slice(0, -20));
  expect(() => f.journal.read()).toThrow();
  writeFileSync(file, bytes);
  chmodSync(file, 0o644);
  expect(() => f.journal.read()).toThrow("bounded private owned");
  chmodSync(file, 0o600);
  const altered = JSON.parse(bytes);
  altered.activation.steps = [];
  writeFileSync(file, JSON.stringify(altered));
  expect(() => f.journal.read()).toThrow();
});

test("the provisioning admission and exact coordinator step are part of the owner-reviewed digest", () => {
  const f = fixture();
  const manifest = structuredClone(f.manifest);
  manifest.targets.push({
    target: "coordinator",
    identitySha256: "1".repeat(64),
    operations: ["replacement"],
  });
  const coordinatorStep = {
    ...manifest.steps[1],
    id: randomUUID(),
    target: "coordinator" as const,
  };
  manifest.steps.push(coordinatorStep);
  manifest.provisioning = {
    admissionSha256: "2".repeat(64),
    coordinatorStepId: coordinatorStep.id,
  };
  const approval = { ...f.approval, manifestSha256: enrollmentManifestDigest(manifest) };
  expect(
    enrolled(enrollInstallation(f.journal, { manifest, approval })).grant.manifest.provisioning,
  ).toEqual(manifest.provisioning);
  expect(() =>
    enrollInstallation(f.journal, {
      manifest: {
        ...manifest,
        provisioning: { ...manifest.provisioning!, admissionSha256: "3".repeat(64) },
      },
      approval,
    }),
  ).toThrow("no longer matches");
  expect(() =>
    validateEnrollmentManifest({
      ...manifest,
      provisioning: { admissionSha256: "2".repeat(64), coordinatorStepId: f.first },
    }),
  ).toThrow("exact coordinator replacement");
});

test.each([false, true])(
  "reopened recovery can observe completion without replay, including after revocation=%s",
  (revoke) => {
    const f = fixture();
    const state = enrolled(f.enroll());
    const reserved = enrolled(
      reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: f.first }),
    );
    const step = reserved.activation.steps[0];
    if (step.status !== "reserved") throw new Error("Reservation missing");
    const failed = enrolled(
      observeActivationStep(f.journal, {
        stepId: step.id,
        generation: step.generation,
        outcome: "recovery_required",
        observationSha256: "b".repeat(64),
      }),
    );
    if (revoke)
      changeStandingGrant(f.journal, {
        expectedRevision: state.grant.revision,
        paused: false,
        disabledTargets: [],
        revoke: true,
      });
    const reopened = new FileEnrollmentJournal(f.directory);
    const observation = {
      id: randomUUID(),
      stepId: step.id,
      generation: step.generation,
      failedObservationSha256: "b".repeat(64),
      observationSha256: "c".repeat(64),
    };
    expect(() =>
      reconcileActivationStep(reopened, { ...observation, generation: randomUUID() }),
    ).toThrow("failed generation");
    expect(() =>
      reconcileActivationStep(reopened, {
        ...observation,
        failedObservationSha256: "0".repeat(64),
      }),
    ).toThrow("failed generation");
    const beforeRecovery = enrolled(reopened.read());
    const recovered = enrolled(reconcileActivationStep(reopened, observation));
    expect(recovered.grant).toEqual(beforeRecovery.grant);
    expect(recovered.activation.recoveries[0].failed).toEqual(failed.activation.steps[0]);
    expect(reconcileActivationStep(reopened, observation)).toEqual(recovered);
    expect(() =>
      reconcileActivationStep(reopened, { ...observation, observationSha256: "0".repeat(64) }),
    ).toThrow("identity changed");
    expect(() =>
      reserveActivationStep(reopened, { grantRevision: recovered.grant.revision, stepId: f.first }),
    ).toThrow();
    if (revoke) {
      expect(() =>
        reserveActivationStep(reopened, {
          grantRevision: recovered.grant.revision,
          stepId: f.second,
        }),
      ).toThrow("paused or revoked");
    } else {
      expect(
        enrolled(
          reserveActivationStep(reopened, {
            grantRevision: recovered.grant.revision,
            stepId: f.second,
          }),
        ).activation.steps[1].status,
      ).toBe("reserved");
    }
  },
);

test("oversized enrollment leaves the previous durable state unchanged", () => {
  const f = fixture();
  const state = f.enroll();
  const invalid = {
    ...f.manifest,
    trustedRepositories: ["https://example.test/" + "x".repeat(1024 * 1024)],
  };
  expect(() =>
    enrollInstallation(f.journal, { manifest: invalid, approval: f.approval }),
  ).toThrow();
  expect(new FileEnrollmentJournal(f.directory).read()).toEqual(state);
});

test("maximum repository, step and recovery counts remain readable through activation", () => {
  const f = fixture();
  f.manifest.trustedRepositories = Array.from({ length: 16 }, (_, index) =>
    ("https://example.test/" + index + "/").padEnd(2048, "x"),
  );
  for (let index = 2; index < 32; index++) {
    f.manifest.steps.push({
      ...f.manifest.steps[1],
      id: randomUUID(),
      target: "container-daemon",
      operation: "source-update",
      dependsOn: f.manifest.steps.map((step) => step.id),
    });
  }
  f.approval.manifestSha256 = enrollmentManifestDigest(f.manifest);
  const state = enrolled(f.enroll());
  for (const plan of f.manifest.steps) {
    const reserved = enrolled(
      reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: plan.id }),
    );
    const step = reserved.activation.steps.find((item) => item.id === plan.id);
    if (!step || step.status !== "reserved") throw new Error("Reservation missing");
    observeActivationStep(f.journal, {
      stepId: step.id,
      generation: step.generation,
      outcome: "recovery_required",
      observationSha256: "a".repeat(64),
    });
    reconcileActivationStep(f.journal, {
      id: randomUUID(),
      stepId: step.id,
      generation: step.generation,
      failedObservationSha256: "a".repeat(64),
      observationSha256: "b".repeat(64),
    });
  }
  expect(
    enrolled(new FileEnrollmentJournal(f.directory).read()).activation.steps.every(
      (step) => step.status === "succeeded",
    ),
  ).toBe(true);
  expect(enrolled(f.journal.read()).activation.recoveries).toHaveLength(32);
}, 15_000);

test("independent instances and lost change responses cannot bypass a paused or revoked grant", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const other = new FileEnrollmentJournal(f.directory);
  const paused = enrolled(
    changeStandingGrant(other, {
      expectedRevision: state.grant.revision,
      paused: true,
      disabledTargets: [],
      revoke: false,
    }),
  );
  expect(() =>
    reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: f.first }),
  ).toThrow("authority changed");
  expect(() =>
    reserveActivationStep(f.journal, { grantRevision: paused.grant.revision, stepId: f.first }),
  ).toThrow("paused or revoked");
  const change = {
    expectedRevision: paused.grant.revision,
    paused: true,
    disabledTargets: [],
    revoke: true,
  };
  const revoked = changeStandingGrant(other, change);
  expect(() => changeStandingGrant(f.journal, change)).toThrow("authority changed");
  expect(new FileEnrollmentJournal(f.directory).read()).toEqual(revoked);
});

test("successful observation retries return the retained receipt", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const reserved = enrolled(
    reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: f.first }),
  );
  const step = reserved.activation.steps[0];
  if (step.status !== "reserved") throw new Error("Reservation missing");
  const observation = {
    stepId: step.id,
    generation: step.generation,
    outcome: "succeeded" as const,
    observationSha256: "a".repeat(64),
  };
  const observed = observeActivationStep(f.journal, observation);
  expect(observeActivationStep(new FileEnrollmentJournal(f.directory), observation)).toEqual(
    observed,
  );
});

test("symlink and hardlink state files cannot supply standing authority", () => {
  const f = fixture();
  f.enroll();
  const file = path.join(f.directory, "maintenance-enrollment.json");
  const other = path.join(f.directory, "retained.json");
  linkSync(file, other);
  expect(() => f.journal.read()).toThrow("bounded private owned");
  unlinkSync(file);
  symlinkSync(other, file);
  expect(() => f.journal.read()).toThrow();
});

test("completed activation never substitutes for fresh service readiness", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  for (const plan of f.manifest.steps) {
    const reserved = enrolled(
      reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: plan.id }),
    );
    const step = reserved.activation.steps.find((item) => item.id === plan.id);
    if (!step || step.status !== "reserved") throw new Error("Reservation missing");
    observeActivationStep(f.journal, {
      stepId: step.id,
      generation: step.generation,
      outcome: "succeeded",
      observationSha256: "a".repeat(64),
    });
  }
  const status = projectEnrollmentStatus({
    installationId: f.manifest.installationId,
    state: f.journal.read(),
    checkedAt: new Date().toISOString(),
    observations: [],
    freshnessMs: 30_000,
  });
  expect(status.activation).toBe("verified");
  expect(status.completedSteps).toBe(2);
  expect(status.services.every((service) => service.readiness === "unknown")).toBe(true);
});

test("stale and future service observations remain unknown instead of implying current health", () => {
  const f = fixture();
  const state = f.enroll();
  const checkedAt = "2026-10-15T01:00:00.000Z";
  const observation = {
    target: "container-daemon" as const,
    identitySha256: "c".repeat(64),
    readiness: "ready" as const,
    reason: "Runtime identity and readiness verified.",
    observedAt: checkedAt,
    selectedSource: "a".repeat(40),
  };
  for (const observedAt of ["2026-10-15T00:59:00.000Z", "2026-10-15T01:01:00.000Z"]) {
    const status = projectEnrollmentStatus({
      installationId: f.manifest.installationId,
      state,
      checkedAt,
      observations: [{ ...observation, observedAt }],
      freshnessMs: 30_000,
    });
    expect(
      status.services.find((service) => service.target === "container-daemon")?.readiness,
    ).toBe("unknown");
  }
  const fresh = projectEnrollmentStatus({
    installationId: f.manifest.installationId,
    state,
    checkedAt,
    observations: [observation],
    freshnessMs: 30_000,
  });
  expect(fresh.services.find((service) => service.target === "container-daemon")?.readiness).toBe(
    "ready",
  );
  expect(() =>
    projectEnrollmentStatus({
      installationId: f.manifest.installationId,
      state,
      checkedAt,
      observations: [observation, observation],
      freshnessMs: 30_000,
    }),
  ).toThrow("duplicate");
});

test("service health and maintenance authorization remain separate after revocation", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const revoked = changeStandingGrant(f.journal, {
    expectedRevision: state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const checkedAt = new Date().toISOString();
  const status = projectEnrollmentStatus({
    installationId: f.manifest.installationId,
    state: revoked,
    checkedAt,
    freshnessMs: 30_000,
    observations: [
      {
        target: "container-daemon",
        identitySha256: "c".repeat(64),
        readiness: "ready",
        reason: "Verified running.",
        observedAt: checkedAt,
        selectedSource: "a".repeat(40),
      },
    ],
  });
  expect(status.authority).toBe("revoked");
  expect(status.services.find((service) => service.target === "container-daemon")).toMatchObject({
    enabled: false,
    readiness: "ready",
  });
});

test("a reserved effect reports an unconfirmed outcome and another installation cannot read its status", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const reserved = reserveActivationStep(f.journal, {
    grantRevision: state.grant.revision,
    stepId: f.first,
  });
  const input = {
    installationId: f.manifest.installationId,
    state: reserved,
    checkedAt: new Date().toISOString(),
    freshnessMs: 30_000,
    observations: [],
  };
  expect(projectEnrollmentStatus(input).activation).toBe("unconfirmed");
  expect(projectEnrollmentStatus(input).completedSteps).toBe(0);
  expect(() => projectEnrollmentStatus({ ...input, installationId: randomUUID() })).toThrow(
    "different installation",
  );
});

test("enrollment reservations contend on the existing lifecycle journal kernel lock", () => {
  const f = fixture();
  const state = enrolled(f.enroll());
  const other = new FileEnrollmentJournal(f.directory);
  const lifecycle = new FileBootstrapRequestJournal(f.directory);
  const input = { grantRevision: state.grant.revision, stepId: f.first };
  lifecycle.withRecoveryTransaction(() => {
    expect(() => reserveActivationStep(other, input)).toThrow();
  });
  expect(enrolled(f.journal.read()).activation.steps[0].status).toBe("pending");
  expect(enrolled(reserveActivationStep(other, input)).activation.steps[0].status).toBe("reserved");
});

test("a fresh observation for the wrong native identity cannot report service readiness", () => {
  const f = fixture();
  const state = f.enroll();
  const checkedAt = new Date().toISOString();
  const status = projectEnrollmentStatus({
    installationId: f.manifest.installationId,
    state,
    checkedAt,
    freshnessMs: 30_000,
    observations: [
      {
        target: "container-daemon",
        identitySha256: "0".repeat(64),
        readiness: "ready",
        reason: "Another service is running.",
        observedAt: checkedAt,
        selectedSource: "a".repeat(40),
      },
    ],
  });
  expect(status.services.find((service) => service.target === "container-daemon")).toMatchObject({
    readiness: "blocked",
    selectedSource: null,
  });
  expect(
    status.services.find((service) => service.target === "container-daemon")?.reason,
  ).toContain("identity differs");
});

test.each([
  "before-write",
  "file-sync",
  "before-rename",
  "after-rename",
  "directory-sync",
] as const)("enrollment reconciles a storage failure at %s without a second consent", (stage) => {
  const f = fixture();
  const journal = new FileEnrollmentJournal(f.directory, failingEnrollmentFiles(stage));
  expect(() => enrollInstallation(journal, { manifest: f.manifest, approval: f.approval })).toThrow(
    "Injected",
  );
  const retained = new FileEnrollmentJournal(f.directory).read();
  const selected = stage === "after-rename" || stage === "directory-sync";
  expect(retained.status).toBe(selected ? "enrolled" : "absent");
  const recovered = enrolled(f.enroll());
  expect(recovered.grant.approval).toEqual(f.approval);
  if (retained.status === "enrolled") expect(recovered).toEqual(retained);
  expect(recovered.activation.steps.every((step) => step.status === "pending")).toBe(true);
});

test.each(["after-rename", "directory-sync"] as const)(
  "a lost observation response at %s preserves the exact generation and result",
  (stage) => {
    const f = fixture();
    const state = enrolled(f.enroll());
    const reserved = enrolled(
      reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: f.first }),
    );
    const step = reserved.activation.steps[0];
    if (step.status !== "reserved") throw new Error("Reservation missing");
    const input = {
      stepId: step.id,
      generation: step.generation,
      outcome: "succeeded" as const,
      observationSha256: "a".repeat(64),
    };
    expect(() =>
      observeActivationStep(
        new FileEnrollmentJournal(f.directory, failingEnrollmentFiles(stage)),
        input,
      ),
    ).toThrow("Injected");
    const retained = f.journal.read();
    expect(observeActivationStep(f.journal, input)).toEqual(retained);
    expect(() =>
      reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: f.first }),
    ).toThrow("already been dispatched");
  },
);

test("native enrollment identity binds custody and execution namespace without process transients", () => {
  const host = {
    version: 1,
    installationId: randomUUID(),
    custodyOwnerUid: 501,
    installationRoot: "/private/installation",
    stateDirectory: "/private/installation/state",
    environment: "host",
    target: "coordinator",
    serviceDomain: "gui/501",
    serviceLabel: "local.vorteo.coordinator",
    launcherPath: "/private/installation/launcher",
    selectionPath: "/private/installation/current",
  };
  const digest = enrollmentNativeIdentityDigest(host);
  expect(
    enrollmentNativeIdentityDigest(Object.fromEntries(Object.entries(host).toReversed())),
  ).toBe(digest);
  for (const changes of [
    { installationId: randomUUID() },
    { custodyOwnerUid: 502, serviceDomain: "gui/502" },
    { serviceLabel: "local.vorteo.other" },
    { selectionPath: "/private/installation/other" },
  ])
    expect(enrollmentNativeIdentityDigest({ ...host, ...changes })).not.toBe(digest);
  expect(() => enrollmentNativeIdentityDigest({ ...host, serviceDomain: "gui/502" })).toThrow();
  expect(() => enrollmentNativeIdentityDigest({ ...host, pid: 123 })).toThrow();
  expect(() =>
    enrollmentNativeIdentityDigest({ ...host, launcherPath: "/private/../launcher" }),
  ).toThrow();
  const container = {
    version: 1,
    installationId: host.installationId,
    custodyOwnerUid: 501,
    installationRoot: host.installationRoot,
    stateDirectory: host.stateDirectory,
    environment: "container",
    target: "container-daemon",
    containerId: "a".repeat(64),
    containerUid: 1000,
    containerGid: 1000,
    containerHome: "/home/worker",
    containerStateDirectory: "/home/worker/state",
    launcherPath: "/home/worker/launcher",
    selectionPath: "/home/worker/current",
  };
  const containerDigest = enrollmentNativeIdentityDigest(container);
  for (const changes of [
    { containerId: "b".repeat(64) },
    { containerUid: 1001 },
    { containerGid: 1001 },
    { containerStateDirectory: "/home/worker/other" },
  ])
    expect(enrollmentNativeIdentityDigest({ ...container, ...changes })).not.toBe(containerDigest);
  expect(() =>
    enrollmentNativeIdentityDigest({ ...container, serviceDomain: "gui/501" }),
  ).toThrow();
});

test("claim-time enrollment reads reuse the held lifecycle lock", () => {
  const f = fixture();
  const state = f.enroll();
  const lifecycle = new FileBootstrapRequestJournal(f.directory);
  lifecycle.withRecoveryTransaction(() => {
    expect(f.journal.readUnderLifecycleLock()).toEqual(state);
    expect(() => f.journal.read()).toThrow();
  });
});

test("enrollment presence prevents every legacy policy fallback, including paused and revoked grants", () => {
  const f = fixture();
  const policy = new DaemonAutomation(f.directory, true, "2026-10-14T00:00:00.000Z");
  expect(policy.legacyPolicyAvailable()).toBe(true);
  policy.change({ expectedRevision: null, service: "coordinator", enabled: true });
  expect(policy.activation("coordinator")).toBeTruthy();
  let state = enrolled(f.enroll());
  for (const change of [null, { paused: true, revoke: false }, { paused: false, revoke: true }]) {
    if (change)
      state = enrolled(
        changeStandingGrant(f.journal, {
          expectedRevision: state.grant.revision,
          disabledTargets: [],
          ...change,
        }),
      );
    expect(policy.legacyPolicyAvailable()).toBe(false);
    for (const target of ["host", "container-daemon", "coordinator", "supervisor"] as const)
      expect(policy.activation(target)).toBeNull();
    expect(() =>
      policy.change({ expectedRevision: policy.read().revision, enabled: true }),
    ).toThrow();
  }
  writeFileSync(path.join(f.directory, "maintenance-enrollment.json"), "corrupt", { mode: 0o600 });
  expect(() => policy.legacyPolicyAvailable()).toThrow();
  expect(() => policy.activation("host")).toThrow();
});

test("the existing service controls change the enrolled grant without reviving legacy authority", () => {
  const f = fixture();
  const initial = enrolled(f.enroll());
  const policy = new DaemonAutomation(f.directory, true, "2026-10-14T00:00:00.000Z");
  const originalLegacy = path.join(f.directory, "daemon-automation.json");
  expect(policy.read()).toMatchObject({
    revision: initial.grant.revision,
    legacyHostOnly: false,
    services: { host: null, "container-daemon": initial.grant.approval.approvedAt },
  });
  const disabled = policy.change({
    expectedRevision: initial.grant.revision,
    enabled: false,
    service: "container-daemon",
  });
  expect(enrolled(f.journal.read()).grant.disabledTargets).toEqual(["container-daemon"]);
  expect(disabled.services?.["container-daemon"]).toBeNull();
  expect(() =>
    policy.change({
      expectedRevision: initial.grant.revision,
      enabled: true,
      service: "container-daemon",
    }),
  ).toThrow();
  expect(() =>
    policy.change({ expectedRevision: disabled.revision, enabled: true, service: "host" }),
  ).toThrow("outside");
  const enabled = policy.change({
    expectedRevision: disabled.revision,
    enabled: true,
    service: "container-daemon",
  });
  expect(enabled.services?.["container-daemon"]).toBe(initial.grant.approval.approvedAt);
  expect(policy.activation("container-daemon")).toBeNull();
  expect(existsSync(originalLegacy)).toBe(false);
});

function restartAdmissionFixture() {
  const f = fixture();
  let state = enrolled(f.enroll());
  for (const stepId of [f.first, f.second]) {
    state = enrolled(
      reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId }),
    );
    const step = state.activation.steps.find((item) => item.id === stepId)!;
    if (step.status !== "reserved") throw new Error("Expected reservation");
    state = enrolled(
      observeActivationStep(f.journal, {
        stepId,
        generation: step.generation,
        outcome: "succeeded",
        observationSha256: "7".repeat(64),
      }),
    );
  }
  const pending: RestartJob = {
    id: randomUUID(),
    revision: randomUUID(),
    target: "container-daemon",
    reason: "Verified maintenance",
    requestedBy: "container-agent",
    createdAt: "2026-10-15T02:00:00.000Z",
    expiresAt: "2026-10-16T00:00:00.000Z",
    status: "pending",
    detail: "Prepared",
  };
  function evaluate(job: RestartJob, current: InstallationEnrollmentState) {
    return evaluateStandingRestart({
      state: current,
      job,
      installationId: f.manifest.installationId,
      nativeIdentitySha256: "c".repeat(64),
      repository: null,
      credentialBindingSha256: "9".repeat(64),
    });
  }
  const decision = evaluate(pending, state);
  if (!decision) throw new Error("Expected policy decision");
  const revision = randomUUID();
  const approved: RestartJob = {
    ...pending,
    revision,
    status: "approved",
    whenIdle: true,
    finishCurrentTurns: true,
    standingDecision: { ...decision, requestRevision: revision },
    automaticAuthority: decision.authoritySha256,
    automaticApproval: { policyActivatedAt: decision.policyActivatedAt, requestRevision: revision },
  };
  const phases: string[] = [];
  function admit(
    previous: RestartJob[],
    next: RestartJob[],
    current: InstallationEnrollmentState = f.journal.read(),
  ) {
    assertStandingRestartAdmission({
      previous,
      next,
      state: current,
      evaluate,
      assertEvidence: (_job, phase) => {
        phases.push(phase);
      },
    });
  }
  function reserveHold(job: RestartJob): RestartJob {
    return {
      ...job,
      standingHold: {
        generation: randomUUID(),
        grantRevision: state.grant.revision,
        decisionSha256: createHash("sha256")
          .update(JSON.stringify(job.standingDecision))
          .digest("hex"),
        reservedAt: new Date().toISOString(),
      },
    };
  }
  return { ...f, state, pending, approved, evaluate, admit, reserveHold, phases };
}

function interruptionFixture() {
  const f = restartAdmissionFixture();
  const now = Date.now();
  const held = f.reserveHold(f.approved);
  const observed: RestartJob = {
    ...held,
    standingHold: { ...held.standingHold!, observedAt: new Date(now).toISOString() },
  };
  const process = {
    pid: 101,
    parentPid: 100,
    uid: 501,
    bootId: "test-boot",
    startIdentity: "test-birth",
    executable: "/test/node",
    argumentsSha256: "a".repeat(64),
  };
  const running: RestartJob = {
    ...observed,
    status: "running",
    standingInterruption: {
      held: {
        requestId: observed.id,
        generation: randomUUID(),
        workerPid: process.pid,
        workerInstanceId: randomUUID(),
        terminateAt: now + f.manifest.interruption.terminateGraceSeconds * 1000,
      },
      approvedRevision: observed.revision,
      grantRevision: f.state.grant.revision,
      holdGeneration: held.standingHold!.generation,
      decisionSha256: createHash("sha256")
        .update(JSON.stringify(observed.standingDecision))
        .digest("hex"),
      planSha256: observed.standingDecision!.planSha256,
      reservedAt: new Date(now).toISOString(),
      finishDeadlineAt: new Date(
        now + f.manifest.interruption.finishTurnsSeconds * 1000,
      ).toISOString(),
      native: {
        identitySha256: observed.standingDecision!.targetIdentitySha256,
        serverId: "fixture",
        sourceCommit: "a".repeat(40),
        selectedRelease: "/test/release",
        observedAt: new Date(now).toISOString(),
        worker: process,
        supervisor: { ...process, pid: 100, parentPid: 1 },
      },
      candidate: null,
    },
  };
  const lifecycle = new FileBootstrapRequestJournal(f.directory);
  function write(jobs: RestartJob[]) {
    lifecycle.writeLifecycle(jobs, (previous, next) => {
      assertStandingRestartAdmission({
        previous,
        next,
        state: f.journal.readUnderLifecycleLock(),
        evaluate: f.evaluate,
        assertEvidence() {},
        now,
      });
      return undefined;
    });
  }
  write([f.pending]);
  write([f.approved]);
  write([held]);
  write([observed]);
  return { ...f, lifecycle, write, running, observed };
}

test("interruption reservation survives journal reopening and cannot be reset or replayed", () => {
  const f = interruptionFixture();
  f.write([f.running]);
  const reopened = new FileBootstrapRequestJournal(f.directory).readLifecycle();
  expect(reopened).toEqual([f.running]);
  expect(() => f.write([{ ...f.running, status: "approved" }])).toThrow("observation-only");
  expect(() => f.write([{ ...f.running, standingInterruption: undefined }])).toThrow(
    "observation-only",
  );
  const changed = structuredClone(f.running);
  changed.standingInterruption!.held.generation = randomUUID();
  expect(() => f.write([changed])).toThrow("observation-only");
  expect(new FileBootstrapRequestJournal(f.directory).readLifecycle()).toEqual(reopened);
});

test.each([
  "revision",
  "hold",
  "plan",
  "deadline",
  "future-observation",
  "cross-boot",
  "worker",
] as const)(
  "interruption reservation rejects substituted %s before journal persistence",
  (field) => {
    const f = interruptionFixture();
    const before = f.lifecycle.readLifecycle();
    const invalid = structuredClone(f.running);
    const intent = invalid.standingInterruption!;
    const substitutions = {
      revision: () => {
        intent.approvedRevision = randomUUID();
      },
      hold: () => {
        intent.holdGeneration = randomUUID();
      },
      plan: () => {
        intent.planSha256 = "f".repeat(64);
      },
      deadline: () => {
        intent.held.terminateAt++;
      },
      "future-observation": () => {
        intent.native.observedAt = new Date(Date.parse(intent.reservedAt) + 1).toISOString();
      },
      "cross-boot": () => {
        intent.native.worker.bootId = "another-boot";
      },
      worker: () => {
        intent.native.worker.pid++;
      },
    };
    substitutions[field]();
    expect(() => f.write([invalid])).toThrow();
    expect(f.lifecycle.readLifecycle()).toEqual(before);
  },
);

test("native held executor reads the exact retained running reservation before connecting", async () => {
  const f = interruptionFixture();
  const config: InstallationConfig = {
    public: {
      version: 1,
      installationId: f.manifest.installationId,
      origin: "https://installation.example",
      environments: [
        { kind: "container", serverId: "dev", endpoint: "127.0.0.1:1", useTls: false },
      ],
    },
    stateDir: f.directory,
    webDistDir: f.directory,
    listenPort: 6770,
    ownerPasswordHash: "$2-fixture",
    hostAgentTokenHash: "0".repeat(64),
    containerAgentTokenHash: "1".repeat(64),
    host: {
      endpoint: "127.0.0.1:1",
      password: "fixture",
      launchdService: "gui/501/local.vorteo.fixture",
    },
    container: { endpoint: "127.0.0.1:1", password: "fixture" },
  };
  const executor = createInstallationRestartExecutor(config);
  const connect = vi.spyOn(DaemonClient.prototype, "connect");
  try {
    await expect(executor.restartHeld!(f.running)).rejects.toThrow(
      "durable interruption reservation",
    );
    f.write([f.running]);
    const changed = structuredClone(f.running);
    changed.standingInterruption!.held.generation = randomUUID();
    await expect(executor.restartHeld!(changed)).rejects.toThrow(
      "durable interruption reservation",
    );
    f.write([{ ...f.running, status: "succeeded" }]);
    await expect(executor.restartHeld!(f.running)).rejects.toThrow(
      "durable interruption reservation",
    );
    expect(connect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
  }
});

test("interruption observation budgets cannot reset or advance before retained backoff", () => {
  const f = interruptionFixture();
  f.write([f.running]);
  const checked: RestartJob = {
    ...f.running,
    interruptionChecks: {
      attempts: 1,
      checkedAt: f.running.standingInterruption!.reservedAt,
      nextCheckAt: new Date(
        Date.parse(f.running.standingInterruption!.reservedAt) + 5000,
      ).toISOString(),
    },
  };
  f.write([checked]);
  expect(() => f.write([{ ...checked, interruptionChecks: undefined }])).toThrow("retry budget");
  expect(() =>
    f.write([
      {
        ...checked,
        interruptionChecks: {
          attempts: 2,
          checkedAt: f.running.standingInterruption!.reservedAt,
          nextCheckAt: new Date(
            Date.parse(f.running.standingInterruption!.reservedAt) + 15000,
          ).toISOString(),
        },
      },
    ]),
  ).toThrow("retry budget");
  expect(f.lifecycle.readLifecycle()).toEqual([checked]);
});

test("interruption reservation refuses revoked authority while retained results remain observable", () => {
  const f = interruptionFixture();
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  expect(() => f.write([f.running])).toThrow("authority changed");
  expect(f.lifecycle.readLifecycle()).toEqual([f.observed]);
});

test("retained interruption permits terminal observation after revocation without another effect", () => {
  const f = interruptionFixture();
  f.write([f.running]);
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const observed: RestartJob = { ...f.running, status: "succeeded" };
  f.write([observed]);
  expect(f.lifecycle.readLifecycle()).toEqual([observed]);
});

test("standing queue admission binds each effect and permits observation after revocation", () => {
  const f = restartAdmissionFixture();
  f.admit([f.pending], [f.approved]);
  const hold = f.reserveHold(f.approved);
  f.admit([f.approved], [hold]);
  const observed = {
    ...hold,
    standingHold: { ...hold.standingHold!, observedAt: new Date().toISOString() },
  };
  f.admit([hold], [observed]);
  f.admit([observed], [{ ...observed, status: "running" }]);
  expect(f.phases).toEqual(["preparation", "hold", "replacement"]);
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  f.admit([hold], [observed]);
  f.admit([observed], [{ ...observed, status: "rejected" }]);
  expect(() => f.admit([observed], [{ ...observed, status: "running" }])).toThrow(
    "authority changed",
  );
});

test("standing queue admission refuses changed plans, stale decisions and uncertain replay", () => {
  const f = restartAdmissionFixture();
  expect(standingRestartPlanDigest(f.pending)).toBe(standingRestartPlanDigest(f.approved));
  expect(() => f.admit([f.pending], [{ ...f.approved, reason: "Different work" }])).toThrow(
    "authority changed",
  );
  expect(() =>
    f.admit(
      [f.pending],
      [
        {
          ...f.approved,
          standingDecision: { ...f.approved.standingDecision!, requestRevision: randomUUID() },
        },
      ],
    ),
  ).toThrow("authority changed");
  expect(() => f.admit([f.approved], [{ ...f.approved, status: "running" }])).toThrow(
    "hold reservation",
  );
  const hold = f.reserveHold(f.approved);
  expect(() => f.admit([hold], [{ ...hold, status: "running" }])).toThrow("verified hold");
  expect(() =>
    f.admit(
      [hold],
      [{ ...hold, standingHold: { ...hold.standingHold!, generation: randomUUID() } }],
    ),
  ).toThrow("reservation changed");
  expect(() => f.admit([f.approved], [])).toThrow("history");
  expect(() => f.admit([f.approved], [{ ...f.approved, standingDecision: undefined }])).toThrow(
    "plan changed",
  );
});

test("later standing work cannot forge a legacy acknowledgment or reuse released hold authority", () => {
  const f = restartAdmissionFixture();
  const reserved = f.reserveHold(f.approved);
  const forged = {
    ...reserved,
    standingHold: {
      ...reserved.standingHold!,
      initialDaemonInstanceSha256: "a".repeat(64),
      acknowledgedAt: new Date().toISOString(),
    },
  };
  expect(() => f.admit([f.approved], [forged])).toThrow("exact initial child");
  const observed = {
    ...reserved,
    standingHold: { ...reserved.standingHold!, observedAt: new Date().toISOString() },
  };
  expect(() =>
    f.admit(
      [observed],
      [
        {
          ...observed,
          standingHold: { ...observed.standingHold, releaseRequestedAt: new Date().toISOString() },
        },
      ],
    ),
  ).toThrow("terminal");
  const released = {
    ...observed,
    status: "rejected" as const,
    standingHold: { ...observed.standingHold, releaseRequestedAt: new Date().toISOString() },
  };
  f.admit([observed], [released]);
  expect(() => f.admit([released], [{ ...released, status: "running" }])).toThrow();
  expect(() =>
    f.admit(
      [released],
      [
        {
          ...released,
          standingHold: { ...released.standingHold, releaseRequestedAt: undefined },
        },
      ],
    ),
  ).toThrow("reservation changed");
});

test("standing policy denies unverified activation, wrong native identity and revoked scope", () => {
  const f = restartAdmissionFixture();
  const context = {
    state: f.state,
    job: f.pending,
    installationId: f.manifest.installationId,
    nativeIdentitySha256: "c".repeat(64),
    repository: null,
    credentialBindingSha256: "9".repeat(64),
  };
  expect(
    evaluateStandingRestart({ ...context, state: { status: "absent", version: 1 } }),
  ).toBeUndefined();
  expect(evaluateStandingRestart({ ...context, nativeIdentitySha256: "0".repeat(64) })).toBeNull();
  const incomplete = structuredClone(f.state);
  incomplete.activation.steps[0] = { id: f.first, status: "pending" };
  expect(evaluateStandingRestart({ ...context, state: incomplete })).toBeNull();
  const paused = enrolled(
    changeStandingGrant(f.journal, {
      expectedRevision: f.state.grant.revision,
      paused: true,
      disabledTargets: [],
      revoke: false,
    }),
  );
  expect(evaluateStandingRestart({ ...context, state: paused })).toBeNull();
});

test("standing queue admission preserves exact manual operation after grant revocation", () => {
  const f = restartAdmissionFixture();
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const manual = {
    ...f.approved,
    standingDecision: undefined,
    automaticAuthority: undefined,
    automaticApproval: undefined,
  };
  f.admit([f.pending], [manual]);
  f.admit([manual], [{ ...manual, status: "running" }]);
  expect(f.phases).toEqual([]);
  expect(() =>
    f.admit([f.pending], [{ ...manual, automaticApproval: f.approved.automaticApproval }]),
  ).toThrow("authority changed");
});

test("retained native descriptors are immutable, private and independently selected by digest", () => {
  const f = fixture();
  const uid = process.getuid!();
  const descriptor = {
    version: 1 as const,
    environment: "host" as const,
    target: "host" as const,
    installationId: f.manifest.installationId,
    custodyOwnerUid: uid,
    installationRoot: f.directory,
    stateDirectory: path.join(f.directory, "host-state"),
    serviceDomain: `gui/${uid}`,
    serviceLabel: "local.vorteo.test.host",
    launcherPath: path.join(f.directory, "launcher"),
    selectionPath: path.join(f.directory, "selected"),
  };
  const digest = retainEnrollmentNativeIdentity(f.directory, descriptor);
  expect(readEnrollmentNativeIdentity(f.directory, digest)).toEqual(descriptor);
  expect(retainEnrollmentNativeIdentity(f.directory, descriptor)).toBe(digest);
  const file = path.join(f.directory, "maintenance-identities", `${digest}.json`);
  const original = readFileSync(file);
  writeFileSync(file, JSON.stringify({ ...descriptor, serviceLabel: "local.vorteo.changed" }));
  expect(() => readEnrollmentNativeIdentity(f.directory, digest)).toThrow("differs");
  expect(() => retainEnrollmentNativeIdentity(f.directory, descriptor)).toThrow("differs");
  expect(readFileSync(file)).not.toEqual(original);
});

test("retained native descriptor readers reject linked files and writable custody", () => {
  const f = fixture();
  const uid = process.getuid!();
  const descriptor = {
    version: 1 as const,
    environment: "host" as const,
    target: "coordinator" as const,
    installationId: f.manifest.installationId,
    custodyOwnerUid: uid,
    installationRoot: f.directory,
    stateDirectory: f.directory,
    serviceDomain: `gui/${uid}`,
    serviceLabel: "local.vorteo.test.coordinator",
    launcherPath: path.join(f.directory, "launcher"),
    selectionPath: null,
  };
  const digest = retainEnrollmentNativeIdentity(f.directory, descriptor);
  const file = path.join(f.directory, "maintenance-identities", `${digest}.json`);
  const extra = path.join(f.directory, "extra");
  linkSync(file, extra);
  expect(() => readEnrollmentNativeIdentity(f.directory, digest)).toThrow("nonlinked");
  unlinkSync(extra);
  chmodSync(file, 0o644);
  expect(() => readEnrollmentNativeIdentity(f.directory, digest)).toThrow("private");
  chmodSync(file, 0o600);
  unlinkSync(file);
  symlinkSync(extra, file);
  expect(() => readEnrollmentNativeIdentity(f.directory, digest)).toThrow();
  chmodSync(f.directory, 0o777);
  expect(() => retainEnrollmentNativeIdentity(f.directory, descriptor)).toThrow("custody");
});

test("standing admission accepts exact owner supersession and rejects altered approval history", () => {
  const f = restartAdmissionFixture();
  const revision = randomUUID();
  const manual: RestartJob = {
    ...f.approved,
    revision,
    whenIdle: false,
    automaticApproval: undefined,
    standingManualApprovals: [
      {
        previousRevision: f.approved.revision,
        revision,
        decision: "approve",
        approvedAt: new Date().toISOString(),
      },
    ],
  };
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  f.admit([f.approved], [manual]);
  f.admit([manual], [{ ...manual, status: "running" }]);
  expect(() => f.admit([manual], [{ ...manual, standingManualApprovals: [] }])).toThrow("history");
  expect(() => f.admit([f.approved], [{ ...manual, revision: randomUUID() }])).toThrow(
    "supersession",
  );
});

test.each(["container-daemon", "supervisor"] as const)(
  "initial %s migration authority binds the one reserved child and its dependencies",
  (target) => {
    const f = fixture();
    const job = {
      ...restartAdmissionFixture().pending,
      ...(target === "supervisor"
        ? { supervisorPlanSha256: "6".repeat(64), requestedBy: "host-agent" as const }
        : {}),
    };
    const nativeIdentitySha256 = target === "supervisor" ? "4".repeat(64) : "c".repeat(64);
    if (target === "supervisor")
      f.manifest.targets.push({
        target,
        identitySha256: nativeIdentitySha256,
        operations: ["replacement"],
      });
    const planSha256 = standingRestartPlanDigest(job);
    f.manifest.steps[1] = {
      ...f.manifest.steps[1],
      target,
      operation: target === "supervisor" ? "replacement" : "restart",
      planSha256,
    };
    f.approval.manifestSha256 = enrollmentManifestDigest(f.manifest);
    let state = enrolled(f.enroll());
    state = enrolled(
      reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: f.first }),
    );
    const first = state.activation.steps[0];
    if (first.status !== "reserved") throw new Error("Missing fixture reservation");
    state = enrolled(
      observeActivationStep(f.journal, {
        stepId: f.first,
        generation: first.generation,
        outcome: "succeeded",
        observationSha256: "8".repeat(64),
      }),
    );
    state = enrolled(
      reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId: f.second }),
    );
    const input = {
      state,
      job,
      installationId: f.manifest.installationId,
      nativeIdentitySha256,
      repository: null,
      credentialBindingSha256: "9".repeat(64),
    };
    const decision = evaluateStandingRestart(input);
    expect(decision?.activationStep?.stepId).toBe(f.second);
    expect(decision?.activationStep?.candidateArtifactSha256).toBe(
      f.manifest.steps[1].candidate.artifactSha256,
    );
    expect(evaluateStandingRestart({ ...input, job: { ...job, id: randomUUID() } })).toBeNull();
    expect(
      evaluateStandingRestart({ ...input, job: { ...job, requireOwnerApproval: true } }),
    ).toBeNull();
    if (target === "supervisor") {
      const daemonStep = structuredClone(state);
      daemonStep.grant.manifest.steps[1].target = "container-daemon";
      expect(evaluateStandingRestart({ ...input, state: daemonStep })).toBeNull();
      expect(
        evaluateStandingRestart({ ...input, nativeIdentitySha256: "c".repeat(64) }),
      ).toBeNull();
    }
    const stale = structuredClone(state);
    const progress = stale.activation.steps[1];
    if (progress.status !== "reserved") throw new Error("Missing child reservation");
    progress.grantRevision = randomUUID();
    expect(evaluateStandingRestart({ ...input, state: stale })).toBeNull();
    const unmet = structuredClone(state);
    unmet.activation.steps[0] = { id: f.first, status: "pending" };
    expect(evaluateStandingRestart({ ...input, state: unmet })).toBeNull();
  },
);

test("identity publication failures and retained temporary aliases reconcile without replacement", () => {
  const f = fixture();
  const uid = process.getuid!();
  const descriptor = {
    version: 1 as const,
    environment: "host" as const,
    target: "host" as const,
    installationId: f.manifest.installationId,
    custodyOwnerUid: uid,
    installationRoot: f.directory,
    stateDirectory: f.directory,
    serviceDomain: `gui/${uid}`,
    serviceLabel: "local.vorteo.test.host",
    launcherPath: path.join(f.directory, "launcher"),
    selectionPath: null,
  };
  const digest = enrollmentNativeIdentityDigest(descriptor);
  expect(() =>
    retainEnrollmentNativeIdentity(f.directory, descriptor, {
      link: () => {
        throw new Error("Interrupted before publication");
      },
    }),
  ).toThrow("Interrupted");
  const file = path.join(f.directory, "maintenance-identities", `${digest}.json`);
  expect(existsSync(file)).toBe(false);
  expect(retainEnrollmentNativeIdentity(f.directory, descriptor)).toBe(digest);
  const temporary = path.join(
    f.directory,
    "maintenance-identities",
    `.${digest}.${randomUUID()}.tmp`,
  );
  linkSync(file, temporary);
  expect(() => readEnrollmentNativeIdentity(f.directory, digest)).toThrow("nonlinked");
  expect(retainEnrollmentNativeIdentity(f.directory, descriptor)).toBe(digest);
  expect(existsSync(temporary)).toBe(false);
  expect(readEnrollmentNativeIdentity(f.directory, digest)).toEqual(descriptor);
});

test("shared-lock restart adapter rereads revocation before effect reservation", () => {
  const f = restartAdmissionFixture();
  const phases: string[] = [];
  const input = {
    directory: f.directory,
    installationId: f.manifest.installationId,
    credentialBindingSha256: "9".repeat(64),
    ports: {
      evidence: () => ({ nativeIdentitySha256: "c".repeat(64), repository: null }),
      assertEvidence: (_job: RestartJob, phase: string) => {
        phases.push(phase);
      },
    },
  };
  const adapter = createStandingRestartAdapter(input);
  adapter.journal.write([f.pending]);
  expect(adapter.standingDecision(f.pending)).toMatchObject({ grantId: f.state.grant.id });
  adapter.journal.write([f.approved]);
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const reopened = createStandingRestartAdapter(input);
  expect(reopened.standingDecision(f.approved)).toBeNull();
  expect(() => reopened.journal.write([f.reserveHold(f.approved)])).toThrow("authority changed");
  expect(reopened.journal.read()).toEqual([f.approved]);
  reopened.journal.write([{ ...f.approved, status: "rejected" }]);
  expect(reopened.journal.read()[0].status).toBe("rejected");
  expect(phases).toEqual(["preparation"]);
});

test("shared-lock adapter distinguishes never enrolled from missing native evidence and corrupt state", () => {
  const f = fixture();
  const job = restartAdmissionFixture().pending;
  const adapter = createStandingRestartAdapter({
    directory: f.directory,
    installationId: f.manifest.installationId,
    credentialBindingSha256: "9".repeat(64),
    ports: { evidence: () => null, assertEvidence: () => undefined },
  });
  expect(adapter.standingDecision(job)).toBeUndefined();
  f.enroll();
  expect(adapter.standingDecision(job)).toBeNull();
  writeFileSync(path.join(f.directory, "maintenance-enrollment.json"), "incomplete");
  expect(() => adapter.standingDecision(job)).toThrow();
});

test("standing source evidence binds protected bytes and the local clone's HTTPS origin", async () => {
  const f = fixture();
  const first = path.join(f.directory, "first.git"),
    upstream = path.join(f.directory, "upstream.git");
  for (const repo of [first, upstream])
    execFileSync("git", ["init", "--bare", "--template=", repo], { stdio: "ignore" });
  const firstConfig = path.join(first, "config"),
    upstreamConfig = path.join(upstream, "config");
  execFileSync("git", ["config", "--file", firstConfig, "remote.origin.url", upstream]);
  const repository = "https://github.com/example/installation.git";
  execFileSync("git", ["config", "--file", upstreamConfig, "remote.origin.url", repository]);
  const bundle = Buffer.from("exact staged source");
  const bundleFile = path.join(f.directory, "source.bundle");
  writeFileSync(bundleFile, bundle, { mode: 0o600 });
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    bytes: bundle.length,
    sha256: createHash("sha256").update(bundle).digest("hex"),
  };
  const proof = await inspectStandingSourceProvenance({
    repository: first,
    bundleFile,
    update,
    writableMountRoots: [],
  });
  expect(proof.repository).toBe(repository);
  proof.assertCurrent();
  writeFileSync(bundleFile, "different bytes");
  expect(() => proof.assertCurrent()).toThrow("changed");
  await expect(
    inspectStandingSourceProvenance({
      repository: first,
      bundleFile,
      update,
      writableMountRoots: [],
    }),
  ).rejects.toThrow("exact request");
  writeFileSync(bundleFile, bundle);
  const repoProof = await inspectStandingSourceProvenance({
    repository: first,
    bundleFile,
    update,
    writableMountRoots: [],
  });
  execFileSync("git", [
    "config",
    "--file",
    upstreamConfig,
    "remote.origin.url",
    "https://github.com/example/changed.git",
  ]);
  expect(() => repoProof.assertCurrent()).toThrow("changed");
  await expect(
    inspectStandingSourceProvenance({
      repository: first,
      bundleFile,
      update,
      writableMountRoots: [f.directory],
    }),
  ).rejects.toThrow("writable container mount");
});

test("standing source origin refuses credentials and circular local origins", async () => {
  const f = fixture();
  const repo = path.join(f.directory, "repo.git");
  execFileSync("git", ["init", "--bare", "--template=", repo], { stdio: "ignore" });
  const file = path.join(repo, "config");
  const bytes = Buffer.from("source");
  const bundleFile = path.join(f.directory, "bundle");
  writeFileSync(bundleFile, bytes, { mode: 0o600 });
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const inspect = () =>
    inspectStandingSourceProvenance({
      repository: repo,
      bundleFile,
      update,
      writableMountRoots: [],
    });
  execFileSync("git", [
    "config",
    "--file",
    file,
    "remote.origin.url",
    "https://user:fixture-password@example.com/repo.git",
  ]);
  await expect(inspect()).rejects.toThrow("credential-free");
  execFileSync("git", ["config", "--file", file, "remote.origin.url", repo]);
  await expect(inspect()).rejects.toThrow("circular");
});

test("temporary native unavailability retains authorization while refusing new effects", () => {
  const f = restartAdmissionFixture();
  let available = true;
  const adapter = createStandingRestartAdapter({
    directory: f.directory,
    installationId: f.manifest.installationId,
    credentialBindingSha256: "9".repeat(64),
    ports: {
      evidence: () =>
        available ? { nativeIdentitySha256: "c".repeat(64), repository: null } : null,
      assertEvidence: () => undefined,
    },
  });
  adapter.journal.write([f.pending]);
  adapter.journal.write([f.approved]);
  available = false;
  expect(adapter.standingDecision(f.pending)).toBeNull();
  expect(adapter.standingDecision(f.approved)).toMatchObject({ grantId: f.state.grant.id });
  expect(() => adapter.journal.write([f.reserveHold(f.approved)])).toThrow("authority changed");
  expect(adapter.journal.read()).toEqual([f.approved]);
  available = true;
  adapter.journal.write([f.reserveHold(f.approved)]);
  expect((adapter.journal.read()[0] as RestartJob).standingHold).toBeDefined();
});

test("daemon evidence expires, failed refresh clears health, and manual selection preserves native binding", async () => {
  const f = fixture();
  const descriptor = {
    version: 1 as const,
    environment: "host" as const,
    target: "host" as const,
    installationId: f.manifest.installationId,
    custodyOwnerUid: process.getuid!(),
    installationRoot: f.directory,
    stateDirectory: f.directory,
    serviceDomain: `gui/${process.getuid!()}`,
    serviceLabel: "local.vorteo.runtime-test.host",
    launcherPath: path.join(f.directory, "host-launcher"),
    selectionPath: null,
  };
  const identitySha256 = retainEnrollmentNativeIdentity(f.directory, descriptor);
  f.manifest.targets[2] = {
    target: "host",
    identitySha256,
    operations: ["restart", "source-update"],
  };
  f.approval.manifestSha256 = enrollmentManifestDigest(f.manifest);
  f.enroll();
  const config: InstallationConfig = {
    public: {
      version: 1,
      installationId: f.manifest.installationId,
      origin: "https://installation.example",
      environments: [
        { kind: "host", serverId: "host", endpoint: "host.example", useTls: true },
        { kind: "container", serverId: "dev", endpoint: "dev.example", useTls: true },
      ],
    },
    stateDir: f.directory,
    webDistDir: f.directory,
    listenPort: 6770,
    ownerPasswordHash: "$2-fixture",
    hostAgentTokenHash: "0".repeat(64),
    containerAgentTokenHash: "1".repeat(64),
    host: {
      endpoint: "localhost:6771",
      password: "fixture",
      launchdService: `gui/${process.getuid!()}/local.vorteo.runtime-test.host`,
    },
    container: { endpoint: "localhost:6772", password: "fixture" },
  };
  let now = Date.parse("2026-10-15T02:00:00Z"),
    unavailable = false,
    birth = "initial-birth";
  const runtimeProcess = {
    pid: 100,
    parentPid: 1,
    uid: process.getuid!(),
    bootId: "boot",
    startIdentity: birth,
    executable: process.execPath,
    argumentsSha256: "a".repeat(64),
  };
  let workerInstanceId = randomUUID();
  let observedDrainId: string | null = null;
  let previousAlive = true;
  let duringExit: () => void = () => {};
  const runtime = createDaemonStandingRuntime(
    config,
    { host: null, "container-daemon": null },
    {
      now: () => now,
      inspect: async () => {
        if (unavailable) throw new Error("Endpoint unavailable");
        return {
          descriptor,
          identitySha256,
          observedAt: new Date(now).toISOString(),
          custodyStateDirectory: f.directory,
          assertCurrent() {},
          writableMountRoots: [],
          serverId: "host",
          workerInstanceId,
          restartDrainId: observedDrainId,
          selectedRelease: path.join(f.directory, "release"),
          sourceCommit: "a".repeat(40),
          supervisor: runtimeProcess,
          worker: { ...runtimeProcess, pid: 101, parentPid: 100, startIdentity: birth },
          async verifyPreviousWorkerExited() {
            if (previousAlive) throw new Error("Previous native worker is still running");
            duringExit();
          },
        };
      },
    },
  );
  await runtime.refresh([]);
  expect(runtime.observations()[0]).toMatchObject({
    readiness: "ready",
    selectedSource: "a".repeat(40),
  });
  now += 30_001;
  expect(runtime.observations()).toEqual([]);
  await runtime.refresh([]);
  expect(runtime.observations()).toHaveLength(1);
  unavailable = true;
  await runtime.refresh([], true);
  expect(runtime.observations()).toEqual([]);
  unavailable = false;
  let state = enrolled(f.journal.read());
  for (const stepId of [f.first, f.second]) {
    state = enrolled(
      reserveActivationStep(f.journal, { grantRevision: state.grant.revision, stepId }),
    );
    const progress = state.activation.steps.find((item) => item.id === stepId)!;
    if (progress.status !== "reserved") throw new Error("Expected reservation");
    state = enrolled(
      observeActivationStep(f.journal, {
        stepId,
        generation: progress.generation,
        outcome: "succeeded",
        observationSha256: "a".repeat(64),
      }),
    );
  }
  const pending: RestartJob = {
    id: randomUUID(),
    revision: randomUUID(),
    target: "host",
    requestedBy: "host-agent",
    reason: "Enrolled maintenance",
    createdAt: new Date(now).toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z",
    status: "pending",
    detail: "Prepared",
  };
  await runtime.refresh([pending], true);
  const decision = runtime.standingDecision(pending);
  if (!decision) throw new Error("Expected enrolled decision");
  const revision = randomUUID();
  const approved: RestartJob = {
    ...pending,
    revision,
    status: "approved",
    whenIdle: true,
    finishCurrentTurns: true,
    standingDecision: { ...decision, requestRevision: revision },
    automaticApproval: { policyActivatedAt: decision.policyActivatedAt, requestRevision: revision },
  };
  runtime.journal.write([pending]);
  runtime.journal.write([approved]);
  const reserved: RestartJob = {
    ...approved,
    standingHold: {
      generation: randomUUID(),
      grantRevision: state.grant.revision,
      decisionSha256: createHash("sha256")
        .update(JSON.stringify(approved.standingDecision))
        .digest("hex"),
      reservedAt: new Date(now).toISOString(),
    },
  };
  runtime.journal.write([reserved]);
  const held: RestartJob = {
    ...reserved,
    standingHold: { ...reserved.standingHold!, observedAt: new Date(now).toISOString() },
  };
  runtime.journal.write([held]);
  observedDrainId = held.id;
  const interruption = await runtime.prepareInterruption(held);
  expect(interruption).toMatchObject({
    held: { requestId: held.id, workerPid: 101, workerInstanceId },
    approvedRevision: held.revision,
    grantRevision: state.grant.revision,
    holdGeneration: held.standingHold!.generation,
    candidate: null,
    native: { identitySha256, sourceCommit: "a".repeat(40) },
  });
  expect(interruption.held.terminateAt).toBe(
    now + f.manifest.interruption.terminateGraceSeconds * 1000,
  );
  expect(runtime.journal.read()).toEqual([held]);
  observedDrainId = randomUUID();
  await expect(runtime.prepareInterruption(held)).rejects.toThrow("exact native hold");
  observedDrainId = held.id;
  await expect(
    runtime.prepareInterruption({
      ...held,
      standingHold: { ...held.standingHold!, releaseRequestedAt: new Date(now).toISOString() },
    }),
  ).rejects.toThrow("exact native hold");
  await expect(
    runtime.prepareInterruption({ ...held, status: "running", standingInterruption: interruption }),
  ).rejects.toThrow("undispatched");
  expect(runtime.journal.read()).toEqual([held]);
  const manualRevision = randomUUID();
  const manual: RestartJob = {
    ...held,
    revision: manualRevision,
    whenIdle: false,
    automaticApproval: undefined,
    standingManualApprovals: [
      {
        previousRevision: held.revision,
        revision: manualRevision,
        decision: "approve",
        approvedAt: new Date(now).toISOString(),
      },
    ],
  };
  runtime.journal.write([manual]);
  const running: RestartJob = { ...manual, status: "running" };
  runtime.journal.write([running]);
  await runtime.verifySelection(running, { restart: async () => "unused" });
  birth = "replacement-birth";
  await expect(runtime.verifySelection(running, { restart: async () => "unused" })).rejects.toThrow(
    "lifetime changed",
  );

  let releaseSource: () => void = () => {
    throw new Error("Source gate not initialized");
  };
  let enteredSource: () => void = () => {
    throw new Error("Source gate not initialized");
  };
  const sourceGate = new Promise<void>((resolve) => {
    releaseSource = resolve;
  });
  const sourceEntered = new Promise<void>((resolve) => {
    enteredSource = resolve;
  });
  const inspectedBirths: string[] = [];
  const blockedSource: RestartJob = {
    ...pending,
    id: randomUUID(),
    update: {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: "c".repeat(64),
      bytes: 10,
    },
  };
  const concurrent = createDaemonStandingRuntime(
    config,
    {
      host: {
        async inspectStandingSource() {
          enteredSource();
          await sourceGate;
          return { repository: f.manifest.trustedRepositories[0], assertCurrent() {} };
        },
        assertStandingPrepared() {},
        standingCandidate: () => ({
          sourceCommit: "a".repeat(40),
          artifactSha256: "b".repeat(64),
          release: path.join(f.directory, "candidate"),
        }),
        async verifyPreparedInstallation() {},
        async verifyInstalledInterruption() {
          return () => {};
        },
      },
      "container-daemon": null,
    },
    {
      now: () => now,
      inspect: async () => {
        inspectedBirths.push(birth);
        return {
          descriptor,
          identitySha256,
          observedAt: new Date(now).toISOString(),
          custodyStateDirectory: f.directory,
          assertCurrent() {},
          writableMountRoots: [],
          serverId: "host",
          selectedRelease: path.join(f.directory, "release"),
          sourceCommit: "a".repeat(40),
          supervisor: runtimeProcess,
          worker: { ...runtimeProcess, pid: 101, parentPid: 100, startIdentity: birth },
        };
      },
    },
  );
  const collecting = concurrent.refresh([blockedSource], true);
  await sourceEntered;
  birth = "changed-at-forced-boundary";
  const forced = concurrent.refresh([], true);
  releaseSource();
  await Promise.all([collecting, forced]);
  expect(inspectedBirths).toEqual(["replacement-birth", "changed-at-forced-boundary"]);
  now +=
    (f.manifest.interruption.finishTurnsSeconds + f.manifest.interruption.terminateGraceSeconds) *
    1000;
  await expect(runtime.prepareInterruption(held)).rejects.toThrow("deadline has elapsed");
  changeStandingGrant(f.journal, {
    expectedRevision: state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  await expect(runtime.prepareInterruption(held)).rejects.toThrow("exact native hold");
  expect(enrolled(f.journal.read()).grant.revokedAt).not.toBeNull();
  const runningInterruption: RestartJob = {
    ...held,
    status: "running",
    standingInterruption: interruption,
  };
  await expect(runtime.observeInterruption(runningInterruption)).rejects.toThrow(
    "exact reviewed replacement",
  );
  observedDrainId = null;
  workerInstanceId = randomUUID();
  await expect(runtime.observeInterruption(runningInterruption)).rejects.toThrow(
    "Previous native worker",
  );
  previousAlive = false;
  duringExit = () => {
    birth = "changed-during-exit-proof";
  };
  await expect(runtime.observeInterruption(runningInterruption)).rejects.toThrow(
    "Replacement changed",
  );
  duringExit = () => {};
  await expect(
    runtime.observeInterruption({
      ...runningInterruption,
      update: {
        sourceCommit: "c".repeat(40),
        baseCommit: "a".repeat(40),
        sha256: "d".repeat(64),
        bytes: 42,
      },
      standingInterruption: {
        ...interruption,
        candidate: {
          sourceCommit: "c".repeat(40),
          artifactSha256: "e".repeat(64),
          release: path.join(f.directory, "candidate"),
        },
      },
    }),
  ).rejects.toThrow("exact reviewed replacement");
  const grantBeforeObservation = enrolled(f.journal.read()).grant;
  await expect(runtime.observeInterruption(runningInterruption)).resolves.toContain(
    "independently verified",
  );
  expect(enrolled(f.journal.read()).grant).toEqual(grantBeforeObservation);
  expect(runtime.journal.read()).toEqual([running]);
});

function serviceAdmissionFixture() {
  const f = restartAdmissionFixture();
  let now = Date.parse("2026-10-15T02:00:00Z");
  const pending: MaintenanceServiceJob = {
    id: randomUUID(),
    revision: randomUUID(),
    target: "maintenance-controller",
    operation: "replacement",
    reason: "Replace the enrolled controller",
    createdAt: new Date(now).toISOString(),
    status: "pending",
    detail: "Prepared",
    evidence: [],
    proposal: {
      id: randomUUID(),
      installationId: f.manifest.installationId,
      requestedBy: "container-agent",
      target: "maintenance-controller",
      operation: "replacement",
      identitySha256: "a".repeat(64),
      planSha256: "b".repeat(64),
      sourceCommit: "c".repeat(40),
      artifactSha256: "d".repeat(64),
      repository: f.manifest.trustedRepositories[0],
      previous: { sourceCommit: "e".repeat(40), artifactSha256: "f".repeat(64) },
    },
  };
  pending.proposal.id = pending.id;
  const bootId = randomUUID();
  const processIdentity = {
    pid: process.pid,
    parentPid: process.ppid,
    uid: process.getuid!(),
    bootId,
    startIdentity: "1:0",
    argumentsSha256: "a".repeat(64),
    executable: process.execPath,
  };
  function proof(
    job: MaintenanceServiceJob,
    approvedRevision = job.revision,
  ): MaintenanceServiceAdmissionEvidence {
    const record: MaintenanceServiceEvidenceRecord = {
      requestId: job.id,
      requestRevision: approvedRevision,
      planSha256: job.proposal.planSha256,
      identitySha256: job.proposal.identitySha256,
      sourceCommit: job.proposal.sourceCommit,
      artifactSha256: job.proposal.artifactSha256,
      observedAt: new Date(now).toISOString(),
      native: {
        bootId,
        process: processIdentity,
        service: {
          domain: `gui/${process.getuid!()}`,
          label: "local.vorteo.fixture.installation",
          registered: true,
          launcherPath: path.join(f.directory, "launcher.plist"),
          launcherSha256: "1".repeat(64),
          registrationSha256: "2".repeat(64),
        },
        selection: {
          path: path.join(f.directory, "selection.json"),
          receiptSha256: "3".repeat(64),
          sourceCommit: job.proposal.previous!.sourceCommit,
          artifactSha256: job.proposal.previous!.artifactSha256,
        },
      },
    };
    record.executor = {
      target: "maintenance-controller",
      identitySha256: "a".repeat(64),
      planSha256: "6".repeat(64),
      sourceCommit: record.native.selection.sourceCommit!,
      artifactSha256: record.native.selection.artifactSha256!,
      runtimeDirectory: path.join(f.directory, "controller-runtime"),
      setup: { path: path.join(f.directory, "setup.json"), sha256: "7".repeat(64) },
      node: { path: path.join(f.directory, "node"), sha256: "8".repeat(64) },
      entrypoint: { path: path.join(f.directory, "entry.mjs"), sha256: "9".repeat(64) },
      native: {
        ...structuredClone(record.native),
        process: processIdentity,
        service: {
          ...record.native.service,
          registered: true,
          launcherSha256: "1".repeat(64),
          registrationSha256: "2".repeat(64),
        },
        selection: {
          ...record.native.selection,
          receiptSha256: "3".repeat(64),
          sourceCommit: record.native.selection.sourceCommit!,
          artifactSha256: record.native.selection.artifactSha256!,
        },
      },
    };
    return {
      expectedRevision: job.revision,
      record,
      sha256: maintenanceServiceEvidenceDigest(record),
      assertCurrent() {},
    };
  }
  function retain(job: MaintenanceServiceJob, evidence: MaintenanceServiceAdmissionEvidence) {
    return {
      ...job,
      evidence: [...job.evidence, { sha256: evidence.sha256, record: evidence.record }],
    };
  }
  const adapter = createStandingRestartAdapter({
    directory: f.directory,
    installationId: f.manifest.installationId,
    credentialBindingSha256: "9".repeat(64),
    now: () => now,
    ports: {
      evidence: () => null,
      assertEvidence() {
        throw new Error("Not a daemon request");
      },
    },
  });
  adapter.journal.write([pending]);
  function approve(edit?: (record: MaintenanceServiceEvidenceRecord) => void) {
    const evidence = proof(pending),
      revision = randomUUID();
    edit?.(evidence.record);
    evidence.sha256 = maintenanceServiceEvidenceDigest(evidence.record);
    const job: MaintenanceServiceJob = {
      ...retain(pending, evidence),
      revision,
      status: "approved",
      approval: {
        grantId: f.state.grant.id,
        grantRevision: f.state.grant.revision,
        manifestSha256: enrollmentManifestDigest(f.manifest),
        proposalSha256: maintenanceServiceProposalDigest(pending.proposal),
        reviewedRevision: pending.revision,
        requestRevision: revision,
        nativeEvidenceSha256: evidence.sha256,
        approvedAt: new Date(now).toISOString(),
        dispatchAfter: new Date(now + 30_000).toISOString(),
      },
    };
    adapter.journal.mutate!(
      (jobs) => jobs.map((current) => (current.id === job.id ? job : current)),
      evidence,
    );
    return job;
  }
  function reserve(approved: MaintenanceServiceJob) {
    now += 30_000;
    const evidence = proof(approved),
      approval = approved.approval!;
    const job: MaintenanceServiceJob = {
      ...retain(approved, evidence),
      revision: randomUUID(),
      status: "running",
      reservation: {
        requestId: approved.id,
        requestRevision: approval.requestRevision,
        generation: randomUUID(),
        target: approved.target,
        operation: approved.operation,
        grantId: approval.grantId,
        grantRevision: approval.grantRevision,
        manifestSha256: approval.manifestSha256,
        proposalSha256: approval.proposalSha256,
        planSha256: approved.proposal.planSha256,
        identitySha256: approved.proposal.identitySha256,
        sourceCommit: approved.proposal.sourceCommit,
        artifactSha256: approved.proposal.artifactSha256,
        previous: approved.proposal.previous,
        nativeEvidenceSha256: evidence.sha256,
        reservedAt: new Date(now).toISOString(),
      },
    };
    adapter.journal.mutate!(
      (jobs) => jobs.map((current) => (current.id === job.id ? job : current)),
      evidence,
    );
    return job;
  }
  function claim(
    running: MaintenanceServiceJob,
    consumedAt = new Date(now).toISOString(),
    edit?: (record: MaintenanceServiceEvidenceRecord) => void,
  ) {
    const evidence = proof(running);
    edit?.(evidence.record);
    evidence.sha256 = maintenanceServiceEvidenceDigest(evidence.record);
    const job: MaintenanceServiceJob = {
      ...retain(running, evidence),
      revision: randomUUID(),
      effectIntent: {
        id: randomUUID(),
        generation: running.reservation!.generation,
        requestRevision: running.reservation!.requestRevision,
        nativeEvidenceSha256: evidence.sha256,
        executor: processIdentity,
        consumedAt,
      },
    };
    adapter.journal.mutate!(
      (jobs) => jobs.map((current) => (current.id === job.id ? job : current)),
      evidence,
    );
    return job;
  }
  function observe(
    running: MaintenanceServiceJob,
    outcome: "candidate" | "previous" | "unknown",
    ready: boolean,
  ) {
    const evidence = proof(running, running.reservation!.requestRevision);
    const selected = outcome === "previous" ? running.proposal.previous! : running.proposal;
    evidence.record.sourceCommit = selected.sourceCommit;
    evidence.record.artifactSha256 = selected.artifactSha256;
    evidence.record.native.selection.sourceCommit = selected.sourceCommit;
    evidence.record.native.selection.artifactSha256 = selected.artifactSha256;
    evidence.sha256 = maintenanceServiceEvidenceDigest(evidence.record);
    let status: MaintenanceServiceJob["status"] = "running";
    if (ready) status = outcome === "candidate" ? "succeeded" : "failed";
    const job: MaintenanceServiceJob = {
      ...retain(running, evidence),
      revision: randomUUID(),
      status,
      observation: {
        requestId: running.id,
        requestRevision: running.reservation!.requestRevision,
        generation: running.reservation!.generation,
        planSha256: running.proposal.planSha256,
        identitySha256: running.proposal.identitySha256,
        outcome,
        sourceCommit: selected.sourceCommit,
        artifactSha256: selected.artifactSha256,
        ready,
        evidenceSha256: evidence.sha256,
        observedAt: evidence.record.observedAt,
      },
    };
    return { job, evidence };
  }
  return {
    ...f,
    adapter,
    pending,
    proof,
    retain,
    approve,
    reserve,
    claim,
    observe,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test("native approval accepts separately retained queue inspection and reservation evidence", async () => {
  const f = serviceAdmissionFixture();
  const { requireServiceApproval, requireServiceAdmissionEvidence } =
    await import("../coordinator-bootstrap-maintenance-service-binding.js");
  const approvalProof = f.proof(f.pending);
  const approved = approveServiceJob(
    f.pending,
    f.adapter.serviceAuthority(f.pending)!,
    approvalProof,
    f.now(),
  );
  f.adapter.journal.mutate!(
    (jobs) => jobs.map((job) => (job.id === approved.id ? approved : job)),
    approvalProof,
  );
  f.advance(30_000);
  const reconciled = { ...approved, revision: randomUUID(), detail: "Inspection retried" };
  f.adapter.journal.write([reconciled]);
  const reservationProof = f.proof(reconciled);
  const running = reserveServiceJob(reconciled, reservationProof, f.now());
  f.adapter.journal.mutate!(
    (jobs) => jobs.map((job) => (job.id === running.id ? running : job)),
    reservationProof,
  );
  expect(f.adapter.journal.read().find((job) => job.id === running.id)).toEqual(running);
  expect(running.approval!.nativeEvidenceSha256).not.toBe(
    running.reservation!.nativeEvidenceSha256,
  );
  expect(() =>
    requireServiceApproval(running.approval!, running.reservation!, running.proposal),
  ).not.toThrow();
  expect(() => requireServiceAdmissionEvidence(running, running.reservation!)).not.toThrow();
  for (const reference of [
    running.approval!.nativeEvidenceSha256,
    running.reservation!.nativeEvidenceSha256,
  ]) {
    const missing = {
      ...running,
      evidence: running.evidence.filter((item) => item.sha256 !== reference),
    };
    expect(() => requireServiceAdmissionEvidence(missing, running.reservation!)).toThrow(
      "admission evidence",
    );
    const tampered = structuredClone(running);
    tampered.evidence.find((item) => item.sha256 === reference)!.record.sourceCommit = "0".repeat(
      40,
    );
    expect(() => requireServiceAdmissionEvidence(tampered, running.reservation!)).toThrow(
      "admission evidence",
    );
    const substituted = structuredClone(running);
    const receipt = substituted.evidence.find((item) => item.sha256 === reference)!;
    receipt.record.identitySha256 = "0".repeat(64);
    receipt.sha256 = maintenanceServiceEvidenceDigest(receipt.record);
    if (reference === substituted.approval!.nativeEvidenceSha256)
      substituted.approval!.nativeEvidenceSha256 = receipt.sha256;
    else substituted.reservation!.nativeEvidenceSha256 = receipt.sha256;
    expect(() => requireServiceAdmissionEvidence(substituted, substituted.reservation!)).toThrow(
      "admission evidence",
    );
    const duplicate = {
      ...running,
      evidence: [...running.evidence, running.evidence.find((item) => item.sha256 === reference)!],
    };
    expect(() => requireServiceAdmissionEvidence(duplicate, running.reservation!)).toThrow(
      "admission evidence",
    );
  }
});

test("service authority projects base policy fields and retains the full reviewed proposal", () => {
  const f = serviceAdmissionFixture();
  const approved = f.approve(),
    running = f.reserve(approved),
    claimed = f.claim(running);
  expect(running.revision).not.toBe(approved.revision);
  expect(running.reservation?.requestRevision).toBe(approved.revision);
  expect(claimed.effectIntent?.requestRevision).toBe(approved.revision);
  expect(claimed.proposal.previous).toEqual(f.pending.proposal.previous);
  const observed = f.observe(claimed, "candidate", true);
  f.adapter.journal.write([observed.job], observed.evidence);
  expect(f.adapter.journal.read()[0].status).toBe("succeeded");
  expect(observed.job.observation?.requestRevision).toBe(approved.revision);
  expect(() => f.adapter.journal.write([running], f.proof(claimed))).toThrow();
});

test("service custody and current revision are checked before durable reservation", () => {
  const f = serviceAdmissionFixture(),
    approved = f.approve();
  const running = f.reserve(approved);
  const proof = f.proof(running);
  proof.assertCurrent = () => {
    throw new Error("Native custody changed");
  };
  const next = f.retain(
    {
      ...running,
      revision: randomUUID(),
      effectIntent: {
        id: randomUUID(),
        generation: running.reservation!.generation,
        requestRevision: approved.revision,
        nativeEvidenceSha256: proof.sha256,
        executor: proof.record.native.process!,
        consumedAt: proof.record.observedAt,
      },
    },
    proof,
  );
  expect(() => f.adapter.journal.write([next], proof)).toThrow("custody changed");
  expect(f.adapter.journal.read()).toEqual([running]);
  const stale = { ...proof, assertCurrent() {}, expectedRevision: approved.revision };
  expect(() => f.adapter.journal.write([next], stale)).toThrow("journal revision changed");
  expect(f.adapter.journal.read()).toEqual([running]);
});

test("revoked services permit native observation but cannot reserve another effect", () => {
  const f = serviceAdmissionFixture(),
    approved = f.approve(),
    running = f.reserve(approved),
    claimed = f.claim(running);
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const unknown = f.observe(claimed, "unknown", false);
  delete unknown.evidence.record.executor;
  unknown.evidence.sha256 = maintenanceServiceEvidenceDigest(unknown.evidence.record);
  unknown.job.evidence[unknown.job.evidence.length - 1].sha256 = unknown.evidence.sha256;
  unknown.job.observation!.evidenceSha256 = unknown.evidence.sha256;
  f.adapter.journal.write([unknown.job], unknown.evidence);
  const candidate = f.observe(unknown.job, "candidate", true);
  f.adapter.journal.write([candidate.job], candidate.evidence);
  expect(f.adapter.journal.read()[0].status).toBe("succeeded");
});

test("unknown and previous service observations cannot masquerade as candidate success", () => {
  const f = serviceAdmissionFixture(),
    running = f.claim(f.reserve(f.approve()));
  const unknown = f.observe(running, "unknown", true);
  expect(() => f.adapter.journal.write([unknown.job], unknown.evidence)).toThrow(
    "Unknown service readiness",
  );
  const previous = f.observe(running, "previous", true);
  expect(() =>
    f.adapter.journal.write([{ ...previous.job, status: "succeeded" }], previous.evidence),
  ).toThrow("rollback readiness");
  f.adapter.journal.write([previous.job], previous.evidence);
  expect(f.adapter.journal.read()[0].status).toBe("failed");
});

test("service reservation pins approved identity after a later journal metadata revision", () => {
  const f = serviceAdmissionFixture(),
    approved = f.approve();
  const retry = { ...approved, revision: randomUUID(), detail: "Native inspection delayed" };
  f.adapter.journal.write([retry]);
  const running = f.reserve(retry);
  expect(running.reservation?.requestRevision).toBe(approved.revision);
  expect(running.reservation?.requestRevision).not.toBe(retry.revision);
});
test("service native claims reject revoked authority and asynchronous custody", () => {
  const f = serviceAdmissionFixture(),
    running = f.reserve(f.approve());
  const result = f.observe(running, "previous", false);
  result.evidence.assertCurrent = async () => {};
  expect(() => f.adapter.journal.write([result.job], result.evidence)).toThrow("synchronous");
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  expect(() => f.claim(running)).toThrow();
  expect(f.adapter.journal.read()).toEqual([running]);
});
test("service candidate readiness requires a consumed native intent", () => {
  const f = serviceAdmissionFixture(),
    running = f.reserve(f.approve());
  const result = f.observe(running, "candidate", true);
  expect(() => f.adapter.journal.write([result.job], result.evidence)).toThrow(
    "consumed native intent",
  );
  expect(f.adapter.journal.read()).toEqual([running]);
});
test("service readiness refuses mismatched boot and missing native custody receipts", () => {
  const f = serviceAdmissionFixture(),
    running = f.claim(f.reserve(f.approve()));
  const observed = f.observe(running, "candidate", true);
  const mutations: Array<(record: MaintenanceServiceEvidenceRecord) => void> = [
    (record) => {
      record.native.bootId = randomUUID();
    },
    (record) => {
      record.native.service.launcherSha256 = null;
    },
    (record) => {
      record.native.service.registrationSha256 = null;
    },
    (record) => {
      record.native.selection.receiptSha256 = null;
    },
  ];
  for (const mutate of mutations) {
    const record = structuredClone(observed.evidence.record);
    mutate(record);
    const proof = {
      ...observed.evidence,
      record,
      sha256: maintenanceServiceEvidenceDigest(record),
    };
    const job = {
      ...observed.job,
      evidence: f.retain(running, proof).evidence,
      observation: { ...observed.job.observation!, evidenceSha256: proof.sha256 },
    };
    expect(() => f.adapter.journal.write([job], proof)).toThrow("rollback readiness");
    expect(f.adapter.journal.read()).toEqual([running]);
  }
});

test("service approval cannot share one durable write with competing daemon approval", () => {
  const f = serviceAdmissionFixture();
  // The real daemon fixture supplies the ordinary legacy request shape.
  const daemon = restartAdmissionFixture().pending;
  daemon.standingDecision = undefined;
  daemon.automaticApproval = undefined;
  f.adapter.journal.write([f.pending, daemon]);
  const evidence = f.proof(f.pending);
  const revision = randomUUID();
  const approved: MaintenanceServiceJob = {
    ...f.retain(f.pending, evidence),
    revision,
    status: "approved",
    approval: {
      grantId: f.state.grant.id,
      grantRevision: f.state.grant.revision,
      manifestSha256: enrollmentManifestDigest(f.manifest),
      proposalSha256: maintenanceServiceProposalDigest(f.pending.proposal),
      reviewedRevision: f.pending.revision,
      requestRevision: revision,
      nativeEvidenceSha256: evidence.sha256,
      approvedAt: evidence.record.observedAt,
      dispatchAfter: new Date(Date.parse(evidence.record.observedAt) + 30_000).toISOString(),
    },
  };
  expect(() =>
    f.adapter.journal.write(
      [approved, { ...daemon, status: "approved", revision: randomUUID() }],
      evidence,
    ),
  ).toThrow("lifecycle admission");
  expect(f.adapter.journal.read()).toEqual([f.pending, daemon]);
});
test("service claims reject future intent and candidate evidence collected before consumption", () => {
  const f = serviceAdmissionFixture(),
    running = f.reserve(f.approve());
  const before = f.proof(running).record.observedAt;
  expect(() => f.claim(running, new Date(Date.parse(before) + 1).toISOString())).toThrow(
    "exact retained reservation",
  );
  expect(f.adapter.journal.read()).toEqual([running]);
  const claimed = f.claim(running),
    observed = f.observe(claimed, "candidate", true);
  const record = {
    ...observed.evidence.record,
    observedAt: new Date(Date.parse(before) - 1).toISOString(),
  };
  const proof = { ...observed.evidence, record, sha256: maintenanceServiceEvidenceDigest(record) };
  const job = {
    ...observed.job,
    evidence: f.retain(claimed, proof).evidence,
    observation: {
      ...observed.job.observation!,
      evidenceSha256: proof.sha256,
      observedAt: record.observedAt,
    },
  };
  expect(() => f.adapter.journal.write([job], proof)).toThrow("predates native effect consumption");
  expect(f.adapter.journal.read()).toEqual([claimed]);
});

function serviceQueueFixture() {
  const f = serviceAdmissionFixture();
  let executed = 0,
    observed = 0;
  let beforeInspect: (() => void) | undefined;
  const native: MaintenanceServiceExecutor = {
    inspect: async (job: MaintenanceServiceJob) => {
      const proof = f.proof(job);
      beforeInspect?.();
      return { ...proof.record, evidenceSha256: proof.sha256, assertCurrent: proof.assertCurrent };
    },
    execute: async (job: MaintenanceServiceJob) => {
      executed++;
      f.claim(job);
      throw new Error("Native start reply was lost");
    },
    observe: async (job: MaintenanceServiceJob) => {
      observed++;
      const result = f.observe(job, "candidate", true);
      return {
        ...result.job.observation!,
        record: result.evidence.record,
        assertCurrent: result.evidence.assertCurrent,
      };
    },
  };
  const create = () =>
    new InstallationRestarts(
      f.adapter.journal,
      {
        restart: async () => {
          throw new Error("Daemon dispatch is outside this test");
        },
        maintenanceServices: native,
      },
      f.now,
      { serviceAuthority: f.adapter.serviceAuthority },
    );
  return {
    ...f,
    create,
    counts: () => ({ executed, observed }),
    setNative: (overrides: Partial<MaintenanceServiceExecutor>) => Object.assign(native, overrides),
    onInspect: (callback: () => void) => {
      beforeInspect = callback;
    },
  };
}
test("service queue observes lost native replies after reopening without repeating execution", async () => {
  const f = serviceQueueFixture(),
    queue = f.create();
  await queue.drain();
  const approved = queue.listServices()[0];
  expect(approved.status).toBe("approved");
  await queue.drain();
  expect(f.counts()).toEqual({ executed: 0, observed: 0 });
  f.advance(30_000);
  await queue.drain();
  expect(f.counts()).toEqual({ executed: 1, observed: 0 });
  const running = queue.listServices()[0];
  expect(running.status).toBe("running");
  expect(running.effectIntent?.requestRevision).toBe(approved.revision);
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const reopened = f.create();
  f.advance(5000);
  await reopened.drain();
  expect(reopened.listServices()[0].status).toBe("succeeded");
  expect(f.counts()).toEqual({ executed: 1, observed: 1 });
  await reopened.drain();
  expect(f.counts()).toEqual({ executed: 1, observed: 1 });
});
test("service queue cancellation during asynchronous inspection prevents approval and dispatch", async () => {
  const f = serviceQueueFixture(),
    queue = f.create();
  f.onInspect(() => queue.cancelService(f.pending.id, f.pending.revision));
  await queue.drain();
  expect(queue.listServices()[0].status).toBe("rejected");
  expect(f.counts()).toEqual({ executed: 0, observed: 0 });
});

test("service queue cancellation preserves an unrelated request added after startup", () => {
  const f = serviceQueueFixture(),
    queue = f.create();
  const daemon = restartAdmissionFixture().pending;
  f.adapter.journal.mutate!((jobs) => [...jobs, daemon]);
  const cancelled = queue.cancelService(f.pending.id, f.pending.revision);
  expect(f.adapter.journal.read()).toEqual([cancelled, daemon]);
});
test("service queue revocation cancels approval before native dispatch", async () => {
  const f = serviceQueueFixture(),
    queue = f.create();
  await queue.drain();
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  f.advance(30_000);
  await queue.drain();
  expect(queue.listServices()[0].status).toBe("rejected");
  expect(f.counts()).toEqual({ executed: 0, observed: 0 });
});
test("service queue submission preserves requester origin and exact retry identity", () => {
  const f = serviceQueueFixture(),
    queue = f.create();
  expect(queue.requestService(f.pending.proposal, f.pending.reason, "container-agent").id).toBe(
    f.pending.id,
  );
  expect(
    queue.requestService(f.pending.proposal, f.pending.reason, "container-agent").revision,
  ).toBe(f.pending.revision);
  expect(() => queue.requestService(f.pending.proposal, f.pending.reason, "host-agent")).toThrow(
    "requester",
  );
  expect(() =>
    queue.requestService(
      { ...f.pending.proposal, sourceCommit: "0".repeat(40) },
      f.pending.reason,
      "container-agent",
    ),
  ).toThrow("different maintenance");
  expect(f.adapter.journal.read()).toEqual([f.pending]);
});

test("service queue cancels revoked approval after exhausting inspection checks", async () => {
  const f = serviceQueueFixture(),
    queue = f.create();
  await queue.drain();
  let inspected = 0;
  f.setNative({
    inspect: async () => {
      inspected++;
      throw new Error("Native inspection unavailable");
    },
  });
  for (const delay of [30_000, 15_000, 45_000]) {
    f.advance(delay);
    await queue.drain();
  }
  expect(queue.listServices()[0].reconciliation?.attempts).toBe(3);
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  await queue.drain();
  expect(queue.listServices()[0].status).toBe("rejected");
  expect(inspected).toBe(3);
  expect(f.counts()).toEqual({ executed: 0, observed: 0 });
});
test("service queue bounds a hung inspection and permits later drain cycles", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const f = serviceQueueFixture(),
      queue = f.create();
    f.setNative({ inspect: () => new Promise(() => {}) });
    const drain = queue.drain();
    await vi.advanceTimersByTimeAsync(30_000);
    await drain;
    expect(queue.listServices()[0].reconciliation?.attempts).toBe(1);
    f.advance(5000);
    const retry = queue.drain();
    await vi.advanceTimersByTimeAsync(30_000);
    await retry;
    expect(queue.listServices()[0].reconciliation?.attempts).toBe(2);
    expect(f.counts()).toEqual({ executed: 0, observed: 0 });
  } finally {
    vi.useRealTimers();
  }
});

test("service queue ignores late execute replies after timeout and observes the retained generation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const f = serviceQueueFixture(),
      queue = f.create();
    await queue.drain();
    f.advance(30_000);
    let executed = 0;
    let complete: ((value: MaintenanceServiceNativeObservation) => void) | undefined;
    let late: MaintenanceServiceNativeObservation | undefined;
    f.setNative({
      execute: async (job) => {
        executed++;
        const claimed = f.claim(job),
          result = f.observe(claimed, "candidate", true);
        late = {
          ...result.job.observation!,
          record: result.evidence.record,
          assertCurrent: result.evidence.assertCurrent,
        };
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const drain = queue.drain();
    await vi.advanceTimersByTimeAsync(30_000);
    await drain;
    expect(queue.listServices()[0].status).toBe("running");
    f.advance(5000);
    await queue.drain();
    expect(queue.listServices()[0].status).toBe("succeeded");
    const retained = f.adapter.journal.read();
    complete!(late!);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.adapter.journal.read()).toEqual(retained);
    expect(executed).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
test("service queue keeps observing a timed-out generation after saturated checks and reopening", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const f = serviceQueueFixture(),
      queue = f.create();
    const readyObservation = f.setNative({}).observe;
    let executions = 0,
      observations = 0,
      ready = false;
    f.setNative({
      execute: async (job) => {
        executions++;
        f.claim(job);
        return new Promise(() => {});
      },
      observe: async (job, reservation) => {
        observations++;
        if (!ready) throw new Error("Retained executor has not finished");
        return readyObservation(job, reservation);
      },
    });
    await queue.drain();
    f.advance(30_000);
    const execution = queue.drain();
    await vi.advanceTimersByTimeAsync(30_000);
    await execution;
    const running = queue.listServices()[0];
    expect(running.status).toBe("running");
    for (const delay of [5000, 15_000, 45_000]) {
      f.advance(delay);
      await queue.drain();
    }
    expect(observations).toBe(3);
    expect(queue.listServices()[0].reconciliation?.attempts).toBe(3);
    changeStandingGrant(f.journal, {
      expectedRevision: f.state.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
    const reopened = f.create();
    f.advance(44_999);
    await reopened.drain();
    expect(observations).toBe(3);
    f.advance(1);
    await reopened.drain();
    expect(observations).toBe(4);
    expect(reopened.listServices()[0].reconciliation?.attempts).toBe(3);
    await reopened.drain();
    expect(observations).toBe(4);
    ready = true;
    f.advance(45_000);
    await reopened.drain();
    const terminal = reopened.listServices()[0];
    expect(terminal.status).toBe("succeeded");
    expect(terminal.reservation).toEqual(running.reservation);
    expect(terminal.effectIntent).toEqual(running.effectIntent);
    expect(executions).toBe(1);
    expect(observations).toBe(5);
  } finally {
    vi.useRealTimers();
  }
});

test("service queue bounds a hung observation without replaying native execution", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const f = serviceQueueFixture(),
      queue = f.create();
    await queue.drain();
    f.advance(30_000);
    await queue.drain();
    f.advance(5000);
    f.setNative({ observe: () => new Promise(() => {}) });
    const drain = queue.drain();
    await vi.advanceTimersByTimeAsync(30_000);
    await drain;
    expect(queue.listServices()[0].reconciliation?.attempts).toBe(2);
    await queue.drain();
    expect(f.counts().executed).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("service queue gives post-dispatch observation its own bounded check budget", async () => {
  const f = serviceQueueFixture(),
    queue = f.create();
  await queue.drain();
  const inspect = f.setNative({}).inspect;
  f.setNative({
    inspect: async () => {
      throw new Error("Temporary inspection failure");
    },
  });
  f.advance(30_000);
  await queue.drain();
  f.advance(5000);
  await queue.drain();
  expect(queue.listServices()[0].reconciliation?.attempts).toBe(2);
  f.setNative({ inspect });
  f.advance(15_000);
  await queue.drain();
  expect(queue.listServices()[0].status).toBe("running");
  expect(queue.listServices()[0].reconciliation?.attempts).toBe(1);
  f.advance(5000);
  await queue.drain();
  expect(queue.listServices()[0].status).toBe("succeeded");
  expect(f.counts()).toEqual({ executed: 1, observed: 1 });
});

test("executor evidence preserves legacy observations and rejects incomplete new bindings", () => {
  const f = serviceAdmissionFixture();
  const record = f.proof(f.pending).record;
  delete record.executor;
  expect(MaintenanceServiceEvidenceRecordSchema.parse(record)).toEqual(record);
  const executor = {
    target: "maintenance-controller",
    identitySha256: "1".repeat(64),
    planSha256: "2".repeat(64),
    sourceCommit: "3".repeat(40),
    artifactSha256: "4".repeat(64),
    runtimeDirectory: "/protected/runtime",
    setup: { path: "/protected/setup.json", sha256: "5".repeat(64) },
    node: { path: "/protected/node", sha256: "6".repeat(64) },
    entrypoint: { path: "/protected/entry.mjs", sha256: "7".repeat(64) },
    native: record.native,
  };
  const bound = { ...record, executor };
  expect(MaintenanceServiceEvidenceRecordSchema.parse(bound)).toEqual(bound);
  expect(maintenanceServiceEvidenceDigest(bound)).not.toBe(
    maintenanceServiceEvidenceDigest(record),
  );
  expect(
    MaintenanceServiceExecutorEvidenceSchema.safeParse({
      ...executor,
      native: { ...executor.native, process: null },
    }).success,
  ).toBe(false);
  expect(
    MaintenanceServiceExecutorEvidenceSchema.safeParse({
      ...executor,
      native: { ...executor.native, service: { ...executor.native.service, registered: false } },
    }).success,
  ).toBe(false);
  expect(
    MaintenanceServiceExecutorEvidenceSchema.safeParse({
      ...executor,
      native: {
        ...executor.native,
        selection: { ...executor.native.selection, receiptSha256: null },
      },
    }).success,
  ).toBe(false);
  expect(
    MaintenanceServiceExecutorEvidenceSchema.safeParse({
      ...executor,
      currentRevision: f.pending.revision,
    }).success,
  ).toBe(false);
});

test("new service effects require enrolled executor proof without changing the journal on refusal", () => {
  const f = serviceAdmissionFixture();
  expect(() =>
    f.approve((record) => {
      delete record.executor;
    }),
  ).toThrow("selected executor evidence");
  expect(f.adapter.journal.read()).toEqual([f.pending]);
  expect(() =>
    f.approve((record) => {
      record.executor!.identitySha256 = "0".repeat(64);
    }),
  ).toThrow("enrolled custody");
  expect(f.adapter.journal.read()).toEqual([f.pending]);
  expect(() =>
    f.approve((record) => {
      record.executor!.native.bootId = randomUUID();
    }),
  ).toThrow("enrolled custody");
  expect(f.adapter.journal.read()).toEqual([f.pending]);
});

test("native intent refuses executor changes after reservation and permits bookkeeping changes", () => {
  const f = serviceAdmissionFixture();
  const running = f.reserve(f.approve());
  expect(() =>
    f.claim(running, undefined, (record) => {
      record.executor!.setup.sha256 = "0".repeat(64);
    }),
  ).toThrow("changed after service reservation");
  expect(f.adapter.journal.read()).toEqual([running]);
  const updated = { ...running, detail: "Fresh bookkeeping", revision: randomUUID() };
  f.adapter.journal.write([updated]);
  expect(f.claim(updated).effectIntent?.requestRevision).toBe(running.reservation!.requestRevision);
});

test("service effects refuse internally consistent executor evidence from another boot", () => {
  const f = serviceAdmissionFixture();
  expect(() =>
    f.approve((record) => {
      const otherBoot = randomUUID();
      record.executor!.native.bootId = otherBoot;
      record.executor!.native.process = { ...record.executor!.native.process, bootId: otherBoot };
    }),
  ).toThrow("enrolled custody");
  expect(f.adapter.journal.read()).toEqual([f.pending]);
});

test("native dashboard observations reject duplicate and non-maintenance targets", async () => {
  const observation = {
    target: "maintenance-controller" as const,
    identitySha256: "a".repeat(64),
    readiness: "ready" as const,
    reason: "Native runtime verified",
    observedAt: new Date().toISOString(),
    selectedSource: "b".repeat(40),
  };
  expect(await readMaintenanceServiceObservations(async () => [observation])).toEqual([
    observation,
  ]);
  expect(await readMaintenanceServiceObservations(async () => [observation, observation])).toEqual(
    [],
  );
  expect(
    await readMaintenanceServiceObservations(async () => [{ ...observation, target: "host" }]),
  ).toEqual([]);
  expect(
    await readMaintenanceServiceObservations(async () => {
      throw new Error("Native tools unavailable");
    }),
  ).toEqual([]);
});

test("native dashboard inspection times out and discards a late ready result", async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: EnrollmentServiceObservation[]) => void;
    let signal: AbortSignal | undefined;
    const blocked = new Promise<EnrollmentServiceObservation[]>((done) => {
      resolve = done;
    });
    const reading = readMaintenanceServiceObservations(async (input) => {
      signal = input;
      return blocked;
    });
    const observed = expect(reading).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    await observed;
    expect(signal?.aborted).toBe(true);
    resolve([
      {
        target: "maintenance-controller",
        identitySha256: "a".repeat(64),
        readiness: "ready",
        reason: "Late native response",
        observedAt: new Date().toISOString(),
        selectedSource: "b".repeat(40),
      },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await reading).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("ordinary replacement cannot acquire a launcher executor even with its enrolled identity", () => {
  const f = serviceAdmissionFixture();
  expect(() =>
    f.approve((record) => {
      record.executor!.target = "recovery-launcher";
      record.executor!.identitySha256 = "b".repeat(64);
    }),
  ).toThrow("requires a linked recovery or rollback");
  expect(f.adapter.journal.read()).toEqual([f.pending]);
});

function replaceServiceRows(
  jobs: readonly LifecycleJob[],
  ...replacements: MaintenanceServiceJob[]
): LifecycleJob[] {
  const byId = new Map(replacements.map((job) => [job.id, job]));
  return jobs.map((job) => byId.get(job.id) ?? job);
}

function serviceRecoveryFixture() {
  const f = serviceAdmissionFixture();
  const originalObservation = f.observe(f.claim(f.reserve(f.approve())), "unknown", false);
  f.adapter.journal.write([originalObservation.job], originalObservation.evidence);
  const original = originalObservation.job;
  function pending(
    parent: MaintenanceServiceJob,
    operation: "recovery" | "rollback" = "recovery",
  ): MaintenanceServiceJob {
    const id = randomUUID();
    const selected = operation === "recovery" ? original.proposal : original.proposal.previous!;
    return {
      id,
      revision: randomUUID(),
      target: parent.target,
      operation,
      reason: "Resolve the exact uncertain generation",
      detail: "Awaiting native recovery proof",
      createdAt: new Date(f.now()).toISOString(),
      status: "pending",
      evidence: [],
      proposal: {
        ...original.proposal,
        id,
        operation,
        planSha256: createHash("sha256").update(id).digest("hex"),
        sourceCommit: selected.sourceCommit,
        artifactSha256: selected.artifactSha256,
        previous:
          operation === "recovery"
            ? original.proposal.previous
            : {
                sourceCommit: original.proposal.sourceCommit,
                artifactSha256: original.proposal.artifactSha256,
              },
        recoveryOf: {
          requestId: parent.id,
          generation: parent.reservation!.generation,
          planSha256: parent.reservation!.planSha256,
          observationSha256: parent.observation!.evidenceSha256,
        },
      },
    };
  }
  function consumed(job: MaintenanceServiceJob): MaintenanceServiceJob {
    const approved = randomUUID(),
      generation = randomUUID();
    const proof = f.proof(job, approved);
    return {
      ...job,
      status: "running",
      revision: randomUUID(),
      approval: {
        ...original.approval!,
        reviewedRevision: job.revision,
        requestRevision: approved,
        proposalSha256: maintenanceServiceProposalDigest(job.proposal),
        nativeEvidenceSha256: proof.sha256,
      },
      reservation: {
        ...original.reservation!,
        requestId: job.id,
        requestRevision: approved,
        generation,
        planSha256: job.proposal.planSha256,
        sourceCommit: job.proposal.sourceCommit,
        artifactSha256: job.proposal.artifactSha256,
        previous: job.proposal.previous,
        recoveryOf: job.proposal.recoveryOf,
        nativeEvidenceSha256: proof.sha256,
      },
      effectIntent: {
        ...original.effectIntent!,
        id: randomUUID(),
        generation,
        requestRevision: approved,
        nativeEvidenceSha256: proof.sha256,
      },
      observation: {
        ...original.observation!,
        requestId: job.id,
        requestRevision: approved,
        generation,
        planSha256: job.proposal.planSha256,
        sourceCommit: proof.record.sourceCommit,
        artifactSha256: proof.record.artifactSha256,
        evidenceSha256: proof.sha256,
        observedAt: proof.record.observedAt,
      },
      evidence: [{ sha256: proof.sha256, record: proof.record }],
    };
  }
  function prepare(parent = original, operation: "recovery" | "rollback" = "recovery") {
    const job = pending(parent, operation);
    f.adapter.journal.mutate!((jobs) => [...jobs, job]);
    const proof = f.proof(job);
    proof.record.executor!.target = "recovery-launcher";
    proof.record.executor!.identitySha256 = "b".repeat(64);
    proof.sha256 = maintenanceServiceEvidenceDigest(proof.record);
    const approved = approveServiceJob(job, f.adapter.serviceAuthority(job)!, proof, f.now());
    f.adapter.journal.mutate!(
      (jobs) => jobs.map((current) => (current.id === job.id ? approved : current)),
      proof,
    );
    f.advance(30_000);
    const reserveProof = f.proof(approved);
    reserveProof.record.executor = structuredClone(proof.record.executor);
    reserveProof.sha256 = maintenanceServiceEvidenceDigest(reserveProof.record);
    const running = reserveServiceJob(approved, reserveProof, f.now());
    f.adapter.journal.mutate!(
      (jobs) => jobs.map((current) => (current.id === job.id ? running : current)),
      reserveProof,
    );
    return f.claim(running, undefined, (record) => {
      record.executor = structuredClone(proof.record.executor);
    });
  }
  return { ...f, original, pending, consumed, prepare };
}

test.each(["recovery", "rollback"] as const)(
  "native %s binds distinct queue approval and reservation proofs",
  async (operation) => {
    const f = serviceRecoveryFixture();
    const claimed = f.prepare(undefined, operation);
    const { requireServiceApproval, requireServiceAdmissionEvidence } =
      await import("../coordinator-bootstrap-maintenance-service-binding.js");
    expect(claimed.approval!.nativeEvidenceSha256).not.toBe(
      claimed.reservation!.nativeEvidenceSha256,
    );
    expect(() =>
      requireServiceApproval(claimed.approval!, claimed.reservation!, claimed.proposal),
    ).not.toThrow();
    expect(() => requireServiceAdmissionEvidence(claimed, claimed.reservation!)).not.toThrow();
  },
);

function unclaimedAbsentFixture() {
  const f = serviceRecoveryFixture();
  const parent = MaintenanceServiceJobSchema.parse(f.consumed(f.pending(f.original)));
  delete parent.effectIntent;
  parent.status = "failed";
  parent.reservation!.operation = parent.operation;
  parent.reservation!.proposalSha256 = maintenanceServiceProposalDigest(parent.proposal);
  const record = structuredClone(parent.evidence[0].record);
  record.sourceCommit = null;
  record.artifactSha256 = null;
  record.native.process = null;
  record.native.service.registered = false;
  record.native.service.registrationSha256 = null;
  record.native.selection.sourceCommit = null;
  record.native.selection.artifactSha256 = null;
  const sha256 = maintenanceServiceEvidenceDigest(record);
  parent.evidence.push({ sha256, record });
  parent.observation = {
    ...parent.observation!,
    evidenceSha256: sha256,
    outcome: "unknown",
    ready: false,
    sourceCommit: null,
    artifactSha256: null,
  };
  return { ...f, parent, record };
}

function unclaimedAbsenceObservation(
  f: ReturnType<typeof serviceAdmissionFixture>,
  running: MaintenanceServiceJob,
): MaintenanceServiceNativeObservation {
  const observed = f.observe(running, "unknown", false);
  const record = observed.evidence.record;
  record.sourceCommit = null;
  record.artifactSha256 = null;
  record.native.process = null;
  record.native.service.registered = false;
  record.native.service.registrationSha256 = null;
  record.native.selection.sourceCommit = null;
  record.native.selection.artifactSha256 = null;
  const sha256 = maintenanceServiceEvidenceDigest(record);
  return {
    ...observed.job.observation!,
    sourceCommit: null,
    artifactSha256: null,
    evidenceSha256: sha256,
    record,
    assertCurrent() {},
    unclaimedAbsent: true,
  };
}

test.each(["fence-first", "claim-first"] as const)(
  "unclaimed native absence and late claim share one atomic decision: %s",
  (ordering) => {
    const f = serviceAdmissionFixture();
    const running = f.reserve(f.approve());
    const value = unclaimedAbsenceObservation(f, running);
    const record = value.record;
    const terminal = observeServiceJob(running, value, f.now());
    expect(terminal.job.status).toBe("failed");
    expect(terminal.job.observation).not.toHaveProperty("unclaimedAbsent");
    if (ordering === "claim-first") {
      const claimed = f.claim(running);
      expect(() => f.adapter.journal.write([terminal.job], terminal.proof)).toThrow();
      expect(f.adapter.journal.read()).toEqual([claimed]);
    } else {
      f.adapter.journal.write([terminal.job], terminal.proof);
      expect(() => f.claim(running)).toThrow();
      expect(f.adapter.journal.read()).toEqual([terminal.job]);
      expect(assertUnclaimedMaintenanceServiceAbsent(terminal.job)).toEqual(record);
    }
  },
);

test("service queue reopens an unclaimed generation and fences it without another dispatch", async () => {
  const f = serviceQueueFixture();
  let executions = 0;
  f.setNative({
    execute: async () => {
      executions++;
      throw new Error("Child exited before claim");
    },
    observe: async (job) => unclaimedAbsenceObservation(f, job),
  });
  const queue = f.create();
  await queue.drain();
  f.advance(30_000);
  await queue.drain();
  const running = queue.listServices()[0];
  expect(running.status).toBe("running");
  expect(running.effectIntent).toBeUndefined();
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  f.advance(5000);
  const reopened = f.create();
  await reopened.drain();
  const failed = reopened.listServices()[0];
  expect(failed.status).toBe("failed");
  expect(failed.reservation).toEqual(running.reservation);
  expect(failed.effectIntent).toBeUndefined();
  expect(() => f.claim(running)).toThrow();
  const bytes = f.adapter.journal.read();
  await reopened.drain();
  expect(f.adapter.journal.read()).toEqual(bytes);
  expect(executions).toBe(1);
});

test("ordinary unknown absence remains running without a native terminal discriminant", () => {
  const f = serviceAdmissionFixture();
  const running = f.reserve(f.approve());
  const { unclaimedAbsent: _terminal, ...ordinary } = unclaimedAbsenceObservation(f, running);
  const observed = observeServiceJob(running, ordinary, f.now());
  expect(observed.job.status).toBe("running");
  f.adapter.journal.write([observed.job], observed.proof);
  expect(() => assertUnclaimedMaintenanceServiceAbsent(observed.job)).toThrow(
    "terminal unclaimed absence",
  );
});

test("unclaimed terminal fencing requires fresh proof and permits observation after revocation", () => {
  const f = serviceAdmissionFixture();
  const running = f.reserve(f.approve());
  const stale = unclaimedAbsenceObservation(f, running);
  f.advance(30_001);
  const refused = observeServiceJob(running, stale, f.now());
  expect(() => f.adapter.journal.write([refused.job], refused.proof)).toThrow("native evidence");
  expect(f.adapter.journal.read()).toEqual([running]);
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const observed = observeServiceJob(running, unclaimedAbsenceObservation(f, running), f.now());
  f.adapter.journal.write([observed.job], observed.proof);
  expect(f.adapter.journal.read()[0].status).toBe("failed");
  expect(f.adapter.serviceAuthority(running)).toBeNull();
});

test.each([
  "running",
  "consumed",
  "ready",
  "selected",
  "process",
  "registered",
  "chronology",
  "generation",
  "revision",
  "duplicate",
  "grant",
  "missing-executor",
] as const)("unclaimed history refuses malformed native absence: %s", (mode) => {
  const f = unclaimedAbsentFixture(),
    parent = f.parent;
  const record = parent.evidence.at(-1)!.record;
  const observation = parent.observation!;
  if (mode === "running") parent.status = "running";
  if (mode === "consumed") parent.effectIntent = f.original.effectIntent;
  if (mode === "ready") observation.ready = true;
  if (mode === "selected") {
    record.sourceCommit = parent.proposal.sourceCommit;
    observation.sourceCommit = record.sourceCommit;
  }
  if (mode === "process") record.native.process = f.original.effectIntent!.executor;
  if (mode === "registered") record.native.service.registered = true;
  if (mode === "chronology") {
    record.observedAt = new Date(Date.parse(parent.reservation!.reservedAt) - 1).toISOString();
    observation.observedAt = record.observedAt;
  }
  if (mode === "generation") observation.generation = randomUUID();
  if (mode === "revision") record.requestRevision = randomUUID();
  if (mode === "grant") parent.reservation!.grantRevision = randomUUID();
  if (mode === "missing-executor") {
    const retained = parent.evidence.find(
      (item) => item.sha256 === parent.reservation!.nativeEvidenceSha256,
    )!;
    delete retained.record.executor;
    retained.sha256 = maintenanceServiceEvidenceDigest(retained.record);
    parent.reservation!.nativeEvidenceSha256 = retained.sha256;
  }
  const sha256 = maintenanceServiceEvidenceDigest(record);
  parent.evidence.at(-1)!.sha256 = sha256;
  observation.evidenceSha256 = sha256;
  if (mode === "duplicate") parent.evidence.push({ sha256, record });
  expect(() => assertUnclaimedMaintenanceServiceAbsent(parent)).toThrow();
  const leaf = f.pending(parent);
  expect(() =>
    maintenanceRecoveryAncestors({ jobs: [f.original, parent], job: leaf, retryLimit: 3 }),
  ).toThrow();
});

test("recovery history accepts only an addressed terminal unclaimed absence", () => {
  const f = unclaimedAbsentFixture();
  expect(assertUnclaimedMaintenanceServiceAbsent(f.parent)).toEqual(f.record);
  const leaf = f.pending(f.parent);
  expect(
    maintenanceRecoveryAncestors({ jobs: [f.original, f.parent], job: leaf, retryLimit: 3 }),
  ).toEqual([f.parent, f.original]);
});

test("recovery history follows immediate generations while preserving original slot choice", () => {
  const f = serviceRecoveryFixture();
  const first = f.consumed(f.pending(f.original));
  const rollback = f.pending(first, "rollback");
  const jobs = [f.original, first, rollback];
  const before = structuredClone(jobs);
  expect(maintenanceRecoveryAncestors({ jobs, job: rollback, retryLimit: 3 })).toEqual([
    first,
    f.original,
  ]);
  assertMaintenanceRecoveryExclusion({ jobs, job: rollback, retryLimit: 3 });
  expect(jobs).toEqual(before);
  expect(rollback.proposal.sourceCommit).toBe(f.original.proposal.previous!.sourceCommit);
});

test("recovery history rejects skipped unresolved generations and competing successors", () => {
  const f = serviceRecoveryFixture();
  const first = f.consumed(f.pending(f.original));
  const skipped = f.pending(f.original, "rollback");
  expect(() =>
    assertMaintenanceRecoveryExclusion({
      jobs: [f.original, first, skipped],
      job: skipped,
      retryLimit: 3,
    }),
  ).toThrow("Another maintenance generation");
  const leaf = f.pending(first);
  const sibling = { ...f.pending(first), status: "approved" as const };
  expect(() =>
    assertMaintenanceRecoveryExclusion({
      jobs: [f.original, first, sibling, leaf],
      job: leaf,
      retryLimit: 3,
    }),
  ).toThrow("Another maintenance generation");
});

test("recovery history rejects stale links, missing evidence and unreviewed slots", () => {
  const f = serviceRecoveryFixture();
  const leaf = f.pending(f.original);
  const check = (job: MaintenanceServiceJob, parent = f.original) =>
    maintenanceRecoveryAncestors({ jobs: [parent], job, retryLimit: 3 });
  expect(() =>
    check({
      ...leaf,
      proposal: {
        ...leaf.proposal,
        recoveryOf: { ...leaf.proposal.recoveryOf!, generation: randomUUID() },
      },
    }),
  ).toThrow("consumed uncertain predecessor");
  expect(() => check(leaf, { ...f.original, evidence: [] })).toThrow("addressed native evidence");
  expect(() =>
    check({ ...leaf, proposal: { ...leaf.proposal, sourceCommit: "0".repeat(40) } }),
  ).toThrow("unreviewed original runtime");
  expect(() => check(leaf, { ...f.original, status: "succeeded" })).toThrow(
    "consumed uncertain predecessor",
  );
});

test("recovery retry budget spans successive generations and cycle detection is explicit", () => {
  const f = serviceRecoveryFixture();
  const first = f.consumed(f.pending(f.original));
  const second = f.consumed(f.pending(first));
  const third = f.consumed(f.pending(second));
  const fourth = f.pending(third);
  expect(() =>
    maintenanceRecoveryAncestors({
      jobs: [f.original, first, second, third],
      job: fourth,
      retryLimit: 3,
    }),
  ).toThrow("retry budget is exhausted");
  const cycle = f.pending(f.original);
  cycle.proposal.recoveryOf!.requestId = cycle.id;
  expect(() =>
    maintenanceRecoveryAncestors({ jobs: [f.original], job: cycle, retryLimit: 3 }),
  ).toThrow("contains a cycle");
});

test("recovery admission reserves the exact launcher generation and preserves unrelated history", () => {
  const f = serviceRecoveryFixture();
  const recovery = f.prepare();
  const reopened = new FileBootstrapRequestJournal(f.directory).readLifecycle();
  expect(reopened).toEqual([f.original, recovery]);
  expect(recovery.effectIntent?.requestRevision).toBe(recovery.approval?.requestRevision);
  expect(recovery.reservation?.recoveryOf).toEqual(recovery.proposal.recoveryOf);
  expect(recovery.evidence.at(-1)?.record.executor?.target).toBe("recovery-launcher");
});

test("ready recovery atomically resolves ancestors without changing their original evidence", () => {
  const f = serviceRecoveryFixture();
  const recovery = f.prepare();
  const result = f.observe(recovery, "candidate", true);
  const before = f.adapter.journal.read();
  expect(() =>
    f.adapter.journal.mutate!((jobs) => replaceServiceRows(jobs, result.job), result.evidence),
  ).toThrow("atomically resolve");
  expect(f.adapter.journal.read()).toEqual(before);
  const resolved = {
    ...f.original,
    revision: randomUUID(),
    status: "failed" as const,
    detail: "A reviewed recovery generation restored readiness.",
    resolvedBy: {
      requestId: result.job.id,
      generation: result.job.reservation!.generation,
      planSha256: result.job.proposal.planSha256,
      observationSha256: result.job.observation!.evidenceSha256,
    },
  };
  f.adapter.journal.mutate!(
    (jobs) => replaceServiceRows(jobs, result.job, resolved),
    result.evidence,
  );
  expect(new FileBootstrapRequestJournal(f.directory).readLifecycle()).toEqual([
    resolved,
    result.job,
  ]);
  expect(resolved.observation).toEqual(f.original.observation);
  expect(resolved.effectIntent).toEqual(f.original.effectIntent);
  expect(resolved.evidence).toEqual(f.original.evidence);
  expect(() =>
    f.adapter.journal.mutate!((jobs) =>
      replaceServiceRows(jobs, { ...resolved, detail: "rewritten", revision: randomUUID() }),
    ),
  ).toThrow("Terminal service");
});

test("recovery admission refuses stale links and a sibling branch without changing the journal", () => {
  const f = serviceRecoveryFixture();
  const running = f.prepare();
  const before = f.adapter.journal.read();
  const sibling = f.pending(f.original);
  f.adapter.journal.mutate!((jobs) => [...jobs, sibling]);
  const proof = f.proof(sibling);
  const approved = approveServiceJob(sibling, f.adapter.serviceAuthority(sibling)!, proof, f.now());
  const retained = f.adapter.journal.read();
  expect(() =>
    f.adapter.journal.mutate!((jobs) => replaceServiceRows(jobs, approved), proof),
  ).toThrow("lifecycle admission");
  expect(f.adapter.journal.read()).toEqual(retained);
  expect(retained.slice(0, 2)).toEqual(before);
  expect(running.status).toBe("running");
  const stale = f.pending(f.original);
  stale.proposal.recoveryOf!.observationSha256 = "0".repeat(64);
  expect(() => f.adapter.journal.mutate!((jobs) => [...jobs, stale])).toThrow(
    "consumed uncertain predecessor",
  );
  expect(f.adapter.journal.read()).toEqual(retained);
});

test("unknown recovery cannot resolve an ancestor and revoked authority cannot reserve a new effect", () => {
  const f = serviceRecoveryFixture();
  const recovery = f.prepare();
  f.advance(1);
  const result = f.observe(recovery, "unknown", false);
  const resolved = {
    ...f.original,
    revision: randomUUID(),
    status: "failed" as const,
    resolvedBy: {
      requestId: recovery.id,
      generation: recovery.reservation!.generation,
      planSha256: recovery.proposal.planSha256,
      observationSha256: result.job.observation!.evidenceSha256,
    },
  };
  const before = f.adapter.journal.read();
  expect(() =>
    f.adapter.journal.mutate!(
      (jobs) => replaceServiceRows(jobs, result.job, resolved),
      result.evidence,
    ),
  ).toThrow("verified descendant observation");
  expect(f.adapter.journal.read()).toEqual(before);
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    disabledTargets: [],
    paused: false,
    revoke: true,
  });
  f.adapter.journal.mutate!((jobs) => replaceServiceRows(jobs, result.job), result.evidence);
  const successor = f.pending(result.job);
  f.adapter.journal.mutate!((jobs) => [...jobs, successor]);
  const proof = f.proof(successor);
  const approved = approveServiceJob(
    successor,
    {
      grantId: recovery.approval!.grantId,
      grantRevision: recovery.approval!.grantRevision,
      manifestSha256: recovery.approval!.manifestSha256,
      proposalSha256: maintenanceServiceProposalDigest(successor.proposal),
    },
    proof,
    f.now(),
  );
  const revoked = f.adapter.journal.read();
  expect(() =>
    f.adapter.journal.mutate!((jobs) => replaceServiceRows(jobs, approved), proof),
  ).toThrow();
  expect(f.adapter.journal.read()).toEqual(revoked);
});

test("recovery queue follows the successor and resolves history after a lost reply and revocation", async () => {
  const f = serviceRecoveryFixture();
  const executed: string[] = [],
    observed: string[] = [];
  const native: MaintenanceServiceExecutor = {
    operations: ["replacement", "recovery", "rollback"],
    inspect: async (job) => {
      const proof = f.proof(job);
      proof.record.executor!.target = "recovery-launcher";
      proof.record.executor!.identitySha256 = "b".repeat(64);
      proof.sha256 = maintenanceServiceEvidenceDigest(proof.record);
      return { ...proof.record, evidenceSha256: proof.sha256, assertCurrent: proof.assertCurrent };
    },
    execute: async (job) => {
      executed.push(job.id);
      const reserved = job.evidence.find(
        (item) => item.sha256 === job.reservation!.nativeEvidenceSha256,
      )!;
      f.claim(job, undefined, (record) => {
        record.executor = structuredClone(reserved.record.executor);
      });
      throw new Error("Lost native reply");
    },
    observe: async (job) => {
      observed.push(job.id);
      const result = f.observe(job, "candidate", true);
      return {
        ...result.job.observation!,
        record: result.evidence.record,
        assertCurrent: result.evidence.assertCurrent,
      };
    },
  };
  const create = () =>
    new InstallationRestarts(
      f.adapter.journal,
      {
        restart: async () => {
          throw new Error("No daemon effect");
        },
        maintenanceServices: native,
      },
      f.now,
      { serviceAuthority: f.adapter.serviceAuthority },
    );
  const queue = create();
  const pending = f.pending(f.original, "rollback");
  queue.requestService(pending.proposal, pending.reason, pending.proposal.requestedBy);
  await queue.drain();
  expect(queue.listServices().find((job) => job.id === pending.id)?.status).toBe("approved");
  expect(observed).toEqual([]);
  f.advance(30_000);
  await queue.drain();
  expect(executed).toEqual([pending.id]);
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  f.advance(5000);
  const reopened = create();
  await reopened.drain();
  const jobs = reopened.listServices();
  const original = jobs.find((job) => job.id === f.original.id)!;
  const restored = jobs.find((job) => job.id === pending.id)!;
  expect(restored.status).toBe("succeeded");
  expect(restored.proposal.sourceCommit).toBe(f.original.proposal.previous!.sourceCommit);
  expect(original.status).toBe("failed");
  expect(original.resolvedBy?.requestId).toBe(restored.id);
  expect(original.observation).toEqual(f.original.observation);
  expect(original.evidence).toEqual(f.original.evidence);
  await reopened.drain();
  expect(executed).toEqual([pending.id]);
  expect(observed).toEqual([pending.id]);
});

test("replacement-only producers cannot accept a recovery request", () => {
  const f = serviceQueueFixture();
  const queue = f.create();
  const recovery = serviceRecoveryFixture();
  const pending = recovery.pending(recovery.original);
  expect(queue.serviceMaintenanceOperations()).toEqual(["replacement"]);
  expect(() =>
    queue.requestService(pending.proposal, pending.reason, pending.proposal.requestedBy),
  ).toThrow("supported operation");
  expect(queue.listServices()).toEqual([f.pending]);
});

test("one recovery observation resolves every uncertain ancestor in the same journal write", () => {
  const f = serviceRecoveryFixture();
  const first = f.prepare();
  f.advance(1);
  const uncertain = f.observe(first, "unknown", false);
  f.adapter.journal.mutate!(
    (jobs) => retainServiceRecoveryObservation(jobs, first, uncertain.job),
    uncertain.evidence,
  );
  const leaf = f.prepare(uncertain.job, "rollback");
  f.advance(1);
  const result = f.observe(leaf, "candidate", true);
  const before = f.adapter.journal.read();
  f.adapter.journal.mutate!(
    (jobs) => retainServiceRecoveryObservation(jobs, leaf, result.job),
    result.evidence,
  );
  const retained = new FileBootstrapRequestJournal(f.directory)
    .readLifecycle()
    .filter(
      (job): job is MaintenanceServiceJob =>
        job.target === "maintenance-controller" || job.target === "recovery-launcher",
    );
  expect(retained.at(-1)?.status).toBe("succeeded");
  for (const ancestor of retained.slice(0, -1)) {
    const original = before.find((job) => job.id === ancestor.id) as MaintenanceServiceJob;
    expect(ancestor.status).toBe("failed");
    expect(ancestor.resolvedBy?.requestId).toBe(leaf.id);
    expect(ancestor.observation).toEqual(original.observation);
    expect(ancestor.effectIntent).toEqual(original.effectIntent);
    expect(ancestor.reservation).toEqual(original.reservation);
    expect(ancestor.evidence).toEqual(original.evidence);
  }
  expect(() =>
    f.adapter.journal.mutate!(
      (jobs) => retainServiceRecoveryObservation(jobs, leaf, result.job),
      result.evidence,
    ),
  ).toThrow("journal changed");
});

test("reopened replacement-only producer observes recovery through a failed recovery predecessor", async () => {
  const f = serviceRecoveryFixture();
  const first = f.prepare();
  f.advance(1);
  const uncertain = f.observe(first, "unknown", false);
  f.adapter.journal.mutate!(
    (jobs) => retainServiceRecoveryObservation(jobs, first, uncertain.job),
    uncertain.evidence,
  );
  const leaf = f.prepare(uncertain.job);
  // Seed retained history from an older writer. New uncertainty stays running;
  // older failed, unready generations still need observation and recovery.
  const failed = { ...uncertain.job, status: "failed" as const };
  const history = replaceServiceRows(f.adapter.journal.read(), failed);
  writeFileSync(path.join(f.directory, "restart-jobs.json"), JSON.stringify(history), {
    mode: 0o600,
  });
  changeStandingGrant(f.journal, {
    expectedRevision: f.state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  f.advance(1);
  const checked: string[] = [];
  const queue = new InstallationRestarts(
    f.adapter.journal,
    {
      restart: async () => {
        throw new Error("No daemon execution");
      },
      maintenanceServices: {
        inspect: async () => {
          throw new Error("No new inspection");
        },
        execute: async () => {
          throw new Error("No execution replay");
        },
        observe: async (job) => {
          checked.push(job.id);
          const result = f.observe(job, "candidate", true);
          return {
            ...result.job.observation!,
            record: result.evidence.record,
            assertCurrent: result.evidence.assertCurrent,
          };
        },
      },
    },
    f.now,
    { serviceAuthority: f.adapter.serviceAuthority },
  );
  await queue.drain();
  expect(checked).toEqual([leaf.id]);
  expect(queue.listServices().find((job) => job.id === leaf.id)?.status).toBe("succeeded");
  expect(queue.listServices().find((job) => job.id === first.id)?.resolvedBy?.requestId).toBe(
    leaf.id,
  );
});

test("rollback-only producer retains the failed replacement while selecting its recovery work", async () => {
  const f = serviceRecoveryFixture();
  const original = { ...f.original, status: "failed" as const };
  writeFileSync(path.join(f.directory, "restart-jobs.json"), JSON.stringify([original]), {
    mode: 0o600,
  });
  const pending = f.pending(original, "rollback");
  const inspected: string[] = [];
  const queue = new InstallationRestarts(
    f.adapter.journal,
    {
      restart: async () => {
        throw new Error("No daemon execution");
      },
      maintenanceServices: {
        operations: ["rollback"],
        inspect: async (job) => {
          inspected.push(job.id);
          const proof = f.proof(job);
          proof.record.executor!.target = "recovery-launcher";
          proof.record.executor!.identitySha256 = "b".repeat(64);
          proof.sha256 = maintenanceServiceEvidenceDigest(proof.record);
          return {
            ...proof.record,
            evidenceSha256: proof.sha256,
            assertCurrent: proof.assertCurrent,
          };
        },
        execute: async () => {
          throw new Error("Cancellation interval has not elapsed");
        },
        observe: async () => {
          throw new Error("No existing running generation");
        },
      },
    },
    f.now,
    { serviceAuthority: f.adapter.serviceAuthority },
  );
  queue.requestService(pending.proposal, pending.reason, pending.proposal.requestedBy);
  await queue.drain();
  expect(inspected).toEqual([pending.id]);
  expect(queue.listServices().find((job) => job.id === pending.id)?.status).toBe("approved");
  expect(queue.listServices().find((job) => job.id === original.id)).toEqual(original);
});

function initialHostPlanFixture(
  preparePlan?: (plan: ReturnType<typeof InitialHostSupervisorMigrationPlanSchema.parse>) => void,
  operations: InstallationEnrollmentManifest["targets"][number]["operations"] = ["replacement"],
) {
  const f = fixture();
  const uid = process.getuid!();
  const file = (name: string) => ({ path: path.join(f.directory, name), sha256: "a".repeat(64) });
  const legacy = path.join(f.directory, "legacy");
  const identity = {
    version: 1 as const,
    environment: "host" as const,
    target: "host" as const,
    installationId: f.manifest.installationId,
    custodyOwnerUid: uid,
    installationRoot: f.directory,
    stateDirectory: path.join(f.directory, "home"),
    serviceDomain: `gui/${uid}`,
    serviceLabel: "local.vorteo.test.host",
    launcherPath: path.join(f.directory, "host.plist"),
    selectionPath: path.join(f.directory, "current"),
  };
  const environment = {
    PASEO_HOME: identity.stateDirectory,
    VORTEO_INSTALLATION_CLIENT_CONFIG: file("client.json").path,
  };
  const supervisor = {
    pid: 101,
    parentPid: 1,
    uid,
    bootId: randomUUID(),
    startIdentity: "100:1",
    executable: file("node").path,
    argumentsSha256: "b".repeat(64),
  };
  const precondition = InitialHostSupervisorPreconditionSchema.parse({
    version: 1,
    purpose: "initial-host-supervisor-migration",
    provenance: "service-custody-and-observed-files",
    identity,
    configuration: file("installation.json"),
    launcher: file("host.plist"),
    clientConfiguration: file("client.json"),
    node: file("node"),
    supervisorEntrypoint: {
      ...file("unused"),
      path: path.join(legacy, "packages/server/dist/scripts/supervisor-entrypoint.js"),
    },
    workerEntrypoint: {
      ...file("unused"),
      path: path.join(legacy, "packages/server/dist/server/server/daemon-worker.js"),
    },
    sourceReceipt: { ...file("unused"), path: path.join(legacy, ".installation-source.json") },
    selectedRelease: legacy,
    sourceCommit: "b".repeat(40),
    serverId: "host-fixture",
    workerInstanceId: null,
    workerInstanceSupport: "unsupported",
    hostEndpoint: "127.0.0.1:1234",
    registration: {
      program: null,
      arguments: [
        file("node").path,
        path.join(identity.selectionPath, "packages/server/dist/scripts/supervisor-entrypoint.js"),
      ],
      environment,
      loadedEnvironment: environment,
    },
    supervisor,
    worker: { ...supervisor, pid: 102, parentPid: 101, startIdentity: "101:1" },
  });
  const release = (name: string, source: string, artifact: string) => ({
    directory: path.join(f.directory, name),
    sourceCommit: source.repeat(40),
    artifactSha256: artifact.repeat(64),
    node: precondition.node,
    configuration: precondition.configuration,
    launcher: file(name + "/host.plist"),
    entrypoint: file(name + "/packages/server/dist/scripts/supervisor-entrypoint.js"),
  });
  const plan = InitialHostSupervisorMigrationPlanSchema.parse({
    version: 3,
    operation: "initial-host-supervisor-migration",
    managedReleaseRoot: f.directory,
    installationId: f.manifest.installationId,
    identitySha256: enrollmentNativeIdentityDigest(identity),
    preconditionSha256: createHash("sha256").update(JSON.stringify(precondition)).digest("hex"),
    precondition,
    candidate: release("candidate", "c", "d"),
    fallback: release("sealed-legacy", "b", "f"),
    fallbackProvenance: file("fallback-copy.json"),
    interruption: f.manifest.interruption,
  });
  if (preparePlan) {
    preparePlan(plan);
    plan.preconditionSha256 = createHash("sha256")
      .update(JSON.stringify(plan.precondition))
      .digest("hex");
  }
  f.manifest.targets[2] = {
    target: "host",
    identitySha256: plan.identitySha256,
    operations,
  };
  const following = { ...f.manifest.steps[1], id: randomUUID(), dependsOn: [f.second] };
  f.manifest.steps[1] = {
    id: f.second,
    target: "host",
    operation: "replacement",
    planSha256: inspectInitialHostSupervisorMigrationPlan(plan).planSha256,
    candidate: {
      sourceCommit: plan.candidate.sourceCommit,
      artifactSha256: plan.candidate.artifactSha256,
    },
    previous: {
      sourceCommit: plan.fallback.sourceCommit,
      artifactSha256: plan.fallback.artifactSha256,
    },
    dependsOn: [f.first],
  };
  f.manifest.steps.push(following);
  f.approval.manifestSha256 = enrollmentManifestDigest(f.manifest);
  const state = enrolled(f.enroll());
  const revision = state.grant.revision;
  const reserved = enrolled(
    reserveActivationStep(f.journal, { grantRevision: revision, stepId: f.first }),
  ).activation.steps[0];
  if (reserved.status !== "reserved") throw new Error("First fixture step was not reserved");
  observeActivationStep(f.journal, {
    stepId: f.first,
    generation: reserved.generation,
    outcome: "succeeded",
    observationSha256: "a".repeat(64),
  });
  const current = enrolled(
    reserveActivationStep(f.journal, { grantRevision: revision, stepId: f.second }),
  );
  const migration = current.activation.steps[1];
  if (migration.status !== "reserved") throw new Error("Host fixture step was not reserved");
  const input = {
    journal: f.journal,
    plan,
    grantId: current.grant.id,
    grantRevision: current.grant.revision,
    stepId: f.second,
    generation: migration.generation,
  };
  return { ...f, plan, input, followingId: following.id };
}

test("initial Host migration enrollment binds the whole plan and exact reservation without writing", () => {
  const f = initialHostPlanFixture();
  const file = path.join(f.directory, "maintenance-enrollment.json");
  const before = readFileSync(file);
  const locked = new FileBootstrapRequestJournal(f.directory);
  const result = locked.withRecoveryTransaction(() =>
    inspectInitialHostMigrationEnrollment(f.input),
  );
  expect(result).toEqual({
    grantId: f.input.grantId,
    grantRevision: f.input.grantRevision,
    manifestSha256: f.approval.manifestSha256,
    stepId: f.second,
    generation: f.input.generation,
    planSha256: inspectInitialHostSupervisorMigrationPlan(f.plan).planSha256,
    preconditionSha256: f.plan.preconditionSha256,
    candidate: f.manifest.steps[1].candidate,
    fallback: f.manifest.steps[1].previous,
  });
  expect(inspectInitialHostMigrationEnrollment(f.input)).toEqual(result);
  expect(readFileSync(file)).toEqual(before);
});

function initialHostIntentFixture(preparePlan?: Parameters<typeof initialHostPlanFixture>[0]) {
  const f = initialHostPlanFixture(preparePlan);
  const planSha256 = inspectInitialHostSupervisorMigrationPlan(f.plan).planSha256;
  const native = {
    precondition: f.plan.precondition,
    preconditionSha256: f.plan.preconditionSha256,
    observedAt: new Date().toISOString(),
    assertCurrent: vi.fn(() => undefined),
  };
  const artifacts = {
    plan: f.plan,
    planSha256,
    assertCurrent: vi.fn(() => undefined),
    assertPreparedCurrent: vi.fn(() => undefined),
  };
  return {
    ...f,
    native,
    artifacts,
    intentInput: { ...f.input, enrollmentStateDirectory: f.directory, native, artifacts },
  };
}

function initialHostClaimFixture(preparePlan?: Parameters<typeof initialHostPlanFixture>[0]) {
  const f = initialHostIntentFixture(preparePlan);
  const retained = reserveInitialHostMigrationIntent(f.intentInput);
  const executor = {
    process: {
      ...f.plan.precondition.supervisor,
      pid: process.pid,
      parentPid: process.ppid,
      executable: process.execPath,
      startIdentity: "200:1",
    },
    assertCurrent: vi.fn(() => undefined),
  };
  return { ...f, retained, executor, claimInput: { ...f.intentInput, executor } };
}

function initialHostActivationFixture() {
  const f = initialHostIntentFixture();
  f.journal.update((state) => {
    if (state.status !== "enrolled") throw new Error("Fixture enrollment disappeared");
    return {
      ...state,
      activation: {
        ...state.activation,
        steps: state.activation.steps.map((step) =>
          step.id === f.second ? { id: step.id, status: "pending" as const } : step,
        ),
      },
    };
  });
  const plans = path.join(f.directory, "initial-host-migrations", "plans");
  mkdirSync(plans, { recursive: true, mode: 0o700 });
  const planFile = path.join(plans, `${f.artifacts.planSha256}.json`);
  writeFileSync(planFile, JSON.stringify(f.plan), { mode: 0o600 });
  const input = {
    installationRoot: f.directory,
    stateDirectory: f.directory,
    installationId: f.plan.installationId,
  };
  const prepared = {
    native: f.native,
    artifacts: f.artifacts,
    assertCurrent: vi.fn(() => undefined),
    launch: vi.fn(async () => undefined),
  };
  const ports = { prepare: vi.fn(async () => prepared), observe: vi.fn(async () => undefined) };
  return { ...f, input, planFile, ports, prepared };
}

function hostActivationConfiguration(
  f: ReturnType<typeof initialHostActivationFixture>,
): InstallationConfig {
  const identity = f.plan.precondition.identity;
  if (identity.environment !== "host") throw new Error("Fixture Host identity missing");
  retainEnrollmentNativeIdentity(f.directory, identity);
  return {
    public: {
      version: 1,
      installationId: f.plan.installationId,
      origin: "https://installation.example",
      environments: [
        { kind: "host", serverId: "host", endpoint: "host.example", useTls: true },
        { kind: "container", serverId: "dev", endpoint: "dev.example", useTls: true },
      ],
    },
    stateDir: f.directory,
    webDistDir: f.directory,
    listenPort: 6770,
    ownerPasswordHash: "$2-fixture",
    hostAgentTokenHash: "0".repeat(64),
    containerAgentTokenHash: "1".repeat(64),
    host: {
      endpoint: "localhost:6771",
      password: "fixture",
      launchdService: `${identity.serviceDomain}/${identity.serviceLabel}`,
      startupValidation: {
        node: f.plan.precondition.node.path,
        entrypoint: f.plan.precondition.supervisorEntrypoint.path,
        home: identity.stateDirectory,
      },
    },
    container: { endpoint: "localhost:6772", password: "fixture" },
  };
}

test("native Host activation refuses fresh effects without constructing inspection tools or reserving", async () => {
  const f = initialHostActivationFixture();
  const configuration = hostActivationConfiguration(f);
  const before = readFileSync(path.join(f.directory, "maintenance-enrollment.json"));
  await expect(
    reconcileNativeInitialHostActivation({
      configuration,
      configurationFile: f.plan.precondition.configuration.path,
    }),
  ).rejects.toThrow("production interruption and child-launch custody are unavailable");
  expect(readFileSync(path.join(f.directory, "maintenance-enrollment.json"))).toEqual(before);
  expect(enrolled(f.journal.read()).activation.steps[1]).toEqual({
    id: f.second,
    status: "pending",
  });
});

test("native Host activation leaves unclaimed work unresolved without constructing observer tools", async () => {
  const f = initialHostActivationFixture();
  const configuration = hostActivationConfiguration(f);
  expect(await reconcileInitialHostActivation(f.input, f.ports)).toBe("unresolved");
  const before = readFileSync(path.join(f.directory, "maintenance-enrollment.json"));
  expect(
    await reconcileNativeInitialHostActivation({
      configuration,
      configurationFile: f.plan.precondition.configuration.path,
    }),
  ).toBe("unresolved");
  expect(readFileSync(path.join(f.directory, "maintenance-enrollment.json"))).toEqual(before);
  expect(f.prepared.launch).toHaveBeenCalledTimes(1);
});

test("native Host activation rejects a mismatched configured home before observer construction", async () => {
  const f = initialHostActivationFixture();
  const configuration = hostActivationConfiguration(f);
  configuration.host.startupValidation!.home = f.directory;
  await expect(
    reconcileNativeInitialHostActivation({
      configuration,
      configurationFile: f.plan.precondition.configuration.path,
    }),
  ).rejects.toThrow("identity differs from current configuration");
  expect(enrolled(f.journal.read()).activation.steps[1]).toEqual({
    id: f.second,
    status: "pending",
  });
});

test("Host activation parent reserves and consumes one intent, never relaunching an unclaimed generation", async () => {
  const f = initialHostActivationFixture();
  expect(await reconcileInitialHostActivation(f.input, f.ports)).toBe("unresolved");
  const state = enrolled(f.journal.read());
  const reserved = state.activation.steps[1];
  expect(reserved.status).toBe("reserved");
  expect(f.prepared.launch).toHaveBeenCalledTimes(1);
  expect(f.ports.prepare).toHaveBeenCalledTimes(1);
  const before = readFileSync(path.join(f.directory, "maintenance-enrollment.json"));
  expect(await reconcileInitialHostActivation(f.input, f.ports)).toBe("unresolved");
  expect(f.prepared.launch).toHaveBeenCalledTimes(1);
  expect(f.ports.prepare).toHaveBeenCalledTimes(1);
  expect(f.ports.observe).not.toHaveBeenCalled();
  expect(readFileSync(path.join(f.directory, "maintenance-enrollment.json"))).toEqual(before);
});

test("Host activation parent observes a claimed generation after lost reply and revocation without effect preparation", async () => {
  const f = initialHostActivationFixture();
  f.prepared.launch.mockImplementation(async () => {
    const state = enrolled(f.journal.read());
    const reserved = state.activation.steps[1];
    if (reserved.status !== "reserved") throw new Error("Fixture reservation missing");
    claimInitialHostMigration({
      ...f.intentInput,
      generation: reserved.generation,
      executor: {
        process: {
          ...f.plan.precondition.supervisor,
          pid: process.pid,
          parentPid: process.ppid,
          executable: process.execPath,
        },
        assertCurrent() {},
      },
    });
    throw new Error("injected lost launch reply");
  });
  await expect(reconcileInitialHostActivation(f.input, f.ports)).rejects.toThrow(
    "lost launch reply",
  );
  const reserved = enrolled(f.journal.read()).activation.steps[1];
  if (reserved.status !== "reserved") throw new Error("Fixture reservation missing");
  changeStandingGrant(f.journal, {
    expectedRevision: f.intentInput.grantRevision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  f.ports.observe.mockImplementation(async () => {
    observeActivationStep(f.journal, {
      stepId: f.second,
      generation: reserved.generation,
      outcome: "succeeded",
      observationSha256: "b".repeat(64),
    });
  });
  expect(await reconcileInitialHostActivation(f.input, f.ports)).toBe("verified");
  expect(f.ports.observe).toHaveBeenCalledTimes(1);
  expect(f.prepared.launch).toHaveBeenCalledTimes(1);
  expect(f.ports.prepare).toHaveBeenCalledTimes(1);
});

test("Host activation parent rejects competing lifecycle work before reserving", async () => {
  const f = initialHostActivationFixture();
  const competing = { ...restartAdmissionFixture().pending, status: "approved" };
  writeFileSync(path.join(f.directory, "restart-jobs.json"), JSON.stringify([competing]), {
    mode: 0o600,
  });
  await expect(reconcileInitialHostActivation(f.input, f.ports)).rejects.toThrow(
    "unresolved installation work",
  );
  expect(enrolled(f.journal.read()).activation.steps[1]).toEqual({
    id: f.second,
    status: "pending",
  });
  expect(f.prepared.launch).not.toHaveBeenCalled();
});

test("Host activation parent refuses missing prerequisites without stranding a reservation", async () => {
  const f = initialHostActivationFixture();
  f.ports.prepare.mockRejectedValue(new Error("Production interruption custody unavailable"));
  await expect(reconcileInitialHostActivation(f.input, f.ports)).rejects.toThrow(
    "interruption custody unavailable",
  );
  expect(enrolled(f.journal.read()).activation.steps[1]).toEqual({
    id: f.second,
    status: "pending",
  });
  expect(f.prepared.launch).not.toHaveBeenCalled();
});

test("Host activation parent rejects changed addressed plan before preparation", async () => {
  const f = initialHostActivationFixture();
  writeFileSync(f.planFile, JSON.stringify({ ...f.plan, installationId: randomUUID() }));
  await expect(reconcileInitialHostActivation(f.input, f.ports)).rejects.toThrow();
  expect(f.ports.prepare).not.toHaveBeenCalled();
  expect(enrolled(f.journal.read()).activation.steps[1]).toEqual({
    id: f.second,
    status: "pending",
  });
});

test("Host activation parent refuses changed enrollment interruption before reserving", async () => {
  const f = initialHostActivationFixture();
  f.journal.update((state) => {
    if (state.status !== "enrolled") throw new Error("Fixture enrollment disappeared");
    state.grant.manifest.interruption.finishTurnsSeconds++;
    const digest = enrollmentManifestDigest(state.grant.manifest);
    state.grant.approval.manifestSha256 = digest;
    state.activation.manifestSha256 = digest;
    return state;
  });
  const before = readFileSync(path.join(f.directory, "maintenance-enrollment.json"));
  await expect(reconcileInitialHostActivation(f.input, f.ports)).rejects.toThrow(
    "interruption differs from enrollment",
  );
  expect(f.ports.prepare).not.toHaveBeenCalled();
  expect(f.prepared.launch).not.toHaveBeenCalled();
  expect(readFileSync(path.join(f.directory, "maintenance-enrollment.json"))).toEqual(before);
  expect(enrolled(f.journal.read()).activation.steps[1]).toEqual({
    id: f.second,
    status: "pending",
  });
});

test("initial Host child claim consumes its exact intent once without changing activation", () => {
  const f = initialHostClaimFixture();
  const enrollment = path.join(f.directory, "maintenance-enrollment.json");
  const before = readFileSync(enrollment);
  const retained = claimInitialHostMigration(f.claimInput);
  const intentSha256 = createHash("sha256").update(JSON.stringify(f.retained.intent)).digest("hex");
  expect(retained.claim).toMatchObject({
    intentId: f.retained.intent.id,
    intentSha256,
    generation: f.input.generation,
    executor: f.executor.process,
  });
  expect(JSON.parse(readFileSync(retained.file, "utf8"))).toEqual(retained.claim);
  expect(f.executor.assertCurrent).toHaveBeenCalled();
  expect(() => claimInitialHostMigration(f.claimInput)).toThrow();
  expect(readFileSync(enrollment)).toEqual(before);
});

test.each(["pid", "boot", "generation", "intent", "revoked", "custody"])(
  "initial Host child claim refuses changed %s before consumption",
  (changed) => {
    const f = initialHostClaimFixture();
    if (changed === "pid") f.executor.process.pid++;
    if (changed === "boot") f.executor.process.bootId = randomUUID();
    if (changed === "generation") f.claimInput.generation = randomUUID();
    if (changed === "intent")
      writeFileSync(
        f.retained.file,
        JSON.stringify({ ...f.retained.intent, planSha256: "f".repeat(64) }),
      );
    if (changed === "revoked")
      changeStandingGrant(f.journal, {
        expectedRevision: f.input.grantRevision,
        paused: false,
        disabledTargets: [],
        revoke: true,
      });
    if (changed === "custody")
      f.executor.assertCurrent.mockImplementation(() => {
        throw new Error("Child changed");
      });
    expect(() => claimInitialHostMigration(f.claimInput)).toThrow();
    expect(
      existsSync(
        path.join(f.directory, `initial-host-claim-${f.input.stepId}-${f.input.generation}.json`),
      ),
    ).toBe(false);
  },
);

test("initial Host child claim fences uncertain directory synchronization", () => {
  const f = initialHostClaimFixture();
  let count = 0;
  expect(() =>
    claimInitialHostMigration(f.claimInput, {
      ...enrollmentWriteFiles,
      sync(fd) {
        if (++count === 2) throw new Error("Claim directory synchronization failed");
        enrollmentWriteFiles.sync(fd);
      },
    }),
  ).toThrow("Claim directory synchronization failed");
  const file = path.join(
    f.directory,
    `initial-host-claim-${f.input.stepId}-${f.input.generation}.json`,
  );
  const before = readFileSync(file);
  expect(() => claimInitialHostMigration(f.claimInput)).toThrow();
  expect(readFileSync(file)).toEqual(before);
});

function initialHostPreparedClaimFixture() {
  const candidateLauncher = Buffer.from("synthetic managed plist");
  const originalLauncher = Buffer.from("synthetic legacy plist");
  const f = initialHostClaimFixture((plan) => {
    for (const directory of [
      plan.precondition.selectedRelease,
      plan.candidate.directory,
      plan.fallback.directory,
    ])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    plan.precondition.launcher.sha256 = createHash("sha256").update(originalLauncher).digest("hex");
    plan.fallback.launcher.sha256 = plan.precondition.launcher.sha256;
    plan.candidate.launcher.sha256 = createHash("sha256").update(candidateLauncher).digest("hex");
    writeFileSync(plan.precondition.launcher.path, originalLauncher, { mode: 0o600 });
    symlinkSync(plan.precondition.selectedRelease, plan.precondition.identity.selectionPath!);
  });
  writeFileSync(f.plan.candidate.launcher.path, candidateLauncher, { mode: 0o600 });
  return { ...f, originalLauncher, candidateLauncher };
}

function initialHostPublicationFixture() {
  const f = initialHostPreparedClaimFixture();
  const claim = claimInitialHostMigration(f.claimInput);
  const absence = {
    identitySha256: f.plan.identitySha256,
    preconditionSha256: f.plan.preconditionSha256,
    bootId: f.executor.process.bootId,
    observedAt: new Date().toISOString(),
    assertCurrent: vi.fn(() => undefined),
  };
  return {
    ...f,
    claim,
    absence,
    publication: { ...f.claimInput, absence, candidateLauncher: f.candidateLauncher },
  };
}

function initialHostTransitionFixture() {
  const f = initialHostPreparedClaimFixture();
  const commands: string[][] = [];
  const absence = {
    identitySha256: f.plan.identitySha256,
    preconditionSha256: f.plan.preconditionSha256,
    bootId: f.executor.process.bootId,
    observedAt: new Date().toISOString(),
    assertCurrent: vi.fn(() => undefined),
  };
  const ports: Parameters<typeof executeInitialHostMigrationTransition>[1] = {
    writableMountRoots: [],
    reader: {
      verifyProcessExited: vi.fn(async () => undefined),
      inspectProcess: vi.fn(async () => {
        throw new Error("Unexpected live process");
      }),
      verifyServiceAbsent: vi.fn(async () => undefined),
    },
    interrupt: vi.fn(async (context) => ({
      claimSha256: createHash("sha256").update(JSON.stringify(context.claim)).digest("hex"),
      planSha256: f.artifacts.planSha256,
      interruption: f.plan.interruption,
      assertCurrent: vi.fn(() => undefined),
    })),
    collectRetirement: vi.fn(async () => ({ status: "present", native: f.native })),
    collectAbsence: vi.fn(async () => absence),
    command: {
      run: vi.fn(async (args) => {
        commands.push([...args]);
      }),
    },
    readCandidate: vi.fn(async () => {
      const now = Date.now();
      const startIdentity = `${Math.floor(now / 1000)}:${(now % 1000) * 1000}`;
      return {
        assertCurrent: vi.fn(() => undefined),
        descriptor: f.plan.precondition.identity,
        identitySha256: f.plan.identitySha256,
        observedAt: new Date(now).toISOString(),
        custodyStateDirectory: f.directory,
        writableMountRoots: [],
        serverId: f.plan.precondition.serverId,
        selectedRelease: f.plan.candidate.directory,
        sourceCommit: f.plan.candidate.sourceCommit,
        supervisor: { ...f.plan.precondition.supervisor, pid: 901, startIdentity },
        worker: { ...f.plan.precondition.worker, pid: 902, parentPid: 901, startIdentity },
      };
    }),
  };
  return { ...f, ports, absence, commands };
}

function hostTransitionObserver(f: ReturnType<typeof initialHostTransitionFixture>) {
  const input = {
    enrollmentStateDirectory: f.directory,
    plan: f.plan,
    stepId: f.input.stepId,
    generation: f.input.generation,
  };
  let observation: Awaited<ReturnType<typeof f.ports.readCandidate>> | undefined;
  const collectCandidate = vi.fn(async (_context: unknown, signal: AbortSignal) => {
    observation ??= await f.ports.readCandidate(signal);
    observation.observedAt = new Date().toISOString();
    return {
      observation,
      assertSelection: () => {
        expect(readFileSync(f.plan.precondition.launcher.path)).toEqual(f.candidateLauncher);
        expect(realpathSync(f.plan.precondition.identity.selectionPath!)).toBe(
          f.plan.candidate.directory,
        );
      },
    };
  });
  return { input, ports: { reader: f.ports.reader, collectCandidate } };
}

test("initial Host observation settles lost bootstrap reply after revocation without another effect", async () => {
  const f = initialHostTransitionFixture();
  f.ports.command!.run = async (args) => {
    f.commands.push([...args]);
    if (args[0] === "bootstrap") throw new Error("Lost bootstrap reply");
  };
  await expect(executeInitialHostMigrationTransition(f.claimInput, f.ports)).rejects.toThrow(
    /Lost bootstrap reply/,
  );
  changeStandingGrant(f.journal, {
    expectedRevision: f.input.grantRevision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const observer = hostTransitionObserver(f);
  const result = await observeInitialHostMigrationTransition(observer.input, observer.ports);
  expect(result.record.generation).toBe(f.input.generation);
  expect(f.commands.map((args) => args[0])).toEqual(["bootout", "bootstrap"]);
  const journalFile = path.join(f.directory, "maintenance-enrollment.json");
  const journalBytes = readFileSync(journalFile);
  const resultBytes = readFileSync(result.file);
  const reopened = await observeInitialHostMigrationTransition(observer.input, observer.ports);
  expect(reopened.observationSha256).toBe(result.observationSha256);
  expect(readFileSync(journalFile)).toEqual(journalBytes);
  expect(readFileSync(result.file)).toEqual(resultBytes);
  expect(f.commands).toHaveLength(2);
});

test("initial Host observation refuses live executor before collecting candidate files", async () => {
  const f = initialHostTransitionFixture();
  f.ports.command!.run = async (args) => {
    if (args[0] === "bootstrap") throw new Error("Uncertain bootstrap");
  };
  await expect(executeInitialHostMigrationTransition(f.claimInput, f.ports)).rejects.toThrow(
    /Uncertain bootstrap/,
  );
  const observer = hostTransitionObserver(f);
  observer.ports.reader.verifyProcessExited = async () => {
    throw new Error("Still live");
  };
  observer.ports.reader.inspectProcess = async () => f.executor.process;
  await expect(
    observeInitialHostMigrationTransition(observer.input, observer.ports),
  ).rejects.toThrow(/exit is unproven/);
  expect(observer.ports.collectCandidate).not.toHaveBeenCalled();
});

test("initial Host observation refuses a collector substituting the retained plan", async () => {
  const f = initialHostTransitionFixture();
  f.ports.command!.run = async (args) => {
    if (args[0] === "bootstrap") throw new Error("Uncertain bootstrap");
  };
  await expect(executeInitialHostMigrationTransition(f.claimInput, f.ports)).rejects.toThrow(
    /Uncertain bootstrap/,
  );
  const observer = hostTransitionObserver(f);
  const collect = observer.ports.collectCandidate;
  observer.ports.collectCandidate = vi.fn(async (context: unknown, signal: AbortSignal) => {
    const result = await collect(context, signal);
    (context as { plan: typeof f.plan }).plan.interruption.finishTurnsSeconds++;
    return result;
  });
  await expect(
    observeInitialHostMigrationTransition(observer.input, observer.ports),
  ).rejects.toThrow(/plan changed/);
  expect(
    existsSync(path.join(f.directory, `initial-host-result-${f.retained.intent.id}.json`)),
  ).toBe(false);
});

test("initial Host transition records one claimed stop/publication/start and exact candidate", async () => {
  const f = initialHostTransitionFixture();
  const result = await executeInitialHostMigrationTransition(f.claimInput, f.ports);
  expect(f.commands.map((args) => args[0])).toEqual(["bootout", "bootstrap"]);
  expect(result.record.worker.pid).toBe(902);
  expect(enrolled(f.journal.readPolicySnapshot()).activation.steps[1].status).toBe("succeeded");
  await expect(executeInitialHostMigrationTransition(f.claimInput, f.ports)).rejects.toThrow();
  expect(f.commands).toHaveLength(2);
});

test("initial Host retirement retries native uncertainty after one bootout", async () => {
  const f = initialHostTransitionFixture();
  const verify = vi.fn(async () => undefined);
  verify.mockRejectedValueOnce(new Error("Process is still exiting"));
  f.ports.reader.verifyProcessExited = verify;
  const result = await executeInitialHostMigrationTransition(f.claimInput, f.ports);
  expect(result.record.worker.pid).toBe(902);
  expect(verify.mock.calls.length).toBeGreaterThan(2);
  expect(f.commands.map((args) => args[0])).toEqual(["bootout", "bootstrap"]);
});

test("initial Host unresolved retirement stops at its budget without publication or replay", async () => {
  const f = initialHostTransitionFixture();
  f.ports.reader.verifyProcessExited = vi.fn(async () => {
    throw new Error("Exit remains uncertain");
  });
  const launcher = readFileSync(f.plan.precondition.launcher.path);
  vi.useFakeTimers();
  try {
    const result = executeInitialHostMigrationTransition(f.claimInput, f.ports);
    const refused = expect(result).rejects.toThrow("Host retirement remains unverified");
    await vi.advanceTimersByTimeAsync(30_000);
    await refused;
    expect(f.commands.map((args) => args[0])).toEqual(["bootout"]);
    expect(readFileSync(f.plan.precondition.launcher.path)).toEqual(launcher);
    expect(realpathSync(f.plan.precondition.identity.selectionPath!)).toBe(
      f.plan.precondition.selectedRelease,
    );
    expect(
      existsSync(
        path.join(f.directory, `initial-host-claim-${f.input.stepId}-${f.input.generation}.json`),
      ),
    ).toBe(true);
    expect(f.ports.readCandidate).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("initial Host revocation during retirement prevents publication and bootstrap", async () => {
  const f = initialHostTransitionFixture();
  f.ports.reader.verifyServiceAbsent = vi.fn(async () => {
    changeStandingGrant(f.journal, {
      expectedRevision: f.input.grantRevision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
  });
  const launcher = readFileSync(f.plan.precondition.launcher.path);
  await expect(executeInitialHostMigrationTransition(f.claimInput, f.ports)).rejects.toThrow(
    "Initial Host migration enrollment authority changed",
  );
  expect(f.commands.map((args) => args[0])).toEqual(["bootout"]);
  expect(readFileSync(f.plan.precondition.launcher.path)).toEqual(launcher);
  expect(f.ports.readCandidate).not.toHaveBeenCalled();
});

test("initial Host transition refuses changed registration before bootout", async () => {
  const f = initialHostTransitionFixture();
  f.ports.collectRetirement = async () => ({
    status: "present",
    native: {
      ...f.native,
      precondition: {
        ...f.native.precondition,
        supervisor: {
          ...f.native.precondition.supervisor,
          pid: 999,
        },
      },
    },
  });
  await expect(executeInitialHostMigrationTransition(f.claimInput, f.ports)).rejects.toThrow(
    /registration changed/,
  );
  expect(f.commands).toEqual([]);
});

test("initial Host transition refuses target reappearance after final awaited absence", async () => {
  const f = initialHostTransitionFixture();
  let checks = 0;
  f.ports.reader.verifyServiceAbsent = async () => {
    checks++;
  };
  f.absence.assertCurrent.mockImplementation(() => {
    if (checks >= 2) throw new Error("Target reappeared");
  });
  await expect(executeInitialHostMigrationTransition(f.claimInput, f.ports)).rejects.toThrow(
    /Target reappeared/,
  );
  expect(f.commands.map((args) => args[0])).toEqual(["bootout"]);
});

test.each(["worker", "selector"])(
  "initial Host transition refuses readiness callback changing %s",
  async (changed) => {
    const f = initialHostTransitionFixture();
    const read = f.ports.readCandidate;
    f.ports.readCandidate = async (signal) => {
      const observed = await read(signal);
      observed.assertCurrent = () => {
        if (changed === "worker") observed.worker.pid++;
        else {
          unlinkSync(f.plan.precondition.identity.selectionPath!);
          symlinkSync(
            f.plan.precondition.selectedRelease,
            f.plan.precondition.identity.selectionPath!,
          );
        }
      };
      return observed;
    };
    await expect(executeInitialHostMigrationTransition(f.claimInput, f.ports)).rejects.toThrow();
    expect(
      existsSync(path.join(f.directory, `initial-host-result-${f.retained.intent.id}.json`)),
    ).toBe(false);
    expect(enrolled(f.journal.readPolicySnapshot()).activation.steps[1].status).toBe("reserved");
  },
);

test("initial Host publication joins one claim to both exact file publications", () => {
  const f = initialHostPublicationFixture();
  const result = publishInitialHostMigrationSelection(f.publication);
  expect(result).toMatchObject({
    intentId: f.retained.intent.id,
    generation: f.input.generation,
    slot: "candidate",
  });
  expect(readFileSync(f.plan.precondition.launcher.path)).toEqual(f.candidateLauncher);
  expect(realpathSync(f.plan.precondition.identity.selectionPath!)).toBe(
    f.plan.candidate.directory,
  );
  const publication = path.join(
    f.directory,
    `initial-host-publication-${f.retained.intent.id}.json`,
  );
  const before = readFileSync(publication);
  expect(() => publishInitialHostMigrationSelection(f.publication)).toThrow();
  expect(readFileSync(publication)).toEqual(before);
  expect(f.absence.assertCurrent).toHaveBeenCalled();
  expect(() => result.assertSelection()).not.toThrow();
});

test.each(["phase", "launcher attempt", "selector attempt", "launcher", "selector"])(
  "initial Host candidate publication observation retains exact %s",
  (changed) => {
    const f = initialHostPublicationFixture();
    publishInitialHostMigrationSelection(f.publication);
    const context = { ...inspectInitialHostSupervisorMigrationPlan(f.plan), ...f.claim };
    const assertCurrent = inspectInitialHostCandidatePublication(context, f.candidateLauncher);
    expect(() => assertCurrent()).not.toThrow();
    if (changed === "launcher")
      writeFileSync(f.plan.precondition.launcher.path, "changed launcher");
    else if (changed === "selector") {
      unlinkSync(f.plan.precondition.identity.selectionPath!);
      symlinkSync(f.plan.precondition.selectedRelease, f.plan.precondition.identity.selectionPath!);
    } else {
      const name = changed === "phase" ? "publication" : changed.replace(" ", "-");
      writeFileSync(
        path.join(f.directory, `initial-host-${name}-${f.retained.intent.id}.json`),
        "changed receipt",
      );
    }
    expect(() => assertCurrent()).toThrow();
  },
);

test("initial Host candidate publication observation refuses another claim", () => {
  const f = initialHostPublicationFixture();
  publishInitialHostMigrationSelection(f.publication);
  const context = { ...inspectInitialHostSupervisorMigrationPlan(f.plan), ...f.claim };
  context.claim.executor = { ...context.claim.executor, startIdentity: "300:1" };
  expect(() => inspectInitialHostCandidatePublication(context, f.candidateLauncher)).toThrow();
});

test.each(["launcher", "selector"])(
  "initial Host retained publication proof refuses later %s substitution",
  (changed) => {
    const f = initialHostPublicationFixture();
    const result = publishInitialHostMigrationSelection(f.publication);
    if (changed === "launcher") {
      writeFileSync(f.plan.precondition.launcher.path, "substituted launcher");
    } else {
      unlinkSync(f.plan.precondition.identity.selectionPath!);
      symlinkSync(f.plan.precondition.selectedRelease, f.plan.precondition.identity.selectionPath!);
    }
    expect(() => result.assertSelection()).toThrow();
  },
);

test.each(["absence", "stale", "launcher", "claim", "grant"])(
  "initial Host publication refuses changed %s before selecting files",
  (changed) => {
    const f = initialHostPublicationFixture();
    if (changed === "absence")
      f.absence.assertCurrent.mockImplementation(() => {
        throw new Error("Service reappeared");
      });
    if (changed === "stale") f.absence.observedAt = new Date(Date.now() - 30_000).toISOString();
    if (changed === "launcher") f.publication.candidateLauncher = Buffer.from("different plist");
    if (changed === "claim")
      writeFileSync(f.claim.file, JSON.stringify({ ...f.claim.claim, intentId: randomUUID() }));
    if (changed === "grant")
      changeStandingGrant(f.journal, {
        expectedRevision: f.input.grantRevision,
        paused: false,
        disabledTargets: [],
        revoke: true,
      });
    expect(() => publishInitialHostMigrationSelection(f.publication)).toThrow();
    expect(readFileSync(f.plan.precondition.launcher.path)).toEqual(f.originalLauncher);
    expect(realpathSync(f.plan.precondition.identity.selectionPath!)).toBe(
      f.plan.precondition.selectedRelease,
    );
  },
);

test("initial Host partial publication preserves its fence without replaying the launcher", () => {
  const f = initialHostPublicationFixture();
  const selector = path.join(
    f.directory,
    `initial-host-selector-attempt-${f.retained.intent.id}.json`,
  );
  writeFileSync(selector, "retained uncertain selector attempt", { mode: 0o600 });
  expect(() => publishInitialHostMigrationSelection(f.publication)).toThrow();
  expect(readFileSync(f.plan.precondition.launcher.path)).toEqual(f.candidateLauncher);
  expect(realpathSync(f.plan.precondition.identity.selectionPath!)).toBe(
    f.plan.precondition.selectedRelease,
  );
  expect(() => publishInitialHostMigrationSelection(f.publication)).toThrow();
  expect(readFileSync(selector, "utf8")).toBe("retained uncertain selector attempt");
});

test.each(["initial", "prepared"])(
  "initial Host publication refuses async %s artifact custody before publication",
  (stage) => {
    const f = initialHostPublicationFixture();
    const artifacts = {
      ...f.artifacts,
      assertCurrent: () => {
        if (stage === "initial") return Promise.resolve();
      },
      assertPreparedCurrent: () => {
        if (stage === "prepared") return Promise.resolve();
      },
    };
    expect(() => publishInitialHostMigrationSelection({ ...f.publication, artifacts })).toThrow(
      "synchronous",
    );
    expect(readFileSync(f.plan.precondition.launcher.path)).toEqual(f.originalLauncher);
    expect(realpathSync(f.plan.precondition.identity.selectionPath!)).toBe(
      f.plan.precondition.selectedRelease,
    );
  },
);

test.each(["selector", "phase", "launcher attempt", "selector attempt"])(
  "initial Host publication retains final %s custody after callbacks",
  (changed) => {
    const f = initialHostPublicationFixture();
    const link = f.plan.precondition.identity.selectionPath!;
    f.absence.assertCurrent.mockImplementation(() => {
      if (realpathSync(link) !== f.plan.candidate.directory) return;
      if (changed === "selector") {
        unlinkSync(link);
        symlinkSync(f.plan.candidate.directory, link);
        return;
      }
      let artifact = "publication";
      if (changed === "launcher attempt") artifact = "launcher-attempt";
      if (changed === "selector attempt") artifact = "selector-attempt";
      writeFileSync(
        path.join(f.directory, `initial-host-${artifact}-${f.retained.intent.id}.json`),
        "foreign callback bytes",
      );
    });
    expect(() => publishInitialHostMigrationSelection(f.publication)).toThrow();
  },
);

test("initial Host intent consumes one exact reservation under the real shared lock", () => {
  const f = initialHostIntentFixture();
  const journalBefore = readFileSync(path.join(f.directory, "maintenance-enrollment.json"));
  const retained = reserveInitialHostMigrationIntent(f.intentInput);
  expect(JSON.parse(readFileSync(retained.file, "utf8"))).toEqual(retained.intent);
  expect(retained.intent).toMatchObject({
    operation: "initial-host-supervisor-migration",
    grantId: f.input.grantId,
    grantRevision: f.input.grantRevision,
    manifestSha256: f.approval.manifestSha256,
    stepId: f.second,
    generation: f.input.generation,
    planSha256: f.artifacts.planSha256,
    preconditionSha256: f.plan.preconditionSha256,
    observedAt: f.native.observedAt,
  });
  expect(lstatSync(retained.file).mode & 0o777).toBe(0o600);
  expect(f.native.assertCurrent).toHaveBeenCalled();
  expect(f.artifacts.assertCurrent).toHaveBeenCalled();
  expect(() => reserveInitialHostMigrationIntent(f.intentInput)).toThrow();
  expect(readFileSync(path.join(f.directory, "maintenance-enrollment.json"))).toEqual(
    journalBefore,
  );
  expect(JSON.parse(readFileSync(retained.file, "utf8"))).toEqual(retained.intent);
});

test.each(["native", "artifact", "expired", "asynchronous"])(
  "initial Host intent refuses changed %s proof before writing",
  (changed) => {
    const f = initialHostIntentFixture();
    if (changed === "native") f.native.preconditionSha256 = "0".repeat(64);
    if (changed === "artifact") f.artifacts.planSha256 = "0".repeat(64);
    if (changed === "expired") f.native.observedAt = new Date(Date.now() - 30_001).toISOString();
    if (changed === "asynchronous") Reflect.set(f.native, "assertCurrent", () => Promise.resolve());
    expect(() => reserveInitialHostMigrationIntent(f.intentInput)).toThrow();
    expect(
      existsSync(path.join(f.directory, `initial-host-${f.second}-${f.input.generation}.json`)),
    ).toBe(false);
  },
);

test("initial Host intent refuses revoked authority inside the shared transaction", () => {
  const f = initialHostIntentFixture();
  changeStandingGrant(f.journal, {
    expectedRevision: f.input.grantRevision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  expect(() => reserveInitialHostMigrationIntent(f.intentInput)).toThrow("authority changed");
  expect(f.native.assertCurrent).not.toHaveBeenCalled();
});

test("initial Host intent retains uncertain directory synchronization without replay", () => {
  const f = initialHostIntentFixture();
  let syncs = 0;
  const files = {
    ...enrollmentWriteFiles,
    sync(descriptor: number) {
      if (++syncs === 2) throw new Error("injected intent directory sync failure");
      enrollmentWriteFiles.sync(descriptor);
    },
  };
  expect(() => reserveInitialHostMigrationIntent(f.intentInput, files)).toThrow(
    "directory sync failure",
  );
  const file = path.join(f.directory, `initial-host-${f.second}-${f.input.generation}.json`);
  const retained = readFileSync(file);
  expect(() => reserveInitialHostMigrationIntent(f.intentInput)).toThrow();
  expect(readFileSync(file)).toEqual(retained);
});

test("initial Host intent refuses a competing approved daemon under shared exclusion", () => {
  const f = initialHostIntentFixture();
  const competing = { ...restartAdmissionFixture().pending, status: "approved" };
  const file = path.join(f.directory, "restart-jobs.json");
  writeFileSync(file, JSON.stringify([competing]), { mode: 0o600 });
  const before = readFileSync(file);
  expect(() => reserveInitialHostMigrationIntent(f.intentInput)).toThrow(
    "unresolved installation work",
  );
  expect(readFileSync(file)).toEqual(before);
  expect(f.native.assertCurrent).not.toHaveBeenCalled();
  expect(
    existsSync(path.join(f.directory, `initial-host-${f.second}-${f.input.generation}.json`)),
  ).toBe(false);
});

test("initial Host intent refuses an active coordinator execution without creating an intent", () => {
  const f = initialHostIntentFixture();
  const plan = CoordinatorBootstrapPlanSchema.parse({
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: f.plan.installationId,
    service: `gui/${process.getuid!()}/local.vorteo.fixture.installation`,
    expectedProcess: {
      pid: f.plan.precondition.supervisor.pid,
      bootId: f.plan.precondition.supervisor.bootId,
      startIdentity: f.plan.precondition.supervisor.startIdentity,
      argumentsSha256: f.plan.precondition.supervisor.argumentsSha256,
    },
    previous: f.plan.fallback,
    candidate: f.plan.candidate,
    state: {
      directory: f.directory,
      restartJournal: path.join(f.directory, "restart-jobs.json"),
      ownerSessions: path.join(f.directory, "owner-sessions.json"),
    },
    hostRequestsAfter: null,
  });
  const now = new Date().toISOString();
  const record = CoordinatorBootstrapRequestSchema.parse({
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Fixture coordinator execution exclusion",
    createdAt: now,
    decisionAt: now,
    plan,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    status: "approved",
    execution: { generation: randomUUID(), stage: "claimed", updatedAt: now },
  });
  const file = path.join(f.directory, "coordinator-bootstrap.json");
  writeFileSync(file, JSON.stringify({ version: 1, requests: [record] }), { mode: 0o600 });
  const before = readFileSync(file);
  expect(() => reserveInitialHostMigrationIntent(f.intentInput)).toThrow(
    "Coordinator execution conflicts",
  );
  expect(readFileSync(file)).toEqual(before);
  expect(f.native.assertCurrent).not.toHaveBeenCalled();
  expect(
    existsSync(path.join(f.directory, `initial-host-${f.second}-${f.input.generation}.json`)),
  ).toBe(false);
});

test("initial Host intent refuses proof substitution during synchronous custody", () => {
  const f = initialHostIntentFixture();
  f.artifacts.assertCurrent.mockImplementation(() => {
    f.native.preconditionSha256 = "0".repeat(64);
  });
  expect(() => reserveInitialHostMigrationIntent(f.intentInput)).toThrow(
    "different reviewed bytes",
  );
  expect(
    existsSync(path.join(f.directory, `initial-host-${f.second}-${f.input.generation}.json`)),
  ).toBe(false);
});

test("initial Host intent refuses a preexisting symlink without touching its target", () => {
  const f = initialHostIntentFixture();
  const target = path.join(f.directory, "retained.json");
  writeFileSync(target, "retained fixture evidence", { mode: 0o600 });
  symlinkSync(
    target,
    path.join(f.directory, `initial-host-${f.second}-${f.input.generation}.json`),
  );
  expect(() => reserveInitialHostMigrationIntent(f.intentInput)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("retained fixture evidence");
});

test.each([
  "precondition",
  "identity",
  "candidate",
  "fallback",
  "generation",
  "grant",
  "limits",
  "entry",
])("initial Host migration enrollment rejects changed %s binding", (changed) => {
  const f = initialHostPlanFixture();
  if (changed === "precondition") f.plan.preconditionSha256 = "f".repeat(64);
  if (changed === "identity") f.plan.identitySha256 = "f".repeat(64);
  if (changed === "candidate") f.plan.candidate.artifactSha256 = "e".repeat(64);
  if (changed === "fallback") f.plan.fallback.sourceCommit = "a".repeat(40);
  if (changed === "generation") f.input.generation = randomUUID();
  if (changed === "grant") f.input.grantId = randomUUID();
  if (changed === "limits") f.plan.interruption.terminateGraceSeconds++;
  if (changed === "entry")
    f.plan.candidate.entrypoint.path = path.join(f.directory, "wrong-entry.js");
  const before = readFileSync(path.join(f.directory, "maintenance-enrollment.json"));
  expect(() => inspectInitialHostMigrationEnrollment(f.input)).toThrow();
  expect(readFileSync(path.join(f.directory, "maintenance-enrollment.json"))).toEqual(before);
});

test.each(["pause", "revoke", "disable"])(
  "initial Host migration enrollment rejects current %s",
  (change) => {
    const f = initialHostPlanFixture();
    const next = enrolled(
      changeStandingGrant(f.journal, {
        expectedRevision: f.input.grantRevision,
        paused: change === "pause",
        disabledTargets: change === "disable" ? ["host"] : [],
        revoke: change === "revoke",
      }),
    );
    f.input.grantRevision = next.grant.revision;
    expect(() => inspectInitialHostMigrationEnrollment(f.input)).toThrow("authority changed");
  },
);

test("initial Host migration plan refuses using its candidate as the fallback", () => {
  const f = initialHostPlanFixture();
  f.plan.fallback = f.plan.candidate;
  expect(() => inspectInitialHostSupervisorMigrationPlan(f.plan)).toThrow(
    "distinct compatible fallback",
  );
});

test.each(["dependency", "competing reservation"])(
  "initial Host migration enrollment refuses changed %s",
  (changed) => {
    const f = initialHostPlanFixture();
    f.journal.update((state) => {
      if (state.status !== "enrolled") throw new Error("Missing fixture enrollment");
      state.activation.steps = state.activation.steps.map((step) => {
        if (changed === "dependency" && step.id === f.first)
          return { id: step.id, status: "pending" };
        if (changed === "competing reservation" && step.id === f.followingId)
          return {
            id: step.id,
            status: "reserved",
            generation: randomUUID(),
            grantRevision: state.grant.revision,
            reservedAt: "2026-10-17T00:00:00.000Z",
          };
        return step;
      });
      return state;
    });
    expect(() => inspectInitialHostMigrationEnrollment(f.input)).toThrow(
      "prerequisites require reconciliation",
    );
  },
);

test("initial Host migration enrollment refuses a terminal reservation", () => {
  const f = initialHostPlanFixture();
  observeActivationStep(f.journal, {
    stepId: f.second,
    generation: f.input.generation,
    outcome: "succeeded",
    observationSha256: "a".repeat(64),
  });
  expect(() => inspectInitialHostMigrationEnrollment(f.input)).toThrow("exact reserved step");
});

test("initial Host migration plan preserves the original immutable fallback launcher", () => {
  const f = initialHostPlanFixture();
  expect(inspectInitialHostSupervisorMigrationPlan(f.plan).plan).toEqual(f.plan);
  f.plan.fallback.launcher.sha256 = "0".repeat(64);
  expect(() => inspectInitialHostSupervisorMigrationPlan(f.plan)).toThrow("persistent launcher");
});

function initialHostLauncherFixture() {
  const f = initialHostPlanFixture();
  const current = {
    Label: f.plan.precondition.identity.serviceLabel,
    ProgramArguments: f.plan.precondition.registration.arguments,
    EnvironmentVariables: { ...f.plan.precondition.registration.environment },
    KeepAlive: true,
    RunAtLoad: true,
    StandardErrorPath: path.join(f.directory, "retained-error.log"),
    ThrottleInterval: 10,
  };
  const fallback = structuredClone(current);
  const candidate = {
    ...structuredClone(current),
    EnvironmentVariables: {
      ...current.EnvironmentVariables,
      PASEO_MANAGED_RELEASE_LINK: f.plan.precondition.identity.selectionPath!,
      PASEO_MANAGED_RELEASE_ROOT: f.plan.managedReleaseRoot,
    },
  };
  const sourceUpdates = {
    releaseRoot: f.plan.managedReleaseRoot,
    currentReleaseLink: f.plan.precondition.identity.selectionPath,
  };
  return { ...f, current, fallback, candidate, sourceUpdates };
}

test("initial Host managed launchers preserve every setting except the exact managed selection", () => {
  const f = initialHostLauncherFixture();
  expect(() => verifyInitialHostMigrationLaunchers(f)).not.toThrow();
  Reflect.set(f.current, "Program", f.plan.precondition.node.path);
  f.plan.precondition.registration.program = f.plan.precondition.node.path;
  f.plan.preconditionSha256 = createHash("sha256")
    .update(JSON.stringify(f.plan.precondition))
    .digest("hex");
  Reflect.set(f.fallback, "Program", f.plan.precondition.node.path);
  Reflect.set(f.candidate, "Program", f.plan.precondition.node.path);
  expect(() => verifyInitialHostMigrationLaunchers(f)).not.toThrow();
});

test.each([
  "configured root",
  "configured selector",
  "fallback",
  "label",
  "arguments",
  "environment",
  "link",
  "root",
  "lifetime",
])("initial Host managed launchers refuse changed %s", (changed) => {
  const f = initialHostLauncherFixture();
  if (changed === "configured root") f.sourceUpdates.releaseRoot += "/other";
  if (changed === "configured selector") f.sourceUpdates.currentReleaseLink += "-other";
  if (changed === "fallback") f.fallback.KeepAlive = false;
  if (changed === "label") f.candidate.Label += ".other";
  if (changed === "arguments")
    f.candidate.ProgramArguments = [f.plan.precondition.node.path, "--eval"];
  if (changed === "environment")
    Reflect.set(f.candidate.EnvironmentVariables, "NODE_OPTIONS", "--require=/unreviewed");
  if (changed === "link") f.candidate.EnvironmentVariables.PASEO_MANAGED_RELEASE_LINK += "-other";
  if (changed === "root") f.candidate.EnvironmentVariables.PASEO_MANAGED_RELEASE_ROOT += "/other";
  if (changed === "lifetime") f.candidate.RunAtLoad = false;
  expect(() => verifyInitialHostMigrationLaunchers(f)).toThrow();
});

test.each(["live fallback", "live candidate", "shared copy", "outside root"])(
  "initial Host managed launchers refuse %s declarations",
  (changed) => {
    const f = initialHostPlanFixture();
    if (changed === "live fallback")
      f.plan.fallback.launcher.path = f.plan.precondition.launcher.path;
    if (changed === "live candidate")
      f.plan.candidate.launcher.path = f.plan.precondition.launcher.path;
    if (changed === "shared copy") f.plan.candidate.launcher.path = f.plan.fallback.launcher.path;
    if (changed === "outside root") f.plan.managedReleaseRoot = path.join(f.directory, "elsewhere");
    expect(() => inspectInitialHostSupervisorMigrationPlan(f.plan)).toThrow();
  },
);

test.each(["source", "supervisor", "worker path", "receipt path"])(
  "initial Host fallback binds the reviewed incumbent %s",
  (changed) => {
    const f = initialHostPlanFixture();
    expect(inspectInitialHostSupervisorMigrationPlan(f.plan).plan).toEqual(f.plan);
    if (changed === "source") f.plan.fallback.sourceCommit = "0".repeat(40);
    if (changed === "supervisor") f.plan.fallback.entrypoint.sha256 = "0".repeat(64);
    if (changed === "worker path") f.plan.precondition.workerEntrypoint.path += ".other";
    if (changed === "receipt path") f.plan.precondition.sourceReceipt.path += ".other";
    f.plan.preconditionSha256 = createHash("sha256")
      .update(JSON.stringify(f.plan.precondition))
      .digest("hex");
    expect(() => inspectInitialHostSupervisorMigrationPlan(f.plan)).toThrow(
      "reviewed incumbent fallback",
    );
  },
);

test("initial Host migration refuses a fallback without addressed provenance", () => {
  const f = initialHostPlanFixture();
  const { fallbackProvenance: _removed, ...missing } = f.plan;
  expect(() => inspectInitialHostSupervisorMigrationPlan(missing)).toThrow();
});

async function initialHostCopyFixture() {
  const f = initialHostPlanFixture();
  const source = f.plan.precondition.selectedRelease;
  const target = f.plan.fallback.directory;
  f.plan.fallback.launcher = { ...f.plan.precondition.launcher };
  const digestBytes = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const relativeFiles = [
    ["packages/server/dist/scripts/supervisor-entrypoint.js", "legacy supervisor"],
    ["packages/server/dist/server/server/daemon-worker.js", "legacy worker"],
    [".installation-source.json", JSON.stringify({ sourceCommit: f.plan.fallback.sourceCommit })],
    ["dependency.js", "legacy dependency"],
  ];
  for (const [name, bytes] of relativeFiles) {
    for (const root of [source, target]) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(root, name), bytes, { mode: 0o600 });
    }
  }
  linkSync(path.join(source, "dependency.js"), path.join(source, "dependency-alias.js"));
  writeFileSync(path.join(target, "dependency-alias.js"), "legacy dependency", { mode: 0o600 });
  relativeFiles.push(["dependency-alias.js", "legacy dependency"]);
  symlinkSync("dependency.js", path.join(source, "dependency-link"));
  symlinkSync("dependency.js", path.join(target, "dependency-link"));
  for (const [key, index] of [
    ["supervisorEntrypoint", 0],
    ["workerEntrypoint", 1],
    ["sourceReceipt", 2],
  ] as const) {
    f.plan.precondition[key].sha256 = digestBytes(relativeFiles[index][1]);
  }
  for (const [file, bytes, mode] of [
    [f.plan.fallback.node.path, "node", 0o700],
    [f.plan.fallback.configuration.path, "{}", 0o600],
    [f.plan.fallback.launcher.path, "launcher", 0o600],
  ] as const) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode });
  }
  f.plan.fallback.node.sha256 = digestBytes("node");
  f.plan.fallback.configuration.sha256 = digestBytes("{}");
  f.plan.fallback.launcher.sha256 = digestBytes("launcher");
  f.plan.fallback.entrypoint.sha256 = f.plan.precondition.supervisorEntrypoint.sha256;
  f.plan.fallback.artifactSha256 = await digestBootstrapArtifact(target);
  const identify = (file: string) => {
    const s = lstatSync(file, { bigint: true });
    return createHash("sha256")
      .update([s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":"))
      .digest("hex");
  };
  const parents = new Set<string>(["."]);
  for (const [name] of relativeFiles) {
    let current = path.dirname(name);
    while (current !== ".") {
      parents.add(current);
      current = path.dirname(current);
    }
  }
  const manifest = {
    version: 1,
    operation: "initial-host-fallback-copy",
    sourceDirectory: source,
    directory: target,
    sourceCommit: f.plan.fallback.sourceCommit,
    artifactSha256: f.plan.fallback.artifactSha256,
    absent: [],
    entries: [
      ...relativeFiles.map(([name, bytes]) => ({
        path: name,
        type: "file",
        sha256: digestBytes(bytes),
        mode: 0o600,
        sourceIdentitySha256: identify(path.join(source, name)),
      })),
      {
        path: "dependency-link",
        type: "link",
        sourceTarget: "dependency.js",
        target: "dependency.js",
        sourceIdentitySha256: identify(path.join(source, "dependency-link")),
      },
    ],
    sourceParents: [...parents].map((name) => ({
      path: name,
      identitySha256: identify(path.join(source, name)),
    })),
  };
  const writeManifest = () => {
    const bytes = JSON.stringify(manifest);
    writeFileSync(f.plan.fallbackProvenance.path, bytes, { mode: 0o600 });
    f.plan.fallbackProvenance.sha256 = digestBytes(bytes);
  };
  writeManifest();
  const controller = new AbortController();
  const inspect = () =>
    inspectInitialHostFallbackCopy({
      reference: f.plan.fallbackProvenance,
      release: f.plan.fallback,
      precondition: f.plan.precondition,
      writableMountRoots: [],
      signal: controller.signal,
    });
  return { ...f, source, target, manifest, writeManifest, inspect, controller };
}

test("initial Host sealed copy verifies original bytes, internal links and retained custody", async () => {
  const f = await initialHostCopyFixture();
  const proof = await f.inspect();
  expect(() => proof.assertCurrent()).not.toThrow();
  writeFileSync(path.join(f.source, "dependency.js"), "changed");
  expect(() => proof.assertCurrent()).toThrow("provenance changed");
});

test.each([
  "source",
  "directory",
  "artifact",
  "duplicate",
  "escaping path",
  "missing parent",
  "missing worker",
  "wrong source bytes",
  "wrong link",
])("initial Host sealed copy refuses repinned %s provenance", async (changed) => {
  const f = await initialHostCopyFixture();
  if (changed === "source") f.manifest.sourceCommit = "0".repeat(40);
  if (changed === "directory") f.manifest.directory += "/other";
  if (changed === "artifact") f.manifest.artifactSha256 = "0".repeat(64);
  if (changed === "duplicate") f.manifest.entries.push(f.manifest.entries[0]);
  if (changed === "escaping path") f.manifest.entries[0].path = "../escape";
  if (changed === "missing parent")
    f.manifest.sourceParents = f.manifest.sourceParents.filter((p) => p.path !== ".");
  if (changed === "missing worker") f.manifest.entries.splice(1, 1);
  if (changed === "wrong source bytes") f.manifest.entries[3].sha256 = "0".repeat(64);
  if (changed === "wrong link") {
    const link = f.manifest.entries.at(-1)!;
    if (link.type !== "link") throw new Error("Missing fixture link");
    link.target = "other.js";
  }
  f.writeManifest();
  await expect(f.inspect()).rejects.toThrow();
});

test.each(["target dependency", "provenance file", "caller cancellation"])(
  "initial Host sealed copy retains %s after collection",
  async (changed) => {
    const f = await initialHostCopyFixture();
    const proof = await f.inspect();
    if (changed === "target dependency")
      writeFileSync(path.join(f.target, "dependency.js"), "changed");
    if (changed === "provenance file") f.writeManifest();
    if (changed === "caller cancellation") f.controller.abort();
    expect(() => proof.assertCurrent()).toThrow();
  },
);

test("initial Host sealed copy refuses inventory omission despite repinned whole artifact", async () => {
  const f = await initialHostCopyFixture();
  writeFileSync(path.join(f.target, "extra.js"), "extra", { mode: 0o600 });
  f.plan.fallback.artifactSha256 = await digestBootstrapArtifact(f.target);
  f.manifest.artifactSha256 = f.plan.fallback.artifactSha256;
  f.writeManifest();
  await expect(f.inspect()).rejects.toThrow("provenance changed");
});
