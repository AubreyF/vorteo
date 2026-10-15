import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import { inspectMaintenanceLauncherSelection } from "./coordinator-bootstrap-maintenance-selection.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import { retainEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import { enrollmentNativeIdentityDigest } from "./maintenance/native-identity.js";
import {
  inspectMaintenanceLauncherPlan,
  maintenanceUserLauncher,
  verifyMaintenanceLauncherArtifacts,
  verifyMaintenanceLauncherProcess,
  type MaintenanceLauncherPlan,
} from "./coordinator-bootstrap-maintenance-launcher.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(separateEnrollment = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "maintenance-slots-")));
  roots.push(root);
  const state = path.join(root, "state");
  const enrollmentStateDirectory = separateEnrollment
    ? path.join(root, "coordinator-state")
    : state;
  const home = path.join(root, "home");
  const base = path.join(root, "maintenance-services/recovery-launcher");
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
    return { path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
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
      target: "recovery-launcher",
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
      nativeAdmission: { path: path.join(state, "native-admission.json"), sha256: "a".repeat(64) },
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
  const service = `${f.plan.identity.environment === "host" ? f.plan.identity.serviceDomain : ""}/${f.plan.identity.environment === "host" ? f.plan.identity.serviceLabel : ""}`;
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
        return `${service} = {\n\tpid = ${pid}\n${mode === "ambiguous-service" ? "\tpid = 9999\n" : ""}}`;
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
  };
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
