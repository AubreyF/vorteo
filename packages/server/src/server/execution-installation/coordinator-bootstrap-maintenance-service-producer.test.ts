import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchRetainedMaintenanceService } from "./coordinator-bootstrap-maintenance-service-producer.js";

const roots: string[] = [];
afterEach(() => {
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
