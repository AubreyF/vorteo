import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, realpath, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as artifacts from "./coordinator-bootstrap-artifact.js";
import * as hostVerification from "./coordinator-bootstrap-host.js";
import * as nativeMaintenance from "./coordinator-bootstrap-maintenance-native.js";
import {
  enrollAndProvisionCoordinatorMaintenance,
  provisionCoordinatorMaintenance,
  provisionEnrolledCoordinatorMaintenance,
  readProvisionedMaintenance,
} from "./coordinator-bootstrap-maintenance-provisioning.js";
import { hashSync } from "bcryptjs";
import { assertMaintenanceExecutionBinding } from "./coordinator-bootstrap-maintenance-runtime.js";
import * as maintenanceRuntime from "./coordinator-bootstrap-maintenance-runtime.js";
import { bindMaintenanceReview } from "./coordinator-bootstrap-maintenance-host.js";
import { verifyBootRunnerBinding } from "./coordinator-bootstrap-runner.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { CoordinatorBootstrapRequestSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import {
  inspectMaintenanceAdmission,
  maintenanceHostSetupDigest,
  verifyMaintenanceProposalFiles,
} from "./coordinator-bootstrap-maintenance-admission.js";
import { CoordinatorBootstrapPlanSchema } from "@getpaseo/protocol/coordinator-bootstrap";

import { createMaintenanceReviewState } from "./coordinator-bootstrap-maintenance-state.js";

import { selectMaintenanceOwnerConfiguration } from "./coordinator-bootstrap-maintenance-controller.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.each(["valid", "wrong-password", "changed-after-auth"] as const)(
  "maintenance provisioning: %s",
  async (mode) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "maintenance-provision-")));
    roots.push(root);
    const input: ReturnType<typeof fixture> = JSON.parse(
      JSON.stringify(fixture()).replaceAll("/fixture", root),
    );
    const ownerBytes = JSON.stringify({
      public: { installationId: input.plan.installationId },
      ownerPasswordHash: hashSync("fixture-owner", 4),
    });
    await writeFile(input.hostSetup.renewal.configuration.path, ownerBytes, { mode: 0o600 });
    input.hostSetup.renewal.configuration.sha256 = createHash("sha256")
      .update(ownerBytes)
      .digest("hex");
    input.runnerSetup.renewal = structuredClone(input.hostSetup.renewal);
    input.receipt.hostSetupSha256 = maintenanceHostSetupDigest(input.hostSetup);
    input.receipt.planSha256 = coordinatorPlanDigest(input.plan);
    const context = {
      ...inspectMaintenanceAdmission(input),
      writableMountRoots: [],
      coordinatorIdentitySha256: "a".repeat(64),
    };
    const digest = createHash("sha256").update(JSON.stringify(context.receipt)).digest("hex");
    const directory = path.join(root, "maintenance-admissions", digest);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const native = vi
      .spyOn(nativeMaintenance, "verifyNativeMaintenanceProposal")
      .mockResolvedValue(context);
    if (mode === "changed-after-auth")
      native
        .mockResolvedValueOnce(context)
        .mockResolvedValueOnce({ ...context, writableMountRoots: ["/changed"] });
    const operation = provisionCoordinatorMaintenance({
      ...input,
      admissionSha256: digest,
      ownerPassword: mode === "wrong-password" ? "incorrect" : "fixture-owner",
    });
    if (mode !== "valid") {
      await expect(operation).rejects.toThrow(
        mode === "wrong-password"
          ? "authentication required"
          : "changed during owner authentication",
      );
      expect(await readdir(directory)).toEqual([]);
      expect(native).toHaveBeenCalledTimes(mode === "wrong-password" ? 1 : 2);
      return;
    }
    expect(await operation).toEqual({
      admission: { path: path.join(directory, "admission.json"), sha256: digest },
      provisioned: true,
      dispatched: false,
    });
    expect(native).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(path.join(directory, "host.json"), "utf8"))).toEqual(
      context.host,
    );
    expect(JSON.parse(await readFile(path.join(directory, "admission.json"), "utf8"))).toEqual(
      context.receipt,
    );
    expect(await readdir(directory)).toEqual([
      "admission.json",
      "host.json",
      "plan.json",
      "runner.json",
    ]);
    // Reconciliation verifies the same bytes; it never overwrites an admitted document.
    await provisionCoordinatorMaintenance({
      ...input,
      admissionSha256: digest,
      ownerPassword: "fixture-owner",
    });
    const reopened = await readProvisionedMaintenance({
      installationRoot: root,
      admissionSha256: digest,
    });
    expect(reopened.admission.sha256).toBe(digest);
    expect(reopened.plan).toEqual(context.plan);
    await writeFile(path.join(directory, "runner.json"), "{}", { mode: 0o600 });
    await expect(
      readProvisionedMaintenance({ installationRoot: root, admissionSha256: digest }),
    ).rejects.toThrow();
    await expect(
      provisionCoordinatorMaintenance({
        ...input,
        admissionSha256: digest,
        ownerPassword: "fixture-owner",
      }),
    ).rejects.toThrow("snapshot differs");
    expect(await readFile(path.join(directory, "runner.json"), "utf8")).toBe("{}");
  },
);

test("maintenance preserves the failed immediate predecessor separately from terminal authority", () => {
  const input = fixture();
  const host = {
    ...input.hostSetup,
    renewal: {
      ...input.hostSetup.renewal,
      unpromotedFailure: {
        id: randomUUID(),
        revision: randomUUID(),
        generation: randomUUID(),
        planSha256: "a".repeat(64),
      },
    },
  };
  const parsed = inspectMaintenanceAdmission(input).host;
  expect(() => nativeMaintenance.assertMaintenancePredecessor(undefined, parsed)).not.toThrow();
  expect(() =>
    nativeMaintenance.assertMaintenancePredecessor(
      host.renewal.unpromotedFailure,
      host as typeof parsed,
    ),
  ).not.toThrow();
  expect(() =>
    nativeMaintenance.assertMaintenancePredecessor(host.renewal.terminal, host as typeof parsed),
  ).toThrow("exact immediate predecessor");
  expect(() =>
    nativeMaintenance.assertMaintenancePredecessor(undefined, host as typeof parsed),
  ).toThrow("exact immediate predecessor");
});

test("execution extends the admitted snapshot only with its exact approval", () => {
  const input = fixture();
  const prepared = inspectMaintenanceAdmission(input).runner;
  const setup = {
    ...prepared,
    maintenance: { installationRoot: input.installationRoot, admissionSha256: "a".repeat(64) },
    renewal: {
      ...prepared.renewal!,
      request: {
        id: input.receipt.requestId,
        revision: randomUUID(),
        planSha256: input.receipt.planSha256,
      },
    },
  };
  expect(() =>
    assertMaintenanceExecutionBinding(
      setup,
      prepared,
      input.receipt.planSha256,
      input.receipt.requestId,
    ),
  ).not.toThrow();
  expect(() =>
    assertMaintenanceExecutionBinding(
      { ...setup, runtimeSha256: "f".repeat(64) },
      prepared,
      input.receipt.planSha256,
      input.receipt.requestId,
    ),
  ).toThrow("admitted runtime");
  expect(() =>
    assertMaintenanceExecutionBinding(setup, prepared, "f".repeat(64), input.receipt.requestId),
  ).toThrow("admitted runtime");
  expect(() =>
    assertMaintenanceExecutionBinding(
      setup,
      setup,
      input.receipt.planSha256,
      input.receipt.requestId,
    ),
  ).toThrow("independently admitted");
});

test("pre-dispatch validation bridges only the exact unpromoted manual claim", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "maintenance-claim-")));
  roots.push(root);
  const input: ReturnType<typeof fixture> = JSON.parse(
    JSON.stringify(fixture()).replaceAll("/fixture", root),
  );
  await mkdir(input.plan.state.directory, { recursive: true, mode: 0o700 });
  const record = CoordinatorBootstrapRequestSchema.parse({
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Fixture maintenance",
    createdAt: "2026-10-15T00:00:00.000Z",
    status: "approved",
    decisionAt: "2026-10-15T00:01:00.000Z",
    plan: input.plan,
    planSha256: coordinatorPlanDigest(input.plan),
  });
  const journal = new FileBootstrapRequestJournal(input.plan.state.directory);
  journal.replace([], [record]);
  const reference = { id: record.id, revision: record.revision, planSha256: record.planSha256 };
  expect(nativeMaintenance.verifyMaintenanceDispatchRecord(input.plan, reference)).toEqual(record);
  expect(() =>
    nativeMaintenance.verifyMaintenanceDispatchRecord(input.plan, {
      ...reference,
      revision: randomUUID(),
    }),
  ).toThrow("revision changed");
  const claimed = CoordinatorBootstrapRequestSchema.parse({
    ...record,
    revision: randomUUID(),
    execution: {
      generation: randomUUID(),
      stage: "claimed",
      updatedAt: "2026-10-15T00:02:00.000Z",
    },
  });
  journal.replace([record], [claimed]);
  expect(nativeMaintenance.verifyMaintenanceDispatchRecord(input.plan, reference)).toEqual(claimed);
  journal.promote(claimed);
  expect(() => nativeMaintenance.verifyMaintenanceDispatchRecord(input.plan, reference)).toThrow(
    "unpromoted",
  );
});

test("maintenance review cannot act on another request or expose automatic dispatch", async () => {
  const input = fixture();
  const own = CoordinatorBootstrapRequestSchema.parse({
    id: input.receipt.requestId,
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Fixture",
    createdAt: "2026-10-15T00:00:00.000Z",
    status: "pending",
    plan: input.plan,
    planSha256: input.receipt.planSha256,
  });
  const other = { ...own, id: randomUUID() };
  const prepare = vi.fn(async () => own);
  const decide = vi.fn(async () => own);
  const automatic = { reconcile: vi.fn(async () => own) };
  const service = bindMaintenanceReview(
    { list: () => [own, other], prepare, decide, automatic },
    input.receipt,
  );
  expect(service.list()).toEqual([own]);
  expect(service.automatic).toBeUndefined();
  await expect(
    service.prepare({ id: other.id, reason: "Fixture", plan: input.plan }),
  ).rejects.toThrow("another request");
  await expect(
    service.prepare({
      id: own.id,
      reason: "Fixture",
      plan: { ...input.plan, hostRequestsAfter: "2026-10-15T00:00:00.000Z" },
    }),
  ).rejects.toThrow("admitted plan");
  await expect(
    service.decide(
      { id: other.id, revision: other.revision, planSha256: other.planSha256, decision: "cancel" },
      "fixture",
    ),
  ).rejects.toThrow("another request");
  expect(prepare).not.toHaveBeenCalled();
  expect(decide).not.toHaveBeenCalled();
  await service.prepare({ id: own.id, reason: "Fixture", plan: input.plan });
  await service.decide(
    { id: own.id, revision: own.revision, planSha256: own.planSha256, decision: "cancel" },
    "fixture",
  );
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenCalledTimes(1);
  expect(automatic.reconcile).not.toHaveBeenCalled();
});

test("boot setup accepts the later admission envelope only after retained verification", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "maintenance-boot-")));
  roots.push(root);
  const input = fixture();
  const prepared = inspectMaintenanceAdmission(input).runner;
  input.plan.state.directory = root;
  const bytes = JSON.stringify(prepared);
  const file = path.join(root, "prepared.json");
  await writeFile(file, bytes, { mode: 0o600 });
  input.plan.bootRecovery = {
    requestId: input.receipt.requestId,
    service: `gui/501/local.vorteo.fixture.installation-recovery-${input.receipt.requestId}`,
    launcher: input.plan.candidate.launcher,
    installedLauncher: "/fixture/recovery.plist",
    setup: { path: file, sha256: createHash("sha256").update(bytes).digest("hex") },
    ownerLauncher: prepared.ownerLauncher,
    node: prepared.node,
    entrypoint: prepared.entrypoint,
  };
  const revision = randomUUID();
  const request = CoordinatorBootstrapRequestSchema.parse({
    id: input.receipt.requestId,
    revision,
    requestedBy: "host-agent",
    reason: "Fixture",
    createdAt: "2026-10-15T00:00:00.000Z",
    status: "approved",
    decisionAt: "2026-10-15T00:01:00.000Z",
    plan: input.plan,
    planSha256: coordinatorPlanDigest(input.plan),
    execution: {
      generation: randomUUID(),
      stage: "claimed",
      updatedAt: "2026-10-15T00:02:00.000Z",
    },
  });
  const setup = {
    ...prepared,
    maintenance: { installationRoot: "/fixture", admissionSha256: "a".repeat(64) },
    renewal: {
      ...prepared.renewal!,
      request: { id: request.id, revision, planSha256: request.planSha256 },
    },
  };
  const snapshotPath = path.join(root, `coordinator-renewal-${request.id}-${revision}.json`);
  const proof = vi
    .spyOn(maintenanceRuntime, "verifyMaintenanceRetainedRuntime")
    .mockResolvedValue();
  await verifyBootRunnerBinding(request, snapshotPath, setup);
  expect(proof).toHaveBeenCalledWith({ setup, request, watchdog: true, historical: false });
  proof.mockRejectedValue(new Error("admission changed"));
  await expect(verifyBootRunnerBinding(request, snapshotPath, setup)).rejects.toThrow(
    "admission changed",
  );
});

function fixture() {
  const file = (filePath: string) => ({ path: filePath, sha256: "a".repeat(64) });
  const installationRoot = "/fixture";
  const sourceCommit = "b".repeat(40);
  const directory = `${installationRoot}/maintenance-runtimes/${sourceCommit}`;
  const host = {
    admissionSetupFile: "/fixture/admission.json",
    daemonId: "host",
    node: file("/fixture/node"),
    entrypoint: file("/fixture/host/runner.js"),
    ownerLauncher: file("/fixture/host/owner.py"),
    ownershipVerifier: file("/fixture/host/verifier.py"),
    runtimeDirectory: "/fixture/host",
    runtimeSha256: "c".repeat(64),
    renewal: {
      version: 1,
      originalSetup: file("/fixture/runner.json"),
      originalAdmission: file("/fixture/admission.json"),
      terminal: {
        id: randomUUID(),
        revision: randomUUID(),
        generation: randomUUID(),
        planSha256: "d".repeat(64),
      },
      configuration: file("/fixture/current-config.json"),
      sourceCommit: "e".repeat(40),
      source: file("/fixture/host/.installation-source.json"),
      hostProcess: {
        pid: 123,
        parentPid: 122,
        uid: 501,
        bootId: randomUUID(),
        startIdentity: "1:2",
        argumentsSha256: "f".repeat(64),
        executable: "/fixture/node",
      },
    },
  };
  const runtime = {
    sourceCommit,
    directory,
    artifactSha256: "b".repeat(64),
    entrypoint: file(
      `${directory}/packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js`,
    ),
    ownerLauncher: file(`${directory}/scripts/run-coordinator-owner.py`),
    ownershipVerifier: file(`${directory}/scripts/verify-coordinator-owner.py`),
  };
  const release = {
    sourceCommit,
    directory,
    artifactSha256: runtime.artifactSha256,
    node: host.node,
    entrypoint: file(
      `${directory}/packages/server/dist/server/server/execution-installation/main.js`,
    ),
    configuration: file("/fixture/candidate.json"),
    launcher: file("/fixture/candidate.plist"),
  };
  const plan = CoordinatorBootstrapPlanSchema.parse({
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: randomUUID(),
    service: "gui/501/local.vorteo.fixture.installation",
    expectedProcess: {
      pid: 121,
      bootId: randomUUID(),
      startIdentity: "1:1",
      argumentsSha256: "f".repeat(64),
    },
    previous: { ...release, directory: "/fixture/previous", sourceCommit: "e".repeat(40) },
    candidate: release,
    compatibleRecovery: { ...release, configuration: file("/fixture/recovery.json") },
    automaticRecovery: "restore-compatible",
    hostRequestsAfter: null,
    state: {
      directory: "/fixture/state/coordinator",
      restartJournal: "/fixture/state/coordinator/restarts.json",
      ownerSessions: "/fixture/state/coordinator/owner.json",
    },
  });
  const runner = {
    ...host,
    runtimeDirectory: directory,
    runtimeSha256: runtime.artifactSha256,
    entrypoint: runtime.entrypoint,
    ownerLauncher: runtime.ownerLauncher,
    ownershipVerifier: runtime.ownershipVerifier,
  };
  const receipt = {
    version: 1,
    operation: "provision-coordinator-maintenance",
    installationId: plan.installationId,
    requestId: randomUUID(),
    installationRecord: file("/fixture/installation.json"),
    planSha256: coordinatorPlanDigest(plan),
    hostSetupSha256: maintenanceHostSetupDigest(host),
    runtime,
  };
  return { installationRoot, receipt, plan, hostSetup: host, runnerSetup: runner };
}

test("independent maintenance preserves actual Host provenance and separate recovery reader", () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = inspectMaintenanceAdmission(input);
  expect(result.runner.renewal?.sourceCommit).toBe(input.hostSetup.renewal.sourceCommit);
  expect(result.runner.renewal?.sourceCommit).not.toBe(result.receipt.runtime.sourceCommit);
  expect(result.plan.compatibleRecovery?.sourceCommit).toBe(result.receipt.runtime.sourceCommit);
  expect(input).toEqual(before);
});

test.each([
  "plan",
  "host",
  "runtime",
  "ownerLauncher",
  "candidate",
  "recovery",
  "installation",
  "source",
  "policy",
  "dispatch",
  "repair",
] as const)("maintenance refuses changed %s authority", (change) => {
  const input = fixture();
  switch (change) {
    case "plan":
      input.plan.expectedProcess.pid++;
      break;
    case "host":
      input.hostSetup.renewal.hostProcess.startIdentity = "3:4";
      break;
    case "runtime":
      input.runnerSetup.runtimeSha256 = "f".repeat(64);
      break;
    case "ownerLauncher":
      input.runnerSetup.ownerLauncher = {
        ...input.runnerSetup.ownerLauncher,
        path: "/other/owner.py",
      };
      break;
    case "candidate":
      input.plan.candidate.directory = "/other/runtime";
      break;
    case "recovery":
      input.plan.compatibleRecovery!.sourceCommit = "f".repeat(40);
      break;
    case "installation":
      input.receipt.installationId = randomUUID();
      break;
    case "source":
      input.runnerSetup.renewal = {
        ...input.runnerSetup.renewal,
        sourceCommit: input.receipt.runtime.sourceCommit,
      };
      break;
    case "policy":
      input.plan.hostRequestsAfter = "2026-10-15T00:00:00.000Z";
      break;
    case "dispatch":
      Object.assign(input.hostSetup.renewal, {
        request: {
          id: input.receipt.requestId,
          revision: randomUUID(),
          planSha256: input.receipt.planSha256,
        },
      });
      break;
    case "repair":
      input.receipt.operation = "provision-claimed-repair";
      break;
  }
  // Rehashing a changed plan does not grant broader runtime or policy authority.
  if (["candidate", "recovery", "policy"].includes(change))
    input.receipt.planSha256 = coordinatorPlanDigest(input.plan);
  expect(() => inspectMaintenanceAdmission(input)).toThrow();
});

test("proposal inspection requires exact protected bytes and rechecks after artifact traversal", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "maintenance-admission-")));
  roots.push(root);
  const input: ReturnType<typeof fixture> = JSON.parse(
    JSON.stringify(fixture()).replaceAll("/fixture", root),
  );
  input.receipt.hostSetupSha256 = maintenanceHostSetupDigest(input.hostSetup);
  input.receipt.planSha256 = coordinatorPlanDigest(input.plan);
  await mkdir(input.receipt.runtime.directory, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(input.receipt));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const receiptFile = {
    path: `${root}/maintenance-admissions/${digest}/proposal.json`,
    sha256: digest,
  };
  await mkdir(path.dirname(receiptFile.path), { recursive: true, mode: 0o700 });
  const protectedPaths = vi.spyOn(artifacts, "assertBootstrapPathsProtected").mockResolvedValue();
  const read = vi.spyOn(artifacts, "readBootstrapPreparedFile").mockImplementation(async (file) => {
    if (file.path === receiptFile.path) return bytes;
    if (file.path === input.receipt.installationRecord.path)
      return Buffer.from(
        JSON.stringify({
          root: input.installationRoot,
          installationId: input.plan.installationId,
          coordinatorService: input.plan.service,
        }),
      );
    return Buffer.from("fixture");
  });
  vi.spyOn(artifacts, "digestBootstrapArtifact").mockResolvedValue(
    input.receipt.runtime.artifactSha256,
  );
  const releases = vi.spyOn(artifacts, "verifyBootstrapReleaseArtifacts").mockResolvedValue();
  const config = vi
    .spyOn(hostVerification, "verifyBootstrapConfiguration")
    .mockReturnValue(undefined);
  await verifyMaintenanceProposalFiles({
    ...input,
    receiptFile,
    writableMountRoots: ["/container"],
  });
  expect(protectedPaths).toHaveBeenCalledWith(
    [input.installationRoot, receiptFile.path],
    ["/container"],
  );
  expect(releases.mock.calls.map(([release]) => release)).toEqual([
    input.plan.previous,
    input.plan.candidate,
    input.plan.compatibleRecovery,
  ]);
  expect(config).toHaveBeenCalledWith({
    plan: input.plan,
    configurationFile: input.hostSetup.renewal.configuration.path,
    daemonId: "host",
  });
  expect(read.mock.calls.filter(([file]) => file.path === receiptFile.path)).toHaveLength(2);
  expect(
    read.mock.calls.filter(([file]) => file.path === input.receipt.installationRecord.path),
  ).toHaveLength(2);
  // Even a successful structural/runtime check must propagate a final pin failure.
  let proposalReads = 0;
  const original = read.getMockImplementation()!;
  read.mockImplementation(async (...args) => {
    if (args[0].path === receiptFile.path && ++proposalReads === 2)
      throw new Error("Prepared document digest changed");
    return original(...args);
  });
  await expect(
    verifyMaintenanceProposalFiles({ ...input, receiptFile, writableMountRoots: [] }),
  ).rejects.toThrow("digest changed");
});

for (const status of ["pending", "approved", "canceled"] as const) {
  test(`maintenance reopen observes retained ${status} without replay`, async () => {
    const input = fixture();
    const own = CoordinatorBootstrapRequestSchema.parse({
      id: input.receipt.requestId,
      revision: randomUUID(),
      requestedBy: "host-agent",
      reason: "Fixture",
      createdAt: "2026-10-15T00:00:00.000Z",
      status,
      plan: input.plan,
      planSha256: input.receipt.planSha256,
    });
    const prepare = vi.fn(async () => own);
    const decide = vi.fn(async () => own);
    const createService = vi.fn(async () => ({ list: () => [own], prepare, decide }));
    const provision = vi.fn(async () => {});
    const state = createMaintenanceReviewState({
      preparation: { id: own.id, reason: "Fixture", plan: input.plan },
      readRequests: () => [own],
      authenticateAndProvision: provision,
      createService,
    });
    await state.reopen();
    expect(state.list()).toEqual([own]);
    expect(state.phase()).toBe(status === "pending" ? "ready" : "unavailable");
    expect(createService).toHaveBeenCalledTimes(status === "pending" ? 1 : 0);
    expect(prepare).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(state.service().automatic).toBeUndefined();
  });
}

test("maintenance validation preserves a concurrent approval without preparing or replaying it", async () => {
  const input = fixture();
  let own = CoordinatorBootstrapRequestSchema.parse({
    id: input.receipt.requestId,
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Fixture",
    createdAt: "2026-10-15T00:00:00.000Z",
    status: "pending",
    plan: input.plan,
    planSha256: input.receipt.planSha256,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prepare = vi.fn(async () => own);
  const decide = vi.fn(async () => own);
  const state = createMaintenanceReviewState({
    preparation: { id: own.id, reason: "Fixture", plan: input.plan },
    readRequests: () => [own],
    authenticateAndProvision: async () => {},
    createService: async () => {
      entered.resolve();
      await release.promise;
      return { list: () => [own], prepare, decide };
    },
  });
  const opening = state.reopen();
  await entered.promise;
  await expect(state.reopen()).rejects.toThrow("already running");
  own = { ...own, status: "approved", revision: randomUUID() };
  release.resolve();
  await opening;
  expect(state.phase()).toBe("unavailable");
  expect(state.list()).toEqual([own]);
  expect(prepare).not.toHaveBeenCalled();
  expect(decide).not.toHaveBeenCalled();
});

test("maintenance provisions one exact pending review and preserves it after a lost preparation reply", async () => {
  const input = fixture();
  const own = CoordinatorBootstrapRequestSchema.parse({
    id: input.receipt.requestId,
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Fixture",
    createdAt: "2026-10-15T00:00:00.000Z",
    status: "pending",
    plan: input.plan,
    planSha256: input.receipt.planSha256,
  });
  let records: (typeof own)[] = [];
  const prepare = vi.fn(async () => {
    records = [own];
    throw new Error("fixture lost preparation reply");
  });
  const decide = vi.fn(async () => own);
  const provision = vi.fn(async () => {});
  const state = createMaintenanceReviewState({
    preparation: { id: own.id, reason: "Fixture", plan: input.plan },
    readRequests: () => records,
    authenticateAndProvision: provision,
    createService: async () => ({ list: () => records, prepare, decide }),
  });
  await expect(state.provision("fixture-password")).rejects.toThrow("lost preparation reply");
  expect(state.phase()).toBe("unavailable");
  expect(state.list()).toEqual([own]);
  expect(state.service().available).toBe(false);
  await state.reopen();
  expect(state.phase()).toBe("ready");
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledWith({ id: own.id, reason: "Fixture", plan: input.plan });
  expect(provision).toHaveBeenCalledTimes(1);
  expect(decide).not.toHaveBeenCalled();
});

test("maintenance owner authentication follows the exact selected launcher and refuses ambiguous configuration", () => {
  const { plan } = fixture();
  const previous = Buffer.from("previous-launcher");
  const candidate = Buffer.from("candidate-launcher");
  plan.previous.launcher.sha256 = createHash("sha256").update(previous).digest("hex");
  plan.candidate.launcher = {
    ...plan.candidate.launcher,
    sha256: createHash("sha256").update(candidate).digest("hex"),
  };
  plan.compatibleRecovery = { ...plan.previous };
  expect(selectMaintenanceOwnerConfiguration(plan, previous)).toEqual(plan.previous.configuration);
  expect(selectMaintenanceOwnerConfiguration(plan, candidate)).toEqual(
    plan.candidate.configuration,
  );
  expect(() => selectMaintenanceOwnerConfiguration(plan, Buffer.from("unknown"))).toThrow(
    "ambiguous",
  );
  plan.compatibleRecovery.configuration = {
    ...plan.previous.configuration,
    sha256: "9".repeat(64),
  };
  expect(() => selectMaintenanceOwnerConfiguration(plan, previous)).toThrow("ambiguous");
});

test.each([
  "valid",
  "wrong-admission",
  "wrong-native-identity",
  "wrong-runtime",
  "wrong-plan",
  "revoked-during-validation",
] as const)("enrolled provisioning carries only exact durable consent: %s", async (mode) => {
  const {
    input,
    context,
    digest,
    directory,
    journal,
    manifest,
    enrollInstallation,
    enrollmentManifestDigest,
    changeStandingGrant,
  } = await enrollmentFixture();
  if (mode === "wrong-admission") manifest.provisioning!.admissionSha256 = "0".repeat(64);
  if (mode === "wrong-native-identity") manifest.targets[0].identitySha256 = "b".repeat(64);
  if (mode === "wrong-runtime") manifest.steps[0].candidate.artifactSha256 = "0".repeat(64);
  if (mode === "wrong-plan") manifest.steps[0].planSha256 = "0".repeat(64);
  const enrolled = enrollInstallation(journal, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: "2026-10-15T01:00:00.000Z",
    },
  });
  if (enrolled.status !== "enrolled") throw new Error("Missing fixture grant");
  let calls = 0;
  vi.spyOn(nativeMaintenance, "verifyNativeMaintenanceProposal").mockImplementation(async () => {
    if (++calls === 2 && mode === "revoked-during-validation")
      changeStandingGrant(journal, {
        expectedRevision: enrolled.grant.revision,
        paused: false,
        disabledTargets: [],
        revoke: true,
      });
    return context;
  });
  const operation = provisionEnrolledCoordinatorMaintenance({
    ...input,
    admissionSha256: digest,
    grantId: enrolled.grant.id,
    grantRevision: enrolled.grant.revision,
  });
  if (mode !== "valid") {
    await expect(operation).rejects.toThrow("Enrollment no longer authorizes");
    expect(await readdir(directory)).toEqual([]);
    return;
  }
  const result = await operation;
  expect(result.dispatched).toBe(false);
  expect(result.consent.approval).toEqual(enrolled.grant.approval);
  expect(JSON.parse(await readFile(path.join(directory, "enrollment.json"), "utf8"))).toEqual(
    result.consent,
  );
  expect(journal.read()).toEqual(enrolled);
  expect(new FileBootstrapRequestJournal(input.plan.state.directory).read()).toEqual([]);
});

async function enrollmentFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "enrolled-maintenance-")));
  roots.push(root);
  const input: ReturnType<typeof fixture> = JSON.parse(
    JSON.stringify(fixture()).replaceAll("/fixture", root),
  );
  const ownerBytes = JSON.stringify({
    public: { installationId: input.plan.installationId },
    ownerPasswordHash: hashSync("fixture-owner", 4),
  });
  await writeFile(input.hostSetup.renewal.configuration.path, ownerBytes, { mode: 0o600 });
  input.hostSetup.renewal.configuration.sha256 = createHash("sha256")
    .update(ownerBytes)
    .digest("hex");
  input.runnerSetup.renewal = structuredClone(input.hostSetup.renewal);
  input.receipt.hostSetupSha256 = maintenanceHostSetupDigest(input.hostSetup);
  input.receipt.planSha256 = coordinatorPlanDigest(input.plan);
  const context = {
    ...inspectMaintenanceAdmission(input),
    writableMountRoots: [],
    coordinatorIdentitySha256: "a".repeat(64),
  };
  const digest = createHash("sha256").update(JSON.stringify(context.receipt)).digest("hex");
  const directory = path.join(root, "maintenance-admissions", digest);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(input.plan.state.directory, { recursive: true, mode: 0o700 });
  const {
    FileEnrollmentJournal,
    enrollInstallation,
    enrollmentManifestDigest,
    changeStandingGrant,
  } = await import("./maintenance/authorization.js");
  const { InstallationEnrollmentManifestSchema } =
    await import("@getpaseo/protocol/installation-enrollment");
  const journal = new FileEnrollmentJournal(input.plan.state.directory);
  const stepId = randomUUID();
  const manifest = InstallationEnrollmentManifestSchema.parse({
    version: 1,
    operation: "installation-enrollment",
    installationId: input.plan.installationId,
    revision: randomUUID(),
    createdAt: "2026-10-15T00:00:00.000Z",
    targets: ["coordinator", "maintenance-controller", "recovery-launcher"].map((target) => ({
      target,
      identitySha256: "a".repeat(64),
      operations: ["replacement", "recovery"],
    })),
    trustedRepositories: ["https://github.com/example/installation.git"],
    provisioning: {
      admissionSha256: digest,
      coordinatorStepId: stepId,
    },
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 5 },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    steps: [
      {
        id: stepId,
        target: "coordinator",
        operation: "replacement",
        planSha256: context.receipt.planSha256,
        candidate: {
          sourceCommit: input.plan.candidate.sourceCommit,
          artifactSha256: input.plan.candidate.artifactSha256,
        },
        previous: {
          sourceCommit: input.plan.previous.sourceCommit,
          artifactSha256: input.plan.previous.artifactSha256,
        },
        dependsOn: [],
      },
    ],
  });
  return {
    input,
    context,
    digest,
    directory,
    journal,
    manifest,
    enrollInstallation,
    enrollmentManifestDigest,
    changeStandingGrant,
  };
}

test.each([
  "valid",
  "wrong-password",
  "wrong-revision",
  "wrong-digest",
  "changed-after-auth",
  "revoked-repeat",
] as const)("combined enrollment preserves one exact owner decision: %s", async (mode) => {
  const {
    input,
    context,
    digest,
    directory,
    journal,
    manifest,
    enrollmentManifestDigest,
    changeStandingGrant,
  } = await enrollmentFixture();
  const native = vi
    .spyOn(nativeMaintenance, "verifyNativeMaintenanceProposal")
    .mockResolvedValue(context);
  if (mode === "changed-after-auth")
    native.mockResolvedValueOnce(context).mockResolvedValueOnce({
      ...context,
      writableMountRoots: ["/changed"],
    });
  const review = { id: randomUUID(), revision: manifest.revision, manifest };
  const decision = {
    id: review.id,
    revision: review.revision,
    manifestSha256: enrollmentManifestDigest(manifest),
  };
  if (mode === "wrong-revision") review.revision = decision.revision = randomUUID();
  if (mode === "wrong-digest") decision.manifestSha256 = "0".repeat(64);
  const operation = enrollAndProvisionCoordinatorMaintenance({
    ...input,
    admissionSha256: digest,
    review,
    decision,
    ownerPassword: mode === "wrong-password" ? "incorrect" : "fixture-owner",
  });
  if (mode !== "valid" && mode !== "revoked-repeat") {
    await expect(operation).rejects.toThrow();
    expect(journal.read().status).toBe("absent");
    expect(await readdir(directory)).toEqual([]);
    return;
  }
  const result = await operation;
  const enrolled = journal.read();
  expect(result.dispatched).toBe(false);
  expect(enrolled.status).toBe("enrolled");
  if (enrolled.status !== "enrolled") throw new Error("Missing grant");
  expect(enrolled.grant.approval.reviewRevision).toBe(manifest.revision);
  if (mode === "revoked-repeat") {
    changeStandingGrant(journal, {
      expectedRevision: enrolled.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
    const revoked = journal.read();
    await expect(
      enrollAndProvisionCoordinatorMaintenance({
        ...input,
        admissionSha256: digest,
        review,
        decision,
        ownerPassword: "fixture-owner",
      }),
    ).rejects.toThrow("Enrollment no longer authorizes");
    expect(journal.read()).toEqual(revoked);
    return;
  }
  // A lost response must reuse durable consent, not ask for another password or dispatch.
  const repeated = await enrollAndProvisionCoordinatorMaintenance({
    ...input,
    admissionSha256: digest,
    review,
    decision,
  });
  expect(repeated.consent).toEqual(result.consent);
  expect(journal.read()).toEqual(enrolled);
  expect(new FileBootstrapRequestJournal(input.plan.state.directory).read()).toEqual([]);
});

test.each([
  "save",
  "wrong-password",
  "changed-after-auth",
  "changed-manifest",
  "revoked-repeat",
] as const)(
  "consent-only enrollment writes no provisioning or lifecycle effects: %s",
  async (mode) => {
    const {
      input,
      context,
      digest,
      directory,
      journal,
      manifest,
      enrollmentManifestDigest,
      changeStandingGrant,
    } = await enrollmentFixture();
    const { recordCoordinatorMaintenanceEnrollment } =
      await import("./coordinator-bootstrap-maintenance-provisioning.js");
    const review = { id: randomUUID(), revision: manifest.revision, manifest };
    const decision = {
      id: review.id,
      revision: review.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
    };
    let inspections = 0;
    const ports = {
      async verifyProposal() {
        inspections++;
        return mode === "changed-after-auth" && inspections === 2
          ? { ...context, writableMountRoots: ["/changed"] }
          : context;
      },
    };
    const prepared = { ...input, admissionSha256: digest, review, decision };
    const operation = recordCoordinatorMaintenanceEnrollment(
      { ...prepared, ownerPassword: mode === "wrong-password" ? "incorrect" : "fixture-owner" },
      ports,
    );
    if (mode === "wrong-password" || mode === "changed-after-auth") {
      await expect(operation).rejects.toThrow();
      expect(journal.read().status).toBe("absent");
      expect(await readdir(directory)).toEqual([]);
      return;
    }
    const state = await operation;
    expect(state.status).toBe("enrolled");
    expect(state.activation.steps.every((step) => step.status === "pending")).toBe(true);
    expect(await readdir(directory)).toEqual([]);
    expect(new FileBootstrapRequestJournal(input.plan.state.directory).read()).toEqual([]);
    if (mode === "changed-manifest") {
      const changed = { ...manifest, revision: randomUUID() };
      const changedReview = { ...review, revision: changed.revision, manifest: changed };
      await expect(
        recordCoordinatorMaintenanceEnrollment(
          {
            ...prepared,
            review: changedReview,
            decision: {
              ...decision,
              revision: changed.revision,
              manifestSha256: enrollmentManifestDigest(changed),
            },
          },
          ports,
        ),
      ).rejects.toThrow("Retained enrollment differs");
      expect(journal.read()).toEqual(state);
      return;
    }
    if (mode === "revoked-repeat") {
      changeStandingGrant(journal, {
        expectedRevision: state.grant.revision,
        paused: false,
        disabledTargets: [],
        revoke: true,
      });
    }
    const retained = journal.read();
    // Losing the response does not replace consent or repeat authentication.
    expect(await recordCoordinatorMaintenanceEnrollment(prepared, ports)).toEqual(retained);
    expect(journal.read()).toEqual(retained);
    expect(await readdir(directory)).toEqual([]);
    expect(new FileBootstrapRequestJournal(input.plan.state.directory).read()).toEqual([]);
  },
);

test("interrupted provisioning resumes the retained enrollment without another approval", async () => {
  const { input, context, digest, directory, journal, manifest, enrollmentManifestDigest } =
    await enrollmentFixture();
  vi.spyOn(nativeMaintenance, "verifyNativeMaintenanceProposal")
    .mockResolvedValue(context)
    .mockResolvedValueOnce(context)
    .mockResolvedValueOnce(context)
    .mockRejectedValueOnce(new Error("fixture interruption after durable approval"));
  const review = { id: randomUUID(), revision: manifest.revision, manifest };
  const decision = {
    id: review.id,
    revision: review.revision,
    manifestSha256: enrollmentManifestDigest(manifest),
  };
  const prepared = { ...input, admissionSha256: digest, review, decision };
  await expect(
    enrollAndProvisionCoordinatorMaintenance({
      ...prepared,
      ownerPassword: "fixture-owner",
    }),
  ).rejects.toThrow("fixture interruption");
  const retained = journal.read();
  expect(retained.status).toBe("enrolled");
  expect(await readdir(directory)).toEqual([]);
  const result = await enrollAndProvisionCoordinatorMaintenance(prepared);
  expect(result.dispatched).toBe(false);
  expect(journal.read()).toEqual(retained);
  expect(new FileBootstrapRequestJournal(input.plan.state.directory).read()).toEqual([]);
});

test.each([
  "valid",
  "changed-bytes",
  "wrong-revision",
  "wrong-installation",
  "wrong-admission",
] as const)(
  "controller enrollment review is bound to protected startup bytes: %s",
  async (mode) => {
    const { input, directory, digest, manifest } = await enrollmentFixture();
    const { readMaintenanceEnrollmentReview } =
      await import("./coordinator-bootstrap-maintenance-controller.js");
    const review = { id: randomUUID(), revision: manifest.revision, manifest };
    if (mode === "wrong-revision") review.revision = randomUUID();
    const bytes = JSON.stringify(review);
    const pin = createHash("sha256").update(bytes).digest("hex");
    await writeFile(
      path.join(directory, "enrollment-review.json"),
      mode === "changed-bytes" ? bytes + " " : bytes,
      { mode: 0o600 },
    );
    const operation = readMaintenanceEnrollmentReview(
      directory,
      pin,
      mode === "wrong-admission" ? "0".repeat(64) : digest,
      mode === "wrong-installation" ? randomUUID() : input.plan.installationId,
    );
    if (mode !== "valid") {
      await expect(operation).rejects.toThrow();
      return;
    }
    expect(await operation).toEqual(review);
  },
);

test.each([
  "valid",
  "revoked-before-approval",
  "revoked-before-claim",
  "wrong-generation",
  "wrong-manifest",
  "changed-provenance",
] as const)("real journal serializes enrollment authority with native claim: %s", async (mode) => {
  const {
    input,
    journal,
    manifest,
    enrollInstallation,
    enrollmentManifestDigest,
    changeStandingGrant,
  } = await enrollmentFixture();
  const { reserveActivationStep } = await import("./maintenance/authorization.js");
  const enrolled = enrollInstallation(journal, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: "2026-10-15T01:00:00.000Z",
    },
  });
  if (enrolled.status !== "enrolled") throw new Error("Fixture grant absent");
  const reserved = reserveActivationStep(journal, {
    grantRevision: enrolled.grant.revision,
    stepId: manifest.steps[0].id,
  });
  if (reserved.status !== "enrolled") throw new Error("Fixture reservation absent");
  const progress = reserved.activation.steps[0];
  if (progress.status !== "reserved") throw new Error("Fixture step not reserved");
  const bootstrap = new FileBootstrapRequestJournal(input.plan.state.directory);
  const pending = CoordinatorBootstrapRequestSchema.parse({
    id: input.receipt.requestId,
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Exact enrolled step",
    createdAt: "2026-10-15T01:00:00.000Z",
    plan: input.plan,
    planSha256: coordinatorPlanDigest(input.plan),
    status: "pending",
  });
  bootstrap.replace([], [pending]);
  let approved = CoordinatorBootstrapRequestSchema.parse({
    ...pending,
    revision: randomUUID(),
    status: "approved",
    decisionAt: enrolled.grant.approval.approvedAt,
    enrollment: {
      grantId: enrolled.grant.id,
      grantRevision: enrolled.grant.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      reviewId: enrolled.grant.approval.requestId,
      reviewRevision: manifest.revision,
      admissionSha256: manifest.provisioning!.admissionSha256,
      stepId: progress.id,
      generation: progress.generation,
    },
  });
  const revoke = () =>
    changeStandingGrant(journal, {
      expectedRevision: enrolled.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
  if (mode === "revoked-before-approval") revoke();
  if (mode === "wrong-generation") approved.enrollment!.generation = randomUUID();
  if (mode === "wrong-manifest") approved.enrollment!.manifestSha256 = "0".repeat(64);
  if (["revoked-before-approval", "wrong-generation", "wrong-manifest"].includes(mode)) {
    expect(() => bootstrap.replace([pending], [approved])).toThrow(
      "Enrollment no longer authorizes",
    );
    expect(bootstrap.read()).toEqual([pending]);
    return;
  }
  bootstrap.replace([pending], [approved]);
  if (mode === "valid") {
    const { enrollment: _proof, ...unbound } = approved;
    const competing = CoordinatorBootstrapRequestSchema.parse({
      ...unbound,
      id: randomUUID(),
      revision: randomUUID(),
      execution: {
        generation: randomUUID(),
        stage: "claimed",
        updatedAt: "2026-10-15T01:00:01.000Z",
      },
    });
    expect(() => bootstrap.replace([approved], [approved, competing])).toThrow(
      "activation must be reconciled",
    );
    expect(bootstrap.read()).toEqual([approved]);
  }
  const { reserveEnrolledBootstrapLaunch } =
    await import("./coordinator-bootstrap-maintenance-dispatch.js");
  approved = reserveEnrolledBootstrapLaunch(approved);
  if (mode === "revoked-before-claim") revoke();
  const claimed = CoordinatorBootstrapRequestSchema.parse({
    ...approved,
    revision: randomUUID(),
    execution: {
      generation: randomUUID(),
      stage: "claimed",
      updatedAt: "2026-10-15T01:00:01.000Z",
    },
  });
  if (mode === "changed-provenance") claimed.enrollment!.generation = randomUUID();
  if (mode !== "valid") {
    expect(() => bootstrap.replace([approved], [claimed])).toThrow();
    expect(bootstrap.read()).toEqual([approved]);
    return;
  }
  bootstrap.replace([approved], [claimed]);
  revoke();
  // Revocation stops new dispatch; it must not erase the already-owned operation or block its recovery bookkeeping.
  const observed = {
    ...claimed,
    revision: randomUUID(),
    execution: { ...claimed.execution!, stage: "recovery_required" as const },
  };
  bootstrap.replace([claimed], [observed]);
  expect(bootstrap.read()).toEqual([observed]);
  const { observeEnrolledCoordinator } =
    await import("./coordinator-bootstrap-maintenance-observation.js");
  const verify = vi.fn(async () => {});
  const observation = { directory: input.plan.state.directory, requestId: observed.id, verify };
  await expect(observeEnrolledCoordinator(observation)).rejects.toThrow("no completed execution");
  expect(verify).not.toHaveBeenCalled();
  // Fixture terminal evidence is deliberately synthetic. Native verification is
  // exercised separately by the compiled disposable controller acceptance.
  const completed = {
    ...observed,
    revision: randomUUID(),
    execution: { ...observed.execution, stage: "succeeded" as const },
  };
  bootstrap.replace([observed], [completed]);
  const before = journal.read();
  verify.mockRejectedValueOnce(new Error("candidate native identity changed"));
  await expect(observeEnrolledCoordinator(observation)).rejects.toThrow("native identity changed");
  expect(journal.read()).toEqual(before);
  const settled = await observeEnrolledCoordinator(observation);
  expect(settled.status === "enrolled" && settled.activation.steps[0].status).toBe("succeeded");
  expect(await observeEnrolledCoordinator(observation)).toEqual(settled);
  expect(bootstrap.read()).toEqual([completed]);
});

test("enrollment approval and native launch each retain one nonreplayable reservation", async () => {
  const { input, journal, manifest, enrollInstallation, enrollmentManifestDigest } =
    await enrollmentFixture();
  const { approveEnrolledBootstrap, reserveEnrolledBootstrapLaunch } =
    await import("./coordinator-bootstrap-maintenance-dispatch.js");
  const review = {
    id: randomUUID(),
    revision: manifest.revision,
    manifestSha256: enrollmentManifestDigest(manifest),
  };
  enrollInstallation(journal, {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: review.id,
      reviewRevision: review.revision,
      manifestSha256: review.manifestSha256,
      approvedAt: "2026-10-15T01:00:00.000Z",
    },
  });
  const bootstrap = new FileBootstrapRequestJournal(input.plan.state.directory);
  const pending = CoordinatorBootstrapRequestSchema.parse({
    id: input.receipt.requestId,
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Enrolled initial migration",
    createdAt: "2026-10-15T01:00:00.000Z",
    status: "pending",
    plan: input.plan,
    planSha256: coordinatorPlanDigest(input.plan),
  });
  bootstrap.replace([], [pending]);
  const approved = approveEnrolledBootstrap({
    request: pending,
    review,
    admissionSha256: manifest.provisioning!.admissionSha256,
  });
  expect(approved.enrollment?.reviewId).toBe(review.id);
  expect(approved.automaticApproval).toBeUndefined();
  expect(() =>
    approveEnrolledBootstrap({
      request: pending,
      review,
      admissionSha256: manifest.provisioning!.admissionSha256,
    }),
  ).toThrow();
  expect(bootstrap.read()).toEqual([approved]);
  const premature = {
    ...approved,
    execution: {
      generation: randomUUID(),
      stage: "claimed" as const,
      updatedAt: "2026-10-15T01:00:01.000Z",
    },
  };
  expect(() => bootstrap.replace([approved], [premature])).toThrow("reserved native launch");
  const dispatched = reserveEnrolledBootstrapLaunch(approved);
  expect(() => reserveEnrolledBootstrapLaunch(approved)).toThrow();
  expect(() => reserveEnrolledBootstrapLaunch(dispatched)).toThrow();
  expect(bootstrap.read()).toEqual([dispatched]);
  expect(journal.read().status).toBe("enrolled");
});

test.each([
  "ready",
  "fenced-health",
  "wrong-installation",
  "wrong-boot",
  "wrong-argv",
  "old-pid",
  "changed-birth",
  "changed-service",
  "unfinished",
] as const)("completed maintenance native observation: %s", async (mode) => {
  const { verifyCompletedMaintenanceCandidate } =
    await import("./coordinator-bootstrap-maintenance-observation.js");
  const { plan } = fixture();
  const request = CoordinatorBootstrapRequestSchema.parse({
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Completed observation fixture",
    createdAt: "2026-10-15T00:00:00.000Z",
    status: "approved",
    decisionAt: "2026-10-15T00:01:00.000Z",
    plan,
    planSha256: coordinatorPlanDigest(plan),
    execution: {
      generation: randomUUID(),
      stage: mode === "unfinished" ? "claimed" : "succeeded",
      updatedAt: "2026-10-15T00:02:00.000Z",
    },
  });
  const pid = mode === "old-pid" ? plan.expectedProcess.pid : 999;
  const processIdentity = {
    pid,
    parentPid: 1,
    uid: process.getuid!(),
    bootId: mode === "wrong-boot" ? randomUUID() : plan.expectedProcess.bootId,
    startIdentity: "2:3",
    executable: plan.candidate.node.path,
    argumentsSha256:
      mode === "wrong-argv"
        ? "0".repeat(64)
        : createHash("sha256")
            .update(
              JSON.stringify([
                plan.candidate.node.path,
                plan.candidate.entrypoint.path,
                plan.candidate.configuration.path,
              ]),
            )
            .digest("hex"),
  };
  let processReads = 0;
  let serviceReads = 0;
  const reader = {
    readService: vi.fn(
      async () =>
        `${plan.service} = {\n\tpid = ${mode === "changed-service" && serviceReads++ > 0 ? pid + 1 : pid}\n}`,
    ),
    inspectProcess: vi.fn(async () => ({
      ...processIdentity,
      startIdentity: mode === "changed-birth" && processReads++ > 0 ? "2:4" : "2:3",
    })),
  };
  const health = vi.fn(async () => ({
    installationId: mode === "wrong-installation" ? randomUUID() : plan.installationId,
    ...(mode === "fenced-health"
      ? { bootstrap: { generation: request.execution!.generation, pid, fenced: true } }
      : {}),
  }));
  const result = verifyCompletedMaintenanceCandidate(request, reader, health);
  if (mode === "ready") {
    await expect(result).resolves.toBeUndefined();
    expect(health).toHaveBeenCalledTimes(2);
    expect(reader.inspectProcess).toHaveBeenCalledTimes(4);
  } else {
    await expect(result).rejects.toThrow();
  }
});

test.each([
  "valid",
  "revoked",
  "incomplete",
  "candidate",
  "plan",
  "mixed",
  "early",
  "claim-without-dispatch",
  "producer",
  "stale-evidence",
  "changed-during-native",
  "changed-before-decision",
  "changed-before-dispatch",
  "async-recheck",
] as const)("standing coordinator uses retained grant and shared journal: %s", async (mode) => {
  const f = await enrollmentFixture();
  const { reserveActivationStep, observeActivationStep } =
    await import("./maintenance/authorization.js");
  const enrolled = f.enrollInstallation(f.journal, {
    manifest: f.manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: f.manifest.revision,
      manifestSha256: f.enrollmentManifestDigest(f.manifest),
      approvedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  if (enrolled.status !== "enrolled") throw Error("fixture enrollment");
  const reserved = reserveActivationStep(f.journal, {
    grantRevision: enrolled.grant.revision,
    stepId: f.manifest.steps[0].id,
  });
  if (reserved.status !== "enrolled" || reserved.activation.steps[0].status !== "reserved")
    throw Error("fixture reservation");
  if (mode !== "incomplete")
    observeActivationStep(f.journal, {
      stepId: f.manifest.steps[0].id,
      generation: reserved.activation.steps[0].generation,
      outcome: "succeeded",
      observationSha256: "a".repeat(64),
    });
  const plan = structuredClone(f.input.plan);
  // This proposal is intentionally different from the initial enrollment plan.
  plan.candidate.sourceCommit = "9".repeat(40);
  const pending = CoordinatorBootstrapRequestSchema.parse({
    id: randomUUID(),
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Later fixture proposal",
    createdAt: new Date(Date.now() - 40_000).toISOString(),
    plan,
    planSha256: coordinatorPlanDigest(plan),
    status: "pending",
  });
  const journal = new FileBootstrapRequestJournal(plan.state.directory);
  journal.replace([], [pending]);
  const decidedAt = new Date(Date.now() - 31_000).toISOString();
  const approved = CoordinatorBootstrapRequestSchema.parse({
    ...pending,
    revision: randomUUID(),
    status: "approved",
    decisionAt: decidedAt,
    standingAuthority: {
      grantId: enrolled.grant.id,
      grantRevision: enrolled.grant.revision,
      manifestSha256: f.enrollmentManifestDigest(f.manifest),
      proposal: {
        id: pending.id,
        installationId: plan.installationId,
        requestedBy: "container-agent",
        target: "coordinator",
        identitySha256: "a".repeat(64),
        operation: "replacement",
        planSha256: pending.planSha256,
        repository: f.manifest.trustedRepositories[0],
        sourceCommit: plan.candidate.sourceCommit,
        artifactSha256: plan.candidate.artifactSha256,
      },
      nativeEvidenceSha256: "b".repeat(64),
      decidedAt,
      dispatchAfter: new Date(Date.parse(decidedAt) + 30_000).toISOString(),
    },
  });
  if (
    [
      "producer",
      "stale-evidence",
      "changed-during-native",
      "changed-before-decision",
      "changed-before-dispatch",
      "async-recheck",
    ].includes(mode)
  ) {
    const { approveStandingBootstrap, reserveStandingBootstrapLaunch } =
      await import("./coordinator-bootstrap-maintenance-standing-dispatch.js");
    const probeLock = () => journal.withRecoveryTransaction(() => {});
    const verify = vi.fn(async (request: typeof pending) => {
      if (mode === "changed-during-native")
        journal.replace([pending], [{ ...pending, revision: randomUUID(), status: "canceled" }]);
      return {
        requestId: request.id,
        requestRevision: request.revision,
        planSha256: request.planSha256,
        identitySha256: "a".repeat(64),
        sourceCommit: request.plan.candidate.sourceCommit,
        artifactSha256: request.plan.candidate.artifactSha256,
        evidenceSha256: "b".repeat(64),
        assertCurrent: () => {
          expect(probeLock).toThrow("storage is busy");
          if (
            mode === "changed-before-decision" ||
            (mode === "changed-before-dispatch" && request.status === "approved")
          )
            throw new Error("Native source selection changed");
          if (mode === "async-recheck") return Promise.resolve();
        },
        observedAt: new Date(Date.now() - (mode === "stale-evidence" ? 31_000 : 0)).toISOString(),
      };
    });
    const operation = approveStandingBootstrap({
      request: pending,
      proposal: approved.standingAuthority!.proposal,
      grantRevision: enrolled.grant.revision,
      verify,
    });
    if (mode !== "producer" && mode !== "changed-before-dispatch") {
      await expect(operation).rejects.toThrow();
      expect(journal.read()[0].status).toBe(
        mode === "changed-during-native" ? "canceled" : "pending",
      );
      return;
    }
    const decision = await operation;
    await expect(reserveStandingBootstrapLaunch({ request: decision, verify })).rejects.toThrow(
      "interval",
    );
    expect(verify).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse(decision.standingAuthority!.dispatchAfter) + 1,
    );
    if (mode === "changed-before-dispatch") {
      await expect(reserveStandingBootstrapLaunch({ request: decision, verify })).rejects.toThrow(
        "Native source selection changed",
      );
      expect(journal.read()).toEqual([decision]);
      expect(journal.read()[0].standingDispatch).toBeUndefined();
      return;
    }
    const launch = await reserveStandingBootstrapLaunch({ request: decision, verify });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(launch.standingDispatch!.nativeEvidenceSha256).toBe("b".repeat(64));
    const changed = structuredClone(launch);
    changed.plan.candidate.sourceCommit = "7".repeat(40);
    expect(() => journal.replace([launch], [changed])).toThrow("plan cannot change");
    await expect(reserveStandingBootstrapLaunch({ request: launch, verify })).rejects.toThrow(
      "already reserved",
    );
    expect(journal.read()).toEqual([launch]);
    return;
  }
  if (mode === "revoked")
    f.changeStandingGrant(f.journal, {
      expectedRevision: enrolled.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
  if (mode === "candidate") approved.standingAuthority!.proposal.sourceCommit = "8".repeat(40);
  if (mode === "plan") approved.standingAuthority!.proposal.planSha256 = "0".repeat(64);
  if (mode === "mixed")
    approved.automaticSubmission = {
      credentialBinding: "a".repeat(64),
      policyActivatedAt: decidedAt,
      submittedAt: decidedAt,
    };
  if (["revoked", "incomplete", "candidate", "plan", "mixed"].includes(mode)) {
    expect(() => journal.replace([pending], [approved])).toThrow();
    expect(journal.read()).toEqual([pending]);
    return;
  }
  if (mode === "early")
    approved.standingAuthority!.dispatchAfter = new Date(Date.now() + 30_000).toISOString();
  journal.replace([pending], [approved]);
  const dispatch = CoordinatorBootstrapRequestSchema.parse({
    ...approved,
    revision: randomUUID(),
    standingDispatch: {
      approvedRevision: approved.revision,
      requestedAt: new Date().toISOString(),
      nativeEvidenceSha256: "b".repeat(64),
    },
  });
  if (mode === "early") {
    expect(() => journal.replace([approved], [dispatch])).toThrow("interval");
    return;
  }
  const claim = {
    ...dispatch,
    revision: randomUUID(),
    execution: {
      generation: randomUUID(),
      stage: "claimed" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  if (mode === "claim-without-dispatch") {
    expect(() => journal.replace([approved], [claim])).toThrow("reserved native dispatch");
    return;
  }
  journal.replace([approved], [dispatch]);
  expect(journal.read()[0].standingAuthority!.proposal.requestedBy).toBe("container-agent");
  f.changeStandingGrant(f.journal, {
    expectedRevision: enrolled.grant.revision,
    paused: false,
    disabledTargets: [],
    revoke: true,
  });
  expect(() => journal.replace([dispatch], [claim])).toThrow();
  expect(journal.read()).toEqual([dispatch]);
});
