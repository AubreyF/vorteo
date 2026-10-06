import { readInstallationProviders } from "./execution-installation/settings/providers.js";
import {
  readInstallationSettings,
  projectInstallationSettings,
} from "./execution-installation/settings/projection.js";
import type { InstallationSettingsAdmission } from "./execution-installation/settings/admission.js";
import { installationResourceRevision } from "./execution-installation/settings/resource-bindings.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DaemonConfigStore, applyMutableProviderConfigToOverrides } from "./daemon-config-store.js";
import { loadPersistedConfig } from "./persisted-config.js";
import type { PersistedConfig } from "./persisted-config.js";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

function reloadableConfig(
  persisted: PersistedConfig,
  options: { relayEnabledFallback?: boolean } = {},
): MutableDaemonConfig {
  const daemon = persisted.daemon ?? {};
  const relay = daemon.relay ?? {};
  const git = daemon.git ?? {};
  const agents = persisted.agents ?? {};
  return {
    relay: {
      enabled: relay.enabled ?? options.relayEnabledFallback ?? true,
    },
    mcp: { enabled: true, injectIntoAgents: false },
    browserTools: { enabled: daemon.browserTools?.enabled ?? false },
    providers: (agents.providers ?? {}) as MutableDaemonConfig["providers"],
    metadataGeneration: { providers: agents.metadataGeneration?.providers ?? [] },
    autoArchiveAfterMerge: daemon.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: daemon.enableTerminalAgentHooks ?? false,
    appendSystemPrompt: daemon.appendSystemPrompt ?? "",
    terminalProfiles: daemon.terminalProfiles,
    agentProfiles: daemon.agentProfiles,
    cors: { allowedOrigins: [] },
    trustedProxies: ["loopback"],
    git: {
      maxProcessesPerSecond: git.maxProcessesPerSecond ?? 64,
      maxProcessConcurrency: git.maxProcessConcurrency ?? 8,
    },
    app: { baseUrl: "https://app.paseo.sh" },
    pluginsEnabled: persisted.pluginsEnabled ?? false,
    plugins: persisted.plugins ?? {},
  };
}

describe("applyMutableProviderConfigToOverrides", () => {
  test("merges mutable provider fields onto provider overrides", () => {
    expect(
      applyMutableProviderConfigToOverrides(
        {
          gemini: {
            extends: "acp",
            label: "Gemini",
            command: ["gemini", "--acp"],
          },
        },
        {
          gemini: {
            enabled: false,
            description: "Gemini ACP",
            env: { GEMINI_AUTO_UPDATE: "0" },
          },
          claude: {
            additionalModels: [
              {
                id: "claude-custom",
                label: "claude-custom",
              },
            ],
          },
        },
      ),
    ).toEqual({
      gemini: {
        extends: "acp",
        label: "Gemini",
        description: "Gemini ACP",
        command: ["gemini", "--acp"],
        env: { GEMINI_AUTO_UPDATE: "0" },
        enabled: false,
      },
      claude: {
        additionalModels: [
          {
            id: "claude-custom",
            label: "claude-custom",
          },
        ],
      },
    });
  });
});

describe("DaemonConfigStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider authority replaces portable fields durably without replacing local credentials", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-provider-authority-"));
    tempDirs.push(home);
    const binding = {
      installationId: "4c07b582-7d41-4be4-9725-36f975708983",
      serverId: "host",
      environment: "host" as const,
      revision: 1,
    };
    const initial = {
      ...reloadableConfig({}),
      providers: {
        codex: {
          label: "Before",
          models: [{ id: "old", label: "Old" }],
          env: { PRIVATE: "retained" },
          command: ["/local/codex"],
        },
      },
    };
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ agents: { providers: initial.providers } }),
    );
    const definitions = readInstallationProviders("host", initial.providers);
    definitions[0].policy = { label: "Shared name", enabled: true };
    const admission: InstallationSettingsAdmission = {
      ...binding,
      installationInstructions: "",
      settings: { ...readInstallationSettings(initial), providerDefinitions: definitions },
    };
    let read = async () => admission;
    const store = new DaemonConfigStore(
      home,
      {
        ...initial,
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: binding,
        },
      },
      undefined,
      {
        installationSettingsReader: { read: () => read() },
        reloadSource: {
          resolve: (persisted) => ({
            mutable: reloadableConfig(persisted),
            overrideControlledPaths: [],
          }),
        },
      },
    );
    expect(() => store.patch({ providers: { codex: { label: "Independent" } } })).toThrow(
      "installation coordinator",
    );
    await expect(
      store.patchFromClient({ providers: { codex: { label: "Independent" } } }),
    ).rejects.toThrow("installation coordinator");
    store.patch({ providers: { codex: { env: { PRIVATE: "retained", LOCAL: "new" } } } });
    const policy = { definitions, excludedIds: [] };
    await store.patchFromClient({ installationProviderPolicy: policy });
    expect(store.get().providers.codex).toMatchObject({
      label: "Shared name",
      env: { PRIVATE: "retained", LOCAL: "new" },
      command: ["/local/codex"],
    });
    expect(store.get().providers.codex.models).toBeUndefined();
    const persisted = loadPersistedConfig(home);
    expect(persisted.agents?.providers?.codex).toMatchObject({
      label: "Shared name",
      env: { PRIVATE: "retained", LOCAL: "new" },
      command: ["/local/codex"],
    });
    expect(persisted.agents?.providers?.codex.models).toBeUndefined();
    const changed = structuredClone(persisted);
    changed.agents!.providers!.codex.label = "Disk drift";
    writeFileSync(path.join(home, "config.json"), JSON.stringify(changed));
    expect(() => store.reload()).toThrow("installation coordinator");
    expect(store.get().providers.codex.label).toBe("Shared name");
    writeFileSync(path.join(home, "config.json"), JSON.stringify(persisted));
    await expect(
      store.patchFromClient({
        installationProviderPolicy: { definitions, excludedIds: [definitions[0].id] },
      }),
    ).rejects.toThrow("does not match");
    read = async () => {
      throw new Error("offline authority");
    };
    await expect(store.patchFromClient({ installationProviderPolicy: policy })).rejects.toThrow(
      "offline authority",
    );
    expect(loadPersistedConfig(home)).toEqual(persisted);
  });

  test("a catalog runtime installs only after enrollment and persists its local command and credentials", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-catalog-enrollment-"));
    tempDirs.push(home);
    const binding = {
      installationId: "4c07b582-7d41-4be4-9725-36f975708983",
      serverId: "host",
      environment: "host" as const,
      revision: 1,
    };
    const initial = reloadableConfig({});
    const admission: InstallationSettingsAdmission = {
      ...binding,
      installationInstructions: "",
      settings: { ...readInstallationSettings(initial), providerDefinitions: [] },
    };
    const store = new DaemonConfigStore(
      home,
      {
        ...initial,
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: binding,
        },
      },
      undefined,
      { installationSettingsReader: { read: async () => admission } },
    );
    const runtime = {
      extends: "acp",
      label: "Shared runtime",
      command: ["/local/runtime"],
      env: { PRIVATE_TOKEN: "local-only" },
    };
    await expect(
      store.patchFromClient({ providers: { "catalog-runtime": runtime } }),
    ).rejects.toThrow("installation coordinator");
    admission.settings.providerDefinitions = [
      {
        id: "catalog/acp/catalog-runtime",
        providerType: "catalog-runtime",
        bindings: { host: "catalog-runtime" },
        policy: { label: "Shared runtime" },
      },
      {
        id: "unrelated-pending",
        providerType: "codex",
        bindings: { host: "missing-account" },
        policy: { label: "Pending account" },
      },
    ];
    await store.patchFromClient({ providers: { "catalog-runtime": runtime } });
    expect(store.get().providers["catalog-runtime"]).toEqual(runtime);
    expect(loadPersistedConfig(home).agents?.providers?.["catalog-runtime"]).toEqual(runtime);
    expect(JSON.stringify(admission.settings)).not.toContain("PRIVATE_TOKEN");
    await expect(
      store.patchFromClient({ providers: { "catalog-runtime": { label: "Independent" } } }),
    ).rejects.toThrow("installation coordinator");
    expect(store.get().providers["catalog-runtime"]).toEqual(runtime);
  });

  test("fresh account exclusions reject delayed binding creation before persistence", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-excluded-account-"));
    tempDirs.push(home);
    const binding = {
      installationId: "4c07b582-7d41-4be4-9725-36f975708983",
      serverId: "host",
      environment: "host" as const,
      revision: 1,
    };
    const initial = reloadableConfig({});
    const definition = {
      id: "shared-account",
      providerType: "codex",
      bindings: { host: "local-account" },
      policy: { label: "Shared", enabled: true },
    };
    const admission: InstallationSettingsAdmission = {
      ...binding,
      installationInstructions: "",
      settings: { ...readInstallationSettings(initial), providerDefinitions: [definition] },
    };
    const store = new DaemonConfigStore(
      home,
      {
        ...initial,
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: binding,
        },
      },
      undefined,
      { installationSettingsReader: { read: async () => admission } },
    );
    const before = loadPersistedConfig(home);
    admission.settings.resourceExclusions.host = {
      providerIds: [definition.id],
      terminalProfileIds: [],
      metadataProviderIds: [],
    };
    await expect(
      store.createProviderAccountBinding("local-account", {
        extends: "codex",
        label: "Shared",
        enabled: true,
        env: { CODEX_HOME: path.join(home, "account") },
      }),
    ).rejects.toThrow("excluded from this environment");
    expect(store.get().providers["local-account"]).toBeUndefined();
    expect(loadPersistedConfig(home)).toEqual(before);
  });

  test("installation settings reject independent daemon edits but retain local terminal bindings", () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-settings-authority-"));
    tempDirs.push(home);
    const terminal = { id: "shell", name: "Shell", command: "sh", cwd: "/before" };
    const store = new DaemonConfigStore(home, {
      ...reloadableConfig({}),
      terminalProfiles: [terminal],
      sharedProviderPreferences: {
        version: 1,
        revision: 1,
        providers: {},
        legacyProfiles: {},
        installation: {
          installationId: "4c07b582-7d41-4be4-9725-36f975708983",
          serverId: "host",
          environment: "host",
          revision: 1,
        },
      },
    });
    expect(() => store.patch({ appendSystemPrompt: "independent edit" })).toThrow(
      "installation coordinator",
    );
    expect(() => store.patch({ terminalProfiles: [{ ...terminal, command: "bash" }] })).toThrow(
      "installation coordinator",
    );
    store.patch({ terminalProfiles: [{ ...terminal, cwd: "/after" }] });
    expect(store.get().terminalProfiles).toEqual([{ ...terminal, cwd: "/after" }]);
    expect(store.get().appendSystemPrompt).toBe("");
  });

  test("shared policy accepts verified coordinator values, rejects divergence and offline writes, and preserves concurrent local edits", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-settings-admission-"));
    tempDirs.push(home);
    const initial = {
      ...reloadableConfig({}),
      terminalProfiles: [{ id: "shell", name: "Shell", command: "sh", cwd: "/local" }],
    };
    const binding = {
      installationId: "4c07b582-7d41-4be4-9725-36f975708983",
      serverId: "host",
      environment: "host" as const,
      revision: 1,
    };
    const admission: InstallationSettingsAdmission = {
      ...binding,
      settings: { ...readInstallationSettings(initial), appendSystemPrompt: "Canonical" },
      installationInstructions: "",
    };
    let read = async () => admission;
    const store = new DaemonConfigStore(
      home,
      {
        ...initial,
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: binding,
        },
      },
      undefined,
      { installationSettingsReader: { read: () => read() } },
    );
    await expect(store.patchFromClient({ appendSystemPrompt: "Independent" })).rejects.toThrow(
      "installation coordinator",
    );
    await expect(store.setAgentSkillSelection({ mode: "custom", skills: [] })).rejects.toThrow(
      "installation coordinator",
    );
    await store.patchFromClient(
      projectInstallationSettings(admission.settings, "host", store.get()),
    );
    expect(store.get().appendSystemPrompt).toBe("Canonical");
    expect(loadPersistedConfig(home).daemon?.appendSystemPrompt).toBe("Canonical");
    expect(store.get().terminalProfiles?.[0].cwd).toBe("/local");
    admission.settings.skills = { selection: { mode: "custom", skills: ["alpha"] } };
    await store.setAgentSkillSelection(admission.settings.skills.selection);
    expect(store.get().skills).toEqual(admission.settings.skills);
    expect(loadPersistedConfig(home).agents?.skills).toEqual(admission.settings.skills);
    read = async () => {
      throw new Error("coordinator offline");
    };
    await expect(store.patchFromClient({ pluginsEnabled: true })).rejects.toThrow(
      "coordinator offline",
    );
    await store.patchFromClient({
      terminalProfiles: [{ ...initial.terminalProfiles[0], cwd: "/offline-local-edit" }],
    });
    expect(store.get().terminalProfiles?.[0].cwd).toBe("/offline-local-edit");
    const pending = Promise.withResolvers<InstallationSettingsAdmission>();
    read = () => pending.promise;
    const projection = store.patchFromClient({ appendSystemPrompt: "New canonical" });
    store.patch({ providers: { codex: { env: { LOCAL_BINDING: "retained" } } } });
    pending.resolve({
      ...admission,
      settings: { ...admission.settings, appendSystemPrompt: "New canonical" },
    });
    await expect(projection).rejects.toThrow("changed while verifying");
    expect(store.get().appendSystemPrompt).toBe("Canonical");
    expect(store.get().providers.codex.env).toEqual({ LOCAL_BINDING: "retained" });
    read = async () => ({ ...admission, serverId: "another-daemon" });
    await expect(store.patchFromClient({ pluginsEnabled: true })).rejects.toThrow(
      "different installation",
    );
  });

  test("installation reload rejects independently edited policy without applying unrelated changes", () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-settings-reload-"));
    tempDirs.push(home);
    const store = new DaemonConfigStore(
      home,
      {
        ...reloadableConfig({}),
        sharedProviderPreferences: {
          version: 1,
          revision: 1,
          providers: {},
          legacyProfiles: {},
          installation: {
            installationId: "4c07b582-7d41-4be4-9725-36f975708983",
            serverId: "host",
            environment: "host",
            revision: 1,
          },
        },
      },
      undefined,
      {
        reloadSource: {
          resolve: (persisted) => ({
            mutable: reloadableConfig(persisted),
            overrideControlledPaths: [],
          }),
        },
      },
    );
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        daemon: { appendSystemPrompt: "Local drift", browserTools: { enabled: true } },
      }),
    );
    expect(() => store.reload()).toThrow("installation coordinator");
    expect(store.get().appendSystemPrompt).toBe("");
    expect(store.get().browserTools.enabled).toBe(false);
  });

  test("removing a local account retains canonical metadata choices for other environments", () => {
    const home = mkdtempSync(path.join(tmpdir(), "vorteo-settings-account-"));
    tempDirs.push(home);
    const metadataGeneration = {
      providers: [{ provider: "local-account", model: "saved-choice" }],
    };
    const store = new DaemonConfigStore(home, {
      ...reloadableConfig({}),
      providers: { "local-account": { extends: "codex" } },
      metadataGeneration,
      sharedProviderPreferences: {
        version: 1,
        revision: 1,
        providers: {},
        legacyProfiles: {},
        installation: {
          installationId: "4c07b582-7d41-4be4-9725-36f975708983",
          serverId: "host",
          environment: "host",
          revision: 1,
        },
      },
    });
    store.patch({ removeProviders: ["local-account"] });
    expect(store.get().providers).toEqual({});
    expect(store.get().metadataGeneration).toEqual(metadataGeneration);
    expect(loadPersistedConfig(home).agents?.metadataGeneration).toEqual(metadataGeneration);
  });

  test("shared resource projection preserves excluded bindings durably and rejects stale local values", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-resource-bindings-"));
    tempDirs.push(paseoHome);
    const profile = {
      id: "shell",
      name: "Shell",
      command: "sh",
      cwd: "/original",
      env: { KEY: "local-only" },
    };
    const store = new DaemonConfigStore(paseoHome, {
      ...reloadableConfig({}),
      terminalProfiles: [profile],
    });
    const revision = installationResourceRevision(store.get());
    store.patch({ terminalProfiles: [{ ...profile, cwd: "/new-local-path" }] });
    const projection = {
      terminalProfiles: [],
      installationResourceBindings: { terminalProfiles: [profile], metadataProviders: [] },
      expectedInstallationResourceRevision: revision,
    };
    expect(() => store.patch(projection)).toThrow("resource bindings changed");
    expect(store.get().terminalProfiles?.[0].cwd).toBe("/new-local-path");
    const current = store.get().terminalProfiles ?? [];
    store.patch({
      ...projection,
      expectedInstallationResourceRevision: installationResourceRevision(store.get()),
      installationResourceBindings: { terminalProfiles: current, metadataProviders: [] },
    });
    expect(store.get().terminalProfiles).toEqual([]);
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.installationResourceBindings?.terminalProfiles).toEqual(current);
    const restarted = new DaemonConfigStore(paseoHome, {
      ...reloadableConfig(persisted),
      installationResourceBindings: persisted.daemon?.installationResourceBindings,
    });
    expect(restarted.get().installationResourceBindings?.terminalProfiles).toEqual(current);
  });

  test("account bindings persist and invalidate a metadata projection prepared before rebinding", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-account-bindings-"));
    tempDirs.push(paseoHome);
    const initial = reloadableConfig({
      agents: { metadataGeneration: { providers: [{ provider: "codex", model: "chosen" }] } },
    });
    initial.sharedProviderPreferences = {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: {
        installationId: "4c07b582-7d41-4be4-9725-36f975708983",
        serverId: "host",
        environment: "host",
        revision: 1,
      },
    };
    const store = new DaemonConfigStore(paseoHome, initial);
    const first = "71fca551-79a4-4af9-b9e6-9ec7222f9e1d";
    store.patch({ providers: { codex: { installationAccountId: first } } });
    expect(loadPersistedConfig(paseoHome).agents?.providers?.codex.installationAccountId).toBe(
      first,
    );
    const policy = readInstallationSettings(store.get());
    const projection = projectInstallationSettings(policy, "host", store.get());
    store.patch({
      providers: { codex: { installationAccountId: "8cba85c0-d92b-4fa4-a9e8-773a9f1f01cc" } },
    });
    expect(() => store.patch(projection)).toThrow("resource bindings changed");
    expect(store.get().metadataGeneration.providers).toEqual([
      { provider: "codex", model: "chosen" },
    ]);
  });

  test("patch persists relay state and emits its field change", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    const changes: unknown[] = [];
    store.onFieldChange("relay.enabled", (value) => changes.push(value));

    store.patch({ relay: { enabled: true } });

    expect(changes).toEqual([true]);
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(true);
    const profile = {
      id: "review",
      name: "Review",
      provider: "codex",
      isDefault: true,
      instructions: "Review all diffs",
      workerProfileId: "local",
      quotaReservePolicy: { kind: "protected" as const, cruisePct: 15, redlinePct: 10 },
    };
    store.patch({ agentProfiles: [profile], expectedAgentProfiles: [] });
    expect(() => store.patch({ agentProfiles: [], expectedAgentProfiles: [] })).toThrow(
      "another device",
    );
    store.patch({ agentProfiles: [{ id: "review", name: "Renamed", provider: "codex" }] });
    expect(store.get().agentProfiles?.[0]).toMatchObject({
      isDefault: true,
      instructions: profile.instructions,
      workerProfileId: "local",
      quotaReservePolicy: profile.quotaReservePolicy,
    });
    store.patch({ agentProfiles: [{ ...profile, instructions: "", workerProfileId: "" }] });
    expect(store.get().agentProfiles?.[0].instructions).toBe("");
    store.patch({ agentProfiles: [{ ...profile, isDefault: false }] });
    expect(store.get().agentProfiles?.[0].isDefault).toBe(false);
    expect(() =>
      store.patch({
        agentProfiles: [
          { ...profile, quotaReservePolicy: { kind: "protected", cruisePct: 10, redlinePct: 15 } },
        ],
      }),
    ).toThrow("Redline must be lower");
    store.patch({ agentProfiles: [{ ...profile, quotaReservePolicy: { kind: "off" } }] });
    expect(store.get().agentProfiles?.[0].quotaReservePolicy).toEqual({ kind: "off" });
  });

  test("patch round-trips agent profiles through the strictly-parsed persisted config", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    store.patch({
      agentProfiles: [
        {
          id: "profile_ui",
          name: "UI work",
          icon: "🎨",
          provider: "claude",
          model: "claude-opus-5",
          modeId: "plan",
          thinkingOptionId: "think-hard",
          featureValues: { webSearch: true },
          notes: "Use for components, layout and design tokens.",
        },
      ],
    });

    expect(loadPersistedConfig(paseoHome).daemon?.agentProfiles).toEqual([
      {
        id: "profile_ui",
        name: "UI work",
        icon: "🎨",
        provider: "claude",
        model: "claude-opus-5",
        modeId: "plan",
        thinkingOptionId: "think-hard",
        featureValues: { webSearch: true },
        notes: "Use for components, layout and design tokens.",
      },
    ]);
    expect(store.get().agentProfiles).toHaveLength(1);
  });

  test("patch replaces the whole agent profile list rather than merging entries", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      agentProfiles: [
        { id: "a", name: "Keep", provider: "claude" },
        { id: "b", name: "Drop", provider: "codex" },
      ],
    });

    store.patch({ agentProfiles: [{ id: "a", name: "Keep", provider: "claude" }] });

    expect(store.get().agentProfiles).toEqual([{ id: "a", name: "Keep", provider: "claude" }]);
    expect(loadPersistedConfig(paseoHome).daemon?.agentProfiles).toHaveLength(1);
  });

  test("rolls back config when a field transition fails", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    store.onFieldChange("relay.enabled", (enabled) => {
      if (enabled === true) {
        throw new Error("Relay transport failed to start");
      }
    });

    expect(() => store.patch({ relay: { enabled: true } })).toThrow(
      "Relay transport failed to start",
    );
    expect(store.get().relay?.enabled).toBe(false);
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(false);
  });

  test("rolls back live owners when a later transactional owner fails", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    let browserToolsEnabled = false;
    store.onApply((next, previous) => {
      browserToolsEnabled = next.browserTools.enabled;
      return () => {
        browserToolsEnabled = previous.browserTools.enabled;
      };
    });
    store.onApply(() => {
      throw new Error("Provider refresh failed");
    });

    expect(() => store.patch({ browserTools: { enabled: true } })).toThrow(
      "Provider refresh failed",
    );
    expect(browserToolsEnabled).toBe(false);
    expect(store.get().browserTools.enabled).toBe(false);
    expect(loadPersistedConfig(paseoHome).daemon?.browserTools?.enabled).toBeUndefined();
  });

  test("rejects relay patches when a launch override owns the setting", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: false },
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    expect(() => store.patch({ relay: { enabled: true } })).toThrow(
      "Relay is controlled by a daemon launch override",
    );
  });

  test("unrelated patches do not persist a one-launch relay override", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const persisted = loadPersistedConfig(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({
        ...persisted,
        daemon: { ...persisted.daemon, relay: { enabled: false } },
      })}\n`,
    );
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: true },
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    store.patch({ browserTools: { enabled: true } });

    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(false);
  });

  test("unrelated patches persist only requested file intent", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const before = loadPersistedConfig(paseoHome);
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: true },
        mcp: { enabled: false, injectIntoAgents: false },
        hostnames: ["launch.example.test"],
        cors: { allowedOrigins: ["https://launch.example.test"] },
        trustedProxies: true,
        git: { maxProcessesPerSecond: 7, maxProcessConcurrency: 2 },
        app: { baseUrl: "https://launch.example.test" },
        catalogRefreshTimeoutMs: 9_000,
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    store.patch({
      appendSystemPrompt: "Only this field",
      // Reload-only runtime state is accepted as unknown wire data for forward
      // compatibility but is not part of the patch capability.
      hostnames: ["attempted-patch.example.test"],
    } as Parameters<typeof store.patch>[0]);

    expect(store.get().hostnames).toEqual(["launch.example.test"]);
    expect(loadPersistedConfig(paseoHome)).toEqual({
      ...before,
      daemon: { ...before.daemon, appendSystemPrompt: "Only this field" },
    });
  });

  test("patch persists provider enabled flags into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const initial = loadPersistedConfig(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    // Reuse the validated serializer through the store path by seeding the file directly.
    // This keeps the test focused on the merge behavior.
    const seeded =
      JSON.stringify(
        {
          ...initial,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
          },
        },
        null,
        2,
      ) + "\n";
    writeFileSync(configPath, seeded);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      providers: {
        gemini: { enabled: false },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.gemini).toEqual({
      extends: "acp",
      label: "Gemini",
      command: ["gemini", "--acp"],
      enabled: false,
    });
  });

  test("patch persists provider Paseo-tool policy without changing availability", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      JSON.stringify({ agents: { providers: { claude: { enabled: false } } } }),
    );
    const store = new DaemonConfigStore(paseoHome, {
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      providers: { claude: { enabled: false } },
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    store.patch({
      providers: {
        claude: {
          paseoTools: { enabled: true, disabledTools: ["list_agents"] },
        },
      },
    });
    store.patch({
      providers: {
        claude: {
          paseoTools: { disabledTools: ["create_agent"] },
        },
      },
    });

    expect(store.get().providers.claude).toEqual({
      enabled: false,
      paseoTools: { enabled: true, disabledTools: ["create_agent"] },
    });
    expect(loadPersistedConfig(paseoHome).agents?.providers?.claude).toEqual({
      enabled: false,
      paseoTools: { enabled: true, disabledTools: ["create_agent"] },
    });
  });

  test("patch removes provider entries from config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
              claude: {
                enabled: false,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {
          gemini: {},
          claude: { enabled: false },
        },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = store.patch({ removeProviders: ["gemini"] });

    expect(next.providers.gemini).toBeUndefined();
    expect(next.providers.claude).toEqual({ enabled: false });
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.gemini).toBeUndefined();
    expect(persisted.agents?.providers?.claude).toEqual({ enabled: false });
  });

  test("patch removes the providers object when the last provider is deleted", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: { gemini: {} },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({ removeProviders: ["gemini"] });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers).toBeUndefined();
  });

  test("patch removes deleted providers from metadata generation", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
              claude: {
                enabled: false,
              },
            },
            metadataGeneration: {
              providers: [
                { provider: "gemini", model: "flash" },
                { provider: "claude", model: "haiku" },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {
          gemini: {},
          claude: { enabled: false },
        },
        metadataGeneration: {
          providers: [
            { provider: "gemini", model: "flash" },
            { provider: "claude", model: "haiku" },
          ],
        },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = store.patch({ removeProviders: ["gemini"] });

    expect(next.metadataGeneration.providers).toEqual([{ provider: "claude", model: "haiku" }]);
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({
      providers: [{ provider: "claude", model: "haiku" }],
    });
  });

  test("patch persists provider removal when in-memory config is already clean", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
            metadataGeneration: {
              providers: [{ provider: "gemini", model: "flash" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = store.patch({ removeProviders: ["gemini"] });

    expect(next.providers.gemini).toBeUndefined();
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers).toBeUndefined();
    expect(persisted.agents?.metadataGeneration).toEqual({ providers: [] });
  });

  test("patch persists append system prompt into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      appendSystemPrompt: "Prefer terse replies.",
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });

  test("patch persists browser tools opt-in into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({ browserTools: { enabled: true } });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.browserTools).toEqual({ enabled: true });
  });

  test("patch persists provider additional models into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      providers: {
        claude: {
          additionalModels: [
            {
              id: "claude-custom",
              label: "claude-custom",
            },
          ],
        },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.claude).toEqual({
      additionalModels: [
        {
          id: "claude-custom",
          label: "claude-custom",
        },
      ],
    });
  });

  test("patch persists daemon append system prompt into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      appendSystemPrompt: "Prefer terse replies.",
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });

  test("patch persists enable terminal agent hooks into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({ enableTerminalAgentHooks: true });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.enableTerminalAgentHooks).toBe(true);
  });

  test("patch persists metadata generation providers into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      metadataGeneration: {
        providers: [
          { provider: "claude", model: "haiku" },
          { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
        ],
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
      ],
    });
  });

  test("patch persists clearing metadata generation providers into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            metadataGeneration: {
              providers: [{ provider: "claude", model: "haiku" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [{ provider: "claude", model: "haiku" }] },
      },
      undefined,
    );

    store.patch({ metadataGeneration: { providers: [] } });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({ providers: [] });
  });

  test("patch persists custom ACP provider overrides into config.json", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [] },
      },
      undefined,
    );

    store.patch({
      providers: {
        "paseo-e2e-acp": {
          extends: "acp",
          label: "Paseo E2E ACP",
          description: "E2E ACP provider fixture",
          command: ["npx", "-y", "--version"],
          env: {},
        },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.["paseo-e2e-acp"]).toEqual({
      extends: "acp",
      label: "Paseo E2E ACP",
      description: "E2E ACP provider fixture",
      command: ["npx", "-y", "--version"],
      env: {},
    });
  });
});

describe("DaemonConfigStore reload", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function createReloadableStore(
    options: {
      overrideControlledPaths?: string[];
      initialPersisted?: PersistedConfig;
    } = {},
  ) {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-reload-"));
    tempDirs.push(paseoHome);
    if (options.initialPersisted) {
      writeFileSync(
        path.join(paseoHome, "config.json"),
        `${JSON.stringify(options.initialPersisted, null, 2)}\n`,
      );
    }
    const persisted = loadPersistedConfig(paseoHome);
    const relayEnabledFallback = persisted.daemon?.relay?.enabled === undefined;
    const initialMutable = reloadableConfig(persisted, { relayEnabledFallback });
    const store = new DaemonConfigStore(paseoHome, initialMutable, undefined, {
      reloadSource: {
        resolve: (nextPersisted) => {
          const mutable = reloadableConfig(nextPersisted, { relayEnabledFallback });
          if (options.overrideControlledPaths?.includes("daemon.relay.enabled")) {
            mutable.relay = initialMutable.relay;
          }
          return {
            mutable,
            overrideControlledPaths: options.overrideControlledPaths ?? [],
          };
        },
      },
    });
    return { paseoHome, store, persisted };
  }

  function writeConfig(paseoHome: string, config: unknown): void {
    writeFileSync(path.join(paseoHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }

  test("applies mutable edits and reports startup-only edits", () => {
    const { paseoHome, store, persisted } = createReloadableStore();
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        listen: "127.0.0.1:7777",
        browserTools: { enabled: true },
        git: { maxProcessesPerSecond: 12, maxProcessConcurrency: 3 },
      },
    });

    expect(store.reload()).toEqual({
      appliedPaths: [
        "daemon.browserTools.enabled",
        "daemon.git.maxProcessConcurrency",
        "daemon.git.maxProcessesPerSecond",
      ],
      restartRequiredPaths: ["daemon.listen"],
      overrideControlledPaths: [],
    });
    expect(store.get().browserTools.enabled).toBe(true);
    expect(store.get().git).toEqual({ maxProcessesPerSecond: 12, maxProcessConcurrency: 3 });
  });

  test("applies the global plugin switch in both directions", () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      initialPersisted: { version: 1, pluginsEnabled: false },
    });
    const changes: unknown[] = [];
    store.onFieldChange("pluginsEnabled", (value) => changes.push(value));

    writeConfig(paseoHome, { ...persisted, pluginsEnabled: true });
    expect(store.reload()).toEqual({
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().pluginsEnabled).toBe(true);

    writeConfig(paseoHome, { ...persisted, pluginsEnabled: false });
    expect(store.reload()).toEqual({
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().pluginsEnabled).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  test("classifies every leaf when a parent subtree is added", () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: { version: 1 },
    });
    writeConfig(paseoHome, {
      version: 1,
      daemon: {
        relay: {
          enabled: false,
          endpoint: "relay.example.test:443",
          useTls: true,
        },
      },
    });

    expect(store.reload()).toEqual({
      appliedPaths: ["daemon.relay.enabled"],
      restartRequiredPaths: ["daemon.relay.endpoint", "daemon.relay.useTls"],
      overrideControlledPaths: [],
    });
  });

  test("classifies every leaf when the daemon subtree is removed", () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: {
        version: 1,
        daemon: {
          listen: "127.0.0.1:7777",
          browserTools: { enabled: true },
          relay: {
            enabled: false,
            endpoint: "relay.example.test:443",
            useTls: true,
          },
          serviceProxy: {
            listen: "127.0.0.1:7788",
            publicBaseUrl: "https://services.example.test",
          },
        },
      },
    });
    writeConfig(paseoHome, { version: 1 });

    expect(store.reload()).toEqual({
      appliedPaths: ["daemon.browserTools.enabled"],
      restartRequiredPaths: [
        "daemon.listen",
        "daemon.relay.endpoint",
        "daemon.relay.useTls",
        "daemon.serviceProxy.listen",
        "daemon.serviceProxy.publicBaseUrl",
      ],
      overrideControlledPaths: [],
    });
    expect(store.get().relay?.enabled).toBe(false);
  });

  test("keeps overridden leaves separate from restart-required siblings", () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: { version: 1 },
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    writeConfig(paseoHome, {
      version: 1,
      daemon: {
        relay: { enabled: false, endpoint: "relay.example.test:443" },
      },
    });

    expect(store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: ["daemon.relay.endpoint"],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
  });

  test("invalid JSON and invalid schema apply nothing", () => {
    const { paseoHome, store } = createReloadableStore();
    writeFileSync(path.join(paseoHome, "config.json"), "{ nope\n");
    expect(() => store.reload()).toThrow("Invalid JSON");
    expect(store.get().browserTools.enabled).toBe(false);

    writeConfig(paseoHome, { daemon: { browserTools: { enabled: "yes" } } });
    expect(() => store.reload()).toThrow("Invalid config");
    expect(store.get().browserTools.enabled).toBe(false);
  });

  test("removing providers and optional profiles clears live state", () => {
    const { paseoHome, store, persisted } = createReloadableStore();
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        terminalProfiles: [{ id: "shell", name: "Shell", command: "bash" }],
        agentProfiles: [{ id: "review", name: "Review", provider: "codex" }],
      },
      agents: {
        providers: {
          gemini: { extends: "acp", label: "Gemini", command: ["gemini", "--acp"] },
        },
      },
    });
    store.reload();

    writeConfig(paseoHome, persisted);
    const result = store.reload();

    expect(result.appliedPaths).toEqual([
      "agents.providers",
      "daemon.agentProfiles",
      "daemon.terminalProfiles",
    ]);
    expect(store.get().providers).toEqual({});
    expect(store.get().terminalProfiles).toBeUndefined();
    expect(store.get().agentProfiles).toBeUndefined();
  });

  test("reports a launch-controlled edit without changing live state", () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    const initialRelay = store.get().relay?.enabled;
    writeConfig(paseoHome, {
      ...persisted,
      daemon: { ...persisted.daemon, relay: { enabled: !initialRelay } },
    });

    expect(store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    expect(store.get().relay?.enabled).toBe(initialRelay);
  });

  test("an unrelated patch does not mark a manual override-owned edit as applied", () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    writeConfig(paseoHome, {
      ...persisted,
      daemon: { ...persisted.daemon, relay: { enabled: true } },
    });
    store.patch({ appendSystemPrompt: "patched elsewhere" });

    expect(store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
  });

  test("reports startup-only launch overrides instead of restart warnings", () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.listen", "daemon.relay.endpoint"],
    });
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        listen: "127.0.0.1:7777",
        relay: {
          ...persisted.daemon?.relay,
          endpoint: "relay.example.test:443",
        },
      },
    });

    expect(store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.listen", "daemon.relay.endpoint"],
    });
  });

  test("a no-op reload returns empty path lists", () => {
    const { store } = createReloadableStore();
    expect(store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
  });
});

test("registered provider defaults remain visible to migration and reload without persisting runtime inventory", () => {
  const home = mkdtempSync(path.join(tmpdir(), "provider-inventory-"));
  try {
    const store = new DaemonConfigStore(home, reloadableConfig({}), undefined, {
      reloadSource: {
        resolve: (persisted) => ({
          mutable: reloadableConfig(persisted),
          overrideControlledPaths: [],
        }),
      },
    });
    store.registerProviderDefaults(["codex", "plugin-provider"]);
    expect(
      readInstallationProviders("host", store.get().providers).map((entry) => entry.bindings.host),
    ).toEqual(["codex", "plugin-provider"]);
    expect(loadPersistedConfig(home).agents?.providers).toBeUndefined();
    store.patch({ providers: { codex: { label: "Keep my name", enabled: false } } });
    store.registerProviderDefaults(["codex", "plugin-provider", "new-plugin"]);
    store.reload();
    expect(store.get().providers).toEqual({
      codex: { label: "Keep my name", enabled: false },
      "plugin-provider": {},
      "new-plugin": {},
    });
    expect(loadPersistedConfig(home).agents?.providers).toEqual({
      codex: { label: "Keep my name", enabled: false },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
