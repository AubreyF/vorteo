import { expect, test } from "vitest";
import { InstallationSettingsSnapshotSchema } from "@getpaseo/protocol/installation-settings";
import { DEFAULT_TERMINAL_PROFILES } from "@getpaseo/protocol/terminal-profiles";
import { SettingsEnvironmentFake, SettingsJournalFake } from "./fakes.js";
import {
  InstallationSettingsConflict,
  InstallationSettingsInvalidUpdate,
  InstallationSettingsNotInitialized,
  InstallationSettingsService,
} from "./service.js";

function fixture() {
  const host = new SettingsEnvironmentFake("host");
  const container = new SettingsEnvironmentFake("container");
  const journal = new SettingsJournalFake();
  const service = new InstallationSettingsService(journal, [host, container]);
  return { host, container, journal, service };
}

test("shared skill choices are durable before projection and removal approvals are consumed once", async () => {
  const { service, host, container, journal } = fixture();
  await service.reconcile();
  host.skillOps = [{ kind: "delete", name: "beta" }];
  container.skillOps = [{ kind: "delete", name: "beta" }];
  const selection = { mode: "custom" as const, skills: ["alpha"] };
  const preview = await service.previewSkills(selection);
  expect(preview.host?.confirmationRequired).toEqual({ removals: ["beta"] });
  expect(host.patches).toEqual([]);
  await service.update({ expectedRevision: 1, settings: { skills: { selection } } });
  expect(journal.state?.settings?.skills).toEqual({ selection });
  const waiting = await service.reconcile();
  expect(waiting.sources.host.error).toBe("skill_removal_review_required");
  expect(host.patches).toEqual([]);
  await service.update({
    expectedRevision: 2,
    settings: { skills: { selection } },
    confirmedSkillRemovals: { host: ["beta"], container: ["beta"] },
  });
  container.offline = true;
  await service.reconcile();
  expect(host.config.skills).toEqual({ selection });
  expect(host.skillConfirmations).toEqual([["beta"]]);
  container.offline = false;
  const reconnected = await service.reconcile();
  expect(reconnected.sources.container.error).toBe("skill_removal_review_required");
  expect(container.patches).toEqual([]);
  await service.update({
    expectedRevision: 2,
    settings: { skills: { selection } },
    confirmedSkillRemovals: { container: ["beta"] },
  });
  const applied = await service.reconcile();
  expect(applied.sources.container.pendingRevision).toBeNull();
  expect(container.config.skills).toEqual({ selection });
  expect(JSON.stringify(journal.state)).not.toContain("confirmedSkillRemovals");
});

test("metadata policy follows the verified account binding across different local IDs", async () => {
  const { service, host, container } = fixture();
  const accountId = "71fca551-79a4-4af9-b9e6-9ec7222f9e1d";
  host.config.providers = {
    "host-second": { extends: "codex", label: "Same label", installationAccountId: accountId },
    "host-first": { extends: "codex", label: "Same label" },
  };
  container.config.providers = {
    "dev-second": { extends: "codex", label: "Different label", installationAccountId: accountId },
  };
  container.config.metadataGeneration.providers = [
    { provider: "dev-second", model: "chosen-model" },
  ];
  const initial = await service.reconcile();
  expect(initial.conflicts?.fields).toEqual(["providerDefinitions", "metadataGeneration"]);
  const desired = initial.conflicts!.candidates.container.metadataGeneration;
  expect(desired.providers).toEqual([
    { provider: `installation-account/${accountId}`, model: "chosen-model" },
  ]);
  await service.update({
    expectedRevision: initial.revision,
    settings: {
      metadataGeneration: desired,
      providerDefinitions: initial.conflicts!.candidates.container.providerDefinitions,
    },
  });
  const applied = await service.reconcile();
  expect(applied.sources.host.pendingRevision).toBeNull();
  expect(host.config.metadataGeneration.providers).toEqual([
    { provider: "host-second", model: "chosen-model" },
  ]);
  expect(container.config.metadataGeneration.providers).toEqual([
    { provider: "dev-second", model: "chosen-model" },
  ]);
  delete host.config.providers["host-second"];
  const unavailable = await service.reconcile();
  expect(unavailable.sources.host.pendingRevision).toBe(applied.revision);
  expect(unavailable.sources.host.error).not.toBeNull();
  expect(unavailable.settings?.metadataGeneration).toEqual(desired);
  expect(host.config.metadataGeneration.providers[0].provider).toBe("host-second");
});

test("provider exclusions suspend metadata locally and restore private bindings when enabled", async () => {
  const { service, host, container, journal } = fixture();
  const accountId = "71fca551-79a4-4af9-b9e6-9ec7222f9e1d";
  host.config.providers = {
    "host-account": { extends: "codex", label: "Account", installationAccountId: accountId },
  };
  container.config.providers = {
    "dev-account": { extends: "codex", label: "Account", installationAccountId: accountId },
  };
  const hostMetadata = { provider: "host-account", model: "m", token: "host-private" };
  const devMetadata = { provider: "dev-account", model: "m", token: "dev-private" };
  host.config.metadataGeneration.providers = [hostMetadata];
  container.config.metadataGeneration.providers = [devMetadata];
  const initial = await service.reconcile();
  const definitions = initial.settings!.providerDefinitions!;
  const definition = definitions.find((entry) => entry.accountId === accountId)!;
  await service.update({
    expectedRevision: initial.revision,
    settings: {
      resourceExclusions: {
        host: { terminalProfileIds: [], metadataProviderIds: [], providerIds: [definition.id] },
      },
    },
  });
  const excluded = await service.reconcile();
  expect(excluded.sources.host).toEqual({
    appliedRevision: excluded.revision,
    pendingRevision: null,
    error: null,
  });
  expect(host.config.metadataGeneration.providers).toEqual([]);
  expect(host.config.installationResourceBindings?.metadataProviders).toEqual([hostMetadata]);
  expect(container.config.metadataGeneration.providers).toEqual([devMetadata]);
  expect(excluded.settings?.metadataGeneration).toEqual(initial.settings?.metadataGeneration);
  const hostBinding = host.config.providers["host-account"];
  delete host.config.providers["host-account"];
  const recovered = new InstallationSettingsService(journal, [host, container]);
  const absent = await recovered.reconcile();
  expect(absent.sources.host.pendingRevision).toBeNull();
  expect(host.config.installationResourceBindings?.metadataProviders).toEqual([hostMetadata]);
  expect(host.config.providers["host-account"]).toBeUndefined();
  host.config.providers["host-account"] = hostBinding;
  await recovered.update({
    expectedRevision: excluded.revision,
    settings: { resourceExclusions: {} },
  });
  const restored = await recovered.reconcile();
  expect(restored.sources.host.pendingRevision).toBeNull();
  expect(host.config.metadataGeneration.providers).toEqual([hostMetadata]);
  await recovered.update({
    expectedRevision: restored.revision,
    settings: {
      providerDefinitions: definitions.map((entry) => ({
        ...entry,
        policy: { ...entry.policy, enabled: false },
      })),
    },
  });
  const disabled = await recovered.reconcile();
  expect(disabled.sources.host.pendingRevision).toBeNull();
  expect(disabled.sources.container.pendingRevision).toBeNull();
  expect(host.config.metadataGeneration.providers).toEqual([]);
  expect(container.config.metadataGeneration.providers).toEqual([]);
  await recovered.update({
    expectedRevision: disabled.revision,
    settings: { providerDefinitions: definitions },
  });
  const enabled = await recovered.reconcile();
  expect(enabled.sources.host.pendingRevision).toBeNull();
  expect(enabled.sources.container.pendingRevision).toBeNull();
  expect(host.config.metadataGeneration.providers).toEqual([hostMetadata]);
  expect(container.config.metadataGeneration.providers).toEqual([devMetadata]);
  expect(JSON.stringify(journal.state)).not.toContain("private");
});

test("equal initial policy is backed up and applied without config writes or polling churn", async () => {
  const { service, host, container, journal } = fixture();
  const snapshot = await service.reconcile();
  expect(snapshot.revision).toBe(1);
  expect(snapshot.settings?.pluginsEnabled).toBe(false);
  expect(snapshot.settings?.terminalProfiles).toEqual(DEFAULT_TERMINAL_PROFILES);
  expect(snapshot.sources.host).toEqual({ appliedRevision: 1, pendingRevision: null, error: null });
  expect(snapshot.sources.container).toEqual(snapshot.sources.host);
  expect(host.patches).toEqual([]);
  expect(container.patches).toEqual([]);
  expect(journal.backups.map((backup) => backup.reason)).toEqual(["initial-migration"]);
  expect(await service.reconcile()).toEqual(snapshot);
  expect(InstallationSettingsSnapshotSchema.parse(snapshot)).toEqual(snapshot);
});

test("unset terminal profiles retain built-ins and differ from an explicitly empty list", async () => {
  const { service, host, container } = fixture();
  container.config.terminalProfiles = [];
  const migration = await service.reconcile();
  expect(migration.settings).toBeNull();
  expect(migration.conflicts?.fields).toEqual(["terminalProfiles"]);
  expect(migration.conflicts?.candidates.host.terminalProfiles).toEqual(DEFAULT_TERMINAL_PROFILES);
  expect(migration.conflicts?.candidates.container.terminalProfiles).toEqual([]);
  expect(host.patches).toEqual([]);
  await service.update({
    expectedRevision: 1,
    settings: { terminalProfiles: Array.from(DEFAULT_TERMINAL_PROFILES) },
  });
  await service.reconcile();
  expect(host.config.terminalProfiles).toBeUndefined();
  expect(container.config.terminalProfiles).toEqual(DEFAULT_TERMINAL_PROFILES);
});

test("owner edits are durable before projection and stale concurrent edits are rejected", async () => {
  const { service, host, container, journal } = fixture();
  await service.reconcile();
  const [first, stale] = await Promise.allSettled([
    service.update({ expectedRevision: 1, settings: { appendSystemPrompt: "Shared policy" } }),
    service.update({ expectedRevision: 1, settings: { autoArchiveAfterMerge: true } }),
  ]);
  expect(first.status).toBe("fulfilled");
  expect(stale.status).toBe("rejected");
  if (stale.status === "rejected")
    expect(stale.reason).toBeInstanceOf(InstallationSettingsConflict);
  expect(journal.state?.settings?.appendSystemPrompt).toBe("Shared policy");
  expect(service.snapshot().sources.host.pendingRevision).toBe(2);
  expect(host.patches).toEqual([]);
  const applied = await service.reconcile();
  expect(host.config.appendSystemPrompt).toBe("Shared policy");
  expect(container.config.appendSystemPrompt).toBe("Shared policy");
  expect(applied.sources.container.appliedRevision).toBe(2);
});

test("initial differences require explicit revisioned resolution and never pick host values", async () => {
  const { service, host, container, journal } = fixture();
  host.config.appendSystemPrompt = "Host instructions";
  container.config.appendSystemPrompt = "Container instructions";
  host.config.autoArchiveAfterMerge = true;
  const migration = await service.reconcile();
  expect(migration.settings).toBeNull();
  expect(migration.conflicts?.fields).toEqual(["appendSystemPrompt", "autoArchiveAfterMerge"]);
  expect(migration.conflicts?.candidates.container.appendSystemPrompt).toBe(
    "Container instructions",
  );
  expect(host.patches).toEqual([]);
  expect(container.patches).toEqual([]);
  await expect(
    service.update({ expectedRevision: 1, settings: { appendSystemPrompt: "Chosen" } }),
  ).rejects.toMatchObject({ fields: ["autoArchiveAfterMerge"] });
  expect(service.snapshot()).toEqual(migration);
  const restored = new InstallationSettingsService(journal, [host, container]);
  await restored.update({
    expectedRevision: 1,
    settings: { appendSystemPrompt: "Chosen", autoArchiveAfterMerge: false },
  });
  await restored.reconcile();
  expect(host.config.appendSystemPrompt).toBe("Chosen");
  expect(container.config.appendSystemPrompt).toBe("Chosen");
  expect(host.config.autoArchiveAfterMerge).toBe(false);
});

test("initial offline environments block migration and owner writes without partial import", async () => {
  const { service, host, container, journal } = fixture();
  container.offline = true;
  const snapshot = await service.reconcile();
  expect(snapshot.revision).toBe(0);
  expect(snapshot.settings).toBeNull();
  expect(snapshot.sources.container.error).toBe("read_failed");
  expect(JSON.stringify(snapshot)).not.toContain("private diagnostic");
  await expect(
    service.update({ expectedRevision: 0, settings: { pluginsEnabled: true } }),
  ).rejects.toBeInstanceOf(InstallationSettingsNotInitialized);
  expect(journal.backups).toEqual([]);
  expect(host.patches).toEqual([]);
  container.offline = false;
  expect((await service.reconcile()).settings).not.toBeNull();
});

test("subsequent environment drift is repaired from canonical policy rather than imported", async () => {
  const { service, host, container } = fixture();
  await service.reconcile();
  host.config.appendSystemPrompt = "Unmanaged edit";
  container.config.autoArchiveAfterMerge = true;
  const snapshot = await service.reconcile();
  expect(snapshot.revision).toBe(1);
  expect(snapshot.settings?.appendSystemPrompt).toBe("");
  expect(host.config.appendSystemPrompt).toBe("");
  expect(container.config.autoArchiveAfterMerge).toBe(false);
});

test("partial projection persists pending errors and restart retries only outstanding writes", async () => {
  const { service, host, container, journal } = fixture();
  await service.reconcile();
  await service.update({ expectedRevision: 1, settings: { enableTerminalAgentHooks: true } });
  container.rejectPatch = true;
  const partial = await service.reconcile();
  expect(partial.sources.host).toEqual({ appliedRevision: 2, pendingRevision: null, error: null });
  expect(partial.sources.container).toEqual({
    appliedRevision: 1,
    pendingRevision: 2,
    error: "patch_failed",
  });
  expect(JSON.stringify(partial)).not.toContain("private patch diagnostic");
  container.rejectPatch = false;
  const restored = new InstallationSettingsService(journal, [host, container]);
  expect((await restored.reconcile()).sources.container.appliedRevision).toBe(2);
  expect(host.patches).toHaveLength(1);
  expect(container.patches).toHaveLength(1);
});

test("lost replies reconcile without a duplicate patch and acknowledgments are independently verified", async () => {
  const { service, host, container } = fixture();
  await service.reconcile();
  await service.update({ expectedRevision: 1, settings: { pluginsEnabled: true } });
  host.loseReply = true;
  container.ignorePatch = true;
  const uncertain = await service.reconcile();
  expect(uncertain.sources.host.error).toBe("patch_failed");
  expect(uncertain.sources.container.error).toBe("verification_failed");
  container.ignorePatch = false;
  expect((await service.reconcile()).sources.host.error).toBeNull();
  expect(host.patches).toHaveLength(1);
  expect(container.patches).toHaveLength(2);
});

test("exclusions filter terminal and metadata resources without divergent canonical definitions", async () => {
  const { service, host, container } = fixture();
  await service.reconcile();
  const terminalProfiles = [
    { id: "native", name: "Native tools", command: "/host/tool", args: ["run"] },
  ];
  await service.update({
    expectedRevision: 1,
    settings: {
      terminalProfiles,
      metadataGeneration: { providers: [{ provider: "native-account", model: "model-a" }] },
      resourceExclusions: {
        container: { terminalProfileIds: ["native"], metadataProviderIds: ["native-account"] },
      },
    },
  });
  const snapshot = await service.reconcile();
  expect(snapshot.settings?.terminalProfiles).toEqual(terminalProfiles);
  expect(host.config.terminalProfiles).toEqual(terminalProfiles);
  expect(container.config.terminalProfiles ?? []).toEqual([]);
  expect(container.config.metadataGeneration.providers).toEqual([]);
  expect(snapshot.sources.container.appliedRevision).toBe(2);
  await expect(
    service.update({
      expectedRevision: 2,
      settings: {
        resourceExclusions: {
          unknown: { terminalProfileIds: [], metadataProviderIds: [] },
        },
      },
    }),
  ).rejects.toBeInstanceOf(InstallationSettingsInvalidUpdate);
  const deleted = await service.update({ expectedRevision: 2, settings: { terminalProfiles: [] } });
  expect(deleted.settings?.resourceExclusions.container).toEqual({
    terminalProfileIds: [],
    metadataProviderIds: ["native-account"],
  });
});

test("browser policy is shared with preserved migration exceptions and private values stay local", async () => {
  const { service, host, container, journal } = fixture();
  host.config.providers = { privateAccount: { env: { API_KEY: "fixture-provider-secret" } } };
  host.config.browserTools = { enabled: false, privateToken: "fixture-browser-secret" };
  container.config.browserTools = { enabled: true };
  host.config.mcp = { injectIntoAgents: false, enabled: false, privateToken: "fixture-mcp-secret" };
  host.config.metadataGeneration = {
    providers: [{ provider: "account", env: { API_KEY: "fixture-metadata-secret" } }],
  };
  container.config.metadataGeneration = { providers: [{ provider: "account" }] };
  const migration = await service.reconcile();
  expect(migration.conflicts).toBeUndefined();
  expect(migration.settings?.browserTools).toEqual({ enabled: true });
  expect(migration.settings?.resourceExclusions.host?.browserTools).toBe(true);
  expect(migration.settings?.resourceExclusions.container?.browserTools).not.toBe(true);
  await service.update({
    expectedRevision: 1,
    settings: {
      metadataGeneration: { providers: [{ provider: "account" }] },
      mcp: { injectIntoAgents: true },
    },
  });
  await service.reconcile();
  const persisted = JSON.stringify({ state: journal.state, backups: journal.backups });
  for (const secret of [
    "fixture-provider-secret",
    "fixture-browser-secret",
    "fixture-mcp-secret",
    "fixture-metadata-secret",
  ])
    expect(persisted).not.toContain(secret);
  expect(host.config.browserTools.enabled).toBe(false);
  expect(host.config.browserTools.privateToken).toBe("fixture-browser-secret");
  expect(container.config.browserTools.enabled).toBe(true);
  expect(host.config.providers.privateAccount.env).toEqual({ API_KEY: "fixture-provider-secret" });
  expect(host.config.mcp.enabled).toBe(false);
  expect(host.config.metadataGeneration.providers[0].env).toEqual({
    API_KEY: "fixture-metadata-secret",
  });
  for (const patch of [...host.patches, ...container.patches]) {
    expect(patch.browserTools).toEqual({ enabled: expect.any(Boolean) });
    expect(patch).not.toHaveProperty("providers");
    expect(patch).not.toHaveProperty("resourceExclusions");
  }
});

test("stable terminal IDs retain each environment's private bindings across canonical edits", async () => {
  const { service, host, container, journal } = fixture();
  const profile = {
    id: "shell",
    name: "Shell",
    command: "old-shell",
    args: ["old-argument"],
    icon: "old-icon",
  };
  host.config.terminalProfiles = [
    {
      ...profile,
      cwd: "/host/private-directory",
      env: { TOKEN: "fixture-host-token" },
      localOption: "host-only",
    },
  ];
  container.config.terminalProfiles = [
    {
      ...profile,
      cwd: "/container/private-directory",
      env: { TOKEN: "fixture-container-token" },
      localOption: "container-only",
    },
  ];
  const migration = await service.reconcile();
  expect(migration.conflicts).toBeUndefined();
  expect(migration.settings?.terminalProfiles).toEqual([profile]);
  expect(host.patches).toEqual([]);
  expect(container.patches).toEqual([]);
  const edited = { id: "shell", name: "Shared shell", command: "new-shell" };
  await service.update({ expectedRevision: 1, settings: { terminalProfiles: [edited] } });
  await service.reconcile();
  expect(host.config.terminalProfiles).toEqual([
    {
      ...edited,
      cwd: "/host/private-directory",
      env: { TOKEN: "fixture-host-token" },
      localOption: "host-only",
    },
  ]);
  expect(container.config.terminalProfiles).toEqual([
    {
      ...edited,
      cwd: "/container/private-directory",
      env: { TOKEN: "fixture-container-token" },
      localOption: "container-only",
    },
  ]);
  const persisted = JSON.stringify({ state: journal.state, backups: journal.backups });
  for (const binding of [
    "fixture-host-token",
    "fixture-container-token",
    "/host/private-directory",
    "/container/private-directory",
    "localOption",
  ])
    expect(persisted).not.toContain(binding);
  expect(service.snapshot().settings?.terminalProfiles).toEqual([edited]);
});

test("backup and state failures prevent ownership changes or unjournaled projection", async () => {
  const { service, host, journal } = fixture();
  journal.failBackup = true;
  await expect(service.reconcile()).rejects.toThrow("backup unavailable");
  expect(service.snapshot().revision).toBe(0);
  expect(host.patches).toEqual([]);
  journal.failBackup = false;
  await service.reconcile();
  journal.failWrite = true;
  await expect(
    service.update({ expectedRevision: 1, settings: { pluginsEnabled: true } }),
  ).rejects.toThrow("journal unavailable");
  expect(service.snapshot().revision).toBe(1);
  journal.failWrite = false;
  await service.update({ expectedRevision: 1, settings: { pluginsEnabled: true } });
  journal.failBackup = true;
  await expect(service.reconcile()).rejects.toThrow("backup unavailable");
  expect(host.patches).toEqual([]);
  expect(service.snapshot().sources.host.pendingRevision).toBe(2);
});

test("snapshots are detached and an environment identity change requires operator migration", async () => {
  const { service, host, journal } = fixture();
  await service.reconcile();
  const copy = service.snapshot();
  if (copy.settings) copy.settings.appendSystemPrompt = "external mutation";
  expect(service.snapshot().settings?.appendSystemPrompt).toBe("");
  expect(
    () =>
      new InstallationSettingsService(journal, [host, new SettingsEnvironmentFake("replacement")]),
  ).toThrow(InstallationSettingsInvalidUpdate);
});

test("excluded resources retain private bindings through reconnect and re-enabling", async () => {
  const { service, host, container, journal } = fixture();
  const profile = { id: "shell", name: "Shell", command: "sh" };
  host.config.terminalProfiles = [{ ...profile, cwd: "/host", env: { TOKEN: "host-secret" } }];
  container.config.terminalProfiles = [{ ...profile, cwd: "/dev", env: { TOKEN: "dev-secret" } }];
  host.config.metadataGeneration.providers = [
    { provider: "codex", model: "m", token: "host-private" },
  ];
  container.config.metadataGeneration.providers = [
    { provider: "codex", model: "m", token: "dev-private" },
  ];
  await service.reconcile();
  await service.update({
    expectedRevision: 1,
    settings: {
      resourceExclusions: {
        container: { terminalProfileIds: ["shell"], metadataProviderIds: ["codex"] },
      },
    },
  });
  await service.reconcile();
  expect(container.config.terminalProfiles).toEqual([]);
  expect(container.config.metadataGeneration.providers).toEqual([]);
  const restarted = new InstallationSettingsService(journal, [host, container]);
  await restarted.reconcile();
  await restarted.update({ expectedRevision: 2, settings: { resourceExclusions: {} } });
  await restarted.reconcile();
  expect(container.config.terminalProfiles).toEqual([
    { ...profile, cwd: "/dev", env: { TOKEN: "dev-secret" } },
  ]);
  expect(container.config.metadataGeneration.providers).toEqual([
    { provider: "codex", model: "m", token: "dev-private" },
  ]);
  expect(container.config.installationResourceBindings).toEqual({
    terminalProfiles: [],
    metadataProviders: [],
  });
  expect(JSON.stringify(journal)).not.toContain("secret");
  expect(JSON.stringify(journal)).not.toContain("private");
});

test("plugin catalog migration preserves both inventories and needs explicit cross-environment review", async () => {
  const { host, container, service, journal } = fixture();
  const plugin = (id: string) => ({
    id,
    path: `/private/${id}`,
    enabled: true,
    status: "running" as const,
    installation: { identity: { kind: "directory" as const, path: `/private/${id}` } },
  });
  host.plugins = [plugin("host-only")];
  container.plugins = [plugin("dev-only")];
  const initial = await service.reconcile();
  expect(initial.conflicts?.fields).toContain("plugins");
  for (const candidate of Object.values(initial.conflicts!.candidates)) {
    expect(candidate.plugins?.map((entry) => entry.id)).toEqual(["dev-only", "host-only"]);
  }
  expect(JSON.stringify(journal.state)).not.toContain("/private/");
  expect(host.plugins).toHaveLength(1);
  expect(container.plugins).toHaveLength(1);
});

test("plugin exclusions persist before projection and retain disabled local copies", async () => {
  const { host, container, service, journal } = fixture();
  await service.reconcile();
  const plugins = [
    {
      id: "shared",
      enabled: true,
      source: {
        kind: "git" as const,
        id: "shared",
        identity: {
          kind: "git" as const,
          remote: "https://example.test/plugin.git",
          pluginPath: ".",
        },
        target: { kind: "git" as const, commit: "a".repeat(40) },
      },
    },
  ];
  await service.update({ expectedRevision: 1, settings: { plugins } });
  expect(journal.state?.settings?.plugins).toEqual(plugins);
  expect(host.plugins).toEqual([]);
  await service.reconcile();
  expect(host.plugins[0].enabled).toBe(true);
  expect(container.plugins[0].enabled).toBe(true);
  const savedPath = container.plugins[0].path;
  await service.update({
    expectedRevision: 2,
    settings: {
      resourceExclusions: {
        container: { terminalProfileIds: [], metadataProviderIds: [], pluginIds: ["shared"] },
      },
    },
  });
  container.offline = true;
  expect((await service.reconcile()).sources.container.pendingRevision).toBe(3);
  container.offline = false;
  const settled = await service.reconcile();
  expect(settled.sources.container.pendingRevision).toBeNull();
  expect(container.plugins[0]).toMatchObject({ enabled: false, path: savedPath });
  expect(host.plugins[0].enabled).toBe(true);
});

test("older journals import a plugin catalog without importing subsequent scalar drift", async () => {
  const { host, container, journal, service } = fixture();
  await service.reconcile();
  if (!journal.state?.settings) throw new Error("Fixture did not initialize");
  delete journal.state.settings.plugins;
  journal.state.settings.appendSystemPrompt = "Saved canonical instructions";
  host.config.appendSystemPrompt = "Later host drift";
  container.config.appendSystemPrompt = "Later dev drift";
  host.patches = [];
  container.patches = [];
  const restored = new InstallationSettingsService(journal, [host, container]);
  container.offline = true;
  const waiting = await restored.reconcile();
  expect(waiting.revision).toBe(1);
  expect(waiting.settings?.plugins).toBeUndefined();
  expect(waiting.sources.container.error).toBe("read_failed");
  expect(host.patches).toEqual([]);
  await expect(restored.update({ expectedRevision: 1, settings: { plugins: [] } })).rejects.toThrow(
    InstallationSettingsNotInitialized,
  );
  container.offline = false;
  const upgraded = await restored.reconcile();
  expect(upgraded.revision).toBe(2);
  expect(upgraded.settings).toMatchObject({
    plugins: [],
    appendSystemPrompt: "Saved canonical instructions",
  });
  expect(host.config.appendSystemPrompt).toBe("Saved canonical instructions");
  expect(container.config.appendSystemPrompt).toBe("Saved canonical instructions");
  const backup = journal.backups.find((entry) => entry.reason === "plugin-catalog-migration");
  expect(backup?.previous.settings?.plugins).toBeUndefined();
  expect(backup?.previous.settings?.appendSystemPrompt).toBe("Saved canonical instructions");
  expect(
    (await new InstallationSettingsService(journal, [host, container]).reconcile()).revision,
  ).toBe(2);
});

test("older unresolved journals preserve their policy choices while adding plugin review", async () => {
  const { host, container, journal, service } = fixture();
  host.config.autoArchiveAfterMerge = true;
  container.config.autoArchiveAfterMerge = false;
  await service.reconcile();
  if (!journal.state?.conflicts) throw new Error("Fixture did not create a conflict");
  for (const candidate of Object.values(journal.state.conflicts.candidates))
    delete candidate.plugins;
  host.plugins = [
    {
      id: "existing",
      path: "/private/existing",
      enabled: true,
      status: "running",
      installation: { identity: { kind: "directory", path: "/private/existing" } },
    },
  ];
  host.config.autoArchiveAfterMerge = false;
  const restored = new InstallationSettingsService(journal, [host, container]);
  const upgraded = await restored.reconcile();
  expect(upgraded.conflicts?.fields).toEqual(["autoArchiveAfterMerge", "plugins"]);
  expect(upgraded.conflicts?.candidates.host.autoArchiveAfterMerge).toBe(true);
  expect(upgraded.conflicts?.candidates.container.autoArchiveAfterMerge).toBe(false);
  expect(upgraded.conflicts?.candidates.container.plugins?.map((plugin) => plugin.id)).toEqual([
    "existing",
  ]);
  expect(host.patches).toEqual([]);
  expect(container.patches).toEqual([]);
  expect(JSON.stringify(upgraded)).not.toContain("/private/");
});

test("a failed upgrade backup cannot apply or acknowledge a migrated catalog", async () => {
  const { host, container, journal, service } = fixture();
  await service.reconcile();
  if (!journal.state?.settings) throw new Error("Fixture did not initialize");
  delete journal.state.settings.plugins;
  host.patches = [];
  container.patches = [];
  journal.failBackup = true;
  const restored = new InstallationSettingsService(journal, [host, container]);
  await expect(restored.reconcile()).rejects.toThrow("backup unavailable");
  expect(restored.snapshot().revision).toBe(1);
  expect(restored.snapshot().settings?.plugins).toBeUndefined();
  expect(host.patches).toEqual([]);
  expect(container.patches).toEqual([]);
});

test("personal skill migration shares the union and never imports later local catalog edits", async () => {
  const { service, host, container, journal } = fixture();
  const hostSkill = {
    name: "host-skill",
    source: null,
    sha256: "a".repeat(64),
    identity: `content:${"a".repeat(64)}`,
  };
  const devSkill = {
    name: "dev-skill",
    source: null,
    sha256: "b".repeat(64),
    identity: `content:${"b".repeat(64)}`,
  };
  host.skillCatalog = [hostSkill];
  container.skillCatalog = [devSkill];
  const migrated = await service.reconcile();
  expect(migrated.settings?.skillLibrary).toEqual([hostSkill, devSkill]);
  expect(host.skillCatalog).toEqual([hostSkill, devSkill]);
  expect(container.skillCatalog).toEqual([hostSkill, devSkill]);
  expect(migrated.sources.host.pendingRevision).toBeNull();
  host.skillCatalog = [];
  await service.reconcile();
  expect(service.snapshot().settings?.skillLibrary).toEqual([hostSkill, devSkill]);
  expect(host.skillCatalog).toEqual([hostSkill, devSkill]);
  const recovered = new InstallationSettingsService(journal, [host, container]);
  expect((await recovered.reconcile()).settings?.skillLibrary).toEqual([hostSkill, devSkill]);
});

test("older settings journals wait for both personal catalogs and preserve existing shared policy", async () => {
  const { service, host, container, journal } = fixture();
  await service.reconcile();
  await service.update({
    expectedRevision: 1,
    settings: { appendSystemPrompt: "Keep shared policy" },
  });
  const previous = service.snapshot();
  if (!previous.settings) throw new Error("Expected shared settings");
  delete previous.settings.skillLibrary;
  journal.state = previous;
  host.config.appendSystemPrompt = "Local drift";
  container.offline = true;
  const recovered = new InstallationSettingsService(journal, [host, container]);
  const waiting = await recovered.reconcile();
  expect(waiting.revision).toBe(2);
  expect(waiting.settings?.skillLibrary).toBeUndefined();
  expect(waiting.settings?.appendSystemPrompt).toBe("Keep shared policy");
  container.offline = false;
  const migrated = await recovered.reconcile();
  expect(migrated.revision).toBe(3);
  expect(migrated.settings?.skillLibrary).toEqual([]);
  expect(host.config.appendSystemPrompt).toBe("Keep shared policy");
  expect(journal.backups.at(-1)?.previous.revision).toBe(3);
});

test("skill migration retains differing versions and directory collisions for explicit review", async () => {
  const { service, host, container } = fixture();
  const source = { repository: "example/skills", directory: "shared", revision: "a".repeat(40) };
  const first = {
    name: "shared",
    source,
    sha256: "a".repeat(64),
    identity: "github:example/skills/shared",
  };
  const second = {
    ...first,
    sha256: "b".repeat(64),
    source: { ...source, revision: "b".repeat(40) },
  };
  host.skillCatalog = [first, second];
  container.skillCatalog = [
    { name: "shared", source: null, sha256: "c".repeat(64), identity: `content:${"c".repeat(64)}` },
  ];
  const waiting = await service.reconcile();
  expect(waiting.settings).toBeNull();
  expect(waiting.conflicts?.fields).toContain("skillLibrary");
  expect(waiting.conflicts?.candidates.host.skillLibrary).toContainEqual(first);
  expect(waiting.conflicts?.candidates.host.skillLibrary).toContainEqual(second);
  expect(waiting.conflicts?.candidates.host.skillLibrary).toContainEqual(container.skillCatalog[0]);
  expect(host.skillCatalog).toEqual([first, second]);
  await expect(
    service.update({
      expectedRevision: waiting.revision,
      settings: { skillLibrary: waiting.conflicts!.candidates.host.skillLibrary },
    }),
  ).rejects.toBeInstanceOf(InstallationSettingsInvalidUpdate);
  expect(service.snapshot()).toEqual(waiting);
});

test("skill exclusions retain installed packages and reject unknown identities", async () => {
  const { service, host, container } = fixture();
  const definition = {
    name: "shared",
    identity: `content:${"a".repeat(64)}`,
    sha256: "a".repeat(64),
    source: null,
  };
  host.skillCatalog = [definition];
  await service.reconcile();
  await service.update({
    expectedRevision: 1,
    settings: {
      resourceExclusions: {
        host: {
          terminalProfileIds: [],
          metadataProviderIds: [],
          skillIdentities: [definition.identity],
        },
      },
    },
  });
  const settled = await service.reconcile();
  expect(settled.sources.host.pendingRevision).toBeNull();
  expect(host.skillCatalog).toEqual([definition]);
  expect(container.skillCatalog).toEqual([definition]);
  await expect(
    service.update({
      expectedRevision: 2,
      settings: {
        resourceExclusions: {
          host: { terminalProfileIds: [], metadataProviderIds: [], skillIdentities: ["unknown"] },
        },
      },
    }),
  ).rejects.toBeInstanceOf(InstallationSettingsInvalidUpdate);
});

test("provider catalog saves once, projects portable changes and exclusions, and retains credentials on removal", async () => {
  const { service, host, container, journal } = fixture();
  const accountId = "f7c183ce-d44e-42f5-a2e5-ed2c8d4ab119";
  host.config.providers = {
    "host-account": {
      extends: "codex",
      installationAccountId: accountId,
      label: "Account",
      models: [{ id: "old", label: "Old" }],
      env: { TOKEN: "host-private" },
    },
  };
  container.config.providers = {
    "dev-account": {
      extends: "codex",
      installationAccountId: accountId,
      label: "Account",
      models: [{ id: "old", label: "Old" }],
      env: { TOKEN: "dev-private" },
    },
  };
  const initial = await service.reconcile();
  const definitions = initial.settings?.providerDefinitions;
  if (!definitions) throw new Error("Expected provider migration");
  expect(definitions).toHaveLength(1);
  expect(definitions[0].bindings).toEqual({ host: "host-account", container: "dev-account" });
  const changed = [{ ...definitions[0], policy: { label: "Shared account", enabled: true } }];
  const saved = await service.update({
    expectedRevision: initial.revision,
    settings: {
      providerDefinitions: changed,
      resourceExclusions: {
        container: {
          providerIds: [changed[0].id],
          terminalProfileIds: [],
          metadataProviderIds: [],
        },
      },
    },
  });
  expect(host.config.providers["host-account"].label).toBe("Account");
  expect(journal.state?.settings?.providerDefinitions).toEqual(changed);
  container.offline = true;
  const pending = await service.reconcile();
  expect(pending.sources.host.pendingRevision).toBeNull();
  expect(pending.sources.container.pendingRevision).toBe(saved.revision);
  expect(host.config.providers["host-account"]).toMatchObject({
    label: "Shared account",
    enabled: true,
    env: { TOKEN: "host-private" },
  });
  expect(host.config.providers["host-account"].models).toBeUndefined();
  container.offline = false;
  const applied = await service.reconcile();
  expect(applied.sources.container.pendingRevision).toBeNull();
  expect(container.config.providers["dev-account"]).toMatchObject({
    enabled: false,
    env: { TOKEN: "dev-private" },
  });
  host.config.providers["host-account"].label = "Local drift";
  await service.reconcile();
  expect(host.config.providers["host-account"].label).toBe("Shared account");
  await service.update({
    expectedRevision: applied.revision,
    settings: { providerDefinitions: [] },
  });
  await service.reconcile();
  expect(host.config.providers["host-account"]).toMatchObject({
    enabled: false,
    env: { TOKEN: "host-private" },
  });
  expect(container.config.providers["dev-account"].env).toEqual({ TOKEN: "dev-private" });
  expect(service.snapshot().settings?.resourceExclusions.container.providerIds).toEqual([]);
  for (const secret of ["host-private", "dev-private"])
    expect(JSON.stringify(journal)).not.toContain(secret);
});

test("older journals wait for both provider catalogs without importing unrelated policy drift", async () => {
  const { service, host, container, journal } = fixture();
  await service.reconcile();
  if (!journal.state?.settings) throw new Error("Expected migration");
  delete journal.state.settings.providerDefinitions;
  journal.state.settings.appendSystemPrompt = "Canonical instructions";
  host.config.appendSystemPrompt = "Local drift";
  host.config.providers = { codex: { label: "Host account" } };
  container.config.providers = { pi: { label: "Dev account" } };
  container.offline = true;
  const restored = new InstallationSettingsService(journal, [host, container]);
  expect((await restored.reconcile()).settings?.providerDefinitions).toBeUndefined();
  await expect(
    restored.update({ expectedRevision: 1, settings: { providerDefinitions: [] } }),
  ).rejects.toThrow(InstallationSettingsNotInitialized);
  container.offline = false;
  const migrated = await restored.reconcile();
  expect(migrated.revision).toBe(2);
  expect(migrated.settings?.providerDefinitions?.map((entry) => entry.policy.label).sort()).toEqual(
    ["Dev account", "Host account"],
  );
  expect(host.config.appendSystemPrompt).toBe("Canonical instructions");
  expect(journal.backups.some((backup) => backup.reason === "provider-catalog-migration")).toBe(
    true,
  );
});

test("provider catalog rejects duplicate bindings and unknown exclusions before canonical writes", async () => {
  const { service, host, journal } = fixture();
  host.config.providers = { codex: { label: "Account" } };
  const initial = await service.reconcile();
  const definition = initial.settings?.providerDefinitions?.[0];
  if (!definition) throw new Error("Expected definition");
  const previous = JSON.stringify(journal);
  await expect(
    service.update({
      expectedRevision: initial.revision,
      settings: { providerDefinitions: [definition, { ...definition, id: "duplicate-binding" }] },
    }),
  ).rejects.toThrow(InstallationSettingsInvalidUpdate);
  await expect(
    service.update({
      expectedRevision: initial.revision,
      settings: {
        resourceExclusions: {
          host: { providerIds: ["missing"], terminalProfileIds: [], metadataProviderIds: [] },
        },
      },
    }),
  ).rejects.toThrow(InstallationSettingsInvalidUpdate);
  expect(JSON.stringify(journal)).toBe(previous);
});

test.each([undefined, ""])(
  "custom provider label %s is rejected before canonical writes",
  async (label) => {
    const { service, host, journal } = fixture();
    host.config.providers = {
      "host-account": {
        extends: "codex",
        label: "Preserved account",
        env: { CODEX_HOME: "/private/account" },
      },
    };
    const initial = await service.reconcile();
    const definition = initial.settings?.providerDefinitions?.[0];
    if (!definition) throw new Error("Expected definition");
    const previous = JSON.stringify(journal);
    await expect(
      service.update({
        expectedRevision: initial.revision,
        settings: {
          providerDefinitions: [{ ...definition, policy: { ...definition.policy, label } }],
        },
      }),
    ).rejects.toThrow(InstallationSettingsInvalidUpdate);
    expect(JSON.stringify(journal)).toBe(previous);
    expect(host.config.providers["host-account"].label).toBe("Preserved account");
  },
);

test("durable account setup resumes after coordinator recovery and lost replies without duplicating local accounts", async () => {
  const { service, host, container, journal } = fixture();
  await service.reconcile();
  const creationId = "7a036ed7-5db5-4b4d-85f2-54c1d43ee333";
  const providerId = `codex-account-${creationId}`;
  const definition = {
    id: `managed/${creationId}`,
    providerType: "codex",
    accountSetup: { provider: "codex" as const, creationId },
    bindings: { host: providerId, container: providerId },
    policy: { label: "New shared account", enabled: true },
  };
  container.offline = true;
  host.loseAccountReply = true;
  const saved = await service.update({
    expectedRevision: service.snapshot().revision,
    settings: { providerDefinitions: [definition] },
  });
  expect(host.accountCreations).toEqual([]);
  expect(journal.state?.settings?.providerDefinitions).toEqual([definition]);
  await service.reconcile();
  expect(host.accountCreations).toEqual([providerId]);
  expect(service.snapshot().sources.host.error).toBe("account_binding_unavailable");
  expect(container.accountCreations).toEqual([]);
  const restored = new InstallationSettingsService(journal, [host, container]);
  container.offline = false;
  await restored.reconcile();
  expect(host.accountCreations).toEqual([providerId]);
  expect(container.accountCreations).toEqual([providerId]);
  expect(host.config.providers[providerId].env).not.toEqual(
    container.config.providers[providerId].env,
  );
  for (const status of Object.values(restored.snapshot().sources)) {
    expect(status.appliedRevision).toBe(saved.revision);
    expect(status.pendingRevision).toBeNull();
  }
  expect(JSON.stringify(journal.state)).not.toContain("LOCAL_ACCOUNT_HOME");
  await expect(
    restored.update({
      expectedRevision: saved.revision,
      settings: {
        providerDefinitions: [{ ...definition, bindings: { host: "another-account" } }],
      },
    }),
  ).rejects.toThrow("deterministic binding IDs");
  expect(restored.snapshot().revision).toBe(saved.revision);
});

test("excluded account bindings are not recreated after local removal or coordinator recovery", async () => {
  const { service, host, container, journal } = fixture();
  await service.reconcile();
  const creationId = "b1e45ec3-59b4-4a29-90c3-a50493180fc2";
  const providerId = `codex-account-${creationId}`;
  const definition = {
    id: `managed/${creationId}`,
    providerType: "codex",
    accountSetup: { provider: "codex" as const, creationId },
    bindings: { host: providerId, container: providerId },
    policy: { label: "Shared retained account", enabled: true },
  };
  const excluded = {
    host: { providerIds: [definition.id], terminalProfileIds: [], metadataProviderIds: [] },
  };
  await service.update({
    expectedRevision: service.snapshot().revision,
    settings: { providerDefinitions: [definition], resourceExclusions: excluded },
  });
  await service.reconcile();
  expect(host.accountCreations).toEqual([]);
  expect(host.config.providers[providerId]).toBeUndefined();
  expect(container.accountCreations).toEqual([providerId]);
  expect(service.snapshot().sources.host.pendingRevision).toBeNull();
  await service.update({
    expectedRevision: service.snapshot().revision,
    settings: { resourceExclusions: {} },
  });
  await service.reconcile();
  expect(host.accountCreations).toEqual([providerId]);
  await service.update({
    expectedRevision: service.snapshot().revision,
    settings: { resourceExclusions: excluded },
  });
  await service.reconcile();
  delete host.config.providers[providerId];
  const restored = new InstallationSettingsService(journal, [host, container]);
  await restored.reconcile();
  expect(host.accountCreations).toEqual([providerId]);
  expect(host.config.providers[providerId]).toBeUndefined();
  expect(container.config.providers[providerId].enabled).toBe(true);
  expect(restored.snapshot().settings?.providerDefinitions).toEqual([definition]);
  expect(restored.snapshot().sources.host.pendingRevision).toBeNull();
  expect(restored.snapshot().sources.host.error).toBeNull();
});

test("new plugin providers enroll once with only locally observed bindings and retain shared policy", async () => {
  const { service, host, container, journal } = fixture();
  await service.reconcile();
  await service.update({
    expectedRevision: 1,
    settings: {
      pluginsEnabled: true,
      plugins: [{ id: "agents", enabled: true, source: { kind: "directory" } }],
    },
  });
  await service.reconcile();
  host.plugins[0].providers = [{ id: "plugin-agent", label: "Plugin agent" }];
  host.config.providers["plugin-agent"] = { env: { PRIVATE: "host-secret" } };
  container.offline = true;
  const enrolled = await service.reconcile();
  const definition = enrolled.settings!.providerDefinitions!.find(
    (entry) => entry.id === "plugin/agents/plugin-agent",
  )!;
  expect(definition).toEqual({
    id: "plugin/agents/plugin-agent",
    providerType: "plugin-agent",
    bindings: { host: "plugin-agent" },
    policy: { label: "Plugin agent", enabled: true },
  });
  expect(journal.backups.some((backup) => backup.reason === "plugin-provider-enrollment")).toBe(
    true,
  );
  expect(host.config.providers["plugin-agent"]).toMatchObject({
    enabled: true,
    env: { PRIVATE: "host-secret" },
  });
  enrolled.settings!.providerDefinitions!.find((entry) => entry.id === definition.id)!.policy = {
    label: "Owner name",
    enabled: false,
  };
  await service.update({
    expectedRevision: enrolled.revision,
    settings: {
      providerDefinitions: enrolled.settings!.providerDefinitions!,
    },
  });
  container.offline = false;
  container.plugins[0].providers = [{ id: "plugin-agent", label: "Dev label" }];
  container.config.providers["plugin-agent"] = { env: { PRIVATE: "dev-secret" } };
  const both = await service.reconcile();
  expect(both.settings!.providerDefinitions!.find((entry) => entry.id === definition.id)).toEqual({
    ...definition,
    bindings: { host: "plugin-agent", container: "plugin-agent" },
    policy: { label: "Owner name", enabled: false },
  });
  expect(container.config.providers["plugin-agent"]).toMatchObject({
    label: "Owner name",
    enabled: false,
    env: { PRIVATE: "dev-secret" },
  });
  expect(JSON.stringify(journal.state)).not.toContain("secret");
  expect((await service.reconcile()).revision).toBe(both.revision);
});

test("older browser policy migration waits for both environments and preserves canonical values", async () => {
  const { service, host, container, journal } = fixture();
  await service.reconcile();
  if (!journal.state?.settings) throw new Error("Missing fixture settings");
  delete journal.state.settings.browserTools;
  const canonicalPrompt = journal.state.settings.appendSystemPrompt;
  host.config.appendSystemPrompt = "later local drift";
  host.config.browserTools.enabled = true;
  container.config.browserTools.enabled = false;
  container.offline = true;
  const restored = new InstallationSettingsService(journal, [host, container]);
  const pending = await restored.reconcile();
  expect(pending.settings?.browserTools).toBeUndefined();
  expect(pending.sources.container.error).toBe("read_failed");
  await expect(
    restored.update({
      expectedRevision: pending.revision,
      settings: { browserTools: { enabled: false } },
    }),
  ).rejects.toBeInstanceOf(InstallationSettingsNotInitialized);
  container.offline = false;
  const upgraded = await restored.reconcile();
  expect(upgraded.settings?.appendSystemPrompt).toBe(canonicalPrompt);
  expect(upgraded.settings?.browserTools).toEqual({ enabled: true });
  expect(upgraded.settings?.resourceExclusions.container.browserTools).toBe(true);
  expect(host.config.browserTools.enabled).toBe(true);
  expect(container.config.browserTools.enabled).toBe(false);
  const exclusions = structuredClone(upgraded.settings!.resourceExclusions);
  exclusions.container.browserTools = false;
  const saved = await restored.update({
    expectedRevision: upgraded.revision,
    settings: { resourceExclusions: exclusions },
  });
  expect(container.config.browserTools.enabled).toBe(false);
  await restored.reconcile();
  expect(container.config.browserTools.enabled).toBe(true);
  host.config.browserTools.enabled = false;
  await restored.reconcile();
  expect(host.config.browserTools.enabled).toBe(true);
  expect(restored.snapshot().revision).toBe(saved.revision);
});

test("owner changes commit while an environment read is pending without acknowledging stale projection", async () => {
  const { service, host, container } = fixture();
  await service.reconcile();
  const gate = Promise.withResolvers<void>();
  host.readGate = gate.promise;
  const projection = service.reconcile();
  await Promise.resolve();
  try {
    const saved = await service.update({ expectedRevision: 1, settings: { pluginsEnabled: true } });
    expect(saved.revision).toBe(2);
    expect(saved.sources.host.pendingRevision).toBe(2);
  } finally {
    gate.resolve();
    host.readGate = null;
  }
  await projection;
  expect(service.snapshot().settings?.pluginsEnabled).toBe(true);
  await service.reconcile();
  expect(host.config.pluginsEnabled).toBe(true);
  expect(container.config.pluginsEnabled).toBe(true);
  expect(service.snapshot().sources.host.appliedRevision).toBe(2);
});

test("a slow previous patch cannot acknowledge a newer owner revision", async () => {
  const { service, host, container } = fixture();
  await service.reconcile();
  await service.update({ expectedRevision: 1, settings: { appendSystemPrompt: "first" } });
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  host.patchGate = gate.promise;
  host.onPatch = started.resolve;
  const projection = service.reconcile();
  await started.promise;
  try {
    const saved = await service.update({
      expectedRevision: 2,
      settings: { appendSystemPrompt: "latest" },
    });
    expect(saved.revision).toBe(3);
  } finally {
    host.patchGate = null;
    host.onPatch = null;
    gate.resolve();
  }
  await projection;
  expect(service.snapshot().sources.host.pendingRevision).toBe(3);
  expect(service.snapshot().sources.host.appliedRevision).not.toBe(3);
  await service.reconcile();
  expect(host.config.appendSystemPrompt).toBe("latest");
  expect(container.config.appendSystemPrompt).toBe("latest");
  expect(service.snapshot().sources.host.appliedRevision).toBe(3);
});
