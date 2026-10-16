import type { LifecycleJob } from "../lifecycle-journal.js";
import {
  approveServiceJob,
  reserveServiceJob,
  retainServiceRecoveryObservation,
} from "./service-progress.js";
import {
  maintenanceRecoveryAncestors,
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
  readFileSync,
  realpathSync,
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
} from "./authorization.js";
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

test("initial migration authority binds the one reserved child and its dependencies", () => {
  const f = fixture();
  const job = restartAdmissionFixture().pending;
  const planSha256 = standingRestartPlanDigest(job);
  f.manifest.steps[1] = {
    ...f.manifest.steps[1],
    target: "container-daemon",
    operation: "restart",
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
    nativeIdentitySha256: "c".repeat(64),
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
  const stale = structuredClone(state);
  const progress = stale.activation.steps[1];
  if (progress.status !== "reserved") throw new Error("Missing child reservation");
  progress.grantRevision = randomUUID();
  expect(evaluateStandingRestart({ ...input, state: stale })).toBeNull();
  const unmet = structuredClone(state);
  unmet.activation.steps[0] = { id: f.first, status: "pending" };
  expect(evaluateStandingRestart({ ...input, state: unmet })).toBeNull();
});

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
