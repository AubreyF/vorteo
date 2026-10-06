import { expect, test } from "vitest";
import type { ProviderOverrides } from "@getpaseo/protocol/provider-config";
import {
  persistInstallationProviders,
  readInstallationProviders,
  mergeInstallationProviders,
  projectInstallationProviders,
} from "./providers.js";
const accountId = "ef227b47-c914-4d5b-bd92-2e50d784407b";
const host: ProviderOverrides = {
  "host-account": {
    extends: "codex",
    installationAccountId: accountId,
    label: "Shared account",
    enabled: true,
    env: { CODEX_HOME: "/private/host/account", TOKEN: "private-host-value" },
    command: ["/host/codex"],
    options: { local: "host" },
    models: [{ id: "model-a", label: "A" }],
  },
};
const dev: ProviderOverrides = {
  "dev-account": {
    ...host["host-account"],
    env: { CODEX_HOME: "/private/dev/account", TOKEN: "private-dev-value" },
    command: ["/dev/codex"],
    options: { local: "dev" },
  },
};
test("verified accounts share one portable definition while credentials and runtime state remain local", () => {
  const observed = {
    host: readInstallationProviders("host", host),
    dev: readInstallationProviders("dev", dev),
  };
  const merged = mergeInstallationProviders(observed);
  expect(merged.needsReview).toBe(false);
  expect(merged.candidates.host).toEqual(merged.candidates.dev);
  expect(merged.candidates.host).toHaveLength(1);
  expect(merged.candidates.host[0].bindings).toEqual({ host: "host-account", dev: "dev-account" });
  const serialized = JSON.stringify(merged);
  for (const value of ["TOKEN", "private-host-value", "CODEX_HOME", "/host/codex", "options"])
    expect(serialized).not.toContain(value);
  const definition = {
    ...merged.candidates.host[0],
    policy: { label: "Renamed globally", enabled: false },
  };
  const projected = projectInstallationProviders([definition], "dev", dev);
  expect(projected["dev-account"]).toMatchObject({
    label: "Renamed globally",
    enabled: false,
    env: dev["dev-account"].env,
    command: ["/dev/codex"],
    options: { local: "dev" },
  });
  expect(projected["dev-account"].models).toBeUndefined();
  expect(dev["dev-account"].label).toBe("Shared account");
});
test("matching labels and local IDs never merge unverified accounts or discard another environment", () => {
  const unverified = { codex: { label: "Codex 1", enabled: true } };
  const merged = mergeInstallationProviders({
    host: readInstallationProviders("host", unverified),
    dev: readInstallationProviders("dev", unverified),
  });
  expect(merged.needsReview).toBe(false);
  expect(merged.candidates.host).toHaveLength(2);
  expect(merged.candidates.host.map((entry) => entry.id)).toEqual([
    "environment/dev/codex",
    "environment/host/codex",
  ]);
  expect(merged.candidates.host).toEqual(merged.candidates.dev);
});
test("Dev defaults preserve a restored Host legacy binding used by existing sessions", () => {
  const restoredHost: ProviderOverrides = {
    codex: { enabled: true, env: { CODEX_HOME: "/host/legacy" } },
    ...host,
  };
  const container: ProviderOverrides = {
    codex: { enabled: false, env: { CODEX_HOME: "/dev/legacy" } },
    ...dev,
  };
  const merged = mergeInstallationProviders({
    host: readInstallationProviders("host", restoredHost),
    dev: readInstallationProviders("dev", container),
  });
  expect(merged.conflicts).toEqual([]);
  const projectedHost = projectInstallationProviders(merged.candidates.dev, "host", restoredHost);
  const projectedDev = projectInstallationProviders(merged.candidates.dev, "dev", container);
  expect(projectedHost.codex).toEqual(restoredHost.codex);
  expect(projectedDev.codex).toEqual(container.codex);
  expect(Object.keys(projectedHost)).toEqual(Object.keys(restoredHost));
  expect(Object.keys(projectedDev)).toEqual(Object.keys(container));
});
test("conflicting account policies retain complete candidates for explicit resolution", () => {
  const differing = structuredClone(dev);
  differing["dev-account"].enabled = false;
  differing["dev-account"].label = "Different local label";
  differing["pi"] = { enabled: true, label: "Pi" };
  const merged = mergeInstallationProviders({
    host: readInstallationProviders("host", host),
    dev: readInstallationProviders("dev", differing),
  });
  expect(merged.conflicts).toEqual([`account/${accountId}`]);
  expect(merged.needsReview).toBe(true);
  for (const candidate of Object.values(merged.candidates)) {
    expect(candidate).toHaveLength(2);
    expect(candidate[0].bindings).toEqual({ host: "host-account", dev: "dev-account" });
  }
  expect(merged.candidates.host[0].policy.label).toBe("Shared account");
  expect(merged.candidates.dev[0].policy.label).toBe("Different local label");
});
test("exclusions only disable the chosen local binding and never create authentication", () => {
  const definitions = mergeInstallationProviders({
    host: readInstallationProviders("host", host),
    dev: readInstallationProviders("dev", dev),
  }).candidates.host;
  const excluded = projectInstallationProviders(definitions, "dev", dev, [definitions[0].id]);
  expect(excluded["dev-account"].enabled).toBe(false);
  expect(excluded["dev-account"].env).toEqual(dev["dev-account"].env);
  expect(projectInstallationProviders(definitions, "host", host)["host-account"].enabled).toBe(
    true,
  );
  expect(projectInstallationProviders(definitions, "unbound", {})).toEqual({});
  expect(() => projectInstallationProviders(definitions, "dev", {})).toThrow(
    "local runtime binding",
  );
  const changed = structuredClone(dev);
  changed["dev-account"].installationAccountId = "7902159c-15b4-49de-b746-0a7bc33424e9";
  expect(() => projectInstallationProviders(definitions, "dev", changed)).toThrow(
    "account binding changed",
  );
});
test("observations cannot assign foreign bindings or conceal duplicate account bindings", () => {
  const entries = readInstallationProviders("host", host);
  expect(() => mergeInstallationProviders({ dev: entries })).toThrow("another environment");
  expect(() =>
    mergeInstallationProviders({
      host: [...entries, { ...entries[0], bindings: { host: "other-account" } }],
    }),
  ).toThrow("multiple provider bindings");
  expect(() => mergeInstallationProviders({ host: [{ ...entries[0], id: "forged" }] })).toThrow(
    "conflicting identity",
  );
});

test("portable replacement retains independent persisted runtime extensions", () => {
  const local = {
    codex: {
      label: "Before",
      models: [{ id: "old", label: "Old" }],
      env: { PRIVATE: "original" },
      runtimeExtension: { retained: true },
    },
  };
  const definition = readInstallationProviders("host", local)[0];
  definition.policy = { label: "After" };
  const projected = projectInstallationProviders([definition], "host", local);
  expect(projected.codex).toHaveProperty("runtimeExtension", { retained: true });
  const persisted = { codex: { ...local.codex, env: { PRIVATE: "independent edit" } } };
  const next = persistInstallationProviders(persisted, projected);
  expect(next.codex).toMatchObject({
    label: "After",
    env: { PRIVATE: "independent edit" },
    runtimeExtension: { retained: true },
  });
  expect(next.codex.models).toBeUndefined();
});

test("launch admission rejects excluded, removed, rebound and pending providers before local projection catches up", async () => {
  const { assertInstallationProviderLaunch } = await import("./provider-admission.js");
  const { MutableDaemonConfigSchema } = await import("@getpaseo/protocol/messages");
  const { readInstallationSettings } = await import("./projection.js");
  const config = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: host,
  });
  const definitions = readInstallationProviders("host", config.providers);
  const admission = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 2,
    installationInstructions: "",
    settings: { ...readInstallationSettings(config), providerDefinitions: definitions },
  };
  expect(() => assertInstallationProviderLaunch(config, "host-account", admission)).not.toThrow();
  admission.settings.resourceExclusions.host = {
    terminalProfileIds: [],
    metadataProviderIds: [],
    providerIds: [definitions[0].id],
  };
  expect(() => assertInstallationProviderLaunch(config, "host-account", admission)).toThrow(
    "excluded",
  );
  admission.settings.resourceExclusions = {};
  definitions[0].policy.enabled = false;
  expect(() => assertInstallationProviderLaunch(config, "host-account", admission)).toThrow(
    "disabled",
  );
  definitions[0].policy.enabled = true;
  delete definitions[0].policy.models;
  expect(() => assertInstallationProviderLaunch(config, "host-account", admission)).toThrow(
    "still being applied",
  );
  delete config.providers["host-account"].models;
  expect(() => assertInstallationProviderLaunch(config, "host-account", admission)).not.toThrow();
  config.providers["host-account"].installationAccountId = "7902159c-15b4-49de-b746-0a7bc33424e9";
  expect(() => assertInstallationProviderLaunch(config, "host-account", admission)).toThrow(
    "account binding changed",
  );
  admission.settings.providerDefinitions = [];
  expect(() => assertInstallationProviderLaunch(config, "host-account", admission)).toThrow(
    "unique shared catalog binding",
  );
});

test("local removal requires its own environment exclusion and retains missing or removed bindings as unavailable", async () => {
  const { assertInstallationProviderRemoval } = await import("./provider-admission.js");
  const { MutableDaemonConfigSchema } = await import("@getpaseo/protocol/messages");
  const { readInstallationSettings } = await import("./projection.js");
  const config = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: host,
  });
  const definitions = readInstallationProviders("host", host);
  const admission = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 2,
    installationInstructions: "",
    settings: { ...readInstallationSettings(config), providerDefinitions: definitions },
  };
  expect(() => assertInstallationProviderRemoval("host-account", admission)).toThrow(
    "Exclude this provider",
  );
  admission.settings.resourceExclusions.dev = {
    terminalProfileIds: [],
    metadataProviderIds: [],
    providerIds: [definitions[0].id],
  };
  expect(() => assertInstallationProviderRemoval("host-account", admission)).toThrow(
    "Exclude this provider",
  );
  admission.settings.resourceExclusions.host = admission.settings.resourceExclusions.dev;
  expect(() => assertInstallationProviderRemoval("host-account", admission)).not.toThrow();
  expect(() => assertInstallationProviderRemoval("unbound-local-runtime", admission)).not.toThrow();
  expect(projectInstallationProviders(definitions, "host", {}, [definitions[0].id])).toEqual({});
  const removed = { "host-account": { ...host["host-account"], removed: true } };
  expect(projectInstallationProviders(definitions, "host", removed, [definitions[0].id])).toEqual({
    "host-account": { ...removed["host-account"], enabled: false },
  });
  expect(() => projectInstallationProviders(definitions, "host", removed)).toThrow(
    "matching local runtime binding",
  );
});

test("restoration retains account identity and stays excluded until portable policy catches up", async () => {
  const { assertInstallationProviderProjection, assertInstallationProviderLaunch } =
    await import("./provider-admission.js");
  const { MutableDaemonConfigSchema } = await import("@getpaseo/protocol/messages");
  const { readInstallationSettings } = await import("./projection.js");
  const installation = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  const config = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: host,
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation,
    },
  });
  const definitions = readInstallationProviders("host", host);
  definitions[0].policy.label = "Renamed while removed";
  config.providers["host-account"].removed = true;
  config.providers["host-account"].enabled = false;
  const admission = {
    ...installation,
    revision: 2,
    installationInstructions: "",
    settings: {
      ...readInstallationSettings(config),
      providerDefinitions: definitions,
      resourceExclusions: {
        host: { terminalProfileIds: [], metadataProviderIds: [], providerIds: [definitions[0].id] },
      },
    },
  };
  const patch = { providers: { "host-account": { removed: false, enabled: false } } };
  expect(() => assertInstallationProviderProjection(config, patch, admission)).not.toThrow();
  expect(() =>
    assertInstallationProviderProjection(
      config,
      {
        providers: { "host-account": { ...patch.providers["host-account"], label: "Independent" } },
      },
      admission,
    ),
  ).toThrow("installation coordinator");
  config.providers["host-account"].removed = false;
  expect(() => assertInstallationProviderLaunch(config, "host-account", admission)).toThrow(
    "excluded",
  );
  config.providers["host-account"].removed = true;
  config.providers["host-account"].installationAccountId = "7902159c-15b4-49de-b746-0a7bc33424e9";
  expect(() => assertInstallationProviderProjection(config, patch, admission)).toThrow(
    "account binding changed",
  );
});

test("plugin enrollment requires an approved running source and rejects local account shadows", async () => {
  const { enrollInstallationPluginProviders } = await import("./providers.js");
  const { InstallationSettingsSchema } = await import("@getpaseo/protocol/installation-settings");
  const { MutableDaemonConfigSchema } = await import("@getpaseo/protocol/messages");
  const { readInstallationSettings } = await import("./projection.js");
  const settings = InstallationSettingsSchema.parse({
    ...readInstallationSettings(
      MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
    ),
    providerDefinitions: [],
    pluginsEnabled: true,
    plugins: [{ id: "approved", enabled: true, source: { kind: "directory" } }],
  });
  const plugin = {
    id: "approved",
    enabled: true,
    status: "running" as const,
    path: "/private/plugin",
    installation: { identity: { kind: "directory" as const, path: "/private/plugin" } },
    providers: [{ id: "plugin-runtime", label: "Runtime" }],
  };
  const input = {
    settings,
    serverId: "host",
    plugins: [plugin],
    providers: { "plugin-runtime": {} },
  };
  expect(enrollInstallationPluginProviders(input)).toHaveLength(1);
  expect(
    enrollInstallationPluginProviders({ ...input, plugins: [{ ...plugin, id: "unapproved" }] }),
  ).toEqual([]);
  expect(
    enrollInstallationPluginProviders({ ...input, plugins: [{ ...plugin, status: "disabled" }] }),
  ).toEqual([]);
  expect(
    enrollInstallationPluginProviders({
      ...input,
      plugins: [{ ...plugin, installation: undefined }],
    }),
  ).toEqual([]);
  expect(() =>
    enrollInstallationPluginProviders({
      ...input,
      providers: { "plugin-runtime": { extends: "codex", label: "Different account" } },
    }),
  ).toThrow("conflicting local account");
  expect(() =>
    enrollInstallationPluginProviders({
      ...input,
      providers: { "plugin-runtime": { installationAccountId: accountId } },
    }),
  ).toThrow("conflicting local account");
  settings.resourceExclusions.host = {
    terminalProfileIds: [],
    metadataProviderIds: [],
    pluginIds: ["approved"],
  };
  expect(enrollInstallationPluginProviders(input)).toEqual([]);
});
