import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { loadPersistedConfig } from "../../persisted-config.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("installation profile caches reject local redefinition, detachment and downgrade", () => {
  const home = mkdtempSync(join(tmpdir(), "installation-profile-cache-"));
  homes.push(home);
  const initial = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    agentProfiles: [{ id: "review", name: "Review", provider: "codex", model: "astra" }],
  });
  const store = new DaemonConfigStore(home, initial);
  const migrated = store.initializeProviderPreferences().sharedProviderPreferences;
  if (!migrated) throw new Error("missing migration");
  const projection = structuredClone(migrated);
  projection.installation = {
    installationId: "00000000-0000-4000-8000-000000000001",
    environment: "host",
    serverId: "host",
    revision: 1,
  };
  store.patch({
    sharedProviderPreferences: projection,
    expectedProviderPreferencesRevision: migrated.revision,
  });
  const saved = structuredClone(store.get().sharedProviderPreferences);
  if (!saved) throw new Error("missing projection");
  const edited = structuredClone(saved);
  edited.providers.codex.defaults.model = "other";
  expect(() =>
    store.patch({
      sharedProviderPreferences: edited,
      expectedProviderPreferencesRevision: saved.revision,
    }),
  ).toThrow("installation coordinator");
  const detached = structuredClone(saved);
  delete detached.installation;
  expect(() =>
    store.patch({
      sharedProviderPreferences: detached,
      expectedProviderPreferencesRevision: saved.revision,
    }),
  ).toThrow("cannot be replaced");
  expect(() => store.patch({ agentProfiles: [] })).toThrow("installation coordinator");
  expect(store.get().sharedProviderPreferences).toEqual(saved);
  expect(loadPersistedConfig(home).daemon?.sharedProviderPreferences).toEqual(saved);
  const next = structuredClone(saved);
  if (!next.installation) throw new Error("missing installation");
  next.installation.revision = 2;
  next.providers.codex.defaults.model = "next";
  store.patch({
    sharedProviderPreferences: next,
    expectedProviderPreferencesRevision: saved.revision,
  });
  expect(store.get().sharedProviderPreferences?.providers.codex.defaults.model).toBe("next");
  expect(() =>
    store.patch({
      sharedProviderPreferences: saved,
      expectedProviderPreferencesRevision: saved.revision + 1,
    }),
  ).toThrow("cannot be replaced or downgraded");
});

test("migration backs up first, survives restart, and rejects concurrent edits without losing deletions", () => {
  const home = mkdtempSync(join(tmpdir(), "provider-preferences-"));
  homes.push(home);
  const initial = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    agentProfiles: [{ id: "review", name: "Review", provider: "codex", model: "astra" }],
  });
  const store = new DaemonConfigStore(home, initial);
  const migrated = store.initializeProviderPreferences().sharedProviderPreferences!;
  expect(migrated.revision).toBe(1);
  const directory = join(home, "backups", "provider-preferences-v1");
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  const receipt = join(directory, files[0]);
  expect(JSON.parse(readFileSync(receipt, "utf8")).profiles).toEqual(initial.agentProfiles);
  const restarted = new DaemonConfigStore(home, {
    ...initial,
    sharedProviderPreferences: loadPersistedConfig(home).daemon?.sharedProviderPreferences,
  });
  restarted.initializeProviderPreferences();
  expect(readdirSync(directory)).toEqual(files);
  const next = structuredClone(migrated);
  delete next.providers.codex.defaults.model;
  next.providers.codex.preferredModels = [];
  restarted.patch({ sharedProviderPreferences: next, expectedProviderPreferencesRevision: 1 });
  expect(restarted.get().sharedProviderPreferences).toEqual({ ...next, revision: 2 });
  expect(() =>
    restarted.patch({
      sharedProviderPreferences: migrated,
      expectedProviderPreferencesRevision: 1,
    }),
  ).toThrow("another device");
  expect(loadPersistedConfig(home).daemon?.sharedProviderPreferences).toEqual({
    ...next,
    revision: 2,
  });
  restarted.onApply(() => {
    throw new Error("Configuration owner refused the change");
  });
  expect(() =>
    restarted.patch({
      sharedProviderPreferences: migrated,
      expectedProviderPreferencesRevision: 2,
    }),
  ).toThrow("Configuration owner refused");
  expect(restarted.get().sharedProviderPreferences).toEqual({ ...next, revision: 2 });
  expect(loadPersistedConfig(home).daemon?.sharedProviderPreferences).toEqual({
    ...next,
    revision: 2,
  });
});

test("legacy edits detach only the edited binding and make an open shared editor stale", () => {
  const home = mkdtempSync(join(tmpdir(), "provider-preferences-"));
  homes.push(home);
  const profiles = [
    { id: "one", name: "One", provider: "codex", model: "astra" },
    { id: "two", name: "Two", provider: "codex", model: "astra" },
  ];
  const store = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false }, agentProfiles: profiles }),
  );
  const shared = store.initializeProviderPreferences().sharedProviderPreferences!;
  const edited = profiles.map((profile) =>
    profile.id === "one" ? { ...profile, instructions: "Review only" } : profile,
  );
  store.patch({ agentProfiles: edited, expectedAgentProfiles: profiles });
  const next = store.get().sharedProviderPreferences!;
  expect(next.revision).toBe(shared.revision + 1);
  expect(next.legacyProfiles.one).toBeUndefined();
  expect(next.legacyProfiles.two).toEqual(shared.legacyProfiles.two);
  expect(next.providers).toEqual(shared.providers);
  expect(store.get().agentProfiles).toEqual(edited);
  expect(() =>
    store.patch({
      sharedProviderPreferences: shared,
      expectedProviderPreferencesRevision: shared.revision,
    }),
  ).toThrow("another device");
});

test("an older editor cannot erase local migrated workflow aliases", () => {
  const home = mkdtempSync(join(tmpdir(), "provider-preferences-"));
  homes.push(home);
  const store = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      agentProfiles: [{ id: "review", name: "Review", provider: "codex", model: "astra" }],
    }),
  );
  const initial = store.initializeProviderPreferences().sharedProviderPreferences!;
  const workflowId = initial.providers.codex.workflows[0].id;
  const aliases = { codex: { "old-draft": workflowId } };
  store.patch({
    sharedProviderPreferences: { ...initial, workflowAliases: aliases },
    expectedProviderPreferencesRevision: initial.revision,
  });
  const olderEditor = structuredClone(store.get().sharedProviderPreferences!);
  delete olderEditor.workflowAliases;
  olderEditor.providers.codex.workflows[0].name = "Edited";
  store.patch({
    sharedProviderPreferences: olderEditor,
    expectedProviderPreferencesRevision: olderEditor.revision,
  });
  expect(store.get().sharedProviderPreferences?.workflowAliases).toEqual(aliases);
  expect(loadPersistedConfig(home).daemon?.sharedProviderPreferences?.workflowAliases).toEqual(
    aliases,
  );
});

test.runIf(process.platform !== "win32")("migration backups are private on POSIX", () => {
  const home = mkdtempSync(join(tmpdir(), "provider-preferences-mode-"));
  homes.push(home);
  const store = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
  );
  store.initializeProviderPreferences();
  const directory = join(home, "backups", "provider-preferences-v1");
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  expect(statSync(join(directory, files[0])).mode & 0o777).toBe(0o600);
});
