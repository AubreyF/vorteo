import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  InitialHostMigrationClaimSchema,
  InitialHostMigrationIntentSchema,
  InitialHostSupervisorMigrationPlanSchema,
  initialHostPublicationRecords,
} from "./host-supervisor-migration.js";
import { enrollmentNativeIdentityDigest } from "./native-identity.js";
import { InitialHostSupervisorPreconditionSchema } from "./native-daemon-inspection.js";
import {
  type HostRecoveryFileImage,
  type InitialHostRecoveryImage,
} from "./host-supervisor-recovery.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import {
  initialHostObservationPending,
  inspectInitialHostRecoveryPublication,
  readInitialHostObservation,
} from "./host-supervisor-recovery-inspection.js";
import { readBoundedMaintenanceInspection } from "../coordinator-bootstrap-maintenance-service-native.js";
import { reconcileNativeInitialHostActivation } from "./host-supervisor-activation.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const present = (file: string, bytes: string): HostRecoveryFileImage => ({
  path: file,
  state: "present",
  bytes: Buffer.from(bytes),
});
const absent = (file: string): HostRecoveryFileImage => ({ path: file, state: "absent" });

/** Actual protected files with injected journal custody and native exit evidence. */
function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "host-recovery-image-")));
  directories.push(directory);
  const file = (name: string) => ({ path: path.join(directory, name), sha256: "a".repeat(64) });
  const identity = {
    version: 1,
    environment: "host",
    target: "host",
    installationId: randomUUID(),
    custodyOwnerUid: process.getuid!(),
    installationRoot: directory,
    stateDirectory: directory + "/home",
    serviceDomain: `gui/${process.getuid!()}`,
    serviceLabel: "local.vorteo.test.host",
    launcherPath: file("host.plist").path,
    selectionPath: directory + "/current",
  };
  const originalLauncher = "original launcher";
  const candidateLauncher = "candidate launcher";
  const legacy = directory + "/legacy";
  const environment = { PASEO_HOME: identity.stateDirectory };
  const supervisor = {
    pid: 101,
    parentPid: 1,
    uid: process.getuid!(),
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
    launcher: { ...file("host.plist"), sha256: bytesDigest(originalLauncher) },
    clientConfiguration: file("client.json"),
    node: file("node"),
    supervisorEntrypoint: file("legacy/packages/server/dist/scripts/supervisor-entrypoint.js"),
    workerEntrypoint: file("legacy/packages/server/dist/server/server/daemon-worker.js"),
    sourceReceipt: file("legacy/.installation-source.json"),
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
        file("current/packages/server/dist/scripts/supervisor-entrypoint.js").path,
      ],
      environment,
      loadedEnvironment: environment,
    },
    supervisor,
    worker: { ...supervisor, pid: 102, parentPid: 101, startIdentity: "101:1" },
  });
  const release = (name: string, source: string, artifact: string, launcherSha: string) => ({
    directory: directory + "/" + name,
    sourceCommit: source.repeat(40),
    artifactSha256: artifact.repeat(64),
    node: precondition.node,
    configuration: precondition.configuration,
    launcher: { ...file(name + "/host.plist"), sha256: launcherSha },
    entrypoint: file(name + "/packages/server/dist/scripts/supervisor-entrypoint.js"),
  });
  const plan = InitialHostSupervisorMigrationPlanSchema.parse({
    version: 3,
    operation: "initial-host-supervisor-migration",
    managedReleaseRoot: directory,
    installationId: identity.installationId,
    identitySha256: enrollmentNativeIdentityDigest(precondition.identity),
    preconditionSha256: digest(precondition),
    precondition,
    candidate: release("candidate", "c", "d", bytesDigest(candidateLauncher)),
    fallback: release("sealed-legacy", "b", "f", bytesDigest(originalLauncher)),
    fallbackProvenance: file("fallback-copy.json"),
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 10 },
  });
  const intent = InitialHostMigrationIntentSchema.parse({
    version: 1,
    id: randomUUID(),
    operation: "initial-host-supervisor-migration",
    grantId: randomUUID(),
    grantRevision: randomUUID(),
    manifestSha256: "a".repeat(64),
    stepId: randomUUID(),
    generation: randomUUID(),
    planSha256: digest(plan),
    identitySha256: plan.identitySha256,
    preconditionSha256: plan.preconditionSha256,
    observedAt: "2026-10-17T00:00:00.000Z",
    createdAt: "2026-10-17T00:00:01.000Z",
  });
  const claim = InitialHostMigrationClaimSchema.parse({
    version: 1,
    operation: "initial-host-supervisor-migration",
    intentId: intent.id,
    intentSha256: digest(intent),
    stepId: intent.stepId,
    generation: intent.generation,
    planSha256: digest(plan),
    executor: { ...supervisor, pid: 103, parentPid: 101, startIdentity: "102:1" },
    consumedAt: "2026-10-17T00:00:02.000Z",
  });
  const records = initialHostPublicationRecords({
    plan,
    intent,
    claim,
    enrollmentStateDirectory: directory,
  });
  const input: InitialHostRecoveryImage = {
    enrollmentStateDirectory: directory,
    plan: present(
      file(`initial-host-migrations/plans/${digest(plan)}.json`).path,
      JSON.stringify(plan),
    ),
    intent: present(
      file(`initial-host-${intent.stepId}-${intent.generation}.json`).path,
      JSON.stringify(intent),
    ),
    claim: present(
      file(`initial-host-claim-${claim.stepId}-${claim.generation}.json`).path,
      JSON.stringify(claim),
    ),
    launcher: present(records.launcher.path, originalLauncher),
    phase: absent(records.phase.file),
    launcherAttempt: absent(records.launcherAttempt.file),
    selectorAttempt: absent(records.selectorAttempt.file),
    selector: {
      path: records.selector.path,
      state: "present",
      text: "legacy",
      resolvedTarget: legacy,
    },
  };
  for (const target of [legacy, plan.candidate.directory, plan.fallback.directory])
    mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const image of [input.plan, input.intent, input.claim, input.launcher]) {
    if (image.state !== "present") throw new Error("Fixture file must exist");
    mkdirSync(path.dirname(image.path), { recursive: true, mode: 0o700 });
    writeFileSync(image.path, image.bytes, { mode: 0o600 });
  }
  symlinkSync("legacy", records.selector.path);
  const controlFiles = [input.plan.path, input.intent.path, input.claim.path];
  const custody = retainServiceFiles(controlFiles);
  const context = {
    plan,
    planSha256: digest(plan),
    intent,
    claim,
    file: input.claim.path,
    intentFile: input.intent.path,
  };
  const retained = { context, assertCurrent: custody };
  const controller = new AbortController();
  const inspection: Parameters<typeof inspectInitialHostRecoveryPublication>[0] = {
    retained,
    signal: controller.signal,
    writableMountRoots: [],
    assertAnchorCurrent() {},
    reader: {
      async verifyProcessExited() {},
      async inspectProcess() {
        throw new Error("Unexpected live process");
      },
    },
  };
  function publish(stage: number) {
    const write = (record: { file: string; record: unknown }) =>
      writeFileSync(record.file, JSON.stringify(record.record), { mode: 0o600 });
    if (stage >= 1) write(records.launcherAttempt);
    if (stage >= 2) writeFileSync(records.launcher.path, candidateLauncher, { mode: 0o600 });
    if (stage >= 3) write(records.phase);
    if (stage >= 4) write(records.selectorAttempt);
    if (stage >= 5) {
      unlinkSync(records.selector.path);
      symlinkSync(plan.candidate.directory, records.selector.path);
    }
  }
  return { directory, records, plan, context, input, inspection, controller, publish };
}

describe("protected Host recovery publication collection", () => {
  test.each([
    [0, "unchanged-original"],
    [1, "unchanged-original"],
    [2, "launcher-first-partial"],
    [3, "launcher-first-partial"],
    [4, "launcher-first-partial"],
    [5, "completed-candidate"],
  ] as const)("captures stage %s as %s without runtime inspection", async (stage, expected) => {
    const f = fixture();
    f.publish(stage);
    const result = await inspectInitialHostRecoveryPublication(f.inspection);
    expect(result.publication.classification).toBe(expected);
    expect(result.publication.snapshot.claim.sha256).toBe(
      bytesDigest(JSON.stringify(f.context.claim)),
    );
    expect(result.assertCurrent()).toBeUndefined();
  });

  test("refuses a live executor before inspecting the substituted target", async () => {
    const f = fixture();
    unlinkSync(f.records.launcher.path);
    symlinkSync("missing-sensitive-file", f.records.launcher.path);
    f.inspection.reader.verifyProcessExited = async () => {
      throw new Error("Still live");
    };
    f.inspection.reader.inspectProcess = async () => f.context.claim.executor;
    await expect(inspectInitialHostRecoveryPublication(f.inspection)).rejects.toThrow(
      /exit is unproven/,
    );
  });

  test("rejects changed claim custody after the awaited exit check", async () => {
    const f = fixture();
    f.inspection.reader.verifyProcessExited = async () => {
      writeFileSync(f.input.claim.path, "changed", { mode: 0o600 });
    };
    await expect(inspectInitialHostRecoveryPublication(f.inspection)).rejects.toThrow(
      /custody changed/,
    );
  });

  test("retains absence of an addressed attempt", async () => {
    const f = fixture();
    const result = await inspectInitialHostRecoveryPublication(f.inspection);
    writeFileSync(f.records.phase.file, "appeared", { mode: 0o600 });
    expect(result.assertCurrent).toThrow(/presence changed/);
  });

  test("rejects replacement with the same launcher bytes", async () => {
    const f = fixture();
    const result = await inspectInitialHostRecoveryPublication(f.inspection);
    const bytes = readFileSync(f.records.launcher.path);
    renameSync(f.records.launcher.path, f.records.launcher.path + ".old");
    writeFileSync(f.records.launcher.path, bytes, { mode: 0o600 });
    expect(result.assertCurrent).toThrow(/custody changed/);
  });

  test("retains the original literal selector text", async () => {
    const f = fixture();
    const result = await inspectInitialHostRecoveryPublication(f.inspection);
    unlinkSync(f.records.selector.path);
    symlinkSync(f.records.selector.original, f.records.selector.path);
    expect(result.assertCurrent).toThrow(/selector changed/);
  });

  test("rejects symlink substitution of a missing attempt's ancestor", async () => {
    const f = fixture();
    const result = await inspectInitialHostRecoveryPublication(f.inspection);
    const moved = f.directory + "-moved";
    directories.push(moved);
    renameSync(f.directory, moved);
    symlinkSync(moved, f.directory);
    expect(result.assertCurrent).toThrow(/custody is unsafe|custody changed/);
  });

  test("rejects a protected-looking image in a writable container mount", async () => {
    const f = fixture();
    f.inspection.writableMountRoots = [f.directory];
    await expect(inspectInitialHostRecoveryPublication(f.inspection)).rejects.toThrow(
      /writable container mount/,
    );
  });

  test("caller cancellation invalidates retained custody after successful collection", async () => {
    const f = fixture();
    const result = await inspectInitialHostRecoveryPublication(f.inspection);
    f.inspection.signal = new AbortController().signal;
    f.controller.abort(new Error("Caller cancelled"));
    expect(result.assertCurrent).toThrow(/Caller cancelled/);
  });

  test("rejects asynchronous anchor custody before exit collection", async () => {
    const f = fixture();
    Object.assign(f.inspection, { assertAnchorCurrent: async () => undefined });
    await expect(inspectInitialHostRecoveryPublication(f.inspection)).rejects.toThrow(
      /must be synchronous/,
    );
  });

  test("retains an immutable claim binding across injected custody callbacks", async () => {
    const f = fixture();
    f.inspection.assertAnchorCurrent = () => {
      f.context.claim.executor.pid++;
    };
    await expect(inspectInitialHostRecoveryPublication(f.inspection)).rejects.toThrow(
      /retained claim changed/,
    );
  });

  test("rechecks publication files after the final anchor callback", async () => {
    const f = fixture();
    let change = false;
    f.inspection.assertAnchorCurrent = () => {
      if (change) writeFileSync(f.records.launcher.path, "substitution", { mode: 0o600 });
    };
    const result = await inspectInitialHostRecoveryPublication(f.inspection);
    change = true;
    expect(result.assertCurrent).toThrow(/custody changed/);
  });

  test("retains a timed-out native read until it settles", async () => {
    const f = fixture();
    let release = () => {};
    let finished = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      finished = resolve;
    });
    f.inspection.timeoutMs = 10;
    f.inspection.reader.verifyProcessExited = async () => {
      await pending;
      finished();
    };
    await expect(inspectInitialHostRecoveryPublication(f.inspection)).rejects.toThrow(/timed out/);
    await expect(inspectInitialHostRecoveryPublication(f.inspection)).rejects.toThrow(
      /still in progress/,
    );
    expect(
      await reconcileNativeInitialHostActivation({
        get configuration() {
          throw new Error("A pending read must prevent anchor setup");
        },
        configurationFile: f.input.plan.path,
      }),
    ).toBe("unresolved");
    release();
    await settled;
    // Flush completion of the native verifier and its retained ownership.
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.inspection.reader.verifyProcessExited = async () => undefined;
    f.inspection.timeoutMs = 30_000;
    const reopened = await inspectInitialHostRecoveryPublication(f.inspection);
    expect(reopened.publication.classification).toBe("unchanged-original");
  });

  test("late candidate rejection releases ownership only after settlement", async () => {
    let rejectRead = (_error: Error) => {};
    const candidate = new Promise<never>((_resolve, reject) => {
      rejectRead = reject;
    });
    const readCandidate = () => candidate;
    await expect(
      readBoundedMaintenanceInspection(() => readInitialHostObservation(readCandidate), {
        timeoutMs: 10,
        detail: "Candidate deadline",
      }),
    ).rejects.toThrow(/Candidate deadline/);
    expect(initialHostObservationPending()).toBe(true);
    await expect(readInitialHostObservation(async () => "replacement")).rejects.toThrow(
      /still in progress/,
    );
    rejectRead(new Error("Late native refusal"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(initialHostObservationPending()).toBe(false);
    await expect(readInitialHostObservation(async () => "fresh scan")).resolves.toBe("fresh scan");
  });
});
