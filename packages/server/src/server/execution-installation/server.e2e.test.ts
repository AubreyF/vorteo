import { retainEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import type { WorkerLaunchLookup } from "./maintenance/worker-launch-lookup.js";
import { InstallationRestarts } from "./restarts.js";
import { standingRestartPlanDigest } from "./maintenance/restart-admission.js";
import {
  FileEnrollmentJournal,
  enrollInstallation,
  enrollmentManifestDigest,
  changeStandingGrant,
} from "./maintenance/authorization.js";
import type { InstallationEnrollmentManifest } from "@getpaseo/protocol/installation-enrollment";
import type { MaintenanceServiceExecutor } from "./maintenance/service-execution.js";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { MaintenanceServiceJobSchema } from "@getpaseo/protocol/maintenance-service";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { InstallationEnrollmentStatusSchema } from "@getpaseo/protocol/installation-enrollment";
import { DaemonAutomation, coordinatorAutomaticAuthority } from "./daemon-automation.js";
import {
  coordinatorPlanDigest,
  type BootstrapReconciliationLedger,
} from "./coordinator-bootstrap.js";
import { loadCoordinatorStartupFence } from "./coordinator-bootstrap-startup.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { RestartExecutor } from "./restarts.js";
import { NativeHelperJobSchema } from "@getpaseo/protocol/native-helper-maintenance";
import type { ClaudeSetupRuntime } from "./accounts/claude-setup-runtime.js";
import { InstallationSkillPackages } from "./settings/skill-packages.js";
import type { InstallationPluginSourceResolver } from "./settings/runtime.js";
import { createInstallationSettingsReader } from "./settings/admission.js";
import { InstallationSourceUpdates } from "./source-updates.js";
import { afterEach, expect, test, vi } from "vitest";
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server, type IncomingMessage } from "node:http";
import pino from "pino";
import { hashDaemonPassword } from "../auth.js";
import { createInstallationServer, type InstallationStartupFence } from "./server.js";
import { InstallationProfiles, type ProfileSharingState } from "./profiles/service.js";
import { createInstallationProfileReader } from "./profiles/admission.js";
import { InstallationSettingsService } from "./settings/service.js";
import { SettingsEnvironmentFake, SettingsJournalFake } from "./settings/fakes.js";
import { InstallationSettingsSnapshotSchema } from "@getpaseo/protocol/installation-settings";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import type {
  RestartImpact,
  ExecutionEnvironmentKind,
} from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "./config.js";
import { delegateToContainer, type DelegationClient } from "./delegation.js";
import {
  RestartJobSchema,
  SourceBatchSchema,
  SourceContributionSchema,
  InstallationUnlockSchema,
  InstallationProfilesSnapshotSchema,
} from "@getpaseo/protocol/execution-installation";

// The installation client refuses request commands outside the builds coordinator.
process.env.VORTEO_BUILDS = "1";

const cleanups: Array<() => Promise<void>> = [];
// Validate the allocated source-only optional field without rebuilding shared declarations.
vi.mock(
  "@getpaseo/protocol/execution-installation",
  () => import("../../../../protocol/src/execution-installation.js"),
);

test("supervisor effect remains private in legacy restart replies", async () => {
  const id = randomUUID(),
    revision = randomUUID(),
    now = "2026-10-17T00:00:00.000Z",
    sha = "a".repeat(64);
  const native = {
    pid: 123,
    parentPid: 1,
    uid: 501,
    bootId: randomUUID(),
    startIdentity: "1:1",
    argumentsSha256: sha,
    auditToken: [0, 1, 2, 3, 4, 5, 6, 7],
    executable: { path: "/fixture/node", sha256: sha },
    entrypoint: { path: "/fixture/entry", sha256: sha },
    artifactSha256: sha,
  };
  const job = RestartJobSchema.parse({
    id,
    revision,
    requestedBy: "host-agent",
    target: "container-daemon",
    reason: "Private projection fixture",
    createdAt: now,
    expiresAt: "9999-12-31T23:59:59.999Z",
    status: "failed",
    detail: "Observation only",
    approvedAt: now,
    supervisorPlanSha256: sha,
    supervisorEffect: {
      phase: "reserved",
      reservedAt: now,
      binding: {
        requestId: id,
        requestRevision: revision,
        approvedAt: now,
        decisionSha256: sha,
        requestPlanSha256: sha,
        supervisorPlanSha256: sha,
        registrationPlanSha256: sha,
        operation: "replace",
        preparationNonce: randomUUID(),
        original: null,
        generation: randomUUID(),
        candidateSha256: sha,
        grantId: randomUUID(),
        grantRevision: randomUUID(),
        manifestSha256: sha,
        stepId: randomUUID(),
        activationGeneration: randomUUID(),
        sourceCommit: "b".repeat(40),
        artifactSha256: sha,
        nativeIdentitySha256: sha,
        preconditionSha256: sha,
        settlementSha256: sha,
        controller: native,
      },
    },
  });
  if (job.supervisorEffect?.phase !== "reserved") throw new Error("Fixture reservation missing");
  const binding = job.supervisorEffect.binding;
  const requestPlanSha256 = standingRestartPlanDigest(job);
  job.standingDecision = {
    grantId: binding.grantId,
    grantRevision: binding.grantRevision,
    manifestSha256: binding.manifestSha256,
    planSha256: requestPlanSha256,
    targetIdentitySha256: binding.nativeIdentitySha256,
    authoritySha256: sha,
    policyActivatedAt: now,
    requestRevision: revision,
  };
  binding.requestPlanSha256 = requestPlanSha256;
  binding.decisionSha256 = createHash("sha256")
    .update(JSON.stringify(job.standingDecision))
    .digest("hex");
  const f = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    (config) => {
      writeFileSync(path.join(config.stateDir, "restart-jobs.json"), JSON.stringify([job]), {
        mode: 0o600,
      });
    },
  );
  const legacy = await (
    await f.request("/api/installation/restart-requests/" + id, "host-agent-test-token")
  ).json();
  expect(legacy).not.toHaveProperty("supervisorEffect");
  expect(RestartJobSchema.omit({ supervisorEffect: true }).parse(legacy).id).toBe(id);
  const owner = await (
    await f.request(
      "/api/installation/owner/restarts/query?supervisorMaintenance=1",
      "owner-test-password",
      {},
    )
  ).json();
  expect(owner[0]).not.toHaveProperty("supervisorEffect");
  expect(
    JSON.parse(readFileSync(path.join(f.root, "restart-jobs.json"), "utf8"))[0].supervisorEffect,
  ).toEqual(job.supervisorEffect);
  expect(f.calls).toEqual([]);
});

test("recovery bookmark discovery is owner-only, read-only and installation-bound", async () => {
  let installationId = "";
  let calls = 0;
  let foreign = false;
  const f = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    {
      observeRecoveryAccess: async () => {
        calls++;
        return {
          installationId: foreign ? randomUUID() : installationId,
          url: "https://machine.tail123.ts.net:8443",
          observedAt: new Date().toISOString(),
        };
      },
    },
    (config) => {
      installationId = config.public.installationId;
    },
  );
  const route = "/api/installation/owner/recovery-access/query";
  for (const credential of [undefined, "host-agent-test-token", "guest-agent-test-token"])
    expect((await f.request(route, credential, {})).status).toBe(401);
  expect(
    (await f.request(route, "owner-test-password", {}, "https://foreign.example.test")).status,
  ).toBe(403);
  expect(calls).toBe(0);
  const response = await f.request(route, "owner-test-password", {});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    installationId,
    status: "verified",
    url: "https://machine.tail123.ts.net:8443",
  });
  foreign = true;
  expect(await (await f.request(route, "owner-test-password", {})).json()).toMatchObject({
    status: "unverified",
    url: null,
  });
  expect(f.calls).toEqual([]);
  expect(existsSync(path.join(f.root, "maintenance-enrollment.json"))).toBe(false);
});

test("recovery bookmark discovery does not invent an address without native support", async () => {
  const f = await fixture();
  const response = await f.request(
    "/api/installation/owner/recovery-access/query",
    "owner-test-password",
    {},
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "unverified", url: null });
  expect(f.calls).toEqual([]);
});

test("service maintenance status and cancellation require owner access", async () => {
  const f = await fixture();
  const query = "/api/installation/owner/maintenance-services/query";
  const cancel = "/api/installation/owner/maintenance-services/cancel";
  const agentRequests = "/api/installation/service-maintenance-requests";
  expect((await f.request(agentRequests, undefined, {})).status).toBe(401);
  expect((await f.request(agentRequests, "guest-agent-test-token", {})).status).toBe(403);
  expect((await f.request(agentRequests, "host-agent-test-token", {})).status).toBe(503);
  const capabilities = await (
    await f.request("/api/installation/capabilities", "host-agent-test-token")
  ).json();
  expect(capabilities.maintenanceServices).toEqual({ available: false, operations: [] });
  for (const credential of [undefined, "host-agent-test-token", "guest-agent-test-token"]) {
    expect((await f.request(query, credential, {})).status).toBe(401);
    expect((await f.request(cancel, credential, {})).status).toBe(401);
  }
  const response = await f.request(query, "owner-test-password", {});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ available: false, jobs: [] });
  const missing = await f.request(cancel, "owner-test-password", {
    id: randomUUID(),
    revision: randomUUID(),
  });
  expect(missing.status).toBe(409);
  const job = MaintenanceServiceJobSchema.parse({
    id: randomUUID(),
    revision: randomUUID(),
    target: "maintenance-controller",
    operation: "replacement",
    proposal: {
      id: randomUUID(),
      installationId: randomUUID(),
      requestedBy: "host-agent",
      target: "maintenance-controller",
      operation: "replacement",
      identitySha256: "a".repeat(64),
      planSha256: "b".repeat(64),
      repository: "https://example.test/private-repository",
      sourceCommit: "c".repeat(40),
      artifactSha256: "d".repeat(64),
      previous: null,
    },
    reason: "Private operator reason",
    createdAt: new Date().toISOString(),
    status: "pending",
    detail: "Awaiting native inspection",
    evidence: [],
  });
  job.proposal.id = job.id;
  new FileBootstrapRequestJournal(f.root).writeLifecycle([job]);
  const publicResponse = await f.request("/api/installation/restart-summary");
  const summary = await publicResponse.json();
  expect(summary).toMatchObject({
    serviceMaintenance: { requested: 1, queued: 0, unverified: 0, attention: 0 },
  });
  expect(JSON.stringify(summary)).not.toContain("Private operator reason");
  const listing = await (await f.request(query, "owner-test-password", {})).json();
  expect(listing.jobs[0]).toMatchObject({ id: job.id, revision: job.revision, cancelable: true });
  expect(listing.jobs[0]).not.toHaveProperty("proposal");
  expect(listing.jobs[0]).not.toHaveProperty("evidence");
  const agentView = await (
    await f.request(`${agentRequests}/${job.id}`, "host-agent-test-token")
  ).json();
  expect(agentView).toEqual(listing.jobs[0]);
  expect((await f.request(`${agentRequests}/${job.id}`, "guest-agent-test-token")).status).toBe(
    403,
  );
  const cancelled = await f.request(cancel, "owner-test-password", {
    id: job.id,
    revision: job.revision,
  });
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({
    id: job.id,
    status: "rejected",
    cancelable: false,
  });
  expect(
    (await f.request(cancel, "owner-test-password", { id: job.id, revision: job.revision })).status,
  ).toBe(409);
  expect(f.calls).toEqual([]);
});

test("enrollment status is owner-only and reading it cannot approve or dispatch maintenance", async () => {
  const f = await fixture();
  const route = "/api/installation/owner/enrollment/query";
  for (const credential of [undefined, "host-agent-test-token", "guest-agent-test-token"])
    expect((await f.request(route, credential, {})).status).toBe(401);
  const response = await f.request(route, "owner-test-password", {});
  expect(response.status).toBe(200);
  const status = InstallationEnrollmentStatusSchema.parse(await response.json());
  expect(status).toMatchObject({
    authority: "not-enrolled",
    activation: "not-enrolled",
    services: [],
    steps: [],
  });
  expect(f.calls).toEqual([]);
  expect(existsSync(path.join(f.root, "maintenance-enrollment.json"))).toBe(false);
});

test("only the owner can prepare a pinned plugin source and preparation does not save settings", async () => {
  const host = new SettingsEnvironmentFake("host-id");
  const guest = new SettingsEnvironmentFake("guest-id");
  const journal = new SettingsJournalFake();
  const settings = new InstallationSettingsService(journal, [host, guest]);
  await settings.reconcile();
  const saved = settings.snapshot();
  const resolved = {
    kind: "git" as const,
    id: "review",
    identity: { kind: "git" as const, remote: "https://example.test/plugin.git", pluginPath: "." },
    target: { kind: "git" as const, commit: "a".repeat(40) },
  };
  const resolveSource = vi.fn(async () => resolved);
  const { request } = await fixture(undefined, settings, resolveSource);
  const route = "/api/installation/owner/settings/plugins/resolve";
  const input = { source: "owner/plugin", ref: "stable" };
  expect((await request(route, "guest-agent-test-token", input)).status).toBe(401);
  expect((await request(route, "host-agent-test-token", input)).status).toBe(401);
  const unlock = await request("/api/installation/owner/unlock", "owner-test-password", {});
  const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing owner cookie");
  expect(
    (await request(route, undefined, input, "https://foreign.example.test", cookie)).status,
  ).toBe(403);
  expect(resolveSource).not.toHaveBeenCalled();
  const prepared = await request(route, undefined, input, undefined, cookie);
  expect(prepared.status).toBe(200);
  expect(await prepared.json()).toEqual(resolved);
  expect(resolveSource).toHaveBeenCalledWith(input);
  expect(settings.snapshot()).toEqual(saved);
  expect(host.plugins).toEqual([]);
  expect(guest.plugins).toEqual([]);
});

test("personal skill preparation requires owner access and leaves the shared catalog unchanged", async () => {
  const settings = new InstallationSettingsService(new SettingsJournalFake(), [
    new SettingsEnvironmentFake("host-id"),
    new SettingsEnvironmentFake("guest-id"),
  ]);
  await settings.reconcile();
  const original = settings.snapshot();
  const source = {
    repository: "owner/repo",
    revision: "a".repeat(40),
    directory: "skills/example",
  };
  const definition = {
    name: "example",
    source,
    sha256: "b".repeat(64),
    identity: "github:owner/repo/skills/example",
  };
  const prepared = {
    definition,
    package: {
      name: definition.name,
      source,
      sha256: definition.sha256,
      files: [{ path: "SKILL.md", content: "cmV2aWV3", executable: false }],
    },
  };
  const prepare = vi
    .spyOn(InstallationSkillPackages.prototype, "prepare")
    .mockResolvedValue(prepared);
  const read = vi
    .spyOn(InstallationSkillPackages.prototype, "read")
    .mockReturnValue(prepared.package);
  try {
    const { request } = await fixture(undefined, settings);
    const route = "/api/installation/owner/settings/skills/prepare";
    for (const token of [undefined, "guest-agent-test-token", "host-agent-test-token"])
      expect((await request(route, token, { source })).status).toBe(401);
    const unlock = await request("/api/installation/owner/unlock", "owner-test-password", {});
    const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Missing owner cookie");
    expect(
      (await request(route, undefined, { source }, "https://foreign.example.test", cookie)).status,
    ).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
    expect(
      (
        await request(
          route,
          undefined,
          { source: { ...source, revision: "main" } },
          undefined,
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
    const response = await request(route, undefined, { source }, undefined, cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(prepared);
    expect(prepare).toHaveBeenCalledWith(source);
    const packageRoute = "/api/installation/owner/settings/skills/package";
    expect((await request(packageRoute, "guest-agent-test-token", { definition })).status).toBe(
      401,
    );
    expect(
      (
        await request(
          packageRoute,
          undefined,
          { definition },
          "https://foreign.example.test",
          cookie,
        )
      ).status,
    ).toBe(403);
    expect(read).not.toHaveBeenCalled();
    const content = await request(packageRoute, undefined, { definition }, undefined, cookie);
    expect(content.status).toBe(200);
    expect(await content.json()).toEqual({ package: prepared.package });
    expect(read).toHaveBeenCalledWith(definition);
    expect(settings.snapshot()).toEqual(original);
  } finally {
    read.mockRestore();
    prepare.mockRestore();
  }
});

test("agents propose shared instructions that apply only after owner approval", async () => {
  const host = new SettingsEnvironmentFake("host-id");
  const guest = new SettingsEnvironmentFake("guest-id");
  const settings = new InstallationSettingsService(new SettingsJournalFake(), [host, guest]);
  await settings.reconcile();
  const { request } = await fixture(undefined, settings);
  const before = settings.snapshot();
  const proposal = {
    appendSystemPrompt: "Use HTTPS preview links, never raw addresses.",
    baseRevision: before.revision,
    reason: "Preview links",
    requester: "Dev sync thread",
  };
  const submitRoute = "/api/installation/instruction-requests";
  expect((await request(submitRoute, undefined, proposal)).status).toBe(401);
  expect((await request(submitRoute, "owner-test-password", proposal)).status).toBe(401);
  const submitted = await request(submitRoute, "guest-agent-test-token", proposal);
  expect(submitted.status).toBe(201);
  const created = await submitted.json();
  expect(created).toMatchObject({ status: "pending", environment: "container" });
  expect(settings.snapshot()).toEqual(before);
  expect((await request(`${submitRoute}/${created.id}`, "host-agent-test-token")).status).toBe(404);
  expect((await request(`${submitRoute}/${created.id}`, "guest-agent-test-token")).status).toBe(
    200,
  );
  const queryRoute = "/api/installation/owner/instruction-requests/query";
  const decisionRoute = "/api/installation/owner/instruction-requests/decision";
  const decision = { id: created.id, decision: "approve", proposedSha256: created.proposedSha256 };
  // Agent request keys never approve, even their own request.
  expect((await request(queryRoute, "guest-agent-test-token", {})).status).toBe(401);
  expect((await request(decisionRoute, "guest-agent-test-token", decision)).status).toBe(401);
  expect((await request(decisionRoute, "host-agent-test-token", decision)).status).toBe(401);
  const unlock = await request("/api/installation/owner/unlock", "owner-test-password", {});
  const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing owner cookie");
  expect(
    (await request(decisionRoute, undefined, decision, "https://foreign.example.test", cookie))
      .status,
  ).toBe(403);
  const query = await (await request(queryRoute, undefined, {}, undefined, cookie)).json();
  expect(query.requests.map((item: { id: string }) => item.id)).toEqual([created.id]);
  const applied = await request(decisionRoute, undefined, decision, undefined, cookie);
  expect(applied.status).toBe(200);
  expect(await applied.json()).toMatchObject({
    status: "applied",
    appliedRevision: before.revision + 1,
  });
  expect(settings.snapshot().settings?.appendSystemPrompt).toBe(proposal.appendSystemPrompt);
  expect((await request(decisionRoute, undefined, decision, undefined, cookie)).status).toBe(409);
});

test("shared settings require owner access and persist revisioned writes before offline delivery", async () => {
  const host = new SettingsEnvironmentFake("host-id");
  const guest = new SettingsEnvironmentFake("guest-id");
  const journal = new SettingsJournalFake();
  const settings = new InstallationSettingsService(journal, [host, guest]);
  await settings.reconcile();
  const { request, url } = await fixture(undefined, settings);
  const readRoute = "/api/installation/owner/settings/read";
  const skillPreviewRoute = "/api/installation/owner/settings/skills/preview";
  const selection = { mode: "custom", skills: ["alpha"] };
  expect((await request(skillPreviewRoute, "guest-agent-test-token", { selection })).status).toBe(
    401,
  );
  expect((await request(readRoute, "guest-agent-test-token", {})).status).toBe(401);
  const unlock = await request("/api/installation/owner/unlock", "owner-test-password", {});
  const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing owner cookie");
  host.skillOps = [{ kind: "delete", name: "beta" }];
  const preview = await request(skillPreviewRoute, undefined, { selection }, undefined, cookie);
  expect(preview.status).toBe(200);
  expect((await preview.json()).sources["host-id"].confirmationRequired).toEqual({
    removals: ["beta"],
  });
  expect(host.patches).toEqual([]);
  host.skillOps = [];
  expect(
    (await request(readRoute, undefined, {}, "https://foreign.example.test", cookie)).status,
  ).toBe(403);
  const snapshot = InstallationSettingsSnapshotSchema.parse(
    await (await request(readRoute, undefined, {}, undefined, cookie)).json(),
  );
  expect(
    (await request("/api/installation/settings/admission", "owner-test-password")).status,
  ).toBe(401);
  const hostAdmission = await (
    await request("/api/installation/settings/admission", "host-agent-test-token")
  ).json();
  expect(hostAdmission).toMatchObject({
    serverId: "host-id",
    environment: "host",
    revision: snapshot.revision,
    settings: snapshot.settings,
  });
  expect(hostAdmission.installationInstructions).toContain("installation-maintenance/SKILL.md");
  const guestAdmission = await (
    await request("/api/installation/settings/admission", "guest-agent-test-token")
  ).json();
  expect(guestAdmission).toMatchObject({
    serverId: "guest-id",
    environment: "container",
    installationInstructions: "",
    settings: snapshot.settings,
  });
  const clientDirectory = mkdtempSync(path.join(tmpdir(), "settings-admission-client-"));
  cleanups.push(async () => rmSync(clientDirectory, { recursive: true, force: true }));
  const clientFile = path.join(clientDirectory, "client.json");
  writeFileSync(
    clientFile,
    JSON.stringify({ origin: url, token: "host-agent-test-token", kind: "host-agent" }),
  );
  expect(
    await createInstallationSettingsReader(clientFile).read({ ...hostAdmission, revision: 1 }),
  ).toEqual(hostAdmission);
  guest.offline = true;
  const update = {
    expectedRevision: snapshot.revision,
    settings: { appendSystemPrompt: "Shared owner instructions" },
  };
  const patch = () =>
    requestWithHost(`${url}/api/installation/owner/settings`, {
      method: "PATCH",
      headers: {
        Host: "owner.example.test",
        Origin: "https://owner.example.test",
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(update),
    });
  const response = await patch();
  expect(response.status).toBe(200);
  const saved = InstallationSettingsSnapshotSchema.parse(await response.json());
  expect(journal.state).toEqual(saved);
  expect(saved.settings?.appendSystemPrompt).toBe(update.settings.appendSystemPrompt);
  expect(saved.sources["guest-id"].pendingRevision).toBe(saved.revision);
  expect((await patch()).status).toBe(409);
  await settings.reconcile();
  expect(host.config.appendSystemPrompt).toBe(update.settings.appendSystemPrompt);
  expect(settings.snapshot().sources["guest-id"].error).toBe("read_failed");
  guest.offline = false;
  await settings.reconcile();
  expect(guest.config.appendSystemPrompt).toBe(update.settings.appendSystemPrompt);
});

test("project policies reach only owner clients and daemons that ask for them", async () => {
  const host = new SettingsEnvironmentFake("host-id");
  const guest = new SettingsEnvironmentFake("guest-id");
  const settings = new InstallationSettingsService(new SettingsJournalFake(), [host, guest]);
  const initial = await settings.reconcile();
  const policies = { "/Users/me/dev/app": { excludedEnvironments: ["container" as const] } };
  await settings.update({
    expectedRevision: initial.revision,
    settings: { projectPolicies: policies },
  });
  const { request, url } = await fixture(undefined, settings);
  const unlock = await request("/api/installation/owner/unlock", "owner-test-password", {});
  const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing owner cookie");
  async function readOwnerSettings(headers: Record<string, string>) {
    const response = await requestWithHost(`${url}/api/installation/owner/settings/read`, {
      method: "POST",
      headers: {
        Host: "owner.example.test",
        Origin: "https://owner.example.test",
        Cookie: cookie!,
        "Content-Type": "application/json",
        ...headers,
      },
      body: "{}",
    });
    return (await response.json()).settings;
  }
  expect(await readOwnerSettings({})).not.toHaveProperty("projectPolicies");
  expect((await readOwnerSettings({ "X-Vorteo-Project-Policies": "1" })).projectPolicies).toEqual(
    policies,
  );
  async function readAdmission(route: string) {
    const response = await fetch(`${url}${route}`, {
      headers: { Authorization: "Bearer guest-agent-test-token" },
    });
    return (await response.json()).settings;
  }
  expect(await readAdmission("/api/installation/settings/admission")).not.toHaveProperty(
    "projectPolicies",
  );
  expect(
    (await readAdmission("/api/installation/settings/admission?projectPolicies=1")).projectPolicies,
  ).toEqual(policies);
});

test("delegated creation resolves a paginated workspace to its working directory", async () => {
  // Isolate directory lookup from provider execution, which requires account credentials.
  const createAgent = vi.fn(async (options: Parameters<DelegationClient["createAgent"]>[0]) => {
    if (!options.cwd) throw new Error("createAgent requires provider and cwd");
    return { id: "worker-id" };
  });
  const fetchWorkspaces = vi
    .fn()
    .mockResolvedValueOnce({ entries: [], pageInfo: { hasMore: true, nextCursor: "next" } })
    .mockResolvedValueOnce({
      entries: [
        { id: "workspace-id", workspaceDirectory: "/worktrees/worker", projectRootPath: "/repo" },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
  const client = { fetchWorkspaces, createAgent } as unknown as DelegationClient;
  const request = {
    operation: "create" as const,
    idempotencyKey: randomUUID(),
    provider: "codex",
    workspaceId: "workspace-id",
    title: "Worker",
    initialPrompt: "Inspect the workspace",
  };
  expect(await delegateToContainer(client, request)).toEqual({ id: "worker-id" });
  expect(fetchWorkspaces.mock.calls).toEqual([
    [{ page: { limit: 200, cursor: undefined } }],
    [{ page: { limit: 200, cursor: "next" } }],
  ]);
  expect(createAgent).toHaveBeenCalledWith({
    provider: request.provider,
    cwd: "/worktrees/worker",
    workspaceId: request.workspaceId,
    title: request.title,
    initialPrompt: request.initialPrompt,
    origin: "agent",
    idempotencyKey: request.idempotencyKey,
    model: undefined,
  });
});

test("delegated creation rejects an unknown workspace before starting a worker", async () => {
  const createAgent = vi.fn();
  const client = {
    fetchWorkspaces: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
    createAgent,
  } as unknown as DelegationClient;
  await expect(
    delegateToContainer(client, {
      operation: "create",
      idempotencyKey: randomUUID(),
      provider: "codex",
      workspaceId: "missing",
      title: "Worker",
      initialPrompt: "Inspect the workspace",
    }),
  ).rejects.toThrow("Container workspace was not found");
  expect(createAgent).not.toHaveBeenCalled();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("delegated requests are labeled only for clients that ask and only for Host-agent requests", async () => {
  const { request } = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    (config) =>
      writeFileSync(
        path.join(config.stateDir, "owner-delegation.json"),
        JSON.stringify({
          version: 1,
          delegatedRequesterPrefixes: ["Nova "],
          hostUpdateServiceRestart: false,
        }),
      ),
  );
  const ask = async (token: string, target: string) =>
    RestartJobSchema.parse(
      await (
        await request("/api/installation/restart-requests", token, {
          target,
          reason: "Routine maintenance",
          requester: "Nova integration",
        })
      ).json(),
    );
  const host = await ask("host-agent-test-token", "host");
  const guest = await ask("guest-agent-test-token", "container-daemon");
  const query = async (flags: string) =>
    RestartJobSchema.array().parse(
      await (
        await request(`/api/installation/owner/restarts/query${flags}`, "owner-test-password", {})
      ).json(),
    );
  const modern = await query("?idleRestarts=1&delegatedRequests=1");
  expect(modern.find((job) => job.id === host.id)?.delegatedTo).toBe("Nova integration");
  // A guest can choose any requester label, so its request still needs the owner.
  expect(modern.find((job) => job.id === guest.id)?.delegatedTo).toBeUndefined();
  for (const job of await query("?idleRestarts=1")) expect(job).not.toHaveProperty("delegatedTo");
  // The locked summary prompts only for the guest request.
  expect(await (await request("/api/installation/restart-summary")).json()).toMatchObject({
    requested: 1,
    queued: 1,
  });
  const cancelled = await request(
    `/api/installation/owner/restarts/${host.id}/decision?delegatedRequests=1`,
    "owner-test-password",
    { revision: host.revision, decision: "reject" },
  );
  // The owner keeps every decision; a finished request is no longer being handled.
  expect(RestartJobSchema.parse(await cancelled.json())).toMatchObject({ status: "rejected" });
  expect(
    (await query("?delegatedRequests=1")).find((job) => job.id === host.id),
  ).not.toHaveProperty("delegatedTo");
});

// Node fetch does not preserve a supplied Host on every supported runtime.
// These origin tests need the actual authority on the wire, not a URL substitution.
function requestWithHost(
  url: string,
  input: { method: string; headers: Record<string, string>; body?: string; redirect?: "manual" },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      { method: input.method, headers: input.headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("error", reject);
        incoming.on("end", () => {
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
          }
          const status = incoming.statusCode ?? 500;
          const body = [204, 304].includes(status) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers }));
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(input.body);
  });
}

async function fixture(
  profiles?: InstallationProfiles,
  settings?: InstallationSettingsService,
  resolvePluginSource?: InstallationPluginSourceResolver,
  sourceUpdates: boolean | "both" = false,
  automaticHost = false,
  claudeSetup?: ClaudeSetupRuntime,
  startupFence?: InstallationStartupFence,
  helperExecutor?: Pick<
    RestartExecutor,
    | "validateHelperPlan"
    | "installHelper"
    | "verifyHelperRecovery"
    | "discoverMaintenanceServices"
    | "observeRecoveryAccess"
    | "reconcileInitialHostActivation"
  >,
  initialize?: (config: InstallationConfig) => void,
  coordinatorRequests?: BootstrapReconciliationLedger,
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vorteo-installation-test-")));
  writeFileSync(
    path.join(root, "index.html"),
    "<html><head></head><body>trusted application</body></html>",
  );
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const config: InstallationConfig = {
    public: {
      version: 1,
      installationId: randomUUID(),
      origin: "https://owner.example.test",
      environments: [
        { kind: "host", serverId: "host-id", endpoint: "host.example.test", useTls: true },
        { kind: "container", serverId: "guest-id", endpoint: "guest.example.test", useTls: true },
      ],
    },
    listenPort: 6770,
    redirectOrigins: ["https://previous.example.test"],
    webDistDir: root,
    stateDir: root,
    ownerPasswordHash: hashDaemonPassword("owner-test-password"),
    hostAgentTokenHash: hash("host-agent-test-token"),
    containerAgentTokenHash: hash("guest-agent-test-token"),
    host: {
      endpoint: "127.0.0.1:6771",
      password: "host-daemon-test-password",
      launchdService: "gui/501/local.vorteo.test.host",
    },
    container: { endpoint: "127.0.0.1:6768", password: "guest-daemon-test-password" },
  };
  if (automaticHost)
    config.restartApprovalPolicy = { hostRequestsAfter: new Date(0).toISOString() };
  if (sourceUpdates) {
    const release = path.join(root, "release");
    mkdirSync(release);
    writeFileSync(
      path.join(release, ".installation-source.json"),
      JSON.stringify({ sourceCommit: "b".repeat(40) }),
    );
    writeFileSync(
      path.join(root, "release.json"),
      JSON.stringify({ sourceCommit: "b".repeat(40) }),
    );
    const link = path.join(root, "current");
    symlinkSync(release, link);
    config.sourceUpdates = {
      sourceRepository: root,
      releaseRoot: root,
      currentReleaseLink: link,
      webDirectory: root,
      toolingDirectory: root,
      integrationRef: "refs/heads/main",
    };
  }
  if (sourceUpdates === "both") {
    const docker = path.join(root, "docker-fixture");
    writeFileSync(
      docker,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({release:"/dev/releases/base",sourceCommit:"${"c".repeat(40)}"}));`,
    );
    chmodSync(docker, 0o700);
    const receiptFile = path.join(root, "dev-source.json");
    writeFileSync(receiptFile, JSON.stringify({ sourceCommit: "c".repeat(40) }));
    config.containerSourceUpdates = {
      docker,
      receiptFile,
      sourceRepository: root,
      toolingDirectory: path.resolve(import.meta.dirname, "../../../../../scripts"),
      integrationRef: "refs/heads/main",
      containerId: "d".repeat(64),
      user: "paseo",
      node: process.execPath,
      home: "/dev/home",
      releaseRoot: "/dev/releases",
      currentReleaseLink: "/dev/releases/current",
    };
  }
  initialize?.(config);
  const calls: string[] = [];
  const app = createInstallationServer(
    config,
    {
      ...(automaticHost
        ? {
            inspect: async (target: RestartImpact["target"]): Promise<RestartImpact> => ({
              target,
              agents: [],
              pendingStarts: 1,
              checkedAt: new Date().toISOString(),
              idleRestartSupported: true,
            }),
            holdCurrentTurns: async () => {
              calls.push("hold");
            },
            releaseCurrentTurns: async () => {
              calls.push("release");
            },
            restartWhenIdle: async () => null,
          }
        : {}),
      ...helperExecutor,
      factoryRuntimePlan: () => "c".repeat(64),
      adoptFactoryRuntime: async () => {
        calls.push("factory-adoption");
        return "verified Factory adoption";
      },
      supervisorPlan: () => "a".repeat(64),
      restartSupervisor: async () => {
        calls.push("supervisor");
        return "verified supervisor";
      },
      restart: async (target) => {
        calls.push(target);
        return "verified ready";
      },
    },
    pino({ level: "silent" }),
    profiles,
    settings,
    resolvePluginSource,
    claudeSetup,
    startupFence,
    coordinatorRequests,
  );
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  config.listenPort = address.port;
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    rmSync(root, { recursive: true, force: true });
  });
  async function request(
    route: string,
    token?: string,
    body?: unknown,
    origin = config.public.origin,
    cookie?: string,
  ) {
    return requestWithHost(`http://127.0.0.1:${address.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Host: "owner.example.test",
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
    });
  }
  return {
    request,
    root,
    calls,
    drain: app.drainRestarts,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function canonicalProfiles() {
  let state: ProfileSharingState | null = null;
  const kinds: ExecutionEnvironmentKind[] = ["host", "container"];
  const environments = kinds.map((kind) => {
    let config = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      sharedProviderPreferences: {
        version: 1,
        revision: 1,
        legacyProfiles: {},
        providers: {
          codex: {
            defaults: {},
            preferredModels: [],
            preferredThinkingOptions: [],
            workflows: [{ id: "review", name: "Review", provider: "codex", model: "astra" }],
            defaultWorkflowId: "review",
          },
        },
      },
    });
    return {
      kind,
      serverId: kind === "host" ? "host-id" : "guest-id",
      async read() {
        return structuredClone(config);
      },
      async patch(patch: import("@getpaseo/protocol/messages").MutableDaemonConfigPatch) {
        if (
          !patch.sharedProviderPreferences ||
          patch.expectedProviderPreferencesRevision !== config.sharedProviderPreferences?.revision
        )
          throw new Error("revision mismatch");
        config = {
          ...config,
          sharedProviderPreferences: {
            ...patch.sharedProviderPreferences,
            revision: patch.sharedProviderPreferences.revision + 1,
          },
        };
        return structuredClone(config);
      },
    };
  });
  const profiles = new InstallationProfiles(
    {
      read: () => structuredClone(state),
      write: (next) => {
        state = structuredClone(next);
      },
      backup: () => {},
    },
    environments,
    "00000000-0000-4000-8000-000000000001",
  );
  await profiles.synchronize();
  return profiles;
}

test("owner canonical profile GET/PATCH use independent revisions and reject stale or guest writes", async () => {
  const profiles = await canonicalProfiles();
  const { request, url } = await fixture(profiles);
  const route = "/api/installation/owner/profiles";
  expect((await request(route, "guest-agent-test-token")).status).toBe(401);
  expect(
    (await request(route, "owner-test-password", undefined, "https://foreign.example.test")).status,
  ).toBe(403);
  const unlock = await request("/api/installation/owner/unlock", "owner-test-password", {});
  const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("missing owner cookie");
  const noOrigin = await requestWithHost(`${url}${route}`, {
    method: "GET",
    headers: { Host: "owner.example.test", Cookie: cookie },
  });
  expect(noOrigin.status).toBe(403);
  const get = await request(`${route}/read`, undefined, {}, undefined, cookie);
  expect(get.status).toBe(200);
  expect(get.headers.get("cache-control")).toBe("no-store");
  const snapshot = InstallationProfilesSnapshotSchema.parse(await get.json());
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows[0].excludedEnvironments = ["host"];
  async function patch(expectedRevision: number) {
    return requestWithHost(`${url}${route}`, {
      method: "PATCH",
      headers: {
        Host: "owner.example.test",
        Origin: "https://owner.example.test",
        Cookie: cookie ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedRevision, providers }),
    });
  }
  const saved = await patch(snapshot.revision);
  expect(saved.status).toBe(200);
  expect(InstallationProfilesSnapshotSchema.parse(await saved.json()).revision).toBe(
    snapshot.revision + 1,
  );
  expect((await patch(snapshot.revision)).status).toBe(409);
  const final = InstallationProfilesSnapshotSchema.parse(
    await (await request(route, undefined, undefined, undefined, cookie)).json(),
  );
  expect(final.providers).toEqual(providers);
});

test("fixed admission transport pins installation and environment and rejects stale responses", async () => {
  const profiles = await canonicalProfiles();
  const { request, root, url } = await fixture(profiles);
  const configFile = path.join(root, "admission-client.json");
  writeFileSync(
    configFile,
    JSON.stringify({ origin: url, token: "host-agent-test-token", kind: "host-agent" }),
    { mode: 0o600 },
  );
  const reader = createInstallationProfileReader(configFile);
  const admission = await (
    await request("/api/installation/profiles/admission", "host-agent-test-token")
  ).json();
  const binding = {
    installationId: admission.installationId,
    serverId: "host-id",
    environment: "host" as const,
    revision: 1,
  };
  expect((await reader.read(binding)).providers).toEqual(profiles.snapshot()?.providers);
  await expect(reader.read({ ...binding, serverId: "guest-id" })).rejects.toThrow(
    "different installation or environment",
  );
  await expect(reader.read({ ...binding, environment: "container" })).rejects.toThrow(
    "does not match the daemon launcher",
  );
  await expect(reader.read({ ...binding, revision: 100 })).rejects.toThrow("stale revision");
  expect(
    (await request("/api/installation/profiles/admission", "owner-test-password")).status,
  ).toBe(401);
});

test("previous origins redirect navigation without accepting API credentials", async () => {
  const { url } = await fixture();
  function previousRequest(route: string, method = "GET", host = "previous.example.test") {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(
        `${url}${route}`,
        {
          method,
          headers: {
            Host: host,
            Origin: "https://previous.example.test",
            Authorization: "Bearer owner-test-password",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response));
        },
      );
      request.on("error", reject);
      request.end();
    });
  }
  const response = await previousRequest("/workspaces/existing?thread=kept");
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe(
    "https://owner.example.test/workspaces/existing?thread=kept",
  );
  expect(response.headers["cache-control"]).toBe("no-store");
  expect((await previousRequest("/api/installation/owner/unlock", "POST")).statusCode).toBe(403);
  expect((await previousRequest("/api/installation/health")).statusCode).toBe(403);
  expect((await previousRequest("/", "GET", "unknown.example.test")).statusCode).toBe(403);
});

test("public HTML has environment identities but no credentials", async () => {
  const { request } = await fixture();
  const response = await request("/");
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("__VORTEO_EXECUTION_INSTALLATION__");
  for (const secret of [
    "owner-test-password",
    "host-daemon-test-password",
    "guest-daemon-test-password",
    "host-agent-test-token",
  ])
    expect(html).not.toContain(secret);
});

test("guest credentials can request a restart but cannot unlock, approve, or address outside agents", async () => {
  const { request, calls } = await fixture();
  const token = "guest-agent-test-token";
  const job = RestartJobSchema.parse(
    await (
      await request("/api/installation/restart-requests", token, {
        target: "host",
        reason: "Prepared update",
      })
    ).json(),
  );
  expect(calls).toEqual([]);
  expect((await request("/api/installation/owner/unlock", token, {})).status).toBe(401);
  expect(
    (
      await request(`/api/installation/owner/restarts/${job.id}/decision`, token, {
        revision: job.revision,
        decision: "approve",
      })
    ).status,
  ).toBe(401);
  expect(
    (await request("/api/installation/container-agents", token, { operation: "list" })).status,
  ).toBe(403);
  expect(
    (await request("/api/installation/owner/unlock", "guest-daemon-test-password", {})).status,
  ).toBe(401);
  expect(
    (
      await request(
        "/api/installation/owner/unlock",
        "owner-test-password",
        {},
        "https://guest.example.test",
      )
    ).status,
  ).toBe(403);
  expect(calls).toEqual([]);
});

test("both request credentials join and observe the same target receipt without approving it", async () => {
  const { request, calls } = await fixture();
  const first = RestartJobSchema.parse(
    await (
      await request("/api/installation/restart-requests", "host-agent-test-token", {
        target: "host",
        reason: "Prepared first update",
      })
    ).json(),
  );
  const joined = RestartJobSchema.parse(
    await (
      await request("/api/installation/restart-requests", "guest-agent-test-token", {
        target: "host",
        reason: "Prepared complementary update",
      })
    ).json(),
  );
  expect(joined).toEqual(first);
  for (const token of ["host-agent-test-token", "guest-agent-test-token"]) {
    const response = await request(`/api/installation/restart-requests/${first.id}`, token);
    expect(response.status).toBe(200);
    expect(RestartJobSchema.parse(await response.json()).status).toBe("pending");
    expect(
      (
        await request(`/api/installation/owner/restarts/${first.id}/decision`, token, {
          revision: first.revision,
          decision: "approve",
        })
      ).status,
    ).toBe(401);
  }
  expect(
    (await request(`/api/installation/restart-requests/${first.id}`, "invalid-token")).status,
  ).toBe(401);
  expect(calls).toEqual([]);
});

test("owner unlocks both separate connections and approves one immutable restart with a durable outcome", async () => {
  const { request, root, calls } = await fixture();
  const owner = "owner-test-password";
  const unlocked = InstallationUnlockSchema.parse(
    await (await request("/api/installation/owner/unlock", owner, {})).json(),
  );
  expect(unlocked.connections.map((entry) => entry.password)).toEqual([
    "host-daemon-test-password",
    "guest-daemon-test-password",
  ]);
  const job = RestartJobSchema.parse(
    await (
      await request("/api/installation/restart-requests", "guest-agent-test-token", {
        target: "container-daemon",
        reason: "Prepared update",
      })
    ).json(),
  );
  const approval = await request(`/api/installation/owner/restarts/${job.id}/decision`, owner, {
    revision: job.revision,
    decision: "approve",
  });
  expect(approval.status).toBe(200);
  expect(calls).toEqual(["container-daemon"]);
  expect(JSON.parse(readFileSync(path.join(root, "restart-jobs.json"), "utf8"))[0].status).toBe(
    "succeeded",
  );
  expect(
    (
      await request(`/api/installation/owner/restarts/${job.id}/decision`, owner, {
        revision: job.revision,
        decision: "approve",
      })
    ).status,
  ).toBe(409);
  expect(calls).toHaveLength(1);
});

test("shared profile inspection and conflict resolution reject guest credentials and foreign origins", async () => {
  const { request } = await fixture();
  expect(
    (await request("/api/installation/owner/profiles/query", "guest-agent-test-token", {})).status,
  ).toBe(401);
  expect(
    (
      await request(
        "/api/installation/owner/profiles/query",
        "owner-test-password",
        {},
        "https://foreign.example.test",
      )
    ).status,
  ).toBe(403);
  expect(
    (await request("/api/installation/owner/profiles/resolve", "guest-daemon-test-password", {}))
      .status,
  ).toBe(401);
  const response = await request(
    "/api/installation/owner/profiles/query",
    "owner-test-password",
    {},
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toBeNull();
});

test("owner cookie restores access without a password and lock revokes it", async () => {
  const { request, calls } = await fixture();
  const route = "/api/installation/owner/";
  const origin = "https://owner.example.test";
  expect(await (await request(`${route}session`, undefined, {})).json()).toEqual({
    authenticated: false,
    expiresAt: null,
  });
  const login = await request(`${route}unlock`, "owner-test-password", {});
  expect(login.status).toBe(200);
  const setCookie = login.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  const cookie = setCookie.split(";")[0];
  expect((await request(`${route}connections`, undefined, {}, origin, cookie)).status).toBe(200);
  expect(
    (await request(`${route}restarts/query`, undefined, {}, "https://attacker.test", cookie))
      .status,
  ).toBe(403);
  expect((await request(`${route}connections`, "guest-agent-test-token", {})).status).toBe(401);
  expect(calls).toEqual([]);
  expect((await request(`${route}lock`, undefined, {}, origin, cookie)).status).toBe(200);
  expect((await request(`${route}connections`, undefined, {}, origin, cookie)).status).toBe(401);
  expect(await (await request(`${route}session`, undefined, {}, origin, cookie)).json()).toEqual({
    authenticated: false,
    expiresAt: null,
  });
});

test("restart details are opt-in so existing open tabs can still decode their strict receipts", async () => {
  const { request } = await fixture();
  const job = RestartJobSchema.parse(
    await (
      await request("/api/installation/restart-requests", "host-agent-test-token", {
        target: "host",
        reason: "Reviewed maintenance",
        requester: "Provider settings task",
      })
    ).json(),
  );
  const legacySchema = RestartJobSchema.omit({
    whenIdle: true,
    approvedAt: true,
    impact: true,
    requester: true,
  });
  const legacy = await (
    await request("/api/installation/owner/restarts/query", "owner-test-password", {})
  ).json();
  expect(legacySchema.array().parse(legacy)[0]?.id).toBe(job.id);
  const details = RestartJobSchema.array().parse(
    await (
      await request(
        "/api/installation/owner/restarts/query?idleRestarts=1",
        "owner-test-password",
        {},
      )
    ).json(),
  );
  expect(details[0]?.requester).toBe("Provider settings task");
});

test("legacy owner clients can read removed providers but cannot resurrect them", async () => {
  const host = new SettingsEnvironmentFake("host-id");
  host.config.providers = { mock: { enabled: true } };
  const settings = new InstallationSettingsService(new SettingsJournalFake(), [host]);
  const initial = await settings.reconcile();
  const definitions = initial.settings!.providerDefinitions!;
  for (const provider of definitions) {
    provider.removed = true;
    provider.policy.enabled = false;
  }
  const saved = await settings.update({
    expectedRevision: initial.revision,
    settings: { providerDefinitions: definitions },
  });
  const { url } = await fixture(undefined, settings);
  const headers = {
    Host: "owner.example.test",
    Origin: "https://owner.example.test",
    Authorization: "Bearer owner-test-password",
    "Content-Type": "application/json",
  };
  const legacy = await (
    await requestWithHost(`${url}/api/installation/owner/settings/read`, {
      method: "POST",
      headers,
      body: "{}",
    })
  ).json();
  expect(legacy.settings.providerDefinitions[0]).not.toHaveProperty("removed");
  expect(legacy.settings.providerDefinitions[0].policy.enabled).toBe(false);
  const rejected = await requestWithHost(`${url}/api/installation/owner/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      expectedRevision: saved.revision,
      settings: { providerDefinitions: legacy.settings.providerDefinitions },
    }),
  });
  expect(rejected.status).toBe(409);
  expect(settings.snapshot().settings!.providerDefinitions![0].removed).toBe(true);
  const aware = await (
    await requestWithHost(`${url}/api/installation/owner/settings/read`, {
      method: "POST",
      headers: { ...headers, "X-Vorteo-Provider-Removal": "1" },
      body: "{}",
    })
  ).json();
  expect(aware.settings.providerDefinitions[0].removed).toBe(true);
  const restored = await requestWithHost(`${url}/api/installation/owner/settings`, {
    method: "PATCH",
    headers: { ...headers, "X-Vorteo-Provider-Removal": "1" },
    body: JSON.stringify({
      expectedRevision: saved.revision,
      settings: {
        providerDefinitions: definitions.map((provider) =>
          Object.assign({}, provider, { removed: false }),
        ),
      },
    }),
  });
  expect(restored.status).toBe(200);
  expect(settings.snapshot().settings!.providerDefinitions![0].removed).toBe(false);
});

test("uploaded source stays inert until the owner approves its exact digest; legacy approval cannot install", async () => {
  const install = vi
    .spyOn(InstallationSourceUpdates.prototype, "install")
    .mockResolvedValue("installed and verified");
  try {
    const { request, url } = await fixture(undefined, undefined, undefined, true);
    const bundle = Buffer.from("inert test bundle");
    const update = {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: createHash("sha256").update(bundle).digest("hex"),
      bytes: bundle.length,
    };
    const body = { request: { target: "host", reason: "Review source update" }, update };
    const upload = (token: string, metadata = body) =>
      fetch(`${url}/api/installation/source-update-requests`, {
        method: "POST",
        headers: {
          Host: "owner.example.test",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "x-vorteo-update": Buffer.from(JSON.stringify(metadata)).toString("base64"),
        },
        body: bundle,
      });
    expect((await upload("wrong-token")).status).toBe(401);
    expect(
      (await request("/api/installation/update-source", "guest-agent-test-token")).status,
    ).toBe(200);
    const uploaded = await upload("guest-agent-test-token");
    expect(uploaded.status).toBe(201);
    const job = RestartJobSchema.parse(await uploaded.json());
    expect(job.update).toEqual(update);
    expect(install).not.toHaveBeenCalled();
    expect((await upload("guest-agent-test-token")).status).toBe(409);
    const legacy = await request(
      "/api/installation/owner/restarts/query",
      "owner-test-password",
      {},
    );
    expect(await legacy.json()).toEqual([expect.not.objectContaining({ update })]);
    const decision = `/api/installation/owner/restarts/${job.id}/decision`;
    expect(
      (
        await request(decision, "guest-agent-test-token", {
          revision: job.revision,
          decision: "approve",
          updateSha256: update.sha256,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(decision, "owner-test-password", {
          revision: job.revision,
          decision: "approve",
        })
      ).status,
    ).toBe(409);
    expect(install).not.toHaveBeenCalled();
    const approved = await request(
      `${decision}?idleRestarts=1&sourceUpdates=1`,
      "owner-test-password",
      { revision: job.revision, decision: "approve", updateSha256: update.sha256 },
    );
    expect(approved.status).toBe(200);
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
  } finally {
    install.mockRestore();
  }
});

test("old coordinators refuse source upload explicitly and a changed bundle never creates a job", async () => {
  const unavailable = await fixture();
  expect(
    (await unavailable.request("/api/installation/update-source", "guest-agent-test-token")).status,
  ).toBe(503);
  const { request, url } = await fixture(undefined, undefined, undefined, true);
  const metadata = {
    request: { target: "host", reason: "test" },
    update: {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: "c".repeat(64),
      bytes: 4,
    },
  };
  const response = await fetch(`${url}/api/installation/source-update-requests`, {
    method: "POST",
    headers: {
      Host: "owner.example.test",
      Authorization: "Bearer guest-agent-test-token",
      "Content-Type": "application/octet-stream",
      "x-vorteo-update": Buffer.from(JSON.stringify(metadata)).toString("base64"),
    },
    body: Buffer.from("nope"),
  });
  expect(response.status).not.toBe(201);
  expect(
    await (
      await request("/api/installation/owner/restarts/query", "owner-test-password", {})
    ).json(),
  ).toEqual([]);
});

test.each(["succeeded", "failed"] as const)(
  "batch uploads retain scoped receipts and require exact approval: %s",
  async (outcome) => {
    const install = vi.spyOn(InstallationSourceUpdates.prototype, "install");
    if (outcome === "succeeded") install.mockResolvedValue("installed");
    else install.mockRejectedValue(new Error("Test installation failed"));
    const prepare = vi
      .spyOn(InstallationSourceUpdates.prototype, "prepare")
      .mockImplementation(async (contributions) => ({
        batch: {
          webCommit: "b".repeat(40),
          status: "ready",
          contributions: contributions.map((item) => ({ ...item, status: "included" })),
        },
        update: { ...contributions[0]!.update, sha256: String(contributions.length).repeat(64) },
      }));
    try {
      const { request, url, drain } = await fixture(undefined, undefined, undefined, true);
      const bundle = Buffer.from("inert source contribution");
      const update = {
        sourceCommit: "a".repeat(40),
        baseCommit: "b".repeat(40),
        sha256: createHash("sha256").update(bundle).digest("hex"),
        bytes: bundle.length,
      };
      const firstId = crypto.randomUUID();
      const secondId = crypto.randomUUID();
      const upload = (id: string, token = "guest-agent-test-token") =>
        fetch(`${url}/api/installation/source-update-requests?sourceBatches=1`, {
          method: "POST",
          headers: {
            Host: "owner.example.test",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "x-vorteo-update": Buffer.from(
              JSON.stringify({
                request: { target: "host", reason: id },
                update,
                contributionId: id,
              }),
            ).toString("base64"),
          },
          body: bundle,
        });
      const replies = await Promise.all([upload(firstId), upload(secondId)]);
      expect(replies.map((reply) => reply.status)).toEqual([201, 201]);
      const [first, second] = await Promise.all(replies.map((reply) => reply.json()));
      expect(first.batch.id).toBe(second.batch.id);
      const receiptPath = `/api/installation/source-contributions/${firstId}`;
      expect((await request(receiptPath, "bad-token")).status).toBe(401);
      const read = async () => (await request(receiptPath, "guest-agent-test-token")).json();
      // Run the coordinator drain that retries preparation invalidated by the second upload.
      await drain();
      const batchResponse = await request(
        "/api/installation/owner/restarts/query?sourceUpdates=1&sourceBatches=1",
        "owner-test-password",
        {},
      );
      const batchJobs = await batchResponse.json();
      expect(batchResponse.status).toBe(200);
      expect(batchJobs[0]?.sourceBatch?.contributions, JSON.stringify(batchJobs)).toHaveLength(2);
      // Trigger the same durable preparation path used by the coordinator's interval.
      const old = await read();
      if (old.batch.sourceBatch.status !== "ready") {
        // Idempotent retries retain the receipt and schedule another preparation.
        expect((await upload(firstId)).status).toBe(201);
      }
      await vi.waitFor(async () => expect((await read()).batch.sourceBatch.status).toBe("ready"));
      const receipt = await read();
      expect(receipt.contribution.update).toEqual(update);
      const decisionPath = `/api/installation/owner/restarts/${receipt.batch.id}/decision`;
      const exact = {
        revision: receipt.batch.revision,
        decision: "approve",
        updateSha256: receipt.batch.update.sha256,
      };
      expect(
        (await request(`${decisionPath}?sourceUpdates=1`, "owner-test-password", exact)).status,
      ).toBe(409);
      expect(
        (
          await request(`${decisionPath}?sourceBatches=1`, "owner-test-password", {
            ...exact,
            revision: first.batch.revision,
          })
        ).status,
      ).toBe(409);
      expect(install).not.toHaveBeenCalled();
      const legacy = await (
        await request("/api/installation/owner/restarts/query", "owner-test-password", {})
      ).json();
      expect(legacy[0].sourceBatch).toBeUndefined();
      expect(legacy[0].update).toBeUndefined();
      expect(
        (
          await request(
            `${decisionPath}?sourceBatches=1&sourceUpdates=1`,
            "owner-test-password",
            exact,
          )
        ).status,
      ).toBe(200);
      await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
      const terminal = (await read()).batch;
      expect(terminal.status).toBe(outcome);
      for (const query of ["", "?sourceUpdates=1", "?sourceUpdates=1&sourceBatches=1"]) {
        const response = await request(
          `/api/installation/owner/restarts/query${query}`,
          "owner-test-password",
          {},
        );
        const jobs = await response.json();
        const completed = jobs.find((item: { id: string }) => item.id === terminal.id);
        expect(completed.status).toBe(outcome);
        expect(completed.detail).toBe(terminal.detail);
        expect(completed.detail).not.toContain("pending");
      }
      expect((await upload(firstId)).status).toBe(201);
      expect(install).toHaveBeenCalledOnce();
      const next = await (await upload(crypto.randomUUID())).json();
      expect(next.batch.id).not.toBe(receipt.batch.id);
      expect(next.batch.status).toBe("pending");
    } finally {
      install.mockRestore();
      prepare.mockRestore();
    }
  },
);

test("scoped Dev updates require target-aware owner review and never reuse Host approval", async () => {
  const { request, url, calls } = await fixture(undefined, undefined, undefined, "both");
  const capabilities = await request("/api/installation/capabilities", "guest-agent-test-token");
  expect(await capabilities.json()).toMatchObject({
    ownerApprovalRequired: true,
    targets: [
      { target: "host", sourceUpdate: { available: true } },
      { target: "container-daemon", sourceUpdate: { available: true } },
    ],
  });
  const source = await request(
    "/api/installation/update-source?target=container-daemon",
    "guest-agent-test-token",
  );
  expect(await source.json()).toMatchObject({
    target: "container-daemon",
    baseCommit: "c".repeat(40),
    baseCandidates: ["c".repeat(40)],
  });
  const bundle = Buffer.from("inert Dev test bundle");
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "c".repeat(40),
    sha256: createHash("sha256").update(bundle).digest("hex"),
    bytes: bundle.length,
  };
  const metadata = {
    request: { target: "container-daemon", reason: "Prepare Dev update" },
    update,
  };
  const upload = (target: string) =>
    fetch(`${url}/api/installation/source-update-requests?target=${target}`, {
      method: "POST",
      headers: {
        Host: "owner.example.test",
        Authorization: "Bearer guest-agent-test-token",
        "Content-Type": "application/octet-stream",
        "x-vorteo-update": Buffer.from(JSON.stringify(metadata)).toString("base64"),
      },
      body: bundle,
    });
  expect((await upload("host")).status).toBe(400);
  const result = await upload("container-daemon");
  expect(result.status).toBe(201);
  const job = RestartJobSchema.parse(await result.json());
  const decision = { revision: job.revision, decision: "approve", updateSha256: update.sha256 };
  const route = `/api/installation/owner/restarts/${job.id}/decision`;
  expect(
    (await request(`${route}?containerSourceUpdates=1`, "guest-agent-test-token", decision)).status,
  ).toBe(401);
  expect(
    (await request(`${route}?sourceUpdates=1&sourceBatches=1`, "owner-test-password", decision))
      .status,
  ).toBe(409);
  const oldTab = await request(
    "/api/installation/owner/restarts/query?sourceUpdates=1&sourceBatches=1",
    "owner-test-password",
    {},
  );
  expect(await oldTab.json()).toEqual([expect.not.objectContaining({ update })]);
  expect(calls).toEqual([]);
});

test("capability discovery reports the Dev bootstrap blocker without exposing configuration", async () => {
  const { request } = await fixture();
  expect((await request("/api/installation/capabilities", "wrong")).status).toBe(401);
  const response = await request("/api/installation/capabilities", "guest-agent-test-token");
  expect(await response.json()).toMatchObject({
    targets: [
      { target: "host", sourceUpdate: { available: false } },
      { target: "container-daemon", sourceUpdate: { available: false } },
    ],
  });
  expect(
    (
      await request(
        "/api/installation/update-source?target=container-daemon",
        "guest-agent-test-token",
      )
    ).status,
  ).toBe(503);
});

test("Factory adoption rejects guest requests and legacy approvals while preserving cancellation", async () => {
  const { request, calls } = await fixture();
  const plan = "c".repeat(64);
  const guest = await request("/api/installation/capabilities", "guest-agent-test-token");
  expect((await guest.json()).factoryRuntimeAdoption).toEqual({
    available: false,
    ownerApprovalRequired: true,
  });
  const input = {
    target: "container-daemon",
    reason: "Reviewed Factory startup",
    factoryRuntimePlanSha256: plan,
  };
  expect(
    (await request("/api/installation/restart-requests", "guest-agent-test-token", input)).status,
  ).toBe(409);
  const created = await request(
    "/api/installation/restart-requests",
    "host-agent-test-token",
    input,
  );
  expect(created.status).toBe(201);
  const job = RestartJobSchema.parse(await created.json());
  expect(job.factoryRuntimePlanSha256).toBe(plan);
  const old = await request("/api/installation/owner/restarts/query", "owner-test-password", {});
  const visible = JSON.stringify(await old.json());
  expect(visible).toContain("Reload Vorteo");
  expect(visible).not.toContain("factoryRuntimePlanSha256");
  const route = `/api/installation/owner/restarts/${job.id}/decision`;
  expect(
    (await request(route, "owner-test-password", { revision: job.revision, decision: "approve" }))
      .status,
  ).toBe(409);
  expect(
    (await request(route, "owner-test-password", { revision: job.revision, decision: "reject" }))
      .status,
  ).toBe(200);
  expect(calls).toEqual([]);
});

test("Factory adoption dispatches only the exact reviewed operation through the owner route", async () => {
  const { request, calls } = await fixture();
  const plan = "c".repeat(64);
  const host = await request("/api/installation/capabilities", "host-agent-test-token");
  expect((await host.json()).factoryRuntimeAdoption).toEqual({
    available: true,
    sha256: plan,
    ownerApprovalRequired: true,
  });
  const created = await request("/api/installation/restart-requests", "host-agent-test-token", {
    target: "container-daemon",
    reason: "Reviewed Factory startup",
    factoryRuntimePlanSha256: plan,
  });
  const job = RestartJobSchema.parse(await created.json());
  const review = await request(
    "/api/installation/owner/restarts/query?factoryRuntimeAdoption=1",
    "owner-test-password",
    {},
  );
  expect(review.status).toBe(200);
  expect((await review.json()).find((entry: { id: string }) => entry.id === job.id)).toMatchObject({
    factoryRuntimePlanSha256: plan,
    revision: job.revision,
  });
  const response = await request(
    `/api/installation/owner/restarts/${job.id}/decision?factoryRuntimeAdoption=1`,
    "owner-test-password",
    {
      revision: job.revision,
      decision: "approve",
      factoryRuntimePlanSha256: plan,
    },
  );
  expect(response.status).toBe(200);
  await expect.poll(() => calls).toEqual(["factory-adoption"]);
  const status = await request(
    `/api/installation/restart-requests/${job.id}`,
    "host-agent-test-token",
  );
  expect((await status.json()).status).toBe("succeeded");
});

test("supervisor maintenance stays visible to old clients but requires exact owner review", async () => {
  const { request, calls } = await fixture();
  const input = {
    target: "container-daemon",
    reason: "Repair profile launcher",
    supervisorPlanSha256: "a".repeat(64),
  };
  const route = "/api/installation/restart-requests";
  expect((await request(route, "guest-agent-test-token", input)).status).toBe(409);
  const created = await request(route, "host-agent-test-token", input);
  expect(created.status).toBe(201);
  const job = RestartJobSchema.parse(await created.json());
  expect(job.supervisorPlanSha256).toBe(input.supervisorPlanSha256);
  expect(calls).toEqual([]);
  const unlocked = await request("/api/installation/owner/unlock", "owner-test-password", {});
  const cookie = unlocked.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing owner cookie");
  const old = await request(
    "/api/installation/owner/restarts/query",
    undefined,
    {},
    undefined,
    cookie,
  );
  expect(old.status).toBe(200);
  const visible = await old.json();
  expect(JSON.stringify(visible)).toContain("Reload Vorteo");
  expect(JSON.stringify(visible)).not.toContain("supervisorPlanSha256");
  const decision = `/api/installation/owner/restarts/${job.id}/decision`;
  expect(
    (
      await request(
        decision,
        undefined,
        { revision: job.revision, decision: "approve" },
        undefined,
        cookie,
      )
    ).status,
  ).toBe(409);
  const cancelled = await request(
    decision,
    undefined,
    { revision: job.revision, decision: "reject" },
    undefined,
    cookie,
  );
  expect(cancelled.status).toBe(200);
  expect(calls).toEqual([]);
});

test("supervisor capability is Host scoped and exact approval dispatches the maintenance executor", async () => {
  const { request, calls } = await fixture();
  const guest = await request("/api/installation/capabilities", "guest-agent-test-token");
  expect((await guest.json()).supervisorMaintenance).toEqual({
    available: false,
    ownerApprovalRequired: true,
  });
  const host = await request("/api/installation/capabilities", "host-agent-test-token");
  const sha = "a".repeat(64);
  expect((await host.json()).supervisorMaintenance).toEqual({
    available: true,
    sha256: sha,
    ownerApprovalRequired: true,
  });
  const created = await request("/api/installation/restart-requests", "host-agent-test-token", {
    target: "container-daemon",
    reason: "Reviewed fixture",
    supervisorPlanSha256: sha,
  });
  const job = RestartJobSchema.parse(await created.json());
  const response = await request(
    `/api/installation/owner/restarts/${job.id}/decision?supervisorMaintenance=1`,
    "owner-test-password",
    { revision: job.revision, decision: "approve", supervisorPlanSha256: sha },
  );
  expect(response.status).toBe(200);
  await expect.poll(() => calls).toEqual(["supervisor"]);
  const status = await request(
    `/api/installation/restart-requests/${job.id}`,
    "host-agent-test-token",
  );
  expect((await status.json()).status).toBe("succeeded");
});

test.each(["host", "container-daemon"] as const)(
  "capabilities keep separate daemon permissions when %s automation is disabled",
  async (disabledTarget) => {
    const f = await fixture(undefined, undefined, undefined, false, true);
    const changed = await f.request(
      "/api/installation/owner/maintenance-permissions/change",
      "owner-test-password",
      {
        expectedRevision: null,
        service: disabledTarget,
        enabled: false,
      },
    );
    expect(changed.status).toBe(200);
    const capabilities = "/api/installation/capabilities";
    const host = await (await f.request(capabilities, "host-agent-test-token")).json();
    expect(host).toMatchObject({ ownerApprovalRequired: true, hostAutomaticRestarts: false });
    for (const target of ["host", "container-daemon"] as const) {
      const automatic = target !== disabledTarget;
      expect(host.targets.find((item: { target: string }) => item.target === target)).toMatchObject(
        {
          ownerApprovalRequired: !automatic,
          hostAutomaticRestarts: automatic,
        },
      );
      const created = await f.request(
        "/api/installation/restart-requests",
        "host-agent-test-token",
        {
          target,
          reason: "Verify separate daemon permissions",
        },
      );
      expect(created.status).toBe(201);
      const job = RestartJobSchema.parse(await created.json());
      await f.drain();
      const receipt = await f.request(
        `/api/installation/restart-requests/${job.id}`,
        "host-agent-test-token",
      );
      expect((await receipt.json()).status).toBe(automatic ? "approved" : "pending");
    }
    const guest = await (await f.request(capabilities, "guest-agent-test-token")).json();
    expect(guest.ownerApprovalRequired).toBe(true);
    expect(
      guest.targets.map((item: { ownerApprovalRequired: boolean }) => item.ownerApprovalRequired),
    ).toEqual([true, true]);
    expect(f.calls).toEqual([]);
  },
);

test("automatic Host approval uses authenticated origin and hides metadata from legacy clients", async () => {
  const { request, calls, drain } = await fixture(undefined, undefined, undefined, false, true);
  const route = "/api/installation/restart-requests";
  const capabilities = "/api/installation/capabilities";
  expect(await (await request(capabilities, "host-agent-test-token")).json()).toMatchObject({
    ownerApprovalRequired: false,
    hostAutomaticRestarts: true,
  });
  expect(await (await request(capabilities, "guest-agent-test-token")).json()).toMatchObject({
    ownerApprovalRequired: true,
    hostAutomaticRestarts: true,
  });
  const guest = RestartJobSchema.parse(
    await (
      await request(route, "guest-agent-test-token", {
        target: "host",
        reason: "Dev update",
        requester: "host-agent",
      })
    ).json(),
  );
  await drain();
  expect(
    RestartJobSchema.parse(
      await (await request(`${route}/${guest.id}`, "guest-agent-test-token")).json(),
    ).status,
  ).toBe("pending");
  expect(calls).toEqual([]);
  expect(
    (
      await request(route, "guest-agent-test-token", {
        target: "host",
        reason: "Forged origin",
        requestedBy: "host-agent",
      })
    ).status,
  ).toBe(400);
  const host = RestartJobSchema.parse(
    await (
      await request(route, "host-agent-test-token", {
        target: "container-daemon",
        reason: "Trusted Host request",
      })
    ).json(),
  );
  await drain();
  const modern = RestartJobSchema.parse(
    await (
      await request(`${route}/${host.id}?hostAutomaticRestarts=1`, "host-agent-test-token")
    ).json(),
  );
  expect(modern.status).toBe("approved");
  expect(modern.requestedBy).toBe("host-agent");
  expect(modern.automaticApproval?.requestRevision).toBe(modern.revision);
  const legacy = await (await request(`${route}/${host.id}`, "host-agent-test-token")).json();
  expect(legacy).not.toHaveProperty("automaticApproval");
  expect(calls).toEqual([]);
  expect(modern).not.toHaveProperty("automaticAuthority");
  expect(modern).not.toHaveProperty("automaticDispatchAfter");
  const canceled = await request(
    `/api/installation/owner/restarts/${host.id}/decision`,
    "owner-test-password",
    {
      revision: modern.revision,
      decision: "cancel",
    },
  );
  expect(canceled.status).toBe(200);
  await drain();
  expect(calls).toEqual(["release"]);
});

test("Claude setup login accepts only owner access and sanitizes code failures", async () => {
  const runtime: ClaudeSetupRuntime = {
    read: vi.fn(() => ({
      login: { status: "idle" },
      connection: { connected: false, environments: [] },
    })),
    start: vi.fn(async () => ({
      status: "starting",
      attemptId: "11111111-1111-4111-8111-111111111111",
    })),
    submit: vi.fn(async () => {
      throw Error("synthetic-private-code");
    }),
    cancel: vi.fn(async () => ({ status: "idle" })),
    signOut: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const { request } = await fixture(undefined, undefined, undefined, false, false, runtime);
  const root = "/api/installation/owner/claude/setup-token";
  for (const credential of [undefined, "host-agent-test-token", "guest-agent-test-token"]) {
    expect((await request(`${root}/start`, credential, { definitionId: "one" })).status).toBe(401);
  }
  expect(
    (
      await request(
        `${root}/start`,
        "owner-test-password",
        { definitionId: "one" },
        "https://foreign.example.test",
      )
    ).status,
  ).toBe(403);
  expect(runtime.start).not.toHaveBeenCalled();
  expect(
    (await request(`${root}/start`, "owner-test-password", { definitionId: "one" })).status,
  ).toBe(200);
  const rejected = await request(`${root}/submit`, "owner-test-password", {
    definitionId: "one",
    attemptId: "11111111-1111-4111-8111-111111111111",
    code: "synthetic-private-code",
  });
  expect(rejected.status).toBe(409);
  expect(JSON.stringify(await rejected.json())).not.toContain("synthetic-private-code");
});

test("a future pending plan does not disable HTTP after the exact promoted startup completes", async () => {
  const retained = coordinatorStatusRequest();
  retained.execution!.stage = "started";
  let fence: InstallationStartupFence | undefined;
  const f = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    {
      generation: retained.execution!.generation,
      released() {
        if (!fence) throw new Error("Fixture startup fence was not initialized");
        return fence.released();
      },
    },
    undefined,
    (config) => {
      retained.plan.installationId = config.public.installationId;
      retained.plan.state.directory = config.stateDir;
      retained.planSha256 = coordinatorPlanDigest(retained.plan);
      writeFileSync(
        path.join(config.stateDir, "coordinator-bootstrap.json"),
        JSON.stringify({ version: 1, requests: [retained] }),
        { mode: 0o600 },
      );
      const futurePlan = { ...retained.plan, futureMaintenanceTooling: true };
      const future = {
        ...retained,
        id: randomUUID(),
        revision: randomUUID(),
        status: "pending",
        execution: undefined,
        plan: futurePlan,
        planSha256: createHash("sha256").update(JSON.stringify(futurePlan)).digest("hex"),
      };
      writeFileSync(
        path.join(config.stateDir, "coordinator-bootstrap-pending.json"),
        JSON.stringify({ version: 1, requests: [future], promotions: [] }),
        { mode: 0o600 },
      );
      fence = loadCoordinatorStartupFence({
        installationId: config.public.installationId,
        stateDirectory: config.stateDir,
        node: retained.plan.candidate.node.path,
        entrypoint: retained.plan.candidate.entrypoint.path,
        configuration: retained.plan.candidate.configuration.path,
      });
    },
  );
  const pendingPath = path.join(f.root, "coordinator-bootstrap-pending.json");
  const before = readFileSync(pendingPath);
  expect((await (await f.request("/api/installation/health")).json()).bootstrap.fenced).toBe(true);
  retained.execution!.stage = "succeeded";
  writeFileSync(
    path.join(f.root, "coordinator-bootstrap.json"),
    JSON.stringify({ version: 1, requests: [retained] }),
    { mode: 0o600 },
  );
  const health = await f.request("/api/installation/health");
  expect(health.status).toBe(200);
  expect(await health.json()).not.toHaveProperty("bootstrap");
  const page = await f.request("/");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("trusted application");
  await f.drain();
  expect(f.calls).toEqual([]);
  expect(readFileSync(pendingPath)).toEqual(before);
  expect(() => new FileBootstrapRequestJournal(f.root).read()).toThrow("futureMaintenanceTooling");
});

test("bootstrap HTTP readiness stays fenced without journal writes or admitted operations", async () => {
  let released = false;
  let broken = false;
  const generation = randomUUID();
  const f = await fixture(undefined, undefined, undefined, false, false, undefined, {
    generation,
    released: () => {
      if (broken) throw new Error("private failure");
      return released;
    },
  });
  const health = await f.request("/api/installation/health");
  expect(health.status).toBe(200);
  expect((await health.json()).bootstrap).toEqual({ generation, pid: process.pid, fenced: true });
  for (const route of [
    "/api/installation/restart-requests",
    "/api/installation/owner/unlock",
    "/api/installation/owner/settings/read",
  ])
    expect((await f.request(route, "owner-test-password", {})).status).toBe(503);
  // Capability discovery and both new-field admission routes share the startup
  // fence. No journal or upload may outlive a failed candidate's bootstrap.
  expect((await f.request("/api/installation/capabilities", "host-agent-test-token")).status).toBe(
    503,
  );
  expect(
    (
      await f.request(
        "/api/installation/restart-requests?requireOwnerApproval=1",
        "host-agent-test-token",
        {
          target: "host",
          reason: "Must remain inert",
          requireOwnerApproval: true,
        },
      )
    ).status,
  ).toBe(503);
  const upload = await fetch(
    `${f.url}/api/installation/source-update-requests?sourceBatches=1&requireOwnerApproval=1`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer host-agent-test-token",
        "Content-Type": "application/octet-stream",
        "x-vorteo-update": Buffer.from(
          JSON.stringify({
            contributionId: randomUUID(),
            request: { target: "host", reason: "Must remain inert", requireOwnerApproval: true },
            update: {
              sourceCommit: "a".repeat(40),
              baseCommit: "b".repeat(40),
              sha256: "c".repeat(64),
              bytes: 1,
            },
          }),
        ).toString("base64"),
      },
      body: "x",
    },
  );
  expect(upload.status).toBe(503);
  await f.drain();
  expect(f.calls).toEqual([]);
  expect(existsSync(path.join(f.root, "restart-jobs.json"))).toBe(false);
  broken = true;
  const refused = await f.request("/api/installation/health");
  expect(refused.status).toBe(503);
  expect(await refused.json()).toEqual({
    error: "Coordinator startup requires installation recovery.",
  });
  broken = false;
  released = true;
  const ready = await f.request("/api/installation/health");
  expect(ready.status).toBe(200);
  expect(await ready.json()).not.toHaveProperty("bootstrap");
  expect(JSON.parse(readFileSync(path.join(f.root, "restart-jobs.json"), "utf8"))).toEqual([]);
  expect(
    (
      await f.request("/api/installation/restart-requests", "guest-agent-test-token", {
        target: "host",
        reason: "After verified release",
      })
    ).status,
  ).toBe(201);
  expect(f.calls).toEqual([]);
});

test("helper controls require owner authentication and preparation refuses guest credentials", async () => {
  const { request } = await fixture();
  for (const route of ["query", "decision", "verify-installed"]) {
    const target = "/api/installation/owner/helpers/" + route;
    for (const token of [undefined, "host-agent-test-token", "guest-agent-test-token"]) {
      expect((await request(target, token, {})).status).toBe(401);
    }
    expect(
      (await request(target, "owner-test-password", {}, "https://foreign.example.test")).status,
    ).toBe(403);
  }
  expect(
    await (await request("/api/installation/capabilities", "host-agent-test-token")).json(),
  ).toMatchObject({ nativeHelper: { available: false, ownerApprovalRequired: true } });
  const prepare = "/api/installation/helper-requests";
  expect((await request(prepare, "guest-agent-test-token", {})).status).toBe(401);
  expect((await request(prepare, "owner-test-password", {})).status).toBe(401);
  expect((await request(prepare, "host-agent-test-token", {})).status).toBe(503);
  const listed = await request("/api/installation/owner/helpers/query", "owner-test-password", {});
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({ jobs: [] });
  expect(
    (
      await request("/api/installation/owner/helpers/decision", "owner-test-password", {
        revision: randomUUID(),
        decision: "approve",
      })
    ).status,
  ).toBe(400);
});

function helperHttpPreparation() {
  const digest = "a".repeat(64);
  const file = { path: "/private/fixture/tool", sha256: digest };
  return {
    id: randomUUID(),
    reason: "Install isolated helper fixture",
    plan: {
      version: 1,
      operation: "native-helper-install",
      installationId: randomUUID(),
      candidate: {
        sourceCommit: "b".repeat(40),
        directory: "/private/fixture/candidate.app",
        artifactSha256: digest,
        signingMode: "local",
        helperRequirement: "fixture-helper",
        clientRequirement: "fixture-client",
      },
      previous: null,
      retainedRollback: null,
      tooling: {
        sourceCommit: "b".repeat(40),
        directory: "/private/fixture/tooling",
        artifactSha256: digest,
        node: file,
        installer: file,
        dispatcher: file,
        invocationClient: file,
      },
      destination: {
        application: "/private/fixture/Helper.app",
        runtime: "/private/fixture/runtime",
      },
      expectedState: {
        configurationSha256: null,
        policySha256: null,
        installationReceiptSha256: null,
      },
    },
  };
}

test("helper HTTP approval binds the exact source and cancellation never invokes installation", async () => {
  const install = vi.fn(async () => "verified fixture helper");
  const { request, drain, calls, root } = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    {
      validateHelperPlan: async () => {},
      installHelper: install,
      verifyHelperRecovery: async () => "verified recovery",
    },
  );
  expect(
    await (await request("/api/installation/capabilities", "host-agent-test-token")).json(),
  ).toMatchObject({ nativeHelper: { available: true, ownerApprovalRequired: true } });
  expect(
    await (await request("/api/installation/capabilities", "guest-agent-test-token")).json(),
  ).toMatchObject({ nativeHelper: { available: false, ownerApprovalRequired: true } });
  const prepared = await request(
    "/api/installation/helper-requests",
    "host-agent-test-token",
    helperHttpPreparation(),
  );
  expect(prepared.status).toBe(201);
  const job = NativeHelperJobSchema.parse(await prepared.json());
  expect(job.status).toBe("pending");
  const publicSummary = await request("/api/installation/restart-summary");
  expect(publicSummary.status).toBe(200);
  expect(await publicSummary.json()).toEqual({
    requested: 0,
    queued: 0,
    running: 0,
    nativeHelper: { requested: 1, queued: 0, running: 0, recovery: 0 },
  });

  await drain();
  expect(install).not.toHaveBeenCalled();
  const decision = {
    operation: "native-helper-install",
    id: job.id,
    revision: job.revision,
    planSha256: job.planSha256,
    decision: "approve",
  };
  const route = "/api/installation/owner/helpers/decision";
  expect(
    (await request(route, "owner-test-password", { ...decision, revision: randomUUID() })).status,
  ).toBe(409);
  expect(install).not.toHaveBeenCalled();
  expect((await request(route, "owner-test-password", decision)).status).toBe(200);
  await expect.poll(() => install.mock.calls.length).toBe(1);
  await expect
    .poll(() => JSON.parse(readFileSync(path.join(root, "restart-jobs.json"), "utf8"))[0].status)
    .toBe("succeeded");
  expect(calls).toEqual([]);
  const canceled = await request(
    "/api/installation/helper-requests",
    "host-agent-test-token",
    helperHttpPreparation(),
  );
  const second = NativeHelperJobSchema.parse(await canceled.json());
  expect(
    (
      await request(route, "owner-test-password", {
        ...decision,
        id: second.id,
        revision: second.revision,
        planSha256: second.planSha256,
        decision: "cancel",
      })
    ).status,
  ).toBe(200);
  await drain();
  expect(install).toHaveBeenCalledTimes(1);
});

test("scoped helper CLI prepares inert requests and returns their exact review receipt", async () => {
  let installations = 0;
  const f = await fixture(undefined, undefined, undefined, false, false, undefined, undefined, {
    validateHelperPlan: async () => {},
    installHelper: async () => {
      installations++;
      return "installed";
    },
    verifyHelperRecovery: async () => "verified",
  });
  const client = path.join(f.root, "host-client.json");
  const guest = path.join(f.root, "guest-client.json");
  for (const [file, kind, token] of [
    [client, "host-agent", "host-agent-test-token"],
    [guest, "container-agent", "guest-agent-test-token"],
  ])
    writeFileSync(file, JSON.stringify({ origin: f.url, kind, token }), { mode: 0o600 });
  const requestFile = path.join(f.root, "helper-request.json");
  const preparation = helperHttpPreparation();
  writeFileSync(requestFile, JSON.stringify(preparation), { mode: 0o600 });
  const command = promisify(execFile);
  const script = path.resolve(import.meta.dirname, "../../../../../scripts/installation-agent.mjs");
  const run = (config: string, ...args: string[]) =>
    command(process.execPath, [script, "--config", config, ...args]);
  await expect(run(guest, "request-helper", "--request-file", requestFile)).rejects.toThrow(
    "trusted Host",
  );
  const result = JSON.parse(
    (await run(client, "request-helper", "--request-file", requestFile)).stdout,
  );
  expect(result).toMatchObject({ id: preparation.id, status: "pending", stage: "prepared" });
  expect(new URL(result.approvalUrl).searchParams.get("restart")).toBe(preparation.id);
  const status = JSON.parse((await run(client, "helper-status", preparation.id)).stdout);
  expect(status).toEqual(result);
  expect(
    (
      await f.request(
        `/api/installation/helper-requests/${preparation.id}`,
        "guest-agent-test-token",
      )
    ).status,
  ).toBe(401);
  expect(
    (await f.request(`/api/installation/helper-requests/${randomUUID()}`, "host-agent-test-token"))
      .status,
  ).toBe(404);
  await f.drain();
  expect(installations).toBe(0);
});

test("Host explicit review is advertised, durable and projected for legacy restart clients", async () => {
  const f = await fixture(undefined, undefined, undefined, false, true);
  expect(
    await (await f.request("/api/installation/capabilities", "host-agent-test-token")).json(),
  ).toMatchObject({ requireOwnerApproval: true, hostAutomaticRestarts: true });
  expect(
    await (await f.request("/api/installation/capabilities", "guest-agent-test-token")).json(),
  ).toMatchObject({ requireOwnerApproval: false });
  const route = "/api/installation/restart-requests";
  const input = { target: "host", reason: "Review Host explicitly", requireOwnerApproval: true };
  expect((await f.request(route, "guest-agent-test-token", input)).status).toBe(409);
  const created = await (
    await f.request(`${route}?requireOwnerApproval=1`, "host-agent-test-token", input)
  ).json();
  expect(created).toMatchObject({
    requireOwnerApproval: true,
    requestedBy: "host-agent",
    status: "pending",
  });
  await f.drain();
  expect(f.calls).toEqual([]);
  const modern = await (
    await f.request(`${route}/${created.id}?requireOwnerApproval=1`, "host-agent-test-token")
  ).json();
  expect(modern).toMatchObject({ status: "pending", requireOwnerApproval: true });
  const legacy = await (await f.request(`${route}/${created.id}`, "host-agent-test-token")).json();
  expect(legacy).not.toHaveProperty("requireOwnerApproval");
  expect(RestartJobSchema.omit({ requireOwnerApproval: true }).parse(legacy).id).toBe(created.id);
  const ownerQuery = "/api/installation/owner/restarts/query";
  const oldOwner = await (await f.request(ownerQuery, "owner-test-password", {})).json();
  expect(RestartJobSchema.omit({ requireOwnerApproval: true }).array().parse(oldOwner)[0]?.id).toBe(
    created.id,
  );
  const decision = `/api/installation/owner/restarts/${created.id}/decision`;
  expect(
    (
      await f.request(decision, "owner-test-password", {
        revision: randomUUID(),
        decision: "approve",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.request(decision, "owner-test-password", {
        revision: modern.revision,
        decision: "reject",
      })
    ).status,
  ).toBe(200);
  await f.drain();
  expect(f.calls).toEqual([]);
});

test("source receipt projection preserves explicit Host batch review and exact manual approval", async () => {
  const prepare = vi
    .spyOn(InstallationSourceUpdates.prototype, "prepare")
    .mockImplementation(async (contributions) => ({
      batch: {
        status: "ready",
        webCommit: "b".repeat(40),
        contributions: contributions.map((item) => ({ ...item, status: "included" })),
      },
      update: contributions[0]!.update,
    }));
  const install = vi
    .spyOn(InstallationSourceUpdates.prototype, "install")
    .mockResolvedValue("installed");
  try {
    const f = await fixture(undefined, undefined, undefined, true, true);
    const bundle = Buffer.from("inert manually reviewed source");
    const update = {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: createHash("sha256").update(bundle).digest("hex"),
      bytes: bundle.length,
    };
    const id = randomUUID();
    const upload = await fetch(
      `${f.url}/api/installation/source-update-requests?sourceBatches=1&requireOwnerApproval=1`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer host-agent-test-token",
          "Content-Type": "application/octet-stream",
          "x-vorteo-update": Buffer.from(
            JSON.stringify({
              contributionId: id,
              update,
              request: { target: "host", reason: "Review source", requireOwnerApproval: true },
            }),
          ).toString("base64"),
        },
        body: bundle,
      },
    );
    expect(upload.status).toBe(201);
    const receipt = await upload.json();
    expect(receipt.contribution).toMatchObject({
      id,
      requestedBy: "host-agent",
      requireOwnerApproval: true,
    });
    await f.drain();
    expect(install).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    const route = `/api/installation/source-contributions/${id}`;
    const modern = await (
      await f.request(`${route}?requireOwnerApproval=1`, "host-agent-test-token")
    ).json();
    expect(modern.batch).toMatchObject({ status: "pending", requireOwnerApproval: true });
    const legacy = await (await f.request(route, "host-agent-test-token")).json();
    expect(
      SourceContributionSchema.omit({ requireOwnerApproval: true }).parse(legacy.contribution).id,
    ).toBe(id);
    const legacyJob = RestartJobSchema.omit({ requireOwnerApproval: true }).extend({
      sourceBatch: SourceBatchSchema.extend({
        contributions: SourceContributionSchema.omit({ requireOwnerApproval: true }).array(),
      }).optional(),
    });
    expect(legacyJob.parse(legacy.batch).id).toBe(receipt.batch.id);
    const decision = `/api/installation/owner/restarts/${modern.batch.id}/decision?sourceUpdates=1&sourceBatches=1`;
    expect(
      (
        await f.request(decision, "owner-test-password", {
          revision: modern.batch.revision,
          decision: "approve",
          updateSha256: "d".repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.request(decision, "owner-test-password", {
          revision: modern.batch.revision,
          decision: "approve",
          updateSha256: update.sha256,
        })
      ).status,
    ).toBe(200);
    await f.drain();
    expect(install).toHaveBeenCalledTimes(1);
  } finally {
    prepare.mockRestore();
    install.mockRestore();
  }
});

test("Host CLI requests truthful manual review and returns the exact owner review link", async () => {
  const f = await fixture(undefined, undefined, undefined, false, true);
  const config = path.join(f.root, "manual-client.json");
  const reason = path.join(f.root, "manual-reason.txt");
  writeFileSync(
    config,
    JSON.stringify({ origin: f.url, kind: "host-agent", token: "host-agent-test-token" }),
    { mode: 0o600 },
  );
  writeFileSync(reason, "Review explicitly", { mode: 0o600 });
  const result = await promisify(execFile)(process.execPath, [
    path.resolve(import.meta.dirname, "../../../../../scripts/installation-agent.mjs"),
    "--config",
    config,
    "request-restart",
    "--target",
    "host",
    "--reason-file",
    reason,
    "--require-owner-approval",
  ]);
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({
    requestedBy: "host-agent",
    requireOwnerApproval: true,
    status: "pending",
  });
  expect(new URL(receipt.approvalUrl).searchParams.get("restart")).toBe(receipt.id);
  await f.drain();
  expect(f.calls).toEqual([]);
});

test.each([false, true])(
  "Host CLI fails closed on an old coordinator before request or upload (update: %s)",
  async (update) => {
    const root = mkdtempSync(path.join(tmpdir(), "manual-cli-old-"));
    const calls: string[] = [];
    const server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ version: 1, hostAutomaticRestarts: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const config = path.join(root, "client.json");
      const reason = path.join(root, "reason.txt");
      writeFileSync(
        config,
        JSON.stringify({
          origin: `http://127.0.0.1:${address.port}`,
          kind: "host-agent",
          token: "fixture-token",
        }),
        { mode: 0o600 },
      );
      writeFileSync(reason, "Review explicitly");
      await expect(
        promisify(execFile)(process.execPath, [
          path.resolve(import.meta.dirname, "../../../../../scripts/installation-agent.mjs"),
          "--config",
          config,
          "request-restart",
          "--target",
          "host",
          "--reason-file",
          reason,
          "--require-owner-approval",
          ...(update ? ["--update", "--repository", root] : []),
        ]),
      ).rejects.toThrow("does not advertise explicit owner approval");
      expect(calls).toEqual(["GET /api/installation/capabilities"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Host CLI source contributions carry the advertised owner-review requirement in upload metadata", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "manual-cli-source-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@localhost",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@localhost",
      },
    }).trim();
  git("init", "--initial-branch=main");
  writeFileSync(path.join(root, "feature.txt"), "base");
  git("add", ".");
  git("commit", "-m", "base");
  const baseCommit = git("rev-parse", "HEAD");
  writeFileSync(path.join(root, "feature.txt"), "feature");
  git("commit", "-am", "feature");
  const calls: string[] = [];
  let metadata: unknown;
  let bytes = 0;
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/installation/capabilities") {
      res.end(JSON.stringify({ requireOwnerApproval: true }));
    } else if (req.url === "/api/installation/update-source") {
      res.end(
        JSON.stringify({
          target: "host",
          baseCommit,
          integrationRef: "refs/heads/main",
          maxBytes: 128 * 1024 * 1024,
          sourceBatches: true,
          baseCandidates: [baseCommit],
        }),
      );
    } else {
      const header = req.headers["x-vorteo-update"];
      if (typeof header === "string")
        metadata = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      req.on("end", () =>
        res.end(
          JSON.stringify({ batch: { id: randomUUID() }, contribution: { id: randomUUID() } }),
        ),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const configRoot = mkdtempSync(path.join(tmpdir(), "manual-cli-source-config-"));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const config = path.join(configRoot, "client.json");
    const reason = path.join(configRoot, "reason.txt");
    writeFileSync(
      config,
      JSON.stringify({
        origin: `http://127.0.0.1:${address.port}`,
        kind: "host-agent",
        token: "fixture-token",
      }),
      { mode: 0o600 },
    );
    writeFileSync(reason, "Review source explicitly");
    const id = randomUUID();
    await promisify(execFile)(process.execPath, [
      path.resolve(import.meta.dirname, "../../../../../scripts/installation-agent.mjs"),
      "--config",
      config,
      "request-restart",
      "--target",
      "host",
      "--reason-file",
      reason,
      "--require-owner-approval",
      "--update",
      "--repository",
      root,
      "--contribution-id",
      id,
    ]);
    expect(calls).toEqual([
      "GET /api/installation/capabilities",
      "GET /api/installation/update-source",
      "POST /api/installation/source-update-requests?target=host&sourceBatches=1&requireOwnerApproval=1&engineRestart=1&engineRecovery=1&hostLauncherUpdate=1",
    ]);
    expect(metadata).toMatchObject({
      request: { target: "host", requireOwnerApproval: true },
      contributionId: id,
    });
    expect(bytes).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    rmSync(root, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("daemon automation preference requires owner access and persists exact revisions", async () => {
  const f = await fixture(undefined, undefined, undefined, false, true);
  const query = "/api/installation/owner/daemon-automation/query";
  const change = "/api/installation/owner/daemon-automation/change";
  expect((await f.request(query, "guest-agent-test-token", {})).status).toBe(401);
  expect((await f.request(query, "host-agent-test-token", {})).status).toBe(401);
  const initial = await (await f.request(query, "owner-test-password", {})).json();
  expect(initial).toEqual({
    revision: null,
    enabled: false,
    enabledAfter: null,
    legacyHostOnly: true,
  });
  const enabled = await f.request(change, "owner-test-password", {
    expectedRevision: null,
    enabled: true,
  });
  expect(enabled.status).toBe(200);
  const saved = await enabled.json();
  expect(saved).toMatchObject({ enabled: true, legacyHostOnly: false });
  expect(new DaemonAutomation(f.root, true).read()).toMatchObject(saved);
  expect(typeof saved.revision).toBe("string");
  expect(typeof saved.enabledAfter).toBe("string");
  expect(await (await f.request(query, "owner-test-password", {})).json()).toEqual(saved);
  expect(
    (await f.request(change, "owner-test-password", { expectedRevision: null, enabled: false }))
      .status,
  ).toBe(409);
  const disabled = await f.request(change, "owner-test-password", {
    expectedRevision: saved.revision,
    enabled: false,
  });
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toMatchObject({
    enabled: false,
    enabledAfter: null,
    legacyHostOnly: false,
  });
});

test("owner can disable automation when the coordinator loses restart support", async () => {
  const f = await fixture();
  const saved = new DaemonAutomation(f.root, false).change({
    expectedRevision: null,
    enabled: true,
  });
  const route = "/api/installation/owner/daemon-automation/change";
  const disabled = await f.request(route, "owner-test-password", {
    expectedRevision: saved.revision,
    enabled: false,
  });
  expect(disabled.status).toBe(200);
  const state = await disabled.json();
  expect(state.enabled).toBe(false);
  const refused = await f.request(route, "owner-test-password", {
    expectedRevision: state.revision,
    enabled: true,
  });
  expect(refused.status).toBe(409);
  expect(new DaemonAutomation(f.root, false).read()).toMatchObject(state);
});

test("Dev repair routes require owner authentication and refuse missing or changed requests without lifecycle effects", async () => {
  const f = await fixture(undefined, undefined, undefined, "both");
  const query = "/api/installation/owner/dev-repair/query";
  const prepare = "/api/installation/owner/dev-repair/prepare";
  for (const token of [undefined, "host-agent-test-token", "guest-agent-test-token"]) {
    expect((await f.request(query, token, {})).status).toBe(401);
    expect(
      (
        await f.request(prepare, token, {
          id: randomUUID(),
          revision: randomUUID(),
        })
      ).status,
    ).toBe(401);
  }
  expect(await (await f.request(query, "owner-test-password", {})).json()).toEqual({
    available: true,
    preparingIds: [],
  });
  const refused = await f.request(prepare, "owner-test-password", {
    id: randomUUID(),
    revision: randomUUID(),
  });
  expect(refused.status).toBe(409);
  expect(f.calls).toEqual([]);
});

test("owner HTTP repair captures and stages real Git source without approving or restarting", async () => {
  let id = "";
  const prepareBatch = vi
    .spyOn(InstallationSourceUpdates.prototype, "prepare")
    .mockImplementation(async (contributions) => ({
      batch: { status: "conflict", contributions },
    }));
  try {
    const f = await fixture(
      undefined,
      undefined,
      undefined,
      "both",
      false,
      undefined,
      undefined,
      undefined,
      (config) => {
        const repository = path.join(config.stateDir, "objects");
        mkdirSync(repository);
        const git = (...args: string[]) =>
          execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
            cwd: repository,
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Fixture",
              GIT_AUTHOR_EMAIL: "fixture@example.test",
              GIT_COMMITTER_NAME: "Fixture",
              GIT_COMMITTER_EMAIL: "fixture@example.test",
            },
          }).trim();
        git("init", "--initial-branch=main");
        writeFileSync(path.join(repository, "source.txt"), "base");
        git("add", ".");
        git("commit", "-m", "Base");
        const base = git("rev-parse", "HEAD");
        writeFileSync(path.join(repository, "source.txt"), "candidate");
        git("commit", "-am", "Candidate");
        const candidate = git("rev-parse", "HEAD");
        config.sourceUpdates!.sourceRepository = repository;
        config.containerSourceUpdates!.sourceRepository = repository;
        writeFileSync(
          config.containerSourceUpdates!.receiptFile,
          JSON.stringify({ sourceCommit: base }),
        );
        writeFileSync(
          path.join(config.sourceUpdates!.currentReleaseLink, ".installation-source.json"),
          JSON.stringify({ sourceCommit: candidate }),
        );
        id = randomUUID();
        writeFileSync(
          path.join(config.stateDir, "restart-jobs.json"),
          JSON.stringify([
            {
              id,
              revision: randomUUID(),
              target: "container-daemon",
              reason: "Fixture conflict",
              requestedBy: "container-agent",
              createdAt: new Date().toISOString(),
              expiresAt: "9999-12-31T23:59:59.999Z",
              status: "pending",
              detail: "Conflict",
              sourceBatch: {
                status: "conflict",
                contributions: [
                  {
                    id: randomUUID(),
                    update: {
                      baseCommit: base,
                      sourceCommit: base,
                      sha256: "a".repeat(64),
                      bytes: 10,
                    },
                    reason: "Retained",
                    requestedBy: "container-agent",
                    createdAt: new Date().toISOString(),
                    status: "conflict",
                    detail: "Fixture conflict",
                  },
                ],
              },
            },
          ]),
          { mode: 0o600 },
        );
      },
    );
    await f.drain();
    const journal = () => JSON.parse(readFileSync(path.join(f.root, "restart-jobs.json"), "utf8"));
    const before = journal()[0];
    const response = await f.request(
      "/api/installation/owner/dev-repair/prepare",
      "owner-test-password",
      { id, revision: before.revision },
    );
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(journal()[0].devRepairs?.[0]?.status).toBe("prepared"));
    const after = journal()[0];
    expect(after.status).toBe("pending");
    expect(after.requireOwnerApproval).toBe(true);
    expect(after.sourceBatch.contributions[0]).toEqual(before.sourceBatch.contributions[0]);
    const update = after.sourceBatch.contributions[1].update;
    expect(
      existsSync(path.join(f.root, "container-source-updates", `${update.sha256}.bundle`)),
    ).toBe(true);
    const legacy = await (
      await f.request("/api/installation/owner/restarts/query", "owner-test-password", {})
    ).json();
    expect(legacy[0]).not.toHaveProperty("devRepairs");
    expect(f.calls).toEqual([]);
  } finally {
    prepareBatch.mockRestore();
  }
});

test("a conflicted source batch reports its conflict to agents instead of asking for a reload", async () => {
  const prepareBatch = vi
    .spyOn(InstallationSourceUpdates.prototype, "prepare")
    .mockImplementation(async (contributions) => ({
      batch: { status: "conflict", contributions },
    }));
  const id = randomUUID();
  const contributionId = randomUUID();
  const invalidId = randomUUID();
  const configRoot = mkdtempSync(path.join(tmpdir(), "conflict-status-config-"));
  try {
    const f = await fixture(
      undefined,
      undefined,
      undefined,
      "both",
      false,
      undefined,
      undefined,
      undefined,
      (config) => {
        writeFileSync(
          path.join(config.stateDir, "restart-jobs.json"),
          JSON.stringify([
            {
              id,
              revision: randomUUID(),
              target: "host",
              reason: "Fixture conflict",
              requestedBy: "host-agent",
              createdAt: new Date().toISOString(),
              expiresAt: "9999-12-31T23:59:59.999Z",
              status: "pending",
              detail: "Contributions need correction before this batch can be approved",
              sourceBatch: {
                status: "conflict",
                contributions: [
                  {
                    id: contributionId,
                    update: {
                      baseCommit: "b".repeat(40),
                      sourceCommit: "c".repeat(40),
                      sha256: "a".repeat(64),
                      bytes: 10,
                    },
                    reason: "Conflicting notes",
                    requestedBy: "host-agent",
                    createdAt: new Date().toISOString(),
                    status: "conflict",
                    detail:
                      "docs/vorteo-customizations.md\n\nCONFLICT (content): Merge conflict in docs/vorteo-customizations.md",
                  },
                  {
                    id: invalidId,
                    update: {
                      baseCommit: "b".repeat(40),
                      sourceCommit: "d".repeat(40),
                      sha256: "e".repeat(64),
                      bytes: 10,
                    },
                    reason: "Bad release note",
                    requester: "Release notes",
                    requestedBy: "host-agent",
                    createdAt: new Date().toISOString(),
                    status: "invalid",
                    detail: "Release-note heading requires review",
                  },
                ],
              },
            },
          ]),
          { mode: 0o600 },
        );
      },
    );
    await f.drain();
    // A client without batch support still learns the batch cannot be approved yet.
    const legacy = await (
      await fetch(`${f.url}/api/installation/restart-requests/${id}`, {
        headers: { Authorization: "Bearer host-agent-test-token" },
      })
    ).json();
    expect(legacy).not.toHaveProperty("sourceBatch");
    expect(legacy.detail).toBe("Contributions need correction before this batch can be approved");

    const config = path.join(configRoot, "client.json");
    writeFileSync(
      config,
      JSON.stringify({ origin: f.url, kind: "host-agent", token: "host-agent-test-token" }),
      { mode: 0o600 },
    );
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      path.resolve(import.meta.dirname, "../../../../../scripts/installation-agent.mjs"),
      "--config",
      config,
      "restart-status",
      id,
    ]);
    expect(JSON.parse(stdout).sourceBatch.status).toBe("conflict");
    expect(stderr).toContain(
      `Source batch blocked: contribution ${contributionId} conflicts in docs/vorteo-customizations.md.`,
    );
    expect(stderr).toContain(
      `Source batch blocked: contribution ${invalidId} from "Release notes" was rejected: Release-note heading requires review.`,
    );
    expect(stderr).toContain(`--replaces ${contributionId}`);
  } finally {
    prepareBatch.mockRestore();
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("maintenance readiness separates legacy authority, broad opt-in and source readiness", async () => {
  const f = await fixture(undefined, undefined, undefined, false, true);
  const route = "/api/installation/maintenance-status";
  expect((await f.request(route, "wrong")).status).toBe(401);
  const initial = await (await f.request(route, "guest-agent-test-token")).json();
  expect(initial.version).toBe(1);
  expect(initial.paths).toHaveLength(8);
  expect(initial.paths).toContainEqual(
    expect.objectContaining({
      requester: "host-agent",
      target: "host",
      operation: "restart",
      authorization: "automatic",
      readiness: "ready",
    }),
  );
  expect(initial.paths).toContainEqual(
    expect.objectContaining({
      requester: "container-agent",
      target: "host",
      operation: "restart",
      authorization: "manual",
      readiness: "ready",
    }),
  );
  expect(
    initial.paths
      .filter((item: { operation: string }) => item.operation === "source-update")
      .every(
        (item: { readiness: string; selectedSource: string | null }) =>
          item.readiness === "blocked" && item.selectedSource === null,
      ),
  ).toBe(true);
  const ownerRoute = "/api/installation/owner/maintenance-status/query";
  expect((await f.request(ownerRoute, "guest-agent-test-token", {})).status).toBe(401);
  await f.request("/api/installation/owner/daemon-automation/change", "owner-test-password", {
    expectedRevision: null,
    enabled: true,
  });
  const enabled = await (await f.request(ownerRoute, "owner-test-password", {})).json();
  expect(enabled.preference).toMatchObject({ enabled: true, legacyHostOnly: false });
  expect(
    enabled.paths.every(
      (item: { requester: string; authorization: string }) =>
        item.authorization === (item.requester === "host-agent" ? "automatic" : "manual"),
    ),
  ).toBe(true);
  expect(f.calls).toEqual([]);
});

function coordinatorStatusRequest(): CoordinatorBootstrapRequest {
  const file = { path: "/protected/fixture", sha256: "a".repeat(64) };
  const release = {
    sourceCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64),
    directory: "/protected/release",
    node: file,
    entrypoint: file,
    configuration: file,
    launcher: file,
  };
  const id = randomUUID();
  const at = new Date(0).toISOString();
  return {
    id,
    revision: randomUUID(),
    requestedBy: "host-agent",
    reason: "Protected fixture",
    createdAt: at,
    planSha256: "d".repeat(64),
    status: "approved",
    decisionAt: at,
    automaticSubmission: {
      credentialBinding: "e".repeat(64),
      policyActivatedAt: at,
      submittedAt: at,
    },
    execution: { generation: randomUUID(), stage: "claimed", updatedAt: at },
    plan: {
      version: 1,
      operation: "coordinator-bootstrap",
      installationId: randomUUID(),
      service: "gui/501/local.vorteo.fixture.installation",
      previous: release,
      candidate: release,
      expectedProcess: {
        pid: 123,
        bootId: "fixture",
        startIdentity: "fixture",
        argumentsSha256: "f".repeat(64),
      },
      state: {
        directory: "/protected/state",
        restartJournal: "/protected/state/restarts.json",
        ownerSessions: "/protected/state/sessions.json",
      },
      hostRequestsAfter: null,
    },
  };
}

test("owner restart review reports coordinator recovery without dispatching or losing cancellation", async () => {
  const f = await fixture();
  const retained = coordinatorStatusRequest();
  writeFileSync(
    path.join(f.root, "coordinator-bootstrap.json"),
    JSON.stringify({ version: 1, requests: [retained] }),
    { mode: 0o600 },
  );
  const response = await f.request("/api/installation/restart-requests", "guest-agent-test-token", {
    target: "host",
    reason: "Review after recovery",
  });
  expect(response.status).toBe(201);
  const job = RestartJobSchema.parse(await response.json());
  const route = `/api/installation/owner/restarts/${job.id}/decision`;
  const approval = await f.request(route, "owner-test-password", {
    revision: job.revision,
    decision: "approve",
  });
  expect(approval.status).toBe(409);
  expect((await approval.json()).error).toMatch(
    /^Coordinator recovery must finish before installation work(: coordinator update [a-f0-9]{8} is running)?$/,
  );
  const rejection = await f.request(route, "owner-test-password", {
    revision: job.revision,
    decision: "reject",
  });
  expect(rejection.status).toBe(200);
  await f.drain();
  expect(f.calls).toEqual([]);
});

test("scoped coordinator status reads the retained request without exposing protected plans or requiring Host RPC", async () => {
  const retained = coordinatorStatusRequest();
  let failed = false;
  const ledger: BootstrapReconciliationLedger = {
    list: () => {
      if (failed) throw new Error("PRIVATE JOURNAL DETAIL");
      return [retained, coordinatorStatusRequest()];
    },
    revokeAutomatic: () => {},
    reserveAutomaticReconciliation: () => null,
    finishAutomaticReconciliation: () => {},
  };
  const f = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    ledger,
  );
  const route = `/api/installation/coordinator-requests/${retained.id}`;
  expect((await f.request(route, "owner-test-password")).status).toBe(401);
  const capabilities = await (
    await f.request("/api/installation/capabilities", "host-agent-test-token")
  ).json();
  expect(capabilities.coordinatorMaintenance).toMatchObject({
    available: false,
    automaticAvailable: false,
    ownerApprovalRequired: true,
  });
  expect(capabilities.coordinatorMaintenance.reason).toContain("retained coordinator request");
  for (const token of ["host-agent-test-token", "guest-agent-test-token"]) {
    const response = await f.request(route, token);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({
      id: retained.id,
      revision: retained.revision,
      status: "approved",
      execution: retained.execution,
      automaticStatus: { state: "execution" },
    });
    expect(new URL(receipt.approvalUrl).searchParams.get("bootstrap")).toBe(retained.id);
    expect(receipt).not.toHaveProperty("plan");
    expect(receipt).not.toHaveProperty("automaticSubmission");
    expect(JSON.stringify(receipt)).not.toContain("/protected/");
  }
  expect(
    (
      await f.request(
        `/api/installation/coordinator-requests/${randomUUID()}`,
        "host-agent-test-token",
      )
    ).status,
  ).toBe(404);
  const clientFile = path.join(f.root, "coordinator-client.json");
  writeFileSync(
    clientFile,
    JSON.stringify({
      origin: f.url,
      publicOrigin: "https://review.example.test",
      kind: "host-agent",
      token: "host-agent-test-token",
    }),
  );
  const cli = await promisify(execFile)(process.execPath, [
    path.resolve(import.meta.dirname, "../../../../../scripts/installation-agent.mjs"),
    "--config",
    clientFile,
    "coordinator-status",
    retained.id,
  ]);
  expect(JSON.parse(cli.stdout)).toMatchObject({ id: retained.id, execution: retained.execution });
  expect(new URL(JSON.parse(cli.stdout).approvalUrl).searchParams.get("bootstrap")).toBe(
    retained.id,
  );
  failed = true;
  const unavailable = await f.request(route, "host-agent-test-token");
  expect(unavailable.status).toBe(503);
  expect(JSON.stringify(await unavailable.json())).not.toContain("PRIVATE JOURNAL DETAIL");
  expect(f.calls).toEqual([]);
});

test.each(["manual", "automatic", "explicit", "unsupported", "blocked"] as const)(
  "scoped coordinator CLI preserves exact preparation and capability refusal (%s)",
  async (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "coordinator-cli-"));
    const retained = coordinatorStatusRequest();
    const preparation = { id: retained.id, reason: retained.reason, plan: retained.plan };
    const submitted: unknown[] = [];
    // This HTTP port checks the installed CLI contract without running native maintenance.
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/installation/capabilities") {
        res.end(
          JSON.stringify({
            requireOwnerApproval: true,
            coordinatorMaintenance: {
              available: mode !== "blocked",
              automaticAvailable: mode === "automatic",
              ownerApprovalRequired: mode === "manual",
            },
          }),
        );
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        submitted.push({ method: req.method, path: req.url, body: JSON.parse(body) });
        res.end(
          JSON.stringify({ id: retained.id, revision: retained.revision, status: "pending" }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const config = path.join(root, "client.json");
      const input = path.join(root, "preparation.json");
      writeFileSync(
        config,
        JSON.stringify({
          origin: `http://127.0.0.1:${address.port}`,
          publicOrigin: "https://review.example.test",
          kind: "host-agent",
          token: "fixture-token",
        }),
      );
      writeFileSync(input, JSON.stringify(preparation));
      const run = promisify(execFile)(process.execPath, [
        path.resolve(import.meta.dirname, "../../../../../scripts/installation-agent.mjs"),
        "--config",
        config,
        "request-coordinator",
        "--request-file",
        input,
        ...(mode === "explicit" ? ["--require-owner-approval"] : []),
      ]);
      if (mode === "unsupported" || mode === "blocked") {
        await expect(run).rejects.toThrow("no preparation submitted");
        expect(submitted).toEqual([]);
      } else {
        const result = await run;
        expect(result.stderr).toContain(`Coordinator request: ${retained.id}`);
        expect(submitted).toEqual([
          {
            method: "POST",
            path: "/api/installation/coordinator-requests",
            body: {
              preparation,
              ...(mode === "explicit" ? { requireOwnerApproval: true } : {}),
            },
          },
        ]);
        expect(JSON.parse(result.stdout)).toMatchObject({
          id: retained.id,
          status: "pending",
          approvalUrl: `https://review.example.test/settings/general?installation=1&bootstrap=${retained.id}`,
        });
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("coordinator submission requires scoped authentication before parsing its preparation", async () => {
  const f = await fixture();
  const route = "/api/installation/coordinator-requests";
  expect((await f.request(route, "owner-test-password", {})).status).toBe(401);
  expect((await f.request(route, undefined, {})).status).toBe(401);
  expect((await f.request(route, "host-agent-test-token", {})).status).toBe(400);
  expect((await f.request(route, "guest-agent-test-token", {})).status).toBe(400);
  expect(f.calls).toEqual([]);
});

test("permission changes persist revocation before success and report ledger failures", async () => {
  let stateDirectory = "";
  let failRevocation = false;
  const observed: Array<string | null> = [];
  const coordinatorRequests = {
    list: () => [],
    reserveAutomaticReconciliation: () => null,
    finishAutomaticReconciliation: () => {},
    revokeAutomatic() {
      observed.push(new DaemonAutomation(stateDirectory, false).activation("coordinator") ?? null);
      if (failRevocation) throw new Error("Fixture journal unavailable");
    },
  };
  const f = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    (config) => {
      stateDirectory = config.stateDir;
    },
    coordinatorRequests,
  );
  const route = "/api/installation/owner/maintenance-permissions/change";
  const enabled = await f.request(route, "owner-test-password", {
    expectedRevision: null,
    service: "coordinator",
    enabled: true,
  });
  expect(enabled.status).toBe(200);
  const preference = await enabled.json();
  expect(observed[0]).toBe(preference.services.coordinator);
  observed.length = 0;
  failRevocation = true;
  const disabled = await f.request(route, "owner-test-password", {
    expectedRevision: preference.revision,
    service: "coordinator",
    enabled: false,
  });
  expect(disabled.status).toBe(500);
  expect(await disabled.json()).toEqual({ error: "Installation request failed" });
  expect(observed).toEqual([null]);
  expect(new DaemonAutomation(f.root, false).activation("coordinator")).toBeNull();
  // The existing reconciliation tick retries only revocation, never a launch.
  failRevocation = false;
  await f.drain();
  expect(observed).toEqual([null, null]);
  expect(f.calls).toEqual([]);
});

test("service permissions preserve daemon grants and keep controller permissions separate", async () => {
  const f = await fixture(undefined, undefined, undefined, false, true);
  const query = "/api/installation/owner/maintenance-permissions/query";
  const change = "/api/installation/owner/maintenance-permissions/change";
  for (const token of ["guest-agent-test-token", "host-agent-test-token"])
    expect(
      (
        await f.request(change, token, {
          expectedRevision: null,
          service: "coordinator",
          enabled: true,
        })
      ).status,
    ).toBe(401);
  const initial = await (await f.request(query, "owner-test-password", {})).json();
  expect(initial.services).toMatchObject({ coordinator: null, supervisor: null });
  expect(initial.services.host).toBeTruthy();
  expect(initial.services["container-daemon"]).toBe(initial.services.host);
  const response = await f.request(change, "owner-test-password", {
    expectedRevision: initial.revision,
    service: "coordinator",
    enabled: true,
  });
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved.services.coordinator).toBeTruthy();
  expect(saved.services.supervisor).toBeNull();
  expect(saved.services.host).toBe(initial.services.host);
  expect(saved.services["container-daemon"]).toBe(initial.services["container-daemon"]);
  expect(new DaemonAutomation(f.root, true).read()).toEqual(saved);
  expect(
    (
      await f.request(change, "owner-test-password", {
        expectedRevision: initial.revision,
        service: "supervisor",
        enabled: true,
      })
    ).status,
  ).toBe(409);
  const disabled = await (
    await f.request(change, "owner-test-password", {
      expectedRevision: saved.revision,
      service: "host",
      enabled: false,
    })
  ).json();
  expect(disabled.services.host).toBeNull();
  expect(disabled.services.coordinator).toBe(saved.services.coordinator);
  expect(disabled.services["container-daemon"]).toBe(saved.services["container-daemon"]);
  const legacy = await (
    await f.request("/api/installation/owner/daemon-automation/query", "owner-test-password", {})
  ).json();
  expect(legacy).not.toHaveProperty("services");
});

test("supervisor permission authorizes only its tracked Host operation and revokes before holds", async () => {
  const f = await fixture(undefined, undefined, undefined, false, true);
  const query = "/api/installation/owner/maintenance-permissions/query";
  const change = "/api/installation/owner/maintenance-permissions/change";
  const initial = await (await f.request(query, "owner-test-password", {})).json();
  const saved = await (
    await f.request(change, "owner-test-password", {
      expectedRevision: initial.revision,
      service: "supervisor",
      enabled: true,
    })
  ).json();
  expect(saved.services.host).toBe(initial.services.host);
  expect(saved.services.coordinator).toBeNull();
  const capability = await (
    await f.request("/api/installation/capabilities", "host-agent-test-token")
  ).json();
  expect(capability.supervisorMaintenance).toEqual({
    available: true,
    sha256: "a".repeat(64),
    ownerApprovalRequired: false,
  });
  const readiness = await (
    await f.request("/api/installation/maintenance-status", "host-agent-test-token")
  ).json();
  expect(
    readiness.services.find((item: { service: string }) => item.service === "supervisor"),
  ).toMatchObject({ readiness: "ready" });
  const route = "/api/installation/restart-requests";
  const input = {
    target: "container-daemon",
    reason: "Verified supervisor plan",
    supervisorPlanSha256: "a".repeat(64),
  };
  expect((await f.request(route, "guest-agent-test-token", input)).status).toBe(409);
  const job = await (await f.request(route, "host-agent-test-token", input)).json();
  await f.drain();
  const status = async () =>
    (
      await f.request(
        `${route}/${job.id}?hostAutomaticRestarts=1&supervisorMaintenance=1`,
        "host-agent-test-token",
      )
    ).json();
  await expect.poll(async () => (await status()).status).toBe("approved");
  expect(await status()).toMatchObject({
    automaticApproval: { policyActivatedAt: saved.services.supervisor },
  });
  expect(f.calls).toEqual([]);
  expect(
    (
      await f.request(change, "owner-test-password", {
        expectedRevision: saved.revision,
        service: "supervisor",
        enabled: false,
      })
    ).status,
  ).toBe(200);
  await expect.poll(async () => (await status()).status).toBe("rejected");
  expect(f.calls).not.toContain("hold");
  expect(f.calls).not.toContain("supervisor");
});

test("the scoped Host client can require manual supervisor review", async () => {
  const f = await fixture(undefined, undefined, undefined, false, true);
  const clientFile = path.join(f.root, "host-client.json");
  const reasonFile = path.join(f.root, "reason.txt");
  writeFileSync(
    clientFile,
    JSON.stringify({ origin: f.url, token: "host-agent-test-token", kind: "host-agent" }),
    { mode: 0o600 },
  );
  writeFileSync(reasonFile, "Review supervisor maintenance explicitly");
  const result = await promisify(execFile)(process.execPath, [
    path.resolve(import.meta.dirname, "../../../../../scripts/installation-agent.mjs"),
    "--config",
    clientFile,
    "request-restart",
    "--target",
    "container-daemon",
    "--supervisor-plan",
    "a".repeat(64),
    "--require-owner-approval",
    "--reason-file",
    reasonFile,
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "pending",
    requireOwnerApproval: true,
    supervisorPlanSha256: "a".repeat(64),
  });
  await f.drain();
  expect(f.calls).toEqual([]);
});

function unusedMaintenanceExecutor(): MaintenanceServiceExecutor {
  async function refuse(): Promise<never> {
    throw new Error("This discovery test must not invoke native effects");
  }
  return { inspect: refuse, execute: refuse, observe: refuse };
}

test("Host activation retains the drain across a slow call and blocks discovery until resolved", async () => {
  let resolve!: (result: "idle" | "unresolved") => void;
  const held = new Promise<"idle" | "unresolved">((done) => {
    resolve = done;
  });
  const reconcile = vi.fn(() => held);
  const discover = vi.fn(async () => unusedMaintenanceExecutor());
  const f = await fixture(undefined, undefined, undefined, false, false, undefined, undefined, {
    reconcileInitialHostActivation: reconcile,
    discoverMaintenanceServices: discover,
  });
  const first = f.drain();
  await f.drain();
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(discover).not.toHaveBeenCalled();
  resolve("unresolved");
  await first;
  expect(discover).not.toHaveBeenCalled();
  reconcile.mockResolvedValue("idle");
  await f.drain();
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(f.calls).toEqual([]);
});

test("Host activation refusal prevents discovery and the next drain may reconcile", async () => {
  const reconcile = vi
    .fn()
    .mockRejectedValueOnce(new Error("Retained child still running"))
    .mockResolvedValue("verified");
  const discover = vi.fn(async () => unusedMaintenanceExecutor());
  const f = await fixture(undefined, undefined, undefined, false, false, undefined, undefined, {
    reconcileInitialHostActivation: reconcile,
    discoverMaintenanceServices: discover,
  });
  await f.drain();
  expect(discover).not.toHaveBeenCalled();
  await f.drain();
  expect(discover).toHaveBeenCalledTimes(1);
  expect(f.calls).toEqual([]);
});

test("service discovery does not block reconciliation and accepts one verified construction", async () => {
  let resolve!: (native: MaintenanceServiceExecutor) => void;
  const discovery = new Promise<MaintenanceServiceExecutor>((done) => {
    resolve = done;
  });
  const discover = vi.fn(() => discovery);
  const f = await fixture(undefined, undefined, undefined, false, false, undefined, undefined, {
    discoverMaintenanceServices: discover,
  });
  await Promise.all([f.drain(), f.drain()]);
  expect(discover).toHaveBeenCalledTimes(1);
  const capabilities = async () =>
    (await (await f.request("/api/installation/capabilities", "host-agent-test-token")).json())
      .maintenanceServices;
  expect(await capabilities()).toEqual({ available: false, operations: [] });
  resolve(unusedMaintenanceExecutor());
  await vi.waitFor(async () => {
    expect(await capabilities()).toEqual({ available: true, operations: ["replacement"] });
  });
  await f.drain();
  expect(discover).toHaveBeenCalledTimes(1);
  expect(f.calls).toEqual([]);
});

test("service discovery discards expired construction and retries only after it settles", async () => {
  let resolve!: (native: MaintenanceServiceExecutor) => void;
  const discovery = new Promise<MaintenanceServiceExecutor>((done) => {
    resolve = done;
  });
  const discover = vi
    .fn()
    .mockImplementationOnce(() => discovery)
    .mockResolvedValue(unusedMaintenanceExecutor());
  const f = await fixture(undefined, undefined, undefined, false, false, undefined, undefined, {
    discoverMaintenanceServices: discover,
  });
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(now);
  try {
    await f.drain();
    await vi.advanceTimersByTimeAsync(25_000);
    await f.drain();
    expect(discover).toHaveBeenCalledTimes(1);
    resolve(unusedMaintenanceExecutor());
    await vi.advanceTimersByTimeAsync(0);
    const expired = await f.request("/api/installation/capabilities", "host-agent-test-token");
    expect((await expired.json()).maintenanceServices).toEqual({
      available: false,
      operations: [],
    });
    await f.drain();
    expect(discover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await f.drain();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(Date.now()).toBe(now + 30_000);
  } finally {
    vi.useRealTimers();
  }
  const response = await f.request("/api/installation/capabilities", "host-agent-test-token");
  expect((await response.json()).maintenanceServices).toEqual({
    available: true,
    operations: ["replacement"],
  });
  expect(f.calls).toEqual([]);
});

test("service discovery retries a refused registration without restarting the coordinator", async () => {
  const discover = vi
    .fn()
    .mockRejectedValueOnce(new Error("Enrollment registration pending"))
    .mockResolvedValue(unusedMaintenanceExecutor());
  const f = await fixture(undefined, undefined, undefined, false, false, undefined, undefined, {
    discoverMaintenanceServices: discover,
  });
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(now);
  try {
    await f.drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(discover).toHaveBeenCalledTimes(1);
    const absent = await f.request("/api/installation/capabilities", "host-agent-test-token");
    expect((await absent.json()).maintenanceServices).toEqual({ available: false, operations: [] });
    await vi.advanceTimersByTimeAsync(5000);
    await f.drain();
    expect(discover).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
  const ready = await f.request("/api/installation/capabilities", "host-agent-test-token");
  expect((await ready.json()).maintenanceServices).toEqual({
    available: true,
    operations: ["replacement"],
  });
  expect(f.calls).toEqual([]);
});

function enrollDashboardFixture(config: InstallationConfig) {
  const manifest: InstallationEnrollmentManifest = {
    version: 1,
    operation: "installation-enrollment",
    installationId: config.public.installationId,
    revision: randomUUID(),
    createdAt: new Date().toISOString(),
    targets: [
      {
        target: "maintenance-controller",
        identitySha256: "a".repeat(64),
        operations: ["replacement"],
      },
      { target: "recovery-launcher", identitySha256: "b".repeat(64), operations: ["replacement"] },
      { target: "host", identitySha256: "c".repeat(64), operations: ["restart"] },
    ],
    trustedRepositories: ["https://example.test/repository.git"],
    provisioning: null,
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 5 },
    retryLimit: 3,
    rollback: "previous-compatible-runtime",
    recovery: "after-login",
    steps: [
      {
        id: randomUUID(),
        target: "maintenance-controller",
        operation: "replacement",
        planSha256: "d".repeat(64),
        candidate: { sourceCommit: "e".repeat(40), artifactSha256: "f".repeat(64) },
        previous: null,
        dependsOn: [],
      },
    ],
  };
  enrollInstallation(new FileEnrollmentJournal(config.stateDir), {
    manifest,
    approval: {
      operation: "installation-enrollment",
      requestId: randomUUID(),
      reviewRevision: manifest.revision,
      manifestSha256: enrollmentManifestDigest(manifest),
      approvedAt: new Date().toISOString(),
    },
  });
}

test("native dashboard readiness is owner-only and uses authority read after inspection", async () => {
  const read = vi.fn(async () => {
    const journal = new FileEnrollmentJournal(f.root);
    const state = journal.read();
    if (state.status !== "enrolled") throw new Error("Expected enrolled fixture");
    changeStandingGrant(journal, {
      expectedRevision: state.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
    return [
      {
        target: "maintenance-controller" as const,
        identitySha256: "a".repeat(64),
        readiness: "ready" as const,
        reason: "Native runtime verified",
        observedAt: new Date().toISOString(),
        selectedSource: "e".repeat(40),
      },
    ];
  });
  const f = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    { observeMaintenanceServices: read },
    enrollDashboardFixture,
  );
  const route = "/api/installation/owner/enrollment/query";
  for (const token of [undefined, "host-agent-test-token", "guest-agent-test-token"])
    expect((await f.request(route, token, {})).status).toBe(401);
  expect(read).not.toHaveBeenCalled();
  const result = await f.request(route, "owner-test-password", {});
  expect(result.status).toBe(200);
  const status = InstallationEnrollmentStatusSchema.parse(await result.json());
  expect(status.authority).toBe("revoked");
  expect(
    status.services.find((service) => service.target === "maintenance-controller"),
  ).toMatchObject({
    enabled: false,
    readiness: "ready",
    selectedSource: "e".repeat(40),
  });
  expect(status.services.find((service) => service.target === "recovery-launcher")).toMatchObject({
    readiness: "unknown",
    selectedSource: null,
  });
  read.mockRejectedValueOnce(new Error("Native inspection unavailable"));
  const failed = await f.request(route, "owner-test-password", {});
  expect(failed.status).toBe(200);
  const stale = InstallationEnrollmentStatusSchema.parse(await failed.json());
  expect(
    stale.services.find((service) => service.target === "maintenance-controller"),
  ).toMatchObject({
    readiness: "unknown",
    selectedSource: null,
  });
  expect(f.calls).toEqual([]);
});

async function workerLaunchLookupHttpFixture() {
  let lookup: WorkerLaunchLookup | undefined;
  let activationChecks = 0;
  const f = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    {
      generation: randomUUID(),
      released() {
        activationChecks += 1;
        throw new Error("Read-only lookup reached activation");
      },
    },
    undefined,
    (config) => {
      config.containerSourceUpdates = {
        sourceRepository: config.stateDir,
        toolingDirectory: config.stateDir,
        integrationRef: "refs/heads/main",
        receiptFile: path.join(config.stateDir, "unused-source"),
        docker: "/unused/docker",
        containerId: "d".repeat(64),
        user: "unit",
        node: "/unused/node",
        home: "/unit/state",
        releaseRoot: "/unit/releases",
        currentReleaseLink: "/unit/current",
      };
      const targetIdentitySha256 = retainEnrollmentNativeIdentity(config.stateDir, {
        version: 1,
        installationId: config.public.installationId,
        custodyOwnerUid: process.getuid!(),
        installationRoot: config.stateDir,
        stateDirectory: config.stateDir,
        environment: "container",
        target: "container-daemon",
        containerId: "d".repeat(64),
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
        profileSha256: "a".repeat(64),
        supervisorPid: 123,
        cause: { kind: "startup" as const, registrationGeneration: randomUUID() },
      };
      lookup = {
        installationId: config.public.installationId,
        serverId: "guest-id",
        targetIdentitySha256,
        supervisor,
        hints,
      };
      const id = randomUUID();
      const job = RestartJobSchema.parse({
        id,
        revision: randomUUID(),
        target: "container-daemon",
        requestedBy: "host-agent",
        reason: "maintenance parent",
        status: "running",
        createdAt: "2026-10-17T00:00:00.000Z",
        expiresAt: "9999-12-31T23:59:59.999Z",
        detail: "Private Host executor diagnostics",
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
            manifestSha256: "a".repeat(64),
            profileSha256: hints.profileSha256,
            targetIdentitySha256,
            sourceCommit: "a".repeat(40),
            artifactSha256: "a".repeat(64),
            publicationSha256: "a".repeat(64),
            cause: { ...hints.cause, registrationSha256: "a".repeat(64) },
            supervisor,
          },
        },
      });
      new FileBootstrapRequestJournal(config.stateDir).writeLifecycle([job]);
    },
  );
  if (!lookup) throw new Error("Missing HTTP lookup fixture");
  const route = (value: WorkerLaunchLookup) =>
    `/api/installation/worker-launch-lookup?workerLaunch=1&lookup=${encodeURIComponent(JSON.stringify(value))}`;
  return {
    ...f,
    lookup,
    route,
    activationChecks: () => activationChecks,
    bytes: () => readFileSync(path.join(f.root, "restart-jobs.json"), "utf8"),
  };
}

test("worker launch lookup HTTP is read-only while startup is fenced and omits Host parent diagnostics", async () => {
  const f = await workerLaunchLookupHttpFixture();
  const before = f.bytes();
  const request = vi.spyOn(InstallationRestarts.prototype, "request");
  const activate = vi.spyOn(InstallationRestarts.prototype, "activate");
  const dispatch = vi.spyOn(InstallationRestarts.prototype, "drain");
  const mutate = vi.spyOn(FileBootstrapRequestJournal.prototype, "mutateLifecycle");
  try {
    const response = await f.request(f.route(f.lookup), "guest-agent-test-token");
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(Object.keys(value)).toEqual(["id", "revision", "status", "detail", "workerLaunch"]);
    expect(value.workerLaunch.binding.supervisor).toEqual(f.lookup.supervisor);
    expect(JSON.stringify(value)).not.toContain("Private Host executor diagnostics");
    expect(f.bytes()).toBe(before);
    expect(f.activationChecks()).toBe(0);
    expect(f.calls).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
    activate.mockRestore();
    dispatch.mockRestore();
    mutate.mockRestore();
  }
});

test("worker launch lookup HTTP authenticates configured Dev requester before malformed query or protected reads", async () => {
  const f = await workerLaunchLookupHttpFixture();
  const read = vi.spyOn(FileBootstrapRequestJournal.prototype, "withRecoveryTransaction");
  try {
    const malformed = "/api/installation/worker-launch-lookup?workerLaunch=1&lookup=%7B";
    expect((await f.request(malformed)).status).toBe(401);
    expect((await f.request(malformed, "host-agent-test-token")).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(f.activationChecks()).toBe(0);
    expect((await f.request(malformed, "guest-agent-test-token")).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

test("worker launch lookup HTTP rejects duplicate selectors and refuses another supervisor lifetime or configured server", async () => {
  const f = await workerLaunchLookupHttpFixture();
  const before = f.bytes();
  expect(
    (await f.request(`${f.route(f.lookup)}&workerLaunch=1`, "guest-agent-test-token")).status,
  ).toBe(400);
  expect(
    (
      await f.request(
        f.route({ ...f.lookup, supervisor: { ...f.lookup.supervisor, startTicks: "99999" } }),
        "guest-agent-test-token",
      )
    ).status,
  ).toBe(404);
  expect(
    (await f.request(f.route({ ...f.lookup, serverId: "host-id" }), "guest-agent-test-token"))
      .status,
  ).toBe(403);
  expect(f.bytes()).toBe(before);
  expect(f.activationChecks()).toBe(0);
  expect(f.calls).toEqual([]);
});

test("missing independent Dev readiness disables ordinary capabilities without blocking Host", async () => {
  const f = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    true,
    undefined,
    undefined,
    undefined,
    (config) => {
      config.container.persistentRegistration = {
        receiptFile: path.join(config.stateDir, "not-published.json"),
        sha256: "a".repeat(64),
      };
    },
  );
  const response = await f.request("/api/installation/capabilities", "host-agent-test-token");
  expect(response.status).toBe(200);
  const capabilities = await response.json();
  expect(capabilities.targets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: "host", restart: true }),
      expect.objectContaining({
        target: "container-daemon",
        restart: false,
        hostAutomaticRestarts: false,
        sourceUpdate: expect.objectContaining({ available: false }),
      }),
    ]),
  );
  expect(capabilities.supervisorMaintenance.available).toBe(false);
  expect(capabilities.factoryRuntimeAdoption.available).toBe(false);
  const created = await f.request("/api/installation/restart-requests", "host-agent-test-token", {
    target: "container-daemon",
    reason: "Manual request must not bypass registration readiness",
  });
  expect(created.status).toBe(201);
  const pending = RestartJobSchema.parse(await created.json());
  expect(pending.status).toBe("pending");
  const refused = await f.request(
    `/api/installation/owner/restarts/${pending.id}/decision`,
    "owner-test-password",
    {
      revision: pending.revision,
      decision: "approve",
    },
  );
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: expect.stringContaining("registration") });
  expect(new FileBootstrapRequestJournal(f.root).readLifecycle()).toEqual([pending]);
  expect(f.calls).toEqual([]);
});

test("native recovery origin serves the interface and authenticated controls independently of Dev", async () => {
  const origin = "https://previous.example.test";
  const { url, calls } = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    (config) => {
      config.recoveryOrigin = origin;
    },
  );
  const request = (
    route: string,
    token?: string,
    body?: unknown,
    requestOrigin = origin,
    host = "previous.example.test",
  ) =>
    new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(
        url + route,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Host: host,
            Origin: requestOrigin,
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks).toString(), { status: incoming.statusCode }),
            ),
          );
          incoming.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const page = await request("/");
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain(origin);
  expect(html).toContain("host-id");
  expect(html).toContain("guest-id");
  for (const secret of [
    "owner-test-password",
    "host-daemon-test-password",
    "guest-daemon-test-password",
    "host-agent-test-token",
  ])
    expect(html).not.toContain(secret);
  expect((await request("/api/installation/owner/unlock", undefined, {})).status).toBe(401);
  expect(
    (await request("/api/installation/owner/unlock", "guest-agent-test-token", {})).status,
  ).toBe(401);
  expect(
    (
      await request(
        "/api/installation/owner/unlock",
        "owner-test-password",
        {},
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/api/installation/owner/unlock",
        "owner-test-password",
        {},
        "https://owner.example.test",
      )
    ).status,
  ).toBe(403);
  expect((await request("/api/installation/owner/unlock", "owner-test-password", {})).status).toBe(
    200,
  );
  expect((await request("/", undefined, undefined, origin, "unknown.example.test")).status).toBe(
    403,
  );
  expect(calls).toEqual([]);
});

test("full maintenance delegation requires owner origin and credential and supports exact revocation", async () => {
  const f = await fixture();
  const query = "/api/installation/owner/maintenance-delegation/query";
  const change = "/api/installation/owner/maintenance-delegation/change";
  for (const token of ["guest-agent-test-token", "host-agent-test-token"])
    expect((await f.request(change, token, { expectedRevision: null, enabled: true })).status).toBe(
      401,
    );
  expect(
    (
      await f.request(
        change,
        "owner-test-password",
        { expectedRevision: null, enabled: true },
        "https://foreign.example.test",
      )
    ).status,
  ).toBe(403);
  const initial = await (await f.request(query, "owner-test-password", {})).json();
  expect(initial).toEqual({ available: true, revision: null, enabled: false, activatedAt: null });
  const response = await f.request(change, "owner-test-password", {
    expectedRevision: initial.revision,
    enabled: true,
  });
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved.enabled).toBe(true);
  expect(
    (await f.request(change, "owner-test-password", { expectedRevision: null, enabled: false }))
      .status,
  ).toBe(409);
  const caps = await (
    await f.request("/api/installation/capabilities", "host-agent-test-token")
  ).json();
  expect(caps.maintenanceDelegation).toEqual({ available: true, enabled: true });
  expect(caps.sessionHostJob.ownerApprovalRequired).toBe(false);
  const revoked = await f.request(change, "owner-test-password", {
    expectedRevision: saved.revision,
    enabled: false,
  });
  expect(revoked.status).toBe(200);
  const after = await (
    await f.request("/api/installation/capabilities", "host-agent-test-token")
  ).json();
  expect(after.maintenanceDelegation.enabled).toBe(false);
  expect(after.sessionHostJob.ownerApprovalRequired).toBe(true);
  expect(f.calls).toEqual([]);
});

test("retained broad delegation cannot bypass enrolled maintenance admission", async () => {
  let retained: InstallationConfig | undefined;
  const f = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    (config) => {
      retained = config;
      writeFileSync(
        path.join(config.stateDir, "owner-delegation.json"),
        JSON.stringify({
          version: 1,
          delegatedRequesterPrefixes: [],
          hostUpdateServiceRestart: false,
          maintenanceApprovedAfter: "2026-01-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      enrollDashboardFixture(config);
    },
  );
  if (!retained) throw new Error("Missing fixture config");
  expect(coordinatorAutomaticAuthority(retained)).toBeNull();
  const caps = await (
    await f.request("/api/installation/capabilities", "host-agent-test-token")
  ).json();
  expect(caps.maintenanceDelegation).toEqual({ available: false, enabled: false });
  expect(caps.sessionHostJob.ownerApprovalRequired).toBe(true);
  expect(
    (
      await f.request(
        "/api/installation/owner/maintenance-delegation/change",
        "owner-test-password",
        { expectedRevision: null, enabled: true },
      )
    ).status,
  ).toBe(409);
  expect(f.calls).toEqual([]);
});

test.each(["127.0.0.1", "localhost"])(
  "local installation at %s binds descriptor, authentication and cookies",
  async (hostname) => {
    const f = await fixture();
    const port = new URL(f.url).port;
    const host = `${hostname}:${port}`;
    const origin = `http://${host}`;
    const route = "/api/installation/owner/";
    const request = (
      suffix: string,
      token?: string,
      cookie?: string,
      requestOrigin = origin,
      requestHost = host,
      extra: Record<string, string> = {},
    ) =>
      requestWithHost(f.url + suffix, {
        method: suffix === "/" ? "GET" : "POST",
        headers: {
          Host: requestHost,
          Origin: requestOrigin,
          "Content-Type": "application/json",
          ...extra,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(suffix === "/" ? {} : { body: "{}" }),
        redirect: "manual",
      });
    const page = await request("/");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`"origin":"${origin}"`);
    expect(html).toContain('"endpoint":"127.0.0.1:6771","useTls":false');
    expect(html).toContain('"endpoint":"guest.example.test","useTls":true');
    expect(html).not.toContain("host-daemon-test-password");
    expect((await request(route + "unlock")).status).toBe(401);
    expect((await request(route + "unlock", "host-agent-test-token")).status).toBe(401);
    for (const hostile of [
      "null",
      "https://owner.example.test",
      "http://evil.test",
      `http://${hostname}:1`,
    ]) {
      expect(
        (await request(route + "unlock", "owner-test-password", undefined, hostile)).status,
      ).toBe(403);
    }
    expect((await request("/", undefined, undefined, origin, `${hostname}:1`)).status).toBe(403);
    for (const headers of [
      { Forwarded: `host=${host}` },
      { "X-Forwarded-Host": host },
      { "X-Forwarded-For": "127.0.0.1" },
      { "X-Forwarded-Proto": "http" },
    ]) {
      expect((await request("/", undefined, undefined, origin, host, headers)).status).toBe(403);
    }
    const login = await request(route + "unlock", "owner-test-password");
    expect(login.status).toBe(200);
    const connection = InstallationUnlockSchema.parse(await login.json());
    expect(connection.connections).toEqual([
      {
        kind: "host",
        serverId: "host-id",
        endpoint: "127.0.0.1:6771",
        useTls: false,
        password: "host-daemon-test-password",
      },
      {
        kind: "container",
        serverId: "guest-id",
        endpoint: "guest.example.test",
        useTls: true,
        password: "guest-daemon-test-password",
      },
    ]);
    const setCookie = login.headers.get("set-cookie");
    expect(setCookie).toContain(`vorteo-owner-local-${port}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toMatch(/; Secure|Domain=/);
    if (!setCookie) throw new Error("Missing local cookie");
    const cookie = setCookie.split(";")[0]!;
    expect((await request(route + "session", undefined, cookie)).status).toBe(200);
    expect(await (await request(route + "session", undefined, cookie)).json()).toMatchObject({
      authenticated: true,
    });
    expect((await request(route + "connections", undefined, cookie)).status).toBe(200);
    const otherHost = `${hostname === "localhost" ? "127.0.0.1" : "localhost"}:${port}`;
    expect(
      (await request(route + "connections", undefined, cookie, `http://${otherHost}`, otherHost))
        .status,
    ).toBe(401);
    expect(
      (
        await f.request(
          route + "connections",
          undefined,
          {},
          undefined,
          cookie.replace(`vorteo-owner-local-${port}`, "__Host-vorteo-owner"),
        )
      ).status,
    ).toBe(401);
    const publicLogin = await f.request(route + "unlock", "owner-test-password", {});
    const publicCookie = publicLogin.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (
        await request(
          route + "connections",
          undefined,
          publicCookie.replace("__Host-vorteo-owner", `vorteo-owner-local-${port}`),
        )
      ).status,
    ).toBe(401);
    expect((await request(route + "lock", undefined, cookie)).status).toBe(200);
    expect((await request(route + "connections", undefined, cookie)).status).toBe(401);
    expect(
      (await f.request(route + "connections", undefined, {}, undefined, publicCookie)).status,
    ).toBe(200);
    expect(f.calls).toEqual([]);
  },
);
