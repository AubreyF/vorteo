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
import { afterEach, expect, test } from "vitest";
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
import { projectEnrollmentStatus } from "./status.js";
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
