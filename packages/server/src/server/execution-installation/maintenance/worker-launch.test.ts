import { InstallationRestarts } from "../restarts.js";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  RestartJobSchema,
  RestartRequestSchema,
  type WorkerLaunchBinding,
} from "@getpaseo/protocol/execution-installation";
import { InstallationEnrollmentManifestSchema } from "@getpaseo/protocol/installation-enrollment";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import {
  FileEnrollmentJournal,
  enrollInstallation,
  enrollmentManifestDigest,
} from "./authorization.js";
import {
  assertWorkerLaunchAdmission,
  reserveWorkerLaunch,
  progressWorkerLaunch,
} from "./worker-launch.js";
import { standingRestartPlanDigest } from "./restart-admission.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const time = "2026-10-17T00:00:00.000Z";
const hash = "a".repeat(64);
function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "worker-launch-unit-")));
  directories.push(directory);
  chmodSync(directory, 0o700);
  const lifecycle = new FileBootstrapRequestJournal(directory);
  const enrollment = new FileEnrollmentJournal(directory);
  const stepId = randomUUID();
  const manifest = InstallationEnrollmentManifestSchema.parse({
    version: 1,
    operation: "installation-enrollment",
    installationId: randomUUID(),
    revision: randomUUID(),
    createdAt: time,
    targets: [
      { target: "maintenance-controller", identitySha256: hash, operations: ["replacement"] },
      { target: "recovery-launcher", identitySha256: hash, operations: ["replacement"] },
      {
        target: "container-daemon",
        identitySha256: hash,
        operations: ["restart", "worker-launch"],
      },
    ],
    trustedRepositories: ["https://example.com/source.git"],
    provisioning: null,
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 30 },
    workerLaunchProfile: {
      profileSha256: hash,
      registrationSha256: hash,
      helperClosureSha256: hash,
      pythonSha256: hash,
      workloadUid: 1000,
      workloadGid: 1000,
      dropSupplementaryGroups: true,
      noNewPrivileges: true,
      descriptors: "same-node-ipc-and-factory-ofd-v1",
      sourcePolicy: "protected-selected-or-exact-parent-candidate",
    },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    steps: [
      {
        id: stepId,
        target: "container-daemon",
        operation: "restart",
        planSha256: hash,
        candidate: { sourceCommit: "a".repeat(40), artifactSha256: hash },
        previous: null,
        dependsOn: [],
      },
    ],
  });
  enrollInstallation(enrollment, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: time,
    },
  });
  const state = enrollment.update((current) => {
    if (current.status !== "enrolled") throw new Error("Missing fixture enrollment");
    return {
      ...current,
      activation: {
        ...current.activation,
        steps: [
          {
            id: stepId,
            status: "succeeded",
            generation: randomUUID(),
            grantRevision: current.grant.revision,
            reservedAt: time,
            observedAt: time,
            observationSha256: hash,
          },
        ],
      },
    };
  });
  if (state.status !== "enrolled") throw new Error("Missing fixture grant");
  const parent = RestartJobSchema.parse({
    target: "container-daemon",
    reason: "Exact maintenance parent",
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "container-agent",
    createdAt: time,
    expiresAt: "9999-12-31T23:59:59.999Z",
    status: "running",
    detail: "reserved",
  });
  parent.standingDecision = {
    grantId: state.grant.id,
    grantRevision: state.grant.revision,
    manifestSha256: enrollmentManifestDigest(manifest),
    requestRevision: parent.revision,
    planSha256: standingRestartPlanDigest(parent),
    targetIdentitySha256: hash,
    authoritySha256: hash,
    policyActivatedAt: time,
  };
  lifecycle.writeLifecycle([parent]);
  const binding: WorkerLaunchBinding = {
    requestId: parent.id,
    approvalRevision: parent.revision,
    generation: randomUUID(),
    grantId: state.grant.id,
    grantRevision: state.grant.revision,
    manifestSha256: enrollmentManifestDigest(manifest),
    profileSha256: hash,
    targetIdentitySha256: hash,
    sourceCommit: "a".repeat(40),
    artifactSha256: hash,
    publicationSha256: hash,
    cause: { kind: "predecessor", generation: randomUUID(), settlementSha256: hash },
    supervisor: { pid: 123, parentPid: 1, uid: 1000, bootId: randomUUID(), startTicks: "1234" },
  };
  let nativeAccepted = true;
  function admission(
    previous: Parameters<typeof assertWorkerLaunchAdmission>[0]["previous"],
    next: Parameters<typeof assertWorkerLaunchAdmission>[0]["next"],
  ) {
    assertWorkerLaunchAdmission({
      previous,
      next,
      state: enrollment.readUnderLifecycleLock(),
      assertNativeWorkerEvidence: () => {
        if (!nativeAccepted) throw new Error("Protected receipt changed");
      },
    });
  }
  function reserve(candidate = binding, expectedRevision = parent.revision, parentId = parent.id) {
    let result;
    lifecycle.mutateLifecycle((previous) => {
      const reservation = reserveWorkerLaunch(previous, {
        parentId,
        expectedParent: { ...parent, revision: expectedRevision },
        binding: candidate,
        now: time,
      });
      result = reservation.retained;
      return reservation.jobs;
    }, admission);
    return RestartJobSchema.parse(result);
  }
  return {
    lifecycle,
    enrollment,
    parent,
    binding,
    admission,
    reserve,
    denyNative: () => {
      nativeAccepted = false;
    },
  };
}

test("locked child progress preserves parent approval and unrelated rows", () => {
  const f = fixture();
  const unrelated = { ...f.parent, id: randomUUID(), status: "succeeded" as const };
  f.lifecycle.mutateLifecycle((previous) => [...previous, unrelated], f.admission);
  const retained = f.reserve();
  expect(retained.revision).toBe(f.parent.revision);
  expect(retained.standingDecision).toEqual(f.parent.standingDecision);
  expect(standingRestartPlanDigest(retained)).toBe(standingRestartPlanDigest(f.parent));
  expect(f.lifecycle.readLifecycle().find((job) => job.id === unrelated.id)).toEqual(unrelated);
});

test("cross-form retries observe one retained uncertain generation even after revocation", () => {
  const f = fixture();
  const reserved = f.reserve().workerLaunch!;
  const consumed = { ...reserved, phase: "consumed" as const, consumedAt: time };
  f.lifecycle.mutateLifecycle(
    (previous) => progressWorkerLaunch(previous, f.parent.id, reserved, consumed),
    f.admission,
  );
  const uncertain = { ...consumed, phase: "uncertain" as const };
  f.lifecycle.mutateLifecycle(
    (previous) => progressWorkerLaunch(previous, f.parent.id, consumed, uncertain),
    f.admission,
  );
  f.enrollment.update((state) =>
    state.status === "enrolled" ? { ...state, grant: { ...state.grant, revokedAt: time } } : state,
  );
  const retry = f.reserve(
    { ...f.binding, requestId: randomUUID(), generation: randomUUID() },
    randomUUID(),
    randomUUID(),
  );
  expect(retry.workerLaunch).toEqual(uncertain);
  expect(f.lifecycle.readLifecycle()).toHaveLength(1);
  expect(() =>
    f.lifecycle.mutateLifecycle(
      (previous) => progressWorkerLaunch(previous, f.parent.id, uncertain, consumed),
      f.admission,
    ),
  ).toThrow("observation-only");
});

test("stale parent revision cannot reserve a fresh generation", () => {
  const f = fixture();
  expect(() => f.reserve(f.binding, randomUUID())).toThrow("parent changed");
  expect(RestartJobSchema.parse(f.lifecycle.readLifecycle()[0]).workerLaunch).toBeUndefined();
});

test("revocation between reservation and consumption blocks effects but preserves intent", () => {
  const f = fixture();
  const reserved = f.reserve().workerLaunch!;
  f.enrollment.update((state) =>
    state.status === "enrolled" ? { ...state, grant: { ...state.grant, revokedAt: time } } : state,
  );
  expect(() =>
    f.lifecycle.mutateLifecycle(
      (previous) =>
        progressWorkerLaunch(previous, f.parent.id, reserved, {
          ...reserved,
          phase: "consumed",
          consumedAt: time,
        }),
      f.admission,
    ),
  ).toThrow("Current grant");
  expect(RestartJobSchema.parse(f.lifecycle.readLifecycle()[0]).workerLaunch).toEqual(reserved);
});

test("competing running operation blocks child reservation", () => {
  const f = fixture();
  f.lifecycle.mutateLifecycle(
    (previous) => [...previous, { ...f.parent, id: randomUUID() }],
    f.admission,
  );
  expect(() => f.reserve()).toThrow("owns exclusion");
});

test("stale whole-parent write cannot erase a child and changed native evidence denies consumption", () => {
  const f = fixture();
  const reserved = f.reserve().workerLaunch!;
  expect(() => f.lifecycle.writeLifecycle([f.parent], f.admission)).toThrow("cannot be discarded");
  f.denyNative();
  expect(() =>
    f.lifecycle.mutateLifecycle(
      (previous) =>
        progressWorkerLaunch(previous, f.parent.id, reserved, {
          ...reserved,
          phase: "consumed",
          consumedAt: time,
        }),
      f.admission,
    ),
  ).toThrow("Protected receipt changed");
});

test("request hints reject retained authority and do not accept native launch commands", () => {
  const f = fixture();
  expect(
    RestartRequestSchema.safeParse({
      target: "container-daemon",
      reason: "crash",
      workerLaunch: { binding: f.binding },
    }).success,
  ).toBe(false);
  expect(
    RestartRequestSchema.safeParse({
      target: "container-daemon",
      reason: "crash",
      workerLaunchRequest: {
        profileSha256: hash,
        supervisorPid: 123,
        cause: { kind: "predecessor", generation: randomUUID() },
        command: "/bin/sh",
      },
    }).success,
  ).toBe(false);
});

test("parent progress with unchanged approval still invalidates a stale mutation snapshot", () => {
  const f = fixture();
  f.lifecycle.mutateLifecycle(
    (previous) =>
      previous.map((job) =>
        job.id === f.parent.id ? { ...job, detail: "new native observation" } : job,
      ),
    f.admission,
  );
  expect(() => f.reserve()).toThrow("parent changed");
});

test("legacy restart plan hash retains its existing approval projection", () => {
  const f = fixture();
  const job = f.parent;
  const legacy = createHash("sha256")
    .update(
      JSON.stringify({
        id: job.id,
        target: job.target,
        requestedBy: job.requestedBy,
        requester: job.requester ?? null,
        reason: job.reason,
        createdAt: job.createdAt,
        requireOwnerApproval: job.requireOwnerApproval ?? false,
        update: job.update ?? null,
        sourceBatch: job.sourceBatch ?? null,
        supervisorPlanSha256: job.supervisorPlanSha256 ?? null,
        factoryRuntimePlanSha256: job.factoryRuntimePlanSha256 ?? null,
        factoryRuntimeRecoveryOf: job.factoryRuntimeRecoveryOf ?? null,
        devRepairs: job.devRepairs ?? [],
      }),
    )
    .digest("hex");
  expect(standingRestartPlanDigest(job)).toBe(legacy);
  expect(job.standingDecision?.planSha256).toBe(legacy);
});

test("combined reservation and competitor activation cannot acquire shared exclusion", () => {
  const f = fixture();
  expect(() =>
    f.lifecycle.mutateLifecycle((previous) => {
      const result = reserveWorkerLaunch(previous, {
        parentId: f.parent.id,
        expectedParent: f.parent,
        binding: f.binding,
        now: time,
      });
      return [...result.jobs, { ...f.parent, id: randomUUID() }];
    }, f.admission),
  ).toThrow("owns exclusion");
  expect(f.lifecycle.readLifecycle()).toEqual([f.parent]);
});

test.each(["thenable", "mutation"])(
  "native admission rejects unexpected result or changed authority: %s",
  (kind) => {
    const f = fixture();
    expect(() =>
      f.lifecycle.mutateLifecycle(
        (previous) =>
          reserveWorkerLaunch(previous, {
            parentId: f.parent.id,
            expectedParent: f.parent,
            binding: f.binding,
            now: time,
          }).jobs,
        (previous, next) => {
          assertWorkerLaunchAdmission({
            previous,
            next,
            state: f.enrollment.readUnderLifecycleLock(),
            assertNativeWorkerEvidence: (job) => {
              // oxlint-disable-next-line unicorn/no-thenable -- Deliberate invalid admission return.
              if (kind === "thenable") return { then() {} };
              if (job.workerLaunch) job.workerLaunch.binding.sourceCommit = "b".repeat(40);
            },
          });
        },
      ),
    ).toThrow(
      kind === "thenable" ? "return undefined synchronously" : "changed during native admission",
    );
    expect(f.lifecycle.readLifecycle()).toEqual([f.parent]);
  },
);

test("actual controller requester resolves maintenance child cause under the same journal lock", () => {
  const f = fixture();
  const reserved = f.reserve();
  const queue = new InstallationRestarts(
    {
      read: () => f.lifecycle.readLifecycle(),
      write: (jobs) => f.lifecycle.writeLifecycle(jobs, f.admission),
      mutate: (update) => f.lifecycle.mutateLifecycle(update, f.admission),
    },
    {
      restart: async () => {
        throw new Error("No ordinary restart effect permitted");
      },
      resolveWorkerLaunchCause: () => ({
        supervisor: f.binding.supervisor,
        cause: f.binding.cause,
        profileSha256: f.binding.profileSha256,
        targetIdentitySha256: f.binding.targetIdentitySha256,
      }),
    },
  );
  const cause = f.binding.cause;
  if (cause.kind !== "predecessor") throw new Error("Expected predecessor fixture");
  const receipt = queue.request(
    {
      target: "container-daemon",
      reason: "Lost maintenance child reply",
      workerLaunchRequest: {
        profileSha256: hash,
        supervisorPid: f.binding.supervisor.pid,
        cause: { kind: "predecessor", generation: cause.generation },
      },
    },
    "container-agent",
  );
  expect(receipt.id).toBe(f.parent.id);
  expect(receipt.workerLaunch).toEqual(reserved.workerLaunch);
  expect(f.lifecycle.readLifecycle()).toHaveLength(1);
});

test("startup cause binds protected registration without inventing predecessor settlement", () => {
  const f = fixture();
  const startup = {
    ...f.binding,
    cause: {
      kind: "startup" as const,
      registrationGeneration: randomUUID(),
      registrationSha256: hash,
    },
  };
  const reserved = f.reserve(startup);
  expect(reserved.workerLaunch?.binding.cause).toEqual(startup.cause);
  expect(
    RestartRequestSchema.safeParse({
      target: "container-daemon",
      reason: "First registered worker",
      workerLaunchRequest: {
        profileSha256: hash,
        supervisorPid: 123,
        cause: { kind: "startup", registrationGeneration: startup.cause.registrationGeneration },
      },
    }).success,
  ).toBe(true);
});
