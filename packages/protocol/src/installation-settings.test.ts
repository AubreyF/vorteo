import { expect, test } from "vitest";
import {
  InstallationSettingsPatchSchema,
  InstallationSettingsSnapshotSchema,
  InstallationSettingsUpdateSchema,
  effectiveProjectPolicy,
  installationProviderReference,
  isProjectPolicyKey,
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

test("Windows project policies match either separator and any case, and only their own folder", () => {
  const policies = {
    "C:\\Users\\me\\dev\\app": { excludedEnvironments: ["host" as const] },
    "C:\\Users\\me\\dev\\application": { providerIds: ["unrelated"] },
  };
  for (const path of [
    "C:\\Users\\me\\dev\\app",
    "C:\\Users\\me\\dev\\app\\src\\",
    "c:/users/ME/dev/app/src",
  ])
    expect(effectiveProjectPolicy(policies, [path])).toMatchObject({
      excludedEnvironments: ["host"],
      providerIds: [],
    });
  expect(
    effectiveProjectPolicy(policies, ["C:\\Users\\me\\dev\\other"]).excludedEnvironments,
  ).toEqual([]);
  // A POSIX path never matches a Windows key, and the reverse.
  expect(effectiveProjectPolicy(policies, ["/Users/me/dev/app"]).excludedEnvironments).toEqual([]);
  expect(
    effectiveProjectPolicy({ "/Users/me/dev/app": { providerIds: ["a"] } }, [
      "C:\\Users\\me\\dev\\app",
    ]).providerIds,
  ).toEqual([]);
});

test("project policy keys are absolute roots without a trailing separator", () => {
  for (const key of ["/Users/me/dev/app", "C:\\Users\\me\\dev\\app", "C:/Users/me/dev/app", "/"])
    expect(isProjectPolicyKey(key)).toBe(true);
  for (const key of ["relative/app", "/Users/me/dev/app/", "C:\\Users\\me\\app\\", "app", "C:app"])
    expect(isProjectPolicyKey(key)).toBe(false);
});
