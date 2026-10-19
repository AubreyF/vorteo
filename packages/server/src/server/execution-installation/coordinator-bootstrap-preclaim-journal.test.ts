import { afterEach, expect, test } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { FileBootstrapPreclaimJournal } from "./coordinator-bootstrap-preclaim-journal.js";
import { CoordinatorBootstrapRequests, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import type { PreclaimCancellation } from "./coordinator-bootstrap-preclaim-recovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(compatible = false) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "preclaim-recovery-")));
  roots.push(directory);
  const file = { path: "/protected/file", sha256: "a".repeat(64) };
  const release = {
    directory: "/protected/release",
    sourceCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64),
    node: file,
    entrypoint: file,
    configuration: file,
    launcher: file,
  };
  const original: PreclaimCancellation["original"] = {
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "fixture",
    createdAt: new Date(0).toISOString(),
    decisionAt: new Date(1).toISOString(),
    status: "approved",
    plan: {
      version: 1,
      operation: "coordinator-bootstrap",
      installationId: randomUUID(),
      service: "gui/501/local.vorteo.fixture.installation",
      expectedProcess: {
        pid: 10,
        bootId: "fixture",
        startIdentity: "1:1",
        argumentsSha256: "d".repeat(64),
      },
      previous: release,
      candidate: release,
      state: {
        directory,
        restartJournal: path.join(directory, "restart.json"),
        ownerSessions: path.join(directory, "sessions.json"),
      },
      hostRequestsAfter: null,
      ...(compatible
        ? ({
            automaticRecovery: "restore-compatible",
            compatibleRecovery: release,
          } as const)
        : {}),
    },
    planSha256: "",
  };
  original.planSha256 = coordinatorPlanDigest(original.plan);
  const input: PreclaimCancellation = {
    version: 1,
    recoveryId: randomUUID(),
    recoveryRevision: randomUUID(),
    recoveryGeneration: randomUUID(),
    recoveryPlanSha256: "e".repeat(64),
    original,
    canceled: {
      ...original,
      revision: randomUUID(),
      status: "canceled",
      decisionAt: new Date(2).toISOString(),
    },
    executor: {
      identity: {
        pid: 20,
        parentPid: 21,
        uid: 501,
        bootId: randomUUID(),
        startIdentity: "1:2",
        argumentsSha256: "f".repeat(64),
        executable: "/protected/node",
      },
      auditToken: [501, 501, 20, 501, 20, 20, 100, 200],
    },
  };
  const legacy = new FileBootstrapRequestJournal(directory);
  legacy.replace([], [original]);
  return {
    directory,
    input,
    legacy,
    recovery: new FileBootstrapPreclaimJournal(directory),
    sidecar: path.join(directory, `coordinator-preclaim-recovery-${input.recoveryId}.json`),
  };
}

test.each([false, true])(
  "cancellation fences a pending legacy claim and preserves approval (%s)",
  async (compatible) => {
    const f = fixture(compatible);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new CoordinatorBootstrapRequests(
      f.legacy,
      () => ({
        environment: "host",
        installationId: f.input.original.plan.installationId,
        service: f.input.original.plan.service,
        ownerPasswordHash: "$2b$04$" + "a".repeat(53),
      }),
      () => barrier,
    );
    const { id, revision, planSha256 } = f.input.original;
    const claim = service.claimDispatch({ id, revision, planSha256 });
    const rejected = expect(claim).rejects.toThrow("request changed");
    f.recovery.fence(f.input);
    release();
    await rejected;
    expect(new FileBootstrapRequestJournal(f.directory).read()).toEqual([f.input.canceled]);
    expect(new FileBootstrapPreclaimJournal(f.directory).inspect(f.input.recoveryId)).toEqual({
      cancellation: f.input,
      fenced: true,
      terminateIntentAt: null,
      killIntentAt: null,
    });
  },
);

test("a prior legacy claim refuses cancellation without creating recovery history", () => {
  const f = fixture();
  const claimed = {
    ...f.input.original,
    revision: randomUUID(),
    execution: {
      generation: randomUUID(),
      stage: "claimed" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  f.legacy.replace([f.input.original], [claimed]);
  expect(() => f.recovery.fence(f.input)).toThrow("already have claimed");
  expect(f.recovery.inspect(f.input.recoveryId)).toBeNull();
  expect(f.legacy.read()).toEqual([claimed]);
});

test.each([false, true])(
  "reconciles retained intent before or after cancellation without losing history (%s)",
  (alreadyCanceled) => {
    const f = fixture(true);
    writeFileSync(
      f.sidecar,
      JSON.stringify({
        cancellation: f.input,
        fenced: false,
        terminateIntentAt: null,
        killIntentAt: null,
      }),
      { mode: 0o600 },
    );
    if (alreadyCanceled) f.legacy.replace([f.input.original], [f.input.canceled]);
    expect(f.recovery.fence(f.input).fenced).toBe(true);
    expect(f.recovery.fence(f.input).cancellation.original).toEqual(f.input.original);
    expect(f.legacy.read()).toEqual([f.input.canceled]);
  },
);

test("effects have durable single-use slots across reopen and require a current fence", () => {
  const f = fixture();
  const terminate = {
    cancellation: f.input,
    effect: "terminate" as const,
    at: new Date(3).toISOString(),
  };
  expect(() => f.recovery.reserveEffect(terminate)).toThrow("no durable");
  f.recovery.fence(f.input);
  expect(() => f.recovery.reserveEffect({ ...terminate, effect: "kill" })).toThrow(
    "precede termination",
  );
  f.recovery.reserveEffect(terminate);
  const reopened = new FileBootstrapPreclaimJournal(f.directory);
  expect(() => reopened.reserveEffect(terminate)).toThrow("cannot be replayed");
  reopened.reserveEffect({ ...terminate, effect: "kill" });
  expect(() => reopened.reserveEffect({ ...terminate, effect: "kill" })).toThrow(
    "cannot be replayed",
  );
  const snapshot = reopened.inspect(f.input.recoveryId);
  f.recovery.fence(f.input);
  expect(reopened.inspect(f.input.recoveryId)).toEqual(snapshot);
  f.legacy.replace([f.input.canceled], [{ ...f.input.canceled, revision: randomUUID() }]);
  expect(() => reopened.reserveEffect(terminate)).toThrow("no durable");
});

test("rejects linked history, changed review and unrecorded cancellation", () => {
  const f = fixture();
  f.legacy.replace([f.input.original], [f.input.canceled]);
  expect(() => f.recovery.fence(f.input)).toThrow("already have claimed");
  f.legacy.replace([f.input.canceled], [f.input.original]);
  f.recovery.fence(f.input);
  expect(() => f.recovery.fence({ ...f.input, recoveryRevision: randomUUID() })).toThrow(
    "review changed",
  );
  const bytes = readFileSync(f.sidecar);
  rmSync(f.sidecar);
  const other = path.join(f.directory, "other.json");
  writeFileSync(other, bytes, { mode: 0o600 });
  symlinkSync(other, f.sidecar);
  expect(() => f.recovery.inspect(f.input.recoveryId)).toThrow();
  expect(readFileSync(other)).toEqual(bytes);
});

test("escaped transaction callbacks cannot mutate after exclusion is released", () => {
  const f = fixture();
  let escaped!: (next: (typeof f.input.original)[]) => void;
  f.legacy.withRecoveryTransaction((_records, replace) => {
    escaped = replace;
  });
  expect(() => escaped([f.input.canceled])).toThrow("transaction ended");
  expect(() => f.legacy.withRecoveryTransaction(() => Promise.resolve())).toThrow(
    "must be synchronous",
  );
  expect(f.legacy.read()).toEqual([f.input.original]);
});

test("changed cancellation contents and target identities never mutate approval", () => {
  const f = fixture();
  for (const changed of [
    { ...f.input, canceled: { ...f.input.canceled, reason: "unreviewed" } },
    { ...f.input, canceled: { ...f.input.canceled, revision: f.input.original.revision } },
    { ...f.input, recoveryId: f.input.original.id },
    {
      ...f.input,
      executor: { ...f.input.executor, auditToken: [501, 501, 20, 501, 20, 999, 100, 200] },
    },
    { ...f.input, original: { ...f.input.original, planSha256: "0".repeat(64) } },
  ])
    expect(() => f.recovery.fence(changed)).toThrow("binding changed");
  expect(f.legacy.read()).toEqual([f.input.original]);
  expect(f.recovery.inspect(f.input.recoveryId)).toBeNull();
});

test("refuses a request bound to another state directory", () => {
  const f = fixture();
  const plan = {
    ...f.input.original.plan,
    state: { ...f.input.original.plan.state, directory: "/foreign/state" },
  };
  const planSha256 = coordinatorPlanDigest(plan);
  const changed = {
    ...f.input,
    original: { ...f.input.original, plan, planSha256 },
    canceled: { ...f.input.canceled, plan, planSha256 },
  };
  expect(() => f.recovery.fence(changed)).toThrow("state directory changed");
  expect(f.legacy.read()).toEqual([f.input.original]);
  expect(f.recovery.inspect(f.input.recoveryId)).toBeNull();
});

test("malformed null history is never treated as an absent journal", () => {
  const f = fixture();
  writeFileSync(f.sidecar, "null", { mode: 0o600 });
  expect(() => f.recovery.inspect(f.input.recoveryId)).toThrow();
  expect(() => f.recovery.fence(f.input)).toThrow();
  writeFileSync(path.join(f.directory, "coordinator-preclaim-reviews.json"), "null", {
    mode: 0o600,
  });
  expect(() => f.recovery.readReviews()).toThrow();
  expect(() => f.recovery.replaceReviews([], [])).toThrow();
  expect(f.legacy.read()).toEqual([f.input.original]);
});

test("independent owner cancellation is adopted verbatim only with explicit matching provenance", () => {
  const f = fixture();
  f.legacy.replace([f.input.original], [f.input.canceled]);
  expect(() => f.recovery.fence(f.input)).toThrow("already have claimed");
  const input = { ...f.input, ownerCancellation: f.input.canceled };
  const before = f.legacy.read();
  expect(f.recovery.fence(input).fenced).toBe(true);
  expect(f.legacy.read()).toEqual(before);
  expect(f.recovery.fence(input).cancellation).toEqual(input);
  expect(f.legacy.read()).toEqual(before);
});

test.each(["approved", "wrong-revision", "wrong-plan", "before-approval"])(
  "independent owner cancellation refuses %s without recovery history",
  (mode) => {
    const f = fixture();
    const input = { ...f.input, ownerCancellation: structuredClone(f.input.canceled) };
    if (mode === "before-approval") {
      input.ownerCancellation.decisionAt = new Date(0).toISOString();
      input.canceled = input.ownerCancellation;
    }
    const current = structuredClone(f.input.canceled);
    if (mode === "wrong-revision") current.revision = randomUUID();
    if (mode === "wrong-plan") current.planSha256 = "0".repeat(64);
    if (mode !== "approved") f.legacy.replace([f.input.original], [current]);
    const before = f.legacy.read();
    expect(() => f.recovery.fence(input)).toThrow();
    expect(f.recovery.inspect(input.recoveryId)).toBeNull();
    expect(f.legacy.read()).toEqual(before);
  },
);
