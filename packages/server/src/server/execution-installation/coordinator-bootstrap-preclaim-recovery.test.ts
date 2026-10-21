import {
  CoordinatorBootstrapRequestSchema,
  CoordinatorBootstrapPlanSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { validateWSOutboundMessage } from "@getpaseo/protocol/validation/ws-outbound";
import {
  handlePreclaimRecoveryReview,
  bootstrapReviewFeatures,
} from "./coordinator-bootstrap-session.js";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashSync } from "bcryptjs";
import { FileBootstrapPreclaimJournal } from "./coordinator-bootstrap-preclaim-journal.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { PreclaimRecoveryReviews } from "./coordinator-bootstrap-preclaim-recovery.js";
import {
  createDispatchingPreclaimReview,
  readPreclaimDispatchObservation,
} from "./coordinator-bootstrap-launch.js";
import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import { assertPreclaimControlBinding } from "./coordinator-bootstrap-preclaim-provisioned-host.js";
import {
  PreclaimRepairProvisioningSchema,
  provisionPreclaimRepair,
  verifyPreclaimRepairProposal,
  verifyPreclaimRepairProvisioning,
} from "./coordinator-bootstrap-preclaim-provisioning.js";
import type { BootstrapPreclaimRecoveryRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { CoordinatorBootstrapRequests, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import {
  executePreclaimRecovery,
  reconcilePreclaimRecovery,
  type PreclaimNativeOperations,
  cancellationFromClaimedRecovery,
  preclaimRecoveryPlanDigest,
  validatePreclaimRecoveryPlan,
  verifyPreclaimLiveProcesses,
  verifyPreclaimPreparationIsolation,
  verifyPreclaimSelectedService,
  verifyPreclaimOriginalApproval,
  verifyPreclaimEffectRequest,
  observePreclaimExecutor,
  waitForPreclaimExecutorExit,
} from "./coordinator-bootstrap-preclaim-recovery.js";

function fixture(directory = "/protected/state"): BootstrapPreclaimRecoveryRequest {
  const file = { path: "/protected/file", sha256: "a".repeat(64) };
  const release = {
    directory: "/protected/release",
    sourceCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64),
    node: { ...file, path: "/protected/node" },
    entrypoint: { ...file, path: "/protected/runner.js" },
    configuration: file,
    launcher: file,
  };
  const birth = {
    pid: 10,
    parentPid: 1,
    uid: 501,
    bootId: randomUUID(),
    startIdentity: "1:1",
    argumentsSha256: "d".repeat(64),
    executable: release.node.path,
  };
  const original: BootstrapPreclaimRecoveryRequest["plan"]["original"] = {
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "fixture",
    createdAt: new Date(0).toISOString(),
    decisionAt: new Date(1).toISOString(),
    status: "approved",
    planSha256: "",
    plan: {
      version: 1,
      operation: "coordinator-bootstrap",
      installationId: randomUUID(),
      service: "gui/501/local.vorteo.fixture.installation",
      expectedProcess: {
        pid: birth.pid,
        bootId: birth.bootId,
        startIdentity: birth.startIdentity,
        argumentsSha256: birth.argumentsSha256,
      },
      previous: release,
      candidate: release,
      state: {
        directory,
        restartJournal: path.join(directory, "restart.json"),
        ownerSessions: path.join(directory, "sessions.json"),
      },
      hostRequestsAfter: null,
    },
  };
  original.planSha256 = coordinatorPlanDigest(original.plan);
  const setup = { ...file, path: "/protected/setup.json" };
  const executorEntrypoint = {
    ...file,
    path: path.join(
      release.directory,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
    ),
  };
  const argv = [release.node.path, executorEntrypoint.path, setup.path, "executor", original.id];
  const plan: BootstrapPreclaimRecoveryRequest["plan"] = {
    version: 1,
    operation: "bootstrap-preclaim-recovery",
    original,
    canceled: {
      ...original,
      revision: randomUUID(),
      status: "canceled",
      decisionAt: undefined,
    },
    executor: {
      identity: {
        ...birth,
        pid: 20,
        parentPid: 21,
        startIdentity: "2:2",
        argumentsSha256: createHash("sha256").update(JSON.stringify(argv)).digest("hex"),
      },
      auditToken: [501, 501, 20, 501, 20, 20, 100, 200],
    },
    hostProcess: { ...birth, pid: 21, startIdentity: "1:2" },
    coordinatorProcess: birth,
    setup,
    ownerLauncher: file,
    runner: release,
    executorEntrypoint,
    selectedLauncher: file,
    selectedConfiguration: file,
    executionLock: {
      path: path.join(directory, "coordinator-bootstrap-execution.lock"),
      device: "1",
      inode: "10",
    },
    signalPolicy: { terminate: "SIGTERM", escalation: "none", graceSeconds: 10 },
  };
  return {
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Recover only the retained executor",
    createdAt: new Date(3).toISOString(),
    decisionAt: new Date(4).toISOString(),
    plan,
    planSha256: preclaimRecoveryPlanDigest(plan),
    status: "approved",
    execution: { generation: randomUUID(), stage: "claimed", updatedAt: new Date(5).toISOString() },
  };
}

test("derives only the reviewed cancellation from an exact claimed recovery", () => {
  const request = fixture();
  expect(cancellationFromClaimedRecovery(request)).toEqual({
    version: 1,
    recoveryId: request.id,
    recoveryRevision: request.revision,
    recoveryGeneration: request.execution!.generation,
    recoveryPlanSha256: request.planSha256,
    original: request.plan.original,
    canceled: { ...request.plan.canceled, decisionAt: request.decisionAt },
    executor: request.plan.executor,
  });
});

test("old approval, unclaimed review, changed digest and terminal generation cannot grant cancellation", () => {
  const request = fixture();
  for (const changed of [
    request.plan.original,
    { ...request, execution: undefined },
    { ...request, status: "pending" },
    { ...request, status: "canceled" },
    { ...request, decisionAt: undefined },
    { ...request, planSha256: "0".repeat(64) },
    { ...request, execution: { ...request.execution, stage: "succeeded" } },
  ])
    expect(() => cancellationFromClaimedRecovery(changed)).toThrow();
});

test("native structural admission binds parent, birth, command, selection and lock path", () => {
  const { plan } = fixture();
  for (const changed of [
    { ...plan, hostProcess: { ...plan.hostProcess, pid: 999 } },
    { ...plan, hostProcess: { ...plan.hostProcess, bootId: randomUUID() } },
    { ...plan, coordinatorProcess: { ...plan.coordinatorProcess, startIdentity: "9:9" } },
    {
      ...plan,
      executor: {
        ...plan.executor,
        identity: { ...plan.executor.identity, argumentsSha256: "0".repeat(64) },
      },
    },
    { ...plan, setup: { ...plan.setup, path: "/other/setup.json" } },
    { ...plan, runner: { ...plan.runner, sourceCommit: "0".repeat(40) } },
    { ...plan, selectedLauncher: { ...plan.selectedLauncher, sha256: "0".repeat(64) } },
    { ...plan, selectedConfiguration: { ...plan.selectedConfiguration, sha256: "0".repeat(64) } },
    { ...plan, executionLock: { ...plan.executionLock, path: "/other/lock" } },
  ])
    expect(() => validatePreclaimRecoveryPlan(changed)).toThrow("native binding changed");
});

test("review digest covers effect policy, retained bytes and kernel identities", () => {
  const { plan, planSha256 } = fixture();
  for (const changed of [
    { ...plan, signalPolicy: { ...plan.signalPolicy, escalation: "SIGKILL" as const } },
    { ...plan, signalPolicy: { ...plan.signalPolicy, graceSeconds: 20 } },
    { ...plan, ownerLauncher: { ...plan.ownerLauncher, sha256: "0".repeat(64) } },
    { ...plan, setup: { ...plan.setup, sha256: "0".repeat(64) } },
    { ...plan, executionLock: { ...plan.executionLock, inode: "11" } },
    { ...plan, executor: { ...plan.executor, auditToken: [501, 501, 20, 501, 20, 20, 100, 201] } },
  ])
    expect(preclaimRecoveryPlanDigest(changed)).not.toBe(planSha256);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const password = "disposable-review-owner";
const ownerPasswordHash = hashSync(password, 4);

test.each(["exact", "host", "executor", "coordinator", "argv", "boot", "uid", "executable"])(
  "independent preclaim control binds its distinct native role (%s)",
  (mode) => {
    const plan = fixture().plan;
    const setup = { node: plan.runner.node, entrypoint: plan.executorEntrypoint };
    const root = "/protected";
    const admissionSha256 = "a".repeat(64);
    const args = [
      setup.node.path,
      setup.entrypoint.path,
      root,
      "preclaim-repair-control",
      admissionSha256,
    ];
    const controlProcess = {
      ...plan.hostProcess,
      pid: 99,
      argumentsSha256: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    };
    if (mode === "host") controlProcess.pid = plan.hostProcess.pid;
    if (mode === "executor") controlProcess.pid = plan.executor.identity.pid;
    if (mode === "coordinator") controlProcess.pid = plan.coordinatorProcess.pid;
    if (mode === "argv") controlProcess.argumentsSha256 = "b".repeat(64);
    if (mode === "boot") controlProcess.bootId = randomUUID();
    if (mode === "uid") controlProcess.uid++;
    if (mode === "executable") controlProcess.executable = "/other/node";
    const inspect = () =>
      assertPreclaimControlBinding({
        setup,
        plan,
        provision: { installationRoot: root, admissionSha256, controlProcess },
      });
    if (mode === "exact") expect(inspect).not.toThrow();
    else expect(inspect).toThrow("control binding changed");
  },
);

test("independent preclaim provisioning preserves approval and requires owner authentication", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "preclaim-provision-")));
  roots.push(root);
  const state = path.join(root, "state/coordinator");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const plan = fixture(state).plan;
  function write(relative: string, contents: string) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, contents, { mode: 0o600 });
    return { path: file, sha256: createHash("sha256").update(contents).digest("hex") };
  }
  const configuration = write(
    "selected.json",
    JSON.stringify({
      public: { installationId: plan.original.plan.installationId },
      ownerPasswordHash,
    }),
  );
  plan.original.plan.previous.configuration = configuration;
  plan.selectedConfiguration = configuration;
  plan.original.planSha256 = coordinatorPlanDigest(plan.original.plan);
  plan.canceled = { ...plan.original, status: "canceled", revision: randomUUID() };
  delete plan.canceled.decisionAt;
  const installationRecord = write(
    "installation.json",
    JSON.stringify({
      root,
      installationId: plan.original.plan.installationId,
      coordinatorService: plan.original.plan.service,
    }),
  );
  const relative = "preclaim-repair-runtimes/" + "a".repeat(40);
  const entrypoint = write(
    relative +
      "/packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
    "disposable pinned review runner",
  );
  const ownerLauncher = write(relative + "/scripts/run-coordinator-owner.py", "fixture owner");
  const ownershipVerifier = write(
    relative + "/scripts/verify-coordinator-owner.py",
    "fixture verifier",
  );
  const directory = path.join(root, relative);
  const receipt = PreclaimRepairProvisioningSchema.parse({
    version: 1,
    operation: "provision-preclaim-repair",
    installationId: plan.original.plan.installationId,
    installationRecord,
    original: {
      id: plan.original.id,
      revision: plan.original.revision,
      planSha256: plan.original.planSha256,
    },
    recoveryPlanSha256: preclaimRecoveryPlanDigest(plan),
    runtime: {
      directory,
      sourceCommit: "a".repeat(40),
      artifactSha256: await digestBootstrapArtifact(directory),
      entrypoint,
      ownerLauncher,
      ownershipVerifier,
    },
  });
  const bytes = JSON.stringify(receipt);
  const admissionSha256 = createHash("sha256").update(bytes).digest("hex");
  const prefix = "claimed-repair-admissions/" + admissionSha256;
  write(prefix + "/claimed-repair-proposal.json", bytes);
  const legacy = new FileBootstrapRequestJournal(state);
  legacy.replace([], [plan.original]);
  const before = legacy.read();
  const input = { installationRoot: root, admissionSha256, plan, writableMountRoots: [] };
  expect((await verifyPreclaimRepairProposal(input)).receipt).toEqual(receipt);
  const admission = path.join(root, prefix, "claimed-repair-admission.json");
  await expect(provisionPreclaimRepair({ ...input, ownerPassword: "wrong" })).rejects.toThrow(
    "authentication",
  );
  expect(() => readFileSync(admission)).toThrow();
  const admitted = await provisionPreclaimRepair({ ...input, ownerPassword: password });
  expect(admitted.receipt).toEqual(receipt);
  expect(legacy.read()).toEqual(before);
  expect(new FileBootstrapPreclaimJournal(state).readReviews()).toEqual([]);
  expect(await provisionPreclaimRepair({ ...input, ownerPassword: password })).toEqual(admitted);
  expect(legacy.read()).toEqual(before);
  const admissionBytes = readFileSync(admission);
  const substituted = structuredClone(plan);
  substituted.signalPolicy.escalation = "SIGKILL";
  await expect(verifyPreclaimRepairProposal({ ...input, plan: substituted })).rejects.toThrow(
    "exact approval",
  );
  expect(
    PreclaimRepairProvisioningSchema.safeParse({
      ...receipt,
      operation: "provision-claimed-repair",
    }).success,
  ).toBe(false);
  expect(
    PreclaimRepairProvisioningSchema.safeParse({
      ...receipt,
      original: { ...receipt.original, generation: randomUUID() },
    }).success,
  ).toBe(false);
  const changed = { ...plan.original, revision: randomUUID() };
  legacy.replace(before, [changed]);
  await expect(provisionPreclaimRepair({ ...input, ownerPassword: password })).rejects.toThrow(
    "target changed",
  );
  expect(legacy.read()).toEqual([changed]);
  expect(readFileSync(admission)).toEqual(admissionBytes);
  writeFileSync(entrypoint.path, "substituted artifact", { mode: 0o600 });
  await expect(verifyPreclaimRepairProvisioning(input)).rejects.toThrow("digest changed");
  expect(readFileSync(admission)).toEqual(admissionBytes);
});

function reviewFixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "preclaim-review-")));
  roots.push(directory);
  const request = fixture(directory);
  const journal = new FileBootstrapPreclaimJournal(directory);
  const legacy = new FileBootstrapRequestJournal(directory);
  legacy.replace([], [request.plan.original]);
  const binding = {
    environment: "host",
    installationId: request.plan.original.plan.installationId,
    service: request.plan.original.plan.service,
    ownerPasswordHash,
  };
  let verify = async () => {};
  const service = new PreclaimRecoveryReviews(
    journal,
    () => binding,
    () => verify(),
  );
  return {
    request,
    journal,
    legacy,
    service,
    directory,
    binding,
    setVerify(value: () => Promise<void>) {
      verify = value;
    },
  };
}
function identity(request: BootstrapPreclaimRecoveryRequest) {
  return { id: request.id, revision: request.revision, planSha256: request.planSha256 };
}

test.each([
  "missing",
  "orphan-birth",
  "attempt",
  "birth",
  "after-claim",
  "wrong-plan",
  "wrong-birth",
  "linked",
  "ambiguous",
])(
  "recovery dispatch observation reads retained evidence without claiming liveness (%s)",
  (mode) => {
    const f = reviewFixture();
    const request = { ...f.request, execution: undefined };
    const reference = identity(request);
    const setup = path.join(
      f.directory,
      `coordinator-preclaim-launch-${request.id}-${request.revision}.json`,
    );
    const attempt = {
      version: 1,
      request: reference,
      setup,
      launcherPid: 20,
      attemptId: randomUUID(),
    };
    const attemptFile = path.join(
      f.directory,
      `coordinator-preclaim-attempt-${request.id}-${request.revision}.json`,
    );
    if (mode !== "missing" && mode !== "orphan-birth")
      writeFileSync(attemptFile, JSON.stringify(attempt), { mode: 0o600 });
    if (mode === "ambiguous")
      writeFileSync(
        path.join(f.directory, `coordinator-preclaim-attempt-${request.id}-${randomUUID()}.json`),
        JSON.stringify(attempt),
        { mode: 0o600 },
      );
    if (["birth", "after-claim", "wrong-birth", "linked", "orphan-birth"].includes(mode)) {
      const birth = {
        version: 1,
        request: reference,
        attemptId: mode === "wrong-birth" ? randomUUID() : attempt.attemptId,
        setup: { path: setup, sha256: "a".repeat(64) },
        executor: f.request.plan.executor,
      };
      const file = path.join(
        f.directory,
        `coordinator-preclaim-executor-${request.id}-${request.revision}.json`,
      );
      if (mode === "linked") {
        writeFileSync(`${file}.target`, JSON.stringify(birth), { mode: 0o600 });
        symlinkSync(`${file}.target`, file);
      } else writeFileSync(file, JSON.stringify(birth), { mode: 0o600 });
    }
    const input = mode === "after-claim" ? { ...f.request, revision: randomUUID() } : request;
    if (mode === "wrong-plan") input.planSha256 = "0".repeat(64);
    const actual = readPreclaimDispatchObservation(f.directory, input);
    expect(
      validateWSOutboundMessage({
        type: "session",
        message: {
          type: "installation.bootstrap_recovery.list_requests.response",
          payload: {
            requestId: randomUUID(),
            requests: [{ ...request, dispatch: actual }],
            error: null,
          },
        },
      }).success,
    ).toBe(true);
    if (mode === "missing") expect(actual).toEqual({ state: "no_receipt" });
    else if (mode === "attempt")
      expect(actual).toEqual({
        state: "attempt_retained",
        approvedRevision: reference.revision,
        attemptId: attempt.attemptId,
      });
    else if (mode === "birth" || mode === "after-claim")
      expect(actual).toEqual({
        state: "birth_retained",
        approvedRevision: reference.revision,
        attemptId: attempt.attemptId,
        executor: f.request.plan.executor.identity,
      });
    else expect(actual).toEqual({ state: "unavailable" });
    expect(f.legacy.read()).toEqual([f.request.plan.original]);
    expect(f.journal.readReviews()).toEqual([]);
  },
);

test("managed recovery cancellation wins during launch preparation", async () => {
  const f = reviewFixture();
  let release!: () => void;
  const prepared = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const preparing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let launches = 0;
  const service = createDispatchingPreclaimReview(f.service, async () => {
    started();
    await prepared;
    return async () => {
      launches++;
    };
  });
  const pending = await service.prepare({
    id: f.request.id,
    reason: f.request.reason,
    plan: f.request.plan,
  });
  const approval = service.decide({ ...identity(pending), decision: "approve" }, password, true);
  const result = approval.catch((error: Error) => error.message);
  await preparing;
  const approved = service.list()[0]!;
  const canceled = await service.decide(
    { ...identity(approved), decision: "cancel" },
    password,
    true,
  );
  release();
  expect(await result).toBe("Recovery decision changed before launch");
  expect(launches).toBe(0);
  expect(service.list()).toEqual([canceled]);
  expect(f.legacy.read()).toEqual([f.request.plan.original]);
});

test.each(["spawned", "uncertain", "preparation-failed"])(
  "managed recovery never replays an approval after %s",
  async (mode) => {
    const f = reviewFixture();
    let preparations = 0;
    let launches = 0;
    const prepareLaunch = async () => {
      preparations++;
      if (mode === "preparation-failed") throw new Error("preparation refused");
      return async () => {
        launches++;
        if (mode === "uncertain") throw new Error("private child details");
      };
    };
    const service = createDispatchingPreclaimReview(f.service, prepareLaunch);
    const pending = await service.prepare({
      id: f.request.id,
      reason: f.request.reason,
      plan: f.request.plan,
    });
    const result = await service
      .decide({ ...identity(pending), decision: "approve" }, password, true)
      .then(
        (request) => request,
        (error: Error) => error.message,
      );
    const approved = service.list()[0]!;
    const expected = {
      spawned: approved,
      uncertain:
        "Recovery launch is unconfirmed. Inspect its retained status; do not replay approval.",
      "preparation-failed": "preparation refused",
    };
    expect(result).toEqual(expected[mode as keyof typeof expected]);
    expect(approved.status).toBe("approved");
    expect(approved.execution).toBeUndefined();
    const reconstructed = createDispatchingPreclaimReview(f.service, prepareLaunch);
    expect(reconstructed.list()).toEqual([approved]);
    await expect(
      reconstructed.decide({ ...identity(approved), decision: "approve" }, password, true),
    ).rejects.toThrow("review changed or dispatch claimed");
    expect(preparations).toBe(1);
    expect(launches).toBe(mode === "preparation-failed" ? 0 : 1);
    expect(f.legacy.read()).toEqual([f.request.plan.original]);
  },
);

test.each([
  "unchanged",
  "launcher",
  "configuration",
  "final-launcher",
  "final-configuration",
  "copied-path",
  "coordinator",
])(
  "terminal selection proof verifies actual selected bytes and native identity (%s)",
  async (change) => {
    const f = reviewFixture();
    const plan = f.request.plan;
    const launcherFile = path.join(f.directory, "selected.plist");
    const configurationFile = path.join(f.directory, "selected.json");
    const retain = (file: string, text: string) => {
      writeFileSync(file, text, { mode: 0o600 });
      return { path: file, sha256: createHash("sha256").update(text).digest("hex") };
    };
    plan.selectedLauncher = retain(launcherFile, "retained launcher bytes");
    plan.selectedConfiguration = retain(configurationFile, "retained configuration bytes");
    plan.original.plan.previous.launcher = plan.selectedLauncher;
    plan.original.plan.previous.configuration = plan.selectedConfiguration;
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          plan.original.plan.previous.node.path,
          plan.original.plan.previous.entrypoint.path,
          configurationFile,
        ]),
      )
      .digest("hex");
    plan.coordinatorProcess.argumentsSha256 = digest;
    plan.original.plan.expectedProcess.argumentsSha256 = digest;
    plan.original.planSha256 = coordinatorPlanDigest(plan.original.plan);
    plan.canceled = {
      ...plan.original,
      revision: randomUUID(),
      status: "canceled",
      decisionAt: undefined,
    };
    if (change === "copied-path")
      plan.selectedLauncher = retain(
        path.join(f.directory, "copy.plist"),
        "retained launcher bytes",
      );
    let reads = 0;
    const reader = {
      readService: async (service: string) =>
        `${service} = {\n\tpid = ${plan.coordinatorProcess.pid}\n}`,
      inspectProcess: async () => {
        reads++;
        if (reads === 3 && change === "launcher") writeFileSync(launcherFile, "changed");
        if (reads === 3 && change === "configuration") writeFileSync(configurationFile, "changed");
        if (reads === 6 && change === "final-launcher") writeFileSync(launcherFile, "changed");
        if (reads === 6 && change === "final-configuration")
          writeFileSync(configurationFile, "changed");
        return change === "coordinator"
          ? { ...plan.coordinatorProcess, startIdentity: "999:999" }
          : plan.coordinatorProcess;
      },
    };
    const result = await verifyPreclaimSelectedService({
      plan,
      reader,
      launcherFile,
      configurationFile,
      writableMountRoots: [],
    }).then(
      () => "verified",
      (error: Error) => error.message,
    );
    const expected: Record<string, string> = {
      unchanged: "verified",
      launcher: "Prepared document digest changed",
      configuration: "Prepared document digest changed",
      "final-launcher": "Prepared document digest changed",
      "final-configuration": "Prepared document digest changed",
      "copied-path": "Preclaim recovery selected paths changed",
      coordinator: "Loaded coordinator process changed since preparation",
    };
    expect(result).toBe(expected[change]);
  },
);

test("owner-authenticated explicit review claims once and feeds the durable cancellation fence", async () => {
  const f = reviewFixture();
  const pending = await f.service.prepare({
    id: f.request.id,
    reason: f.request.reason,
    plan: f.request.plan,
  });
  await expect(
    f.service.decide({ ...identity(pending), decision: "approve" }, password, false),
  ).rejects.toThrow("Reload to review");
  await expect(
    f.service.decide({ ...identity(pending), decision: "approve" }, "wrong", true),
  ).rejects.toThrow("authentication required");
  expect(f.service.list()).toEqual([pending]);
  const approved = await f.service.decide(
    { ...identity(pending), decision: "approve" },
    password,
    true,
  );
  const claimed = await f.service.claim(identity(approved));
  await expect(f.service.claim(identity(approved))).rejects.toThrow("undispatched");
  const cancellation = cancellationFromClaimedRecovery(claimed);
  expect(pending.plan.canceled.decisionAt).toBeUndefined();
  expect(cancellation.canceled.decisionAt).toBe(approved.decisionAt);
  expect(cancellation.original.decisionAt).toBe(f.request.plan.original.decisionAt);
  expect(f.journal.fence(cancellation).fenced).toBe(true);
  expect(f.legacy.read()).toEqual([
    { ...f.request.plan.canceled, decisionAt: approved.decisionAt },
  ]);
  expect(new FileBootstrapPreclaimJournal(f.directory).readReviews()).toEqual([claimed]);
  await expect(
    f.service.decide({ ...identity(claimed), decision: "cancel" }, password, true),
  ).rejects.toThrow("dispatch claimed");
});

test("preparation cannot manufacture an owner cancellation timestamp", async () => {
  const f = reviewFixture();
  await expect(
    f.service.prepare({
      id: f.request.id,
      reason: f.request.reason,
      plan: {
        ...f.request.plan,
        canceled: { ...f.request.plan.canceled, decisionAt: new Date(0).toISOString() },
      },
    }),
  ).rejects.toThrow("Cancellation time must come from the recovery owner decision");
  expect(f.service.list()).toEqual([]);
  expect(f.legacy.read()).toEqual([f.request.plan.original]);
});

test("owner cancellation during recovery claim verification wins without dispatch", async () => {
  const f = reviewFixture();
  const pending = await f.service.prepare({
    id: f.request.id,
    reason: f.request.reason,
    plan: f.request.plan,
  });
  const approved = await f.service.decide(
    { ...identity(pending), decision: "approve" },
    password,
    true,
  );
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setVerify(() => barrier);
  const claim = f.service.claim(identity(approved));
  const rejected = expect(claim).rejects.toThrow("review changed");
  const canceled = await f.service.decide(
    { ...identity(approved), decision: "cancel" },
    password,
    false,
  );
  release();
  await rejected;
  expect(f.service.list()).toEqual([canceled]);
  expect(f.legacy.read()).toEqual([f.request.plan.original]);
  expect(f.journal.inspect(canceled.id)).toBeNull();
});

test("installation changes and competing recovery reviews fail closed", async () => {
  const f = reviewFixture();
  const pending = await f.service.prepare({
    id: f.request.id,
    reason: f.request.reason,
    plan: f.request.plan,
  });
  await expect(
    f.service.prepare({ id: randomUUID(), reason: f.request.reason, plan: f.request.plan }),
  ).rejects.toThrow("already open");
  f.binding.installationId = randomUUID();
  await expect(
    f.service.decide({ ...identity(pending), decision: "approve" }, password, true),
  ).rejects.toThrow("installation changed");
  expect(f.service.list()).toEqual([pending]);
});

test("changed owner authority during approval verification cannot save approval", async () => {
  const f = reviewFixture();
  const pending = await f.service.prepare({
    id: f.request.id,
    reason: f.request.reason,
    plan: f.request.plan,
  });
  f.setVerify(async () => {
    f.binding.ownerPasswordHash = hashSync("replacement-owner", 4);
  });
  await expect(
    f.service.decide({ ...identity(pending), decision: "approve" }, password, true),
  ).rejects.toThrow("installation changed");
  expect(f.service.list()).toEqual([pending]);
});

test("invalid old approval or changed cancellation is refused before native preparation", async () => {
  const f = reviewFixture();
  let verifications = 0;
  f.setVerify(async () => {
    verifications++;
  });
  for (const changed of [
    { ...f.request.plan, original: { ...f.request.plan.original, status: "pending" } },
    { ...f.request.plan, canceled: { ...f.request.plan.canceled, reason: "hidden change" } },
  ])
    await expect(
      f.service.prepare({ id: randomUUID(), reason: f.request.reason, plan: changed }),
    ).rejects.toThrow("binding changed");
  expect(verifications).toBe(0);
  expect(f.service.list()).toEqual([]);
});

async function executionFixture(escalation: "none" | "SIGKILL" = "none") {
  const f = reviewFixture();
  f.request.plan.signalPolicy.escalation = escalation;
  const pending = await f.service.prepare({
    id: f.request.id,
    reason: f.request.reason,
    plan: f.request.plan,
  });
  const approved = await f.service.decide(
    { ...identity(pending), decision: "approve" },
    password,
    true,
  );
  const calls: string[] = [];
  const state = {
    aliveAfterTerm: false,
    signalFails: false,
    terminalProof: true,
    beforeCancelProof: true,
  };
  const native: PreclaimNativeOperations = {
    withRecoveryOwnership: async (operation) => operation(),
    verifyBeforeCancellation: async () => {
      if (!state.beforeCancelProof) throw new Error("identity changed");
    },
    inspectExecutor: async () => "alive",
    verifyBeforeEffect: async () => {
      expect(f.legacy.read()).toEqual([
        { ...f.request.plan.canceled, decisionAt: approved.decisionAt },
      ]);
    },
    terminateExact: async (request) => {
      expect(request).toEqual(f.service.list()[0]);
      expect(f.journal.inspect(approved.id)?.terminateIntentAt).not.toBeNull();
      expect(f.service.list()[0]?.execution?.stage).toBe("effect_pending");
      calls.push("terminate");
      if (state.signalFails) throw new Error("result lost");
    },
    waitAfterTermination: async () => (state.aliveAfterTerm ? "alive" : "exited"),
    killExact: async (request) => {
      expect(request).toEqual(f.service.list()[0]);
      expect(f.journal.inspect(approved.id)?.killIntentAt).not.toBeNull();
      calls.push("kill");
    },
    waitAfterKill: async () => {},
    withVerifiedExitAndSelection: async (request, operation) => {
      expect(request).toEqual(f.service.list()[0]);
      if (!state.terminalProof) throw new Error("exit, lock or selection unproven");
      return operation();
    },
  };
  return { ...f, approved, calls, state, native };
}

test("execution records intents before effects and cannot replay the approval", async () => {
  const f = await executionFixture();
  const input = {
    reviews: f.service,
    identity: identity(f.approved),
    journal: f.journal,
    native: f.native,
  };
  const result = await executePreclaimRecovery(input);
  expect(result.execution?.stage).toBe("succeeded");
  expect(f.calls).toEqual(["terminate"]);
  await expect(executePreclaimRecovery(input)).rejects.toThrow("undispatched");
  expect(f.calls).toEqual(["terminate"]);
});

test.each(["none", "SIGKILL"] as const)(
  "escalation follows only the exact reviewed policy (%s)",
  async (escalation) => {
    const f = await executionFixture(escalation);
    f.state.aliveAfterTerm = true;
    const result = await executePreclaimRecovery({
      reviews: f.service,
      identity: identity(f.approved),
      journal: f.journal,
      native: f.native,
    });
    expect(f.calls).toEqual(escalation === "SIGKILL" ? ["terminate", "kill"] : ["terminate"]);
    expect(result.execution?.stage).toBe(
      escalation === "SIGKILL" ? "succeeded" : "recovery_required",
    );
  },
);

test.each(["signal", "terminal"])(
  "uncertain %s result permits only independent observation, never replay",
  async (failure) => {
    const f = await executionFixture();
    f.state.signalFails = failure === "signal";
    f.state.terminalProof = false;
    const failed = await executePreclaimRecovery({
      reviews: f.service,
      identity: identity(f.approved),
      journal: f.journal,
      native: f.native,
    });
    expect(failed.execution?.stage).toBe("recovery_required");
    const uncertain = await reconcilePreclaimRecovery({
      reviews: f.service,
      identity: identity(failed),
      journal: f.journal,
      native: f.native,
    });
    expect(uncertain.execution?.stage).toBe("recovery_required");
    f.state.terminalProof = true;
    const verified = await reconcilePreclaimRecovery({
      reviews: f.service,
      identity: identity(uncertain),
      journal: f.journal,
      native: f.native,
    });
    expect(verified.execution?.stage).toBe("succeeded");
    expect(f.calls).toEqual(["terminate"]);
  },
);

test("identity failure before cancellation preserves old approval and sends no signal", async () => {
  const f = await executionFixture();
  f.state.beforeCancelProof = false;
  const result = await executePreclaimRecovery({
    reviews: f.service,
    identity: identity(f.approved),
    journal: f.journal,
    native: f.native,
  });
  expect(result.execution?.stage).toBe("aborted_before_effects");
  expect(f.legacy.read()).toEqual([f.request.plan.original]);
  expect(f.journal.inspect(f.approved.id)).toBeNull();
  expect(f.calls).toEqual([]);
  const replacement = await f.service.prepare({
    id: randomUUID(),
    reason: "Review a freshly verified recovery after the aborted attempt",
    plan: f.request.plan,
  });
  expect(replacement.status).toBe("pending");
  await expect(
    executePreclaimRecovery({
      reviews: f.service,
      identity: identity(result),
      journal: f.journal,
      native: f.native,
    }),
  ).rejects.toThrow("undispatched");
});

test("a lost pre-cancellation claim can be closed by observation without effects", async () => {
  const f = await executionFixture();
  const claimed = await f.service.claim(identity(f.approved));
  const observed = await reconcilePreclaimRecovery({
    reviews: f.service,
    identity: identity(claimed),
    journal: f.journal,
    native: {
      withRecoveryOwnership: f.native.withRecoveryOwnership,
      withVerifiedExitAndSelection: async () => {
        throw new Error("No termination or exit proof is authorized for this result");
      },
    },
  });
  expect(observed.execution?.stage).toBe("aborted_before_effects");
  expect(f.legacy.read()).toEqual([f.request.plan.original]);
  expect(f.calls).toEqual([]);
});

test("abort proof refuses retained intent, changed original and stale recovery review", async () => {
  const f = await executionFixture();
  const claimed = await f.service.claim(identity(f.approved));
  const cancellation = cancellationFromClaimedRecovery(claimed);
  expect(() => f.journal.abortBeforeEffects(f.approved)).toThrow("ownership changed");
  f.legacy.replace([f.request.plan.original], [cancellation.canceled]);
  expect(f.journal.abortBeforeEffects(claimed)).toBeNull();
  f.legacy.replace([cancellation.canceled], [f.request.plan.original]);
  f.journal.fence(cancellation);
  expect(f.journal.abortBeforeEffects(claimed)).toBeNull();
  expect(f.service.list()[0]?.execution?.stage).toBe("claimed");
  expect(f.calls).toEqual([]);
});

test.each(["executor", "host", "coordinator", "service"])(
  "native process proof refuses a changed %s during the second observation",
  async (changed) => {
    const { plan } = fixture();
    let serviceReads = 0;
    await expect(
      verifyPreclaimLiveProcesses({
        plan,
        reader: {
          verifyProcessExited: async () => {
            throw new Error("No retained observation was reviewed");
          },
          inspectProcess: async (pid) => {
            const role = pid === plan.hostProcess.pid ? "host" : "coordinator";
            const value = role === "host" ? plan.hostProcess : plan.coordinatorProcess;
            return serviceReads && role === changed
              ? { ...value, startIdentity: "999:999" }
              : value;
          },
          inspectAuditedProcess: async () => {
            const value = structuredClone(plan.executor);
            if (serviceReads && changed === "executor") value.auditToken[7]++;
            return value;
          },
          readService: async (service) => {
            serviceReads++;
            const pid =
              serviceReads === 2 && changed === "service" ? 999 : plan.coordinatorProcess.pid;
            return `${service} = {\n\tpid = ${pid}\n}`;
          },
        },
      }),
    ).rejects.toThrow(
      changed === "service" ? "selected coordinator changed" : "process identity changed",
    );
  },
);

function retainedFixture() {
  const f = reviewFixture();
  const plan = f.request.plan;
  const setupPath = path.join(f.directory, "retained-setup.json");
  const request = {
    id: plan.original.id,
    revision: plan.original.revision,
    planSha256: plan.original.planSha256,
  };
  const setup = {
    node: plan.runner.node,
    entrypoint: plan.executorEntrypoint,
    renewal: { hostProcess: plan.hostProcess, request },
  };
  const setupBytes = Buffer.from(JSON.stringify(setup));
  writeFileSync(setupPath, setupBytes, { mode: 0o600 });
  plan.setup = { path: setupPath, sha256: createHash("sha256").update(setupBytes).digest("hex") };
  plan.executor.identity.argumentsSha256 = createHash("sha256")
    .update(
      JSON.stringify([
        plan.runner.node.path,
        plan.executorEntrypoint.path,
        setupPath,
        "executor",
        plan.original.id,
      ]),
    )
    .digest("hex");
  const inspector = { path: "/protected/inspector.py", sha256: "e".repeat(64) };
  const retained = {
    version: 1,
    provenance: "observed-after-launch",
    observedAt: new Date().toISOString(),
    request,
    setup: plan.setup,
    inspector,
    ownerLauncher: plan.ownerLauncher,
    executor: structuredClone(plan.executor),
    host: plan.hostProcess,
    coordinator: plan.coordinatorProcess,
    executionLock: plan.executionLock,
  };
  const observationPath = path.join(f.directory, "observation.json");
  const save = () => {
    const bytes = Buffer.from(JSON.stringify(retained));
    writeFileSync(observationPath, bytes, { mode: 0o600 });
    plan.retainedObservation = {
      path: observationPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  save();
  let exitProofs = 0;
  const reader = {
    inspectProcess: async (pid: number) => {
      if (pid !== plan.coordinatorProcess.pid) throw new Error("Original Host is gone");
      return plan.coordinatorProcess;
    },
    inspectAuditedProcess: async () => ({
      ...plan.executor,
      identity: { ...plan.executor.identity, parentPid: 1 },
    }),
    verifyProcessExited: async (pid: number) => {
      expect(pid).toBe(plan.hostProcess.pid);
      exitProofs++;
    },
    readService: async (service: string) =>
      `${service} = {\n\tpid = ${plan.coordinatorProcess.pid}\n}`,
  };
  return {
    ...f,
    plan,
    retained,
    save,
    reader,
    retainedContext: { inspector, writableMountRoots: [] as string[] },
    exitProofs: () => exitProofs,
  };
}

test("reparented identity requires exact protected observation, renewal parent and independent exit proof", async () => {
  const f = retainedFixture();
  const input = { plan: f.plan, reader: f.reader, retainedContext: f.retainedContext };
  await verifyPreclaimLiveProcesses(input);
  expect(f.exitProofs()).toBe(2);
  const digest = preclaimRecoveryPlanDigest(f.plan);
  await expect(verifyPreclaimLiveProcesses({ plan: f.plan, reader: f.reader })).rejects.toThrow(
    "context required",
  );
  await expect(
    verifyPreclaimLiveProcesses({
      ...input,
      reader: {
        ...f.reader,
        verifyProcessExited: async () => {
          throw new Error("Parent exit unproven");
        },
      },
    }),
  ).rejects.toThrow("Parent exit unproven");
  const withoutEvidence = { ...f.plan, retainedObservation: undefined };
  expect(preclaimRecoveryPlanDigest(withoutEvidence)).not.toBe(digest);
  await expect(verifyPreclaimLiveProcesses({ ...input, plan: withoutEvidence })).rejects.toThrow(
    "Original Host is gone",
  );
});

test.each(["request", "executor", "inspector", "lock"])(
  "repinned retained %s evidence cannot change the reviewed binding",
  async (changed) => {
    const f = retainedFixture();
    if (changed === "request") f.retained.request.revision = randomUUID();
    if (changed === "executor") f.retained.executor.auditToken[7]++;
    if (changed === "inspector")
      f.retained.inspector = { ...f.retained.inspector, sha256: "f".repeat(64) };
    if (changed === "lock")
      f.retained.executionLock = { ...f.retained.executionLock, inode: "999" };
    f.save();
    await expect(
      verifyPreclaimLiveProcesses({
        plan: f.plan,
        reader: f.reader,
        retainedContext: f.retainedContext,
      }),
    ).rejects.toThrow("observation binding changed");
  },
);

test("guest-writable observation and changed protected renewal bytes refuse reparented admission", async () => {
  const f = retainedFixture();
  await expect(
    verifyPreclaimLiveProcesses({
      plan: f.plan,
      reader: f.reader,
      retainedContext: { ...f.retainedContext, writableMountRoots: [f.directory] },
    }),
  ).rejects.toThrow("mount");
  writeFileSync(f.plan.setup.path, "{}");
  await expect(
    verifyPreclaimLiveProcesses({
      plan: f.plan,
      reader: f.reader,
      retainedContext: f.retainedContext,
    }),
  ).rejects.toThrow("digest changed");
});

test.runIf(process.platform === "darwin")(
  "retained native identity survives actual disposable parent exit",
  async () => {
    const f = retainedFixture();
    const plan = f.plan;
    const helper = path.join(f.directory, "inspector.py");
    const helperBytes = readFileSync(
      fileURLToPath(
        new URL("../../../../../scripts/inspect-coordinator-process.py", import.meta.url),
      ),
    );
    writeFileSync(helper, helperBytes, { mode: 0o600 });
    const inspector = {
      path: helper,
      sha256: createHash("sha256").update(helperBytes).digest("hex"),
    };
    const reader = await createNativeBootstrapServiceReader({
      helperPath: helper,
      helperSha256: inspector.sha256,
      writableMountRoots: [],
    });
    const node = realpathSync(process.execPath);
    const entry = path.join(
      f.directory,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
    );
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, 'process.send("ready"); setTimeout(() => process.exit(0), 30000);', {
      mode: 0o600,
    });
    const parentCode =
      'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,process.argv.slice(1),{stdio:["ignore","ignore","ignore","ipc"]}); c.once("message",()=>process.send(c.pid)); process.once("message",()=>process.exit(0));';
    const parent = spawn(
      node,
      ["-e", parentCode, entry, plan.setup.path, "executor", plan.original.id],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    let executorPid: number | undefined;
    try {
      executorPid = z
        .number()
        .int()
        .positive()
        .parse((await once(parent, "message"))[0]);
      plan.hostProcess = ProcessObservationSchema.parse(await reader.inspectProcess(parent.pid!));
      plan.executor = await reader.inspectAuditedProcess(executorPid);
      plan.runner.directory = f.directory;
      plan.runner.node.path = node;
      plan.executorEntrypoint = {
        path: entry,
        sha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
      };
      plan.coordinatorProcess = {
        ...plan.coordinatorProcess,
        bootId: plan.executor.identity.bootId,
        uid: plan.executor.identity.uid,
        executable: node,
      };
      plan.original.plan.expectedProcess = {
        ...plan.original.plan.expectedProcess,
        bootId: plan.coordinatorProcess.bootId,
      };
      plan.original.planSha256 = coordinatorPlanDigest(plan.original.plan);
      plan.canceled = {
        ...plan.original,
        revision: randomUUID(),
        status: "canceled",
        decisionAt: undefined,
      };
      const request = {
        id: plan.original.id,
        revision: plan.original.revision,
        planSha256: plan.original.planSha256,
      };
      const setup = Buffer.from(
        JSON.stringify({
          node: plan.runner.node,
          entrypoint: plan.executorEntrypoint,
          renewal: { hostProcess: plan.hostProcess, request },
        }),
      );
      writeFileSync(plan.setup.path, setup);
      plan.setup.sha256 = createHash("sha256").update(setup).digest("hex");
      Object.assign(f.retained, {
        request,
        setup: plan.setup,
        inspector,
        executor: structuredClone(plan.executor),
        host: plan.hostProcess,
        coordinator: plan.coordinatorProcess,
      });
      f.save();
      const exited = once(parent, "exit");
      parent.send("exit");
      await exited;
      const observed = await reader.inspectAuditedProcess(executorPid);
      expect(observed).toEqual({
        ...plan.executor,
        identity: { ...plan.executor.identity, parentPid: 1 },
      });
      await verifyPreclaimLiveProcesses({
        plan,
        reader: {
          ...reader,
          inspectProcess: async (pid) =>
            pid === plan.coordinatorProcess.pid
              ? plan.coordinatorProcess
              : reader.inspectProcess(pid),
          readService: f.reader.readService,
        },
        retainedContext: { inspector, writableMountRoots: [] },
      });
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        const closed = once(parent, "exit");
        parent.kill();
        await closed;
      }
      if (executorPid !== undefined) {
        // This PID belongs only to the disposable child created by this test.
        expect((await reader.inspectAuditedProcess(executorPid)).auditToken).toEqual(
          plan.executor.auditToken,
        );
        process.kill(executorPid, "SIGTERM");
      }
    }
  },
  30_000,
);

test.runIf(process.platform === "darwin").each(["isolated", "shared-group"])(
  "native proof binds disposable processes, preparation isolation and audit identity (%s)",
  async (mode) => {
    const f = reviewFixture();
    const helper = path.join(f.directory, "inspector.py");
    const bytes = readFileSync(
      fileURLToPath(
        new URL("../../../../../scripts/inspect-coordinator-process.py", import.meta.url),
      ),
    );
    writeFileSync(helper, bytes, { mode: 0o600 });
    const reader = await createNativeBootstrapServiceReader({
      helperPath: helper,
      helperSha256: createHash("sha256").update(bytes).digest("hex"),
      writableMountRoots: [],
    });
    const entry = path.join(
      f.directory,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
    );
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, 'process.send("ready"); setInterval(() => {}, 1000);', { mode: 0o600 });
    const node = realpathSync(process.execPath);
    const setup = path.join(f.directory, "setup.json");
    const executor = spawn(node, [entry, setup, "executor", f.request.plan.original.id], {
      detached: mode === "isolated",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const coordinator = spawn(node, [entry], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try {
      await Promise.all([once(executor, "message"), once(coordinator, "message")]);
      const plan = f.request.plan;
      plan.hostProcess = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
      plan.coordinatorProcess = ProcessObservationSchema.parse(
        await reader.inspectProcess(coordinator.pid!),
      );
      plan.executor = await reader.inspectAuditedProcess(executor.pid!);
      plan.runner.node.path = node;
      plan.runner.directory = f.directory;
      plan.executorEntrypoint = {
        path: entry,
        sha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
      };
      plan.setup.path = setup;
      const { pid, bootId, startIdentity, argumentsSha256 } = plan.coordinatorProcess;
      plan.original.plan.expectedProcess = { pid, bootId, startIdentity, argumentsSha256 };
      plan.original.planSha256 = coordinatorPlanDigest(plan.original.plan);
      plan.canceled = {
        ...plan.original,
        revision: randomUUID(),
        status: "canceled",
        decisionAt: undefined,
      };
      const ports = {
        ...reader,
        // This test owns no launchd job; only the service lookup is simulated.
        readService: async (service: string) => `${service} = {\n\tpid = ${pid}\n}`,
      };
      await verifyPreclaimLiveProcesses({ plan, reader: ports });
      const owner = fileURLToPath(
        new URL("../../../../../scripts/run-coordinator-owner.py", import.meta.url),
      );
      const isolation = verifyPreclaimPreparationIsolation({
        plan,
        reader: ports,
        helper: {
          path: owner,
          sha256: createHash("sha256").update(readFileSync(owner)).digest("hex"),
        },
        inspector: { path: helper, sha256: createHash("sha256").update(bytes).digest("hex") },
        writableMountRoots: [],
      });
      if (mode === "isolated") await isolation;
      else await expect(isolation).rejects.toThrow("isolation is unproven");
      plan.executor.auditToken[7]++;
      await expect(verifyPreclaimLiveProcesses({ plan, reader: ports })).rejects.toThrow(
        "process identity changed",
      );
    } finally {
      await Promise.all(
        [executor, coordinator].map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const closed = once(child, "close");
          child.kill();
          await closed;
        }),
      );
    }
  },
  30_000,
);

test
  .runIf(process.platform === "darwin")
  .each([
    "exited",
    "selected",
    "changed-selection",
    "live",
    "orphan-child",
    "wrong-inode",
    "unheld-recovery",
    "unheld-selected",
    "held-execution",
    "stale-review",
    "callback-failure",
  ])(
  "native terminal ownership requires independent exit and both exact kernel locks (%s)",
  async (mode) => {
    const f = reviewFixture();
    const inspector = fileURLToPath(
      new URL("../../../../../scripts/inspect-coordinator-process.py", import.meta.url),
    );
    const processReader = await createNativeBootstrapServiceReader({
      helperPath: inspector,
      helperSha256: createHash("sha256").update(readFileSync(inspector)).digest("hex"),
      writableMountRoots: [],
    });
    const orphanCode =
      'const {spawn}=require("node:child_process");const c=spawn("/bin/sleep",["30"],{stdio:"ignore"});c.once("spawn",()=>console.log(c.pid));setInterval(()=>{},1000);';
    const target =
      mode === "orphan-child"
        ? spawn(process.execPath, ["-e", orphanCode], {
            detached: true,
            stdio: ["ignore", "pipe", "ignore"],
          })
        : spawn("/bin/sleep", ["30"], { stdio: "ignore", detached: true });
    let orphan: Awaited<ReturnType<typeof processReader.inspectAuditedProcess>> | undefined;
    await once(target, "spawn");
    try {
      if (mode === "orphan-child") {
        const message = (await once(target.stdout!, "data"))[0];
        const pid = Number(message.toString().trim());
        orphan = await processReader.inspectAuditedProcess(pid);
      }
      const plan = f.request.plan;
      plan.executor.identity.pid = target.pid!;
      plan.executor.auditToken[5] = target.pid!;
      writeFileSync(plan.executionLock.path, "", { mode: 0o600 });
      const lock = statSync(plan.executionLock.path, { bigint: true });
      plan.executionLock.device = String(lock.dev);
      plan.executionLock.inode = mode === "wrong-inode" ? "1" : String(lock.ino);
      if (mode === "selected" || mode === "changed-selection" || mode === "unheld-selected") {
        const retain = (name: string, contents: string) => {
          const file = path.join(f.directory, name);
          writeFileSync(file, contents, { mode: 0o600 });
          return { path: file, sha256: createHash("sha256").update(contents).digest("hex") };
        };
        plan.selectedLauncher = retain("selected.plist", "unchanged launcher");
        plan.selectedConfiguration = retain("selected.json", "{}");
        plan.original.plan.previous.launcher = plan.selectedLauncher;
        plan.original.plan.previous.configuration = plan.selectedConfiguration;
        const argv = [
          plan.original.plan.previous.node.path,
          plan.original.plan.previous.entrypoint.path,
          plan.selectedConfiguration.path,
        ];
        const digest = createHash("sha256").update(JSON.stringify(argv)).digest("hex");
        plan.coordinatorProcess.argumentsSha256 = digest;
        plan.original.plan.expectedProcess.argumentsSha256 = digest;
        plan.original.planSha256 = coordinatorPlanDigest(plan.original.plan);
        plan.canceled = {
          ...plan.original,
          revision: randomUUID(),
          status: "canceled",
          decisionAt: undefined,
        };
        f.legacy.replace(f.legacy.read(), [plan.original]);
      }
      const pending = await f.service.prepare({ id: f.request.id, reason: f.request.reason, plan });
      const approved = await f.service.decide(
        { ...identity(pending), decision: "approve" },
        password,
        true,
      );
      const claimed = await f.service.claim(identity(approved));
      f.journal.fence(cancellationFromClaimedRecovery(claimed));
      const fenced = f.service.advance(claimed, "cancellation_fenced");
      const verifying = f.service.advance(fenced, "verifying");
      const requestFile = path.join(f.directory, "request.json");
      writeFileSync(requestFile, JSON.stringify(verifying), { mode: 0o600 });
      if (mode === "stale-review") f.service.advance(verifying, "recovery_required");
      if (mode !== "live") {
        const closed = once(target, "close");
        target.kill();
        await closed;
      }
      const helper = fileURLToPath(
        new URL("../../../../../scripts/run-coordinator-owner.py", import.meta.url),
      );
      const moduleFile = fileURLToPath(
        new URL("./coordinator-bootstrap-preclaim-recovery.ts", import.meta.url),
      );
      const driver = path.join(f.directory, "driver.ts");
      writeFileSync(
        driver,
        `
import {withPreclaimKernelOwnership,createPreclaimNativeOperations} from ${JSON.stringify(moduleFile)};
import {readFileSync,writeFileSync,closeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createNativeBootstrapServiceReader} from ${JSON.stringify(fileURLToPath(new URL("./coordinator-bootstrap-service.ts", import.meta.url)))};
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
const probe=${JSON.stringify("import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR)\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(7)\n")};
async function main(){
 const nativeReader=await createNativeBootstrapServiceReader({helperPath:${JSON.stringify(fileURLToPath(new URL("../../../../../scripts/inspect-coordinator-process.py", import.meta.url)))},helperSha256:${JSON.stringify(
   createHash("sha256")
     .update(
       readFileSync(
         fileURLToPath(
           new URL("../../../../../scripts/inspect-coordinator-process.py", import.meta.url),
         ),
       ),
     )
     .digest("hex"),
 )},writableMountRoots:[]});
 let callback=false, held=false, accepted=false, failure=null, selectionHeld=false;
 const combined=process.argv[3]==='selected'||process.argv[3]==='changed-selection'||process.argv[3]==='unheld-selected';
 const verify=combined?async(input)=>{
  let admitted=false;
  const native=createPreclaimNativeOperations({...input,
   stateDirectory:request.plan.original.plan.state.directory,
   inspector:{path:'/unused-inspector',sha256:'a'.repeat(64)},journal:{},
   verifySupportedPlan:async(plan)=>{if(plan.original.id!==request.plan.original.id)throw Error('Wrong plan');admitted=true;},
  });
  await native.withRecoveryOwnership(async()=>{
   let nestedRefused=false;
   try{await native.withRecoveryOwnership(async()=>{throw Error('Nested operation entered');});}
   catch(error){nestedRefused=error.message==='Recovery executor is already active';}
   if(!nestedRefused)throw Error('Nested execution was not refused');
   return native.withVerifiedExitAndSelection(request,input.operation);
  });
  let outsideRefused=false;
  try{await native.inspectExecutor(request);}
  catch(error){outsideRefused=error.message==='Recovery operation is outside its owned state';}
  if(!outsideRefused)throw Error('Operation escaped ownership scope');
  if(!admitted)throw Error('Supported runner was not verified');
 }:withPreclaimKernelOwnership;
 const reader={
  readService:async(service)=>service+' = {\\n\\tpid = '+request.plan.coordinatorProcess.pid+'\\n}',
  inspectProcess:async()=>{
   try{execFileSync('/usr/bin/python3',['-I','-B','-c',probe,request.plan.executionLock.path]);}
   catch(error){selectionHeld=error.status===7;}
   if(!selectionHeld)throw Error('Selection inspection did not retain lock');
   if(process.argv[3]==='changed-selection')writeFileSync(request.plan.selectedConfiguration.path,'changed');
   return request.plan.coordinatorProcess;
  },
  verifyProcessExited:(pid)=>nativeReader.verifyProcessExited(pid),
 };

 try {
  await verify({request,recoveryDescriptor:3,reader,launcherFile:request.plan.selectedLauncher.path,configurationFile:request.plan.selectedConfiguration.path,
   helper:{path:${JSON.stringify(helper)},sha256:${JSON.stringify(createHash("sha256").update(readFileSync(helper)).digest("hex"))}},
   writableMountRoots:[],operation:async()=>{
    callback=true;
    try{execFileSync('/usr/bin/python3',['-I','-B','-c',probe,request.plan.executionLock.path]);}
    catch(error){held=error.status===7;}
    if(!held)throw Error('Callback did not retain kernel lock');
    if(process.argv[3]==='callback-failure')throw Error('Injected callback failure');
   }});
  accepted=true;
 }catch(error){failure=error.message;}
 if(process.argv[3]==='held-execution')closeSync(4);
 execFileSync('/usr/bin/python3',['-I','-B','-c',probe,request.plan.executionLock.path]);
 console.log(JSON.stringify({accepted,callback,held,selectionHeld,released:true,failure}));
}
main().catch(()=>{process.exitCode=1;});
`,
        { mode: 0o600 },
      );
      const wrapper = `import fcntl,os,sys
file,node,driver,request,mode=sys.argv[1:]
fd=os.open(file,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
if mode not in ('unheld-recovery','unheld-selected'): fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
if fd!=3: os.dup2(fd,3); os.close(fd)
os.set_inheritable(3,True)
if mode=='held-execution':
 other=os.open(os.path.join(os.path.dirname(file),'coordinator-bootstrap-execution.lock'),os.O_RDWR)
 fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if other!=4: os.dup2(other,4); os.close(other)
 os.set_inheritable(4,True)
os.execv(node,[node,'--import','tsx',driver,request,mode])
`;
      const result = await promisify(execFile)(
        "/usr/bin/python3",
        [
          "-I",
          "-B",
          "-c",
          wrapper,
          path.join(f.directory, "coordinator-preclaim-execution.lock"),
          process.execPath,
          driver,
          requestFile,
          mode,
        ],
        { timeout: 20_000 },
      );
      const success = mode === "exited" || mode === "selected";
      const callback = success || mode === "callback-failure";
      const observed = JSON.parse(result.stdout);
      const failures: Record<string, string | null> = {
        exited: null,
        selected: null,
        "changed-selection": "Prepared document digest changed",
        live: "Preclaim native verification refused: executor_exit_unproven",
        "orphan-child": "Preclaim native verification refused: children_unproven",
        "wrong-inode": "Preclaim native verification refused: execution_lock_changed",
        "stale-review": "Preclaim native verification refused: review_changed",
        "unheld-recovery": "Preclaim native verification refused: verification_failed",
        "unheld-selected": "Preclaim recovery ownership unproven",
        "held-execution": "Preclaim native verification refused: verification_failed",
        "callback-failure": "Injected callback failure",
      };
      expect(observed).toEqual({
        accepted: success,
        callback,
        held: callback,
        selectionHeld: mode === "selected" || mode === "changed-selection",
        released: true,
        failure: failures[mode],
      });
      expect(f.service.list()[0]?.execution?.stage).toBe(
        mode === "stale-review" ? "recovery_required" : "verifying",
      );
      expect(f.legacy.read()).toEqual([{ ...plan.canceled, decisionAt: approved.decisionAt }]);
    } finally {
      if (target.exitCode === null && target.signalCode === null) {
        const closed = once(target, "close");
        target.kill();
        await closed;
      }
      if (orphan) {
        try {
          const current = await processReader.inspectAuditedProcess(orphan.identity.pid);
          expect(current.auditToken).toEqual(orphan.auditToken);
          // Only the disposable child whose audit identity this fixture captured.
          process.kill(orphan.identity.pid, "SIGTERM");
        } catch {
          await processReader.verifyProcessExited(orphan.identity.pid);
        }
      }
    }
  },
  30_000,
);

test.each([
  "exact",
  "stale-revision",
  "generation",
  "decision",
  "unreserved",
  "unfenced",
  "unreviewed-kill",
])(
  "native effect authorization binds current revision, cancellation and intent (%s)",
  async (change) => {
    const f = await executionFixture();
    const claimed = await f.service.claim(identity(f.approved));
    const cancellation = cancellationFromClaimedRecovery(claimed);
    f.journal.fence(cancellation);
    const fenced = f.service.advance(claimed, "cancellation_fenced");
    f.journal.reserveEffect({ cancellation, effect: "terminate", at: new Date().toISOString() });
    const request = f.service.advance(fenced, "effect_pending");
    const retained = f.journal.inspect(request.id)!;
    if (change === "generation") request.execution!.generation = randomUUID();
    if (change === "decision") request.decisionAt = new Date(42).toISOString();
    if (change === "unreserved") retained.terminateIntentAt = null;
    if (change === "unfenced") retained.fenced = false;
    if (change === "unreviewed-kill") retained.killIntentAt = new Date().toISOString();
    const reviews = [structuredClone(request)];
    if (change === "stale-revision") reviews[0]!.revision = randomUUID();
    const verify = () =>
      verifyPreclaimEffectRequest({
        request,
        reviews,
        retained,
        effect: change === "unreviewed-kill" ? "kill" : "terminate",
      });
    if (change === "exact") expect(verify).not.toThrow();
    else expect(verify).toThrow();
    expect(f.calls).toEqual([]);
  },
);

test
  .runIf(process.platform === "darwin")
  .each([
    "terminate",
    "kill",
    "early-kill",
    "wrong-token",
    "children",
    "unreserved",
    "stale-review",
    "consumed",
  ])(
  "native effect helper refuses unsafe dispatch and signals only its disposable audited target (%s)",
  async (mode) => {
    const f = reviewFixture();
    const plan = f.request.plan;
    const escalation = mode === "kill" || mode === "early-kill";
    const effect = escalation ? "kill" : "terminate";
    if (escalation) {
      plan.signalPolicy.escalation = "SIGKILL";
      plan.signalPolicy.graceSeconds = mode === "early-kill" ? 60 : 1;
    }
    const helper = fileURLToPath(
      new URL("../../../../../scripts/run-coordinator-owner.py", import.meta.url),
    );
    const inspector = fileURLToPath(
      new URL("../../../../../scripts/inspect-coordinator-process.py", import.meta.url),
    );
    const inspectorDigest = createHash("sha256").update(readFileSync(inspector)).digest("hex");
    const reader = await createNativeBootstrapServiceReader({
      helperPath: inspector,
      helperSha256: inspectorDigest,
      writableMountRoots: [],
    });
    const retain = (file: string, contents: string) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents, { mode: 0o600 });
      return { path: file, sha256: createHash("sha256").update(contents).digest("hex") };
    };
    plan.runner.directory = f.directory;
    plan.runner.node.path = realpathSync(process.execPath);
    plan.setup = retain(path.join(f.directory, "setup.json"), "{}");
    plan.selectedLauncher = retain(path.join(f.directory, "selected.plist"), "retained launcher");
    plan.selectedConfiguration = retain(path.join(f.directory, "selected.json"), "{}");
    plan.original.plan.previous.launcher = plan.selectedLauncher;
    plan.original.plan.previous.configuration = plan.selectedConfiguration;
    const prefix = escalation ? 'process.on("SIGTERM",()=>{});' : "";
    const code =
      mode === "children"
        ? 'const {spawn}=require("node:child_process");const c=spawn("/bin/sleep",["20"]);c.once("spawn",()=>process.send("ready"));process.on("SIGTERM",()=>{c.kill();process.exit(0)});'
        : 'process.send("ready");setTimeout(()=>{},20000);';
    plan.executorEntrypoint = retain(
      path.join(
        f.directory,
        "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
      ),
      prefix + code,
    );
    const target = spawn(
      plan.runner.node.path,
      [plan.executorEntrypoint.path, plan.setup.path, "executor", plan.original.id],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true },
    );
    await once(target, "message");
    try {
      plan.executor = await reader.inspectAuditedProcess(target.pid!);
      plan.hostProcess = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
      plan.coordinatorProcess = structuredClone(plan.hostProcess);
      const { pid, bootId, startIdentity, argumentsSha256 } = plan.coordinatorProcess;
      plan.original.plan.expectedProcess = { pid, bootId, startIdentity, argumentsSha256 };
      if (mode === "wrong-token") plan.executor.auditToken[7]++;
      plan.original.planSha256 = coordinatorPlanDigest(plan.original.plan);
      plan.canceled = {
        ...plan.original,
        revision: randomUUID(),
        status: "canceled",
        decisionAt: undefined,
      };
      writeFileSync(plan.executionLock.path, "", { mode: 0o600 });
      const lock = statSync(plan.executionLock.path, { bigint: true });
      plan.executionLock.device = String(lock.dev);
      plan.executionLock.inode = String(lock.ino);
      f.legacy.replace(f.legacy.read(), [plan.original]);
      const pending = await f.service.prepare({ id: f.request.id, reason: f.request.reason, plan });
      const approved = await f.service.decide(
        { ...identity(pending), decision: "approve" },
        password,
        true,
      );
      const claimed = await f.service.claim(identity(approved));
      const cancellation = cancellationFromClaimedRecovery(claimed);
      f.journal.fence(cancellation);
      const fenced = f.service.advance(claimed, "cancellation_fenced");
      if (mode !== "unreserved")
        f.journal.reserveEffect({
          cancellation,
          effect: "terminate",
          at: new Date().toISOString(),
        });
      const request = f.service.advance(fenced, "effect_pending");
      if (mode === "stale-review") f.service.advance(request, "recovery_required");
      const dispatch = path.join(
        f.directory,
        `coordinator-preclaim-effect-${request.execution!.generation}-${effect}.json`,
      );
      if (mode === "consumed") writeFileSync(dispatch, "{}", { mode: 0o600 });
      const wrapper = `import fcntl,os,sys
lock,helper,*arguments=sys.argv[1:]
fd=os.open(lock,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
if fd!=3: os.dup2(fd,3); os.close(fd)
os.set_inheritable(3,True)
os.execv('/usr/bin/python3',['/usr/bin/python3','-I','-B',helper,*arguments])
`;
      const exited = once(target, "exit");
      const invoke = (selectedEffect: "terminate" | "kill") =>
        promisify(execFile)(
          "/usr/bin/python3",
          [
            "-I",
            "-B",
            "-c",
            wrapper,
            path.join(f.directory, "coordinator-preclaim-execution.lock"),
            helper,
            "preclaim-effect",
            f.directory,
            request.id,
            request.revision,
            request.execution!.generation,
            request.planSha256,
            selectedEffect,
            inspector,
            inspectorDigest,
          ],
          { timeout: 10000 },
        ).then(
          () => ({ ok: true, error: "" }),
          (error: { stderr: string }) => ({ ok: false, error: error.stderr.trim() }),
        );
      if (escalation) {
        expect(await invoke("terminate")).toEqual({ ok: true, error: "" });
        f.journal.reserveEffect({ cancellation, effect: "kill", at: new Date().toISOString() });
        if (mode === "kill") await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      const result = await invoke(effect);
      if (mode === "terminate" || mode === "kill") {
        expect(result).toEqual({ ok: true, error: "" });
        expect((await exited)[1]).toBe(mode === "kill" ? "SIGKILL" : "SIGTERM");
        await expect(observePreclaimExecutor({ plan, reader })).resolves.toBe("exited");
        expect(JSON.parse(readFileSync(dispatch, "utf8"))).toMatchObject({
          requestId: request.id,
          revision: request.revision,
          generation: request.execution!.generation,
          planSha256: request.planSha256,
          effect,
          executor: plan.executor,
        });
      } else {
        const errors: Record<string, string> = {
          "early-kill": "effect_unreserved",
          "wrong-token": "process_changed",
          children: "children_unproven",
          unreserved: "effect_unreserved",
          "stale-review": "review_changed",
          consumed: "verification_failed",
        };
        expect(result).toEqual({ ok: false, error: `preclaim:${errors[mode]}` });
        expect((await reader.inspectAuditedProcess(target.pid!)).identity.pid).toBe(target.pid);
      }
      expect(f.legacy.read()).toEqual([{ ...plan.canceled, decisionAt: approved.decisionAt }]);
    } finally {
      if (target.exitCode === null && target.signalCode === null) {
        const closed = once(target, "close");
        target.kill(escalation ? "SIGKILL" : "SIGTERM");
        await closed;
      }
    }
  },
  30000,
);

test.each(["alive", "exited", "inspection-error", "pid-reused"])(
  "executor observation requires independent native exit proof (%s)",
  async (mode) => {
    const { plan } = fixture();
    const absence: number[] = [];
    const reader = {
      inspectProcess: async (pid: number) =>
        pid === plan.hostProcess.pid ? plan.hostProcess : plan.coordinatorProcess,
      inspectAuditedProcess: async () => {
        if (mode === "exited" || mode === "inspection-error")
          throw new Error("Live inspection failed");
        if (mode === "pid-reused")
          return {
            ...plan.executor,
            identity: { ...plan.executor.identity, startIdentity: "99:99" },
          };
        return plan.executor;
      },
      readService: async (service: string) =>
        `${service} = {\n\tpid = ${plan.coordinatorProcess.pid}\n}`,
      verifyProcessExited: async (pid: number) => {
        absence.push(pid);
        if (mode !== "exited") throw new Error("Native absence unproven");
      },
    };
    const result = observePreclaimExecutor({ plan, reader });
    if (mode === "alive" || mode === "exited") await expect(result).resolves.toBe(mode);
    else
      await expect(result).rejects.toThrow(
        mode === "inspection-error" ? "Live inspection failed" : "process identity changed",
      );
    expect(absence).toEqual(mode === "alive" ? [] : [plan.executor.identity.pid]);
  },
);

test.each(["exited", "timeout", "identity-change", "backwards-clock", "invalid-clock"])(
  "bounded recovery wait never converts uncertainty to exit (%s)",
  async (mode) => {
    const { plan } = fixture();
    plan.signalPolicy.graceSeconds = 1;
    let now = mode === "invalid-clock" ? NaN : 0;
    let observations = 0;
    const sleeps: number[] = [];
    const result = waitForPreclaimExecutorExit({
      plan,
      ports: {
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now = mode === "backwards-clock" ? -1 : now + milliseconds;
        },
        observe: async () => {
          observations++;
          if (mode === "identity-change") throw new Error("Audit identity changed");
          return mode === "exited" ? "exited" : "alive";
        },
      },
    });
    if (mode === "exited") {
      await expect(result).resolves.toBe("exited");
      expect(sleeps).toEqual([]);
    } else if (mode === "timeout") {
      await expect(result).resolves.toBe("alive");
      expect(now).toBe(1000);
      expect(observations).toBe(11);
    } else
      await expect(result).rejects.toThrow(
        mode === "identity-change" ? "Audit identity changed" : "clock",
      );
    expect(sleeps.every((ms) => ms > 0 && ms <= 100)).toBe(true);
    if (mode === "invalid-clock") expect(observations).toBe(0);
  },
);

test("managed recovery transport preserves explicit review, authentication and cancellation", async () => {
  const f = reviewFixture();
  const service = {
    available: true,
    list: () => f.service.list(),
    prepare: (value: unknown) => f.service.prepare(value),
    decide: (value: unknown, proof: string, ack: boolean) => f.service.decide(value, proof, ack),
  };
  const prepared = await handlePreclaimRecoveryReview(
    {
      type: "installation.bootstrap_recovery.prepare.request",
      requestId: "prepare",
      input: { id: f.request.id, reason: f.request.reason, plan: f.request.plan },
    },
    service,
  );
  expect(prepared.payload.error).toBeNull();
  expect(validateWSOutboundMessage({ type: "session", message: prepared }).success).toBe(true);
  const malformed = structuredClone(prepared);
  malformed.payload.requests![0]!.plan.executor.auditToken = [];
  expect(validateWSOutboundMessage({ type: "session", message: malformed }).success).toBe(false);
  const pending = prepared.payload.requests![0]!;
  const message = {
    type: "installation.bootstrap_recovery.decide.request" as const,
    requestId: "decision",
    input: { ...identity(pending), decision: "approve" as const },
    ownerPassword: password,
  };
  const hidden = await handlePreclaimRecoveryReview(message, service);
  expect(hidden.payload.error).toContain("Reload");
  expect(f.service.list()[0]!.status).toBe("pending");
  const refused = await handlePreclaimRecoveryReview(
    { ...message, preclaimRecovery: true, ownerPassword: "wrong" },
    service,
  );
  expect(refused.payload.error).toContain("authentication");
  const approved = await handlePreclaimRecoveryReview(
    { ...message, preclaimRecovery: true },
    service,
  );
  expect(approved.payload.error).toBeNull();
  expect(approved.payload.requests![0]!.status).toBe("approved");
  const canceled = await handlePreclaimRecoveryReview(
    { ...message, input: { ...identity(approved.payload.requests![0]!), decision: "cancel" } },
    service,
  );
  expect(canceled.payload.requests![0]!.status).toBe("canceled");
  expect(f.legacy.read()).toEqual([f.request.plan.original]);
  expect(JSON.stringify([prepared, hidden, refused, approved, canceled])).not.toContain(password);
});

test("preclaim recovery hides retained startup plans from older readers and refuses hidden approval", async () => {
  const f = reviewFixture();
  const original = f.request.plan.original;
  const file = original.plan.candidate.configuration;
  const bootRecovery = {
    requestId: original.id,
    service: `gui/501/local.vorteo.fixture.installation-recovery-${original.id}`,
    launcher: file,
    installedLauncher: "/protected/retained-startup.plist",
    setup: file,
    ownerLauncher: file,
    node: file,
    entrypoint: file,
  };
  const stored = {
    ...f.request,
    status: "pending" as const,
    plan: {
      ...f.request.plan,
      original: { ...original, plan: { ...original.plan, bootRecovery } },
      canceled: { ...f.request.plan.canceled, plan: { ...original.plan, bootRecovery } },
    },
  };
  const service = {
    available: true,
    list: () => [stored],
    prepare: (value: Parameters<typeof f.service.prepare>[0]) => f.service.prepare(value),
    decide: (...args: Parameters<typeof f.service.decide>) => f.service.decide(...args),
  };
  const message = {
    type: "installation.bootstrap_recovery.list_requests.request" as const,
    requestId: "list",
  };
  const legacy = await handlePreclaimRecoveryReview(message, service);
  expect(legacy.payload.error).toBeNull();
  expect(legacy.payload.requests?.[0]?.plan.original.plan).not.toHaveProperty("bootRecovery");
  expect(legacy.payload.requests?.[0]?.plan.canceled.plan).not.toHaveProperty("bootRecovery");
  const oldRequestSchema = CoordinatorBootstrapRequestSchema.extend({
    plan: CoordinatorBootstrapPlanSchema.omit({ bootRecovery: true }),
  });
  expect(oldRequestSchema.safeParse(stored.plan.original).success).toBe(false);
  expect(oldRequestSchema.safeParse(legacy.payload.requests?.[0]?.plan.original).success).toBe(
    true,
  );
  expect(oldRequestSchema.safeParse(legacy.payload.requests?.[0]?.plan.canceled).success).toBe(
    true,
  );
  const modern = await handlePreclaimRecoveryReview(
    { ...message, recoveryBootPlan: true },
    service,
  );
  expect(modern.payload.requests?.[0]?.plan.original.plan.bootRecovery).toEqual(bootRecovery);
  const decision = await handlePreclaimRecoveryReview(
    {
      type: "installation.bootstrap_recovery.decide.request",
      requestId: "approve",
      preclaimRecovery: true,
      ownerPassword: "fixture-password",
      input: {
        id: stored.id,
        revision: stored.revision,
        planSha256: stored.planSha256,
        decision: "approve",
      },
    },
    service,
  );
  expect(decision.payload.error).toContain("retained startup recovery");
  expect(stored.status).toBe("pending");
  expect(stored.plan.original.plan.bootRecovery).toEqual(bootRecovery);
});

test("preclaim recovery responses omit private reconciliation state in nested requests", async () => {
  const f = reviewFixture();
  const check = {
    phase: "approval" as const,
    attempt: 1,
    startedAt: "2026-10-15T00:00:00Z",
    retryAfter: "2026-10-15T00:16:00Z",
    outcome: "running" as const,
  };
  const stored = {
    ...f.request,
    plan: {
      ...f.request.plan,
      original: { ...f.request.plan.original, automaticCheck: check },
      canceled: { ...f.request.plan.canceled, automaticCheck: check },
    },
  };
  const response = await handlePreclaimRecoveryReview(
    { type: "installation.bootstrap_recovery.list_requests.request", requestId: "list" },
    {
      available: true,
      list: () => [stored],
      prepare: (value) => f.service.prepare(value),
      decide: (value, proof, ack) => f.service.decide(value, proof, ack),
    },
  );
  expect(response.payload.error).toBeNull();
  expect(response.payload.requests?.[0]?.plan.original).not.toHaveProperty("automaticCheck");
  expect(response.payload.requests?.[0]?.plan.canceled).not.toHaveProperty("automaticCheck");
  expect(stored.plan.original.automaticCheck).toEqual(check);
});

test.each(["missing", "unavailable", "private-error"])(
  "managed recovery transport refuses unavailable runtime and redacts private failure (%s)",
  async (mode) => {
    let writes = 0;
    const f = reviewFixture();
    const service = {
      available: mode !== "unavailable",
      list: () => [],
      prepare: async () => {
        writes++;
        throw new Error("private-sentinel");
      },
      decide: async () => {
        throw new Error("unused");
      },
    };
    const response = await handlePreclaimRecoveryReview(
      {
        type: "installation.bootstrap_recovery.prepare.request",
        requestId: "prepare",
        input: { id: f.request.id, reason: f.request.reason, plan: f.request.plan },
      },
      mode === "missing" ? undefined : service,
    );
    expect(response.payload.requests).toBeNull();
    expect(response.payload.error).toBeTruthy();
    expect(response.payload.error).not.toContain("private-sentinel");
    expect(writes).toBe(mode === "private-error" ? 1 : 0);
  },
);

test("recovery capability tracks its own validated runtime independently of normal maintenance", () => {
  const recovery = {
    available: true,
    list: () => [],
    prepare: async () => {
      throw new Error("unused");
    },
    decide: async () => {
      throw new Error("unused");
    },
  };
  const service = {
    available: false,
    unavailableReason: "Ordinary maintenance blocked",
    list: () => [],
    prepare: async () => {
      throw new Error("unused");
    },
    decide: async () => {
      throw new Error("unused");
    },
    preclaimRecovery: recovery,
  };
  expect(bootstrapReviewFeatures(service)).toMatchObject({
    coordinatorBootstrapReview: false,
    coordinatorBootstrapPreclaimRecovery: true,
  });
  recovery.available = false;
  expect(bootstrapReviewFeatures(service).coordinatorBootstrapPreclaimRecovery).toBe(false);
  expect(bootstrapReviewFeatures(undefined).coordinatorBootstrapPreclaimRecovery).toBe(false);
});

test
  .runIf(process.platform === "darwin")
  .each([
    "approved",
    "canceled",
    "claimed",
    "wrong-digest",
    "changed-entry",
    "busy",
    "replay",
    "exec-failure",
    "birth",
    "birth-parent-mismatch",
    "birth-runner-stale",
  ])(
  "protected preclaim launcher binds one exact approval and never queues or replays (%s)",
  async (mode) => {
    const f = reviewFixture();
    const pending = await f.service.prepare({
      id: f.request.id,
      reason: f.request.reason,
      plan: f.request.plan,
    });
    const approved = await f.service.decide(
      { ...identity(pending), decision: "approve" },
      password,
      true,
    );
    const entry = path.join(f.directory, "coordinator-bootstrap-runner.js");
    const lock = path.join(f.directory, "coordinator-preclaim-execution.lock");
    const probe = `import os,fcntl,sys\np=os.open(sys.argv[1],os.O_RDWR)\ntry: fcntl.flock(p,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: pass\nelse: sys.exit(3)\nfcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\n`;
    const birth = mode.startsWith("birth");
    const birthModule = fileURLToPath(
      new URL("./coordinator-bootstrap-launch.ts", import.meta.url),
    );
    const tsxApi = fileURLToPath(
      new URL("../../../../../node_modules/tsx/dist/esm/api/index.cjs", import.meta.url),
    );
    let beginBirth = "";
    if (mode === "birth-runner-stale")
      beginBirth = `require(${JSON.stringify(tsxApi)}).register();await (await import(${JSON.stringify(birthModule)})).runNativePreclaimRecovery({setupFile:process.argv[2],identity:{id:process.argv[4],revision:${JSON.stringify(randomUUID())},planSha256:process.argv[6]},recoveryDescriptor:fd});`;
    else if (birth)
      beginBirth = `require(${JSON.stringify(tsxApi)}).register();await (await import(${JSON.stringify(birthModule)})).retainPreclaimExecutorBirth({setupFile:process.argv[2],recoveryDescriptor:fd,writableMountRoots:[]});`;
    writeFileSync(
      entry,
      `const {execFileSync}=require('node:child_process');
const fd=Number(process.env.VORTEO_PRECLAIM_LOCK_FD);
execFileSync('/usr/bin/python3',['-I','-B','-c',${JSON.stringify(probe)},${JSON.stringify(lock)}],{stdio:['ignore','ignore','pipe',fd]});
(async()=>{${beginBirth}console.log(JSON.stringify({argv:process.argv.slice(2),owned:true,environment:Object.keys(process.env).filter(key=>key!=="__CF_USER_TEXT_ENCODING").sort()}));})().catch(error=>{console.error(error.message);process.exitCode=1;});`,
      { mode: 0o600 },
    );
    const pin = (file: string) => ({
      path: realpathSync(file),
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    });
    const setupFile = path.join(
      f.directory,
      `coordinator-preclaim-launch-${approved.id}-${approved.revision}.json`,
    );
    // CoreFoundation may add __CF_USER_TEXT_ENCODING after exec on macOS.
    // All caller-supplied environment remains excluded by the launcher.
    const node =
      mode === "exec-failure" ? path.join(f.directory, "nonexecutable-node") : process.execPath;
    if (mode === "exec-failure") writeFileSync(node, "not executable", { mode: 0o600 });
    let birthFields = {};
    if (birth) {
      const inspector = pin(
        fileURLToPath(
          new URL("../../../../../scripts/inspect-coordinator-process.py", import.meta.url),
        ),
      );
      const reader = await createNativeBootstrapServiceReader({
        helperPath: inspector.path,
        helperSha256: inspector.sha256,
        writableMountRoots: [],
      });
      const hostProcess = await reader.inspectProcess(process.pid);
      if (mode === "birth-parent-mismatch") hostProcess.startIdentity = "wrong-birth";
      const file = pin(entry);
      birthFields = {
        admissionSetupFile: entry,
        daemonId: "fixture",
        ownerLauncher: pin(
          fileURLToPath(
            new URL("../../../../../scripts/run-coordinator-owner.py", import.meta.url),
          ),
        ),
        ownershipVerifier: file,
        runtimeDirectory: f.directory,
        runtimeSha256: "a".repeat(64),
        original: identity(f.request.plan.original),
        inspector,
        selectedLauncherFile: entry,
        renewal: {
          version: 1,
          originalSetup: file,
          originalAdmission: file,
          terminal: { ...identity(f.request.plan.original), generation: randomUUID() },
          configuration: file,
          sourceCommit: "a".repeat(40),
          source: file,
          hostProcess,
        },
      };
    }
    writeFileSync(
      setupFile,
      JSON.stringify({
        ...birthFields,
        version: 1,
        kind: "bootstrap-preclaim-recovery",
        stateDirectory: f.directory,
        request: identity(approved),
        node: pin(node),
        entrypoint: pin(entry),
      }),
      { mode: 0o600 },
    );
    if (mode === "canceled")
      await f.service.decide({ ...identity(approved), decision: "cancel" }, password, false);
    if (mode === "claimed") await f.service.claim(identity(approved));
    if (mode === "changed-entry")
      writeFileSync(entry, "throw Error('Changed entry must not execute');");
    const helper = fileURLToPath(
      new URL("../../../../../scripts/run-coordinator-owner.py", import.meta.url),
    );
    const args = [
      helper,
      "preclaim-launch",
      setupFile,
      approved.id,
      approved.revision,
      mode === "wrong-digest" ? "a".repeat(64) : approved.planSha256,
    ];
    const run = () =>
      mode === "busy"
        ? promisify(execFile)(
            "/usr/bin/python3",
            [
              "-I",
              "-B",
              "-c",
              `import fcntl,os,sys\nf=os.open(${JSON.stringify(lock)},os.O_RDWR|os.O_CREAT,0o600)\nfcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nsys.argv=sys.argv[1:]\nexec(compile(open(sys.argv[0]).read(),sys.argv[0],'exec'))`,
              ...args,
            ],
            { timeout: 10000 },
          )
        : promisify(execFile)("/usr/bin/python3", ["-I", "-B", ...args], { timeout: 10000 });
    const attempt = path.join(
      f.directory,
      `coordinator-preclaim-attempt-${approved.id}-${approved.revision}.json`,
    );
    if (mode === "approved" || mode === "replay" || mode === "birth") {
      const result = await run();
      expect(JSON.parse(result.stdout)).toEqual({
        argv: [setupFile, "preclaim-executor", approved.id, approved.revision, approved.planSha256],
        owned: true,
        environment: ["PATH", "VORTEO_PRECLAIM_LOCK_FD"],
      });
      const before = readFileSync(attempt, "utf8");
      expect(JSON.parse(before).request).toEqual(identity(approved));
      if (mode === "birth") {
        const record = JSON.parse(
          readFileSync(
            path.join(
              f.directory,
              `coordinator-preclaim-executor-${approved.id}-${approved.revision}.json`,
            ),
            "utf8",
          ),
        );
        expect(record.request).toEqual(identity(approved));
        expect(record.setup).toEqual(pin(setupFile));
        expect(record.executor.identity.pid).toBe(JSON.parse(before).launcherPid);
        expect(record.executor.identity.parentPid).toBe(process.pid);
        expect(record.executor.auditToken[5]).toBe(record.executor.identity.pid);
      }
      if (mode === "replay") {
        await expect(run()).rejects.toThrow();
        expect(readFileSync(attempt, "utf8")).toBe(before);
      }
    } else if (mode === "birth-parent-mismatch" || mode === "birth-runner-stale") {
      await expect(run()).rejects.toThrow();
      expect(JSON.parse(readFileSync(attempt, "utf8")).request).toEqual(identity(approved));
      expect(() =>
        readFileSync(
          path.join(
            f.directory,
            `coordinator-preclaim-executor-${approved.id}-${approved.revision}.json`,
          ),
        ),
      ).toThrow();
    } else if (mode === "exec-failure") {
      await expect(run()).rejects.toThrow();
      const retained = readFileSync(attempt, "utf8");
      await expect(run()).rejects.toThrow();
      expect(readFileSync(attempt, "utf8")).toBe(retained);
    } else {
      await expect(run()).rejects.toThrow();
      expect(() => readFileSync(attempt)).toThrow();
    }
    expect(f.legacy.read()).toEqual([f.request.plan.original]);
  },
  20000,
);

test.each([
  "unknown-source",
  "missing-observation",
  "current-missing-observation",
  "current-wrong-artifact",
])(
  "legacy runner admission refuses unsupported provenance before file access (%s)",
  async (mode) => {
    const { verifySupportedPreclaimRunner } =
      await import("./coordinator-bootstrap-preclaim-recovery.js");
    const plan = fixture().plan;
    if (mode === "missing-observation") {
      plan.runner.sourceCommit = "853b193e69c48260366635610501912efff73a0c";
      plan.original.plan.candidate.sourceCommit = plan.runner.sourceCommit;
    } else if (mode.startsWith("current-")) {
      plan.runner.sourceCommit = "e9922b953658ad7873bf921bb5837a84686f9475";
      plan.original.plan.candidate.sourceCommit = plan.runner.sourceCommit;
      if (mode === "current-wrong-artifact") plan.retainedObservation = plan.setup;
    } else plan.retainedObservation = plan.setup;
    plan.original.planSha256 = coordinatorPlanDigest(plan.original.plan);
    plan.canceled = { ...plan.original, revision: randomUUID(), status: "canceled" };
    delete plan.canceled.decisionAt;
    await expect(
      verifySupportedPreclaimRunner({
        plan,
        daemonId: "fixture",
        admissionSetupFile: "/unavailable/admission.json",
        anchor: {
          originalSetup: plan.setup,
          originalAdmission: plan.setup,
          terminal: { ...identity(plan.original), generation: randomUUID() },
        },
        writableMountRoots: [],
      }),
    ).rejects.toThrow(
      mode === "current-wrong-artifact"
        ? "not the reviewed preclaim release"
        : "not supported for preclaim recovery",
    );
  },
);

test("retained observation route reconciles the same generation without effect methods", async () => {
  const f = await executionFixture();
  f.state.terminalProof = false;
  const failed = await executePreclaimRecovery({
    reviews: f.service,
    identity: identity(f.approved),
    journal: f.journal,
    native: f.native,
  });
  f.state.terminalProof = true;
  const service = {
    available: true,
    list: () => f.service.list(),
    prepare: (value: unknown) => f.service.prepare(value),
    decide: (value: unknown, proof: string, ack: boolean) => f.service.decide(value, proof, ack),
    reconcile: async (input: {
      id: string;
      revision: string;
      planSha256: string;
      generation: string;
    }) => {
      if (f.service.list()[0]!.execution?.generation !== input.generation)
        throw new Error("Wrong generation");
      await reconcilePreclaimRecovery({
        reviews: f.service,
        identity: identity(input),
        journal: f.journal,
        native: {
          withRecoveryOwnership: f.native.withRecoveryOwnership,
          withVerifiedExitAndSelection: f.native.withVerifiedExitAndSelection,
        },
      });
    },
  };
  const message = {
    type: "installation.bootstrap_recovery.list_requests.request" as const,
    requestId: "observe",
    reconcile: { ...identity(failed), generation: failed.execution!.generation },
  };
  const result = await handlePreclaimRecoveryReview(message, service);
  expect(result.payload.error).toBeNull();
  expect(result.payload.requests![0]!.execution?.stage).toBe("succeeded");
  expect(result.payload.requests![0]!.execution?.generation).toBe(failed.execution!.generation);
  // Simulate a lost response: the old exact revision refuses; status remains terminal.
  const repeated = await handlePreclaimRecoveryReview(message, service);
  expect(repeated.payload.error).not.toBeNull();
  expect(f.service.list()[0]!.execution?.stage).toBe("succeeded");
  expect(f.calls).toEqual(["terminate"]);
  const unavailable = await handlePreclaimRecoveryReview(message, {
    ...service,
    reconcile: undefined,
  });
  expect(unavailable.payload.error).toContain("unavailable");
});

function retainOwnerCancellation(request: BootstrapPreclaimRecoveryRequest) {
  const plan = request.plan;
  plan.ownerCancellation = { ...plan.canceled, decisionAt: new Date(2).toISOString() };
  plan.originalApproval = { path: "/protected/original-approval.json", sha256: "a".repeat(64) };
  request.planSha256 = preclaimRecoveryPlanDigest(plan);
  return request;
}

test("owner-canceled original binds approval, cancellation chronology and exact plan/process", () => {
  const request = retainOwnerCancellation(fixture());
  const cancellation = cancellationFromClaimedRecovery(request);
  expect(cancellation.canceled).toEqual(request.plan.ownerCancellation);
  expect(cancellation.canceled.decisionAt).not.toBe(request.decisionAt);
  const plan = request.plan;
  for (const changed of [
    { ...plan, originalApproval: undefined },
    { ...plan, ownerCancellation: undefined },
    {
      ...plan,
      ownerCancellation: { ...plan.ownerCancellation, decisionAt: new Date(0).toISOString() },
    },
    { ...plan, ownerCancellation: { ...plan.ownerCancellation, revision: plan.original.revision } },
    { ...plan, ownerCancellation: { ...plan.ownerCancellation, revision: randomUUID() } },
    { ...plan, ownerCancellation: { ...plan.ownerCancellation, planSha256: "0".repeat(64) } },
    { ...plan, original: { ...plan.original, status: "pending" } },
    { ...plan, executor: { ...plan.executor, identity: { ...plan.executor.identity, pid: 999 } } },
  ])
    expect(() => validatePreclaimRecoveryPlan(changed)).toThrow();
});

test("owner-canceled original verifies protected full retained approval bytes", async () => {
  const f = reviewFixture();
  const request = retainOwnerCancellation(f.request);
  const file = path.join(f.request.plan.original.plan.state.directory, "approval.json");
  const bytes = JSON.stringify(request.plan.original);
  writeFileSync(file, bytes, { mode: 0o600 });
  request.plan.originalApproval = {
    path: file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await verifyPreclaimOriginalApproval(request.plan, []);
  const changed = structuredClone(request.plan);
  changed.original.decisionAt = new Date(0).toISOString();
  await expect(verifyPreclaimOriginalApproval(changed, [])).rejects.toThrow(
    "Retained original approval changed",
  );
  writeFileSync(file, bytes + " ");
  await expect(verifyPreclaimOriginalApproval(request.plan, [])).rejects.toThrow();
});

test("owner-canceled original preserves actual cancellation through recovery and effect-free observation", async () => {
  const f = reviewFixture();
  const original = f.request.plan.original;
  const old = new CoordinatorBootstrapRequests(
    f.legacy,
    () => ({
      environment: "host",
      installationId: original.plan.installationId,
      service: original.plan.service,
      ownerPasswordHash,
    }),
    async () => {},
    () => 2,
  );
  const canceled = await old.decide({ ...identity(original), decision: "cancel" }, password);
  await expect(old.claimDispatch(identity(original))).rejects.toThrow();
  f.request.plan.canceled = { ...canceled, decisionAt: undefined };
  retainOwnerCancellation(f.request);
  expect(f.request.plan.ownerCancellation).toEqual(canceled);
  const pending = await f.service.prepare({
    id: f.request.id,
    reason: f.request.reason,
    plan: f.request.plan,
  });
  const service = {
    available: true,
    list: () => f.service.list(),
    prepare: (value: unknown) => f.service.prepare(value),
    decide: (value: unknown, proof: string, ack: boolean) => f.service.decide(value, proof, ack),
  };
  const decision = {
    type: "installation.bootstrap_recovery.decide.request" as const,
    requestId: "review",
    input: { ...identity(pending), decision: "approve" as const },
    ownerPassword: password,
    preclaimRecovery: true as const,
  };
  expect((await handlePreclaimRecoveryReview(decision, service)).payload.error).toContain(
    "retained owner cancellation",
  );
  const legacy = await handlePreclaimRecoveryReview(
    { type: "installation.bootstrap_recovery.list_requests.request", requestId: "old" },
    service,
  );
  expect(legacy.payload.requests![0]!.plan.ownerCancellation).toBeUndefined();
  expect(legacy.payload.requests![0]!.planSha256).toBe(pending.planSha256);
  const response = await handlePreclaimRecoveryReview(
    { ...decision, ownerCanceledOriginal: true },
    service,
  );
  expect(response.payload.error).toBeNull();
  const approved = response.payload.requests![0]!;
  let effects = 0;
  const native: PreclaimNativeOperations = {
    withRecoveryOwnership: async (operation) => operation(),
    verifyBeforeCancellation: async () => {},
    inspectExecutor: async () => "exited",
    verifyBeforeEffect: async () => {
      throw new Error("unexpected effect");
    },
    terminateExact: async () => {
      effects++;
    },
    killExact: async () => {
      effects++;
    },
    waitAfterTermination: async () => "exited",
    waitAfterKill: async () => {},
    withVerifiedExitAndSelection: async () => {
      throw new Error("lost terminal proof");
    },
  };
  const failed = await executePreclaimRecovery({
    reviews: f.service,
    journal: f.journal,
    identity: identity(approved),
    native,
  });
  expect(failed.execution?.stage).toBe("recovery_required");
  expect(f.legacy.read()).toEqual([canceled]);
  const observed = await reconcilePreclaimRecovery({
    reviews: f.service,
    journal: f.journal,
    identity: identity(failed),
    native: {
      withRecoveryOwnership: async (operation) => operation(),
      withVerifiedExitAndSelection: async (_request, operation) => operation(),
    },
  });
  expect(observed.execution?.stage).toBe("succeeded");
  expect(observed.execution?.generation).toBe(failed.execution?.generation);
  expect(effects).toBe(0);
  expect(f.legacy.read()).toEqual([canceled]);
  expect(f.journal.inspect(approved.id)?.cancellation.original).toEqual(original);
  await expect(
    executePreclaimRecovery({
      reviews: f.service,
      journal: f.journal,
      identity: identity(approved),
      native,
    }),
  ).rejects.toThrow();
});
