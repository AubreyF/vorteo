import {
  createDispatchingClaimedReview,
  readClaimedDispatchObservation,
  launchClaimedObservation,
} from "./coordinator-bootstrap-claimed-launch.js";
import {
  handleClaimedRecoveryReview,
  bootstrapReviewFeatures,
  type ClaimedRecoveryReviewService,
} from "./coordinator-bootstrap-session.js";
import { once } from "node:events";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import {
  executeClaimedRecovery,
  reconcileClaimedRecovery,
  type ClaimedRecoveryOperations,
} from "./coordinator-bootstrap-claimed-executor.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ClaimedRecoveryObservationSchema,
  verifyClaimedRetainedObservation,
  verifyClaimedLiveProcesses,
  observeClaimedExecutor,
  verifyClaimedExecutionLock,
} from "./coordinator-bootstrap-claimed-verification.js";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  statSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { FileClaimedRecoveryReviewJournal } from "./coordinator-bootstrap-claimed-journal.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { hashSync } from "bcryptjs";
import {
  BootstrapPreclaimRecoveryPlanSchema,
  type BootstrapClaimedRecoveryRequest,
  type BootstrapClaimedRecoveryPlan,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import {
  ClaimedRecoveryReviews,
  claimedRecoveryPlanDigest,
  validateClaimedRecoveryPlan,
} from "./coordinator-bootstrap-claimed-recovery.js";
import {
  inspectClaimedSuccessorHistory,
  verifyClaimedSuccessorExit,
} from "./coordinator-bootstrap-claimed-successor.js";

function fixture(directory = "/protected/state"): BootstrapClaimedRecoveryRequest {
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
  const original: BootstrapClaimedRecoveryRequest["plan"]["original"] = {
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
  original.plan.automaticRecovery = "restore-compatible";
  original.plan.compatibleRecovery = release;
  original.execution = {
    generation: randomUUID(),
    stage: "claimed",
    updatedAt: new Date(2).toISOString(),
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
  const plan: BootstrapClaimedRecoveryRequest["plan"] = {
    version: 1,
    operation: "bootstrap-claimed-recovery",
    original,
    dispatchApprovalRevision: randomUUID(),
    retainedObservation: file,
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
    planSha256: claimedRecoveryPlanDigest(plan),
    status: "approved",
    execution: { generation: randomUUID(), stage: "claimed", updatedAt: new Date(5).toISOString() },
  };
}

const password = "disposable-owner-password";
const ownerPasswordHash = hashSync(password, 4);
function reviewFixture() {
  const { plan } = fixture();
  let records: BootstrapClaimedRecoveryRequest[] = [];
  let verify: (value: BootstrapClaimedRecoveryPlan) => Promise<void> = async () => {};
  const binding = {
    environment: "host",
    installationId: plan.original.plan.installationId,
    service: plan.original.plan.service,
    ownerPasswordHash,
  };
  const journal = {
    readReviews: () => structuredClone(records),
    replaceReviews: (
      expected: BootstrapClaimedRecoveryRequest[],
      next: BootstrapClaimedRecoveryRequest[],
    ) => {
      if (!isDeepStrictEqual(expected, records)) throw new Error("review changed");
      records = structuredClone(next);
    },
  };
  const reviews = new ClaimedRecoveryReviews(
    journal,
    () => binding,
    (value) => verify(value),
  );
  return {
    plan,
    reviews,
    binding,
    setVerify: (value: typeof verify) => {
      verify = value;
    },
    prepare: () =>
      reviews.prepare({ id: randomUUID(), reason: "Recover retained claimed executor", plan }),
  };
}
function identity(request: BootstrapClaimedRecoveryRequest) {
  return { id: request.id, revision: request.revision, planSha256: request.planSha256 };
}

test("claimed recovery has distinct scope and preserves exact claimed approval", () => {
  const { plan } = fixture();
  expect(validateClaimedRecoveryPlan(plan)).toEqual(plan);
  expect(BootstrapPreclaimRecoveryPlanSchema.safeParse(plan).success).toBe(false);
  expect(() =>
    validateClaimedRecoveryPlan({ ...plan, operation: "bootstrap-preclaim-recovery" }),
  ).toThrow();
  expect(() => validateClaimedRecoveryPlan({ ...plan, canceled: plan.original })).toThrow();
});

test("claimed admission rejects missing claim, altered digest and wrong native bindings", () => {
  const { plan } = fixture();
  const mutations: ((value: BootstrapClaimedRecoveryPlan) => void)[] = [
    (p) => {
      p.original.execution = undefined;
    },
    (p) => {
      p.original.execution!.stage = "frozen";
    },
    (p) => {
      p.original.decisionAt = undefined;
    },
    (p) => {
      p.original.execution!.rollbackAttemptedAt = new Date().toISOString();
    },
    (p) => {
      p.original.planSha256 = "f".repeat(64);
    },
    (p) => {
      p.original.status = "canceled";
    },
    (p) => {
      p.dispatchApprovalRevision = p.original.revision;
    },
    (p) => {
      p.executor.identity.parentPid++;
    },
    (p) => {
      p.executor.auditToken[5]++;
    },
    (p) => {
      p.coordinatorProcess.startIdentity = "9:9";
    },
    (p) => {
      p.hostProcess.bootId = randomUUID();
    },
    (p) => {
      p.selectedConfiguration.sha256 = "f".repeat(64);
    },
    (p) => {
      p.executionLock.path += ".other";
    },
    (p) => {
      p.executorEntrypoint.path += ".other";
    },
    (p) => {
      p.runner.sourceCommit = "f".repeat(40);
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(plan);
    mutate(changed);
    expect(() => validateClaimedRecoveryPlan(changed)).toThrow();
  }
});

test("review requires owner authentication, exact acknowledgement and fresh native verification", async () => {
  const f = reviewFixture();
  let verified = 0;
  f.setVerify(async () => {
    verified++;
  });
  const pending = await f.prepare();
  expect(verified).toBe(1);
  const input = { ...identity(pending), decision: "approve" };
  await expect(f.reviews.decide(input, password, false)).rejects.toThrow("Reload");
  await expect(f.reviews.decide(input, "incorrect", true)).rejects.toThrow("authentication");
  const approved = await f.reviews.decide(input, password, true);
  expect(verified).toBe(2);
  const claimed = await f.reviews.claim(identity(approved));
  expect(verified).toBe(3);
  expect(claimed.execution?.stage).toBe("claimed");
  expect(claimed.plan).toEqual(f.plan);
  await expect(f.reviews.claim(identity(approved))).rejects.toThrow("undispatched");
  await expect(
    f.reviews.decide({ ...identity(claimed), decision: "cancel" }, password, true),
  ).rejects.toThrow("dispatch claimed");
});

test.each(["approval", "claim"])(
  "cancellation wins outstanding %s verification without revival",
  async (phase) => {
    const f = reviewFixture();
    let current = await f.prepare();
    if (phase === "claim")
      current = await f.reviews.decide(
        { ...identity(current), decision: "approve" },
        password,
        true,
      );
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.setVerify(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const attempt =
      phase === "claim"
        ? f.reviews.claim(identity(current))
        : f.reviews.decide({ ...identity(current), decision: "approve" }, password, true);
    const outcome = expect(attempt).rejects.toThrow("review changed");
    await started;
    const canceled = await f.reviews.decide(
      { ...identity(current), decision: "cancel" },
      password,
      true,
    );
    release();
    await outcome;
    expect(f.reviews.list()).toEqual([canceled]);
  },
);

test("changed native state and owner binding prevent approval and leave review pending", async () => {
  const f = reviewFixture();
  const pending = await f.prepare();
  f.setVerify(async () => {
    throw new Error("promotion observed");
  });
  await expect(
    f.reviews.decide({ ...identity(pending), decision: "approve" }, password, true),
  ).rejects.toThrow("promotion observed");
  f.setVerify(async () => {
    f.binding.ownerPasswordHash = hashSync("rotated", 4);
  });
  await expect(
    f.reviews.decide({ ...identity(pending), decision: "approve" }, password, true),
  ).rejects.toThrow("installation changed");
  expect(f.reviews.list()).toEqual([pending]);
});

test("recovery required can only enter observation, never reenter an effect stage", async () => {
  const f = reviewFixture();
  const pending = await f.prepare();
  const approved = await f.reviews.decide(
    { ...identity(pending), decision: "approve" },
    password,
    true,
  );
  const claimed = await f.reviews.claim(identity(approved));
  const fenced = f.reviews.advance(claimed, "claim_fenced");
  const effect = f.reviews.advance(fenced, "effect_pending");
  const uncertain = f.reviews.advance(effect, "recovery_required");
  expect(() => f.reviews.advance(uncertain, "effect_pending")).toThrow("Invalid");
  await expect(f.prepare()).rejects.toThrow("already open");
  const verifying = f.reviews.advance(uncertain, "verifying");
  const terminal = f.reviews.advance(verifying, "succeeded");
  expect(terminal.execution?.generation).toBe(claimed.execution?.generation);
  expect(() => f.reviews.advance(terminal, "verifying")).toThrow("Invalid");
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function diskFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "claimed-review-")));
  roots.push(root);
  const { plan } = fixture(root);
  const binding = {
    environment: "host",
    installationId: plan.original.plan.installationId,
    service: plan.original.plan.service,
    ownerPasswordHash,
  };
  const journal = new FileClaimedRecoveryReviewJournal(root);
  const reviews = new ClaimedRecoveryReviews(
    journal,
    () => binding,
    async () => {},
  );
  return { root, plan, journal, reviews };
}

test("durable review retains decisions across reopen and rejects stale writers without touching original history", async () => {
  const f = diskFixture();
  const original = new FileBootstrapRequestJournal(f.root);
  original.replace([], [f.plan.original]);
  const before = readFileSync(path.join(f.root, "coordinator-bootstrap-pending.json"));
  const pending = await f.reviews.prepare({ id: randomUUID(), reason: "fixture", plan: f.plan });
  const stale = f.journal.readReviews();
  const approved = await f.reviews.decide(
    { ...identity(pending), decision: "approve" },
    password,
    true,
  );
  const reopened = new FileClaimedRecoveryReviewJournal(f.root);
  expect(reopened.readReviews()).toEqual([approved]);
  expect(() => reopened.replaceReviews(stale, [])).toThrow("review changed");
  const claimed = await f.reviews.claim(identity(approved));
  expect(reopened.readReviews()).toEqual([claimed]);
  expect(original.read()).toEqual([f.plan.original]);
  expect(readFileSync(path.join(f.root, "coordinator-bootstrap-pending.json"))).toEqual(before);
  expect(statSync(path.join(f.root, "coordinator-claimed-reviews.json")).mode & 0o777).toBe(0o600);
});

test("durable review refuses linked storage and duplicate request identities", async () => {
  const f = diskFixture();
  const file = path.join(f.root, "coordinator-claimed-reviews.json");
  const unrelated = path.join(f.root, "unrelated");
  writeFileSync(unrelated, "preserve", { mode: 0o600 });
  symlinkSync(unrelated, file);
  expect(() => f.journal.readReviews()).toThrow();
  expect(readFileSync(unrelated, "utf8")).toBe("preserve");
  rmSync(file);
  const pending = await f.reviews.prepare({ id: randomUUID(), reason: "fixture", plan: f.plan });
  expect(() => f.journal.replaceReviews([pending], [pending, pending])).toThrow("Duplicate");
  expect(f.journal.readReviews()).toEqual([pending]);
});

test("durable approved recovery fences the exact original under shared exclusion", async () => {
  const f = diskFixture();
  const original = new FileBootstrapRequestJournal(f.root);
  original.replace([], [f.plan.original]);
  const pending = await f.reviews.prepare({ id: randomUUID(), reason: "fixture", plan: f.plan });
  expect(() => f.journal.fenceClaim(pending)).toThrow("dispatch required");
  const approved = await f.reviews.decide(
    { ...identity(pending), decision: "approve" },
    password,
    true,
  );
  expect(() => f.journal.fenceClaim(approved)).toThrow("dispatch required");
  const claimed = await f.reviews.claim(identity(approved));
  const fenced = f.journal.fenceClaim(claimed);
  expect(fenced.execution?.stage).toBe("recovery_required");
  expect(fenced.decisionAt).toBe(f.plan.original.decisionAt);
  expect(f.journal.fenceClaim(claimed)).toEqual(fenced);
  expect(() => original.promote(f.plan.original)).toThrow("Exact protected bootstrap claim");
  const advanced = f.reviews.advance(claimed, "claim_fenced");
  expect(() => f.journal.fenceClaim(claimed)).toThrow("ownership changed");
  expect(f.journal.readReviews()).toEqual([advanced]);
  expect(original.read()).toEqual([fenced]);
});

test("a promoted original refuses the separately approved recovery fence", async () => {
  const f = diskFixture();
  const original = new FileBootstrapRequestJournal(f.root);
  original.replace([], [f.plan.original]);
  const pending = await f.reviews.prepare({ id: randomUUID(), reason: "fixture", plan: f.plan });
  const approved = await f.reviews.decide(
    { ...identity(pending), decision: "approve" },
    password,
    true,
  );
  const claimed = await f.reviews.claim(identity(approved));
  original.promote(f.plan.original);
  expect(() => f.journal.fenceClaim(claimed)).toThrow("promotion already started");
  expect(original.readPromoted()).toEqual([f.plan.original]);
});

function observationFixture() {
  const f = diskFixture();
  const plan = f.plan;
  const pin = (name: string, value: unknown) => {
    const file = path.join(f.root, name);
    const bytes = JSON.stringify(value);
    writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  plan.setup = pin("setup.json", {
    node: plan.runner.node,
    entrypoint: plan.executorEntrypoint,
    renewal: {
      hostProcess: plan.hostProcess,
      request: {
        id: plan.original.id,
        revision: plan.dispatchApprovalRevision,
        planSha256: plan.original.planSha256,
      },
    },
  });
  plan.executor.identity.argumentsSha256 = createHash("sha256")
    .update(
      JSON.stringify([
        plan.runner.node.path,
        plan.executorEntrypoint.path,
        plan.setup.path,
        "executor",
        plan.original.id,
      ]),
    )
    .digest("hex");
  const inspector = { path: "/protected/inspector", sha256: "a".repeat(64) };
  const observation = ClaimedRecoveryObservationSchema.parse({
    version: 1,
    provenance: "observed-after-claim",
    observedAt: new Date().toISOString(),
    claim: {
      id: plan.original.id,
      revision: plan.original.revision,
      planSha256: plan.original.planSha256,
      generation: plan.original.execution!.generation,
    },
    dispatchApprovalRevision: plan.dispatchApprovalRevision,
    setup: plan.setup,
    inspector,
    ownerLauncher: plan.ownerLauncher,
    executor: plan.executor,
    host: plan.hostProcess,
    coordinator: plan.coordinatorProcess,
    executionLock: plan.executionLock,
  });
  plan.retainedObservation = pin("observation.json", observation);
  const reader = {
    inspectProcess: async (pid: number) =>
      structuredClone(pid === plan.hostProcess.pid ? plan.hostProcess : plan.coordinatorProcess),
    inspectAuditedProcess: async (_pid: number) => structuredClone(plan.executor),
    verifyProcessExited: async (_pid: number) => {
      throw new Error("parent is alive");
    },
    readService: async (service: string) =>
      `${service} = {\n\tpid = ${plan.coordinatorProcess.pid}\n}`,
  };
  return { ...f, inspector, observation, reader, pin, writableMountRoots: [] as string[] };
}

test("native observation checks exact claim and approval revisions independently", async () => {
  const f = observationFixture();
  await verifyClaimedRetainedObservation(f);
  await verifyClaimedLiveProcesses(f);
  const changed = structuredClone(f.plan);
  changed.dispatchApprovalRevision = randomUUID();
  await expect(verifyClaimedRetainedObservation({ ...f, plan: changed })).rejects.toThrow(
    "observation changed",
  );
  const altered = { ...f.observation, claim: { ...f.observation.claim, generation: randomUUID() } };
  f.plan.retainedObservation = f.pin("observation.json", altered);
  await expect(verifyClaimedRetainedObservation(f)).rejects.toThrow("observation changed");
});

test("native observation rejects changed setup, evidence bytes and observations before the claim", async () => {
  const f = observationFixture();
  writeFileSync(f.plan.retainedObservation.path, "{}");
  await expect(verifyClaimedRetainedObservation(f)).rejects.toThrow();
  f.plan.retainedObservation = f.pin("observation.json", {
    ...f.observation,
    observedAt: new Date(0).toISOString(),
  });
  await expect(verifyClaimedRetainedObservation(f)).rejects.toThrow("observation changed");
  f.plan.retainedObservation = f.pin("observation.json", f.observation);
  writeFileSync(f.plan.setup.path, "{}");
  await expect(verifyClaimedRetainedObservation(f)).rejects.toThrow();
});

test("native observations reject identity change between reads and selected service change", async () => {
  const f = observationFixture();
  let reads = 0;
  const changedReader = {
    ...f.reader,
    inspectAuditedProcess: async () => {
      const observed = structuredClone(f.plan.executor);
      if (++reads === 2) observed.auditToken[7]++;
      return observed;
    },
  };
  await expect(verifyClaimedLiveProcesses({ ...f, reader: changedReader })).rejects.toThrow(
    "process identity changed",
  );
  await expect(
    verifyClaimedLiveProcesses({
      ...f,
      reader: {
        ...f.reader,
        readService: async (service: string) => `${service} = {\n\tpid = 999\n}`,
      },
    }),
  ).rejects.toThrow("selected coordinator changed");
});

test("reparenting needs proven Host exit and preserves every other audited identity field", async () => {
  const f = observationFixture();
  const orphan = structuredClone(f.plan.executor);
  orphan.identity.parentPid = 1;
  const reader = { ...f.reader, inspectAuditedProcess: async () => structuredClone(orphan) };
  await expect(verifyClaimedLiveProcesses({ ...f, reader })).rejects.toThrow("parent is alive");
  let exits = 0;
  const exited = {
    ...reader,
    verifyProcessExited: async (pid: number) => {
      expect(pid).toBe(f.plan.hostProcess.pid);
      exits++;
    },
  };
  await verifyClaimedLiveProcesses({ ...f, reader: exited });
  expect(exits).toBe(2);
  orphan.identity.startIdentity = "999:1";
  await expect(verifyClaimedLiveProcesses({ ...f, reader: exited })).rejects.toThrow(
    "process identity changed",
  );
});

test("read-only original admission refuses promotion intent and leaves bytes unchanged", () => {
  const f = diskFixture();
  const original = new FileBootstrapRequestJournal(f.root);
  original.replace([], [f.plan.original]);
  original.verifyUnpromotedClaim(f.plan.original);
  original.promote(f.plan.original);
  rmSync(path.join(f.root, "coordinator-bootstrap.json"));
  const before = readFileSync(path.join(f.root, "coordinator-bootstrap-pending.json"));
  expect(() => original.verifyUnpromotedClaim(f.plan.original)).toThrow(
    "unpromoted bootstrap claim",
  );
  expect(readFileSync(path.join(f.root, "coordinator-bootstrap-pending.json"))).toEqual(before);
});

test("execution lock verification rejects a replacement inode without taking ownership", async () => {
  const f = diskFixture();
  const uid = process.getuid!();
  f.plan.executor.identity.uid = uid;
  f.plan.hostProcess.uid = uid;
  f.plan.coordinatorProcess.uid = uid;
  f.plan.executor.auditToken[1] = uid;
  const file = f.plan.executionLock.path;
  writeFileSync(file, "", { mode: 0o600 });
  const stat = statSync(file, { bigint: true });
  f.plan.executionLock.device = String(stat.dev);
  f.plan.executionLock.inode = String(stat.ino);
  await verifyClaimedExecutionLock({ plan: f.plan, writableMountRoots: [] });
  renameSync(file, file + ".retained");
  writeFileSync(file, "", { mode: 0o600 });
  await expect(
    verifyClaimedExecutionLock({ plan: f.plan, writableMountRoots: [] }),
  ).rejects.toThrow("execution lock changed");
  rmSync(file);
  symlinkSync(file + ".retained", file);
  await expect(
    verifyClaimedExecutionLock({ plan: f.plan, writableMountRoots: [] }),
  ).rejects.toThrow("canonical");
});

test("retained observation cannot authenticate a different dispatch approval in setup", async () => {
  const f = observationFixture();
  f.plan.setup = f.pin("setup.json", {
    node: f.plan.runner.node,
    entrypoint: f.plan.executorEntrypoint,
    renewal: {
      hostProcess: f.plan.hostProcess,
      request: {
        id: f.plan.original.id,
        revision: randomUUID(),
        planSha256: f.plan.original.planSha256,
      },
    },
  });
  f.plan.retainedObservation = f.pin("observation.json", { ...f.observation, setup: f.plan.setup });
  await expect(verifyClaimedRetainedObservation(f)).rejects.toThrow("dispatch provenance changed");
});

async function effectFixture(escalation: "none" | "SIGKILL" = "none") {
  const f = diskFixture();
  f.plan.signalPolicy.escalation = escalation;
  const original = new FileBootstrapRequestJournal(f.root);
  original.replace([], [f.plan.original]);
  const pending = await f.reviews.prepare({ id: randomUUID(), reason: "fixture", plan: f.plan });
  const approved = await f.reviews.decide(
    { ...identity(pending), decision: "approve" },
    password,
    true,
  );
  const claimed = await f.reviews.claim(identity(approved));
  const fenced = f.journal.fenceClaim(claimed);
  const request = f.reviews.advance(f.reviews.advance(claimed, "claim_fenced"), "effect_pending");
  return { ...f, original, request, fenced };
}

test("lost reservation reply never permits a repeated effect after reopening", async () => {
  const f = await effectFixture();
  const record = f.journal.reserveEffect(f.request, "terminate");
  const reopened = new FileClaimedRecoveryReviewJournal(f.root);
  expect(() => reopened.reserveEffect(f.request, "terminate")).toThrow("already reserved");
  expect(reopened.inspectEffects(f.request)).toEqual({ terminate: record, kill: null });
  const uncertain = f.reviews.advance(f.request, "recovery_required");
  expect(() => reopened.reserveEffect(uncertain, "terminate")).toThrow("approved recovery effect");
  const observing = f.reviews.advance(uncertain, "verifying");
  expect(reopened.inspectEffects(observing)).toEqual({ terminate: record, kill: null });
  expect(reopened.inspectEffects(observing)).toEqual({ terminate: record, kill: null });
  expect(f.original.read()).toEqual([f.fenced]);
});

test("effect reservation rejects stale review, changed fence and changed original", async () => {
  const f = await effectFixture();
  expect(() =>
    f.journal.reserveEffect({ ...f.request, revision: randomUUID() }, "terminate"),
  ).toThrow("ownership changed");
  const file = path.join(f.root, `coordinator-claim-fence-${f.request.execution!.generation}.json`);
  const before = readFileSync(file);
  const record = JSON.parse(before.toString());
  record.fenced.execution.generation = randomUUID();
  writeFileSync(file, JSON.stringify(record));
  expect(() => f.journal.reserveEffect(f.request, "terminate")).toThrow(
    "Retained claim fence changed",
  );
  writeFileSync(file, before);
  f.original.replace([f.fenced], [{ ...f.fenced, revision: randomUUID() }]);
  expect(() => f.journal.reserveEffect(f.request, "terminate")).toThrow("fence is not current");
  expect(() =>
    readFileSync(
      path.join(
        f.root,
        `coordinator-claimed-effect-${f.request.execution!.generation}-terminate.json`,
      ),
    ),
  ).toThrow();
});

test("escalation requires explicit approval and prior termination reservation", async () => {
  const denied = await effectFixture();
  expect(() => denied.journal.reserveEffect(denied.request, "kill")).toThrow(
    "approved recovery effect",
  );
  const f = await effectFixture("SIGKILL");
  expect(() => f.journal.reserveEffect(f.request, "kill")).toThrow("termination history");
  const terminate = f.journal.reserveEffect(f.request, "terminate");
  const kill = f.journal.reserveEffect(f.request, "kill");
  expect(f.journal.inspectEffects(f.request)).toEqual({ terminate, kill });
  expect(() => f.journal.reserveEffect(f.request, "kill")).toThrow("already reserved");
});

test("corrupt reservation consumes its slot instead of being treated as absent", async () => {
  const f = await effectFixture();
  f.journal.reserveEffect(f.request, "terminate");
  const file = path.join(
    f.root,
    `coordinator-claimed-effect-${f.request.execution!.generation}-terminate.json`,
  );
  writeFileSync(file, "{}");
  expect(() => f.journal.reserveEffect(f.request, "terminate")).toThrow();
  expect(readFileSync(file, "utf8")).toBe("{}");
  expect(() => f.journal.inspectEffects(f.request)).toThrow();
});

test("two independent processes cannot reserve the same recovery effect", async () => {
  const f = await effectFixture();
  const helper = path.join(f.root, "race.mjs");
  const module = new URL("./coordinator-bootstrap-claimed-journal.ts", import.meta.url).href;
  writeFileSync(
    helper,
    `import {FileClaimedRecoveryReviewJournal} from ${JSON.stringify(module)};
const journal = new FileClaimedRecoveryReviewJournal(process.argv[2]);
try { const request = journal.readReviews()[0]; journal.reserveEffect(request, "terminate"); console.log(JSON.stringify({reserved:true})); }
catch (error) { console.log(JSON.stringify({reserved:false, error:String(error.message)})); }
`,
    { mode: 0o600 },
  );
  const loader = fileURLToPath(
    new URL("../../../../../node_modules/tsx/dist/loader.mjs", import.meta.url),
  );
  const run = () =>
    promisify(execFile)(process.execPath, ["--import", loader, helper, f.root], { timeout: 15000 });
  const outcomes = await Promise.all([run(), run()]);
  const results = outcomes.map((result) => JSON.parse(result.stdout));
  expect(results.filter((result) => result.reserved)).toHaveLength(1);
  expect(results.find((result) => !result.reserved).error).toMatch(
    /already reserved|storage is busy/,
  );
  expect(f.journal.inspectEffects(f.request).terminate?.request).toEqual(f.request);
});

async function executorFixture(escalation: "none" | "SIGKILL" = "none") {
  const f = diskFixture();
  f.plan.signalPolicy.escalation = escalation;
  const original = new FileBootstrapRequestJournal(f.root);
  original.replace([], [f.plan.original]);
  const pending = await f.reviews.prepare({ id: randomUUID(), reason: "fixture", plan: f.plan });
  const approved = await f.reviews.decide(
    { ...identity(pending), decision: "approve" },
    password,
    true,
  );
  const calls: string[] = [];
  let owned = false;
  let terminalOwned = false;
  const advance = f.reviews.advance.bind(f.reviews);
  f.reviews.advance = (request, stage) => {
    if (stage === "succeeded") expect(terminalOwned).toBe(true);
    return advance(request, stage);
  };
  const operations: ClaimedRecoveryOperations = {
    withOwnership: async (_request, operation) => {
      expect(owned).toBe(false);
      owned = true;
      try {
        return await operation();
      } finally {
        owned = false;
      }
    },
    verifyBeforeFence: async () => {
      expect(owned).toBe(true);
      calls.push("verify before fence");
    },
    observeExecutor: async () => "running",
    dispatchEffect: async (record) => {
      expect(owned).toBe(true);
      expect(f.journal.inspectEffects(record.request)[record.effect]).toEqual(record);
      calls.push(record.effect);
    },
    waitForExit: async () => true,
    withVerifiedExitAndSelection: async (_request, operation) => {
      expect(owned).toBe(true);
      calls.push("verify terminal");
      terminalOwned = true;
      try {
        return await operation();
      } finally {
        terminalOwned = false;
      }
    },
  };
  return { ...f, original, approved, calls, operations };
}
function observationIdentity(request: BootstrapClaimedRecoveryRequest) {
  return { ...identity(request), generation: request.execution!.generation };
}

test("recovery core retains a single effect and commits terminal result inside ownership", async () => {
  const f = await executorFixture();
  const result = await executeClaimedRecovery(
    f.reviews,
    f.journal,
    identity(f.approved),
    f.operations,
  );
  expect(result.execution?.stage).toBe("succeeded");
  expect(f.calls).toEqual(["verify before fence", "terminate", "verify terminal"]);
  expect(f.journal.inspectEffects(result).terminate).not.toBeNull();
  expect(f.original.read()[0]?.execution?.stage).toBe("recovery_required");
  await expect(
    executeClaimedRecovery(f.reviews, f.journal, identity(f.approved), f.operations),
  ).rejects.toThrow("undispatched");
});

test("lost effect reply enters observation without replaying termination", async () => {
  const f = await executorFixture();
  f.operations.dispatchEffect = async () => {
    f.calls.push("uncertain termination");
    throw new Error("private lost reply");
  };
  const result = await executeClaimedRecovery(
    f.reviews,
    f.journal,
    identity(f.approved),
    f.operations,
  );
  expect(result.execution?.stage).toBe("recovery_required");
  expect(f.journal.inspectEffects(result).terminate).not.toBeNull();
  const observed = await reconcileClaimedRecovery(
    f.reviews,
    f.journal,
    observationIdentity(result),
    {
      withOwnership: f.operations.withOwnership,
      withVerifiedExitAndSelection: f.operations.withVerifiedExitAndSelection,
    },
  );
  expect(observed.execution?.stage).toBe("succeeded");
  expect(observed.execution?.generation).toBe(result.execution?.generation);
  expect(f.calls).toEqual(["verify before fence", "uncertain termination", "verify terminal"]);
});

test("already exited target needs no effect while escalation requires its exact policy", async () => {
  const gone = await executorFixture();
  gone.operations.observeExecutor = async () => "exited";
  const result = await executeClaimedRecovery(
    gone.reviews,
    gone.journal,
    identity(gone.approved),
    gone.operations,
  );
  expect(result.execution?.stage).toBe("succeeded");
  expect(gone.journal.inspectEffects(result)).toEqual({ terminate: null, kill: null });
  const denied = await executorFixture();
  denied.operations.waitForExit = async () => false;
  const failed = await executeClaimedRecovery(
    denied.reviews,
    denied.journal,
    identity(denied.approved),
    denied.operations,
  );
  expect(failed.execution?.stage).toBe("recovery_required");
  expect(denied.calls).toEqual(["verify before fence", "terminate"]);
  const allowed = await executorFixture("SIGKILL");
  let waits = 0;
  allowed.operations.waitForExit = async () => ++waits === 2;
  const done = await executeClaimedRecovery(
    allowed.reviews,
    allowed.journal,
    identity(allowed.approved),
    allowed.operations,
  );
  expect(done.execution?.stage).toBe("succeeded");
  expect(allowed.calls).toEqual(["verify before fence", "terminate", "kill", "verify terminal"]);
});

test("uncertain inspection cannot authorize escalation or a terminal result", async () => {
  const f = await executorFixture("SIGKILL");
  f.operations.waitForExit = async () => {
    throw new Error("inspection unavailable");
  };
  const result = await executeClaimedRecovery(
    f.reviews,
    f.journal,
    identity(f.approved),
    f.operations,
  );
  expect(result.execution?.stage).toBe("recovery_required");
  expect(f.journal.inspectEffects(result).kill).toBeNull();
  const observed = await reconcileClaimedRecovery(
    f.reviews,
    f.journal,
    observationIdentity(result),
    {
      withOwnership: f.operations.withOwnership,
      withVerifiedExitAndSelection: async () => {
        throw new Error("exit unproven");
      },
    },
  );
  expect(observed.execution?.stage).toBe("recovery_required");
  expect(f.calls).toEqual(["verify before fence", "terminate"]);
});

test("failed ownership before fencing can be closed without effects under fresh ownership", async () => {
  const f = await executorFixture();
  const result = await executeClaimedRecovery(f.reviews, f.journal, identity(f.approved), {
    ...f.operations,
    withOwnership: async () => {
      throw new Error("ownership unavailable");
    },
  });
  expect(result.execution?.stage).toBe("recovery_required");
  const aborted = await reconcileClaimedRecovery(
    f.reviews,
    f.journal,
    observationIdentity(result),
    {
      withOwnership: f.operations.withOwnership,
      withVerifiedExitAndSelection: f.operations.withVerifiedExitAndSelection,
    },
  );
  expect(aborted.execution?.stage).toBe("aborted_before_effects");
  expect(f.calls).toEqual([]);
  expect(f.original.read()).toEqual([f.plan.original]);
});

test("lost terminal write reply reconciles existing success without another effect", async () => {
  const f = await executorFixture();
  const advance = f.reviews.advance.bind(f.reviews);
  let loseReply = true;
  f.reviews.advance = (request, stage) => {
    const result = advance(request, stage);
    if (stage === "succeeded" && loseReply) {
      loseReply = false;
      throw new Error("lost terminal reply");
    }
    return result;
  };
  await expect(
    executeClaimedRecovery(f.reviews, f.journal, identity(f.approved), f.operations),
  ).rejects.toThrow();
  const stored = f.reviews.list()[0]!;
  expect(stored.execution?.stage).toBe("succeeded");
  const observed = await reconcileClaimedRecovery(
    f.reviews,
    f.journal,
    observationIdentity(stored),
    {
      withOwnership: f.operations.withOwnership,
      withVerifiedExitAndSelection: f.operations.withVerifiedExitAndSelection,
    },
  );
  expect(observed).toEqual(stored);
  expect(f.calls.filter((call) => call === "terminate")).toHaveLength(1);
});

test("observation closes a retained fence intent whose original write never committed", async () => {
  const f = await executorFixture();
  const claimed = await f.reviews.claim(identity(f.approved));
  const fenced = f.journal.fenceClaim(claimed);
  // Disposable crash image: evidence retained, pending replacement absent.
  f.original.replace([fenced], [f.plan.original]);
  const observed = await reconcileClaimedRecovery(
    f.reviews,
    f.journal,
    observationIdentity(claimed),
    {
      withOwnership: f.operations.withOwnership,
      withVerifiedExitAndSelection: f.operations.withVerifiedExitAndSelection,
    },
  );
  expect(observed.execution?.stage).toBe("aborted_before_effects");
  expect(f.original.read()).toEqual([f.plan.original]);
  expect(f.calls).toEqual([]);
  expect(
    JSON.parse(
      readFileSync(
        path.join(f.root, `coordinator-claim-fence-${claimed.execution!.generation}.json`),
        "utf8",
      ),
    ).fenced,
  ).toEqual(fenced);
});

test("observation can finish a committed fence before the recovery stage reply was recorded", async () => {
  const f = await executorFixture();
  const claimed = await f.reviews.claim(identity(f.approved));
  const fenced = f.journal.fenceClaim(claimed);
  const observed = await reconcileClaimedRecovery(
    f.reviews,
    f.journal,
    observationIdentity(claimed),
    {
      withOwnership: f.operations.withOwnership,
      withVerifiedExitAndSelection: f.operations.withVerifiedExitAndSelection,
    },
  );
  expect(observed.execution?.stage).toBe("succeeded");
  expect(observed.execution?.generation).toBe(claimed.execution?.generation);
  expect(f.original.read()).toEqual([fenced]);
  expect(f.calls).toEqual(["verify terminal"]);
});

async function verifyNativeAdapterFixture(input: {
  mode: string;
  f: ReturnType<typeof diskFixture>;
  request: BootstrapClaimedRecoveryRequest;
  target: ChildProcess;
  original: FileBootstrapRequestJournal;
  helper: string;
  inspector: string;
  inspectorDigest: string;
}) {
  const { mode, f, request, target, original, helper, inspector, inspectorDigest } = input;
  const verifying = f.reviews.advance(request, "verifying");
  if (mode === "adapter-stale") f.reviews.advance(verifying, "recovery_required");
  if (mode !== "adapter-live") {
    const closed = once(target, "close");
    target.kill();
    await closed;
  }
  const modulePath = (name: string) => fileURLToPath(new URL(name, import.meta.url));
  const requestFile = path.join(f.root, "native-request.json");
  writeFileSync(requestFile, JSON.stringify(verifying), { mode: 0o600 });
  const driver = path.join(f.root, "native-driver.ts");
  const helperPin = {
    path: helper,
    sha256: createHash("sha256").update(readFileSync(helper)).digest("hex"),
  };
  writeFileSync(
    driver,
    `
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createClaimedNativeOperations} from ${JSON.stringify(modulePath("./coordinator-bootstrap-claimed-native.ts"))};
import {FileClaimedRecoveryReviewJournal} from ${JSON.stringify(modulePath("./coordinator-bootstrap-claimed-journal.ts"))};
import {createNativeBootstrapServiceReader} from ${JSON.stringify(modulePath("./coordinator-bootstrap-service.ts"))};
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
const mode=process.argv[3];
const probe="import os,fcntl,sys; f=os.open(sys.argv[1],os.O_RDWR); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)";
async function main(){
 const nativeReader=await createNativeBootstrapServiceReader({helperPath:${JSON.stringify(inspector)},helperSha256:${JSON.stringify(inspectorDigest)},writableMountRoots:[]});
 let callback=false,held=false,admitted=false;
 const reader={...nativeReader,
  readService:async(service)=>service+' = {\\n\\tpid = '+request.plan.coordinatorProcess.pid+'\\n}',
  inspectProcess:async()=>{
   if(mode==='adapter-selection')writeFileSync(request.plan.selectedConfiguration.path,'changed');
   return request.plan.coordinatorProcess;
  },
 };
 const native=createClaimedNativeOperations({stateDirectory:request.plan.original.plan.state.directory,
  recoveryDescriptor:3,helper:${JSON.stringify(helperPin)},inspector:${JSON.stringify({ path: inspector, sha256: inspectorDigest })},reader,
  launcherFile:request.plan.selectedLauncher.path,configurationFile:request.plan.selectedConfiguration.path,writableMountRoots:[],
  journal:new FileClaimedRecoveryReviewJournal(request.plan.original.plan.state.directory),
  verifySupportedPlan:async()=>{admitted=true;},
 });
 let accepted=false;
 try{await native.withOwnership(request,async()=>{
  let nested=false;
  try{await native.withOwnership(request,async()=>{throw Error('entered nested');});}
  catch(error){nested=error.message==='Claimed recovery is already active';}
  if(!nested)throw Error('nested ownership admitted');
  await native.withVerifiedExitAndSelection(request,async()=>{
   callback=true;
   try{execFileSync('/usr/bin/python3',['-I','-B','-c',probe,request.plan.executionLock.path],{stdio:'pipe'});}
   catch(error){held=error.status!==0;}
   if(!held)throw Error('lock not retained');
   if(mode==='adapter-callback')throw Error('callback failure');
  });
 });accepted=true;}catch{}
 let outsideRefused=false;
 try{await native.observeExecutor(request);}catch{outsideRefused=true;}
 execFileSync('/usr/bin/python3',['-I','-B','-c',probe,request.plan.executionLock.path],{stdio:'pipe'});
 console.log(JSON.stringify({accepted,callback,held,admitted,outsideRefused,released:true}));
}
main().catch(()=>{process.exitCode=1;});
`,
    { mode: 0o600 },
  );
  const wrapper = `import fcntl,os,sys
lock,node,loader,driver,request,mode=sys.argv[1:]
fd=os.open(lock,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
if mode!='adapter-unheld': fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
if fd!=3: os.dup2(fd,3); os.close(fd)
os.set_inheritable(3,True)
os.execv(node,[node,'--import',loader,driver,request,mode])
`;
  const result = await promisify(execFile)(
    "/usr/bin/python3",
    [
      "-I",
      "-B",
      "-c",
      wrapper,
      path.join(f.root, "coordinator-preclaim-execution.lock"),
      process.execPath,
      modulePath("../../../../../node_modules/tsx/dist/loader.mjs"),
      driver,
      requestFile,
      mode,
    ],
    { timeout: 20000 },
  );
  expect(JSON.parse(result.stdout)).toMatchObject({
    accepted: mode === "adapter-exited",
    callback: ["adapter-exited", "adapter-callback"].includes(mode),
    held: ["adapter-exited", "adapter-callback"].includes(mode),
    outsideRefused: true,
    released: true,
  });
  expect(original.read()[0]?.execution?.stage).toBe("recovery_required");
}

function prepareNativeEffectFixture(input: {
  mode: string;
  effect: string;
  f: ReturnType<typeof diskFixture>;
  request: BootstrapClaimedRecoveryRequest;
  original: FileBootstrapRequestJournal;
  fenced: BootstrapClaimedRecoveryPlan["original"];
}) {
  const { mode, effect, f, request, original, fenced } = input;
  const plan = f.plan;
  if (mode !== "unreserved") f.journal.reserveEffect(request, "terminate");
  if (mode === "stale-review") f.reviews.advance(request, "recovery_required");
  if (mode === "changed-fence") original.replace([fenced], [{ ...fenced, revision: randomUUID() }]);
  if (mode === "changed-lock") {
    renameSync(plan.executionLock.path, plan.executionLock.path + ".old");
    writeFileSync(plan.executionLock.path, "", { mode: 0o600 });
  }
  if (mode === "changed-observation") writeFileSync(plan.retainedObservation.path, "{}");
  const dispatch = path.join(
    f.root,
    `coordinator-claimed-send-${request.execution!.generation}-${effect}.json`,
  );
  if (mode === "consumed") writeFileSync(dispatch, "{}", { mode: 0o600 });
  return dispatch;
}

async function closeNativeFixture(
  target: ChildProcess,
  coordinator: ChildProcess,
  escalation: boolean,
) {
  for (const child of [target, coordinator]) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, "close");
    child.kill(child === target && escalation ? "SIGKILL" : "SIGTERM");
    await closed;
  }
}

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
    "changed-fence",
    "changed-lock",
    "changed-observation",
    "adapter-exited",
    "adapter-live",
    "adapter-stale",
    "adapter-selection",
    "adapter-unheld",
    "adapter-callback",
  ])("claimed native helper acts only on its disposable audited target (%s)", async (mode) => {
  const f = diskFixture();
  const plan = f.plan;
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
  plan.runner.directory = f.root;
  plan.runner.node.path = realpathSync(process.execPath);
  plan.setup = retain(path.join(f.root, "setup.json"), "{}");
  plan.selectedLauncher = retain(path.join(f.root, "selected.plist"), "retained launcher");
  plan.selectedConfiguration = retain(path.join(f.root, "selected.json"), "{}");
  plan.original.plan.previous.launcher = plan.selectedLauncher;
  plan.original.plan.previous.configuration = plan.selectedConfiguration;
  const prefix = escalation ? 'process.on("SIGTERM",()=>{});' : "";
  const code =
    mode === "children"
      ? 'const {spawn}=require("node:child_process");const c=spawn("/bin/sleep",["20"]);c.once("spawn",()=>process.send("ready"));process.on("SIGTERM",()=>{c.kill();process.exit(0)});'
      : 'process.send("ready");setTimeout(()=>{},20000);';
  plan.executorEntrypoint = retain(
    path.join(
      f.root,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
    ),
    prefix + code,
  );
  const coordinator = spawn(
    plan.runner.node.path,
    ["-e", 'process.send("ready");setTimeout(()=>{},20000)'],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  await once(coordinator, "message");
  const target = spawn(
    plan.runner.node.path,
    [plan.executorEntrypoint.path, plan.setup.path, "executor", plan.original.id],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true },
  );
  await once(target, "message");
  try {
    plan.executor = await reader.inspectAuditedProcess(target.pid!);
    plan.hostProcess = await reader.inspectProcess(process.pid);
    plan.coordinatorProcess = await reader.inspectProcess(coordinator.pid!);
    if (mode.startsWith("adapter-")) {
      // Only service-manager selection is simulated in adapter acceptance.
      // Target identity/absence, inherited locks and journals remain native.
      plan.original.plan.previous.node = plan.runner.node;
      plan.coordinatorProcess.parentPid = 1;
      plan.coordinatorProcess.argumentsSha256 = createHash("sha256")
        .update(
          JSON.stringify([
            plan.original.plan.previous.node.path,
            plan.original.plan.previous.entrypoint.path,
            plan.selectedConfiguration.path,
          ]),
        )
        .digest("hex");
    }
    const { pid, bootId, startIdentity, argumentsSha256 } = plan.coordinatorProcess;
    plan.original.plan.expectedProcess = { pid, bootId, startIdentity, argumentsSha256 };
    if (mode === "wrong-token") plan.executor.auditToken[7]++;
    plan.original.planSha256 = coordinatorPlanDigest(plan.original.plan);
    plan.setup = retain(
      plan.setup.path,
      JSON.stringify({
        node: plan.runner.node,
        entrypoint: plan.executorEntrypoint,
        renewal: {
          hostProcess: plan.hostProcess,
          request: {
            id: plan.original.id,
            revision: plan.dispatchApprovalRevision,
            planSha256: plan.original.planSha256,
          },
        },
      }),
    );
    writeFileSync(plan.executionLock.path, "", { mode: 0o600 });
    const lock = statSync(plan.executionLock.path, { bigint: true });
    plan.executionLock.device = String(lock.dev);
    plan.executionLock.inode = String(lock.ino);
    plan.retainedObservation = retain(
      path.join(f.root, "observation.json"),
      JSON.stringify({
        version: 1,
        provenance: "observed-after-claim",
        observedAt: new Date().toISOString(),
        claim: {
          id: plan.original.id,
          revision: plan.original.revision,
          planSha256: plan.original.planSha256,
          generation: plan.original.execution!.generation,
        },
        dispatchApprovalRevision: plan.dispatchApprovalRevision,
        setup: plan.setup,
        inspector: { path: inspector, sha256: inspectorDigest },
        ownerLauncher: plan.ownerLauncher,
        executor: plan.executor,
        host: plan.hostProcess,
        coordinator: plan.coordinatorProcess,
        executionLock: plan.executionLock,
      }),
    );
    const original = new FileBootstrapRequestJournal(f.root);
    original.replace([], [plan.original]);
    const pending = await f.reviews.prepare({
      id: randomUUID(),
      reason: "Disposable native helper acceptance",
      plan,
    });
    const approved = await f.reviews.decide(
      { ...identity(pending), decision: "approve" },
      password,
      true,
    );
    const claimed = await f.reviews.claim(identity(approved));
    const fenced = f.journal.fenceClaim(claimed);
    const request = f.reviews.advance(f.reviews.advance(claimed, "claim_fenced"), "effect_pending");
    if (mode.startsWith("adapter-")) {
      await verifyNativeAdapterFixture({
        mode,
        f,
        request,
        target,
        original,
        helper,
        inspector,
        inspectorDigest,
      });
      return;
    }
    const dispatch = prepareNativeEffectFixture({ mode, effect, f, request, original, fenced });
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
          path.join(f.root, "coordinator-preclaim-execution.lock"),
          helper,
          "claimed-effect",
          f.root,
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
      f.journal.reserveEffect(request, "kill");
      if (mode === "kill") await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    const result = await invoke(effect);
    if (mode === "terminate" || mode === "kill") {
      expect(result).toEqual({ ok: true, error: "" });
      expect((await exited)[1]).toBe(mode === "kill" ? "SIGKILL" : "SIGTERM");
      expect(JSON.parse(readFileSync(dispatch, "utf8"))).toMatchObject({
        requestId: request.id,
        revision: request.revision,
        generation: request.execution!.generation,
        planSha256: request.planSha256,
        effect,
        executor: plan.executor,
      });
      expect((await invoke(effect)).ok).toBe(false);
      const verifying = f.reviews.advance(request, "verifying");
      // Use the actual native verifier and retain its inherited open file
      // description after it exits. A separate process must still be excluded.
      const terminalWrapper = `import fcntl,os,subprocess,sys
state,helper,*arguments=sys.argv[1:]
recovery=os.open(os.path.join(state,'coordinator-preclaim-execution.lock'),os.O_RDWR|os.O_NOFOLLOW)
fcntl.flock(recovery,fcntl.LOCK_EX|fcntl.LOCK_NB)
if recovery!=3: os.dup2(recovery,3); os.close(recovery)
execution=os.open(os.path.join(state,'coordinator-bootstrap-execution.lock'),os.O_RDWR|os.O_NOFOLLOW)
if execution!=4: os.dup2(execution,4); os.close(execution)
result=subprocess.run(['/usr/bin/python3','-I','-B',helper,'claimed-verify',state,*arguments],pass_fds=(3,4),capture_output=True)
if result.returncode: sys.stderr.buffer.write(result.stderr); sys.exit(result.returncode)
probe="import os,fcntl,sys; f=os.open(sys.argv[1],os.O_RDWR); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)"
lock=os.path.join(state,'coordinator-bootstrap-execution.lock')
assert subprocess.run(['/usr/bin/python3','-I','-B','-c',probe,lock],capture_output=True).returncode!=0
os.close(4)
assert subprocess.run(['/usr/bin/python3','-I','-B','-c',probe,lock],capture_output=True).returncode==0
`;
      const terminal = (retained: BootstrapClaimedRecoveryRequest) =>
        promisify(execFile)(
          "/usr/bin/python3",
          [
            "-I",
            "-B",
            "-c",
            terminalWrapper,
            f.root,
            helper,
            retained.id,
            retained.revision,
            retained.execution!.generation,
            retained.planSha256,
          ],
          { timeout: 10000 },
        );
      await terminal(verifying);
      const succeeded = f.reviews.advance(verifying, "succeeded");
      // Lost terminal replies can reverify the same generation, without effects.
      await terminal(succeeded);
      await expect(terminal(verifying)).rejects.toThrow();
    } else {
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/^preclaim:/);
      expect((await reader.inspectAuditedProcess(target.pid!)).identity.pid).toBe(target.pid);
    }
    expect((await reader.inspectProcess(coordinator.pid!)).pid).toBe(coordinator.pid);
    expect(original.read()[0]?.status).toBe("approved");
  } finally {
    await closeNativeFixture(target, coordinator, escalation);
  }
});

async function nativeLaunchBirthFields(input: {
  mode: string;
  entry: string;
  f: ReturnType<typeof diskFixture>;
  pin(file: string): BootstrapClaimedRecoveryPlan["setup"];
}) {
  const { mode, entry, f, pin } = input;
  if (!mode.startsWith("birth")) return {};
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
  if (mode === "birth-parent") hostProcess.startIdentity = "wrong-birth";
  const file = pin(entry);
  return {
    admissionSetupFile: entry,
    daemonId: "fixture",
    runtimeDirectory: f.root,
    runtimeSha256: "a".repeat(64),
    ownerLauncher: pin(
      fileURLToPath(new URL("../../../../../scripts/run-coordinator-owner.py", import.meta.url)),
    ),
    ownershipVerifier: file,
    inspector,
    selectedLauncherFile: entry,
    renewal: {
      version: 1,
      originalSetup: file,
      originalAdmission: file,
      terminal: { ...identity(f.plan.original), generation: randomUUID() },
      configuration: file,
      sourceCommit: "a".repeat(40),
      source: file,
      hostProcess,
      request: identity(f.plan.original),
    },
  };
}

test
  .runIf(process.platform === "darwin")
  .each([
    "launch",
    "pending",
    "changed-node",
    "wrong-original",
    "busy",
    "observer",
    "birth",
    "birth-parent",
    "birth-stale",
  ])("claimed launcher preserves one-shot approval and shared exclusion (%s)", async (mode) => {
  const f = diskFixture();
  const pending = await f.reviews.prepare({
    id: randomUUID(),
    reason: "Disposable launch",
    plan: f.plan,
  });
  const approved =
    mode === "pending"
      ? pending
      : await f.reviews.decide({ ...identity(pending), decision: "approve" }, password, true);
  let request = approved;
  if (mode === "observer") request = await f.reviews.claim(identity(approved));
  const node = realpathSync(process.execPath);
  const marker = path.join(f.root, "launched.json");
  const entry = path.join(f.root, "coordinator-bootstrap-runner.js");
  const birth = mode.startsWith("birth");
  const runnerModule = fileURLToPath(
    new URL("./coordinator-bootstrap-claimed-runner.ts", import.meta.url),
  );
  const tsxApi = fileURLToPath(
    new URL("../../../../../node_modules/tsx/dist/esm/api/index.cjs", import.meta.url),
  );
  const identityArgument = JSON.stringify({
    ...identity(approved),
    revision: mode === "birth-stale" ? randomUUID() : approved.revision,
  });
  const call =
    mode === "birth-stale"
      ? `await module.runNativeClaimedRecovery({setupFile:process.argv[2],identity:${identityArgument},recoveryDescriptor:Number(process.env.VORTEO_CLAIMED_LOCK_FD)});`
      : `await module.retainClaimedExecutorBirth({setupFile:process.argv[2],recoveryDescriptor:Number(process.env.VORTEO_CLAIMED_LOCK_FD),writableMountRoots:[]});`;
  const beforeMarker = birth
    ? `require(${JSON.stringify(tsxApi)}).register();const module=await import(${JSON.stringify(runnerModule)});${call}`
    : "";
  writeFileSync(
    entry,
    `const fs=require('node:fs');(async()=>{${beforeMarker}fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),fd:Number(process.env.VORTEO_CLAIMED_LOCK_FD)}));})().catch(error=>{console.error(error.message);process.exitCode=1;});`,
    { mode: 0o600 },
  );
  const setupFile = path.join(
    f.root,
    `coordinator-claimed-launch-${request.id}-${approved.revision}.json`,
  );
  const pin = (file: string) => ({
    path: realpathSync(file),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  });
  const birthFields = await nativeLaunchBirthFields({ mode, entry, f, pin });
  const setup = {
    ...birthFields,
    version: 1,
    kind: "bootstrap-claimed-recovery",
    stateDirectory: f.root,
    request: identity(approved),
    original: identity(f.plan.original),
    node: { path: node, sha256: createHash("sha256").update(readFileSync(node)).digest("hex") },
    entrypoint: {
      path: entry,
      sha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
    },
  };
  if (mode === "changed-node") setup.node.sha256 = "0".repeat(64);
  if (mode === "wrong-original") setup.original.revision = randomUUID();
  writeFileSync(setupFile, JSON.stringify(setup), { mode: 0o600 });
  const helper = fileURLToPath(
    new URL("../../../../../scripts/run-coordinator-owner.py", import.meta.url),
  );
  const lock = path.join(f.root, "coordinator-preclaim-execution.lock");
  let holder: ChildProcess | undefined;
  if (mode === "busy") {
    holder = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-u",
        "-c",
        "import os,fcntl,sys,time; f=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); time.sleep(20)",
        lock,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await once(holder.stdout!, "data");
  }
  const invoke = () =>
    promisify(execFile)(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        helper,
        mode === "observer" ? "claimed-observe" : "claimed-launch",
        setupFile,
        request.id,
        request.revision,
        request.planSha256,
        ...(mode === "observer" ? [request.execution!.generation] : []),
      ],
      { timeout: 10000 },
    );
  const attempt = path.join(
    f.root,
    `coordinator-claimed-attempt-${request.id}-${approved.revision}.json`,
  );
  try {
    if (mode === "launch" || mode === "observer" || mode === "birth") {
      await invoke();
      const observed = JSON.parse(readFileSync(marker, "utf8"));
      expect(observed.args).toEqual([
        setupFile,
        mode === "observer" ? "claimed-observer" : "claimed-executor",
        request.id,
        request.revision,
        request.planSha256,
        ...(mode === "observer" ? [request.execution!.generation] : []),
      ]);
      expect(observed.fd).toBeGreaterThanOrEqual(3);
      if (mode === "launch" || mode === "birth") {
        const retained = readFileSync(attempt, "utf8");
        await expect(invoke()).rejects.toThrow();
        expect(readFileSync(attempt, "utf8")).toBe(retained);
      } else expect(() => readFileSync(attempt)).toThrow();
      if (mode === "birth") {
        const record = JSON.parse(
          readFileSync(
            path.join(
              f.root,
              `coordinator-claimed-executor-${approved.id}-${approved.revision}.json`,
            ),
            "utf8",
          ),
        );
        expect(record.request).toEqual(identity(approved));
        expect(record.setup).toEqual(pin(setupFile));
        expect(record.executor.identity.pid).toBe(
          JSON.parse(readFileSync(attempt, "utf8")).launcherPid,
        );
        expect(record.executor.identity.parentPid).toBe(process.pid);
      }
    } else if (birth) {
      await expect(invoke()).rejects.toThrow();
      expect(JSON.parse(readFileSync(attempt, "utf8")).request).toEqual(identity(approved));
      expect(() => readFileSync(marker)).toThrow();
      expect(() =>
        readFileSync(
          path.join(
            f.root,
            `coordinator-claimed-executor-${approved.id}-${approved.revision}.json`,
          ),
        ),
      ).toThrow();
    } else {
      await expect(invoke()).rejects.toThrow();
      expect(() => readFileSync(marker)).toThrow();
      expect(() => readFileSync(attempt)).toThrow();
    }
    expect(f.journal.readReviews()).toEqual([request]);
  } finally {
    if (holder) {
      const closed = once(holder, "close");
      holder.kill();
      await closed;
    }
  }
});

test.each(["exited", "unproven", "changed-provenance"])(
  "claimed observation requires independent exit proof (%s)",
  async (mode) => {
    const f = observationFixture();
    let exitReads = 0;
    const reader = {
      ...f.reader,
      inspectAuditedProcess: async () => {
        throw new Error("live inspection unavailable");
      },
      verifyProcessExited: async () => {
        exitReads++;
        if (mode === "unproven") throw new Error("no native absence proof");
      },
    };
    if (mode === "changed-provenance") writeFileSync(f.plan.retainedObservation.path, "{}");
    if (mode === "exited") {
      await expect(observeClaimedExecutor({ ...f, reader })).resolves.toBe("exited");
      expect(exitReads).toBe(1);
    } else {
      await expect(observeClaimedExecutor({ ...f, reader })).rejects.toThrow();
      expect(exitReads).toBe(mode === "changed-provenance" ? 0 : 1);
    }
  },
);

function claimedReviewAdapter(f: ReturnType<typeof reviewFixture>): ClaimedRecoveryReviewService {
  return {
    available: true,
    list: () => f.reviews.list(),
    prepare: (value) => f.reviews.prepare(value),
    decide: (...args) => f.reviews.decide(...args),
  };
}

test.each(["exact", "hidden", "password", "unavailable", "cancel", "private-error"])(
  "claimed review messages preserve visible owner scope (%s)",
  async (mode) => {
    const f = reviewFixture();
    const service = claimedReviewAdapter(f);
    const id = randomUUID();
    const prepared = await handleClaimedRecoveryReview(
      {
        type: "installation.claimed_recovery.prepare.request",
        requestId: "prepare",
        input: { id, reason: "Fixture", plan: f.plan },
      },
      service,
    );
    expect(prepared.payload.error).toBeNull();
    const pending = f.reviews.list()[0]!;
    if (mode === "unavailable") service.available = false;
    if (mode === "private-error")
      f.setVerify(async () => {
        throw new Error("PRIVATE FIXTURE DETAIL");
      });
    const response = await handleClaimedRecoveryReview(
      {
        type: "installation.claimed_recovery.decide.request",
        requestId: "decision",
        input: { ...identity(pending), decision: mode === "cancel" ? "cancel" : "approve" },
        ownerPassword: mode === "password" ? "wrong" : password,
        ...(mode === "hidden" || mode === "cancel" ? {} : { claimedRecovery: true }),
      },
      service,
    );
    let expected = "pending";
    if (mode === "exact") expected = "approved";
    if (mode === "cancel") expected = "canceled";
    expect(f.reviews.list()[0]?.status).toBe(expected);
    if (mode === "exact" || mode === "cancel") {
      expect(response.payload.error).toBeNull();
      expect(response.payload.requests?.[0]?.status).toBe(expected);
    } else {
      expect(response.payload.requests).toBeNull();
      expect(typeof response.payload.error).toBe("string");
      expect(response.payload.error).not.toContain("PRIVATE FIXTURE DETAIL");
    }
  },
);

test("claimed observation capability requires its own available service and method", async () => {
  const f = reviewFixture();
  const claimed = claimedReviewAdapter(f);
  const base = {
    available: true,
    list: () => [],
    prepare: async () => {
      throw new Error("unused");
    },
    decide: async () => {
      throw new Error("unused");
    },
  };
  expect(bootstrapReviewFeatures(base)).toMatchObject({
    coordinatorBootstrapClaimedRecovery: false,
    coordinatorBootstrapClaimedObservation: false,
  });
  expect(bootstrapReviewFeatures({ ...base, claimedRecovery: claimed })).toMatchObject({
    coordinatorBootstrapClaimedRecovery: true,
    coordinatorBootstrapClaimedObservation: false,
  });
  const observed: unknown[] = [];
  claimed.reconcile = async (value) => {
    observed.push(value);
  };
  expect(
    bootstrapReviewFeatures({ ...base, available: false, claimedRecovery: claimed }),
  ).toMatchObject({
    coordinatorBootstrapReview: false,
    coordinatorBootstrapClaimedRecovery: true,
    coordinatorBootstrapClaimedObservation: true,
  });
  const input = {
    id: randomUUID(),
    revision: randomUUID(),
    planSha256: "a".repeat(64),
    generation: randomUUID(),
  };
  expect(
    (
      await handleClaimedRecoveryReview(
        {
          type: "installation.claimed_recovery.list_requests.request",
          requestId: "observe",
          reconcile: input,
        },
        claimed,
      )
    ).payload.error,
  ).toBeNull();
  expect(observed).toEqual([input]);
  claimed.available = false;
  expect(bootstrapReviewFeatures({ ...base, claimedRecovery: claimed })).toMatchObject({
    coordinatorBootstrapClaimedRecovery: false,
    coordinatorBootstrapClaimedObservation: false,
  });
});

test.each(["none", "attempt", "birth", "duplicate", "wrong-plan", "wrong-pid", "orphan", "linked"])(
  "claimed dispatch discovery retains history without inferring liveness: %s",
  async (mode) => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "claimed-discovery-")));
    try {
      const request = fixture(directory);
      const reference = {
        id: request.id,
        revision: request.revision,
        planSha256: request.planSha256,
      };
      const attemptId = randomUUID();
      const setup = path.join(
        directory,
        `coordinator-claimed-launch-${request.id}-${request.revision}.json`,
      );
      const attempt = {
        version: 1,
        request: reference,
        setup,
        launcherPid: request.plan.executor.identity.pid,
        attemptId,
      };
      const birth = {
        version: 1,
        request: reference,
        attemptId,
        setup: { path: setup, sha256: "a".repeat(64) },
        executor: structuredClone(request.plan.executor),
      };
      const attemptFile = path.join(
        directory,
        `coordinator-claimed-attempt-${request.id}-${request.revision}.json`,
      );
      const birthFile = path.join(
        directory,
        `coordinator-claimed-executor-${request.id}-${request.revision}.json`,
      );
      const save = (file: string, value: unknown) =>
        writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
      if (mode !== "none" && mode !== "orphan") save(attemptFile, attempt);
      if (!["none", "attempt"].includes(mode)) save(birthFile, birth);
      if (mode === "duplicate")
        save(
          path.join(directory, `coordinator-claimed-attempt-${request.id}-${randomUUID()}.json`),
          attempt,
        );
      if (mode === "wrong-plan")
        save(attemptFile, { ...attempt, request: { ...reference, planSha256: "f".repeat(64) } });
      if (mode === "wrong-pid") {
        birth.executor.identity.pid += 1;
        save(birthFile, birth);
      }
      if (mode === "linked") {
        renameSync(birthFile, birthFile + ".retained");
        symlinkSync(birthFile + ".retained", birthFile);
      }
      const observed = readClaimedDispatchObservation(directory, request);
      let expectedState = "unavailable";
      if (mode === "none") expectedState = "no_receipt";
      if (mode === "attempt") expectedState = "attempt_retained";
      if (mode === "birth") expectedState = "birth_retained";
      expect(observed.state).toBe(expectedState);
      if (mode === "birth")
        expect(observed).toEqual({
          state: "birth_retained",
          approvedRevision: request.revision,
          attemptId,
          executor: request.plan.executor.identity,
        });
      await expect(
        launchClaimedObservation(directory, { ...reference, generation: randomUUID() }),
      ).rejects.toThrow("Exact retained recovery generation required");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each(["launch", "cancel-during-preparation", "uncertain-launch", "cancel"])(
  "claimed review dispatch occurs only for a fresh unchanged owner decision: %s",
  async (mode) => {
    const f = reviewFixture();
    let prepares = 0;
    let launches = 0;
    const service = createDispatchingClaimedReview(f.reviews, async (request) => {
      prepares++;
      if (mode === "cancel-during-preparation")
        await f.reviews.decide({ ...identity(request), decision: "cancel" }, password, false);
      return async () => {
        launches++;
        if (mode === "uncertain-launch") throw new Error("fixture lost response");
      };
    });
    const pending = await service.prepare({
      id: randomUUID(),
      reason: "Fixture dispatch",
      plan: f.plan,
    });
    service.list();
    expect(prepares).toBe(0);
    const input = {
      ...identity(pending),
      decision: mode === "cancel" ? ("cancel" as const) : ("approve" as const),
    };
    const decision = service.decide(input, password, true);
    if (mode === "cancel-during-preparation" || mode === "uncertain-launch")
      await expect(decision).rejects.toThrow();
    else await decision;
    expect(prepares).toBe(mode === "cancel" ? 0 : 1);
    expect(launches).toBe(mode === "launch" || mode === "uncertain-launch" ? 1 : 0);
    const current = service.list()[0]!;
    expect(current.status).toBe(mode.startsWith("cancel") ? "canceled" : "approved");
    await expect(
      service.decide({ ...identity(current), decision: "approve" }, password, true),
    ).rejects.toThrow();
    expect(launches).toBe(mode === "launch" || mode === "uncertain-launch" ? 1 : 0);
  },
);

function successorHistoryFixture() {
  const recovery = fixture();
  const original = recovery.plan.original;
  original.plan.state.restartJournal = path.join(
    original.plan.state.directory,
    "restart-jobs.json",
  );
  original.plan.state.ownerSessions = path.join(
    original.plan.state.directory,
    "owner-sessions.json",
  );
  original.planSha256 = coordinatorPlanDigest(original.plan);
  recovery.planSha256 = claimedRecoveryPlanDigest(recovery.plan);
  const terminal = structuredClone(original);
  terminal.id = randomUUID();
  terminal.revision = randomUUID();
  terminal.execution!.generation = randomUUID();
  terminal.execution!.stage = "succeeded";
  const fenced = structuredClone(original);
  fenced.revision = randomUUID();
  fenced.execution!.stage = "recovery_required";
  const fence = {
    version: 1,
    recovery: { ...identity(recovery), generation: recovery.execution!.generation },
    original: structuredClone(original),
    fenced,
  };
  recovery.revision = randomUUID();
  recovery.execution!.stage = "succeeded";
  return {
    records: [terminal, structuredClone(fenced)],
    recovery,
    fence,
    identity: {
      installationId: original.plan.installationId,
      stateDirectory: original.plan.state.directory,
      service: original.plan.service,
    },
  };
}

test("successor history preserves the real release receipt and failed original", () => {
  const input = successorHistoryFixture();
  const before = structuredClone(input);
  const result = inspectClaimedSuccessorHistory(input);
  expect(result.terminal.request).toEqual(input.records[0]);
  expect(result.recoveredFrom).toEqual({
    ...identity(input.fence.fenced),
    generation: input.fence.fenced.execution!.generation,
  });
  expect(result.recovery.id).toBe(input.recovery.id);
  expect(input).toEqual(before);
  expect(input.records[1].execution!.stage).toBe("recovery_required");
});

test("successor history refuses incomplete recovery, altered provenance and later execution", () => {
  const mutations: ((input: ReturnType<typeof successorHistoryFixture>) => void)[] = [
    (input) => {
      input.recovery.execution!.stage = "recovery_required";
    },
    (input) => {
      input.recovery.status = "canceled";
    },
    (input) => {
      input.recovery.decisionAt = undefined;
    },
    (input) => {
      input.recovery.planSha256 = "f".repeat(64);
    },
    (input) => {
      input.fence.recovery.generation = randomUUID();
    },
    (input) => {
      input.fence.recovery.id = randomUUID();
    },
    (input) => {
      input.records[1].decisionAt = new Date().toISOString();
    },
    (input) => {
      input.records[1].revision = randomUUID();
    },
    (input) => {
      input.records.push(structuredClone(input.records[1]));
    },
    (input) => {
      const later = structuredClone(input.records[0]);
      later.id = randomUUID();
      later.execution!.generation = randomUUID();
      input.records.push(later);
    },
    (input) => {
      input.records.shift();
    },
    (input) => {
      input.identity.installationId = randomUUID();
    },
    (input) => {
      input.records[0].plan.candidate.configuration.sha256 = "f".repeat(64);
      input.records[0].planSha256 = coordinatorPlanDigest(input.records[0].plan);
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const input = successorHistoryFixture();
    mutate(input);
    expect(() => inspectClaimedSuccessorHistory(input), `history mutation ${index}`).toThrow();
  }
});

test("successor native admission independently requires both executors to have exited", async () => {
  const request = fixture();
  const executor = { ...request.plan.executor.identity, pid: 30 };
  const evidence = { request, executor };
  await expect(verifyClaimedSuccessorExit(evidence, {})).rejects.toThrow("native exit proof");
  const observed: number[] = [];
  await verifyClaimedSuccessorExit(evidence, {
    verifyProcessExited: async (pid) => {
      observed.push(pid);
    },
  });
  expect(observed).toEqual([request.plan.executor.identity.pid, executor.pid]);
  for (const livePid of observed) {
    await expect(
      verifyClaimedSuccessorExit(evidence, {
        verifyProcessExited: async (pid) => {
          if (pid === livePid) throw new Error("Independent absence is unproven");
        },
      }),
    ).rejects.toThrow("absence is unproven");
  }
});

test("successor history accepts exact protected snapshot bytes at new plan paths", () => {
  const input = successorHistoryFixture();
  input.records[0].plan.candidate.configuration = {
    ...input.records[0].plan.candidate.configuration,
    path: "/protected/earlier-plan/config.json",
  };
  input.records[0].plan.candidate.launcher = {
    ...input.records[0].plan.candidate.launcher,
    path: "/protected/earlier-plan/launcher.plist",
  };
  input.records[0].planSha256 = coordinatorPlanDigest(input.records[0].plan);
  expect(inspectClaimedSuccessorHistory(input).terminal.request.id).toBe(input.records[0].id);
  input.records[0].plan.candidate.launcher.sha256 = "f".repeat(64);
  input.records[0].planSha256 = coordinatorPlanDigest(input.records[0].plan);
  expect(() => inspectClaimedSuccessorHistory(input)).toThrow("terminal release");
});

test("status reads do not take the executor's journal lock while writers remain serialized", async () => {
  const f = diskFixture();
  const pending = await f.reviews.prepare({ id: randomUUID(), reason: "fixture", plan: f.plan });
  const original = new FileBootstrapRequestJournal(f.root);
  original.withRecoveryTransaction(() => {
    expect(f.journal.readReviews()).toEqual([pending]);
    expect(() => f.journal.replaceReviews([pending], [])).toThrow("storage is busy");
  });
  expect(f.journal.readReviews()).toEqual([pending]);
});

test("status reads retain canonical private-directory checks without the writer lock", async () => {
  const f = diskFixture();
  const pending = await f.reviews.prepare({ id: randomUUID(), reason: "fixture", plan: f.plan });
  chmodSync(f.root, 0o755);
  try {
    expect(() => f.journal.readReviews()).toThrow("private owned canonical directory");
  } finally {
    chmodSync(f.root, 0o700);
  }
  expect(f.journal.readReviews()).toEqual([pending]);
});
