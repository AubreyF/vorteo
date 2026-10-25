import { helperReviewFixture } from "./helper-review.fixture";
import type {
  InstallationEnrollmentStatus,
  InstallationRecoveryAccessStatus,
} from "@getpaseo/protocol/installation-enrollment";
import { InstallationRouteUnavailable } from "./client";
import { expect, test, vi } from "vitest";
import { InstallationClient, hasInstallationConnections } from "./client";
import type { HostProfile } from "@/types/host-connection";
import {
  validateExecutionInstallation,
  type InstallationUnlock,
} from "@getpaseo/protocol/execution-installation";
import { maintenanceTaskTarget, installationMaintenancePrompt } from "./maintenance-task";

const installation = validateExecutionInstallation({
  version: 1,
  installationId: "3386c661-7e90-4e01-abf7-e7ca3b9fca00",
  origin: "https://owner.example.test",
  environments: [
    { kind: "container", serverId: "guest-id", endpoint: "guest.example.test", useTls: true },
    { kind: "host", serverId: "host-id", endpoint: "host.example.test", useTls: true },
  ],
});

test("reload recognizes both saved installation connections and rejects partial or changed targets", () => {
  const profiles: Pick<HostProfile, "serverId" | "connections" | "password">[] =
    installation.environments.map((environment) => ({
      serverId: environment.serverId,
      password: "saved-connection-password",
      connections: [
        {
          id: environment.kind,
          type: "directTcp",
          endpoint: `${environment.endpoint}:443`,
          useTls: true,
        },
      ],
    }));
  expect(hasInstallationConnections(installation, profiles)).toBe(true);
  expect(hasInstallationConnections(installation, profiles.slice(0, 1))).toBe(false);
  profiles[1].connections = [
    {
      id: "host",
      type: "directTcp",
      endpoint: "other.example.test:443",
      useTls: true,
    },
  ];
  expect(hasInstallationConnections(installation, profiles)).toBe(false);
  profiles[1].password = undefined;
  profiles[1].connections = [
    { id: "host", type: "directTcp", endpoint: "host.example.test:443", useTls: true },
  ];
  expect(hasInstallationConnections(installation, profiles)).toBe(false);
});

test("unlock registers both verified environments atomically without probing a fallback", async () => {
  const registrations: InstallationUnlock["connections"][] = [];
  const client = new InstallationClient(installation, {
    request: async () => ({
      installationId: installation.installationId,
      connections: installation.environments.map((environment) => ({
        ...environment,
        password: `${environment.kind}-password`,
      })),
    }),
    register: {
      installExecutionEnvironments: async (connections) => {
        registrations.push(connections);
      },
    },
  });
  await client.unlock("owner-password");
  expect(registrations).toHaveLength(1);
  expect(registrations[0]?.map((environment) => environment.kind)).toEqual(["container", "host"]);
});

test("an endpoint or identity change rejects the entire unlock before any credentials are registered", async () => {
  let registered = false;
  const client = new InstallationClient(installation, {
    request: async () => ({
      installationId: installation.installationId,
      connections: installation.environments.map((environment) => ({
        ...environment,
        endpoint: "attacker.example.test",
        password: "secret",
      })),
    }),
    register: {
      installExecutionEnvironments: async () => {
        registered = true;
      },
    },
  });
  await expect(client.unlock("owner-password")).rejects.toThrow("reviewed environment");
  expect(registered).toBe(false);
  await expect(client.listRestarts()).rejects.toThrow("Unlock");
});

test("maintenance drafts target the host even if only the container is online and never silently substitute it", () => {
  expect(maintenanceTaskTarget(installation, ["guest-id", "host-id"])).toBe("host-id");
  expect(() => maintenanceTaskTarget(installation, ["guest-id"])).toThrow("host environment");
  expect(() => maintenanceTaskTarget(null, ["guest-id"])).toThrow("host environment");
  expect(installationMaintenancePrompt("Review upstream")).toContain("wait for owner approval");
});

test("session-capable clients discard the password and restore verified connections", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ sessions: true, passwordFile: "/installation/owner-password" }),
      ),
  );
  try {
    const calls: Array<[string, string]> = [];
    const connections = {
      installationId: installation.installationId,
      connections: installation.environments.map((environment) => ({
        ...environment,
        password: `${environment.kind}-password`,
      })),
    };
    let authenticated = false;
    const client = new InstallationClient(installation, {
      request: async (route, password) => {
        calls.push([route, password]);
        if (route === "session") return { authenticated, expiresAt: null };
        if (route === "unlock") {
          authenticated = true;
          return connections;
        }
        if (route === "connections") return connections;
        if (route === "lock") return { locked: true };
        return [];
      },
      register: { installExecutionEnvironments: async () => {} },
    });
    expect(await client.restoreSession()).toBe(false);
    await client.unlock("recovery-password");
    await client.listRestarts();
    expect(calls.at(-1)).toEqual([
      "restarts/query?sourceUpdates=1&sourceBatches=1&containerSourceUpdates=1&supervisorMaintenance=1&hostAutomaticRestarts=1&factoryRuntimeAdoption=1&engineRestart=1&hostLauncherUpdate=1&delegatedRequests=1",
      "",
    ]);
    expect(await client.restoreSession()).toBe(true);
    expect(calls.at(-1)).toEqual(["connections", ""]);
    await client.lock();
    await expect(client.listRestarts()).rejects.toThrow("Unlock");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("capable installation clients request extended restart details without changing legacy requests", async () => {
  const calls: string[] = [];
  const client = new InstallationClient(
    { ...installation, idleRestarts: true },
    {
      request: async (route) => {
        calls.push(route);
        if (route === "unlock")
          return {
            installationId: installation.installationId,
            connections: installation.environments.map((environment) =>
              Object.assign({}, environment, { password: "test-password" }),
            ),
          };
        return [];
      },
      register: { installExecutionEnvironments: async () => {} },
    },
  );
  await client.unlock("test-owner");
  await client.listRestarts();
  expect(calls).toEqual([
    "unlock",
    "restarts/query?idleRestarts=1&sourceUpdates=1&sourceBatches=1&containerSourceUpdates=1&supervisorMaintenance=1&hostAutomaticRestarts=1&factoryRuntimeAdoption=1&engineRestart=1&hostLauncherUpdate=1&delegatedRequests=1",
  ]);
});

test("helper client preserves exact approval binding and reads old coordinators without requests", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  let available = false;
  let now = 1_000;
  const client = new InstallationClient(installation, {
    now: () => now,
    request: async (path, _password, body) => {
      calls.push({ path, body });
      if (path === "unlock")
        return {
          installationId: installation.installationId,
          connections: installation.environments.map((environment) =>
            Object.assign({}, environment, { password: "fixture" }),
          ),
        };
      if (path === "helpers/query") {
        if (!available) throw new InstallationRouteUnavailable();
        return { jobs: [helperReviewFixture] };
      }
      return helperReviewFixture;
    },
    register: { installExecutionEnvironments: async () => {} },
  });
  await expect(client.listHelpers()).rejects.toThrow("Unlock");
  await client.unlock("fixture-owner");
  expect(await client.listHelpers()).toEqual([]);
  const callsAfterUnavailable = calls.length;
  now += 5_000;
  expect(await client.listHelpers()).toEqual([]);
  expect(calls).toHaveLength(callsAfterUnavailable);
  await client.lock();
  await expect(client.listHelpers()).rejects.toThrow("Unlock");
  await client.unlock("fixture-owner");
  available = true;
  now += 55_000;
  expect(await client.listHelpers()).toEqual([helperReviewFixture]);
  expect(await client.listHelpers()).toEqual([helperReviewFixture]);
  await client.decideHelper(helperReviewFixture, "approve");
  expect(calls.at(-1)).toEqual({
    path: "helpers/decision",
    body: {
      id: helperReviewFixture.id,
      revision: helperReviewFixture.revision,
      planSha256: helperReviewFixture.planSha256,
      operation: "native-helper-install",
      decision: "approve",
    },
  });
  await client.decideHelper(helperReviewFixture, "verify-installed");
  expect(calls.at(-1)).toEqual({
    path: "helpers/verify-installed",
    body: {
      id: helperReviewFixture.id,
      revision: helperReviewFixture.revision,
      planSha256: helperReviewFixture.planSha256,
      operation: "native-helper-verify-installed",
    },
  });
});

test("monitor client fails closed with legacy coordinator, rediscovers and binds exact approval", async () => {
  const { monitorReviewFixture: job } = await import("./preview-monitor-review.fixture");
  let now = 0;
  let available = false;
  let tamper = false;
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = new InstallationClient(installation, {
    now: () => now,
    request: async (path, _password, body) => {
      calls.push({ path, body });
      if (path === "unlock")
        return {
          installationId: installation.installationId,
          connections: installation.environments.map((e) =>
            Object.assign({}, e, { password: "fixture" }),
          ),
        };
      if (path === "monitors/query") {
        if (!available) throw new InstallationRouteUnavailable();
        return { jobs: [job] };
      }
      return tamper ? { ...job, revision: "00000000-0000-4000-8000-000000000005" } : job;
    },
    register: { installExecutionEnvironments: async () => {} },
  });
  await expect(client.listMonitors()).rejects.toThrow("Unlock");
  await client.unlock("owner");
  expect(await client.listMonitors()).toEqual([]);
  const n = calls.length;
  now = 5000;
  expect(await client.listMonitors()).toEqual([]);
  expect(calls).toHaveLength(n);
  available = true;
  now = 60000;
  expect(await client.listMonitors()).toEqual([job]);
  await client.decideMonitor(job, "approve");
  expect(calls.at(-1)).toEqual({
    path: "monitors/decision",
    body: {
      id: job.id,
      revision: job.revision,
      planSha256: job.planSha256,
      operation: job.operation,
      decision: "approve",
    },
  });
  tamper = true;
  await expect(client.decideMonitor(job, "cancel")).rejects.toThrow("changed");
  await client.lock();
  await expect(client.listMonitors()).rejects.toThrow("Unlock");
});

test("daemon automation requires unlocked access and refuses writes without supported query", async () => {
  const calls: string[] = [];
  let supported = false;
  const preference = { revision: null, enabled: false, enabledAfter: null, legacyHostOnly: false };
  const client = new InstallationClient(installation, {
    request: async (resource) => {
      calls.push(resource);
      if (resource === "unlock")
        return {
          installationId: installation.installationId,
          connections: installation.environments.map((environment) => ({
            kind: environment.kind,
            serverId: environment.serverId,
            endpoint: environment.endpoint,
            useTls: environment.useTls,
            password: "fixture-password",
          })),
        };
      if (!supported) throw new InstallationRouteUnavailable("Unavailable");
      return preference;
    },
    register: { installExecutionEnvironments: async () => {} },
  });
  await expect(client.daemonAutomation()).rejects.toThrow("Unlock installation controls first");
  expect(calls).toEqual([]);
  await client.unlock("owner-password");
  expect(await client.daemonAutomation()).toBeNull();
  await expect(client.changeDaemonAutomation(preference, true)).rejects.toThrow("unavailable");
  expect(calls).toEqual(["unlock", "maintenance-permissions/query", "daemon-automation/query"]);
  supported = true;
  expect(await client.daemonAutomation()).toEqual(preference);
  supported = false;
  await expect(client.daemonAutomation()).rejects.toThrow("Unavailable");
});

test("Dev repair capability loss fails closed and preparation sends only the exact request identity", async () => {
  let available = true;
  const sent: Array<{ path: string; body: unknown }> = [];
  const id = "c429363b-8277-4d56-8f46-029b0c05668c";
  const revision = "b752672e-bd0e-4464-8367-41fb0a695eb2";
  const client = new InstallationClient(installation, {
    request: async (path, _password, body) => {
      if (path === "unlock")
        return {
          installationId: installation.installationId,
          connections: installation.environments.map((item) =>
            Object.assign({}, item, { password: "fixture" }),
          ),
        };
      if (!available) throw new InstallationRouteUnavailable("Unavailable");
      sent.push({ path, body });
      return path === "dev-repair/query" ? { available: true, preparingIds: [] } : { id, revision };
    },
    register: { installExecutionEnvironments: async () => {} },
  });
  await client.unlock("fixture");
  await client.devRepairStatus();
  await client.prepareDevRepair({ id, revision } as Parameters<typeof client.prepareDevRepair>[0]);
  expect(sent.at(-1)).toEqual({
    path: "dev-repair/prepare",
    body: { id, revision },
  });
  available = false;
  await expect(client.devRepairStatus()).rejects.toThrow("Unavailable");
  const before = sent.length;
  await expect(
    client.prepareDevRepair({ id, revision } as Parameters<typeof client.prepareDevRepair>[0]),
  ).rejects.toThrow("Update the coordinator");
  expect(sent).toHaveLength(before);
});

test("maintenance status distinguishes an older coordinator from a failed observation", async () => {
  let outcome: "old" | "ready" | "failed" = "old";
  const status = {
    version: 1,
    checkedAt: new Date().toISOString(),
    paths: [],
    preference: { revision: null, enabled: false, enabledAfter: null, legacyHostOnly: true },
  };
  const client = new InstallationClient(installation, {
    request: async (resource) => {
      if (resource === "unlock")
        return {
          installationId: installation.installationId,
          connections: installation.environments.map((environment) => ({
            kind: environment.kind,
            serverId: environment.serverId,
            endpoint: environment.endpoint,
            useTls: environment.useTls,
            password: "fixture",
          })),
        };
      if (outcome === "old") throw new InstallationRouteUnavailable("Update coordinator");
      if (outcome === "failed") throw new Error("Observation failed");
      return status;
    },
    register: { installExecutionEnvironments: async () => {} },
  });
  await expect(client.maintenanceStatus()).rejects.toThrow("Unlock");
  await client.unlock("owner-password");
  expect(await client.maintenanceStatus()).toBeNull();
  outcome = "ready";
  expect(await client.maintenanceStatus()).toEqual(status);
  outcome = "old";
  await expect(client.maintenanceStatus()).rejects.toThrow("Update coordinator");
  outcome = "failed";
  await expect(client.maintenanceStatus()).rejects.toThrow("Observation failed");
});

test("enrollment status binds the installation and distinguishes missing routes from later failures", async () => {
  let outcome: "old" | "ready" | "wrong-installation" = "old";
  const status: InstallationEnrollmentStatus = {
    version: 1,
    installationId: installation.installationId,
    checkedAt: new Date().toISOString(),
    authority: "not-enrolled",
    grantRevision: null,
    activation: "not-enrolled",
    completedSteps: 0,
    totalSteps: 0,
    services: [],
    steps: [],
  };
  const resources: string[] = [];
  const client = new InstallationClient(installation, {
    request: async (resource) => {
      resources.push(resource);
      if (resource === "unlock")
        return {
          installationId: installation.installationId,
          connections: installation.environments.map((environment) => ({
            kind: environment.kind,
            serverId: environment.serverId,
            endpoint: environment.endpoint,
            useTls: environment.useTls,
            password: "fixture",
          })),
        };
      if (outcome === "old") throw new InstallationRouteUnavailable("Route unavailable");
      if (outcome === "wrong-installation")
        return { ...status, installationId: "00000000-0000-4000-8000-000000000099" };
      return status;
    },
    register: { installExecutionEnvironments: async () => {} },
  });
  await expect(client.enrollmentStatus()).rejects.toThrow("Unlock");
  await client.unlock("owner-password");
  expect(await client.enrollmentStatus()).toBeNull();
  outcome = "ready";
  expect(await client.enrollmentStatus()).toEqual(status);
  outcome = "old";
  await expect(client.enrollmentStatus()).rejects.toThrow("Route unavailable");
  outcome = "wrong-installation";
  await expect(client.enrollmentStatus()).rejects.toThrow("another installation");
  expect(
    resources
      .filter((resource) => resource !== "unlock")
      .every((resource) => resource === "enrollment/query"),
  ).toBe(true);
});

test("maintenance queue binds installation identity and cancellation uses the reviewed revision", async () => {
  const job = {
    id: "00000000-0000-4000-8000-000000000001",
    revision: "00000000-0000-4000-8000-000000000002",
    target: "maintenance-controller",
    operation: "replacement",
    reason: "Install reviewed controller",
    createdAt: "2026-10-15T20:00:00.000Z",
    status: "approved",
    detail: "Waiting for cancellation interval",
    cancelable: true,
    dispatchAfter: "2026-10-15T20:00:30.000Z",
    generation: null,
    outcome: null,
    observedAt: null,
  } as const;
  let wrongInstallation = false;
  let failCancellation = false;
  const calls: { path: string; body: unknown }[] = [];
  const client = new InstallationClient(installation, {
    request: async (path, _password, body) => {
      calls.push({ path, body });
      if (path === "unlock")
        return {
          installationId: installation.installationId,
          connections: installation.environments.map((environment) => ({
            kind: environment.kind,
            serverId: environment.serverId,
            endpoint: environment.endpoint,
            useTls: environment.useTls,
            password: "fixture",
          })),
        };
      if (path === "maintenance-services/query")
        return {
          installationId: wrongInstallation
            ? "00000000-0000-4000-8000-000000000099"
            : installation.installationId,
          available: true,
          jobs: [job],
        };
      if (failCancellation) throw new Error("Maintenance changed before cancellation");
      return { ...job, status: "rejected", cancelable: false };
    },
    register: { installExecutionEnvironments: async () => {} },
  });
  await expect(client.maintenanceServices()).rejects.toThrow("Unlock");
  await client.unlock("owner-password");
  expect((await client.maintenanceServices()).jobs).toEqual([job]);
  wrongInstallation = true;
  await expect(client.maintenanceServices()).rejects.toThrow("another installation");
  expect((await client.cancelMaintenanceService(job)).status).toBe("rejected");
  expect(calls.at(-1)).toEqual({
    path: "maintenance-services/cancel",
    body: { id: job.id, revision: job.revision },
  });
  failCancellation = true;
  await expect(client.cancelMaintenanceService(job)).rejects.toThrow("changed before cancellation");
  await expect(
    client.cancelMaintenanceService({ ...job, status: "running", cancelable: false }),
  ).rejects.toThrow("already dispatched");
});

test("recovery bookmark binds the installation and distinguishes missing routes from later failures", async () => {
  let outcome: "old" | "ready" | "wrong-installation" = "old";
  const status: InstallationRecoveryAccessStatus = {
    version: 1,
    installationId: installation.installationId,
    checkedAt: new Date().toISOString(),
    status: "verified",
    url: "https://machine.tail123.ts.net:8443",
    validUntil: new Date(Date.now() + 30_000).toISOString(),
  };
  const resources: string[] = [];
  const client = new InstallationClient(installation, {
    request: async (resource) => {
      resources.push(resource);
      if (resource === "unlock")
        return {
          installationId: installation.installationId,
          connections: installation.environments.map((environment) => ({
            kind: environment.kind,
            serverId: environment.serverId,
            endpoint: environment.endpoint,
            useTls: environment.useTls,
            password: "fixture",
          })),
        };
      if (outcome === "old") throw new InstallationRouteUnavailable("Route unavailable");
      if (outcome === "wrong-installation")
        return { ...status, installationId: "00000000-0000-4000-8000-000000000099" };
      return status;
    },
    register: { installExecutionEnvironments: async () => {} },
  });
  await expect(client.recoveryAccess()).rejects.toThrow("Unlock");
  await client.unlock("owner-password");
  expect(await client.recoveryAccess()).toBeNull();
  outcome = "ready";
  expect(await client.recoveryAccess()).toEqual(status);
  outcome = "old";
  await expect(client.recoveryAccess()).rejects.toThrow("Route unavailable");
  outcome = "wrong-installation";
  await expect(client.recoveryAccess()).rejects.toThrow("another installation");
  expect(
    resources
      .filter((resource) => resource !== "unlock")
      .every((resource) => resource === "recovery-access/query"),
  ).toBe(true);
});

test("session host client hides on old coordinators and binds requests and decisions exactly", async () => {
  const { sessionHostJobFixture: job, sessionHostStatusFixture: status } =
    await import("./session-host-review.fixture");
  const calls: { path: string; body: unknown }[] = [];
  let available = false;
  let later = false;
  let now = 1_000;
  const client = new InstallationClient(installation, {
    now: () => now,
    request: async (path, _password, body) => {
      calls.push({ path, body });
      if (path === "unlock")
        return {
          installationId: installation.installationId,
          connections: installation.environments.map((environment) =>
            Object.assign({}, environment, { password: "fixture" }),
          ),
        };
      if (!available) throw new InstallationRouteUnavailable();
      if (path === "session-host/query") {
        if (!later) return { jobs: [job], status };
        return {
          jobs: [{ ...job, later: 1, plan: { ...job.plan, later: 1 }, host: { pid: 1, later: 1 } }],
          status: { ...status, later: 1, detail: { ...status.detail, later: 1 } },
          restartSupported: true,
          later: 1,
        };
      }
      if (path === "session-host/request") {
        const request = body as { id: string };
        return { ...job, id: request.id };
      }
      return job;
    },
    register: { installExecutionEnvironments: async () => {} },
  });
  await expect(client.sessionHost()).rejects.toThrow("Unlock");
  await client.unlock("fixture-owner");
  // An older coordinator: the card hides, and the route is not probed again for a minute.
  expect(await client.sessionHost()).toBeNull();
  const afterUnavailable = calls.length;
  now += 5_000;
  expect(await client.sessionHost()).toBeNull();
  expect(calls).toHaveLength(afterUnavailable);
  await expect(client.requestSessionHost("session-host-install", "reason")).rejects.toThrow(
    "Update the coordinator",
  );
  expect(calls).toHaveLength(afterUnavailable);

  available = true;
  now += 60_000;
  expect(await client.sessionHost()).toEqual({ jobs: [job], status });
  // The query declares every addition this interface parses, for coordinators that gate them.
  expect(calls.at(-1)).toEqual({
    path: "session-host/query",
    body: { restart: true, indicator: true, upgrade: true },
  });
  // A coordinator that adds fields anywhere in the reply never breaks this interface again.
  later = true;
  const tolerated = await client.sessionHost();
  expect(tolerated?.jobs[0]?.id).toBe(job.id);
  expect(tolerated?.status?.detail?.label).toBe(status.detail?.label);
  later = false;
  const requested = await client.requestSessionHost("session-host-install", "Owner request");
  const sent = calls.at(-1)!;
  expect(sent.path).toBe("session-host/request");
  expect(sent.body).toEqual({
    id: requested.id,
    operation: "session-host-install",
    reason: "Owner request",
  });
  expect(requested.id).toMatch(/^[0-9a-f-]{36}$/);

  await client.decideSessionHost(job, "approve");
  expect(calls.at(-1)).toEqual({
    path: "session-host/decision",
    body: {
      operation: job.operation,
      id: job.id,
      revision: job.revision,
      planSha256: job.planSha256,
      decision: "approve",
    },
  });

  // Once supported, losing the route is a failure rather than a silently hidden card.
  available = false;
  await expect(client.sessionHost()).rejects.toBeInstanceOf(InstallationRouteUnavailable);
});

test("session host decisions refuse a receipt for a different plan", async () => {
  const { sessionHostJobFixture: job } = await import("./session-host-review.fixture");
  const client = new InstallationClient(installation, {
    request: async (path) =>
      path === "unlock"
        ? {
            installationId: installation.installationId,
            connections: installation.environments.map((environment) =>
              Object.assign({}, environment, { password: "fixture" }),
            ),
          }
        : { ...job, planSha256: "c".repeat(64) },
    register: { installExecutionEnvironments: async () => {} },
  });
  await client.unlock("fixture-owner");
  await expect(client.decideSessionHost(job, "approve")).rejects.toThrow("receipt changed");
});

test("session host query keeps jobs when the coordinator could not inspect the job", async () => {
  const { sessionHostJobFixture: job } = await import("./session-host-review.fixture");
  const client = new InstallationClient(installation, {
    request: async (path) =>
      path === "unlock"
        ? {
            installationId: installation.installationId,
            connections: installation.environments.map((environment) =>
              Object.assign({}, environment, { password: "fixture" }),
            ),
          }
        : { jobs: [job], status: null },
    register: { installExecutionEnvironments: async () => {} },
  });
  await client.unlock("fixture-owner");
  expect(await client.sessionHost()).toEqual({ jobs: [job], status: null });
});
