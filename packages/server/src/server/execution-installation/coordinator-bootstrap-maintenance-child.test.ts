import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { RestartJobSchema } from "@getpaseo/protocol/execution-installation";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  FileEnrollmentJournal,
  enrollInstallation,
  enrollmentManifestDigest,
  reserveActivationStep,
  changeStandingGrant,
} from "./maintenance/authorization.js";
import type { InstallationEnrollmentManifest } from "@getpaseo/protocol/installation-enrollment";
import type { LifecycleActivationChild } from "./coordinator-bootstrap-maintenance-child.js";
import { standingRestartPlanDigest } from "./maintenance/restart-admission.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(target: "host" | "container-daemon" | "supervisor" = "host") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "activation-child-")));
  roots.push(root);
  const stepId = randomUUID();
  const supervisor = target === "supervisor";
  const operation = supervisor ? "replacement" : "source-update";
  const job = RestartJobSchema.parse({
    id: randomUUID(),
    revision: randomUUID(),
    target: supervisor ? "container-daemon" : target,
    reason: "Initial migration fixture",
    requestedBy: "host-agent",
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    status: "approved",
    detail: "fixture",
    ...(supervisor
      ? { supervisorPlanSha256: "9".repeat(64) }
      : {
          update: {
            sourceCommit: "a".repeat(40),
            baseCommit: "b".repeat(40),
            sha256: "f".repeat(64),
            bytes: 123,
          },
        }),
  });
  const manifest: InstallationEnrollmentManifest = {
    version: 1,
    operation: "installation-enrollment",
    installationId: randomUUID(),
    revision: randomUUID(),
    createdAt: new Date().toISOString(),
    provisioning: null,
    trustedRepositories: ["https://example.test/source"],
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 5 },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    targets: [
      { target, identitySha256: "a".repeat(64), operations: [operation] },
      {
        target: "maintenance-controller",
        identitySha256: "b".repeat(64),
        operations: ["replacement"],
      },
      { target: "recovery-launcher", identitySha256: "c".repeat(64), operations: ["replacement"] },
    ],
    steps: [
      {
        id: stepId,
        target,
        operation,
        planSha256: supervisor ? standingRestartPlanDigest(job) : "d".repeat(64),
        candidate: { sourceCommit: "a".repeat(40), artifactSha256: "e".repeat(64) },
        previous: { sourceCommit: "b".repeat(40), artifactSha256: "f".repeat(64) },
        dependsOn: [],
      },
    ],
  };
  const enrollment = new FileEnrollmentJournal(root);
  const enrolled = enrollInstallation(enrollment, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: new Date().toISOString(),
    },
  });
  if (enrolled.status !== "enrolled") throw Error("fixture");
  const reserved = reserveActivationStep(enrollment, {
    grantRevision: enrolled.grant.revision,
    stepId,
  });
  if (reserved.status !== "enrolled" || reserved.activation.steps[0].status !== "reserved")
    throw Error("fixture");
  const proof: LifecycleActivationChild = {
    grantId: enrolled.grant.id,
    grantRevision: enrolled.grant.revision,
    manifestSha256: enrollmentManifestDigest(manifest),
    stepId,
    generation: reserved.activation.steps[0].generation,
    requestId: job.id,
    requestRevision: job.revision,
    planSha256: manifest.steps[0].planSha256,
    target,
  };
  if (supervisor)
    job.standingDecision = {
      activationStep: {
        stepId,
        generation: proof.generation,
        candidateArtifactSha256: manifest.steps[0].candidate.artifactSha256,
      },
      grantId: proof.grantId,
      grantRevision: proof.grantRevision,
      manifestSha256: proof.manifestSha256,
      planSha256: proof.planSha256,
      targetIdentitySha256: manifest.targets[0].identitySha256,
      authoritySha256: "8".repeat(64),
      policyActivatedAt: enrolled.grant.approval.approvedAt,
      requestRevision: job.revision,
    };
  return { root, enrollment, job, proof, journal: new FileBootstrapRequestJournal(root) };
}
test.each(["host", "container-daemon"] as const)(
  "exact initial %s child advances before all activation steps complete",
  (target) => {
    const f = fixture(target);
    const admission = vi.fn(() => undefined);
    expect(() => f.journal.writeLifecycle([f.job], admission)).toThrow(
      "activation must be reconciled",
    );
    f.journal.writeLifecycle([f.job], admission, f.proof);
    expect(f.journal.readLifecycle()).toEqual([f.job]);
    const running = { ...f.job, revision: randomUUID(), status: "running" as const };
    f.journal.writeLifecycle([running], admission, {
      ...f.proof,
      requestRevision: running.revision,
    });
    expect(f.journal.readLifecycle()).toEqual([running]);
    const second = { ...running, id: randomUUID(), revision: randomUUID() };
    expect(() =>
      f.journal.writeLifecycle([second], admission, {
        ...f.proof,
        requestId: second.id,
        requestRevision: second.revision,
      }),
    ).toThrow("already bound");
    expect(f.journal.readLifecycle()).toEqual([running]);
  },
);
test.each([
  "no-callback",
  "callback-refusal",
  "generation",
  "revision",
  "plan",
  "source",
  "extra-job",
  "revoked",
] as const)("initial child refuses %s without changing queue", (mode) => {
  const f = fixture();
  const proof = { ...f.proof };
  const jobs = [structuredClone(f.job)];
  if (mode === "generation") proof.generation = randomUUID();
  if (mode === "revision") proof.requestRevision = randomUUID();
  if (mode === "plan") proof.planSha256 = "0".repeat(64);
  if (mode === "source") jobs[0].update!.sourceCommit = "c".repeat(40);
  if (mode === "extra-job") jobs.push({ ...f.job, id: randomUUID(), revision: randomUUID() });
  if (mode === "revoked")
    changeStandingGrant(f.enrollment, {
      expectedRevision: proof.grantRevision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
  const admission =
    mode === "no-callback"
      ? undefined
      : () => {
          if (mode === "callback-refusal") throw Error("native evidence unavailable");
          return undefined;
        };
  expect(() => f.journal.writeLifecycle(jobs, admission, proof)).toThrow();
  expect(f.journal.readLifecycle()).toEqual([]);
});

test("supervisor replacement retains its own child binding through real journal progress", () => {
  const f = fixture("supervisor");
  const admission = vi.fn(() => undefined);
  expect(() => f.journal.writeLifecycle([f.job], admission)).toThrow(
    "activation must be reconciled",
  );
  f.journal.writeLifecycle([f.job], admission, f.proof);
  const running = {
    ...f.job,
    revision: randomUUID(),
    status: "running" as const,
    detail: "Current execution progress",
  };
  running.standingDecision = { ...running.standingDecision!, requestRevision: running.revision };
  f.journal.writeLifecycle([running], admission, {
    ...f.proof,
    requestRevision: running.revision,
  });
  expect(new FileBootstrapRequestJournal(f.root).readLifecycle()).toEqual([running]);
  expect(admission).toHaveBeenCalledTimes(3);
  const other = { ...running, id: randomUUID() };
  expect(() =>
    f.journal.writeLifecycle([other], admission, {
      ...f.proof,
      requestId: other.id,
      requestRevision: other.revision,
    }),
  ).toThrow();
  expect(f.journal.readLifecycle()).toEqual([running]);
});

test.each([
  "script",
  "request-plan",
  "daemon-target",
  "fake-source-update",
  "decision",
  "decision-revision",
  "decision-generation",
  "decision-artifact",
  "decision-identity",
  "disabled-supervisor",
  "missing-custody",
  "extra-request",
] as const)("supervisor activation child refuses %s", (mode) => {
  const f = fixture("supervisor");
  const job = structuredClone(f.job);
  const jobs = [job];
  if (mode === "script") job.supervisorPlanSha256 = "7".repeat(64);
  if (mode === "request-plan") job.reason = "Different reviewed operation";
  if (mode === "daemon-target") job.target = "host";
  if (mode === "fake-source-update")
    job.update = {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: "f".repeat(64),
      bytes: 123,
    };
  if (mode === "decision") delete job.standingDecision;
  if (mode === "decision-revision") job.standingDecision!.requestRevision = randomUUID();
  if (mode === "decision-generation")
    job.standingDecision!.activationStep!.generation = randomUUID();
  if (mode === "decision-artifact")
    job.standingDecision!.activationStep!.candidateArtifactSha256 = "0".repeat(64);
  if (mode === "decision-identity") job.standingDecision!.targetIdentitySha256 = "0".repeat(64);
  if (mode === "disabled-supervisor")
    changeStandingGrant(f.enrollment, {
      expectedRevision: f.proof.grantRevision,
      paused: false,
      disabledTargets: ["supervisor"],
      revoke: false,
    });
  if (mode === "extra-request") jobs.push({ ...job, id: randomUUID() });
  expect(() =>
    f.journal.writeLifecycle(
      jobs,
      mode === "missing-custody" ? undefined : () => undefined,
      f.proof,
    ),
  ).toThrow();
  expect(f.journal.readLifecycle()).toEqual([]);
});
test("revocation blocks new child effects but preserves terminal bookkeeping", () => {
  const f = fixture();
  f.journal.writeLifecycle([f.job], () => undefined, f.proof);
  changeStandingGrant(f.enrollment, {
    expectedRevision: f.proof.grantRevision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const running = { ...f.job, revision: randomUUID(), status: "running" as const };
  expect(() =>
    f.journal.writeLifecycle([running], () => undefined, {
      ...f.proof,
      requestRevision: running.revision,
    }),
  ).toThrow();
  const failed = { ...f.job, revision: randomUUID(), status: "failed" as const };
  f.journal.writeLifecycle([failed]);
  expect(f.journal.readLifecycle()).toEqual([failed]);
});

test("lost queue write retains the exact child binding across journal reopen", () => {
  const f = fixture();
  const writer = f.journal as unknown as { write(file: string, value: unknown): void };
  const originalWrite = writer.write.bind(writer);
  const injected = vi.spyOn(writer, "write").mockImplementation((file, value) => {
    if (path.basename(file) === "restart-jobs.json") throw Error("injected queue write loss");
    originalWrite(file, value);
  });
  expect(() => f.journal.writeLifecycle([f.job], () => undefined, f.proof)).toThrow(
    "injected queue write loss",
  );
  injected.mockRestore();
  const reopened = new FileBootstrapRequestJournal(f.root);
  expect(reopened.readLifecycle()).toEqual([]);
  const other = { ...f.job, id: randomUUID(), revision: randomUUID() };
  expect(() =>
    reopened.writeLifecycle([other], () => undefined, {
      ...f.proof,
      requestId: other.id,
      requestRevision: other.revision,
    }),
  ).toThrow("already bound");
  expect(reopened.readLifecycle()).toEqual([]);
  reopened.writeLifecycle([f.job], () => undefined, f.proof);
  expect(reopened.readLifecycle()).toEqual([f.job]);
});
