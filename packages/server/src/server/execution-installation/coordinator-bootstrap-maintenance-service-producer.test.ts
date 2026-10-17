import { afterEach, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  closeSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  launchRetainedMaintenanceService,
  verifyRecordedMaintenanceChildExited,
} from "./coordinator-bootstrap-maintenance-service-producer.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "maintenance-producer-test-"));
  roots.push(root);
  return path.join(root, "observed.json");
}

test("one-shot native invocation preserves literal arguments and waits for exit", async () => {
  const receipt = fixture();
  const literal = "literal '$HOME' `value` & spaces";
  await launchRetainedMaintenanceService({
    node: process.execPath,
    args: [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
      receipt,
      literal,
    ],
    deadline: Date.now() + 3000,
  });
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual([literal]);
});

test("elapsed deadline refuses before starting a child", async () => {
  const receipt = fixture();
  await expect(
    launchRetainedMaintenanceService({
      node: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", receipt],
      deadline: Date.now() - 1,
    }),
  ).rejects.toThrow("deadline elapsed");
  expect(existsSync(receipt)).toBe(false);
});

test("failed child is uncertain, not a candidate success receipt", async () => {
  await expect(
    launchRetainedMaintenanceService({
      node: process.execPath,
      args: ["-e", "process.exit(23)"],
      deadline: Date.now() + 3000,
    }),
  ).rejects.toThrow("did not verify completion; observe only");
});

test("private generation diagnostics retain refusal without becoming a success receipt", async () => {
  const diagnosticFile = fixture();
  await expect(
    launchRetainedMaintenanceService({
      node: process.execPath,
      args: ["-e", "process.stderr.write('Fixture preclaim refusal'); process.exitCode = 23"],
      deadline: Date.now() + 3000,
      diagnosticFile,
    }),
  ).rejects.toThrow("did not verify completion; observe only");
  expect(readFileSync(diagnosticFile, "utf8")).toContain("Fixture preclaim refusal");
  const beforeReplay = readFileSync(diagnosticFile, "utf8");
  const spawned = JSON.parse(beforeReplay.split("\n")[0]!);
  expect(spawned.phase).toBe("launch-attempt");
  expect(Number.isNaN(Date.parse(spawned.at))).toBe(false);
  expect(statSync(diagnosticFile).mode & 0o777).toBe(0o600);
  await expect(
    launchRetainedMaintenanceService({
      node: process.execPath,
      args: ["-e", "process.stderr.write('replayed')"],
      deadline: Date.now() + 3000,
      diagnosticFile,
    }),
  ).rejects.toThrow("EEXIST");
  expect(readFileSync(diagnosticFile, "utf8")).toBe(beforeReplay);
});

test("diagnostic close failure retains child observation and refuses a success receipt", async () => {
  const receipt = fixture(),
    diagnosticFile = fixture();
  let closes = 0;
  const launch = launchRetainedMaintenanceService(
    {
      node: process.execPath,
      args: [
        "-e",
        "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1], 'completed once'), 50)",
        receipt,
      ],
      deadline: Date.now() + 3000,
      diagnosticFile,
    },
    (descriptor) => {
      closes++;
      closeSync(descriptor);
      throw new Error("Fixture close failed after descriptor retirement");
    },
  );
  await expect(launch).rejects.toThrow("diagnostic cleanup failed; observe only");
  expect(readFileSync(receipt, "utf8")).toBe("completed once");
  expect(closes).toBe(1);
});

test("generation diagnostics refuse symlinks without touching their destination", async () => {
  const target = fixture(),
    diagnosticFile = fixture();
  writeFileSync(target, "preserved", { mode: 0o600 });
  symlinkSync(target, diagnosticFile);
  await expect(
    launchRetainedMaintenanceService({
      node: process.execPath,
      args: [],
      deadline: Date.now() + 3000,
      diagnosticFile,
    }),
  ).rejects.toThrow("EEXIST");
  expect(readFileSync(target, "utf8")).toBe("preserved");
});

test("launch timeout does not signal or relaunch the disposable child", async () => {
  const receipt = fixture();
  const attempt = launchRetainedMaintenanceService({
    node: process.execPath,
    args: [
      "-e",
      "setTimeout(()=>require('node:fs').appendFileSync(process.argv[1], 'once'), 150)",
      receipt,
    ],
    deadline: Date.now() + 30,
  });
  await expect(attempt).rejects.toThrow("uncertain; observe only");
  // The fixture exits on its own. Its delayed write proves timeout did not
  // terminate it; one write proves the launcher did not retry.
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(readFileSync(receipt, "utf8")).toBe("once");
});

test("missing executable returns uncertainty without a retry", async () => {
  await expect(
    launchRetainedMaintenanceService({
      node: path.join(fixture(), "missing-node"),
      args: [],
      deadline: Date.now() + 3000,
    }),
  ).rejects.toThrow("uncertain; observe only");
});

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { resolveNativeMaintenanceExecutorSetup } from "./coordinator-bootstrap-maintenance-service-producer.js";
import {
  inspectMaintenanceLauncherPlan,
  type MaintenanceLauncherPlan,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { enrollmentNativeIdentityDigest } from "./maintenance/native-identity.js";
import { retainEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import {
  FileEnrollmentJournal,
  enrollInstallation,
  enrollmentManifestDigest,
  reserveActivationStep,
  changeStandingGrant,
} from "./maintenance/authorization.js";
import { reserveMaintenanceLauncherEffect } from "./coordinator-bootstrap-maintenance-launcher-state.js";

function registeredFixture(
  role: "maintenance-controller" | "recovery-launcher" = "maintenance-controller",
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "maintenance-registration-test-")));
  roots.push(root);
  const stateDirectory = path.join(root, "state");
  const base = path.join(root, "maintenance-services", role);
  mkdirSync(stateDirectory, { mode: 0o700 });
  mkdirSync(path.join(base, "plans"), { recursive: true, mode: 0o700 });
  const owner = userInfo();
  const account = { uid: owner.uid, home: owner.homedir };
  const installationId = randomUUID();
  const label = `local.vorteo.${installationId}.installation`;
  const sourceCommit = "a".repeat(40);
  const directory = path.join(root, "maintenance-runtimes", sourceCommit);
  const setupFile = path.join(base, `${sourceCommit}.json`);
  const identity: MaintenanceLauncherPlan["identity"] = {
    version: 1,
    environment: "host",
    target: role,
    installationId,
    custodyOwnerUid: owner.uid,
    installationRoot: root,
    stateDirectory,
    serviceDomain: `gui/${owner.uid}`,
    serviceLabel: label,
    launcherPath: path.join(owner.homedir, "Library/LaunchAgents", `${label}.plist`),
    selectionPath: path.join(base, "selection.json"),
  };
  const setup = JSON.stringify({
    version: 1,
    installationRoot: root,
    enrollmentStateDirectory: stateDirectory,
    identitySha256: enrollmentNativeIdentityDigest(identity),
    target: identity.target,
    sourceCommit,
    nativeAdmission: {
      path: path.join(root, "admission.json"),
      sha256: "a".repeat(64),
    },
  });
  writeFileSync(setupFile, setup, { mode: 0o600 });
  const plan: MaintenanceLauncherPlan = {
    version: 1,
    operation: "maintenance-launcher-replacement",
    identity,
    previous: null,
    candidate: {
      sourceCommit,
      directory,
      artifactSha256: "b".repeat(64),
      node: { path: path.join(directory, "node"), sha256: "c".repeat(64) },
      entrypoint: {
        path: path.join(
          directory,
          "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
        ),
        sha256: "d".repeat(64),
      },
      setup: {
        path: setupFile,
        sha256: createHash("sha256").update(setup).digest("hex"),
      },
    },
    retryLimit: 3,
    recovery: "after-login",
  };
  const native = inspectMaintenanceLauncherPlan(plan, account);
  const manifest = {
    version: 1,
    operation: "installation-enrollment",
    installationId,
    revision: randomUUID(),
    createdAt: new Date().toISOString(),
    provisioning: null,
    trustedRepositories: ["https://example.test/fixture"],
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 5 },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    targets: ["maintenance-controller", "recovery-launcher", "coordinator"].map((target) => ({
      target,
      identitySha256: native.identitySha256,
      operations: ["replacement"],
    })),
    steps: [
      {
        id: randomUUID(),
        target: identity.target,
        operation: "replacement",
        planSha256: native.planSha256,
        candidate: {
          sourceCommit,
          artifactSha256: plan.candidate.artifactSha256,
        },
        previous: null,
        dependsOn: [],
      },
    ],
  };
  const journal = new FileEnrollmentJournal(stateDirectory);
  const enrolled = enrollInstallation(journal, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: new Date().toISOString(),
    },
  });
  if (enrolled.status !== "enrolled") throw new Error("Fixture enrollment missing");
  const reserved = reserveActivationStep(journal, {
    grantRevision: enrolled.grant.revision,
    stepId: manifest.steps[0]!.id,
  });
  const step = reserved.status === "enrolled" ? reserved.activation.steps[0] : undefined;
  if (!step || step.status !== "reserved") throw new Error("Fixture reservation missing");
  const effect = reserveMaintenanceLauncherEffect({
    plan,
    enrollmentStateDirectory: stateDirectory,
    account,
    grantId: enrolled.grant.id,
    grantRevision: enrolled.grant.revision,
    stepId: step.id,
    generation: step.generation,
    assertCurrent: () => undefined,
  });
  retainEnrollmentNativeIdentity(stateDirectory, identity);
  writeFileSync(path.join(base, "plans", `${native.planSha256}.json`), JSON.stringify(plan), {
    mode: 0o600,
  });
  writeFileSync(
    identity.selectionPath!,
    JSON.stringify({
      version: 1,
      intentId: effect.intent.id,
      stepId: step.id,
      generation: step.generation,
      planSha256: native.planSha256,
      slot: "candidate",
    }),
    { mode: 0o600 },
  );
  return {
    installationId,
    stateDirectory,
    setupFile,
    journal,
    grantRevision: enrolled.grant.revision,
    identity,
  };
}

test("configured registration resolves exact setup without treating it as native health", async () => {
  const f = registeredFixture();
  await expect(resolveNativeMaintenanceExecutorSetup(f)).resolves.toMatchObject({
    installationId: f.installationId,
    stateDirectory: f.stateDirectory,
    executorSetupFile: f.setupFile,
  });
});

test("revoked enrollment keeps the retained setup observable", async () => {
  const f = registeredFixture();
  changeStandingGrant(f.journal, {
    expectedRevision: f.grantRevision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const before = f.journal.read();
  await expect(
    resolveNativeMaintenanceExecutorSetup({
      installationId: f.installationId,
      stateDirectory: f.stateDirectory,
    }),
  ).resolves.toEqual({
    installationId: f.installationId,
    stateDirectory: f.stateDirectory,
    executorSetupFile: f.setupFile,
  });
  expect(f.journal.read()).toEqual(before);
});

test("configured installation identity cannot resolve another installation", async () => {
  const f = registeredFixture();
  await expect(
    resolveNativeMaintenanceExecutorSetup({
      installationId: randomUUID(),
      stateDirectory: f.stateDirectory,
    }),
  ).rejects.toThrow("no matching maintenance enrollment");
});

test("changed selector cannot redirect setup discovery", async () => {
  const f = registeredFixture();
  const selection = JSON.parse(readFileSync(f.identity.selectionPath!, "utf8"));
  writeFileSync(f.identity.selectionPath!, JSON.stringify({ ...selection, slot: "previous" }));
  await expect(resolveNativeMaintenanceExecutorSetup(f)).rejects.toThrow(
    "differs from its retained plan",
  );
});

import { withinMaintenanceExecutionDeadline } from "./coordinator-bootstrap-maintenance-service-producer.js";

test("total deadline discards slow validation without launching its child", async () => {
  const receipt = fixture();
  await expect(
    withinMaintenanceExecutionDeadline(Date.now() + 20, async (assertCurrent) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      assertCurrent();
      await launchRetainedMaintenanceService({
        node: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'bad')", receipt],
        deadline: Date.now() + 1000,
      });
    }),
  ).rejects.toThrow("deadline elapsed; observe only");
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(existsSync(receipt)).toBe(false);
});

test("total deadline includes observation after a successful child exit", async () => {
  const receipt = fixture();
  let observations = 0;
  await expect(
    withinMaintenanceExecutionDeadline(Date.now() + 300, async () => {
      await launchRetainedMaintenanceService({
        node: process.execPath,
        args: ["-e", "require('node:fs').appendFileSync(process.argv[1], 'once')", receipt],
        deadline: Date.now() + 250,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      observations++;
      return "late success";
    }),
  ).rejects.toThrow("deadline elapsed; observe only");
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(observations).toBe(1);
  expect(readFileSync(receipt, "utf8")).toBe("once");
});

test("recovery launcher discovery requires its explicit enrolled role", async () => {
  const { resolveNativeMaintenanceRoleSetup } =
    await import("./coordinator-bootstrap-maintenance-service-producer.js");
  const f = registeredFixture("recovery-launcher");
  const selected = await resolveNativeMaintenanceRoleSetup({ ...f, target: "recovery-launcher" });
  expect(selected.executorSetupFile).toBe(f.setupFile);
  await expect(resolveNativeMaintenanceExecutorSetup(f)).rejects.toThrow("descriptor differs");
});

test("controller registration cannot substitute for a recovery launcher", async () => {
  const { resolveNativeMaintenanceRoleSetup } =
    await import("./coordinator-bootstrap-maintenance-service-producer.js");
  const f = registeredFixture();
  await expect(
    resolveNativeMaintenanceRoleSetup({ ...f, target: "recovery-launcher" }),
  ).rejects.toThrow("descriptor differs");
});

test("explicit recovery producer refuses a listener-only selected page before native setup", async () => {
  const { createNativeMaintenanceServiceExecutor } =
    await import("./coordinator-bootstrap-maintenance-service-producer.js");
  const f = registeredFixture("recovery-launcher");
  const before = readFileSync(f.setupFile);
  const input = {
    ...f,
    executorSetupFile: f.setupFile,
    executorTarget: "recovery-launcher" as const,
  };
  await expect(createNativeMaintenanceServiceExecutor(input)).rejects.toThrow(
    "Selected recovery page does not provide exact service execution",
  );
  expect(readFileSync(f.setupFile)).toEqual(before);
});

test("completed inspection keeps custody usable after its collection deadline", async () => {
  const { readBoundedMaintenanceInspection } =
    await import("./coordinator-bootstrap-maintenance-service-native.js");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let changed = false;
  const proof = await readBoundedMaintenanceInspection(
    async (signal) => ({
      assertCurrent() {
        signal.throwIfAborted();
        if (changed) throw new Error("Fixture custody changed");
      },
    }),
    { timeoutMs: 10_000, detail: "Fixture collection timed out" },
  );
  await vi.advanceTimersByTimeAsync(11_000);
  expect(() => proof.assertCurrent()).not.toThrow();
  changed = true;
  expect(() => proof.assertCurrent()).toThrow("Fixture custody changed");
});

test("inspection timeout aborts an unfinished read and discards its late proof", async () => {
  const { readBoundedMaintenanceInspection } =
    await import("./coordinator-bootstrap-maintenance-service-native.js");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const delayed = Promise.withResolvers<AbortSignal>();
  let observed: AbortSignal | undefined;
  const operation = readBoundedMaintenanceInspection(
    async (signal) => {
      observed = signal;
      return delayed.promise;
    },
    { timeoutMs: 10_000, detail: "Fixture collection timed out" },
  );
  const refused = expect(operation).rejects.toThrow("Fixture collection timed out");
  await vi.advanceTimersByTimeAsync(10_000);
  await refused;
  expect(observed?.aborted).toBe(true);
  delayed.resolve(observed!);
  await expect(operation).rejects.toThrow("Fixture collection timed out");
});

test("inspection rejects a synchronous late result before timer delivery", async () => {
  const { readBoundedMaintenanceInspection } =
    await import("./coordinator-bootstrap-maintenance-service-native.js");
  await expect(
    readBoundedMaintenanceInspection(
      async () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
        return "late";
      },
      { timeoutMs: 20, detail: "Fixture collection timed out" },
    ),
  ).rejects.toThrow("Fixture collection timed out");
});

function childDiagnostic() {
  const stateDirectory = realpathSync(path.dirname(fixture()));
  const requestId = randomUUID(),
    generation = randomUUID();
  const file = path.join(stateDirectory, `maintenance-service-${requestId}-${generation}.stderr`);
  const entry = { phase: "child-entry", pid: 42, at: new Date().toISOString() };
  const save = (value: string) => writeFileSync(file, value, { mode: 0o600 });
  return { stateDirectory, requestId, generation, file, entry, save };
}

test.each(["live", "reused", "inconclusive"])(
  "recorded %s PID defers unclaimed artifact collection",
  async (reason) => {
    const f = childDiagnostic();
    f.save(JSON.stringify(f.entry) + "\nMaintenance service invocation verified.\n");
    const collect = vi.fn();
    const reader = {
      verifyProcessExited: vi.fn(async () => {
        throw new Error(reason);
      }),
    };
    await expect(
      verifyRecordedMaintenanceChildExited({ ...f, reader }).then(collect),
    ).rejects.toThrow(reason);
    expect(reader.verifyProcessExited).toHaveBeenCalledWith(f.entry.pid);
    expect(collect).not.toHaveBeenCalled();
  },
);

test.each(["exited", "missing"])(
  "%s diagnostic hint still requires independent absence validation",
  async (kind) => {
    const f = childDiagnostic();
    if (kind === "exited") f.save(JSON.stringify(f.entry));
    const reader = { verifyProcessExited: vi.fn(async () => undefined) };
    const collect = vi.fn(async () => {
      throw new Error("Independent native absence is not proved");
    });
    await expect(
      verifyRecordedMaintenanceChildExited({ ...f, reader }).then(collect),
    ).rejects.toThrow("Independent native absence");
    expect(collect).toHaveBeenCalledOnce();
    expect(reader.verifyProcessExited).toHaveBeenCalledTimes(kind === "exited" ? 1 : 0);
  },
);

test.each(["duplicate", "invalid-pid", "unexpected-field", "truncated", "symlink"])(
  "%s diagnostic refuses before native or artifact inspection",
  async (kind) => {
    const f = childDiagnostic();
    if (kind === "duplicate") f.save(JSON.stringify(f.entry) + "\n" + JSON.stringify(f.entry));
    if (kind === "invalid-pid") f.save(JSON.stringify({ ...f.entry, pid: -1 }));
    if (kind === "unexpected-field") f.save(JSON.stringify({ ...f.entry, authority: true }));
    if (kind === "truncated") f.save('{"phase":"child-entry"');
    if (kind === "symlink") {
      const target = path.join(f.stateDirectory, "target");
      writeFileSync(target, JSON.stringify(f.entry), { mode: 0o600 });
      symlinkSync(target, f.file);
    }
    const reader = { verifyProcessExited: vi.fn(async () => undefined) };
    const collect = vi.fn();
    await expect(
      verifyRecordedMaintenanceChildExited({ ...f, reader }).then(collect),
    ).rejects.toThrow();
    expect(reader.verifyProcessExited).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  },
);

import { createNativeMaintenanceServiceRouter } from "./coordinator-bootstrap-maintenance-service-routing.js";
import {
  MaintenanceServiceJobSchema,
  MaintenanceServiceEvidenceRecordSchema,
  type MaintenanceServiceJob,
  type MaintenanceServiceEvidenceRecord,
} from "@getpaseo/protocol/maintenance-service";
import type { MaintenanceServiceExecutor } from "./maintenance/service-execution.js";

function routedJob(operation: MaintenanceServiceJob["operation"] = "replacement") {
  const id = randomUUID(),
    installationId = randomUUID(),
    now = new Date().toISOString();
  const request = MaintenanceServiceJobSchema.parse({
    id,
    revision: randomUUID(),
    target: "maintenance-controller",
    operation,
    reason: "Routing fixture",
    detail: "Pending",
    createdAt: now,
    status: "pending",
    evidence: [],
    proposal: {
      id,
      installationId,
      requestedBy: "host-agent",
      target: "maintenance-controller",
      operation,
      repository: "https://example.test/fixture",
      identitySha256: "a".repeat(64),
      planSha256: "b".repeat(64),
      sourceCommit: "c".repeat(40),
      artifactSha256: "d".repeat(64),
      previous: null,
      ...(operation === "replacement"
        ? {}
        : {
            recoveryOf: {
              requestId: randomUUID(),
              generation: randomUUID(),
              planSha256: "e".repeat(64),
              observationSha256: "f".repeat(64),
            },
          }),
    },
  });
  function reserve(role: "maintenance-controller" | "recovery-launcher") {
    const bootId = randomUUID(),
      revision = randomUUID();
    const native: MaintenanceServiceEvidenceRecord["native"] = {
      bootId,
      process: null,
      service: {
        domain: `gui/${process.getuid!()}`,
        label: "local.vorteo.fixture.installation",
        registered: false,
        launcherPath: "/fixture/launcher.plist",
        launcherSha256: null,
        registrationSha256: null,
      },
      selection: {
        path: "/fixture/selection.json",
        receiptSha256: null,
        sourceCommit: null,
        artifactSha256: null,
      },
    };
    const record: MaintenanceServiceEvidenceRecord = {
      requestId: id,
      requestRevision: revision,
      observedAt: now,
      planSha256: request.proposal.planSha256,
      identitySha256: request.proposal.identitySha256,
      sourceCommit: request.proposal.sourceCommit,
      artifactSha256: request.proposal.artifactSha256,
      native,
      executor: {
        target: role,
        identitySha256: "1".repeat(64),
        planSha256: "2".repeat(64),
        sourceCommit: "3".repeat(40),
        artifactSha256: "4".repeat(64),
        runtimeDirectory: "/fixture/runtime",
        node: { path: "/fixture/node", sha256: "5".repeat(64) },
        entrypoint: { path: "/fixture/entry.js", sha256: "6".repeat(64) },
        setup: { path: "/fixture/setup.json", sha256: "7".repeat(64) },
        native: {
          ...native,
          process: {
            pid: 42,
            parentPid: 1,
            uid: process.getuid!(),
            bootId,
            startIdentity: "1:0",
            executable: "/fixture/node",
            argumentsSha256: "8".repeat(64),
          },
          service: {
            ...native.service,
            registered: true,
            launcherSha256: "9".repeat(64),
            registrationSha256: "a".repeat(64),
          },
          selection: {
            ...native.selection,
            receiptSha256: "b".repeat(64),
            sourceCommit: "3".repeat(40),
            artifactSha256: "4".repeat(64),
          },
        },
      },
    };
    const parsedRecord = MaintenanceServiceEvidenceRecordSchema.parse(record);
    const sha256 = createHash("sha256").update(JSON.stringify(parsedRecord)).digest("hex");
    return MaintenanceServiceJobSchema.parse({
      ...request,
      status: "running",
      evidence: [{ sha256, record: parsedRecord }],
      reservation: {
        requestId: id,
        requestRevision: revision,
        generation: randomUUID(),
        target: request.target,
        operation,
        grantId: randomUUID(),
        grantRevision: randomUUID(),
        manifestSha256: "c".repeat(64),
        proposalSha256: "d".repeat(64),
        planSha256: record.planSha256,
        identitySha256: record.identitySha256,
        sourceCommit: record.sourceCommit,
        artifactSha256: record.artifactSha256,
        previous: null,
        recoveryOf: request.proposal.recoveryOf,
        nativeEvidenceSha256: sha256,
        reservedAt: now,
      },
    });
  }
  return { request, installationId, stateDirectory: "/fixture/state", reserve };
}

function routedProducer(label: string): MaintenanceServiceExecutor {
  return {
    inspect: vi.fn(async () => {
      throw new Error(`${label} inspect`);
    }),
    execute: vi.fn(async () => {
      throw new Error(`${label} execute`);
    }),
    observe: vi.fn(async () => {
      throw new Error(`${label} observe`);
    }),
  };
}

test("default routing constructs only the controller and preserves replacement-only support", async () => {
  const f = routedJob(),
    controller = routedProducer("controller");
  const construct = vi.fn(async () => controller);
  const router = await createNativeMaintenanceServiceRouter(f, construct);
  expect(router.operations).toEqual(["replacement"]);
  await expect(router.inspect(f.request)).rejects.toThrow("controller inspect");
  await expect(router.inspect(routedJob("recovery").request)).rejects.toThrow("not enabled");
  expect(construct).toHaveBeenCalledExactlyOnceWith("maintenance-controller");
});

test("linked controller routing constructs the page first and refuses unsupported targets before native inspection", async () => {
  const f = routedJob("recovery"),
    page = routedProducer("page"),
    controller = routedProducer("controller");
  const construct = vi.fn(async (role: string) =>
    role === "recovery-launcher" ? page : controller,
  );
  const router = await createNativeMaintenanceServiceRouter(
    { ...f, mode: "linked-controller-recovery" },
    construct,
  );
  expect(construct).toHaveBeenCalledExactlyOnceWith("recovery-launcher");
  await expect(router.inspect(f.request)).rejects.toThrow("page inspect");
  expect(construct).toHaveBeenCalledTimes(1);
  await expect(router.inspect({ ...f.request, target: "recovery-launcher" })).rejects.toThrow(
    "readiness is not accepted",
  );
  await expect(router.inspect(routedJob().request)).rejects.toThrow("controller inspect");
  expect(construct).toHaveBeenCalledTimes(2);
  expect(page.execute).not.toHaveBeenCalled();
});

test("reserved execution never constructs or substitutes another role", async () => {
  const f = routedJob("recovery"),
    page = routedProducer("page"),
    construct = vi.fn(async () => page);
  const router = await createNativeMaintenanceServiceRouter(
    { ...f, mode: "linked-controller-recovery" },
    construct,
  );
  const request = f.reserve("recovery-launcher");
  await expect(router.execute(request, request.reservation!)).rejects.toThrow("page execute");
  const foreign = f.reserve("maintenance-controller");
  await expect(router.execute(foreign, foreign.reservation!)).rejects.toThrow("role differs");
  await expect(
    router.execute(request, { ...request.reservation!, generation: randomUUID() }),
  ).rejects.toThrow("generation changed");
  const replacement = routedJob().reserve("maintenance-controller");
  await expect(router.execute(replacement, replacement.reservation!)).rejects.toThrow(
    "unavailable",
  );
  expect(construct).toHaveBeenCalledTimes(1);
  expect(page.execute).toHaveBeenCalledOnce();
});

test("consumed legacy observation uses cached tools without constructing a substitute", async () => {
  const f = routedJob("recovery"),
    page = routedProducer("page"),
    construct = vi.fn(async () => page);
  const router = await createNativeMaintenanceServiceRouter(
    { ...f, mode: "linked-controller-recovery" },
    construct,
  );
  const request = f.reserve("recovery-launcher"),
    entry = request.evidence[0]!;
  request.effectIntent = {
    id: randomUUID(),
    requestRevision: request.reservation!.requestRevision,
    generation: request.reservation!.generation,
    nativeEvidenceSha256: entry.sha256,
    executor: entry.record.executor!.native.process,
    consumedAt: new Date().toISOString(),
  };
  request.reservation!.nativeEvidenceSha256 = "f".repeat(64);
  await expect(router.observe(request, request.reservation!)).rejects.toThrow("page observe");
  delete request.effectIntent;
  await expect(router.observe(request, request.reservation!)).rejects.toThrow(
    "proof is unavailable",
  );
  expect(construct).toHaveBeenCalledTimes(1);
  expect(page.observe).toHaveBeenCalledOnce();
});

test("present tampered or ambiguous executor evidence never falls back to legacy observation", async () => {
  const f = routedJob("recovery"),
    page = routedProducer("page"),
    construct = vi.fn(async () => page);
  const router = await createNativeMaintenanceServiceRouter(
    { ...f, mode: "linked-controller-recovery" },
    construct,
  );
  const request = f.reserve("recovery-launcher"),
    entry = request.evidence[0]!;
  entry.record.planSha256 = "0".repeat(64);
  await expect(router.observe(request, request.reservation!)).rejects.toThrow("evidence changed");
  request.evidence.push(entry);
  await expect(router.observe(request, request.reservation!)).rejects.toThrow("ambiguous");
  expect(page.observe).not.toHaveBeenCalled();
  expect(construct).toHaveBeenCalledTimes(1);
});

test("one constructor remains owned after timeout and blocks cached dispatch until settlement", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = routedJob("recovery"),
    page = routedProducer("page"),
    controller = routedProducer("controller");
  let complete: ((producer: MaintenanceServiceExecutor) => void) | undefined;
  let controllerAttempts = 0;
  const construct = vi.fn(async (role: string) => {
    if (role === "recovery-launcher") return page;
    if (++controllerAttempts > 1) return controller;
    return new Promise<MaintenanceServiceExecutor>((resolve) => {
      complete = resolve;
    });
  });
  const router = await createNativeMaintenanceServiceRouter(
    { ...f, mode: "linked-controller-recovery" },
    construct,
  );
  const constructing = router.inspect(routedJob().request).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(0);
  const duplicate = router.inspect(routedJob().request).catch((error: Error) => error);
  const request = f.reserve("recovery-launcher");
  await expect(router.execute(request, request.reservation!)).rejects.toThrow("unavailable");
  await vi.advanceTimersByTimeAsync(25_001);
  expect(await constructing).toBeInstanceOf(Error);
  expect(await duplicate).toBeInstanceOf(Error);
  await expect(router.execute(request, request.reservation!)).rejects.toThrow("unavailable");
  await expect(router.inspect(routedJob().request)).rejects.toThrow("not settled");
  expect(construct).toHaveBeenCalledTimes(2);
  complete!(controller);
  await vi.advanceTimersByTimeAsync(0);
  await expect(router.inspect(routedJob().request)).rejects.toThrow("defer");
  expect(controller.inspect).not.toHaveBeenCalled();
  expect(page.execute).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  await expect(router.inspect(routedJob().request)).rejects.toThrow("controller inspect");
  expect(construct).toHaveBeenCalledTimes(3);
});

test("a timed-out underlying dispatch retains exclusion until it settles", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = routedJob("recovery"),
    page = routedProducer("page");
  let fail: ((error: Error) => void) | undefined;
  page.execute = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const construct = vi.fn(async () => page);
  const router = await createNativeMaintenanceServiceRouter(
    { ...f, mode: "linked-controller-recovery" },
    construct,
  );
  const request = f.reserve("recovery-launcher");
  const executing = router.execute(request, request.reservation!).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(25_001);
  expect(await executing).toBeInstanceOf(Error);
  await expect(router.inspect(routedJob().request)).rejects.toThrow("dispatch is still active");
  expect(construct).toHaveBeenCalledTimes(1);
  fail!(new Error("Late dispatch refusal"));
  await vi.advanceTimersByTimeAsync(0);
  await expect(router.inspect(routedJob().request)).rejects.toThrow("page inspect");
  expect(construct).toHaveBeenCalledTimes(2);
  expect(page.execute).toHaveBeenCalledOnce();
});

test("addressed retained page observation works without enabling page effects or falling back after refusal", async () => {
  const f = routedJob("recovery"),
    controller = routedProducer("controller"),
    page = routedProducer("page");
  const construct = vi.fn(async (role: string) =>
    role === "maintenance-controller" ? controller : page,
  );
  const router = await createNativeMaintenanceServiceRouter(f, construct);
  const retained = f.reserve("recovery-launcher");
  await expect(router.observe(retained, retained.reservation!)).rejects.toThrow("page observe");
  expect(construct.mock.calls.map(([role]) => role)).toEqual([
    "maintenance-controller",
    "recovery-launcher",
  ]);
  expect(controller.observe).not.toHaveBeenCalled();
  expect(router.operations).toEqual(["replacement"]);
});

test("timed-out native inspection retains read ownership until settlement and discards late proof", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = routedJob(),
    controller = routedProducer("controller"),
    page = routedProducer("page");
  let finish:
    | ((value: Awaited<ReturnType<MaintenanceServiceExecutor["inspect"]>>) => void)
    | undefined;
  controller.inspect = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const construct = vi.fn(async (role: string) =>
    role === "maintenance-controller" ? controller : page,
  );
  const router = await createNativeMaintenanceServiceRouter(f, construct);
  const inspected = router.inspect(f.request).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(25_001);
  expect(await inspected).toBeInstanceOf(Error);
  const running = f.reserve("maintenance-controller");
  await expect(router.execute(running, running.reservation!)).rejects.toThrow("unavailable");
  const retainedPage = routedJob("recovery").reserve("recovery-launcher");
  await expect(router.observe(retainedPage, retainedPage.reservation!)).rejects.toThrow(
    "construction is unavailable",
  );
  expect(construct).toHaveBeenCalledTimes(1);
  const proof = running.evidence[0]!;
  finish!({ ...proof.record, evidenceSha256: proof.sha256, assertCurrent() {} });
  await vi.advanceTimersByTimeAsync(0);
  expect(await inspected).toBeInstanceOf(Error);
  await expect(router.observe(retainedPage, retainedPage.reservation!)).rejects.toThrow(
    "page observe",
  );
  expect(construct).toHaveBeenCalledTimes(2);
  expect(controller.execute).not.toHaveBeenCalled();
});

test("timed-out retained observation cannot leave an abandoned artifact reader", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = routedJob("recovery"),
    page = routedProducer("page"),
    controller = routedProducer("controller");
  let fail: ((error: Error) => void) | undefined;
  page.observe = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const construct = vi.fn(async (role: string) =>
    role === "recovery-launcher" ? page : controller,
  );
  const router = await createNativeMaintenanceServiceRouter(
    { ...f, mode: "linked-controller-recovery" },
    construct,
  );
  const retained = f.reserve("recovery-launcher");
  const observed = router.observe(retained, retained.reservation!).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await observed).toBeInstanceOf(Error);
  await expect(router.execute(retained, retained.reservation!)).rejects.toThrow("unavailable");
  await expect(router.observe(retained, retained.reservation!)).rejects.toThrow(
    "reader or dispatch is still active",
  );
  await expect(router.inspect(routedJob().request)).rejects.toThrow("construction is unavailable");
  expect(construct).toHaveBeenCalledTimes(1);
  fail!(new Error("Late observation refusal"));
  await vi.advanceTimersByTimeAsync(0);
  await expect(router.inspect(routedJob().request)).rejects.toThrow("controller inspect");
  expect(construct).toHaveBeenCalledTimes(2);
  expect(page.observe).toHaveBeenCalledOnce();
});
