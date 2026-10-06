import { describe, expect, it } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { InstallationSettingsSchema } from "@getpaseo/protocol/installation-settings";
import {
  sharedCatalogProviderEnrollment,
  sharedProviderSettingsPatch,
  sharedSettingsPatch,
  withSharedSettings,
} from "./settings-policy";

describe("installation settings ownership", () => {
  it("saves the shared account identity and displays its environment-local choice", () => {
    const accountId = "71fca551-79a4-4af9-b9e6-9ec7222f9e1d";
    const local = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      providers: {
        "local-second": { extends: "codex", label: "Second", installationAccountId: accountId },
      },
    });
    const patch = sharedSettingsPatch(
      {
        metadataGeneration: { providers: [{ provider: "local-second", model: "chosen" }] },
      },
      local,
    );
    expect(patch).toEqual({
      metadataGeneration: {
        providers: [{ provider: `installation-account/${accountId}`, model: "chosen" }],
      },
    });
    const settings = InstallationSettingsSchema.parse({
      mcp: local.mcp,
      appendSystemPrompt: "",
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      pluginsEnabled: false,
      terminalProfiles: [],
      resourceExclusions: {},
      ...patch,
    });
    expect(withSharedSettings(local, settings).metadataGeneration.providers).toEqual([
      { provider: "local-second", model: "chosen" },
    ]);
    expect(settings.metadataGeneration.providers[0].provider).toBe(
      `installation-account/${accountId}`,
    );
  });
  it("can clear metadata selection before environment bindings load", () => {
    expect(sharedSettingsPatch({ metadataGeneration: { providers: [] } })).toEqual({
      metadataGeneration: { providers: [] },
    });
    expect(() =>
      sharedSettingsPatch({ metadataGeneration: { providers: [{ provider: "local-account" }] } }),
    ).toThrow("Load the environment account bindings");
  });

  it("routes shared policy to the installation and keeps credentials local", () => {
    expect(sharedSettingsPatch({ appendSystemPrompt: "Shared instructions" })).toEqual({
      appendSystemPrompt: "Shared instructions",
    });
    expect(sharedSettingsPatch({ browserTools: { enabled: true } })).toEqual({
      browserTools: { enabled: true },
    });
    expect(sharedSettingsPatch({ providers: {} })).toBeNull();
    expect(() => sharedSettingsPatch({ appendSystemPrompt: "Shared", providers: {} })).toThrow(
      "separately",
    );
  });

  it("rejects unknown nested fields instead of transmitting local values", () => {
    expect(() =>
      sharedSettingsPatch({
        terminalProfiles: [
          { id: "shell", name: "Shell", command: "zsh", env: { TOKEN: "local-only" } },
        ],
      }),
    ).toThrow();
  });

  it("reads canonical policy without replacing local provider or browser configuration", () => {
    const local = MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } });
    const settings = InstallationSettingsSchema.parse({
      mcp: { injectIntoAgents: true },
      appendSystemPrompt: "Shared instructions",
      autoArchiveAfterMerge: true,
      enableTerminalAgentHooks: true,
      metadataGeneration: { providers: [] },
      pluginsEnabled: true,
      terminalProfiles: [],
      resourceExclusions: {},
    });
    const effective = withSharedSettings(local, settings);
    expect(effective.appendSystemPrompt).toBe("Shared instructions");
    expect(effective.providers).toBe(local.providers);
    expect(effective.browserTools).toBe(local.browserTools);
    expect(local.appendSystemPrompt).not.toBe("Shared instructions");
    local.browserTools = { enabled: false, privateBinding: "local-only" };
    settings.browserTools = { enabled: true };
    settings.resourceExclusions.host = {
      terminalProfileIds: [],
      metadataProviderIds: [],
      browserTools: true,
    };
    expect(withSharedSettings(local, settings, "host").browserTools).toEqual({
      enabled: true,
      privateBinding: "local-only",
    });
    expect(local.browserTools.enabled).toBe(false);
  });
});

it("provider model and label editors share canonical policy while preserving local runtime configuration", () => {
  const settings = InstallationSettingsSchema.parse({
    mcp: { injectIntoAgents: false },
    appendSystemPrompt: "",
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    pluginsEnabled: false,
    terminalProfiles: [],
    metadataGeneration: { providers: [] },
    resourceExclusions: {},
    providerDefinitions: [
      {
        id: "shared",
        providerType: "codex",
        bindings: { host: "host-account", dev: "dev-account" },
        policy: { label: "Shared", additionalModels: [{ id: "old", label: "Old" }], enabled: true },
      },
    ],
  });
  const patch = sharedProviderSettingsPatch(
    { providers: { "host-account": { additionalModels: [], label: "Renamed" } } },
    { settings, serverId: "host" },
  );
  expect(patch?.providerDefinitions[0].policy).toEqual({
    label: "Renamed",
    additionalModels: [],
    enabled: true,
  });
  const local = MutableDaemonConfigSchema.parse({
    mcp: settings.mcp,
    providers: {
      "dev-account": {
        extends: "codex",
        label: "Stale",
        command: ["private-cli"],
        env: { PRIVATE: "retained" },
        models: [{ id: "obsolete", label: "Obsolete" }],
      },
    },
  });
  const view = withSharedSettings(local, { ...settings, ...patch }, "dev");
  expect(view.providers["dev-account"]).toEqual({
    extends: "codex",
    label: "Renamed",
    additionalModels: [],
    enabled: true,
    command: ["private-cli"],
    env: { PRIVATE: "retained" },
  });
  expect(local.providers["dev-account"].label).toBe("Stale");
  expect(settings.providerDefinitions?.[0].policy.label).toBe("Shared");
  expect(
    sharedProviderSettingsPatch(
      { providers: { "host-account": { env: { PRIVATE: "local" } } } },
      { settings, serverId: "host" },
    ),
  ).toBeNull();
  expect(() =>
    sharedProviderSettingsPatch(
      { providers: { "host-account": { label: "Shared", env: { PRIVATE: "local" } } } },
      { settings, serverId: "host" },
    ),
  ).toThrow("separately");
  expect(() =>
    sharedProviderSettingsPatch(
      { providers: { unknown: { enabled: true } } },
      { settings, serverId: "host" },
    ),
  ).toThrow("shared provider catalog");
});

describe("shared catalog runtime enrollment", () => {
  function settings() {
    return InstallationSettingsSchema.parse({
      mcp: { injectIntoAgents: false },
      appendSystemPrompt: "",
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      pluginsEnabled: false,
      terminalProfiles: [],
      metadataGeneration: { providers: [] },
      resourceExclusions: {},
      providerDefinitions: [],
    });
  }
  const runtime = {
    extends: "acp",
    label: "Catalog provider",
    command: ["local-cli"],
    env: { PRIVATE_TOKEN: "private" },
  };

  it("keeps runtime secrets local and reuses the shared catalog across environments and retries", () => {
    const initial = settings();
    const host = sharedCatalogProviderEnrollment("catalog-provider", runtime, {
      settings: initial,
      serverId: "host",
    });
    expect(host.settings?.providerDefinitions).toEqual([
      {
        id: "catalog/acp/catalog-provider",
        providerType: "catalog-provider",
        bindings: { host: "catalog-provider" },
        policy: { label: "Catalog provider" },
      },
    ]);
    expect(host.patch.providers["catalog-provider"]).toEqual(runtime);
    expect(JSON.stringify(host.settings)).not.toContain("PRIVATE_TOKEN");
    const saved = InstallationSettingsSchema.parse({ ...initial, ...host.settings });
    saved.providerDefinitions![0].policy = {
      label: "Owner name",
      enabled: false,
      additionalModels: [{ id: "custom", label: "Custom" }],
    };
    const dev = sharedCatalogProviderEnrollment("catalog-provider", runtime, {
      settings: saved,
      serverId: "dev",
    });
    expect(dev.settings?.providerDefinitions).toHaveLength(1);
    expect(dev.settings?.providerDefinitions[0].bindings).toEqual({
      host: "catalog-provider",
      dev: "catalog-provider",
    });
    expect(dev.patch.providers["catalog-provider"]).toEqual({
      extends: "acp",
      command: ["local-cli"],
      env: { PRIVATE_TOKEN: "private" },
      ...saved.providerDefinitions![0].policy,
    });
    const retried = sharedCatalogProviderEnrollment("catalog-provider", runtime, {
      settings: InstallationSettingsSchema.parse({ ...saved, ...dev.settings }),
      serverId: "dev",
    });
    expect(retried.settings).toBeNull();
    expect(retried.patch).toEqual(dev.patch);
  });

  it("honors exclusions and rejects mismatched account or runtime identities", () => {
    const initial = settings();
    initial.providerDefinitions = [
      {
        id: "catalog/acp/catalog-provider",
        providerType: "catalog-provider",
        bindings: { host: "catalog-provider" },
        policy: { label: "Shared", enabled: true },
      },
    ];
    initial.resourceExclusions.dev = {
      providerIds: ["catalog/acp/catalog-provider"],
      terminalProfileIds: [],
      metadataProviderIds: [],
    };
    const dev = sharedCatalogProviderEnrollment("catalog-provider", runtime, {
      settings: initial,
      serverId: "dev",
    });
    expect(dev.settings?.providerDefinitions[0].policy.enabled).toBe(true);
    expect(dev.patch.providers["catalog-provider"].enabled).toBe(false);
    initial.providerDefinitions[0].providerType = "codex";
    expect(() =>
      sharedCatalogProviderEnrollment("catalog-provider", runtime, {
        settings: initial,
        serverId: "host",
      }),
    ).toThrow("different shared provider");
    expect(() =>
      sharedCatalogProviderEnrollment(
        "catalog-provider",
        { ...runtime, installationAccountId: "71fca551-79a4-4af9-b9e6-9ec7222f9e1d" },
        { settings: initial, serverId: "host" },
      ),
    ).toThrow("without an account identity");
  });
});
