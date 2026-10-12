import { helperReviewFixture } from "./helper-review.fixture";
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
      "restarts/query?sourceUpdates=1&sourceBatches=1&containerSourceUpdates=1&supervisorMaintenance=1&hostAutomaticRestarts=1&factoryRuntimeAdoption=1",
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
    "restarts/query?idleRestarts=1&sourceUpdates=1&sourceBatches=1&containerSourceUpdates=1&supervisorMaintenance=1&hostAutomaticRestarts=1&factoryRuntimeAdoption=1",
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
  expect(calls).toEqual(["unlock", "daemon-automation/query"]);
  supported = true;
  expect(await client.daemonAutomation()).toEqual(preference);
  supported = false;
  await expect(client.daemonAutomation()).rejects.toThrow("Unavailable");
});
