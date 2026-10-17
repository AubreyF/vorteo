import { hashSync } from "bcryptjs";
import {
  reconcileRecoveryAccessActivation,
  inspectRecoveryActivationInvocation,
  activateRecoveryBeforeCoordinator,
} from "./coordinator-bootstrap-maintenance-recovery-activation.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { verifyPersistentMaintenanceReview } from "./coordinator-bootstrap-maintenance-controller.js";
import { afterEach, expect, test, vi } from "vitest";
import {
  existsSync as fileExists,
  linkSync,
  symlinkSync,
  truncateSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  digestBootstrapArtifact,
  verifyBootstrapPreparedDependency,
} from "./coordinator-bootstrap-artifact.js";
import { inspectMaintenanceLauncherSelection } from "./coordinator-bootstrap-maintenance-selection.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import {
  inspectMaintenanceRecoveryRouting,
  verifyMaintenanceRecoveryRouteSelection,
} from "./coordinator-bootstrap-maintenance-recovery-routing.js";
import {
  activateMaintenanceRecoveryAccess,
  observeMaintenanceRecoveryAccessRegistration,
  type RecoveryRegistrationPorts,
} from "./coordinator-bootstrap-maintenance-recovery-registration.js";
import { createNativeRecoveryRegistrationPorts } from "./coordinator-bootstrap-maintenance-recovery-native-ports.js";
import { retainEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import { enrollmentNativeIdentityDigest } from "./maintenance/native-identity.js";
import {
  inspectMaintenanceLauncherPlan,
  maintenanceUserLauncher,
  prepareMaintenanceLauncherRouting,
  verifyMaintenanceLauncherArtifacts,
  verifyMaintenanceLauncherProcess,
  type MaintenanceLauncherPlan,
} from "./coordinator-bootstrap-maintenance-launcher.js";
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(separateEnrollment = false, controller = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "maintenance-slots-")));
  roots.push(root);
  const state = path.join(root, "state");
  const enrollmentStateDirectory = separateEnrollment
    ? path.join(root, "coordinator-state")
    : state;
  const home = path.join(root, "home");
  const target = controller ? "maintenance-controller" : "recovery-launcher";
  const base = path.join(root, "maintenance-services", target);
  for (const dir of [
    state,
    enrollmentStateDirectory,
    base,
    path.join(home, "Library/LaunchAgents"),
  ])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pin = (file: string, bytes: string) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode: 0o600 });
    return {
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const release = async (sourceCommit: string) => {
    const directory = path.join(root, "maintenance-runtimes", sourceCommit);
    const entrypoint = pin(
      path.join(
        directory,
        "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
      ),
      "fixture only",
    );
    const node = pin(path.join(directory, "node"), "fixture executable bytes");
    const setup = pin(path.join(base, `${sourceCommit}.json`), "{}");
    return {
      sourceCommit,
      directory,
      entrypoint,
      node,
      setup,
      artifactSha256: await digestBootstrapArtifact(directory),
    };
  };
  const plan: MaintenanceLauncherPlan = {
    version: 1,
    operation: "maintenance-launcher-replacement",
    retryLimit: 3,
    recovery: "after-login",
    identity: {
      version: 1,
      environment: "host",
      target,
      installationId: randomUUID(),
      custodyOwnerUid: process.getuid!(),
      installationRoot: root,
      stateDirectory: state,
      serviceDomain: `gui/${process.getuid!()}`,
      serviceLabel: "local.vorteo.fixture-recovery.installation",
      launcherPath: path.join(
        home,
        "Library/LaunchAgents/local.vorteo.fixture-recovery.installation.plist",
      ),
      selectionPath: path.join(base, "selection.json"),
    },
    previous: await release("a".repeat(40)),
    candidate: await release("b".repeat(40)),
  };
  for (const selected of [plan.previous!, plan.candidate]) {
    const bytes = JSON.stringify({
      version: 1,
      installationRoot: root,
      enrollmentStateDirectory,
      identitySha256: enrollmentNativeIdentityDigest(plan.identity),
      target: plan.identity.target,
      sourceCommit: selected.sourceCommit,
      nativeAdmission: {
        path: path.join(state, "native-admission.json"),
        sha256: "a".repeat(64),
      },
    });
    selected.setup = pin(selected.setup.path, bytes);
  }
  return {
    plan,
    enrollmentStateDirectory,
    account: { uid: process.getuid!(), home },
    writableMountRoots: [],
  };
}
test.each([
  "candidate",
  "previous",
  "new-boot",
  "wrong-pid",
  "parent",
  "uid",
  "argv",
  "executable",
  "birth-change",
  "boot-change",
  "service-change",
  "ambiguous-service",
] as const)("persistent startup native process proof: %s", async (mode) => {
  const f = await fixture();
  const selected = mode === "previous" ? "previous" : "candidate";
  const slot = f.plan[selected]!;
  const service = `${f.plan.identity.environment === "host" ? f.plan.identity.serviceDomain : ""}/${
    f.plan.identity.environment === "host" ? f.plan.identity.serviceLabel : ""
  }`;
  const process = {
    pid: 4312,
    parentPid: 1,
    uid: f.account.uid,
    bootId: randomUUID(),
    startIdentity: "1000:12",
    executable: slot.node.path,
    argumentsSha256: createHash("sha256")
      .update(JSON.stringify(maintenanceUserLauncher(f.plan, selected).ProgramArguments))
      .digest("hex"),
  };
  if (mode === "parent") process.parentPid = 42;
  if (mode === "uid") process.uid++;
  if (mode === "argv") process.argumentsSha256 = "f".repeat(64);
  if (mode === "executable") process.executable = "/tmp/unselected-node";
  let reads = 0;
  const result = verifyMaintenanceLauncherProcess({
    ...f,
    selected,
    pid: mode === "wrong-pid" ? 4313 : process.pid,
    reader: {
      readService: async () => {
        reads++;
        const pid = mode === "service-change" && reads > 1 ? 4313 : process.pid;
        return `${service} = {\n\tpid = ${pid}\n${
          mode === "ambiguous-service" ? "\tpid = 9999\n" : ""
        }}`;
      },
      inspectProcess: async () => ({
        ...process,
        ...(mode === "birth-change" && reads > 1 ? { startIdentity: "1001:1" } : {}),
        ...(mode === "boot-change" && reads > 1 ? { bootId: randomUUID() } : {}),
      }),
    },
  });
  if (["candidate", "previous", "new-boot"].includes(mode))
    await expect(result).resolves.toEqual(process);
  else await expect(result).rejects.toThrow();
});
test.each(["hardlink", "symlink", "oversized", "writable", "mount", "deadline"])(
  "streamed dependency refuses %s without relaxing custody",
  async (mode) => {
    const f = await fixture();
    const file = f.plan.candidate.node;
    if (mode === "hardlink") linkSync(file.path, `${file.path}.alias`);
    if (mode === "symlink") {
      const original = file.path;
      file.path = `${original}.alias`;
      symlinkSync(original, file.path);
    }
    if (mode === "oversized") truncateSync(file.path, 256 * 1024 * 1024 + 1);
    if (mode === "writable") chmodSync(file.path, 0o622);
    const mounts = mode === "mount" ? [f.plan.candidate.directory] : [];
    const clock =
      mode === "deadline"
        ? vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_000)
        : null;
    try {
      await expect(verifyBootstrapPreparedDependency(file, mounts)).rejects.toThrow();
    } finally {
      clock?.mockRestore();
    }
  },
);
test("native runtime dependencies exceed document size without relaxing setup bounds", async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  const candidate = f.plan.candidate;
  writeFileSync(candidate.node.path, bytes);
  candidate.node.sha256 = createHash("sha256").update(bytes).digest("hex");
  candidate.artifactSha256 = await digestBootstrapArtifact(candidate.directory);
  await expect(verifyMaintenanceLauncherArtifacts(f)).resolves.toMatchObject({ plan: f.plan });
  writeFileSync(candidate.node.path, Buffer.alloc(bytes.length, 8));
  await expect(verifyMaintenanceLauncherArtifacts(f)).rejects.toThrow("digest changed");
  writeFileSync(candidate.node.path, bytes);
  writeFileSync(candidate.setup.path, bytes);
  candidate.setup.sha256 = candidate.node.sha256;
  await expect(verifyMaintenanceLauncherArtifacts(f)).rejects.toThrow("bounded regular file");
});
test("both immutable slots retain the same login-only service identity", async () => {
  const f = await fixture();
  const verified = await verifyMaintenanceLauncherArtifacts(f);
  expect(verified.identitySha256).toMatch(/^[a-f0-9]{64}$/);
  const previous = maintenanceUserLauncher(f.plan, "previous");
  const candidate = maintenanceUserLauncher(f.plan, "candidate");
  expect(previous.Label).toBe(candidate.Label);
  expect(candidate.RunAtLoad).toBe(true);
  expect(candidate.KeepAlive).toBe(false);
  expect(candidate.ProgramArguments).toContain(f.plan.candidate.setup.path);
  expect(previous.ProgramArguments).toContain(f.plan.previous!.setup.path);
});
test.each(["owner", "launcher", "selection", "entrypoint", "same-slot", "unsupported-service"])(
  "rejects changed %s custody",
  async (mode) => {
    const f = await fixture();
    if (mode === "owner") f.account.uid++;
    if (mode === "unsupported-service" && f.plan.identity.environment === "host")
      f.plan.identity.serviceLabel = "local.vorteo.arbitrary";
    if (mode === "launcher")
      f.plan.identity.launcherPath = path.join(f.account.home, "other.plist");
    if (mode === "selection") f.plan.identity.selectionPath = "/tmp/arbitrary-selection.json";
    if (mode === "entrypoint") f.plan.candidate.entrypoint.path = "/tmp/arbitrary.js";
    if (mode === "same-slot") f.plan.previous = f.plan.candidate;
    expect(() => inspectMaintenanceLauncherPlan(f.plan, f.account)).toThrow();
  },
);
test.each(["candidate", "previous"] as const)(
  "rejects changed %s bytes before registration",
  async (slot) => {
    const f = await fixture();
    writeFileSync(f.plan[slot]!.entrypoint.path, "changed", { mode: 0o600 });
    await expect(verifyMaintenanceLauncherArtifacts(f)).rejects.toThrow();
  },
);

test.each([
  "valid",
  "separate-storage",
  "separate-lock",
  "changed-custody",
  "async-custody",
  "missing-custody",
  "revoked",
  "generation",
  "artifact",
  "lock",
  "installation",
] as const)("launcher effect reservation is exact and nonreplayable: %s", async (mode) => {
  const f = await fixture(mode === "separate-storage" || mode === "separate-lock");
  const {
    FileEnrollmentJournal,
    enrollInstallation,
    enrollmentManifestDigest,
    reserveActivationStep,
    changeStandingGrant,
  } = await import("./maintenance/authorization.js");
  const { reserveMaintenanceLauncherEffect } =
    await import("./coordinator-bootstrap-maintenance-launcher-state.js");
  const { FileBootstrapRequestJournal } = await import("./coordinator-bootstrap-journal.js");
  const inspected = inspectMaintenanceLauncherPlan(f.plan, f.account);
  const artifact = (slot: MaintenanceLauncherPlan["candidate"]) => ({
    sourceCommit: slot.sourceCommit,
    artifactSha256: slot.artifactSha256,
  });
  const manifest = {
    version: 1 as const,
    operation: "installation-enrollment" as const,
    installationId: f.plan.identity.installationId,
    revision: randomUUID(),
    createdAt: new Date().toISOString(),
    trustedRepositories: ["https://example.test/fixture"],
    provisioning: null,
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 5 },
    retryLimit: 3 as const,
    rollback: "previous-compatible-runtime" as const,
    recovery: "after-login" as const,
    targets: [
      {
        target: "recovery-launcher" as const,
        identitySha256: inspected.identitySha256,
        operations: ["replacement" as const],
      },
      {
        target: "maintenance-controller" as const,
        identitySha256: "a".repeat(64),
        operations: ["replacement" as const],
      },
      {
        target: "coordinator" as const,
        identitySha256: "b".repeat(64),
        operations: ["replacement" as const],
      },
    ],
    steps: [
      {
        id: randomUUID(),
        target: "recovery-launcher" as const,
        operation: "replacement" as const,
        planSha256: inspected.planSha256,
        candidate: artifact(f.plan.candidate),
        previous: artifact(f.plan.previous!),
        dependsOn: [],
      },
    ],
  };
  if (mode === "installation") manifest.installationId = randomUUID();
  const journal = new FileEnrollmentJournal(f.enrollmentStateDirectory);
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
  if (enrolled.status !== "enrolled") throw new Error("Fixture enrollment absent");
  const reserved = reserveActivationStep(journal, {
    grantRevision: enrolled.grant.revision,
    stepId: manifest.steps[0].id,
  });
  if (reserved.status !== "enrolled" || reserved.activation.steps[0].status !== "reserved")
    throw new Error("Fixture reservation absent");
  const input = {
    ...f,
    grantId: enrolled.grant.id,
    grantRevision: enrolled.grant.revision,
    stepId: manifest.steps[0].id,
    generation: reserved.activation.steps[0].generation,
    assertCurrent: () => {
      // Native custody must be checked inside the same lock as the reservation.
      expect(() =>
        new FileBootstrapRequestJournal(f.enrollmentStateDirectory).withRecoveryTransaction(
          () => undefined,
        ),
      ).toThrow("storage is busy");
      if (mode === "changed-custody") throw new Error("Native selection changed");
      if (mode === "async-custody") return Promise.resolve();
    },
  };
  if (mode === "missing-custody") Object.assign(input, { assertCurrent: undefined });
  if (mode === "revoked")
    changeStandingGrant(journal, {
      expectedRevision: enrolled.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
  if (mode === "generation") input.generation = randomUUID();
  if (mode === "artifact") input.plan.candidate.artifactSha256 = "c".repeat(64);
  if (mode === "lock" || mode === "separate-lock") {
    new FileBootstrapRequestJournal(f.enrollmentStateDirectory).withRecoveryTransaction(() => {
      expect(() => reserveMaintenanceLauncherEffect(input)).toThrow("storage is busy");
    });
    return;
  }
  if (mode !== "valid" && mode !== "separate-storage") {
    expect(() => reserveMaintenanceLauncherEffect(input)).toThrow();
    expect(journal.read()).toEqual(mode === "revoked" ? journal.read() : reserved);
    const { existsSync } = await import("node:fs");
    expect(
      existsSync(
        path.join(
          f.enrollmentStateDirectory,
          `maintenance-launcher-${input.stepId}-${input.generation}.json`,
        ),
      ),
    ).toBe(false);
    return;
  }
  const { InstallationRestarts } = await import("./restarts.js");
  const bootstrap = new FileBootstrapRequestJournal(f.enrollmentStateDirectory);
  const effects: string[] = [];
  const queue = new InstallationRestarts(
    {
      read: () => bootstrap.readLifecycle(),
      write: (jobs) => bootstrap.writeLifecycle(jobs),
      admissionAvailable: () => bootstrap.lifecycleAdmissionAvailable(),
    },
    {
      restart: async () => {
        effects.push("restart");
        return "ready";
      },
    },
  );
  expect(bootstrap.lifecycleAdmissionAvailable()).toBe(false);
  const pending = queue.request({ target: "host", reason: "Competing fixture restart" }, "owner");
  expect(() => queue.decide(pending.id, pending.revision, "approve")).toThrow(
    /recovery must finish|activation must be reconciled/,
  );
  await queue.drain();
  expect(effects).toEqual([]);
  expect(queue.list()[0]?.status).toBe("pending");
  const enrollmentFile = path.join(f.enrollmentStateDirectory, "maintenance-enrollment.json");
  const retainedEnrollment = readFileSync(enrollmentFile);
  writeFileSync(enrollmentFile, "broken", { mode: 0o600 });
  expect(() => bootstrap.lifecycleAdmissionAvailable()).toThrow();
  queue.decide(pending.id, pending.revision, "reject");
  writeFileSync(enrollmentFile, retainedEnrollment, { mode: 0o600 });
  expect(queue.list()[0]?.status).toBe("rejected");
  const review = { id: randomUUID(), revision: manifest.revision, manifest };
  expect(() => verifyPersistentMaintenanceReview(f.enrollmentStateDirectory, review)).not.toThrow();
  expect(() => verifyPersistentMaintenanceReview(f.enrollmentStateDirectory, undefined)).toThrow(
    "retained enrollment",
  );
  expect(() =>
    verifyPersistentMaintenanceReview(f.enrollmentStateDirectory, {
      ...review,
      manifest: { ...manifest, revision: randomUUID() },
    }),
  ).toThrow("retained enrollment");
  const receipt = reserveMaintenanceLauncherEffect(input);
  expect(receipt.intent.generation).toBe(input.generation);
  const startup = {
    plan: f.plan,
    account: f.account,
    enrollment: journal.read(),
    intent: receipt.intent,
    selection: {
      version: 1,
      intentId: receipt.intent.id,
      stepId: receipt.intent.stepId,
      generation: input.generation,
      planSha256: inspected.planSha256,
      slot: "candidate",
    },
  };
  expect(inspectMaintenanceLauncherSelection(startup).selected).toEqual(f.plan.candidate);
  // Disposable synthetic identity only. This tests protected loading, not
  // native service registration or permission to register a real launcher.
  retainEnrollmentNativeIdentity(f.enrollmentStateDirectory, f.plan.identity);
  const plans = path.join(path.dirname(f.plan.identity.selectionPath!), "plans");
  mkdirSync(plans, { mode: 0o700 });
  writeFileSync(path.join(plans, `${inspected.planSha256}.json`), JSON.stringify(f.plan), {
    mode: 0o600,
  });
  writeFileSync(f.plan.identity.selectionPath!, JSON.stringify(startup.selection), {
    mode: 0o600,
  });
  await expect(
    readMaintenanceLauncherStartup({
      setupFile: f.plan.candidate.setup.path,
      account: f.account,
    }),
  ).resolves.toMatchObject({ selected: f.plan.candidate });
  await expect(
    readMaintenanceLauncherStartup({
      setupFile: f.plan.previous!.setup.path,
      account: f.account,
    }),
  ).rejects.toThrow("selected reviewed slot");
  expect(
    inspectMaintenanceLauncherSelection({
      ...startup,
      selection: { ...startup.selection, slot: "previous" },
    }).selected,
  ).toEqual(f.plan.previous);
  for (const field of ["intentId", "generation", "planSha256"] as const) {
    expect(() =>
      inspectMaintenanceLauncherSelection({
        ...startup,
        selection: {
          ...startup.selection,
          [field]: field === "planSha256" ? "0".repeat(64) : randomUUID(),
        },
      }),
    ).toThrow();
  }
  expect(() =>
    inspectMaintenanceLauncherSelection({
      ...startup,
      intent: { ...receipt.intent, grantId: randomUUID() },
    }),
  ).toThrow();
  expect(() =>
    inspectMaintenanceLauncherSelection({
      ...startup,
      intent: { ...receipt.intent, grantRevision: randomUUID() },
    }),
  ).toThrow();
  expect(() =>
    inspectMaintenanceLauncherSelection({
      ...startup,
      enrollment: enrolled,
    }),
  ).toThrow();
  expect(() => reserveMaintenanceLauncherEffect(input)).toThrow();
  expect(journal.read()).toEqual(reserved);
  changeStandingGrant(journal, {
    expectedRevision: enrolled.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  // Reading the already selected slot remains possible after revocation. The
  // dispatch reservation above is separate and must continue to reject replay.
  expect(
    inspectMaintenanceLauncherSelection({
      ...startup,
      enrollment: journal.read(),
    }).selected,
  ).toEqual(f.plan.candidate);
  expect(bootstrap.lifecycleAdmissionAvailable()).toBe(false);
  const { observeActivationStep } = await import("./maintenance/authorization.js");
  observeActivationStep(journal, {
    stepId: input.stepId,
    generation: input.generation,
    outcome: "succeeded",
    observationSha256: "f".repeat(64),
  });
  expect(bootstrap.lifecycleAdmissionAvailable()).toBe(true);
});

test.each(["complete", "partial", "custody", "symlink", "hardlink", "missing"] as const)(
  "launcher file publication retains a nonreplayable attempt: %s",
  async (mode) => {
    const { selectMaintenanceFiles } =
      await import("./coordinator-bootstrap-maintenance-file-selection.js");
    const { existsSync, unlinkSync } = await import("node:fs");
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "maintenance-publication-")));
    roots.push(root);
    const launcher = path.join(root, "launcher.plist");
    const selection = path.join(root, "selection.json");
    const attemptFile = path.join(root, "attempt.json");
    const old = Buffer.from("retained old bytes");
    const next = Buffer.from("reviewed candidate bytes");
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    writeFileSync(launcher, old, { mode: 0o600 });
    writeFileSync(selection, old, { mode: 0o600 });
    if (mode === "symlink") {
      unlinkSync(selection);
      symlinkSync(launcher, selection);
    }
    if (mode === "hardlink") {
      unlinkSync(selection);
      linkSync(launcher, selection);
    }
    if (mode === "missing") {
      unlinkSync(launcher);
      unlinkSync(selection);
    }
    const input = {
      attemptFile,
      reservationSha256: "a".repeat(64),
      launcher: {
        path: launcher,
        previousSha256: mode === "missing" ? null : sha(old),
        bytes: next,
      },
      selection: {
        path: selection,
        previousSha256: mode === "missing" ? null : sha(old),
        bytes: next,
      },
      assertCurrent: () => {
        if (mode === "custody") throw new Error("Native process changed");
        // A write arriving after the initial read must not be overwritten.
        if (mode === "partial") writeFileSync(selection, "concurrent change");
      },
    };
    if (["custody", "symlink", "hardlink"].includes(mode)) {
      expect(() => selectMaintenanceFiles(input)).toThrow();
      expect(existsSync(attemptFile)).toBe(false);
      expect(readFileSync(launcher)).toEqual(old);
      return;
    }
    if (mode === "partial") {
      expect(() => selectMaintenanceFiles(input)).toThrow("changed before publication");
      expect(readFileSync(launcher)).toEqual(next);
      expect(readFileSync(selection, "utf8")).toBe("concurrent change");
    } else {
      selectMaintenanceFiles(input);
      expect(readFileSync(launcher)).toEqual(next);
      expect(readFileSync(selection)).toEqual(next);
    }
    const retained = readFileSync(attemptFile);
    expect(JSON.parse(retained.toString()).reservationSha256).toBe(input.reservationSha256);
    // Even restoring every original byte cannot make this effect replayable.
    writeFileSync(launcher, old);
    writeFileSync(selection, old);
    expect(() =>
      selectMaintenanceFiles({
        ...input,
        launcher: { ...input.launcher, previousSha256: sha(old) },
        selection: { ...input.selection, previousSha256: sha(old) },
        assertCurrent: () => undefined,
      }),
    ).toThrow();
    expect(readFileSync(attemptFile)).toEqual(retained);
    expect(readFileSync(launcher)).toEqual(old);
  },
);

test.each([
  "valid",
  "request",
  "identity",
  "approved-revision",
  "plan",
  "source",
  "previous",
  "grant",
  "manifest",
  "native-evidence",
  "proposal",
  "interval",
  "future",
  "not-running",
  "consumed",
  "recovery",
  "recover-absent",
  "recover-rollback",
  "recover-lost-start",
  "recover-observe-lost-start",
  "recover-observe-runtime",
  "recover-observe-rollback",
  "recover-observe-unready",
  "recover-observe-timeout",
  "recover-observe-late",
  "recover-wrong-observation",
  "recover-unready-execution",
  "native-success",
  "native-unclaimed",
  "native-unclaimed-race",
  "native-unclaimed-candidate",
  "native-runtime-readiness",
  "native-grant-revoked",
  "native-stop-failure",
  "native-start-failure",
  "native-bad-health",
  "native-custody-changed",
  "native-observation-timeout",
] as const)("native service independently binds retained reservation: %s", async (mode) => {
  const f = await fixture(false, mode.startsWith("native-"));
  const { MaintenanceServiceJobSchema } = await import("@getpaseo/protocol/maintenance-service");
  const { inspectMaintenanceServiceExecution } =
    await import("./coordinator-bootstrap-maintenance-service-binding.js");
  const native = inspectMaintenanceLauncherPlan(f.plan, f.account);
  const id = randomUUID();
  const approvedRevision = randomUUID();
  const proposal = {
    id,
    installationId: f.plan.identity.installationId,
    requestedBy: "host-agent",
    target: f.plan.identity.target,
    identitySha256: native.identitySha256,
    operation: "replacement",
    planSha256: native.planSha256,
    repository: "https://example.test/fixture",
    sourceCommit: f.plan.candidate.sourceCommit,
    artifactSha256: f.plan.candidate.artifactSha256,
    previous: {
      sourceCommit: f.plan.previous!.sourceCommit,
      artifactSha256: f.plan.previous!.artifactSha256,
    },
  };
  const proposalSha256 = createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
  const {
    FileEnrollmentJournal,
    enrollInstallation,
    enrollmentManifestDigest,
    changeStandingGrant,
  } = await import("./maintenance/authorization.js");
  const manifest = {
    version: 1 as const,
    operation: "installation-enrollment" as const,
    installationId: f.plan.identity.installationId,
    revision: randomUUID(),
    createdAt: new Date(Date.now() - 240_000).toISOString(),
    trustedRepositories: [proposal.repository],
    provisioning: null,
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 5 },
    retryLimit: 3 as const,
    rollback: "previous-compatible-runtime" as const,
    recovery: "after-login" as const,
    targets: (["recovery-launcher", "maintenance-controller", "coordinator"] as const).map(
      (target) => ({
        target,
        identitySha256: target === proposal.target ? native.identitySha256 : "a".repeat(64),
        operations:
          mode === "valid" || mode.startsWith("recover-")
            ? ["replacement" as const, "recovery" as const, "rollback" as const]
            : ["replacement" as const],
      }),
    ),
    steps: [
      {
        id: randomUUID(),
        target: proposal.target,
        operation: "replacement" as const,
        planSha256: native.planSha256,
        candidate: { sourceCommit: proposal.sourceCommit, artifactSha256: proposal.artifactSha256 },
        previous: proposal.previous,
        dependsOn: [],
      },
    ],
  };
  if (
    [
      "native-success",
      "native-unclaimed",
      "native-unclaimed-race",
      "native-unclaimed-candidate",
      "native-runtime-readiness",
      "native-grant-revoked",
      "native-stop-failure",
      "native-start-failure",
      "native-bad-health",
      "native-custody-changed",
      "native-observation-timeout",
    ].includes(mode)
  ) {
    const initialPlan = { ...f.plan, previous: null, candidate: f.plan.previous! };
    manifest.steps[0] = {
      ...manifest.steps[0]!,
      planSha256: inspectMaintenanceLauncherPlan(initialPlan, f.account).planSha256,
      candidate: {
        sourceCommit: initialPlan.candidate.sourceCommit,
        artifactSha256: initialPlan.candidate.artifactSha256,
      },
      previous: null,
    };
  }
  const enrollmentJournal = new FileEnrollmentJournal(f.enrollmentStateDirectory);
  const enrolled = enrollInstallation(enrollmentJournal, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: new Date(Date.now() - 180_000).toISOString(),
    },
  });
  if (enrolled.status !== "enrolled") throw new Error("Fixture enrollment absent");
  const binding = {
    grantId: enrolled.grant.id,
    grantRevision: enrolled.grant.revision,
    manifestSha256: enrollmentManifestDigest(manifest),
    proposalSha256,
    requestRevision: approvedRevision,
    nativeEvidenceSha256: "d".repeat(64),
  };
  const reservation = {
    ...binding,
    requestId: id,
    generation: randomUUID(),
    target: proposal.target,
    operation: proposal.operation,
    planSha256: native.planSha256,
    identitySha256: native.identitySha256,
    sourceCommit: proposal.sourceCommit,
    artifactSha256: proposal.artifactSha256,
    previous: proposal.previous,
    reservedAt: new Date(Date.now() - 1000).toISOString(),
  };
  const job = MaintenanceServiceJobSchema.parse({
    id,
    revision: randomUUID(),
    target: proposal.target,
    operation: proposal.operation,
    proposal,
    reason: "Native fixture",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    status: "running",
    detail: "Reserved",
    evidence: [],
    reservation,
    approval: {
      ...binding,
      reviewedRevision: randomUUID(),
      approvedAt: new Date(Date.now() - 90_000).toISOString(),
      dispatchAfter: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  const mutations: Record<string, () => void> = {
    request: () => {
      job.proposal.id = randomUUID();
    },
    identity: () => {
      job.proposal.identitySha256 = "e".repeat(64);
    },
    "approved-revision": () => {
      job.approval!.requestRevision = randomUUID();
    },
    plan: () => {
      job.proposal.planSha256 = "e".repeat(64);
    },
    source: () => {
      job.proposal.sourceCommit = "e".repeat(40);
    },
    previous: () => {
      job.proposal.previous = null;
    },
    grant: () => {
      job.approval!.grantRevision = randomUUID();
    },
    manifest: () => {
      job.approval!.manifestSha256 = "e".repeat(64);
    },
    "native-evidence": () => {
      job.approval!.nativeEvidenceSha256 = "e".repeat(64);
    },
    proposal: () => {
      job.approval!.proposalSha256 = "e".repeat(64);
    },
    interval: () => {
      job.approval!.dispatchAfter = job.approval!.approvedAt;
    },
  };
  mutations[mode]?.();
  if (mode === "future") {
    reservation.reservedAt = new Date(Date.now() + 60_000).toISOString();
    job.reservation!.reservedAt = reservation.reservedAt;
  }
  if (mode === "not-running") job.status = "approved";
  if (mode === "consumed")
    job.effectIntent = {
      id: randomUUID(),
      generation: reservation.generation,
      requestRevision: approvedRevision,
      nativeEvidenceSha256: "d".repeat(64),
      consumedAt: new Date().toISOString(),
      executor: {
        pid: 10,
        parentPid: 1,
        uid: process.getuid!(),
        bootId: randomUUID(),
        startIdentity: "100:1",
        argumentsSha256: "f".repeat(64),
        executable: "/fixture/node",
      },
    };
  if (mode === "recovery") job.operation = "recovery";
  const inspect = () =>
    inspectMaintenanceServiceExecution({
      retained: job,
      reservation,
      plan: f.plan,
      account: f.account,
    });
  const nativeCase = mode.startsWith("native-") && mode !== "native-evidence";
  if (mode !== "valid" && !mode.startsWith("recover-") && !nativeCase) {
    expect(inspect).toThrow();
    return;
  }
  expect(inspect().reservation.requestRevision).toBe(approvedRevision);
  const { inspectMaintenanceServiceInvocation } =
    await import("./coordinator-bootstrap-maintenance-service-runner.js");
  const invocation = [job.id, approvedRevision, reservation.generation, native.planSha256];
  const invoke = (args: string[]) =>
    inspectMaintenanceServiceInvocation(args, {
      retained: job,
      reservation,
      plan: f.plan,
      account: f.account,
    });
  expect(invoke(invocation).job.revision).toBe(job.revision);
  for (const args of [
    [job.id, job.revision, reservation.generation, native.planSha256],
    [randomUUID(), ...invocation.slice(1)],
    [job.id, approvedRevision, randomUUID(), native.planSha256],
    [job.id, approvedRevision, reservation.generation, "0".repeat(64)],
    invocation.slice(0, 3),
    [...invocation, "unexpected"],
    ["../another-request", ...invocation.slice(1)],
  ])
    expect(() => invoke(args)).toThrow();
  // Later journal revisions do not silently replace the approved revision.
  expect(job.revision).not.toBe(approvedRevision);
  const { claimMaintenanceServiceEffect } =
    await import("./coordinator-bootstrap-maintenance-service-claim.js");
  const { FileBootstrapRequestJournal } = await import("./coordinator-bootstrap-journal.js");
  const { MaintenanceServiceEvidenceRecordSchema } =
    await import("@getpaseo/protocol/maintenance-service");
  const journal = new FileBootstrapRequestJournal(f.enrollmentStateDirectory);
  journal.writeLifecycle([job]);
  const bootId = randomUUID();
  const executor = {
    pid: process.pid,
    parentPid: process.ppid,
    uid: process.getuid!(),
    bootId,
    startIdentity: "100:1",
    argumentsSha256: "f".repeat(64),
    executable: "/fixture/node",
  };
  const record = MaintenanceServiceEvidenceRecordSchema.parse({
    requestId: job.id,
    requestRevision: job.revision,
    planSha256: native.planSha256,
    identitySha256: native.identitySha256,
    sourceCommit: proposal.sourceCommit,
    artifactSha256: proposal.artifactSha256,
    observedAt: new Date().toISOString(),
    native: {
      bootId,
      process: null,
      service: {
        domain: `gui/${process.getuid!()}`,
        label: "local.vorteo.fixture.installation",
        registered: false,
        launcherPath: f.plan.identity.launcherPath,
        launcherSha256: null,
        registrationSha256: null,
      },
      selection: {
        path: f.plan.identity.selectionPath,
        receiptSha256: null,
        sourceCommit: null,
        artifactSha256: null,
      },
    },
  });
  let rejectAdmission = true;
  const evidence = {
    ...record,
    evidenceSha256: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
    assertCurrent: () => {
      expect(() =>
        journal.mutateLifecycle(
          () => [],
          () => undefined,
        ),
      ).toThrow("storage is busy");
    },
  };
  const claimInput = {
    stateDirectory: f.enrollmentStateDirectory,
    requestId: job.id,
    expectedRevision: job.revision,
    reservation: job.reservation!,
    plan: f.plan,
    account: f.account,
    executor,
    evidence,
    admission: () => {
      if (rejectAdmission) throw new Error("Grant revoked before effect");
    },
  };
  if (nativeCase) {
    rejectAdmission = false;
    await exerciseNativeReplacement(f, claimInput, mode);
    return;
  }
  expect(() => claimMaintenanceServiceEffect(claimInput)).toThrow("Grant revoked before effect");
  expect(journal.readLifecycle()).toEqual([job]);
  rejectAdmission = false;
  expect(() =>
    claimMaintenanceServiceEffect({ ...claimInput, expectedRevision: randomUUID() }),
  ).toThrow("revision changed");
  expect(() =>
    claimMaintenanceServiceEffect({
      ...claimInput,
      evidence: { ...evidence, evidenceSha256: "e".repeat(64) },
    }),
  ).toThrow("native admission");
  const claimed = claimMaintenanceServiceEffect(claimInput);
  expect(claimed.effectIntent?.generation).toBe(reservation.generation);
  expect(claimed.effectIntent?.requestRevision).toBe(approvedRevision);
  expect(claimed.revision).not.toBe(job.revision);
  expect(new FileBootstrapRequestJournal(f.enrollmentStateDirectory).readLifecycle()).toEqual([
    claimed,
  ]);
  expect(() => claimMaintenanceServiceEffect(claimInput)).toThrow("revision changed");
  expect(() =>
    claimMaintenanceServiceEffect({ ...claimInput, expectedRevision: claimed.revision }),
  ).toThrow("unconsumed");
  expect(journal.readLifecycle()).toEqual([claimed]);
  const { inspectRetainedMaintenanceServiceEffect } =
    await import("./coordinator-bootstrap-maintenance-service-binding.js");
  const observe = (retained: unknown) =>
    inspectRetainedMaintenanceServiceEffect({
      retained,
      plan: f.plan,
      account: f.account,
    });
  expect(observe(claimed).intent.id).toBe(claimed.effectIntent!.id);
  const { verifyMaintenanceRecoveryPredecessor } =
    await import("./coordinator-bootstrap-maintenance-recovery-proof.js");
  const failedRecord = {
    ...claimed.evidence[0]!.record,
    requestRevision: reservation.requestRevision,
    observedAt: new Date(Date.parse(claimed.effectIntent!.consumedAt) + 1).toISOString(),
  };
  const failedSha = createHash("sha256").update(JSON.stringify(failedRecord)).digest("hex");
  const failed = MaintenanceServiceJobSchema.parse({
    ...claimed,
    status: "failed",
    observation: {
      requestId: claimed.id,
      requestRevision: reservation.requestRevision,
      generation: reservation.generation,
      planSha256: native.planSha256,
      identitySha256: native.identitySha256,
      outcome: "candidate",
      sourceCommit: failedRecord.sourceCommit,
      artifactSha256: failedRecord.artifactSha256,
      ready: false,
      evidenceSha256: failedSha,
      observedAt: failedRecord.observedAt,
    },
    evidence: [...claimed.evidence, { sha256: failedSha, record: failedRecord }],
  });
  const recoveryInput = {
    retained: failed,
    plan: f.plan,
    account: f.account,
    recoveryOf: {
      requestId: claimed.id,
      generation: reservation.generation,
      planSha256: native.planSha256,
      observationSha256: failedSha,
    },
    reader: { verifyProcessExited: vi.fn(async () => undefined) },
  };
  expect((await verifyMaintenanceRecoveryPredecessor(recoveryInput)).intent.id).toBe(
    claimed.effectIntent!.id,
  );
  expect(
    (
      await verifyMaintenanceRecoveryPredecessor({
        ...recoveryInput,
        retained: { ...failed, status: "running" },
      })
    ).intent.id,
  ).toBe(claimed.effectIntent!.id);
  const { inspectMaintenanceRecoveryPlan } =
    await import("./coordinator-bootstrap-maintenance-recovery-plan.js");
  const recoveryPlan = {
    version: 2,
    operation: "maintenance-service-recovery",
    recoveryOf: recoveryInput.recoveryOf,
    originalPlanSha256: native.planSha256,
    original: f.plan,
  };
  expect(inspectMaintenanceRecoveryPlan(recoveryPlan, f.account).selected).toEqual(
    f.plan.candidate,
  );
  expect(
    inspectMaintenanceRecoveryPlan(
      { ...recoveryPlan, operation: "maintenance-service-rollback" },
      f.account,
    ).selected,
  ).toEqual(f.plan.previous);
  expect(() =>
    inspectMaintenanceRecoveryPlan(
      {
        ...recoveryPlan,
        original: {
          ...f.plan,
          candidate: { ...f.plan.candidate, artifactSha256: "e".repeat(64) },
        },
      },
      f.account,
    ),
  ).toThrow("original reviewed slots");
  const { inspectMaintenanceRecoveryPredecessorPlan } =
    await import("./coordinator-bootstrap-maintenance-recovery-plan.js");
  const firstRecovery = inspectMaintenanceRecoveryPlan(recoveryPlan, f.account);
  expect(
    inspectMaintenanceRecoveryPredecessorPlan(firstRecovery, f.plan, f.account).planSha256,
  ).toBe(native.planSha256);
  const secondPlan = {
    ...recoveryPlan,
    recoveryOf: {
      ...recoveryPlan.recoveryOf,
      requestId: randomUUID(),
      generation: randomUUID(),
      planSha256: firstRecovery.planSha256,
    },
  };
  const secondRecovery = inspectMaintenanceRecoveryPlan(secondPlan, f.account);
  expect(
    inspectMaintenanceRecoveryPredecessorPlan(secondRecovery, recoveryPlan, f.account).planSha256,
  ).toBe(firstRecovery.planSha256);
  expect(() =>
    inspectMaintenanceRecoveryPredecessorPlan(secondRecovery, f.plan, f.account),
  ).toThrow("immediate predecessor");
  const thirdRecovery = inspectMaintenanceRecoveryPlan(
    {
      ...recoveryPlan,
      recoveryOf: { ...secondPlan.recoveryOf, planSha256: secondRecovery.planSha256 },
    },
    f.account,
  );
  expect(
    inspectMaintenanceRecoveryPredecessorPlan(thirdRecovery, secondPlan, f.account).planSha256,
  ).toBe(secondRecovery.planSha256);
  const { inspectMaintenanceRecoveryExecution } =
    await import("./coordinator-bootstrap-maintenance-recovery-binding.js");
  const recoveryContext = inspectMaintenanceRecoveryPlan(recoveryPlan, f.account);
  const recoveryId = randomUUID();
  const recoveryRevision = randomUUID();
  const recoveryProposal = {
    ...job.proposal,
    id: recoveryId,
    operation: "recovery",
    planSha256: recoveryContext.planSha256,
    recoveryOf: recoveryPlan.recoveryOf,
  };
  const proposalDigest = createHash("sha256")
    .update(JSON.stringify(recoveryProposal))
    .digest("hex");
  const recoveryReservation = {
    ...reservation,
    requestId: recoveryId,
    requestRevision: recoveryRevision,
    generation: randomUUID(),
    operation: "recovery",
    planSha256: recoveryContext.planSha256,
    proposalSha256: proposalDigest,
    recoveryOf: recoveryPlan.recoveryOf,
  };
  const recoveryJob = MaintenanceServiceJobSchema.parse({
    ...job,
    id: recoveryId,
    operation: "recovery",
    proposal: recoveryProposal,
    approval: {
      ...job.approval,
      requestRevision: recoveryRevision,
      proposalSha256: proposalDigest,
    },
    reservation: recoveryReservation,
  });
  if (mode.startsWith("recover-")) {
    const { exerciseAbsentRecovery } =
      await import("./coordinator-bootstrap-maintenance-recovery-native.fixture.js");
    await exerciseAbsentRecovery({
      f,
      mode,
      failed,
      job: recoveryJob,
      plan: recoveryPlan,
      claimInput,
    });
    return;
  }
  // Claiming recovery uses the same atomic journal transition, preserving the
  // failed predecessor. The callback still owns grant and global exclusion.
  const recoveryEvidenceRecord = {
    ...record,
    requestId: recoveryJob.id,
    requestRevision: recoveryJob.revision,
    planSha256: recoveryContext.planSha256,
    observedAt: new Date().toISOString(),
  };
  const recoveryEvidence = {
    ...recoveryEvidenceRecord,
    evidenceSha256: createHash("sha256")
      .update(JSON.stringify(recoveryEvidenceRecord))
      .digest("hex"),
    assertCurrent: evidence.assertCurrent,
  };
  journal.writeLifecycle([failed, recoveryJob]);
  const recoveryClaimInput = {
    ...claimInput,
    requestId: recoveryJob.id,
    expectedRevision: recoveryJob.revision,
    reservation: recoveryJob.reservation!,
    plan: recoveryPlan,
    evidence: recoveryEvidence,
  };
  rejectAdmission = true;
  expect(() => claimMaintenanceServiceEffect(recoveryClaimInput)).toThrow("Grant revoked");
  expect(journal.readLifecycle()).toEqual([failed, recoveryJob]);
  rejectAdmission = false;
  const recoveryClaimed = claimMaintenanceServiceEffect(recoveryClaimInput);
  expect(recoveryClaimed.effectIntent?.generation).toBe(recoveryReservation.generation);
  expect(journal.readLifecycle()[0]).toEqual(failed);
  expect(() =>
    claimMaintenanceServiceEffect({
      ...recoveryClaimInput,
      expectedRevision: recoveryClaimed.revision,
    }),
  ).toThrow("fresh unconsumed");
  const rollbackPlan = { ...recoveryPlan, operation: "maintenance-service-rollback" };
  const rollbackContext = inspectMaintenanceRecoveryPlan(rollbackPlan, f.account);
  const rollbackProposal = {
    ...recoveryProposal,
    operation: "rollback",
    planSha256: rollbackContext.planSha256,
    sourceCommit: rollbackContext.selected.sourceCommit,
    artifactSha256: rollbackContext.selected.artifactSha256,
    previous: {
      sourceCommit: f.plan.candidate.sourceCommit,
      artifactSha256: f.plan.candidate.artifactSha256,
    },
  };
  const rollbackProposalSha = createHash("sha256")
    .update(JSON.stringify(rollbackProposal))
    .digest("hex");
  const rollbackJob = MaintenanceServiceJobSchema.parse({
    ...recoveryJob,
    operation: "rollback",
    proposal: rollbackProposal,
    approval: { ...recoveryJob.approval, proposalSha256: rollbackProposalSha },
    reservation: {
      ...recoveryReservation,
      operation: "rollback",
      planSha256: rollbackContext.planSha256,
      proposalSha256: rollbackProposalSha,
      sourceCommit: rollbackProposal.sourceCommit,
      artifactSha256: rollbackProposal.artifactSha256,
      previous: rollbackProposal.previous,
    },
  });
  journal.writeLifecycle([failed, rollbackJob]);
  const rollbackRecord = {
    ...recoveryEvidenceRecord,
    planSha256: rollbackContext.planSha256,
    sourceCommit: rollbackProposal.sourceCommit,
    artifactSha256: rollbackProposal.artifactSha256,
  };
  const rollbackInput = {
    ...recoveryClaimInput,
    reservation: rollbackJob.reservation!,
    plan: rollbackPlan,
    evidence: {
      ...rollbackRecord,
      evidenceSha256: createHash("sha256").update(JSON.stringify(rollbackRecord)).digest("hex"),
      assertCurrent: evidence.assertCurrent,
    },
  };
  const substituted = { ...rollbackRecord, sourceCommit: f.plan.candidate.sourceCommit };
  expect(() =>
    claimMaintenanceServiceEffect({
      ...rollbackInput,
      evidence: {
        ...substituted,
        evidenceSha256: createHash("sha256").update(JSON.stringify(substituted)).digest("hex"),
        assertCurrent: evidence.assertCurrent,
      },
    }),
  ).toThrow("native evidence changed");
  expect(journal.readLifecycle()).toEqual([failed, rollbackJob]);
  const rollbackClaimed = claimMaintenanceServiceEffect(rollbackInput);
  expect(rollbackClaimed.operation).toBe("rollback");
  expect(rollbackClaimed.effectIntent?.generation).toBe(rollbackJob.reservation!.generation);
  expect(journal.readLifecycle()[0]).toEqual(failed);
  journal.writeLifecycle([claimed]);
  const { inspectNativeMaintenanceRecoveryHistory } =
    await import("./coordinator-bootstrap-maintenance-recovery-history.js");
  const consumedAt = new Date().toISOString();
  const recoveryClaimRecord = {
    ...failedRecord,
    requestId: recoveryId,
    requestRevision: recoveryRevision,
    planSha256: recoveryContext.planSha256,
    observedAt: consumedAt,
  };
  const recoveryClaimSha = createHash("sha256")
    .update(JSON.stringify(recoveryClaimRecord))
    .digest("hex");
  const recoveryObservedRecord = {
    ...recoveryClaimRecord,
    observedAt: new Date(Date.parse(consumedAt) + 1).toISOString(),
  };
  const recoveryObservedSha = createHash("sha256")
    .update(JSON.stringify(recoveryObservedRecord))
    .digest("hex");
  const uncertainRecovery = MaintenanceServiceJobSchema.parse({
    ...recoveryJob,
    effectIntent: {
      ...claimed.effectIntent,
      id: randomUUID(),
      generation: recoveryReservation.generation,
      requestRevision: recoveryRevision,
      nativeEvidenceSha256: recoveryClaimSha,
      consumedAt,
      executor: { ...claimed.effectIntent!.executor, pid: claimed.effectIntent!.executor.pid + 1 },
    },
    observation: {
      ...failed.observation,
      requestId: recoveryId,
      requestRevision: recoveryRevision,
      generation: recoveryReservation.generation,
      planSha256: recoveryContext.planSha256,
      evidenceSha256: recoveryObservedSha,
      observedAt: recoveryObservedRecord.observedAt,
    },
    evidence: [
      { sha256: recoveryClaimSha, record: recoveryClaimRecord },
      { sha256: recoveryObservedSha, record: recoveryObservedRecord },
    ],
  });
  const historyPlan = {
    ...recoveryPlan,
    recoveryOf: {
      requestId: recoveryId,
      generation: recoveryReservation.generation,
      planSha256: recoveryContext.planSha256,
      observationSha256: recoveryObservedSha,
    },
  };
  const historyPlans = path.join(path.dirname(f.plan.identity.selectionPath!), "plans");
  mkdirSync(historyPlans, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(historyPlans, native.planSha256 + ".json"), JSON.stringify(f.plan), {
    mode: 0o600,
  });
  writeFileSync(
    path.join(historyPlans, recoveryContext.planSha256 + ".json"),
    JSON.stringify(recoveryPlan),
    { mode: 0o600 },
  );
  const historyFile = path.join(f.enrollmentStateDirectory, "restart-jobs.json");
  const historyJobs = [{ ...failed, status: "running" }, uncertainRecovery];
  writeFileSync(historyFile, JSON.stringify(historyJobs), { mode: 0o600 });
  const exitProof = vi.fn(async () => undefined);
  const historyInput = {
    stateDirectory: f.enrollmentStateDirectory,
    plan: historyPlan,
    account: f.account,
    reader: { verifyProcessExited: exitProof },
    signal: new AbortController().signal,
  };
  const history = await inspectNativeMaintenanceRecoveryHistory(historyInput);
  expect(history.ancestors.map((item) => item.job.id)).toEqual([recoveryId, claimed.id]);
  expect(exitProof.mock.calls).toEqual([
    [uncertainRecovery.effectIntent!.executor.pid],
    [claimed.effectIntent!.executor.pid],
  ]);
  history.assertCurrent();
  const { inspectAbsentMaintenanceRecovery } =
    await import("./coordinator-bootstrap-maintenance-recovery-inspection.js");
  const absentPlan = inspectMaintenanceRecoveryPlan(historyPlan, f.account);
  const absentRequest = {
    ...recoveryJob,
    proposal: {
      ...recoveryJob.proposal,
      planSha256: absentPlan.planSha256,
      recoveryOf: historyPlan.recoveryOf,
    },
  };
  const absentInput = {
    ...historyInput,
    request: absentRequest,
    writableMountRoots: [],
    currentBoot: {
      target: "maintenance-controller" as const,
      installationId: f.plan.identity.installationId,
      process: { ...claimed.effectIntent!.executor, bootId: randomUUID() },
      assertCurrent: () => undefined,
    },
    assertAbsent: vi.fn(() => undefined),
    assertRuntimeAbsent: vi.fn(() => undefined),
  };
  retainEnrollmentNativeIdentity(f.enrollmentStateDirectory, f.plan.identity);
  const absent = await inspectAbsentMaintenanceRecovery(absentInput);
  expect(absent.native.process).toBeNull();
  expect(absent.native.service.registered).toBe(false);
  expect(absent.native.selection.sourceCommit).toBeNull();
  absent.assertCurrent();
  writeFileSync(f.plan.identity.selectionPath!, "partial selection", { mode: 0o600 });
  expect(absent.assertCurrent).toThrow("state appeared");
  const partial = await inspectAbsentMaintenanceRecovery(absentInput);
  expect(partial.native.selection.receiptSha256).toBe(
    createHash("sha256").update("partial selection").digest("hex"),
  );
  expect(partial.native.selection.sourceCommit).toBeNull();
  await expect(
    inspectAbsentMaintenanceRecovery({
      ...absentInput,
      assertAbsent: () => {
        throw new Error("permission denied");
      },
    }),
  ).rejects.toThrow("permission denied");
  const sameBoot = await inspectAbsentMaintenanceRecovery({
    ...absentInput,
    currentBoot: { ...absentInput.currentBoot, process: claimed.effectIntent!.executor },
  });
  expect(sameBoot.native.process).toBeNull();
  expect(absentInput.assertRuntimeAbsent).toHaveBeenCalled();
  absentInput.assertRuntimeAbsent.mockImplementationOnce(() => {
    throw new Error("Runtime appeared before claim");
  });
  expect(sameBoot.assertCurrent).toThrow("Runtime appeared before claim");
  await expect(
    inspectAbsentMaintenanceRecovery({
      ...absentInput,
      assertRuntimeAbsent: () => {
        throw new Error("unrecorded native process remains");
      },
    }),
  ).rejects.toThrow("unrecorded native process remains");
  await expect(
    inspectAbsentMaintenanceRecovery({
      ...absentInput,
      request: {
        ...absentRequest,
        proposal: { ...absentRequest.proposal, sourceCommit: "f".repeat(40) },
      },
    }),
  ).rejects.toThrow("differs from retained native plan");
  rmSync(f.plan.identity.selectionPath!);
  const bootWitness = {
    target: "maintenance-controller" as const,
    installationId: f.plan.identity.installationId,
    process: { ...claimed.effectIntent!.executor, bootId: randomUUID() },
    assertCurrent: vi.fn(() => undefined),
  };
  const previousBootReader = {
    verifyProcessExited: vi.fn(async () => {
      throw new Error("Numeric PIDs reused after reboot");
    }),
  };
  const rebootHistory = await inspectNativeMaintenanceRecoveryHistory({
    ...historyInput,
    currentBoot: bootWitness,
    reader: previousBootReader,
  });
  expect(rebootHistory.ancestors).toHaveLength(2);
  expect(previousBootReader.verifyProcessExited).not.toHaveBeenCalled();
  rebootHistory.assertCurrent();
  bootWitness.assertCurrent.mockImplementation(() => {
    throw new Error("Selected native witness changed");
  });
  expect(rebootHistory.assertCurrent).toThrow("Selected native witness changed");
  writeFileSync(historyFile, JSON.stringify([historyJobs[0]]), { mode: 0o600 });
  expect(history.assertCurrent).toThrow("history changed");
  await expect(inspectNativeMaintenanceRecoveryHistory(historyInput)).rejects.toThrow(
    "missing or ambiguous",
  );
  writeFileSync(historyFile, JSON.stringify(historyJobs), { mode: 0o600 });
  await expect(
    inspectNativeMaintenanceRecoveryHistory({
      ...historyInput,
      reader: {
        verifyProcessExited: async () => {
          throw new Error("live ancestor");
        },
      },
    }),
  ).rejects.toThrow("lifetime exit is unproven");
  const recoverySelection = {
    version: 3,
    operation: "recovery",
    requestId: recoveryId,
    requestRevision: recoveryRevision,
    intentId: uncertainRecovery.effectIntent!.id,
    generation: recoveryReservation.generation,
    planSha256: recoveryContext.planSha256,
    slot: "candidate",
  };
  writeFileSync(f.plan.identity.selectionPath!, JSON.stringify(recoverySelection), { mode: 0o600 });
  const recoveryStartup = { setupFile: f.plan.candidate.setup.path, account: f.account };
  const startedRecovery = await readMaintenanceLauncherStartup(recoveryStartup);
  expect(startedRecovery.selected).toEqual(f.plan.candidate);
  expect(startedRecovery.planSha256).toBe(recoveryContext.planSha256);
  const readyRecord = {
    ...recoveryObservedRecord,
    native: {
      ...recoveryObservedRecord.native,
      process: { ...claimed.effectIntent!.executor, executable: f.plan.candidate.node.path },
      service: {
        ...recoveryObservedRecord.native.service,
        label: f.plan.identity.environment === "host" ? f.plan.identity.serviceLabel : "invalid",
        registered: true,
        launcherSha256: "c".repeat(64),
        registrationSha256: "d".repeat(64),
      },
      selection: {
        ...recoveryObservedRecord.native.selection,
        receiptSha256: "e".repeat(64),
        sourceCommit: f.plan.candidate.sourceCommit,
        artifactSha256: f.plan.candidate.artifactSha256,
      },
    },
  };
  const readySha = createHash("sha256").update(JSON.stringify(readyRecord)).digest("hex");
  const readyRecovery = MaintenanceServiceJobSchema.parse({
    ...uncertainRecovery,
    status: "succeeded",
    observation: {
      ...uncertainRecovery.observation,
      ready: true,
      outcome: "candidate",
      evidenceSha256: readySha,
    },
    evidence: [...uncertainRecovery.evidence, { sha256: readySha, record: readyRecord }],
  });
  const resolvedOriginal = {
    ...failed,
    status: "failed",
    resolvedBy: {
      requestId: recoveryId,
      generation: recoveryReservation.generation,
      planSha256: recoveryContext.planSha256,
      observationSha256: readySha,
    },
  };
  writeFileSync(historyFile, JSON.stringify([resolvedOriginal, readyRecovery]), { mode: 0o600 });
  expect((await readMaintenanceLauncherStartup(recoveryStartup)).selected).toEqual(
    f.plan.candidate,
  );
  writeFileSync(
    historyFile,
    JSON.stringify([
      {
        ...resolvedOriginal,
        resolvedBy: { ...resolvedOriginal.resolvedBy, generation: randomUUID() },
      },
      readyRecovery,
    ]),
    { mode: 0o600 },
  );
  await expect(readMaintenanceLauncherStartup(recoveryStartup)).rejects.toThrow(
    "resolution differs",
  );
  writeFileSync(historyFile, JSON.stringify([resolvedOriginal, uncertainRecovery]), {
    mode: 0o600,
  });
  await expect(readMaintenanceLauncherStartup(recoveryStartup)).rejects.toThrow(
    "no exact ready leaf",
  );
  writeFileSync(historyFile, JSON.stringify([resolvedOriginal, readyRecovery]), { mode: 0o600 });
  writeFileSync(
    f.plan.identity.selectionPath!,
    JSON.stringify({ ...recoverySelection, generation: randomUUID() }),
    { mode: 0o600 },
  );
  await expect(readMaintenanceLauncherStartup(recoveryStartup)).rejects.toThrow(
    "selected slot differs",
  );
  rmSync(f.plan.identity.selectionPath!);
  writeFileSync(historyFile, JSON.stringify([claimed]), { mode: 0o600 });
  rmSync(historyPlans, { recursive: true });
  const recoveryBinding = {
    retained: recoveryJob,
    reservation: recoveryReservation,
    plan: recoveryPlan,
    account: f.account,
  };
  expect(inspectMaintenanceRecoveryExecution(recoveryBinding).selected).toEqual(f.plan.candidate);
  await expect(verifyMaintenanceRecoveryPredecessor(recoveryInput)).resolves.toHaveProperty(
    "intent.id",
    claimed.effectIntent!.id,
  );
  expect(() =>
    inspectMaintenanceRecoveryExecution({
      ...recoveryBinding,
      retained: { ...recoveryJob, effectIntent: claimed.effectIntent },
    }),
  ).toThrow("fresh unconsumed");
  expect(() =>
    inspectMaintenanceRecoveryExecution({
      ...recoveryBinding,
      reservation: { ...recoveryReservation, generation: reservation.generation },
    }),
  ).toThrow("fresh unconsumed");
  expect(() =>
    inspectMaintenanceRecoveryExecution({
      ...recoveryBinding,
      retained: { ...recoveryJob, proposal: { ...recoveryProposal, sourceCommit: "e".repeat(40) } },
    }),
  ).toThrow("exact retained plan");
  const noPrevious = { ...f.plan, previous: null };
  expect(() =>
    inspectMaintenanceRecoveryPlan(
      {
        ...recoveryPlan,
        operation: "maintenance-service-rollback",
        original: noPrevious,
        originalPlanSha256: inspectMaintenanceLauncherPlan(noPrevious, f.account).planSha256,
        recoveryOf: {
          ...recoveryPlan.recoveryOf,
          planSha256: inspectMaintenanceLauncherPlan(noPrevious, f.account).planSha256,
        },
      },
      f.account,
    ),
  ).toThrow("rollback slot");
  expect(recoveryInput.reader.verifyProcessExited).toHaveBeenCalledWith(
    claimed.effectIntent!.executor.pid,
  );
  await expect(
    verifyMaintenanceRecoveryPredecessor({
      ...recoveryInput,
      reader: {
        verifyProcessExited: async () => {
          throw new Error("still live");
        },
      },
    }),
  ).rejects.toThrow("lifetime exit is unproven");
  await expect(
    verifyMaintenanceRecoveryPredecessor({
      ...recoveryInput,
      recoveryOf: { ...recoveryInput.recoveryOf, generation: randomUUID() },
    }),
  ).rejects.toThrow("predecessor differs");
  await expect(
    verifyMaintenanceRecoveryPredecessor({
      ...recoveryInput,
      retained: { ...failed, status: "succeeded" },
    }),
  ).rejects.toThrow("predecessor differs");
  await expect(
    verifyMaintenanceRecoveryPredecessor({
      ...recoveryInput,
      retained: { ...failed, evidence: claimed.evidence },
    }),
  ).rejects.toThrow("exact retained native evidence");
  expect(() => observe(job)).toThrow("Retained service effect");
  [
    { ...claimed, effectIntent: { ...claimed.effectIntent, generation: randomUUID() } },
    { ...claimed, evidence: [] },
    { ...claimed, evidence: [...claimed.evidence, ...claimed.evidence] },
    {
      ...claimed,
      evidence: claimed.evidence.map((item) => ({
        ...item,
        record: { ...item.record, sourceCommit: "e".repeat(40) },
      })),
    },
  ].forEach((forged) => expect(() => observe(forged)).toThrow());
  retainEnrollmentNativeIdentity(f.enrollmentStateDirectory, f.plan.identity);
  const plans = path.join(path.dirname(f.plan.identity.selectionPath!), "plans");
  mkdirSync(plans, { mode: 0o700 });
  writeFileSync(path.join(plans, `${native.planSha256}.json`), JSON.stringify(f.plan), {
    mode: 0o600,
  });
  const selection = {
    version: 2,
    requestId: claimed.id,
    requestRevision: reservation.requestRevision,
    intentId: claimed.effectIntent!.id,
    generation: reservation.generation,
    planSha256: native.planSha256,
    slot: "candidate",
  };
  const select = (value: unknown) =>
    writeFileSync(f.plan.identity.selectionPath!, JSON.stringify(value), { mode: 0o600 });
  select(selection);
  const startup = () =>
    readMaintenanceLauncherStartup({ setupFile: f.plan.candidate.setup.path, account: f.account });
  await expect(startup()).resolves.toMatchObject({ selected: f.plan.candidate, job: claimed });
  const { maintenanceExecutorStartupBinding } =
    await import("./coordinator-bootstrap-maintenance-executor-evidence.js");
  // Role discovery alone is not native proof: verify the exact registered
  // launcher, selected files and current process before accepting its role.
  const { inspectSelectedMaintenanceExecutor } =
    await import("./coordinator-bootstrap-maintenance-executor-evidence.js");
  const { renderMaintenanceUserLauncher } =
    await import("./coordinator-bootstrap-maintenance-launcher.js");
  writeFileSync(f.plan.identity.launcherPath, renderMaintenanceUserLauncher(f.plan, "candidate"), {
    mode: 0o600,
  });
  const launcherProcess = {
    ...claimed.effectIntent!.executor,
    parentPid: 1,
    executable: f.plan.candidate.node.path,
    argumentsSha256: createHash("sha256")
      .update(JSON.stringify(maintenanceUserLauncher(f.plan, "candidate").ProgramArguments))
      .digest("hex"),
  };
  const executorInput = {
    setupFile: f.plan.candidate.setup.path,
    account: f.account,
    stateDirectory: f.enrollmentStateDirectory,
    writableMountRoots: [],
    ports: {
      reader: {
        readService: async (service: string) => `${service} = {\n\tpid = ${launcherProcess.pid}\n}`,
        inspectProcess: async () => launcherProcess,
      },
      assertCurrent: () => undefined,
    },
  };
  await expect(inspectSelectedMaintenanceExecutor(executorInput)).rejects.toThrow(
    "required enrolled role",
  );
  const launcherExecutor = await inspectSelectedMaintenanceExecutor({
    ...executorInput,
    expectedTarget: "recovery-launcher",
  });
  expect(launcherExecutor.executor.target).toBe("recovery-launcher");
  expect(launcherExecutor.executor.native.process).toEqual(launcherProcess);
  launcherExecutor.assertCurrent();
  const originalLauncher = readFileSync(f.plan.identity.launcherPath);
  writeFileSync(f.plan.identity.launcherPath, "changed launcher");
  expect(() => launcherExecutor.assertCurrent()).toThrow();
  writeFileSync(f.plan.identity.launcherPath, originalLauncher);
  const beforeBookkeeping = await startup();
  journal.writeLifecycle([
    { ...claimed, status: "failed", detail: "Observation pending", revision: randomUUID() },
  ]);
  const afterBookkeeping = await startup();
  expect(afterBookkeeping).not.toEqual(beforeBookkeeping);
  expect(maintenanceExecutorStartupBinding(afterBookkeeping)).toEqual(
    maintenanceExecutorStartupBinding(beforeBookkeeping),
  );
  journal.writeLifecycle([claimed]);

  // Revocation allows retained observation, never another effect claim.
  changeStandingGrant(enrollmentJournal, {
    expectedRevision: enrolled.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  await expect(startup()).resolves.toMatchObject({ selected: f.plan.candidate });
  const rejectOtherSelections = async () => {
    for (const field of ["requestId", "requestRevision", "intentId", "generation"] as const) {
      select({ ...selection, [field]: randomUUID() });
      await expect(startup()).rejects.toThrow();
    }
  };
  await rejectOtherSelections();
  select({ ...selection, slot: "previous" });
  await expect(startup()).rejects.toThrow("selected reviewed slot");
  await expect(
    readMaintenanceLauncherStartup({ setupFile: f.plan.previous!.setup.path, account: f.account }),
  ).resolves.toMatchObject({ selected: f.plan.previous });
  expect(journal.readLifecycle()).toEqual([claimed]);
});

test("reviewed launcher rendering survives native plist parsing without argument expansion", async () => {
  const f = await fixture();
  const { renderMaintenanceUserLauncher } =
    await import("./coordinator-bootstrap-maintenance-launcher.js");
  const { readBootstrapLauncher } = await import("./coordinator-bootstrap-service.js");
  // Shell metacharacters are literal argv bytes, never an executable command.
  f.plan.candidate.setup.path = path.join(
    f.plan.identity.installationRoot,
    "literal & <'\" $HOME `value`.json",
  );
  const bytes = renderMaintenanceUserLauncher(f.plan, "candidate");
  const file = path.join(f.plan.identity.stateDirectory, "rendered-fixture.plist");
  writeFileSync(file, bytes, { mode: 0o600 });
  const decoded = await readBootstrapLauncher(
    {
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    [],
  );
  expect(decoded).toEqual(maintenanceUserLauncher(f.plan, "candidate"));
  expect(renderMaintenanceUserLauncher(f.plan, "candidate")).toEqual(bytes);
});

async function exerciseNativeReplacement(
  f: Awaited<ReturnType<typeof fixture>>,
  claim: Parameters<
    typeof import("./coordinator-bootstrap-maintenance-service-claim.js").claimMaintenanceServiceEffect
  >[0],
  mode: string,
) {
  const { MaintenanceServiceEvidenceRecordSchema } =
    await import("@getpaseo/protocol/maintenance-service");
  const { executeMaintenanceServiceReplacement } =
    await import("./coordinator-bootstrap-maintenance-service-native.js");
  const { FileBootstrapRequestJournal } = await import("./coordinator-bootstrap-journal.js");
  const { FileEnrollmentJournal, reserveActivationStep, observeActivationStep } =
    await import("./maintenance/authorization.js");
  const { reserveMaintenanceLauncherEffect } =
    await import("./coordinator-bootstrap-maintenance-launcher-state.js");
  const { renderMaintenanceUserLauncher } =
    await import("./coordinator-bootstrap-maintenance-launcher.js");
  const journal = new FileBootstrapRequestJournal(f.enrollmentStateDirectory);
  const jobs = journal.readLifecycle();
  // Establish disposable prior-selection history before restoring the fixture's
  // later running job. This is test setup, not a production history rewrite.
  journal.writeLifecycle([]);
  const enrollment = new FileEnrollmentJournal(f.enrollmentStateDirectory);
  const state = enrollment.read();
  if (state.status !== "enrolled") throw new Error("Fixture enrollment absent");
  const stepId = state.grant.manifest.steps[0]!.id;
  const reserved = reserveActivationStep(enrollment, {
    grantRevision: state.grant.revision,
    stepId,
  });
  if (reserved.status !== "enrolled" || reserved.activation.steps[0]!.status !== "reserved")
    throw new Error("Fixture activation absent");
  const initialPlan = { ...f.plan, previous: null, candidate: f.plan.previous! };
  const initialNative = inspectMaintenanceLauncherPlan(initialPlan, f.account);
  const initial = reserveMaintenanceLauncherEffect({
    ...f,
    plan: initialPlan,
    grantId: state.grant.id,
    grantRevision: state.grant.revision,
    stepId,
    generation: reserved.activation.steps[0]!.generation,
    assertCurrent: () => undefined,
  });
  const native = inspectMaintenanceLauncherPlan(f.plan, f.account);
  retainEnrollmentNativeIdentity(f.enrollmentStateDirectory, f.plan.identity);
  const plans = path.join(path.dirname(f.plan.identity.selectionPath!), "plans");
  mkdirSync(plans, { mode: 0o700 });
  writeFileSync(path.join(plans, `${native.planSha256}.json`), JSON.stringify(f.plan), {
    mode: 0o600,
  });
  const initialSelection = {
    version: 1,
    intentId: initial.intent.id,
    stepId,
    generation: initial.intent.generation,
    planSha256: initialNative.planSha256,
    slot: "candidate",
  };
  writeFileSync(path.join(plans, `${initialNative.planSha256}.json`), JSON.stringify(initialPlan), {
    mode: 0o600,
  });
  writeFileSync(f.plan.identity.selectionPath!, JSON.stringify(initialSelection), { mode: 0o600 });
  writeFileSync(f.plan.identity.launcherPath, renderMaintenanceUserLauncher(f.plan, "previous"), {
    mode: 0o600,
  });
  observeActivationStep(enrollment, {
    stepId,
    generation: initial.intent.generation,
    outcome: "succeeded",
    observationSha256: "a".repeat(64),
  });
  journal.writeLifecycle(jobs);
  const identity = f.plan.identity;
  if (identity.environment !== "host") throw new Error("Fixture Host required");
  const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const processFor = (slot: "previous" | "candidate") => ({
    pid: slot === "previous" ? 43120 : 43121,
    parentPid: 1,
    uid: f.account.uid,
    bootId: claim.evidence.native.bootId,
    startIdentity: slot === "previous" ? "100:1" : "101:2",
    executable: f.plan[slot]!.node.path,
    argumentsSha256: digest(JSON.stringify(maintenanceUserLauncher(f.plan, slot).ProgramArguments)),
  });
  const previous = processFor("previous");
  const { assertCurrent: _assertCurrent, evidenceSha256: _sha, ...oldRecord } = claim.evidence;
  const record = MaintenanceServiceEvidenceRecordSchema.parse({
    ...oldRecord,
    native: {
      ...oldRecord.native,
      process: previous,
      service: {
        ...oldRecord.native.service,
        registered: true,
        label: identity.serviceLabel,
        launcherSha256: digest(readFileSync(identity.launcherPath)),
        registrationSha256: digest(readFileSync(identity.launcherPath)),
      },
      selection: {
        ...oldRecord.native.selection,
        receiptSha256: digest(readFileSync(identity.selectionPath!)),
        sourceCommit: f.plan.previous!.sourceCommit,
        artifactSha256: f.plan.previous!.artifactSha256,
      },
    },
  });
  let loaded: "previous" | "candidate" | null = "previous";
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  const commands: string[][] = [];
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected native reader method");
  };
  const reader = {
    readService: async () => {
      if (!loaded) throw new Error("Fixture service absent");
      return `${service} = {\n\tpid = ${processFor(loaded).pid}\n}`;
    },
    inspectProcess: async (pid: number) => {
      if (pid === process.pid) return claim.executor;
      if (!loaded) throw new Error("Absent");
      return processFor(loaded);
    },
    inspectAuditedProcess: unused,
    inspectRunningProcess: unused,
    inspectStoppedProcess: unused,
    verifyProcessExited: async (pid: number) => {
      expect(pid).toBe(previous.pid);
      expect(loaded).toBeNull();
    },
    verifyServiceAbsent: async (name: string) => {
      expect(name).toBe(service);
      expect(loaded).toBeNull();
    },
  };
  let executorChecks = 0;
  let observationAborted = false;
  const deferredObservation = Promise.withResolvers<never>();
  const input = {
    ...claim,
    reader,
    writableMountRoots: [],
    evidence: {
      ...record,
      evidenceSha256: digest(JSON.stringify(record)),
      assertCurrent: claim.evidence.assertCurrent,
    },
    requireExecutor: async () => {
      executorChecks++;
      if (mode === "native-custody-changed" && executorChecks === 2)
        throw new Error("Executor custody changed");
      return claim.executor;
    },
    readCandidateObservation: async (signal: AbortSignal) => {
      if (mode === "native-observation-timeout") {
        signal.addEventListener(
          "abort",
          () => {
            observationAborted = true;
          },
          { once: true },
        );
        queueMicrotask(() => {
          void vi.advanceTimersByTimeAsync(30_000);
        });
        return deferredObservation.promise;
      }
      const candidate = processFor("candidate");
      if (mode === "native-runtime-readiness") {
        const server = createServer((request, response) => {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              version: 1,
              nonce: new URL(request.url!, "http://localhost").searchParams.get("nonce"),
              installationId: identity.installationId,
              target: identity.target,
              identitySha256: native.identitySha256,
              sourceCommit: f.plan.candidate.sourceCommit,
              artifactSha256: f.plan.candidate.artifactSha256,
              process: candidate,
              ready: true,
            }),
          );
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Fixture listener absent");
          writeFileSync(
            path.join(identity.installationRoot, `maintenance-control-${candidate.pid}.json`),
            JSON.stringify({
              version: 1,
              admissionSha256: "a".repeat(64),
              requestId: claim.requestId,
              process: candidate,
              address: "127.0.0.1",
              port: address.port,
            }),
            { mode: 0o600 },
          );
          const { inspectMaintenanceServiceReadiness } =
            await import("./coordinator-bootstrap-maintenance-service-inspection.js");
          return await inspectMaintenanceServiceReadiness({
            stateDirectory: f.enrollmentStateDirectory,
            requestId: claim.requestId,
            plan: f.plan,
            account: f.account,
            writableMountRoots: [],
            signal,
            ports: {
              reader,
              assertCurrent: (name, observed) => {
                expect(name).toBe(service);
                expect(observed).toEqual(candidate);
              },
            },
          });
        } finally {
          server.closeAllConnections();
          const closed = once(server, "close");
          server.close();
          await closed;
        }
      }
      const now = new Date().toISOString();
      const proof = MaintenanceServiceEvidenceRecordSchema.parse({
        ...record,
        requestRevision: claim.reservation.requestRevision,
        observedAt: now,
        native: {
          ...record.native,
          process: candidate,
          service: {
            ...record.native.service,
            launcherSha256: digest(readFileSync(identity.launcherPath)),
          },
          selection: {
            ...record.native.selection,
            receiptSha256: digest(readFileSync(identity.selectionPath!)),
            sourceCommit: f.plan.candidate.sourceCommit,
            artifactSha256: f.plan.candidate.artifactSha256,
          },
        },
      });
      return {
        requestId: claim.requestId,
        requestRevision: claim.reservation.requestRevision,
        generation: claim.reservation.generation,
        planSha256: native.planSha256,
        identitySha256: native.identitySha256,
        outcome: "candidate" as const,
        sourceCommit: f.plan.candidate.sourceCommit,
        artifactSha256: f.plan.candidate.artifactSha256,
        ready: mode !== "native-bad-health",
        evidenceSha256: digest(JSON.stringify(proof)),
        observedAt: now,
        record: proof,
        assertCurrent: () => undefined,
      };
    },
  };
  const command = {
    run: async (args: readonly string[]) => {
      // The shared lifecycle lock must be free for every native command.
      journal.withRecoveryTransaction(() => undefined);
      commands.push([...args]);
      const retained = journal.readLifecycle()[0];
      expect(retained && "effectIntent" in retained && retained.effectIntent).toBeTruthy();
      if (args[0] === "bootout") {
        expect(args).toEqual(["bootout", service]);
        loaded = null;
        if (mode === "native-stop-failure") throw new Error("Lost stop reply");
      } else {
        expect(args).toEqual(["bootstrap", identity.serviceDomain, identity.launcherPath]);
        loaded = "candidate";
        if (mode === "native-observation-timeout")
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        if (mode === "native-start-failure") throw new Error("Lost start reply");
      }
    },
  };
  const { readMaintenanceServiceInvocation } =
    await import("./coordinator-bootstrap-maintenance-service-runner.js");
  const invocation = {
    executorSetupFile: f.plan.previous!.setup.path,
    args: [
      claim.requestId,
      claim.reservation.requestRevision,
      claim.reservation.generation,
      claim.reservation.planSha256,
    ],
    account: f.account,
  };
  const loadedInvocation = await readMaintenanceServiceInvocation(invocation);
  expect(loadedInvocation.expectedRevision).toBe(claim.expectedRevision);
  expect(loadedInvocation.reservation).toEqual(claim.reservation);
  await verifyChildIdentityCases(loadedInvocation, invocation.args, claim.executor);

  await expect(
    readMaintenanceServiceInvocation({
      ...invocation,
      args: [
        claim.requestId,
        claim.expectedRevision,
        claim.reservation.generation,
        claim.reservation.planSha256,
      ],
    }),
  ).rejects.toThrow("invocation differs");
  const { maintenanceServiceClaimAdmission } =
    await import("./coordinator-bootstrap-maintenance-service-runner.js");
  let nativeRechecks = 0;
  const {
    inspectSelectedMaintenanceExecutor,
    bindMaintenanceExecutorEvidence,
    requireReservedMaintenanceExecutor,
    inspectMaintenanceTargetEvidence,
    maintenanceRecoveryBootWitness,
  } = await import("./coordinator-bootstrap-maintenance-executor-evidence.js");
  const selectedExecutor = await inspectSelectedMaintenanceExecutor({
    setupFile: f.plan.previous!.setup.path,
    account: f.account,
    stateDirectory: f.enrollmentStateDirectory,
    writableMountRoots: [],
    ports: { reader, assertCurrent: () => undefined },
  });
  const reservationJob = journal.readLifecycle()[0]!;
  if (!("reservation" in reservationJob) || !reservationJob.reservation)
    throw new Error("Missing fixture reservation");
  const reservedProof = { record: { ...record }, sha256: "" };
  reservationJob.evidence.push(reservedProof);
  reservedProof.record.executor = selectedExecutor.executor;
  reservedProof.sha256 = digest(JSON.stringify(reservedProof.record));
  reservationJob.reservation.nativeEvidenceSha256 = reservedProof.sha256;
  reservationJob.approval!.nativeEvidenceSha256 = reservedProof.sha256;
  claim.reservation.nativeEvidenceSha256 = reservedProof.sha256;
  journal.writeLifecycle([reservationJob]);
  requireReservedMaintenanceExecutor(reservationJob, selectedExecutor.executor);
  expect(() =>
    requireReservedMaintenanceExecutor(reservationJob, {
      ...selectedExecutor.executor,
      setup: { ...selectedExecutor.executor.setup, sha256: "f".repeat(64) },
    }),
  ).toThrow("reserved native evidence");
  const nativeEvidence = bindMaintenanceExecutorEvidence(
    await inspectMaintenanceTargetEvidence({
      currentBoot: maintenanceRecoveryBootWitness(selectedExecutor),
      reader,
      signal: new AbortController().signal,
      request: journal.readLifecycle()[0],
      plan: f.plan,
      account: f.account,
      stateDirectory: f.enrollmentStateDirectory,
      writableMountRoots: [],
      ports: {
        reader,
        assertCurrent: (name, observed) => {
          expect(name).toBe(service);
          expect(observed).toEqual(previous);
          nativeRechecks++;
        },
      },
    }),
    selectedExecutor,
  );
  expect(nativeRechecks).toBe(2);
  expect(nativeEvidence.requestRevision).toBe(claim.expectedRevision);
  expect(nativeEvidence.native.process).toEqual(previous);
  expect(nativeEvidence.native.selection.sourceCommit).toBe(f.plan.previous!.sourceCommit);
  expect(nativeEvidence.sourceCommit).toBe(f.plan.candidate.sourceCommit);
  input.evidence = nativeEvidence;
  const { evidenceSha256, assertCurrent, ...nativeRecord } = input.evidence;
  input.admission = maintenanceServiceClaimAdmission({
    stateDirectory: input.stateDirectory,
    evidence: {
      expectedRevision: input.expectedRevision,
      record: nativeRecord,
      sha256: evidenceSha256,
      assertCurrent,
    },
  });
  const run = () => executeMaintenanceServiceReplacement(input, command);
  if (mode.startsWith("native-unclaimed")) {
    await exerciseNativeObservation(
      f,
      input,
      loaded,
      mode,
      processFor,
      commands,
      enrollment,
      state.grant.revision,
    );
    return;
  }
  if (mode === "native-grant-revoked") {
    const { changeStandingGrant } = await import("./maintenance/authorization.js");
    changeStandingGrant(enrollment, {
      expectedRevision: state.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
    const before = journal.readLifecycle();
    await expect(run()).rejects.toThrow();
    expect(journal.readLifecycle()).toEqual(before);
    expect(commands).toHaveLength(0);
    return;
  }

  if (mode === "native-success" || mode === "native-runtime-readiness")
    await expect(run()).resolves.toMatchObject({ outcome: "candidate", ready: true });
  else if (mode === "native-observation-timeout") {
    await expect(run()).rejects.toThrow("Candidate readiness observation timed out");
    expect(observationAborted).toBe(true);
    vi.useRealTimers();
    deferredObservation.reject(new Error("Late transport failure"));
    await Promise.resolve();
  } else if (mode === "native-bad-health")
    await expect(run()).rejects.toThrow("Candidate observation differs");
  else if (mode === "native-custody-changed")
    await expect(run()).rejects.toThrow("Executor custody changed");
  else await expect(run()).rejects.toThrow(/Lost (stop|start) reply/);
  const retained = journal.readLifecycle();
  const calls = commands.length;
  if (mode === "native-custody-changed") expect(calls).toBe(0);
  await expect(run()).rejects.toThrow("unconsumed");
  expect(commands).toHaveLength(calls);
  expect(journal.readLifecycle()).toEqual(retained);
  if (mode === "native-observation-timeout") return;
  await exerciseNativeObservation(
    f,
    input,
    loaded,
    mode,
    processFor,
    commands,
    enrollment,
    state.grant.revision,
  );
}

async function exerciseNativeObservation(
  f: Awaited<ReturnType<typeof fixture>>,
  input: Parameters<
    typeof import("./coordinator-bootstrap-maintenance-service-native.js").executeMaintenanceServiceReplacement
  >[0],
  loaded: "previous" | "candidate" | null,
  mode: string,
  processFor: (
    slot: "previous" | "candidate",
  ) => ReturnType<
    typeof import("@getpaseo/protocol/coordinator-bootstrap").BootstrapProcessIdentitySchema.parse
  >,
  commands: string[][],
  enrollment: import("./maintenance/authorization.js").FileEnrollmentJournal,
  grantRevision: string,
) {
  const { MaintenanceServiceEvidenceRecordSchema } =
    await import("@getpaseo/protocol/maintenance-service");
  const { FileBootstrapRequestJournal } = await import("./coordinator-bootstrap-journal.js");
  const journal = new FileBootstrapRequestJournal(f.enrollmentStateDirectory);
  const retained = journal.readLifecycle();
  const calls = commands.length;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const { observeMaintenanceServiceReplacement } =
    await import("./coordinator-bootstrap-maintenance-service-native.js");
  await revokeObservationGrant(enrollment, grantRevision, mode);
  const observedSlot = loaded;
  const outcome = observedSlot ?? "unknown";
  const selected = observedSlot ? f.plan[observedSlot]! : null;
  const candidate = await input.readCandidateObservation(new AbortController().signal);
  const observedRecord = MaintenanceServiceEvidenceRecordSchema.parse({
    ...candidate.record,
    sourceCommit: selected?.sourceCommit ?? null,
    artifactSha256: selected?.artifactSha256 ?? null,
    native: {
      ...candidate.record.native,
      process: observedSlot ? processFor(observedSlot) : null,
      service: { ...candidate.record.native.service, registered: observedSlot !== null },
      selection: {
        ...candidate.record.native.selection,
        sourceCommit: selected?.sourceCommit ?? f.plan.previous!.sourceCommit,
        artifactSha256: selected?.artifactSha256 ?? f.plan.previous!.artifactSha256,
      },
    },
  });
  const observedValue = {
    ...candidate,
    outcome,
    sourceCommit: selected?.sourceCommit ?? null,
    artifactSha256: selected?.artifactSha256 ?? null,
    ready: observedSlot !== null && mode !== "native-bad-health",
    record: observedRecord,
    evidenceSha256: digest(JSON.stringify(observedRecord)),
  };
  const observerInput = { ...input, readObservation: async () => observedValue };
  if (mode === "native-unclaimed-candidate") {
    await expect(
      observeMaintenanceServiceReplacement({
        ...observerInput,
        readObservation: async () => candidate,
      }),
    ).rejects.toThrow("fresh previous-slot observation");
    expect(journal.readLifecycle()).toEqual(retained);
    expect(commands).toHaveLength(0);
    return;
  }
  const observed = await observeMaintenanceServiceReplacement(observerInput);
  if (mode.startsWith("native-unclaimed")) {
    await verifyUnclaimedObservation({ observerInput, observed, claim: input, mode, commands });
    return;
  }
  assertConsumedObservation(outcome, observed, observedValue);
  await verifyTerminalObservation(observerInput, observedValue, observed);
  expect(observed.requestRevision).toBe(input.reservation.requestRevision);
  observed.assertCurrent();
  expect(commands).toHaveLength(calls);
  expect(journal.readLifecycle()).toEqual(retained);
  await expect(
    observeMaintenanceServiceReplacement({
      ...observerInput,
      reservation: { ...input.reservation, generation: randomUUID() },
    }),
  ).rejects.toThrow("reservation changed");
  await expect(
    observeMaintenanceServiceReplacement({
      ...observerInput,
      readObservation: async () => ({ ...observedValue, generation: randomUUID() }),
    }),
  ).rejects.toThrow("differs from reserved");
  journal.mutateLifecycle(
    (current) =>
      current.map((job) => (job.id === input.requestId ? { ...job, revision: randomUUID() } : job)),
    () => undefined,
  );
  expect(() => observed.assertCurrent()).toThrow(
    mode === "native-runtime-readiness"
      ? "Native readiness custody changed"
      : "Retained native observation changed",
  );
  expect(commands).toHaveLength(calls);
}

async function revokeObservationGrant(
  enrollment: import("./maintenance/authorization.js").FileEnrollmentJournal,
  grantRevision: string,
  mode: string,
) {
  const { changeStandingGrant } = await import("./maintenance/authorization.js");
  if (mode !== "native-unclaimed-race")
    changeStandingGrant(enrollment, {
      expectedRevision: grantRevision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
}

function assertConsumedObservation(
  outcome: import("./maintenance/service-execution.js").MaintenanceServiceNativeObservation["outcome"],
  observed: import("./maintenance/service-execution.js").MaintenanceServiceNativeObservation,
  expected: import("./maintenance/service-execution.js").MaintenanceServiceNativeObservation,
) {
  expect(observed.outcome).toBe(outcome === "previous" ? "unknown" : outcome);
  expect(observed.ready).toBe(outcome === "previous" ? false : expected.ready);
}

async function verifyUnclaimedObservation(input: {
  observerInput: Parameters<
    typeof import("./coordinator-bootstrap-maintenance-service-native.js").observeMaintenanceServiceReplacement
  >[0];
  observed: import("./maintenance/service-execution.js").MaintenanceServiceNativeObservation;
  claim: Parameters<
    typeof import("./coordinator-bootstrap-maintenance-service-claim.js").claimMaintenanceServiceEffect
  >[0];
  mode: string;
  commands: string[][];
}) {
  const { observerInput, observed, claim, mode, commands } = input;
  const { FileBootstrapRequestJournal } = await import("./coordinator-bootstrap-journal.js");
  const journal = new FileBootstrapRequestJournal(observerInput.stateDirectory);
  expect(observed).toMatchObject({ outcome: "previous", ready: true });
  const { MaintenanceServiceJobSchema } = await import("@getpaseo/protocol/maintenance-service");
  const { maintenanceServiceClaimAdmission } =
    await import("./coordinator-bootstrap-maintenance-service-runner.js");
  const { claimMaintenanceServiceEffect } =
    await import("./coordinator-bootstrap-maintenance-service-claim.js");
  const before = MaintenanceServiceJobSchema.parse(journal.readLifecycle()[0]);
  expect(before.effectIntent).toBeUndefined();
  const { record, assertCurrent, ...receipt } = observed;
  const admission = maintenanceServiceClaimAdmission({
    stateDirectory: claim.stateDirectory,
    evidence: {
      expectedRevision: before.revision,
      record,
      sha256: observed.evidenceSha256,
      assertCurrent,
    },
  });
  const settle = () =>
    journal.mutateLifecycle(
      (jobs) =>
        jobs.map((job) =>
          job.id === before.id
            ? {
                ...before,
                revision: randomUUID(),
                status: "failed",
                observation: receipt,
                evidence: [...before.evidence, { record, sha256: observed.evidenceSha256 }],
              }
            : job,
        ),
      admission,
    );
  if (mode === "native-unclaimed-race") {
    claimMaintenanceServiceEffect(claim);
    expect(() => observed.assertCurrent()).toThrow("Retained native observation changed");
    expect(MaintenanceServiceJobSchema.parse(journal.readLifecycle()[0]).effectIntent).toBeTruthy();
    const claimed = journal.readLifecycle();
    expect(settle).toThrow("Retained service authority or generation changed");
    expect(journal.readLifecycle()).toEqual(claimed);
    expect(commands).toHaveLength(0);
    return;
  }
  settle();
  const terminal = MaintenanceServiceJobSchema.parse(
    new FileBootstrapRequestJournal(claim.stateDirectory).readLifecycle()[0],
  );
  expect(terminal).toMatchObject({
    status: "failed",
    observation: { outcome: "previous", ready: true },
  });
  expect(terminal.reservation).toEqual(before.reservation);
  expect(terminal.approval).toEqual(before.approval);
  expect(() =>
    claimMaintenanceServiceEffect({ ...claim, expectedRevision: terminal.revision }),
  ).toThrow("unconsumed");
  expect(commands).toHaveLength(0);
  expect(journal.readLifecycle()).toEqual([terminal]);
}

async function verifyChildIdentityCases(
  invocation: Awaited<
    ReturnType<
      typeof import("./coordinator-bootstrap-maintenance-service-runner.js").readMaintenanceServiceInvocation
    >
  >,
  args: string[],
  lifetime: unknown,
) {
  const { inspectMaintenanceServiceChildIdentity } =
    await import("./coordinator-bootstrap-maintenance-service-runner.js");
  const { BootstrapProcessIdentitySchema } =
    await import("@getpaseo/protocol/coordinator-bootstrap");
  const selected = invocation.startup.selected;
  const argv = [
    selected.node.path,
    selected.entrypoint.path,
    selected.setup.path,
    "maintenance-service",
    ...args,
  ];
  const observation = {
    ...BootstrapProcessIdentitySchema.parse(lifetime),
    executable: selected.node.path,
    argumentsSha256: createHash("sha256").update(JSON.stringify(argv)).digest("hex"),
  };
  const runtime = {
    modulePath: path.join(
      selected.directory,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-maintenance-service-runner.js",
    ),
    executable: selected.node.path,
    argv,
    pid: observation.pid,
    parentPid: observation.parentPid,
    uid: observation.uid,
  };
  const input = { invocation, args, observation, runtime };
  expect(inspectMaintenanceServiceChildIdentity(input)).toEqual(observation);
  for (const changed of [
    { modulePath: "/unselected/module.js" },
    { executable: "/unselected/node" },
    { argv: [...argv, "extra"] },
    { pid: observation.pid + 1 },
    { parentPid: observation.parentPid + 1 },
    { uid: observation.uid + 1 },
  ])
    expect(() =>
      inspectMaintenanceServiceChildIdentity({ ...input, runtime: { ...runtime, ...changed } }),
    ).toThrow("outside its selected runtime");
  for (const changed of [{ argumentsSha256: "f".repeat(64) }, { executable: "/unselected/node" }])
    expect(() =>
      inspectMaintenanceServiceChildIdentity({
        ...input,
        observation: { ...observation, ...changed },
      }),
    ).toThrow("outside its selected runtime");
}

async function verifyTerminalObservation(
  observerInput: Parameters<
    typeof import("./coordinator-bootstrap-maintenance-service-native.js").observeMaintenanceServiceReplacement
  >[0],
  observedValue: import("./maintenance/service-execution.js").MaintenanceServiceNativeObservation,
  observed: import("./maintenance/service-execution.js").MaintenanceServiceNativeObservation,
) {
  const { observeMaintenanceServiceReplacement } =
    await import("./coordinator-bootstrap-maintenance-service-native.js");
  const { FileBootstrapRequestJournal } = await import("./coordinator-bootstrap-journal.js");
  const journal = new FileBootstrapRequestJournal(observerInput.stateDirectory);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  if (observedValue.outcome === "previous") {
    const afterExit = await observeMaintenanceServiceReplacement({
      ...observerInput,
      reader: {
        ...observerInput.reader,
        verifyProcessExited: async (pid) => {
          expect(pid).toBe(process.pid);
        },
      },
    });
    expect(afterExit.outcome).toBe("previous");
    expect(afterExit.ready).toBe(true);
    expect(observed.sourceCommit).toBeNull();
    expect(observed.record.native.process).toEqual(observedValue.record.native.process);
  }
  if (observedValue.outcome === "candidate") {
    const job = journal.readLifecycle()[0];
    if (!job || !("effectIntent" in job) || !job.effectIntent)
      throw new Error("Fixture intent missing");
    const observedAt = new Date(Date.parse(job.effectIntent.consumedAt) - 1).toISOString();
    const record = { ...observedValue.record, observedAt };
    await expect(
      observeMaintenanceServiceReplacement({
        ...observerInput,
        readObservation: async () => ({
          ...observedValue,
          observedAt,
          record,
          evidenceSha256: digest(JSON.stringify(record)),
        }),
      }),
    ).rejects.toThrow("predates its consumed intent");
  }
}

async function independentAccessFixture(enrollment: "shared" | "separate" = "shared") {
  const f = await fixture(enrollment === "separate");
  const ownerConfigurationFile = path.join(f.plan.identity.installationRoot, "recovery-owner.json");
  writeFileSync(
    ownerConfigurationFile,
    JSON.stringify({
      public: {
        installationId: f.plan.identity.installationId,
        origin: "https://app.example.test",
      },
      stateDir: f.enrollmentStateDirectory,
      ownerPasswordHash: hashSync("fixture-owner", 4),
    }),
    { mode: 0o600 },
  );
  for (const release of [f.plan.previous!, f.plan.candidate]) {
    release.entrypoint.path = path.join(
      release.directory,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-maintenance-recovery-access.js",
    );
    writeFileSync(release.entrypoint.path, "standalone fixture bytes", { mode: 0o600 });
    release.entrypoint.sha256 = createHash("sha256")
      .update("standalone fixture bytes")
      .digest("hex");
    const setup = JSON.parse(readFileSync(release.setup.path, "utf8"));
    setup.control = {
      admissionSha256: "d".repeat(64),
      recoveryAccess: {
        installationId: f.plan.identity.installationId,
        origin: "https://recovery.example.test:9443",
        listenPort: 4446,
        ownerConfigurationFile,
      },
    };
    const bytes = JSON.stringify(setup);
    writeFileSync(release.setup.path, bytes);
    release.setup.sha256 = createHash("sha256").update(bytes).digest("hex");
    release.artifactSha256 = await digestBootstrapArtifact(release.directory);
  }
  return { ...f, ownerConfigurationFile };
}

async function recoveryRoutingFixture() {
  const f = await independentAccessFixture();
  const bytes = JSON.stringify({
    TCP: { "44444": { HTTPS: true } },
    Web: {
      "machine.tail123.ts.net:44444": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:6770" } },
      },
    },
    ExtraFutureSetting: { retained: true },
  });
  const snapshot = path.join(f.plan.identity.stateDirectory, "previous-serve.json");
  writeFileSync(snapshot, bytes, { mode: 0o600 });
  f.plan.recoveryRoute = {
    tailscale: f.plan.candidate.node,
    previousServe: {
      path: snapshot,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
  for (const release of [f.plan.previous!, f.plan.candidate]) {
    const setup = JSON.parse(readFileSync(release.setup.path, "utf8"));
    setup.control.recoveryAccess.origin = "https://machine.tail123.ts.net:9443";
    const setupBytes = JSON.stringify(setup);
    writeFileSync(release.setup.path, setupBytes);
    release.setup.sha256 = createHash("sha256").update(setupBytes).digest("hex");
  }
  const setup = JSON.parse(readFileSync(f.plan.candidate.setup.path, "utf8"));
  return {
    ...f,
    routing: {
      access: { ...setup.control.recoveryAccess, origin: "https://machine.tail123.ts.net:9443" },
      backend: { BackendState: "Running", Self: { DNSName: "machine.tail123.ts.net." } },
      previousServe: JSON.parse(bytes),
      currentServe: JSON.parse(bytes),
    },
  };
}

test("recovery routing enters the exact plan digest and preserves every existing route", async () => {
  const f = await recoveryRoutingFixture();
  const inspected = await verifyMaintenanceLauncherArtifacts(f);
  const unbound = { ...f.plan };
  delete unbound.recoveryRoute;
  expect(inspected.planSha256).not.toBe(
    inspectMaintenanceLauncherPlan(unbound, f.account).planSha256,
  );
  const before = JSON.stringify(f.routing.currentServe);
  expect(inspectMaintenanceRecoveryRouting(f.routing)).toEqual({
    origin: f.routing.access.origin,
    arguments: ["serve", "--bg", "--https=9443", "http://127.0.0.1:4446"],
    previousServe: f.routing.previousServe,
  });
  await expect(prepareMaintenanceLauncherRouting({ ...f, ...f.routing })).resolves.toMatchObject({
    planSha256: inspected.planSha256,
    origin: f.routing.access.origin,
    arguments: ["serve", "--bg", "--https=9443", "http://127.0.0.1:4446"],
  });
  expect(JSON.stringify(f.routing.currentServe)).toBe(before);
  writeFileSync(f.plan.recoveryRoute!.previousServe.path, "{}");
  await expect(verifyMaintenanceLauncherArtifacts(f)).rejects.toThrow();
});

test.each(["tcp", "web", "funnel", "drift", "backend", "hostname", "public-name"])(
  "recovery routing refuses %s conflicts before producing a command",
  async (mode) => {
    const f = await recoveryRoutingFixture();
    const routing = f.routing;
    if (mode === "tcp") routing.currentServe.TCP["9443"] = { HTTPS: true };
    if (mode === "web") routing.currentServe.Web["other.tail123.ts.net:9443"] = { Handlers: {} };
    if (mode === "funnel")
      routing.currentServe.AllowFunnel = { "machine.tail123.ts.net:9443": false };
    if (mode === "drift") routing.currentServe.ExtraFutureSetting.retained = false;
    if (["tcp", "web", "funnel"].includes(mode))
      routing.previousServe = structuredClone(routing.currentServe);
    if (mode === "backend") routing.backend.BackendState = "Stopped";
    if (mode === "hostname") routing.backend.Self.DNSName = "other.tail123.ts.net.";
    if (mode === "public-name") {
      routing.backend.Self.DNSName = "public.example.test.";
      routing.access.origin = "https://public.example.test:9443";
    }
    expect(() => inspectMaintenanceRecoveryRouting(routing)).toThrow();
  },
);

test("recovery route configuration is refused on ordinary controller plans", async () => {
  const f = await fixture(false, true);
  f.plan.recoveryRoute = {
    tailscale: f.plan.candidate.node,
    previousServe: f.plan.candidate.setup,
  };
  expect(() => inspectMaintenanceLauncherPlan(f.plan, f.account)).toThrow(
    "standalone access launcher",
  );
});

test("recovery access has exact standalone argv and read-only OS supervision", async () => {
  const f = await independentAccessFixture();
  await expect(verifyMaintenanceLauncherArtifacts(f)).resolves.toMatchObject({ plan: f.plan });
  const launcher = maintenanceUserLauncher(f.plan, "candidate");
  expect(launcher.ProgramArguments).toEqual([
    f.plan.candidate.node.path,
    f.plan.candidate.entrypoint.path,
    f.plan.candidate.setup.path,
  ]);
  expect(launcher).toMatchObject({ RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10 });
  const { renderMaintenanceUserLauncher } =
    await import("./coordinator-bootstrap-maintenance-launcher.js");
  const { readBootstrapLauncher } = await import("./coordinator-bootstrap-service.js");
  const bytes = renderMaintenanceUserLauncher(f.plan, "candidate");
  const file = path.join(f.plan.identity.stateDirectory, "recovery-access.plist");
  writeFileSync(file, bytes, { mode: 0o600 });
  expect(
    await readBootstrapLauncher(
      { path: file, sha256: createHash("sha256").update(bytes).digest("hex") },
      [],
    ),
  ).toEqual(launcher);
  const observed = {
    pid: 4312,
    parentPid: 1,
    uid: f.account.uid,
    bootId: randomUUID(),
    startIdentity: "1000:12",
    executable: f.plan.candidate.node.path,
    argumentsSha256: createHash("sha256")
      .update(JSON.stringify(launcher.ProgramArguments))
      .digest("hex"),
  };
  const reader = {
    readService: async (service: string) => `${service} = {\n\tpid = ${observed.pid}\n}`,
    inspectProcess: async () => ({ ...observed }),
  };
  await expect(
    verifyMaintenanceLauncherProcess({ ...f, selected: "candidate", pid: observed.pid, reader }),
  ).resolves.toEqual(observed);
  observed.argumentsSha256 = createHash("sha256")
    .update(JSON.stringify([...launcher.ProgramArguments, "maintenance-launcher"]))
    .digest("hex");
  await expect(
    verifyMaintenanceLauncherProcess({ ...f, selected: "candidate", pid: observed.pid, reader }),
  ).rejects.toThrow("native identity");
});

test("recovery page scheduling is reviewed per slot without changing retained launchers", async () => {
  const f = await independentAccessFixture();
  const original = inspectMaintenanceLauncherPlan(f.plan, f.account);
  const previousLauncher = maintenanceUserLauncher(f.plan, "previous");
  expect(maintenanceUserLauncher(f.plan, "candidate").ProcessType).toBe("Background");
  f.plan.candidate.processType = "Interactive";
  const selected = inspectMaintenanceLauncherPlan(f.plan, f.account);
  expect(selected.planSha256).not.toBe(original.planSha256);
  expect(maintenanceUserLauncher(f.plan, "candidate")).toMatchObject({
    ProcessType: "Interactive",
    KeepAlive: true,
    ThrottleInterval: 10,
  });
  expect(maintenanceUserLauncher(f.plan, "previous")).toEqual(previousLauncher);
  await expect(verifyMaintenanceLauncherArtifacts(f)).resolves.toMatchObject({
    plan: selected.plan,
  });
});

test.each([false, true])(
  "interactive scheduling is refused outside the recovery page: controller=%s",
  async (controller) => {
    const f = await fixture(false, controller);
    f.plan.candidate.processType = "Interactive";
    expect(() => inspectMaintenanceLauncherPlan(f.plan, f.account)).toThrow(
      "standalone owner recovery page",
    );
  },
);

test.each([
  "installation",
  "state",
  "source",
  "missing-access",
  "primary-origin",
  "bookmark",
  "owner",
  "guest-owner",
  "controller",
  "entrypoint",
])("recovery access admission refuses changed %s binding", async (mode) => {
  const f = await independentAccessFixture();
  const release = f.plan.candidate;
  const setup = JSON.parse(readFileSync(release.setup.path, "utf8"));
  if (mode === "installation") setup.control.recoveryAccess.installationId = randomUUID();
  if (mode === "state") setup.enrollmentStateDirectory = f.account.home;
  if (mode === "source") setup.sourceCommit = "f".repeat(40);
  if (mode === "missing-access") delete setup.control.recoveryAccess;
  if (mode === "primary-origin") {
    for (const slot of [f.plan.previous!, release]) {
      const value = JSON.parse(readFileSync(slot.setup.path, "utf8"));
      value.control.recoveryAccess.origin = "https://app.example.test";
      const bytes = JSON.stringify(value);
      writeFileSync(slot.setup.path, bytes);
      slot.setup.sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    setup.control.recoveryAccess.origin = "https://app.example.test";
  }
  if (mode === "bookmark") setup.control.recoveryAccess.listenPort++;
  if (mode === "owner") {
    const owner = JSON.parse(readFileSync(f.ownerConfigurationFile, "utf8"));
    owner.public.installationId = randomUUID();
    writeFileSync(f.ownerConfigurationFile, JSON.stringify(owner));
  }
  if (mode === "controller") f.plan.identity.target = "maintenance-controller";
  if (mode === "entrypoint") {
    release.entrypoint.path = path.join(
      release.directory,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
    );
    release.entrypoint.sha256 = createHash("sha256")
      .update(readFileSync(release.entrypoint.path))
      .digest("hex");
  }
  const bytes = JSON.stringify(setup);
  writeFileSync(release.setup.path, bytes);
  release.setup.sha256 = createHash("sha256").update(bytes).digest("hex");
  await expect(
    verifyMaintenanceLauncherArtifacts({
      ...f,
      writableMountRoots:
        mode === "guest-owner" ? [f.ownerConfigurationFile] : f.writableMountRoots,
    }),
  ).rejects.toThrow();
});

test.each(["supported", "missing", "unsupported"] as const)(
  "recovery access executor contract binds reviewed runtime support: %s",
  async (mode) => {
    const f = await independentAccessFixture();
    const release = f.plan.candidate;
    const setup = JSON.parse(readFileSync(release.setup.path, "utf8"));
    setup.control.recoveryAccess.serviceExecutorVersion = 1;
    const setupBytes = JSON.stringify(setup);
    writeFileSync(release.setup.path, setupBytes);
    release.setup.sha256 = createHash("sha256").update(setupBytes).digest("hex");
    const metadata = path.join(release.directory, "packages/server/package.json");
    mkdirSync(path.dirname(metadata), { recursive: true, mode: 0o700 });
    const contracts: Record<string, number> = {};
    if (mode !== "missing") contracts.recoveryServiceExecutor = mode === "supported" ? 1 : 2;
    writeFileSync(metadata, JSON.stringify({ vorteoRuntimeContracts: contracts }), { mode: 0o600 });
    release.artifactSha256 = await digestBootstrapArtifact(release.directory);
    if (mode !== "supported") {
      await expect(verifyMaintenanceLauncherArtifacts(f)).rejects.toThrow();
      return;
    }
    await expect(verifyMaintenanceLauncherArtifacts(f)).resolves.toMatchObject({ plan: f.plan });
    expect(maintenanceUserLauncher(f.plan, "candidate").ProgramArguments).toEqual([
      release.node.path,
      release.entrypoint.path,
      release.setup.path,
    ]);
  },
);

test("recovery access retains a separate shared lifecycle directory", async () => {
  const f = await independentAccessFixture("separate");
  expect(f.enrollmentStateDirectory).not.toBe(f.plan.identity.stateDirectory);
  await expect(verifyMaintenanceLauncherArtifacts(f)).resolves.toMatchObject({ plan: f.plan });
});

test("recovery access listener cannot supply native executor authority", async () => {
  const f = await independentAccessFixture();
  const { inspectSelectedMaintenanceExecutor } =
    await import("./coordinator-bootstrap-maintenance-executor-evidence.js");
  await expect(
    inspectSelectedMaintenanceExecutor({
      setupFile: f.plan.candidate.setup.path,
      expectedTarget: "recovery-launcher",
      account: f.account,
      stateDirectory: f.enrollmentStateDirectory,
      writableMountRoots: [],
      ports: {
        reader: {
          async readService() {
            throw new Error("No native dispatch inspection expected");
          },
          async inspectProcess() {
            throw new Error("No native dispatch inspection expected");
          },
        },
        assertCurrent: () => undefined,
      },
    }),
  ).rejects.toThrow("does not provide lifecycle execution");
});

async function recoveryRegistrationFixture(mode = "ready", listenPort?: number) {
  const f = await recoveryRoutingFixture();
  if (listenPort !== undefined) {
    f.routing.access.listenPort = listenPort;
    for (const release of [f.plan.previous!, f.plan.candidate]) {
      const setup = JSON.parse(readFileSync(release.setup.path, "utf8"));
      setup.control.recoveryAccess.listenPort = listenPort;
      const bytes = JSON.stringify(setup);
      writeFileSync(release.setup.path, bytes);
      release.setup.sha256 = createHash("sha256").update(bytes).digest("hex");
    }
  }
  if (mode === "service-executor") {
    const release = f.plan.candidate;
    const setup = JSON.parse(readFileSync(release.setup.path, "utf8"));
    setup.control.recoveryAccess.serviceExecutorVersion = 1;
    const bytes = JSON.stringify(setup);
    writeFileSync(release.setup.path, bytes);
    release.setup.sha256 = createHash("sha256").update(bytes).digest("hex");
    const metadata = path.join(release.directory, "packages/server/package.json");
    mkdirSync(path.dirname(metadata), { recursive: true, mode: 0o700 });
    writeFileSync(
      metadata,
      JSON.stringify({ vorteoRuntimeContracts: { recoveryServiceExecutor: 1 } }),
      {
        mode: 0o600,
      },
    );
    release.artifactSha256 = await digestBootstrapArtifact(release.directory);
  }
  f.plan.previous = null;
  if (mode === "native-ports") prepareNativeRegistrationFixture(f);
  const {
    FileEnrollmentJournal,
    enrollInstallation,
    enrollmentManifestDigest,
    reserveActivationStep,
    changeStandingGrant,
  } = await import("./maintenance/authorization.js");
  const { FileBootstrapRequestJournal } = await import("./coordinator-bootstrap-journal.js");
  const inspected = inspectMaintenanceLauncherPlan(f.plan, f.account);
  const base = path.dirname(f.plan.identity.selectionPath!);
  const plans = path.join(base, "plans");
  mkdirSync(plans, { mode: 0o700 });
  writeFileSync(path.join(plans, `${inspected.planSha256}.json`), JSON.stringify(f.plan), {
    mode: 0o600,
  });
  retainEnrollmentNativeIdentity(f.enrollmentStateDirectory, f.plan.identity);
  const stepId = randomUUID();
  const manifest = {
    version: 1 as const,
    operation: "installation-enrollment" as const,
    installationId: f.plan.identity.installationId,
    revision: randomUUID(),
    createdAt: new Date().toISOString(),
    trustedRepositories: ["https://example.test/fixture"],
    provisioning: null,
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 5 },
    retryLimit: 3 as const,
    rollback: "previous-compatible-runtime" as const,
    recovery: "after-login" as const,
    targets: [
      {
        target: "recovery-launcher" as const,
        identitySha256: inspected.identitySha256,
        operations: ["replacement" as const],
      },
      {
        target: "maintenance-controller" as const,
        identitySha256: "a".repeat(64),
        operations: ["replacement" as const],
      },
      {
        target: "coordinator" as const,
        identitySha256: "b".repeat(64),
        operations: ["replacement" as const],
      },
    ],
    steps: [
      {
        id: stepId,
        target: "recovery-launcher" as const,
        operation: "replacement" as const,
        planSha256: inspected.planSha256,
        candidate: {
          sourceCommit: f.plan.candidate.sourceCommit,
          artifactSha256: f.plan.candidate.artifactSha256,
        },
        previous: null,
        dependsOn: [],
      },
    ],
  };
  const enrollment = new FileEnrollmentJournal(f.enrollmentStateDirectory);
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
  if (enrolled.status !== "enrolled") throw new Error("Fixture enrollment absent");
  const reserved = reserveActivationStep(enrollment, {
    grantRevision: enrolled.grant.revision,
    stepId,
  });
  if (reserved.status !== "enrolled" || reserved.activation.steps[0].status !== "reserved")
    throw new Error("Fixture reservation absent");
  const bootstrap = new FileBootstrapRequestJournal(f.enrollmentStateDirectory);
  const revoke = () =>
    changeStandingGrant(enrollment, {
      expectedRevision: enrolled.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
  const commands: string[][] = [];
  let registered = false;
  let revoked = false;
  let serve = structuredClone(f.routing.previousServe);
  const native = {
    pid: 43123,
    parentPid: 1,
    uid: f.account.uid,
    bootId: randomUUID(),
    startIdentity: "1000:42",
    executable: f.plan.candidate.node.path,
    argumentsSha256: createHash("sha256")
      .update(JSON.stringify(maintenanceUserLauncher(f.plan, "candidate").ProgramArguments))
      .digest("hex"),
  };
  const ports: RecoveryRegistrationPorts = {
    reader: {
      async readService(service) {
        if (!registered) throw new Error("Fixture service absent");
        return `${service} = {\n\tpid = ${native.pid}\n}`;
      },
      async inspectProcess(pid) {
        if (!registered || pid !== native.pid) throw new Error("Fixture process absent");
        return { ...native };
      },
    },
    async readRouting() {
      const observed = {
        backend: structuredClone(f.routing.backend),
        serve: structuredClone(serve),
      };
      return {
        ...observed,
        assertCurrent() {
          if (mode === "route-custody-after-start" && registered)
            throw new Error("Fixture routing custody changed");
          expect({ backend: f.routing.backend, serve }).toEqual(observed);
        },
      };
    },
    assertAbsent() {
      expect(() => bootstrap.withRecoveryTransaction(() => undefined)).toThrow("storage is busy");
      if (registered) throw new Error("Fixture service is already present");
    },
    async inspectListener({ process: observedProcess }) {
      bootstrap.withRecoveryTransaction(() => undefined);
      expect(observedProcess).toEqual(native);
      if (mode === "revoke-after-start" && !revoked) {
        revoke();
        revoked = true;
      }
      if (mode === "route-drift-after-start") serve.ExtraFutureSetting.retained = false;
      return {
        assertCurrent() {
          if (!registered) throw new Error("Fixture listener custody changed");
          expect(observedProcess).toEqual(native);
        },
      };
    },
    async run(executable, args) {
      bootstrap.withRecoveryTransaction(() => undefined);
      commands.push([executable, ...args]);
      if (executable === "/bin/launchctl") {
        expect(args).toEqual([
          "bootstrap",
          f.plan.identity.serviceDomain,
          f.plan.identity.launcherPath,
        ]);
        expect(registered).toBe(false);
        registered = true;
        if (mode === "lost-start") throw new Error("Lost start reply");
      } else {
        expect(executable).toBe(f.plan.recoveryRoute!.tailscale.path);
        expect(args).toEqual(["serve", "--bg", "--https=9443", "http://127.0.0.1:4446"]);
        serve.TCP["9443"] = { HTTPS: true };
        serve.Web["machine.tail123.ts.net:9443"] = {
          Handlers: { "/": { Proxy: "http://127.0.0.1:4446" } },
        };
        if (mode === "lost-route") throw new Error("Lost route reply");
      }
    },
  };
  const input = {
    ...f,
    grantId: enrolled.grant.id,
    grantRevision: enrolled.grant.revision,
    stepId,
    generation: reserved.activation.steps[0].generation,
    assertCurrent: () => undefined,
  };
  const intent = () => {
    const file = path.join(
      f.enrollmentStateDirectory,
      `maintenance-launcher-${stepId}-${input.generation}.json`,
    );
    return { file, intent: JSON.parse(readFileSync(file, "utf8")) };
  };
  return { ...f, input, ports, commands, enrollment, reserved, revoke, intent };
}

test("reviewed recovery page executor retains its selected native and runtime custody", async () => {
  const f = await recoveryRegistrationFixture("service-executor");
  await activateMaintenanceRecoveryAccess(f.input, f.ports);
  const { inspectSelectedMaintenanceExecutor } =
    await import("./coordinator-bootstrap-maintenance-executor-evidence.js");
  const input = {
    setupFile: f.plan.candidate.setup.path,
    account: f.account,
    stateDirectory: f.enrollmentStateDirectory,
    writableMountRoots: [],
    ports: { reader: f.ports.reader, assertCurrent: () => undefined },
  };
  await expect(inspectSelectedMaintenanceExecutor(input)).rejects.toThrow("required enrolled role");
  const executor = await inspectSelectedMaintenanceExecutor({
    ...input,
    expectedTarget: "recovery-launcher",
  });
  expect(executor.executor.target).toBe("recovery-launcher");
  expect(executor.executor.entrypoint).toEqual(f.plan.candidate.entrypoint);
  expect(executor.executor.native.process).toMatchObject({ pid: 43123, parentPid: 1 });
  executor.assertCurrent();
  expect(f.commands).toHaveLength(2);
  writeFileSync(path.join(f.plan.candidate.directory, "packages/server/package.json"), "{}");
  expect(executor.assertCurrent).toThrow();
  expect(f.commands).toHaveLength(2);
});

function prepareNativeRegistrationFixture(f: Awaited<ReturnType<typeof recoveryRoutingFixture>>) {
  const state = f.plan.identity.stateDirectory;
  const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const pin = (file: string, bytes: Buffer | string, mode = 0o600) => {
    writeFileSync(file, bytes, { mode });
    return { path: file, sha256: digest(bytes) };
  };
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const helper = pin(
    path.join(state, "inspector.py"),
    readFileSync(path.resolve("scripts/inspect-coordinator-process.py")),
  );
  const containerId = "d".repeat(64);
  const dockerState = pin(
    path.join(state, "docker.json"),
    JSON.stringify({ Id: containerId, State: { Running: true }, Mounts: [] }),
  );
  const docker = pin(
    path.join(state, "docker-fixture"),
    `#!/usr/bin/env bash\nexec /bin/cat ${quote(dockerState.path)}\n`,
    0o700,
  );
  const backend = pin(
    path.join(state, "tailscale-backend.json"),
    JSON.stringify(f.routing.backend),
  );
  const serve = f.plan.recoveryRoute!.previousServe;
  f.plan.recoveryRoute!.tailscale = pin(
    path.join(state, "tailscale-fixture"),
    `#!/usr/bin/env bash\nif [ "$1" = serve ]; then exec /bin/cat ${quote(serve.path)}; fi\nexec /bin/cat ${quote(backend.path)}\n`,
    0o700,
  );
  const admission = pin(
    path.join(state, "admission.json"),
    JSON.stringify({
      configurationFile: f.ownerConfigurationFile,
      launcherFile: f.plan.identity.launcherPath,
      docker: docker.path,
      socket: path.join(state, "docker.sock"),
      containerId,
      helperPath: helper.path,
      helperSha256: helper.sha256,
    }),
  );
  const setup = JSON.parse(readFileSync(f.plan.candidate.setup.path, "utf8"));
  setup.nativeAdmission = admission;
  f.plan.candidate.setup = pin(f.plan.candidate.setup.path, JSON.stringify(setup));
}

test.skipIf(process.platform !== "darwin")(
  "native recovery activation refuses a port conflict before consuming the enrollment effect",
  async () => {
    const server = createServer((_request, response) => response.end("fixture"));
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture socket unavailable");
    try {
      const f = await recoveryRegistrationFixture("native-ports", address.port);
      const ports = await createNativeRecoveryRegistrationPorts(f.input, []);
      const before = f.enrollment.read();
      await expect(activateMaintenanceRecoveryAccess(f.input, ports)).rejects.toThrow(
        "Recovery loopback port is unavailable or unverified",
      );
      expect(f.enrollment.read()).toEqual(before);
      expect(f.intent).toThrow();
      expect(fileExists(f.plan.identity.launcherPath!)).toBe(false);
      expect(fileExists(f.plan.identity.selectionPath!)).toBe(false);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "native recovery registration ports require an intent and preserve revoked observation",
  async () => {
    const f = await recoveryRegistrationFixture("native-ports");
    const ports = await createNativeRecoveryRegistrationPorts(f.input, []);
    const observed = await ports.readRouting(f.plan.recoveryRoute!.tailscale.path);
    expect(observed.serve).toEqual(f.routing.previousServe);
    observed.assertCurrent();
    await expect(
      ports.run(
        "/bin/launchctl",
        ["bootstrap", f.plan.identity.serviceDomain, f.plan.identity.launcherPath],
        () => undefined,
      ),
    ).rejects.toThrow();
    expect(f.intent).toThrow();
    f.revoke();
    const reopened = await createNativeRecoveryRegistrationPorts(f.input, []);
    expect((await reopened.readRouting(f.plan.recoveryRoute!.tailscale.path)).serve).toEqual(
      f.routing.previousServe,
    );
    expect(f.commands).toEqual([]);
  },
);

test("recovery route observation rejects unrelated changes and public exposure", async () => {
  const f = await recoveryRoutingFixture();
  const selected = structuredClone(f.routing.currentServe);
  selected.TCP["9443"] = { HTTPS: true };
  selected.Web["machine.tail123.ts.net:9443"] = {
    Handlers: { "/": { Proxy: "http://127.0.0.1:4446" } },
  };
  const observe = () =>
    verifyMaintenanceRecoveryRouteSelection({ ...f.routing, currentServe: selected });
  expect(observe()).toEqual({ origin: f.routing.access.origin, ready: true });
  selected.AllowFunnel = { "machine.tail123.ts.net:9443": false };
  expect(observe().ready).toBe(true);
  selected.AllowFunnel["machine.tail123.ts.net:9443"] = true;
  expect(observe).toThrow("public exposure");
  selected.AllowFunnel["machine.tail123.ts.net:9443"] = false;
  selected.ExtraFutureSetting.retained = false;
  expect(observe).toThrow("Unrelated private routing changed");
});

test("initial recovery registration consumes one existing activation intent and never replays", async () => {
  const f = await recoveryRegistrationFixture();
  const result = await activateMaintenanceRecoveryAccess(f.input, f.ports);
  expect(result).toMatchObject({
    listenerAndRouteVerified: true,
    ownerRemoteAcceptance: false,
    process: { pid: 43123 },
  });
  expect(f.commands).toHaveLength(2);
  expect(f.enrollment.read()).toEqual(f.reserved);
  const retained = f.intent();
  const before = readFileSync(retained.file);
  await expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow();
  expect(f.commands).toHaveLength(2);
  expect(readFileSync(retained.file)).toEqual(before);
});

test("initial recovery registration observes exec and listener startup without repeating effects", async () => {
  const f = await recoveryRegistrationFixture();
  const inspect = f.ports.reader.inspectProcess;
  const inspectListener = f.ports.inspectListener;
  let processChecks = 0;
  let listenerChecks = 0;
  f.ports.reader.inspectProcess = async (pid) => {
    processChecks++;
    if (processChecks === 1) throw new Error("Fixture exec identity is not stable yet");
    return inspect(pid);
  };
  f.ports.inspectListener = async (input) => {
    listenerChecks++;
    if (listenerChecks === 1) throw new Error("Fixture loopback socket is not ready yet");
    return inspectListener(input);
  };
  const result = await activateMaintenanceRecoveryAccess(f.input, f.ports);
  expect(result.listenerAndRouteVerified).toBe(true);
  expect(processChecks).toBe(7);
  expect(listenerChecks).toBe(3);
  expect(f.commands.map((command) => command[0])).toEqual([
    "/bin/launchctl",
    f.plan.recoveryRoute!.tailscale.path,
  ]);
  expect(f.enrollment.read()).toEqual(f.reserved);
});

test("initial recovery startup timeout retains its intent without a route or repeated start", async () => {
  const f = await recoveryRegistrationFixture();
  let started: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.ports.reader.inspectProcess = async () => {
    started();
    throw new Error("Fixture process never establishes native custody");
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const outcome = expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow(
    "deadline elapsed",
  );
  await waiting;
  const retained = f.intent();
  const before = readFileSync(retained.file);
  await vi.advanceTimersByTimeAsync(60_001);
  await outcome;
  expect(f.commands.map((command) => command[0])).toEqual(["/bin/launchctl"]);
  expect(readFileSync(retained.file)).toEqual(before);
  expect(f.enrollment.read()).toEqual(f.reserved);
  await expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow();
  expect(f.commands.map((command) => command[0])).toEqual(["/bin/launchctl"]);
});

test("initial recovery startup wait does not authorize routing after revocation", async () => {
  const f = await recoveryRegistrationFixture();
  const inspect = f.ports.reader.inspectProcess;
  let first = true;
  f.ports.reader.inspectProcess = async (pid) => {
    if (first) {
      first = false;
      f.revoke();
      throw new Error("Fixture exec was incomplete when the owner revoked authority");
    }
    return inspect(pid);
  };
  await expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow();
  expect(f.commands.map((command) => command[0])).toEqual(["/bin/launchctl"]);
  const before = readFileSync(f.intent().file);
  await expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow();
  expect(readFileSync(f.intent().file)).toEqual(before);
  expect(f.commands.map((command) => command[0])).toEqual(["/bin/launchctl"]);
});

test("selected recovery listener supplies review custody without executor authority", async () => {
  const f = await recoveryRegistrationFixture();
  const result = await reconcileRecoveryAccessActivation(f.input, f.ports);
  const { inspectSelectedMaintenanceRecoveryAccess, inspectSelectedMaintenanceExecutor } =
    await import("./coordinator-bootstrap-maintenance-executor-evidence.js");
  let changed = false;
  const input = {
    setupFile: f.plan.candidate.setup.path,
    account: f.account,
    stateDirectory: f.enrollmentStateDirectory,
    writableMountRoots: [],
    ports: {
      reader: f.ports.reader,
      assertCurrent() {
        if (changed) throw new Error("Fixture native lifetime changed");
      },
    },
  };
  const commands = structuredClone(f.commands);
  const journal = readFileSync(
    path.join(f.enrollmentStateDirectory, "maintenance-enrollment.json"),
  );
  const reviewed = await inspectSelectedMaintenanceRecoveryAccess(input);
  expect(reviewed.process).toEqual(result.process);
  expect(reviewed.access).toEqual(f.routing.access);
  expect(reviewed).not.toHaveProperty("executor");
  reviewed.assertCurrent();
  f.revoke();
  const revoked = readFileSync(
    path.join(f.enrollmentStateDirectory, "maintenance-enrollment.json"),
  );
  expect(revoked).not.toEqual(journal);
  const afterRevocation = await inspectSelectedMaintenanceRecoveryAccess(input);
  expect(afterRevocation.process).toEqual(reviewed.process);
  expect(
    readFileSync(path.join(f.enrollmentStateDirectory, "maintenance-enrollment.json")),
  ).toEqual(revoked);
  await expect(inspectSelectedMaintenanceExecutor(input)).rejects.toThrow(
    "does not provide lifecycle execution",
  );
  changed = true;
  expect(afterRevocation.assertCurrent).toThrow("native lifetime changed");
  expect(f.commands).toEqual(commands);
});

test("one-generation recovery activation settles its reserved step and observes after revocation", async () => {
  const f = await recoveryRegistrationFixture();
  const result = await reconcileRecoveryAccessActivation(f.input, f.ports);
  expect(result.activationSettled).toBe(true);
  const settled = f.enrollment.read();
  if (settled.status !== "enrolled") throw new Error("Fixture enrollment missing");
  const step = settled.activation.steps[0];
  if (step.status !== "succeeded") throw new Error("Activation not settled");
  const receipt = readFileSync(
    path.join(f.enrollmentStateDirectory, `maintenance-observation-${step.observationSha256}.json`),
    "utf8",
  );
  expect(createHash("sha256").update(receipt).digest("hex")).toBe(step.observationSha256);
  expect(JSON.parse(receipt).intent.generation).toBe(f.input.generation);
  const commands = structuredClone(f.commands);
  f.revoke();
  const revoked = f.enrollment.read();
  const observed = await reconcileRecoveryAccessActivation(f.input, f.ports);
  expect(observed.activationSettled).toBe(true);
  expect(f.commands).toEqual(commands);
  expect(f.enrollment.read()).toEqual(revoked);
});

test("recovery activation reconciles a lost route response without repeating effects", async () => {
  const f = await recoveryRegistrationFixture("lost-route");
  await expect(reconcileRecoveryAccessActivation(f.input, f.ports)).rejects.toThrow(
    "Lost route reply",
  );
  const commands = structuredClone(f.commands);
  f.revoke();
  expect((await reconcileRecoveryAccessActivation(f.input, f.ports)).activationSettled).toBe(true);
  expect(f.commands).toEqual(commands);
});

test("recovery activation keeps a lost start response unverified without retrying routing", async () => {
  const f = await recoveryRegistrationFixture("lost-start");
  await expect(reconcileRecoveryAccessActivation(f.input, f.ports)).rejects.toThrow(
    "Lost start reply",
  );
  const commands = structuredClone(f.commands);
  await expect(reconcileRecoveryAccessActivation(f.input, f.ports)).rejects.toThrow();
  expect(f.commands).toEqual(commands);
  const state = f.enrollment.read();
  expect(state.status === "enrolled" && state.activation.steps[0].status).toBe("reserved");
});

test("recovery activation preserves failed history when a retained generation becomes verified", async () => {
  const f = await recoveryRegistrationFixture("lost-route");
  await expect(reconcileRecoveryAccessActivation(f.input, f.ports)).rejects.toThrow(
    "Lost route reply",
  );
  const { observeActivationStep } = await import("./maintenance/authorization.js");
  const failedState = observeActivationStep(f.enrollment, {
    stepId: f.input.stepId,
    generation: f.input.generation,
    outcome: "recovery_required",
    observationSha256: "e".repeat(64),
  });
  if (failedState.status !== "enrolled") throw new Error("Fixture enrollment absent");
  const commands = structuredClone(f.commands);
  f.revoke();
  const revoked = f.enrollment.read();
  expect((await reconcileRecoveryAccessActivation(f.input, f.ports)).activationSettled).toBe(true);
  const reconciled = f.enrollment.read();
  if (reconciled.status !== "enrolled" || revoked.status !== "enrolled")
    throw new Error("Fixture enrollment absent");
  expect(reconciled.activation.recoveries[0].failed).toEqual(failedState.activation.steps[0]);
  expect(reconciled.activation.steps[0].status).toBe("succeeded");
  expect(reconciled.grant).toEqual(revoked.grant);
  expect(f.commands).toEqual(commands);
});

test("recovery activation rejects another generation before reserving or dispatching", async () => {
  const f = await recoveryRegistrationFixture();
  const before = f.enrollment.read();
  await expect(
    reconcileRecoveryAccessActivation({ ...f.input, generation: randomUUID() }, f.ports),
  ).rejects.toThrow("exact activation");
  expect(f.enrollment.read()).toEqual(before);
  expect(f.intent).toThrow();
  expect(f.commands).toEqual([]);
});

test("recovery activation refuses a malformed retained intent without granting another attempt", async () => {
  const f = await recoveryRegistrationFixture("lost-start");
  await expect(reconcileRecoveryAccessActivation(f.input, f.ports)).rejects.toThrow();
  const retained = f.intent();
  writeFileSync(retained.file, "{", { mode: 0o600 });
  const commands = structuredClone(f.commands);
  await expect(reconcileRecoveryAccessActivation(f.input, f.ports)).rejects.toThrow();
  expect(f.commands).toEqual(commands);
});

test("recovery activation accepts only four immutable enrollment identifiers", () => {
  const args = Array.from({ length: 4 }, () => randomUUID());
  expect(inspectRecoveryActivationInvocation(args)).toEqual({
    grantId: args[0],
    grantRevision: args[1],
    stepId: args[2],
    generation: args[3],
  });
  expect(() => inspectRecoveryActivationInvocation([...args, "/other/plan"])).toThrow();
  expect(() => inspectRecoveryActivationInvocation(["/other/plan", ...args.slice(1)])).toThrow();
});

test.each([
  "success",
  "lost-reply",
  "lost-before-intent",
  "revoked-before-reservation",
  "async-custody",
  "dependency-missing",
] as const)(
  "combined enrollment launches recovery once before coordinator migration: %s",
  async (mode) => {
    const f = await recoveryRegistrationFixture();
    const { enrollmentManifestDigest } = await import("./maintenance/authorization.js");
    const { FileBootstrapRequestJournal } = await import("./coordinator-bootstrap-journal.js");
    const coordinatorStepId = randomUUID();
    const seeded = f.enrollment.update((current) => {
      if (current.status !== "enrolled") throw new Error("Fixture enrollment absent");
      const manifest = {
        ...current.grant.manifest,
        provisioning: { admissionSha256: "e".repeat(64), coordinatorStepId },
        steps: [
          ...current.grant.manifest.steps,
          {
            ...current.grant.manifest.steps[0],
            id: coordinatorStepId,
            target: "coordinator" as const,
            dependsOn: mode === "dependency-missing" ? [] : [f.input.stepId],
          },
        ],
      };
      const digest = enrollmentManifestDigest(manifest);
      return {
        ...current,
        grant: {
          ...current.grant,
          manifest,
          approval: { ...current.grant.approval, manifestSha256: digest },
        },
        activation: {
          ...current.activation,
          manifestSha256: digest,
          steps: manifest.steps.map((step) => ({ id: step.id, status: "pending" as const })),
        },
      };
    });
    if (seeded.status !== "enrolled") throw new Error("Fixture enrollment absent");
    let launches = 0;
    let observations = 0;
    const settle = async (
      invocation: Parameters<typeof inspectRecoveryActivationInvocation>[0],
      options?: { observationOnly: true },
    ) => {
      observations++;
      const exact = inspectRecoveryActivationInvocation(invocation);
      return reconcileRecoveryAccessActivation({ ...f.input, ...exact }, f.ports, options);
    };
    const ports = {
      async prepare() {
        if (mode === "revoked-before-reservation") f.revoke();
        return {
          assertCurrent() {
            expect(() =>
              new FileBootstrapRequestJournal(f.enrollmentStateDirectory).withRecoveryTransaction(
                () => undefined,
              ),
            ).toThrow("storage is busy");
            if (mode === "async-custody") return Promise.resolve();
          },
          async launch(invocation: readonly string[]) {
            launches++;
            if (mode === "lost-before-intent") throw new Error("Lost child launch reply");
            await settle(invocation);
            if (mode === "lost-reply") throw new Error("Lost child launch reply");
          },
          observe: (invocation: readonly string[]) => settle(invocation, { observationOnly: true }),
        };
      },
    };
    const input = {
      journal: f.enrollment,
      manifestSha256: seeded.grant.approval.manifestSha256,
      coordinatorStepId,
    };
    if (
      mode === "revoked-before-reservation" ||
      mode === "async-custody" ||
      mode === "dependency-missing"
    ) {
      await expect(activateRecoveryBeforeCoordinator(input, ports)).rejects.toThrow();
      expect(launches).toBe(0);
      const current = f.enrollment.read();
      expect(current.status === "enrolled" && current.activation.steps[0].status).toBe("pending");
      expect(f.commands).toEqual([]);
      return;
    }
    if (mode === "lost-before-intent") {
      await expect(activateRecoveryBeforeCoordinator(input, ports)).rejects.toThrow("Lost child");
      const file = path.join(f.enrollmentStateDirectory, "maintenance-enrollment.json");
      const before = readFileSync(file);
      await expect(activateRecoveryBeforeCoordinator(input, ports)).rejects.toThrow(
        "launch is uncertain",
      );
      expect(launches).toBe(1);
      expect(observations).toBe(1);
      expect(f.commands).toEqual([]);
      expect(readFileSync(file)).toEqual(before);
      return;
    }
    if (mode === "lost-reply")
      await expect(activateRecoveryBeforeCoordinator(input, ports)).rejects.toThrow("Lost child");
    else await activateRecoveryBeforeCoordinator(input, ports);
    f.revoke();
    await activateRecoveryBeforeCoordinator(input, ports);
    expect(launches).toBe(1);
    expect(observations).toBe(2);
    const current = f.enrollment.read();
    expect(current.status === "enrolled" && current.activation.steps[0].status).toBe("succeeded");
    expect(current.status === "enrolled" && current.activation.steps[1].status).toBe("pending");
    expect(f.commands.map((command) => command[0])).toEqual([
      "/bin/launchctl",
      f.plan.recoveryRoute!.tailscale.path,
    ]);
  },
);

test.each([
  "lost-start",
  "lost-route",
  "revoke-after-start",
  "route-drift-after-start",
  "route-custody-after-start",
])("initial recovery registration retains uncertain %s without a second effect", async (mode) => {
  const f = await recoveryRegistrationFixture(mode);
  await expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow();
  const retained = f.intent();
  const count = f.commands.length;
  await expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow();
  expect(f.commands).toHaveLength(count);
  if (mode === "lost-route") {
    f.revoke();
    const before = readFileSync(retained.file);
    const observed = await observeMaintenanceRecoveryAccessRegistration(f.input, f.ports, retained);
    expect(observed.listenerAndRouteVerified).toBe(true);
    expect(f.commands).toHaveLength(count);
    expect(readFileSync(retained.file)).toEqual(before);
  } else {
    await expect(
      observeMaintenanceRecoveryAccessRegistration(f.input, f.ports, retained),
    ).rejects.toThrow();
    expect(f.commands).toHaveLength(count);
  }
});

test("initial recovery registration rejects revocation before creating an intent", async () => {
  const f = await recoveryRegistrationFixture();
  f.revoke();
  await expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow(
    "Standing grant",
  );
  expect(f.commands).toEqual([]);
  expect(f.intent).toThrow();
});

test("initial recovery registration rejects asynchronous absence proof", async () => {
  const f = await recoveryRegistrationFixture();
  f.ports.assertAbsent = async () => undefined;
  await expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow(
    "synchronous native absence",
  );
  expect(f.commands).toEqual([]);
  expect(f.intent).toThrow();
});

test("initial recovery registration expires hanging preparation without a late dispatch", async () => {
  const f = await recoveryRegistrationFixture();
  let releaseRouting: (
    value: Awaited<ReturnType<RecoveryRegistrationPorts["readRouting"]>>,
  ) => void = () => {
    throw new Error("Fixture routing not waiting");
  };
  let started: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.ports.readRouting = () =>
    new Promise((resolve) => {
      releaseRouting = resolve;
      started();
    });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const outcome = expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow(
    "deadline elapsed",
  );
  await waiting;
  await vi.advanceTimersByTimeAsync(60_001);
  await outcome;
  releaseRouting({
    backend: f.routing.backend,
    serve: f.routing.previousServe,
    assertCurrent: () => undefined,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(f.commands).toEqual([]);
  expect(f.intent).toThrow();
});

test("initial recovery registration timeout retains a dispatched generation without a late route", async () => {
  const f = await recoveryRegistrationFixture();
  const run = f.ports.run;
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.ports.run = async (executable, args, assertWithinDeadline) => {
    await run(executable, args, assertWithinDeadline);
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const outcome = expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow(
    "deadline elapsed",
  );
  await waiting;
  const retained = f.intent();
  const before = readFileSync(retained.file);
  await vi.advanceTimersByTimeAsync(60_001);
  await outcome;
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.commands).toHaveLength(1);
  expect(readFileSync(retained.file)).toEqual(before);
  await expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow();
  expect(f.commands).toHaveLength(1);
});

test("initial recovery registration observation expires without a new effect", async () => {
  const f = await recoveryRegistrationFixture();
  await activateMaintenanceRecoveryAccess(f.input, f.ports);
  const retained = f.intent();
  let release: (value: { assertCurrent(): void }) => void = () => undefined;
  let started: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.ports.inspectListener = () =>
    new Promise((resolve) => {
      release = resolve;
      started();
    });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const outcome = expect(
    observeMaintenanceRecoveryAccessRegistration(f.input, f.ports, retained),
  ).rejects.toThrow("deadline elapsed");
  await waiting;
  await vi.advanceTimersByTimeAsync(10_001);
  await outcome;
  release({ assertCurrent: () => undefined });
  await Promise.resolve();
  await Promise.resolve();
  expect(f.commands).toHaveLength(2);
  expect(f.enrollment.read()).toEqual(f.reserved);
});

test("initial recovery registration forbids late native dispatch validation", async () => {
  const f = await recoveryRegistrationFixture();
  const run = f.ports.run;
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.ports.run = async (executable, args, assertWithinDeadline) => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    assertWithinDeadline();
    await run(executable, args, assertWithinDeadline);
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const outcome = expect(activateMaintenanceRecoveryAccess(f.input, f.ports)).rejects.toThrow(
    "deadline elapsed",
  );
  await waiting;
  const retained = f.intent();
  await vi.advanceTimersByTimeAsync(60_001);
  await outcome;
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.commands).toEqual([]);
  expect(f.intent()).toEqual(retained);
});
