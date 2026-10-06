import { expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { readInstallationProfileConfig, createInstallationProfileReader } from "./admission.js";

function settings() {
  return MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: { local: { extends: "codex", env: { LOCAL_BINDING: "retained" } } },
    sharedProviderPreferences: {
      version: 1,
      revision: 9,
      legacyProfiles: {},
      providers: {},
      installation: {
        installationId: "00000000-0000-4000-8000-000000000001",
        environment: "host",
        serverId: "host",
        revision: 2,
      },
    },
  });
}

test("profile admission replaces cache values while retaining local account configuration", async () => {
  const cached = settings();
  const saved = cached.sharedProviderPreferences;
  if (!saved) throw new Error("missing preferences");
  const preferences = {
    ...saved,
    revision: 3,
    providers: {
      codex: {
        defaults: { model: "astra" },
        preferredModels: [],
        preferredThinkingOptions: [],
        workflows: [],
        defaultWorkflowId: null,
      },
    },
  };
  const admitted = await readInstallationProfileConfig(cached, { read: async () => preferences });
  expect(admitted.sharedProviderPreferences).toEqual(preferences);
  expect(admitted.providers).toEqual(cached.providers);
  expect(cached.sharedProviderPreferences?.providers).toEqual({});
});

test("coordinator unavailability fails closed and leaves cached configuration untouched", async () => {
  const cached = settings();
  const before = structuredClone(cached);
  await expect(
    readInstallationProfileConfig(cached, {
      read: async () => {
        throw new Error("coordinator offline");
      },
    }),
  ).rejects.toThrow("coordinator offline");
  expect(cached).toEqual(before);
});

test("paired profile launch refuses missing fixed launcher configuration", async () => {
  const cached = settings();
  const binding = cached.sharedProviderPreferences?.installation;
  if (!binding) throw new Error("missing installation binding");
  await expect(createInstallationProfileReader(undefined).read(binding)).rejects.toThrow(
    "VORTEO_INSTALLATION_CLIENT_CONFIG",
  );
});
