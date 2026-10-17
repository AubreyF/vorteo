import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import pathApi from "node:path";
import * as fs from "node:fs";
import { runInNewContext } from "node:vm";
import { isDeepStrictEqual } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
// Exercise the allocated source schema without rebuilding or touching shared declarations.
vi.mock(
  "@getpaseo/protocol/execution-installation",
  () => import("../../../../../protocol/src/execution-installation.js"),
);
import {
  RestartJobSchema,
  SupervisorEffectSchema,
  type RestartJob,
  type SupervisorEffectChild,
  type SupervisorEffectObservation,
} from "@getpaseo/protocol/execution-installation";
import { InstallationConfigSchema } from "../config.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import { readBootstrapPreparedFile } from "../coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { assertCoordinatorLifecycleIdle } from "../coordinator-bootstrap.js";
import { createStandingRestartAdapter } from "./restart-adapter.js";
import {
  inspectLifecycleActivationChild,
  type LifecycleActivationChild,
} from "../coordinator-bootstrap-maintenance-child.js";
import {
  FileEnrollmentJournal,
  enrollInstallation,
  reserveActivationStep,
  enrollmentManifestDigest,
  changeStandingGrant,
} from "./authorization.js";
import type { InstallationEnrollmentManifest } from "@getpaseo/protocol/installation-enrollment";
import { evaluateStandingRestart, standingRestartPlanDigest } from "./restart-admission.js";
import { InstallationRestarts } from "../restarts.js";
import {
  DevRegistrationReceiptSchema,
  prepareDevRegistrationPublication,
  publishDevRegistration,
} from "./dev-registration.js";
import {
  prepareDevRegistrationProvisioner,
  prepareDevRegistrationC1Documents,
  devRegistrationC1Receipt,
  verifyRetainedDevRegistrationProvisioner,
  DevRegistrationProvisionerInputSchema,
  devRegistrationLinuxArtifactDigest,
} from "./dev-registration-provisioner.js";
import {
  executeDevRegistration,
  assertDevRegistrationEffectAdmission,
  devRegistrationReservationDigest,
  devRegistrationAuthorityDigest,
  type DevRegistrationExecutionCandidate,
  type DevRegistrationExecutionPorts,
  type DevRegistrationExecutionPreflight,
  type DevRegistrationExecutionObservation,
  type DevRegistrationExecutionChildProof,
} from "./dev-registration-execution.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const FACTORY_ENTRY =
  "const candidate = '/fixture/factory-candidate';\nvoid [candidate + '/modules/factory/launch.py', '/fixture/linux-node/bin/node', '/fixture/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js', candidate + '/runtime.mjs'];\n";
const FACTORY_LAUNCHER =
  "def launch(options):\n    for path in [options.supervisor_entry]:\n        if path == options.node:\n            pass\n        else:\n            physical(path)\n";
function staticInput() {
  const file = (path: string, content: string) => ({
    path,
    content,
    sha256: hash(content),
    size: Buffer.byteLength(content),
  });
  const linuxArtifact = {
    algorithm: "vorteo-container-artifact-v1",
    platform: "linux",
    arch: "arm64",
    root: "/opt/vorteo-managed-releases/prepared-linux",
    sourceCommit: "2".repeat(40),
    artifactSha256: "3".repeat(64),
    entries: [
      { kind: "directory", path: "", mode: 0o40755 },
      { kind: "directory", path: "packages", mode: 0o40755 },
      { kind: "directory", path: "packages/server", mode: 0o40755 },
      { kind: "directory", path: "packages/server/dist", mode: 0o40755 },
      { kind: "directory", path: "packages/server/dist/scripts", mode: 0o40755 },
      {
        kind: "file",
        path: "packages/server/dist/scripts/supervisor-entrypoint.js",
        mode: 0o100644,
        sha256: hash("fixture supervisor"),
        size: 18,
      },
      { kind: "directory", path: "packages/server/dist/server", mode: 0o40755 },
      { kind: "directory", path: "packages/server/dist/server/server", mode: 0o40755 },
      {
        kind: "file",
        path: "packages/server/dist/server/server/daemon-worker.js",
        mode: 0o100644,
        sha256: hash("fixture worker"),
        size: 14,
      },
    ],
  };
  linuxArtifact.artifactSha256 = devRegistrationLinuxArtifactDigest(linuxArtifact);
  const parent = {
    pid: 7,
    parentPid: 1,
    uid: 0,
    gid: 0,
    bootId: "fixture-boot",
    startIdentity: "5113560",
    executable: "/usr/bin/python3.11",
    argumentsSha256: "4".repeat(64),
  };
  return DevRegistrationProvisionerInputSchema.parse({
    installationId: "a3ed817e-d9f4-40c4-8409-5948c4d6b35c",
    preparationNonce: "2fd5c9ab-e74a-4cd1-98fe-47715955740a",
    hostInspector: {
      path: "/host/audited-inspector.py",
      sha256: hash("fixture read-only inspector"),
      size: Buffer.byteLength("fixture read-only inspector"),
    },
    configurationFile: "/host/coordinator.json",
    hostReceiptFile: "/host/dev-registration.json",
    docker: {
      path: "/host/docker",
      socket: "/host/docker.sock",
      containerId: "5".repeat(64),
      sha256: hash("reviewed Docker fixture"),
      size: 23,
    },
    startup: {
      path: "/usr/bin/tini",
      args: ["--", "/bin/bash", "/opt/personal-tailscale/entrypoint"],
      entrypoint: ["/usr/bin/tini", "--", "/bin/bash", "/opt/personal-tailscale/entrypoint"],
      cmd: null,
    },
    account: {
      user: "paseo",
      uid: 1000,
      gid: 1000,
      home: "/home/paseo",
      stateDirectory: "/home/paseo/.paseo",
    },
    requiredCapability: "reviewed-dev-root-registration-and-parent-observation-v1",
    systemPython: { path: "/usr/bin/python3.11", sha256: "6".repeat(64), size: 100 },
    node: {
      path: "/fixture/linux-node/bin/node",
      sha256: "7".repeat(64),
      size: 200,
      platform: "linux",
      arch: "arm64",
    },
    supervisor: {
      ...parent,
      pid: 101,
      parentPid: 7,
      uid: 1000,
      gid: 1000,
      executable: "/fixture/linux-node/bin/node",
      startIdentity: "132361430",
    },
    parent,
    startupFiles: [
      "/opt/personal-tailscale/entrypoint",
      "/etc/personal-tailscale/supervisord.conf",
      "/opt/personal-tailscale/start-paseo",
      "/usr/local/bin/paseo-docker-entrypoint",
    ].map((path) => ({ path, sha256: "8".repeat(64), size: 100 })),
    originalPointer: file("/etc/paseo-server-entry", "/fixture/bootstrap/factory-main-entry.mjs\n"),
    factoryEntry: file("/fixture/bootstrap/factory-main-entry.mjs", FACTORY_ENTRY),
    factoryLauncher: file("/fixture/factory-candidate/modules/factory/launch.py", FACTORY_LAUNCHER),
    originalSupervisorEntrypoint:
      "/fixture/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js",
    originalFactoryRuntime: "/fixture/factory-candidate/runtime.mjs",
    selectionPath: "/opt/vorteo-managed-releases/current",
    releaseRoot: "/opt/vorteo-managed-releases",
    linuxArtifact,
    originalLinuxArtifact: { ...linuxArtifact, root: "/fixture/bootstrap" },
    factoryRuntime: {
      path: "/fixture/factory-candidate/runtime.mjs",
      sha256: "9".repeat(64),
      size: 100,
    },
  });
}

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(historical = false, c1First = !historical) {
  const directory = realpathSync(mkdtempSync(pathApi.join(tmpdir(), "dev-execution-test-")));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const before = staticInput();
  const helper = Buffer.from("fixture audited inspector, never executed");
  const configFile = pathApi.join(directory, "config.json"),
    receiptFile = pathApi.join(directory, "registration.json"),
    scriptFile = pathApi.join(directory, "registration.mjs");
  const inspector = pathApi.join(directory, "inspector.py");
  const fixtureNode = pathApi.join(directory, "node");
  const rollbackScriptFile = pathApi.join(directory, "registration-rollback.mjs");
  writeFileSync(inspector, helper, { mode: 0o600 });
  // Real immutable generated bytes precede every job/grant/manifest identifier.
  const dockerFile = pathApi.join(directory, "docker");
  writeFileSync(dockerFile, "reviewed Docker fixture", { mode: 0o600 });
  const pinned = prepareDevRegistrationProvisioner({
    ...before,
    docker: { ...before.docker, path: dockerFile },
    configurationFile: configFile,
    ...(c1First
      ? {
          c1First: {
            format: "c1-first-v1",
            configurationFiles: {
              original: pathApi.join(directory, "original.json"),
              replacement: configFile,
              rollback: pathApi.join(directory, "rollback.json"),
              selected: pathApi.join(directory, "selected.json"),
            },
            preparedReceiptFile: pathApi.join(directory, "prepared-receipt.json"),
            scripts: { node: fixtureNode, replacement: scriptFile, rollback: rollbackScriptFile },
            startupReceiptRoles: {
              containerEntrypoint: before.startupFiles[0],
              supervisorConfiguration: before.startupFiles[1],
              profileLauncher: before.startupFiles[2],
              dockerEntrypoint: before.startupFiles[3],
            },
          },
        }
      : {}),
    hostReceiptFile: receiptFile,
    hostInspector: { path: inspector, sha256: hash(helper), size: helper.length },
  });
  const provisioner = historical ? v682Postimage(pinned) : pinned;
  writeFileSync(scriptFile, provisioner.script, { mode: 0o600 });
  writeFileSync(rollbackScriptFile, provisioner.rollback.script, { mode: 0o600 });
  const p = provisioner.plan;
  const file = (name: string) => ({ path: "/protected/" + name, sha256: "d".repeat(64) });
  const receipt = c1First
    ? devRegistrationC1Receipt(provisioner)
    : DevRegistrationReceiptSchema.parse({
        version: 1,
        purpose: "dev-persistent-registration",
        installationId: p.installationId,
        containerId: p.docker.containerId,
        startup: p.startup,
        account: p.account,
        supervisorPlanSha256: provisioner.sha256,
        launcherPath: p.originalPointer.path,
        selectionPath: p.selectionPath,
        releaseRoot: p.releaseRoot,
        selectionCustody: "configured-dev-user",
        parentArgumentsSha256: p.parent.argumentsSha256,
        files: {
          containerEntrypoint: file("entry"),
          supervisorConfiguration: file("config"),
          profileLauncher: file("profile"),
          dockerEntrypoint: file("docker"),
          entrySelection: { path: p.originalPointer.path, sha256: hash(p.pointerContent) },
          factoryEntrypoint: { path: p.files[0].path, sha256: p.files[0].sha256 },
          factoryLauncher: { path: p.files[1].path, sha256: p.files[1].sha256 },
          supervisorEntrypoint: file("supervisor"),
          parentExecutable: { path: p.parent.executable, sha256: p.systemPython.sha256 },
          node: { path: p.protectedNode, sha256: p.node.sha256 },
        },
      });
  writeFileSync(fixtureNode, "fixture Node bytes", { mode: 0o700 });
  let config = InstallationConfigSchema.parse({
    public: {
      version: 1,
      installationId: p.installationId,
      origin: "https://fixture.example",
      environments: [
        { kind: "host", serverId: "host", useTls: true, endpoint: "https://host.example" },
        { kind: "container", serverId: "dev", useTls: true, endpoint: "https://dev.example" },
      ],
    },
    listenPort: 6767,
    webDistDir: "/web",
    stateDir: directory,
    ownerPasswordHash: "$2fixture",
    hostAgentTokenHash: "1".repeat(64),
    containerAgentTokenHash: "2".repeat(64),
    host: {
      endpoint: "127.0.0.1:6767",
      password: "fixture",
      launchdService: "gui/501/local.vorteo.fixture",
    },
    container: {
      endpoint: "127.0.0.1:6768",
      password: "fixture",
      supervisorMaintenance: { node: "/host/node", script: scriptFile, sha256: provisioner.sha256 },
    },
    containerSourceUpdates: {
      sourceRepository: "/source",
      toolingDirectory: "/tooling",
      integrationRef: "refs/heads/main",
      receiptFile: "/host/source.json",
      docker: p.docker.path,
      containerId: p.docker.containerId,
      user: p.account.user,
      node: p.node.path,
      home: p.account.stateDirectory,
      releaseRoot: p.releaseRoot,
      currentReleaseLink: p.selectionPath,
    },
  });
  let documents;
  if (c1First) {
    const original = structuredClone(config);
    delete original.container.supervisorMaintenance;
    const originalBytes = Buffer.from(JSON.stringify(original));
    documents = prepareDevRegistrationC1Documents({
      provisioner,
      original: {
        path: provisioner.plan.c1First!.configurationFiles.original,
        bytes: originalBytes,
        sha256: hash(originalBytes),
        parsed: original,
      },
      replacementScript: {
        path: scriptFile,
        bytes: Buffer.from(provisioner.script),
        sha256: provisioner.sha256,
      },
      rollbackScript: {
        path: rollbackScriptFile,
        bytes: Buffer.from(provisioner.rollback.script),
        sha256: provisioner.rollback.sha256,
      },
      hostNode: fixtureNode,
    });
    for (const document of Object.values(documents))
      writeFileSync(document.path, document.bytes, { mode: 0o600 });
    config = documents.replacement.parsed;
  }
  const bytes = Buffer.from(JSON.stringify(config));
  writeFileSync(configFile, bytes, { mode: 0o600 });
  const job: RestartJob = RestartJobSchema.parse({
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    requester: "fixture",
    target: "container-daemon",
    reason: "Exact Dev registration",
    createdAt: "2026-10-17T00:00:00.000Z",
    expiresAt: "9999-12-31T23:59:59.999Z",
    status: "running",
    detail: "fixture",
    approvedAt: "2026-10-17T00:00:01.000Z",
    supervisorPlanSha256: provisioner.sha256,
    whenIdle: true,
    finishCurrentTurns: true,
  });
  const planSha256 = standingRestartPlanDigest(job),
    stepId = randomUUID();
  const manifest: InstallationEnrollmentManifest = {
    version: 1,
    operation: "installation-enrollment",
    installationId: before.installationId,
    revision: randomUUID(),
    createdAt: job.createdAt,
    targets: [
      {
        target: "maintenance-controller",
        identitySha256: "a".repeat(64),
        operations: ["replacement"],
      },
      { target: "recovery-launcher", identitySha256: "b".repeat(64), operations: ["replacement"] },
      { target: "supervisor", identitySha256: "c".repeat(64), operations: ["replacement"] },
    ],
    trustedRepositories: ["https://example.test/repository"],
    provisioning: null,
    interruption: { finishTurnsSeconds: 600, terminateGraceSeconds: 30 },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    steps: [
      {
        id: stepId,
        target: "supervisor",
        operation: "replacement",
        planSha256,
        candidate: {
          sourceCommit: before.linuxArtifact.sourceCommit,
          artifactSha256: before.linuxArtifact.artifactSha256,
        },
        previous: null,
        dependsOn: [],
      },
    ],
  };
  const enrollment = new FileEnrollmentJournal(directory);
  const enrolled = enrollInstallation(enrollment, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: job.approvedAt!,
    },
  });
  if (enrolled.status !== "enrolled") throw Error("Fixture enrollment absent");
  const state = reserveActivationStep(enrollment, {
    grantRevision: enrolled.grant.revision,
    stepId,
  });
  if (state.status !== "enrolled") throw Error("Fixture reservation absent");
  const evaluated = evaluateStandingRestart({
    state,
    job,
    installationId: before.installationId,
    nativeIdentitySha256: "c".repeat(64),
    repository: null,
    credentialBindingSha256: "f".repeat(64),
  });
  if (!evaluated?.activationStep) throw Error("Fixture standing admission absent");
  job.standingDecision = { ...evaluated, requestRevision: job.revision };
  job.standingHold = {
    generation: randomUUID(),
    grantRevision: state.grant.revision,
    decisionSha256: digest(job.standingDecision),
    reservedAt: job.createdAt,
    observedAt: job.approvedAt,
  };
  const child: LifecycleActivationChild = {
    grantId: state.grant.id,
    grantRevision: state.grant.revision,
    manifestSha256: enrollmentManifestDigest(manifest),
    stepId,
    generation: evaluated.activationStep.generation,
    requestId: job.id,
    requestRevision: job.revision,
    planSha256,
    target: "supervisor",
  };
  const journal = new FileBootstrapRequestJournal(directory);
  journal.mutateLifecycle(
    () => [job],
    (_previous, next) => {
      inspectLifecycleActivationChild(child, enrollment.readUnderLifecycleLock(), next);
      return undefined;
    },
    child,
  );
  const candidate: DevRegistrationExecutionCandidate = {
    operation: "replace",
    provisioner,
    publication: {
      ...(documents ? { documents, registrationPlanSha256: provisioner.planSha256 } : {}),
      config,
      configurationFile: configFile,
      configurationBytes: bytes,
      configurationSha256: hash(bytes),
      receiptFile,
      receipt,
      protectedSourceCommit: p.linuxArtifact.sourceCommit,
    },
    publicationAttemptFile: c1First
      ? receiptFile + ".publication-attempt-" + p.preparationNonce + ".json"
      : pathApi.join(directory, "publication-attempt.json"),
  };
  const supervisor = {
    pid: 101,
    parentPid: 7,
    uid: 1000,
    gid: 1000,
    bootId: "fixture-boot",
    startIdentity: "101",
    executable: p.protectedNode,
    argumentsSha256: "e".repeat(64),
  };
  const worker = { ...supervisor, pid: 102, parentPid: 101, startIdentity: "102" };
  const readiness = {
    phase: "native-and-authenticated-ready",
    installationId: p.installationId,
    containerId: p.docker.containerId,
    account: p.account,
    startup: p.startup,
    supervisor,
    worker,
    supervisorEntrypoint: receipt.files.supervisorEntrypoint.path,
    selectedRelease: p.releaseRoot + "/one",
    sourceCommit: p.linuxArtifact.sourceCommit,
    authenticated: { serverId: "dev", workerPid: worker.pid, workerInstanceId: "fixture-instance" },
    registration: {
      files: receipt.files,
      entrySelection: receipt.files.factoryEntrypoint.path,
      selectionPath: p.selectionPath,
      selectedRelease: p.releaseRoot + "/one",
      parent: {
        pid: p.parent.pid,
        parentPid: p.parent.parentPid,
        uid: 0,
        bootId: supervisor.bootId,
        startIdentity: p.parent.startIdentity,
        executable: p.parent.executable,
        argumentsSha256: p.parent.argumentsSha256,
      },
    },
  };
  const controller = {
    pid: 301,
    parentPid: 1,
    uid: process.getuid!(),
    bootId: randomUUID(),
    startIdentity: "1:1",
    argumentsSha256: "a".repeat(64),
    auditToken: [0, 1, 2, 3, 4, 5, 6, 7],
    executable: { path: "/host/node", sha256: "b".repeat(64) },
    entrypoint: { path: "/host/controller", sha256: "c".repeat(64) },
    artifactSha256: "d".repeat(64),
  };
  const effectChild = {
    ...controller,
    pid: 302,
    parentPid: controller.pid,
    startIdentity: "2:1",
    executable: { path: fixtureNode, sha256: hash("fixture Node bytes") },
    entrypoint: { path: scriptFile, sha256: provisioner.sha256 },
  };
  let nativeInvocation = false,
    launches = 0,
    invocations = 0,
    observations = 0,
    childClaim: SupervisorEffectChild | null = null;
  let lostLaunch = false,
    lostInvocation = false,
    nativeMissing = false,
    settled = true;
  const proof: DevRegistrationExecutionPreflight = {
    ...(documents
      ? {
          selectedConfiguration: {
            path: documents.selected.path,
            sha256: documents.selected.sha256,
          },
        }
      : {}),
    controller,
    nativeIdentitySha256: "c".repeat(64),
    preconditionSha256: "a".repeat(64),
    settlementSha256: "b".repeat(64),
    assertCurrent() {
      if (nativeMissing) throw Error("Fixture independent native proof absent");
    },
  };
  const ports: DevRegistrationExecutionPorts = {
    async preflight() {
      return proof;
    },
    async launch(reservation) {
      launches++;
      if (lostLaunch) throw Error("Lost gated launch acknowledgement");
      childClaim = {
        reservationSha256: devRegistrationReservationDigest(reservation),
        executor: effectChild,
        acknowledgedAt: "2026-10-17T00:00:03.000Z",
      };
      return {
        claim: childClaim,
        assertCurrent() {
          expect(childClaim?.executor.pid).toBe(302);
        },
      };
    },
    invoke(effect) {
      invocations++;
      expect(journal.readLifecycle()[0]).toMatchObject({ supervisorEffect: effect });
      expect(() =>
        new FileBootstrapRequestJournal(directory).withRecoveryTransaction(() => undefined),
      ).toThrow("storage is busy");
      nativeInvocation = true;
      const selected = { ...config, container: { ...config.container } };
      delete selected.container.supervisorMaintenance;
      writeFileSync(
        p.hostAttemptFile,
        JSON.stringify({
          ...(documents ? { version: 2 } : {}),
          planSha256: provisioner.planSha256,
          claimSha256: devRegistrationAuthorityDigest(effect),
          jobId: job.id,
          scriptSha256: provisioner.sha256,
          configurationSha256: digest(selected),
          ...(documents
            ? {
                documents: Object.fromEntries(
                  Object.entries(documents).map(([name, item]) => [
                    name,
                    { path: item.path, sha256: item.sha256 },
                  ]),
                ),
              }
            : {}),
          receiptAbsent: true,
        }),
        { mode: 0o600 },
      );
      if (lostInvocation) throw Error("Lost root invocation acknowledgement");
    },
    async observe(effect) {
      observations++;
      const published =
        existsSync(candidate.publicationAttemptFile) &&
        existsSync(receiptFile) &&
        readFileSync(documents?.selected.path ?? configFile).equals(
          prepareDevRegistrationPublication({ ...candidate.publication, readiness })
            .configurationBytes,
        );
      const prepared = prepareDevRegistrationPublication({ ...candidate.publication, readiness });
      let outcome: SupervisorEffectObservation["outcome"] = "unresolved";
      if (nativeInvocation) outcome = published ? "published" : "candidate-ready-unpublished";
      const record: SupervisorEffectObservation = {
        observedAt: "2026-10-17T00:00:04.000Z",
        evidenceSha256: "9".repeat(64),
        outcome,
        settled: nativeInvocation && settled,
        publication: published
          ? {
              receiptSha256: prepared.reference.sha256,
              configurationSha256: prepared.configurationSha256,
            }
          : null,
      };
      return {
        controller,
        child: childClaim,
        record,
        nativeResult: nativeInvocation
          ? {
              claimSha256: devRegistrationAuthorityDigest(effect),
              planSha256: provisioner.planSha256,
              jobId: job.id,
              scriptSha256: provisioner.sha256,
              operation: "replace",
              phase: "started-unverified",
              rootExecutor: {
                pid: 401,
                parentPid: 1,
                uid: 0,
                gid: 0,
                bootId: p.parent.bootId,
                startIdentity: "401",
                executable: p.systemPython.path,
                argumentsSha256: "4".repeat(64),
              },
            }
          : null,
        readiness: nativeInvocation ? readiness : null,
        assertCurrent() {
          if (nativeMissing) throw Error("Fixture independent native observation absent");
        },
      };
    },
  };
  const input = {
    directory,
    requestId: job.id,
    candidate,
    credentialBindingSha256: "f".repeat(64),
    ports,
    now: () => "2026-10-17T00:00:02.000Z",
  };
  return {
    directory,
    journal,
    enrollment,
    manifest,
    job,
    candidate,
    child,
    controller,
    effectChild,
    readiness,
    input,
    counts: () => ({ launches, invocations, observations }),
    setLostLaunch: () => {
      lostLaunch = true;
    },
    setLostInvocation: () => {
      lostInvocation = true;
    },
    setMissing: () => {
      nativeMissing = true;
    },
    setUnsettled: () => {
      settled = false;
    },
    revoke: () =>
      changeStandingGrant(enrollment, {
        expectedRevision: state.grant.revision,
        paused: false,
        disabledTargets: [],
        revoke: true,
      }),
  };
}

test("real tuple prepares bytes before request/manifest/enrollment and consumes both controller and actual fixture child", async () => {
  const f = fixture(),
    before = f.candidate.provisioner.script;
  const selected = f.candidate.publication.documents!.selected;
  const selectedIdentity = fs.lstatSync(selected.path, { bigint: true }).ino;
  const result = await executeDevRegistration(f.input);
  expect(fs.lstatSync(selected.path, { bigint: true }).ino).toBe(selectedIdentity);
  expect(readFileSync(selected.path)).toEqual(selected.bytes);
  expect(result.effect.phase).toBe("observed");
  if (result.effect.phase !== "observed") throw Error("Observation absent");
  expect(result.effect.observation.outcome).toBe("published");
  expect(f.counts()).toMatchObject({ launches: 1, invocations: 1 });
  expect(f.candidate.provisioner.script).toBe(before);
  expect(f.candidate.provisioner.plan).not.toHaveProperty("activation");
  expect(f.candidate.provisioner.plan).not.toHaveProperty("jobId");
  expect(result.effect.binding.manifestSha256).toBe(enrollmentManifestDigest(f.manifest));
  expect(result.effect.binding.requestPlanSha256).toBe(standingRestartPlanDigest(f.job));
  expect(result.effect.child?.executor.pid).toBe(302);
  expect(result.effect.binding.controller.pid).toBe(301);
  const configured = JSON.parse(
    readFileSync(
      f.candidate.publication.documents?.selected.path ?? f.candidate.publication.configurationFile,
      "utf8",
    ),
  );
  expect(configured.containerSourceUpdates.node).toBe(f.candidate.provisioner.plan.protectedNode);
  expect(configured.containerSourceUpdates.currentReleaseLink).toBe(
    f.candidate.publication.config.containerSourceUpdates?.currentReleaseLink,
  );
  await executeDevRegistration(f.input);
  expect(f.counts()).toMatchObject({ launches: 1, invocations: 1 });
});
test("guarded Dev publication invalidates shared selected coordinator configuration bytes and lifetime", async () => {
  const f = fixture(false, false);
  const { publication, provisioner } = f.candidate;
  const selectedConfiguration = {
    path: publication.configurationFile,
    sha256: publication.configurationSha256,
  };
  const assertSelectedCurrent = retainServiceFiles([selectedConfiguration.path]);
  const originalIdentity = fs.lstatSync(selectedConfiguration.path, { bigint: true });
  const originalBytes = await readBootstrapPreparedFile(selectedConfiguration, []);
  const runningConfiguration = InstallationConfigSchema.parse(
    JSON.parse(originalBytes.toString("utf8")),
  );
  const prepared = prepareDevRegistrationPublication({ ...publication, readiness: f.readiness });
  expect(prepared.configurationFile).toBe(selectedConfiguration.path);
  expect(prepared.previousConfigurationSha256).toBe(selectedConfiguration.sha256);
  expect(prepared.configurationSha256).not.toBe(selectedConfiguration.sha256);
  expect(prepared.receiptBytes).toEqual(Buffer.from(JSON.stringify(publication.receipt)));
  expect(hash(provisioner.script)).toBe(provisioner.sha256);
  expect(readFileSync(runningConfiguration.container.supervisorMaintenance!.script, "utf8")).toBe(
    provisioner.script,
  );

  // Exercise the filesystem transaction, not the fixture's injected native success.
  // The local guard holds the real journal lock and retains C0; it grants no native authority.
  f.journal.withRecoveryTransaction(() => {
    publishDevRegistration({
      prepared,
      attemptFile: f.candidate.publicationAttemptFile,
      reservationSha256: provisioner.planSha256,
      assertCurrent() {
        assertSelectedCurrent();
        expect(readFileSync(selectedConfiguration.path)).toEqual(originalBytes);
      },
    });
  });

  const finalBytes = readFileSync(selectedConfiguration.path);
  const finalConfiguration = InstallationConfigSchema.parse(
    JSON.parse(finalBytes.toString("utf8")),
  );
  expect(finalBytes).toEqual(prepared.configurationBytes);
  expect(readFileSync(prepared.receiptFile)).toEqual(prepared.receiptBytes);
  expect(finalConfiguration).toEqual({
    ...runningConfiguration,
    containerSourceUpdates: {
      ...runningConfiguration.containerSourceUpdates,
      node: provisioner.plan.protectedNode,
    },
    container: { ...runningConfiguration.container, persistentRegistration: prepared.reference },
  });
  expect(fs.lstatSync(selectedConfiguration.path, { bigint: true }).ino).not.toBe(
    originalIdentity.ino,
  );
  await expect(readBootstrapPreparedFile(selectedConfiguration, [])).rejects.toThrow(
    "Prepared document digest changed",
  );
  expect(assertSelectedCurrent).toThrow("Native service file custody changed");
  expect(runningConfiguration).toEqual(publication.config);
  expect(runningConfiguration.container.persistentRegistration).toBeUndefined();
  expect(f.counts()).toEqual({ launches: 0, invocations: 0, observations: 0 });
});
test.each(["launch", "invocation"])(
  "lost %s reply reopens only observation without a second effect",
  async (phase) => {
    const f = fixture();
    if (phase === "launch") f.setLostLaunch();
    else f.setLostInvocation();
    await executeDevRegistration(f.input);
    await executeDevRegistration(f.input);
    expect(f.counts()).toMatchObject({ launches: 1, invocations: phase === "launch" ? 0 : 1 });
    expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
  },
);
test("observing a gated child after lost acknowledgement cannot create consumed authority", async () => {
  const f = fixture(),
    launch = f.input.ports.launch;
  f.input.ports.launch = async (...args) => {
    await launch(...args);
    throw Error("Lost acknowledgement after gated child exists");
  };
  const result = await executeDevRegistration(f.input);
  expect(result.effect.phase).toBe("observed");
  if (result.effect.phase !== "observed") throw Error("Observation absent");
  expect(result.effect.child?.executor.pid).toBe(302);
  expect(result.effect.consumedAt).toBeNull();
  expect(() => devRegistrationAuthorityDigest(result.effect)).toThrow(
    "no consumed child authority",
  );
  reopen(f);
  await executeDevRegistration(f.input);
  expect(() =>
    f.journal.mutateLifecycle(
      (previous) => {
        const next = structuredClone([...previous]),
          item = next[0];
        if (item.target !== "container-daemon" || item.supervisorEffect?.phase !== "observed")
          throw Error("Observation absent");
        item.supervisorEffect.consumedAt = "2026-10-17T00:00:05.000Z";
        return next;
      },
      (previous, next) => {
        assertDevRegistrationEffectAdmission({ previous, next, assertObservation() {} });
        return undefined;
      },
    ),
  ).toThrow("Observation cannot create or replace consumption");
  await executeDevRegistration(f.input);
  expect(f.counts()).toMatchObject({ launches: 1, invocations: 0 });
});
test("missing independent proof refuses before reservation or launch", async () => {
  const f = fixture();
  f.setMissing();
  await expect(executeDevRegistration(f.input)).rejects.toThrow("proof absent");
  expect(f.counts()).toMatchObject({ launches: 0, invocations: 0 });
  expect(f.journal.readLifecycle()[0]).not.toHaveProperty("supervisorEffect");
});

function reopen(f: ReturnType<typeof fixture>) {
  return new InstallationRestarts(
    {
      read: () => f.journal.readLifecycle(),
      write: (next) =>
        f.journal.writeLifecycle(next, (previous, after) => {
          assertDevRegistrationEffectAdmission({ previous, next: after });
          return undefined;
        }),
    },
    {
      restart: async () => {
        throw Error("No restart may run in this source fixture");
      },
    },
  );
}
test("legacy recovery retains a consumed effect on failed parent and reopening has no effects", async () => {
  const f = fixture();
  f.setLostInvocation();
  await executeDevRegistration(f.input);
  const retained = f.journal.readLifecycle()[0];
  reopen(f);
  expect(f.journal.readLifecycle()[0]).toMatchObject({
    status: "failed",
    supervisorEffect:
      retained.target === "container-daemon" ? retained.supervisorEffect : undefined,
  });
  const result = await executeDevRegistration(f.input);
  expect(result.recorded).toBe(true);
  expect(f.counts()).toMatchObject({ launches: 1, invocations: 1 });
  expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
});

test.each(["write", "mutate"] as const)(
  "production lifecycle %s refuses competing effects behind a failed unsettled registration",
  async (operation) => {
    const f = fixture();
    f.setLostInvocation();
    f.setUnsettled();
    await executeDevRegistration(f.input);
    reopen(f);
    const adapter = createStandingRestartAdapter({
      directory: f.directory,
      installationId: f.manifest.installationId,
      credentialBindingSha256: "f".repeat(64),
      ports: {
        evidence: () => null,
        assertEvidence() {
          throw Error("No new native admission may occur");
        },
      },
    });
    const file = pathApi.join(f.directory, "restart-jobs.json");
    const before = readFileSync(file);
    const competitor: RestartJob = {
      ...f.job,
      id: randomUUID(),
      revision: randomUUID(),
      status: "approved",
      reason: "Competing ordinary maintenance",
    };
    const append = () => {
      if (operation === "write") adapter.journal.write([...adapter.journal.read(), competitor]);
      else adapter.journal.mutate!((previous) => [...previous, competitor]);
    };
    expect(() => append()).toThrow(
      "Unsettled supervisor executor fences competing lifecycle effects",
    );
    expect(readFileSync(file)).toEqual(before);
    expect(f.counts()).toMatchObject({ launches: 1, invocations: 1 });
  },
);

test("coordinator admission retains a failed registration until its exact settlement is terminal", async () => {
  const f = fixture();
  f.setLostInvocation();
  f.setUnsettled();
  const result = await executeDevRegistration(f.input);
  const failed: RestartJob = {
    ...f.job,
    status: "failed",
    finishCurrentTurns: false,
    holdReleased: true,
    supervisorEffect: result.effect,
  };
  expect(() => assertCoordinatorLifecycleIdle([failed])).toThrow("unresolved installation work");
  const settled = structuredClone(failed);
  if (settled.supervisorEffect?.phase !== "observed") throw Error("Fixture observation absent");
  settled.supervisorEffect.observation = {
    ...settled.supervisorEffect.observation,
    settled: true,
    outcome: "stopped",
  };
  expect(() => assertCoordinatorLifecycleIdle([settled])).not.toThrow();
});
test("two real journal consumers reserve one dispatch only", async () => {
  const f = fixture();
  f.setLostLaunch();
  const results = await Promise.allSettled([
    executeDevRegistration(f.input),
    executeDevRegistration(f.input),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(f.counts()).toMatchObject({ launches: 1, invocations: 0 });
});
test("revocation between gated launch and consumption prevents root invocation", async () => {
  const f = fixture(),
    launch = f.input.ports.launch;
  f.input.ports.launch = async (...args) => {
    const proof = await launch(...args);
    f.revoke();
    return proof;
  };
  await executeDevRegistration(f.input);
  await executeDevRegistration(f.input);
  expect(f.counts()).toMatchObject({ launches: 1, invocations: 0 });
  expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
});
test("revocation after root outcome prevents publication and permits only observation", async () => {
  const f = fixture(),
    observe = f.input.ports.observe;
  let revoked = false;
  f.input.ports.observe = async (...args) => {
    const observation = await observe(...args);
    if (!revoked) {
      revoked = true;
      f.revoke();
    }
    return observation;
  };
  await executeDevRegistration(f.input);
  reopen(f);
  await executeDevRegistration(f.input);
  expect(f.counts()).toMatchObject({ launches: 1, invocations: 1 });
  expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
});
test("unsettled native child or workload cannot publish or release reservation", async () => {
  const f = fixture();
  f.setUnsettled();
  const result = await executeDevRegistration(f.input);
  expect(result.effect.phase).toBe("observed");
  if (result.effect.phase !== "observed") throw Error("Observation absent");
  expect(result.effect.observation.settled).toBe(false);
  expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
});
test.each(["reserve", "publication"])(
  "lost %s journal reply never repeats launch or root effect",
  async (phase) => {
    const f = fixture(),
      real = FileBootstrapRequestJournal.prototype.mutateLifecycle;
    let mutations = 0;
    const call = vi
      .spyOn(FileBootstrapRequestJournal.prototype, "mutateLifecycle")
      .mockImplementation(function (
        this: FileBootstrapRequestJournal,
        ...args: Parameters<typeof real>
      ) {
        mutations++;
        real.apply(this, args);
        if (mutations === (phase === "reserve" ? 1 : 4)) throw Error("Lost durable journal reply");
      });
    if (phase === "reserve")
      await expect(executeDevRegistration(f.input)).rejects.toThrow("Lost durable journal reply");
    else await executeDevRegistration(f.input);
    call.mockRestore();
    reopen(f);
    const result = await executeDevRegistration(f.input);
    expect(f.counts()).toMatchObject({
      launches: phase === "reserve" ? 0 : 1,
      invocations: phase === "reserve" ? 0 : 1,
    });
    if (phase === "publication") {
      expect(result.effect.phase).toBe("observed");
      if (result.effect.phase !== "observed") throw Error("Observation absent");
      expect(result.effect.observation.outcome).toBe("published");
    }
  },
);
test.each(["binding", "child", "consumption", "discard", "reset", "competitor"])(
  "real journal guard refuses %s after failed-parent reopening",
  async (change) => {
    const f = fixture();
    f.setLostInvocation();
    await executeDevRegistration(f.input);
    reopen(f);
    expect(() =>
      f.journal.mutateLifecycle(
        (previous) => {
          const next = structuredClone([...previous]),
            job = next[0];
          if (job.target !== "container-daemon" || !job.supervisorEffect)
            throw Error("Fixture claim absent");
          switch (change) {
            case "binding":
              job.supervisorEffect.binding.generation = randomUUID();
              break;
            case "child":
              if (job.supervisorEffect.phase === "reserved" || !job.supervisorEffect.child)
                throw Error("Fixture child absent");
              job.supervisorEffect.child.executor.pid++;
              break;
            case "consumption":
              if (job.supervisorEffect.phase !== "observed")
                throw Error("Fixture consumption absent");
              job.supervisorEffect.consumedAt = null;
              break;
            case "discard":
              delete job.supervisorEffect;
              break;
            case "reset":
              job.status = "approved";
              break;
            case "competitor":
              next.push({ ...f.job, id: randomUUID(), status: "running" });
              break;
          }
          return next;
        },
        (previous, next) => {
          assertDevRegistrationEffectAdmission({ previous, next });
          return undefined;
        },
      ),
    ).toThrow();
  },
);
test("partial publication reopens without writing the missing configuration or addressed attempt", async () => {
  const f = fixture();
  f.setLostInvocation();
  await executeDevRegistration(f.input);
  reopen(f);
  const prepared = prepareDevRegistrationPublication({
    ...f.candidate.publication,
    readiness: f.readiness,
  });
  writeFileSync(prepared.receiptFile, prepared.receiptBytes, { mode: 0o600 });
  await executeDevRegistration(f.input);
  expect(readFileSync(prepared.configurationFile)).toEqual(prepared.configurationBytes);
  expect(readFileSync(f.candidate.publication.configurationFile)).toEqual(
    f.candidate.publication.configurationBytes,
  );
  expect(existsSync(f.candidate.publicationAttemptFile)).toBe(false);
  expect(f.counts()).toMatchObject({ launches: 1, invocations: 1 });
});

test.each(["pid", "birth", "argv", "script"])(
  "gated child %s substitution never invokes root",
  async (field) => {
    const f = fixture(),
      launch = f.input.ports.launch;
    f.input.ports.launch = async (...args) => {
      const proof = await launch(...args);
      switch (field) {
        case "pid":
          proof.claim.executor.pid++;
          break;
        case "birth":
          proof.claim.executor.startIdentity = "forged";
          break;
        case "argv":
          proof.claim.executor.argumentsSha256 = "0".repeat(64);
          break;
        case "script":
          proof.claim.executor.entrypoint.sha256 = "0".repeat(64);
          break;
      }
      return {
        ...proof,
        assertCurrent() {
          throw Error("Independent gated child proof differs");
        },
      };
    };
    if (field === "script")
      await expect(executeDevRegistration(f.input)).rejects.toThrow("artifact differs");
    else await executeDevRegistration(f.input);
    expect(f.counts()).toMatchObject({ launches: 1, invocations: 0 });
  },
);

test.each(["auth", "native-result", "host-attempt"])(
  "changed %s evidence refuses publication",
  async (field) => {
    const f = fixture(),
      observe = f.input.ports.observe;
    f.input.ports.observe = async (...args) => {
      const proof = await observe(...args);
      if (field === "auth") proof.readiness = null;
      if (field === "native-result" && proof.nativeResult)
        proof.nativeResult.claimSha256 = "0".repeat(64);
      if (field === "host-attempt")
        writeFileSync(f.candidate.provisioner.plan.hostAttemptFile, "{}", { mode: 0o600 });
      return proof;
    };
    await expect(executeDevRegistration(f.input)).rejects.toThrow();
    expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
  },
);

type ObservationChange = "settled" | "record" | "native" | "readiness" | "controller" | "child";
function changeObservation(
  proof: DevRegistrationExecutionObservation,
  field: ObservationChange,
  f: ReturnType<typeof fixture>,
) {
  switch (field) {
    case "settled":
      proof.record.settled = false;
      break;
    case "record":
      proof.record.observedAt = "2026-10-17T00:00:06.000Z";
      break;
    case "native":
      if (!proof.nativeResult) throw Error("Fixture native result absent");
      proof.nativeResult.rootExecutor.pid++;
      break;
    case "readiness":
      proof.readiness = {
        ...f.readiness,
        authenticated: { ...f.readiness.authenticated, workerInstanceId: "changed-instance" },
      };
      break;
    case "controller":
      proof.controller = { ...proof.controller, pid: proof.controller.pid + 1 };
      break;
    case "child":
      if (!proof.child) throw Error("Fixture child absent");
      proof.child = structuredClone(proof.child);
      proof.child.executor.pid++;
      break;
  }
}
function mutateObservationOnAssertion(
  f: ReturnType<typeof fixture>,
  field: ObservationChange,
  assertion: number,
) {
  const observe = f.input.ports.observe;
  f.input.ports.observe = async (...args) => {
    const proof = await observe(...args),
      check = proof.assertCurrent;
    let calls = 0;
    proof.assertCurrent = () => {
      check();
      if (++calls === assertion) changeObservation(proof, field, f);
    };
    return proof;
  };
}
const observationChanges: ObservationChange[] = [
  "settled",
  "record",
  "native",
  "readiness",
  "controller",
  "child",
];
test.each(observationChanges)(
  "observation persistence refuses callback mutation of %s",
  async (field) => {
    const f = fixture();
    f.setLostInvocation();
    await executeDevRegistration(f.input);
    reopen(f);
    const before = readFileSync(pathApi.join(f.directory, "restart-jobs.json"));
    mutateObservationOnAssertion(f, field, 2);
    const result = await executeDevRegistration(f.input);
    expect(result.recorded).toBe(false);
    expect(readFileSync(pathApi.join(f.directory, "restart-jobs.json"))).toEqual(before);
    expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
    expect(f.counts()).toMatchObject({ launches: 1, invocations: 1 });
  },
);
const publicationMutations = observationChanges.flatMap((field) =>
  [2, 4, 6].map((assertion) => ({ field, assertion })),
);
test.each(publicationMutations)(
  "publication refuses $field callback mutation at custody assertion $assertion",
  async ({ field, assertion }) => {
    const f = fixture();
    mutateObservationOnAssertion(f, field, assertion);
    await executeDevRegistration(f.input);
    expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
    expect(existsSync(f.candidate.publicationAttemptFile)).toBe(false);
    expect(readFileSync(f.candidate.publication.configurationFile)).toEqual(
      f.candidate.publication.configurationBytes,
    );
    expect(f.counts()).toMatchObject({ launches: 1, invocations: 1 });
  },
);
test.each([
  { assertion: 1, field: "pid", phase: "reserved" },
  { assertion: 1, field: "argv", phase: "reserved" },
  { assertion: 2, field: "pid", phase: "consumed" },
  { assertion: 2, field: "argv", phase: "consumed" },
])(
  "child callback $field substitution at assertion $assertion prevents gate release",
  async ({ assertion, field, phase }) => {
    const f = fixture(),
      launch = f.input.ports.launch;
    f.input.ports.launch = async (...args) => {
      const proof = await launch(...args);
      let calls = 0;
      const changed: DevRegistrationExecutionChildProof = {
        ...proof,
        assertCurrent() {
          proof.assertCurrent();
          if (++calls !== assertion) return;
          changed.claim = structuredClone(changed.claim);
          if (field === "pid") changed.claim.executor.pid++;
          else changed.claim.executor.argumentsSha256 = "0".repeat(64);
        },
      };
      return changed;
    };
    await executeDevRegistration(f.input);
    const job = f.journal.readLifecycle()[0];
    expect(job.target === "container-daemon" && job.supervisorEffect?.phase).toBe(phase);
    expect(f.counts()).toMatchObject({ launches: 1, invocations: 0 });
    expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
  },
);

// Run generated Host validation only with injected command outputs. No Python
// inspector, Docker command, root program or live service is executed.
async function hostScriptBoundary(
  change:
    | "none"
    | "manifest"
    | "revision"
    | "pid"
    | "birth"
    | "argv"
    | "operation"
    | "snapshot"
    | "docker-missing"
    | "docker-size"
    | "docker-bytes"
    | "docker-changed"
    | "selected-inode"
    | "rollback-script",
) {
  const f = fixture();
  f.input.ports.invoke = () => {
    throw Error("Fixture child held before script entry");
  };
  await executeDevRegistration(f.input);
  const jobs = f.journal.readLifecycle(),
    job = jobs[0];
  if (job.target !== "container-daemon" || job.supervisorEffect?.phase !== "consumed")
    throw Error("Fixture consumed claim absent");
  const native = structuredClone(f.effectChild);
  switch (change) {
    case "manifest":
      job.supervisorEffect.binding.manifestSha256 = "0".repeat(64);
      break;
    case "revision":
      job.revision = randomUUID();
      break;
    case "pid":
      job.supervisorEffect.child.executor.pid++;
      break;
    case "birth":
      job.supervisorEffect.child.executor.startIdentity = "999:9";
      break;
    case "argv":
      job.supervisorEffect.child.executor.argumentsSha256 = "0".repeat(64);
      break;
    case "operation":
      job.supervisorEffect.binding.operation = "rollback";
      break;
    case "snapshot":
      writeFileSync(f.candidate.provisioner.plan.hostAttemptFile, "{}", { mode: 0o600 });
      break;
  }
  writeFileSync(pathApi.join(f.directory, "restart-jobs.json"), JSON.stringify(jobs), {
    mode: 0o600,
  });
  if (change === "rollback-script")
    writeFileSync(f.candidate.provisioner.plan.c1First!.scripts.rollback, "changed", {
      mode: 0o600,
    });
  const source =
    "globalThis.structuredClone=value=>JSON.parse(JSON.stringify(value));\n" +
    f.candidate.provisioner.script.replace(/^import .*;\n/gm, "");
  const inspector = {
    identity: {
      pid: native.pid,
      parentPid: native.parentPid,
      uid: native.uid,
      bootId: native.bootId,
      startIdentity: native.startIdentity,
      argumentsSha256: native.argumentsSha256,
      executable: native.executable.path,
    },
    auditToken: native.auditToken,
  };
  const p = f.candidate.provisioner.plan;
  if (change === "docker-missing") rmSync(p.docker.path);
  if (change === "docker-size") writeFileSync(p.docker.path, "short");
  if (change === "docker-bytes") writeFileSync(p.docker.path, "x".repeat(23));
  let dockerCommands = 0;
  let rootRequest: unknown = null;
  let gateReads = 0;
  let gateOpen = true;
  const execute = () =>
    runInNewContext(source, {
      fs: {
        ...fs,
        readSync(
          fd: number,
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number | null,
        ) {
          if (fd !== 3 || !gateOpen) return fs.readSync(fd, buffer, offset, length, position);
          if (gateReads++ === 0) {
            buffer[offset] = 1;
            return 1;
          }
          return 0;
        },
        closeSync(fd: number) {
          if (fd === 3 && gateOpen) {
            gateOpen = false;
            return;
          }
          fs.closeSync(fd);
        },
      },
      path: pathApi,
      structuredClone,
      createHash,
      isDeepStrictEqual,
      process: {
        pid: native.pid,
        execArgv: ["--input-type=module", "--eval", f.candidate.provisioner.script],
        execPath: native.executable.path,
        getuid: () => process.getuid!(),
        env: { VORTEO_RESTART_JOB_ID: job.id },
      },
      execFileSync: (file: string, args: string[], options: { input?: string }) => {
        if (file === "/usr/bin/python3") {
          if (change === "selected-inode") {
            const selected = f.candidate.publication.documents!.selected;
            const next = selected.path + ".replacement";
            writeFileSync(next, selected.bytes, { mode: 0o600 });
            fs.renameSync(next, selected.path);
          }
          return JSON.stringify(inspector);
        }
        dockerCommands++;
        if (args.includes("inspect")) {
          if (change === "docker-changed") writeFileSync(p.docker.path, "x".repeat(23));
          return JSON.stringify({
            id: p.docker.containerId,
            running: true,
            ...p.startup,
            mounts: [],
          });
        }
        rootRequest = JSON.parse(options.input ?? "null");
        throw Error("Fixed native root boundary reached");
      },
      console,
    });
  return { execute, rootRequest: () => rootRequest, dockerCommands: () => dockerCommands, f };
}
test("generated static script independently validates the real consumed tuple before fixed root boundary", async () => {
  const f = await hostScriptBoundary("none");
  expect(f.execute).toThrow("Fixed native root boundary reached");
  expect(f.rootRequest()).toMatchObject({
    planSha256: f.f.candidate.provisioner.planSha256,
    operation: "replace",
    jobId: f.f.job.id,
  });
});
test.each(["manifest", "revision", "pid", "birth", "argv", "operation", "snapshot"] as const)(
  "generated Host script rejects %s before root",
  async (change) => {
    const f = await hostScriptBoundary(change);
    expect(f.execute).toThrow();
    expect(f.rootRequest()).toBeNull();
  },
);

// Reconstruct the recorded v682 shape from inert fixture inputs only. The
// provisioner suite pins the entire historical postimage to its captured hash.
function v682Postimage(prepared: ReturnType<typeof prepareDevRegistrationProvisioner>) {
  const plan = structuredClone(prepared.plan);
  delete plan.docker.sha256;
  delete plan.docker.size;
  const planSha256 = hash(JSON.stringify(plan));
  function script(bytes: string, operation: "replace" | "rollback") {
    return bytes
      .replace(
        /^const reviewed=.*;$/m,
        () => "const reviewed=" + JSON.stringify({ plan, planSha256, operation }) + ";",
      )
      .replace(/function verifyDocker\(\)\{\n[\s\S]*?\n\}\n/, "")
      .replace(
        "const docker=args=>{verifyDocker();return execFileSync(",
        "const docker=args=>execFileSync(",
      )
      .replace("encoding:'utf8'});};", "encoding:'utf8'});")
      .replace("verifyDocker();\nconst result=", "const result=");
  }
  const replacement = script(prepared.script, "replace"),
    rollback = script(prepared.rollback.script, "rollback");
  return {
    plan,
    planSha256,
    script: replacement,
    sha256: hash(replacement),
    rollback: { script: rollback, sha256: hash(rollback) },
  };
}

test.each(["docker-missing", "docker-size", "docker-bytes", "docker-changed"] as const)(
  "reviewed Docker pin refuses %s before fixed root command",
  async (change) => {
    const f = await hostScriptBoundary(change);
    expect(f.execute).toThrow();
    expect(f.rootRequest()).toBeNull();
    expect(f.dockerCommands()).toBe(change === "docker-changed" ? 1 : 0);
  },
);

test.each(["replace", "rollback"] as const)(
  "historical verification cannot feed fresh %s reservation",
  async (operation) => {
    const f = fixture(true);
    f.candidate.operation = operation;
    expect(verifyRetainedDevRegistrationProvisioner(f.candidate.provisioner)).toBeUndefined();
    const preflight = vi.fn(f.input.ports.preflight);
    f.input.ports.preflight = preflight;
    const before = readFileSync(pathApi.join(f.directory, "restart-jobs.json"));
    await expect(executeDevRegistration(f.input)).rejects.toThrow();
    expect(preflight).not.toHaveBeenCalled();
    expect(readFileSync(pathApi.join(f.directory, "restart-jobs.json"))).toEqual(before);
    expect(f.counts()).toEqual({ launches: 0, invocations: 0, observations: 0 });
  },
);

// Seed historical journal images as retained fixture data, never through the
// new preparer or a fresh lifecycle dispatch. No native facts are asserted.
function retainHistoricalEffect(
  f: ReturnType<typeof fixture>,
  phase: "reserved" | "consumed" | "uncertain" | "observed",
) {
  const job = f.job,
    d = job.standingDecision;
  if (!d?.activationStep) throw Error("Fixture decision absent");
  const p = f.candidate.provisioner;
  const reserved = SupervisorEffectSchema.parse({
    binding: {
      requestId: job.id,
      requestRevision: job.revision,
      approvedAt: job.approvedAt,
      decisionSha256: digest(d),
      requestPlanSha256: standingRestartPlanDigest(job),
      supervisorPlanSha256: p.sha256,
      registrationPlanSha256: p.planSha256,
      operation: "replace",
      preparationNonce: p.plan.preparationNonce,
      original: null,
      generation: d.activationStep.generation,
      candidateSha256: digest(f.candidate),
      grantId: d.grantId,
      grantRevision: d.grantRevision,
      manifestSha256: d.manifestSha256,
      stepId: d.activationStep.stepId,
      activationGeneration: d.activationStep.generation,
      sourceCommit: p.plan.linuxArtifact.sourceCommit,
      artifactSha256: p.plan.linuxArtifact.artifactSha256,
      nativeIdentitySha256: "c".repeat(64),
      preconditionSha256: "a".repeat(64),
      settlementSha256: "b".repeat(64),
      controller: f.controller,
    },
    reservedAt: "2026-10-17T00:00:02.000Z",
    phase: "reserved",
  });
  const child = {
    reservationSha256: devRegistrationReservationDigest(reserved),
    executor: f.effectChild,
    acknowledgedAt: "2026-10-17T00:00:03.000Z",
  };
  const consumed = { ...reserved, phase, consumedAt: "2026-10-17T00:00:03.000Z", child };
  let image: unknown = consumed;
  if (phase === "reserved") image = reserved;
  if (phase === "observed")
    image = {
      ...consumed,
      observation: {
        observedAt: "2026-10-17T00:00:04.000Z",
        evidenceSha256: "9".repeat(64),
        outcome: "unresolved",
        settled: false,
        publication: null,
      },
    };
  const effect = SupervisorEffectSchema.parse(image);
  writeFileSync(
    pathApi.join(f.directory, "restart-jobs.json"),
    JSON.stringify([{ ...job, supervisorEffect: effect }]),
    { mode: 0o600 },
  );
  const observe = f.input.ports.observe;
  f.input.ports.observe = async (...args) => ({
    ...(await observe(...args)),
    child: phase === "reserved" ? null : structuredClone(child),
  });
  return effect;
}

test.each(["reserved", "consumed", "uncertain", "observed"] as const)(
  "historical %s effect reopens observation-only before fresh pin requirement",
  async (phase) => {
    const f = fixture(true),
      retained = retainHistoricalEffect(f, phase);
    const bytes = JSON.stringify(f.candidate.provisioner);
    const preflight = vi.fn(f.input.ports.preflight);
    f.input.ports.preflight = preflight;
    const result = await executeDevRegistration(f.input);
    expect(result.effect.binding).toEqual(retained.binding);
    expect(result.effect.phase).toBe("observed");
    expect(preflight).not.toHaveBeenCalled();
    expect(f.counts()).toEqual({ launches: 0, invocations: 0, observations: 1 });
    expect(JSON.stringify(f.candidate.provisioner)).toBe(bytes);
    expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
  },
);

test("reviewed Docker pin commits script then real request and enrollment manifest without future authority", () => {
  const f = fixture(),
    current = f.candidate.provisioner;
  const input = DevRegistrationProvisionerInputSchema.strip().parse(current.plan);
  const changed = prepareDevRegistrationProvisioner({
    ...input,
    docker: { ...input.docker, sha256: "e".repeat(64) },
  });
  const changedJob = { ...f.job, supervisorPlanSha256: changed.sha256 };
  const changedRequestDigest = standingRestartPlanDigest(changedJob);
  expect(current.plan.docker.sha256).toBe(hash("reviewed Docker fixture"));
  expect(f.job.supervisorPlanSha256).toBe(current.sha256);
  expect(f.manifest.steps[0].planSha256).toBe(standingRestartPlanDigest(f.job));
  expect(changedRequestDigest).not.toBe(standingRestartPlanDigest(f.job));
  const changedManifest = {
    ...f.manifest,
    steps: [{ ...f.manifest.steps[0], planSha256: changedRequestDigest }],
  };
  expect(enrollmentManifestDigest(changedManifest)).not.toBe(enrollmentManifestDigest(f.manifest));
  expect(current.plan).not.toHaveProperty("grantId");
  expect(current.plan).not.toHaveProperty("manifestSha256");
  expect(f.enrollment.read()).toMatchObject({ grant: { manifest: f.manifest } });
});

test("historical consumed attempt remains read-only after parent failure and grant revocation", async () => {
  const f = fixture(true),
    retained = retainHistoricalEffect(f, "consumed");
  reopen(f);
  f.revoke();
  const before = f.journal.readLifecycle()[0];
  expect(before.status).toBe("failed");
  const result = await executeDevRegistration(f.input);
  expect(result.effect.binding).toEqual(retained.binding);
  expect(f.journal.readLifecycle()[0].status).toBe("failed");
  expect(f.counts()).toEqual({ launches: 0, invocations: 0, observations: 1 });
  expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
});

test.each(["raw", "parsed", "inode"])(
  "C1 document %s substitution during preflight refuses before reservation",
  async (change) => {
    const f = fixture(),
      preflight = f.input.ports.preflight;
    f.input.ports.preflight = async (...args) => {
      const proof = await preflight(...args);
      const d = f.candidate.publication.documents!.selected;
      if (change === "raw") d.bytes[0] = 32;
      if (change === "parsed") d.parsed.listenPort++;
      if (change === "inode") {
        const temporary = d.path + ".changed";
        writeFileSync(temporary, d.bytes, { mode: 0o600 });
        fs.renameSync(temporary, d.path);
      }
      return proof;
    };
    await expect(executeDevRegistration(f.input)).rejects.toThrow();
    expect(f.journal.readLifecycle()[0]).not.toHaveProperty("supervisorEffect");
    expect(f.counts()).toEqual({ launches: 0, invocations: 0, observations: 0 });
  },
);
test("C1 current operation refs and actual raw inputs precede real manifest enrollment", async () => {
  const f = fixture();
  const documents = f.candidate.publication.documents!;
  expect(f.candidate.provisioner.script).not.toContain(enrollmentManifestDigest(f.manifest));
  expect(f.candidate.provisioner.script).not.toContain(f.job.id);
  expect(documents.original.parsed.container.supervisorMaintenance).toBeUndefined();
  expect(documents.replacement.parsed.container.supervisorMaintenance?.sha256).toBe(
    f.candidate.provisioner.sha256,
  );
  expect(documents.rollback.parsed.container.supervisorMaintenance?.sha256).toBe(
    f.candidate.provisioner.rollback.sha256,
  );
  expect(documents.selected.parsed.container.persistentRegistration).toEqual({
    receiptFile: f.candidate.publication.receiptFile,
    sha256: documents.preparedReceipt.sha256,
  });
  expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
  await executeDevRegistration(f.input);
  const attempt = JSON.parse(readFileSync(f.candidate.publicationAttemptFile, "utf8"));
  expect(attempt).toMatchObject({
    version: 2,
    operation: "dev-registration-receipt-publication",
    planSha256: f.candidate.provisioner.planSha256,
    documents: { selected: { path: documents.selected.path, sha256: documents.selected.sha256 } },
  });
  expect(attempt).not.toHaveProperty("files");
  for (const document of Object.values(documents))
    expect(readFileSync(document.path)).toEqual(document.bytes);
});
test("v684 pinned preparation cannot create a fresh consumed generation", async () => {
  const f = fixture(false, false);
  await expect(executeDevRegistration(f.input)).rejects.toThrow(
    "Historical registration preparation is observation-only",
  );
  expect(f.counts()).toEqual({ launches: 0, invocations: 0, observations: 0 });
  expect(f.journal.readLifecycle()[0]).not.toHaveProperty("supervisorEffect");
});

test.each(["selected-inode", "rollback-script"] as const)(
  "C1 generated script refuses %s substitution without root dispatch",
  async (change) => {
    const f = await hostScriptBoundary(change);
    expect(f.execute).toThrow();
    expect(f.rootRequest()).toBeNull();
    expect(f.dockerCommands()).toBe(0);
  },
);
test("C1 document substitution in child custody callback prevents consumption", async () => {
  const f = fixture(),
    launch = f.input.ports.launch;
  f.input.ports.launch = async (...args) => {
    const proof = await launch(...args);
    return {
      ...proof,
      assertCurrent() {
        proof.assertCurrent();
        f.candidate.publication.documents!.rollback.parsed.listenPort++;
      },
    };
  };
  await expect(executeDevRegistration(f.input)).rejects.toThrow(/C1/);
  const current = f.journal.readLifecycle()[0];
  expect(current.supervisorEffect?.phase).toBe("reserved");
  expect(f.counts()).toMatchObject({ launches: 1, invocations: 0 });
  expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
});

test.each(["maintenance", "registration"] as const)(
  "C1 initial document composer refuses existing P %s reference",
  (kind) => {
    const f = fixture();
    const original = structuredClone(f.candidate.publication.documents!.original);
    original.bytes = Buffer.from(original.bytes);
    if (kind === "maintenance")
      original.parsed.container.supervisorMaintenance =
        f.candidate.publication.config.container.supervisorMaintenance;
    else
      original.parsed.container.persistentRegistration = {
        receiptFile: "/host/old-receipt.json",
        sha256: "a".repeat(64),
      };
    original.bytes = Buffer.from(JSON.stringify(original.parsed));
    original.sha256 = hash(original.bytes);
    const p = f.candidate.provisioner;
    expect(() =>
      prepareDevRegistrationC1Documents({
        provisioner: p,
        original,
        replacementScript: {
          path: p.plan.c1First!.scripts.replacement,
          bytes: Buffer.from(p.script),
          sha256: p.sha256,
        },
        rollbackScript: {
          path: p.plan.c1First!.scripts.rollback,
          bytes: Buffer.from(p.rollback.script),
          sha256: p.rollback.sha256,
        },
        hostNode: p.plan.c1First!.scripts.node,
      }),
    ).toThrow("unsupported");
  },
);

test("C1 preflight without independent selected runtime pin refuses before reservation", async () => {
  const f = fixture(),
    preflight = f.input.ports.preflight;
  f.input.ports.preflight = async (...args) => {
    const proof = await preflight(...args);
    return { ...proof, selectedConfiguration: undefined };
  };
  await expect(executeDevRegistration(f.input)).rejects.toThrow(
    "actual Host configuration proof differs",
  );
  expect(f.counts()).toEqual({ launches: 0, invocations: 0, observations: 0 });
  expect(f.journal.readLifecycle()[0]).not.toHaveProperty("supervisorEffect");
});

test("C1 launch cannot replace the retained preflight custody callback", async () => {
  const f = fixture(),
    launch = f.input.ports.launch;
  f.input.ports.launch = async (reservation, proof) => {
    const child = await launch(reservation, proof);
    proof.assertCurrent = () => undefined;
    return child;
  };
  await executeDevRegistration(f.input);
  expect(f.journal.readLifecycle()[0].supervisorEffect?.phase).toBe("reserved");
  expect(f.counts()).toMatchObject({ launches: 1, invocations: 0 });
  expect(existsSync(f.candidate.publication.receiptFile)).toBe(false);
});

test.each([0o720, 0o702])(
  "C1 generated VM rejects writable full ancestor mode %s before helper or Docker",
  async (mode) => {
    const f = await hostScriptBoundary("none");
    fs.chmodSync(f.f.directory, mode);
    expect(f.execute).toThrow("C1 document custody differs");
    expect(f.rootRequest()).toBeNull();
    expect(f.dockerCommands()).toBe(0);
  },
);
test("C1 generated VM retains accepted protected user and root ancestor ownership", async () => {
  const f = await hostScriptBoundary("none");
  fs.chmodSync(f.f.directory, 0o750);
  expect(f.execute).toThrow("Fixed native root boundary reached");
  expect(f.dockerCommands()).toBe(2);
});

test("C1 generated VM refuses the actual root-owned writable temporary ancestor", () => {
  const f = fixture(),
    root = realpathSync(mkdtempSync(pathApi.join("/tmp", "c1-vm-root-ancestor-")));
  fs.chmodSync(root, 0o700);
  directories.push(root);
  const parent = fs.lstatSync(pathApi.dirname(root));
  expect(parent.uid).toBe(0);
  expect(parent.mode & 0o022).not.toBe(0);
  const file = pathApi.join(root, "document.json");
  writeFileSync(file, "{}", { mode: 0o600 });
  const script = f.candidate.provisioner.script;
  const source = script.slice(
    script.indexOf("function retainC1Files(paths){"),
    script.indexOf("function assertC1Documents(documents)"),
  );
  expect(() =>
    runInNewContext(source + "\nretainC1Files([file])();", {
      fs,
      path: pathApi,
      file,
      process: { getuid: () => process.getuid!() },
      check(ok: boolean, reason: string) {
        if (!ok) throw Error(reason);
      },
    }),
  ).toThrow("C1 document custody differs");
});
