import { expect, test } from "vitest";
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
