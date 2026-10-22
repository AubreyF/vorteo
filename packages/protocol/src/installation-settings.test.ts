import { expect, test } from "vitest";
import {
  InstallationSettingsPatchSchema,
  InstallationSettingsSnapshotSchema,
  InstallationSettingsUpdateSchema,
  effectiveProjectPolicy,
  installationProviderReference,
  localInstallationProvider,
} from "./installation-settings.js";

test("account references require one explicit binding and never match labels", () => {
  const installationAccountId = "71fca551-79a4-4af9-b9e6-9ec7222f9e1d";
  const reference = `installation-account/${installationAccountId}`;
  expect(installationProviderReference("second", { second: { installationAccountId } })).toBe(
    reference,
  );
  expect(localInstallationProvider(reference, { first: { label: "Second" } })).toBeNull();
  expect(
    localInstallationProvider(reference, { first: { installationAccountId, enabled: false } }),
  ).toBeNull();
  expect(
    localInstallationProvider(reference, {
      first: { installationAccountId },
      second: { installationAccountId },
    }),
  ).toBeNull();
  expect(
    localInstallationProvider(reference, {
      first: { installationAccountId, removed: true },
      second: { installationAccountId },
    }),
  ).toBe("second");
  expect(localInstallationProvider("mock", {})).toBe("mock");
});

test("shared patches allow only explicit policy and resource fields", () => {
  expect(
    InstallationSettingsUpdateSchema.parse({
      expectedRevision: 4,
      settings: {
        mcp: { injectIntoAgents: true },
        pluginsEnabled: false,
        browserTools: { enabled: true },
      },
    }),
  ).toEqual({
    expectedRevision: 4,
    settings: {
      mcp: { injectIntoAgents: true },
      pluginsEnabled: false,
      browserTools: { enabled: true },
    },
  });
  for (const settings of [
    { browserTools: { enabled: true, token: "fixture-secret" } },
    { installationResourceBindings: { terminalProfiles: [], metadataProviders: [] } },
    { providers: { account: { env: { API_KEY: "fixture-secret" } } } },
    { mcp: { injectIntoAgents: true, enabled: true } },
    {
      terminalProfiles: [
        { id: "shell", name: "Shell", command: "sh", env: { TOKEN: "fixture-secret" } },
      ],
    },
    { metadataGeneration: { providers: [{ provider: "account", apiKey: "fixture-secret" }] } },
  ])
    expect(InstallationSettingsPatchSchema.safeParse(settings).success).toBe(false);
  expect(
    InstallationSettingsUpdateSchema.safeParse({ expectedRevision: -1, settings: {} }).success,
  ).toBe(false);
});

test("snapshots distinguish waiting, migration conflicts, and resolved policy", () => {
  expect(
    InstallationSettingsSnapshotSchema.safeParse({
      version: 1,
      revision: 0,
      settings: null,
      sources: {},
    }).success,
  ).toBe(true);
  expect(
    InstallationSettingsSnapshotSchema.safeParse({
      version: 1,
      revision: 1,
      settings: null,
      sources: {},
    }).success,
  ).toBe(false);
  expect(
    InstallationSettingsSnapshotSchema.safeParse({
      version: 1,
      revision: 0,
      settings: null,
      sources: {},
      browserTools: {},
    }).success,
  ).toBe(false);
});

test("project policies cover their folder and everything inside it, and combine", () => {
  const policies = {
    "/Users/me/dev/app": { excludedEnvironments: ["container" as const], providerIds: ["a"] },
    "/Users/me/dev/app/packages/web": { providerIds: ["b"], skillIdentities: ["s"] },
    "/Users/me/dev/application": { profileIds: ["unrelated"] },
  };
  expect(effectiveProjectPolicy(policies, ["/Users/me/dev/app/packages/web/src"])).toEqual({
    excludedEnvironments: ["container"],
    providerIds: ["a", "b"],
    profileIds: [],
    skillIdentities: ["s"],
  });
  expect(effectiveProjectPolicy(policies, ["/Users/me/dev/app/"]).providerIds).toEqual(["a"]);
  expect(effectiveProjectPolicy(policies, ["/Users/me/dev/other"]).providerIds).toEqual([]);
});
