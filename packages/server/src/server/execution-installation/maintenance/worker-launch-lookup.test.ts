import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { RestartJobSchema } from "@getpaseo/protocol/execution-installation";
import { InstallationEnrollmentManifestSchema } from "@getpaseo/protocol/installation-enrollment";
import { InstallationConfigSchema } from "../config.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import { retainEnrollmentNativeIdentity } from "./native-registration.js";
import {
  FileEnrollmentJournal,
  enrollInstallation,
  enrollmentManifestDigest,
  changeStandingGrant,
} from "./authorization.js";
import {
  lookupWorkerLaunch,
  parseWorkerLaunchLookupQuery,
  type WorkerLaunchLookup,
} from "./worker-launch-lookup.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const hash = "a".repeat(64);
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "worker-lookup-unit-")));
  directories.push(root);
  chmodSync(root, 0o700);
  const config = InstallationConfigSchema.parse({
    public: {
      version: 1,
      installationId: randomUUID(),
      origin: "https://unit.test",
      environments: [
        { kind: "host", serverId: "host", endpoint: "host.test", useTls: true },
        { kind: "container", serverId: "dev", endpoint: "dev.test", useTls: true },
      ],
    },
    listenPort: 6770,
    webDistDir: root,
    stateDir: root,
    ownerPasswordHash: "$2unit",
    hostAgentTokenHash: hash,
    containerAgentTokenHash: "b".repeat(64),
    host: {
      endpoint: "127.0.0.1:6771",
      password: "unit-host",
      launchdService: "gui/501/local.vorteo.unit",
    },
    container: { endpoint: "127.0.0.1:6772", password: "unit-dev" },
    containerSourceUpdates: {
      sourceRepository: root,
      toolingDirectory: root,
      integrationRef: "refs/heads/main",
      receiptFile: path.join(root, "unused"),
      docker: "/unused/docker",
      containerId: "c".repeat(64),
      user: "unit",
      node: "/unused/node",
      home: "/unit/state",
      releaseRoot: "/unit/releases",
      currentReleaseLink: "/unit/current",
    },
  });
  const targetIdentitySha256 = retainEnrollmentNativeIdentity(root, {
    version: 1,
    installationId: config.public.installationId,
    custodyOwnerUid: process.getuid!(),
    installationRoot: root,
    stateDirectory: root,
    environment: "container",
    target: "container-daemon",
    containerId: "c".repeat(64),
    containerUid: 1000,
    containerGid: 1000,
    containerHome: "/home/unit",
    containerStateDirectory: "/unit/state",
    launcherPath: "/opt/unit/start",
    selectionPath: "/unit/current",
  });
  const supervisor = {
    pid: 123,
    parentPid: 1,
    uid: 1000,
    bootId: randomUUID(),
    startTicks: "12345",
  };
  const hints = {
    profileSha256: hash,
    supervisorPid: 123,
    cause: { kind: "startup" as const, registrationGeneration: randomUUID() },
  };
  const lookup: WorkerLaunchLookup = {
    installationId: config.public.installationId,
    serverId: "dev",
    targetIdentitySha256,
    supervisor,
    hints,
  };
  const id = randomUUID();
  const job = RestartJobSchema.parse({
    id,
    revision: randomUUID(),
    target: "container-daemon",
    reason: "Host maintenance",
    requestedBy: "host-agent",
    status: "running",
    createdAt: "2026-10-17T00:00:00.000Z",
    expiresAt: "9999-12-31T23:59:59.999Z",
    detail: "Private unrelated Host diagnostics",
    workerLaunch: {
      phase: "uncertain",
      reservedAt: "2026-10-17T00:00:00.000Z",
      consumedAt: "2026-10-17T00:00:01.000Z",
      binding: {
        requestId: id,
        approvalRevision: randomUUID(),
        generation: randomUUID(),
        grantId: randomUUID(),
        grantRevision: randomUUID(),
        manifestSha256: hash,
        profileSha256: hash,
        targetIdentitySha256,
        sourceCommit: "a".repeat(40),
        artifactSha256: hash,
        publicationSha256: hash,
        cause: { ...hints.cause, registrationSha256: hash },
        supervisor,
      },
    },
  });
  const journal = new FileBootstrapRequestJournal(root);
  journal.writeLifecycle([job]);
  return {
    config,
    root,
    lookup,
    job,
    journal,
    bytes: () => readFileSync(path.join(root, "restart-jobs.json"), "utf8"),
  };
}

test("worker launch lookup returns an exact retained child without journal writes or parent diagnostics", () => {
  const f = fixture();
  const before = f.bytes();
  const receipt = lookupWorkerLaunch(f.config, f.lookup);
  expect(receipt).toMatchObject({
    id: f.job.id,
    revision: f.job.revision,
    status: "running",
    workerLaunch: f.job.workerLaunch,
  });
  expect(Object.keys(receipt!)).toEqual(["id", "revision", "status", "detail", "workerLaunch"]);
  expect(receipt?.detail).not.toContain(f.job.detail);
  expect(f.bytes()).toBe(before);
});

test.each(["profile", "birth", "boot", "parent", "cause"])(
  "worker launch lookup never matches a different immutable selector: %s",
  (field) => {
    const f = fixture();
    const query = structuredClone(f.lookup);
    if (field === "profile") query.hints.profileSha256 = "b".repeat(64);
    if (field === "birth") query.supervisor.startTicks = "12346";
    if (field === "boot") query.supervisor.bootId = randomUUID();
    if (field === "parent") query.supervisor.parentPid = 2;
    if (field === "cause")
      query.hints.cause = { kind: "startup", registrationGeneration: randomUUID() };
    const before = f.bytes();
    expect(lookupWorkerLaunch(f.config, query)).toBeNull();
    expect(f.bytes()).toBe(before);
  },
);

test("worker launch lookup refuses foreign installation, configured server and immutable container identity", () => {
  const f = fixture();
  expect(() => lookupWorkerLaunch(f.config, { ...f.lookup, installationId: randomUUID() })).toThrow(
    "another environment",
  );
  expect(() => lookupWorkerLaunch(f.config, { ...f.lookup, serverId: "host" })).toThrow(
    "another environment",
  );
  const configured = f.config.containerSourceUpdates;
  if (!configured) throw new Error("Missing fixture container settings");
  configured.containerId = "d".repeat(64);
  expect(() => lookupWorkerLaunch(f.config, f.lookup)).toThrow("configured Dev identity");
});

test("worker launch lookup keeps bare pending hints unknown and rejects ambiguous retained children", () => {
  const f = fixture();
  const pending = {
    ...f.job,
    workerLaunch: undefined,
    workerLaunchRequest: f.lookup.hints,
    status: "pending" as const,
  };
  f.journal.writeLifecycle([pending]);
  expect(lookupWorkerLaunch(f.config, f.lookup)).toBeNull();
  const id = randomUUID();
  const duplicate = {
    ...f.job,
    id,
    workerLaunch: {
      ...f.job.workerLaunch!,
      binding: { ...f.job.workerLaunch!.binding, requestId: id },
    },
  };
  f.journal.writeLifecycle([f.job, duplicate]);
  const before = f.bytes();
  expect(() => lookupWorkerLaunch(f.config, f.lookup)).toThrow("multiple retained");
  expect(f.bytes()).toBe(before);
});

test("worker launch lookup remains observational after actual grant revocation", () => {
  const f = fixture();
  const enrollment = new FileEnrollmentJournal(f.root);
  const manifest = InstallationEnrollmentManifestSchema.parse({
    version: 1,
    operation: "installation-enrollment",
    installationId: f.config.public.installationId,
    revision: randomUUID(),
    createdAt: "2026-10-17T00:00:00.000Z",
    targets: [
      { target: "maintenance-controller", identitySha256: hash, operations: ["replacement"] },
      { target: "recovery-launcher", identitySha256: hash, operations: ["replacement"] },
      {
        target: "container-daemon",
        identitySha256: f.lookup.targetIdentitySha256,
        operations: ["restart"],
      },
    ],
    trustedRepositories: ["https://example.test/source.git"],
    provisioning: null,
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 30 },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    steps: [
      {
        id: randomUUID(),
        target: "container-daemon",
        operation: "restart",
        planSha256: hash,
        candidate: { sourceCommit: "a".repeat(40), artifactSha256: hash },
        previous: null,
        dependsOn: [],
      },
    ],
  });
  const state = enrollInstallation(enrollment, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: manifest.createdAt,
    },
  });
  if (state.status !== "enrolled") throw new Error("Missing enrollment fixture");
  changeStandingGrant(enrollment, {
    expectedRevision: state.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  const before = f.bytes();
  const policy = readFileSync(path.join(f.root, "maintenance-enrollment.json"), "utf8");
  expect(lookupWorkerLaunch(f.config, f.lookup)?.workerLaunch).toEqual(f.job.workerLaunch);
  expect(f.bytes()).toBe(before);
  expect(readFileSync(path.join(f.root, "maintenance-enrollment.json"), "utf8")).toBe(policy);
});

test("worker launch lookup query rejects duplicate, oversized, malformed and PID-only input", () => {
  const f = fixture();
  const lookup = JSON.stringify(f.lookup);
  expect(parseWorkerLaunchLookupQuery({ workerLaunch: "1", lookup }, "short")).toEqual(f.lookup);
  for (const query of [
    { workerLaunch: ["1", "1"], lookup },
    { workerLaunch: "1", lookup: [lookup, lookup] },
    { workerLaunch: "1", lookup: "{" },
    { workerLaunch: "1", lookup: "x".repeat(4097) },
    { workerLaunch: "1", lookup: JSON.stringify({ hints: f.lookup.hints }) },
  ])
    expect(() => parseWorkerLaunchLookupQuery(query, "short")).toThrow();
  expect(() =>
    parseWorkerLaunchLookupQuery({ workerLaunch: "1", lookup }, "x".repeat(16 * 1024 + 1)),
  ).toThrow("size limit");
});

test("worker launch lookup matches exact predecessor cause even when the parent failed", () => {
  const f = fixture();
  const generation = randomUUID();
  if (!f.job.workerLaunch) throw new Error("Missing retained child");
  f.job.status = "failed";
  f.job.workerLaunch.binding.cause = { kind: "predecessor", generation, settlementSha256: hash };
  f.lookup.hints.cause = { kind: "predecessor", generation };
  f.journal.writeLifecycle([f.job]);
  const before = f.bytes();
  expect(lookupWorkerLaunch(f.config, f.lookup)).toMatchObject({
    id: f.job.id,
    status: "failed",
    workerLaunch: f.job.workerLaunch,
  });
  expect(f.bytes()).toBe(before);
});

test("worker launch lookup rejects contradictory supervisor PID selectors at its exported boundary", () => {
  const f = fixture();
  f.lookup.hints.supervisorPid = 999;
  expect(() => lookupWorkerLaunch(f.config, f.lookup)).toThrow("supervisor differs");
});
