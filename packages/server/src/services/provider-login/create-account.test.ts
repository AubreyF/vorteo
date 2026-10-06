import { readInstallationSettings } from "../../server/execution-installation/settings/projection.js";
import type { InstallationSettingsAdmission } from "../../server/execution-installation/settings/admission.js";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "../../server/daemon-config-store.js";
import { loadPersistedConfig } from "../../server/persisted-config.js";
import { createCodexAccount } from "./create-account.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "codex-accounts-"));
  homes.push(paseoHome);
  const initial = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: {
      primary: { extends: "codex", label: "Primary", env: { CODEX_HOME: "/existing/home" } },
    },
    agentProfiles: [{ id: "preset", name: "Existing", provider: "primary" }],
  });
  return { paseoHome, store: new DaemonConfigStore(paseoHome, initial) };
}

it("persists distinct account homes without touching existing providers or presets", async () => {
  const f = fixture();
  const before = f.store.get();
  const first = await createCodexAccount({ ...f, creationId: randomUUID(), name: " Work " });
  const second = await createCodexAccount({ ...f, creationId: randomUUID(), name: "Personal" });
  const providers = f.store.get().providers;
  expect(first.name).toBe("Work");
  expect(providers[first.providerId]).toEqual({
    extends: "codex",
    label: "Work",
    enabled: true,
    env: { CODEX_HOME: path.join(f.paseoHome, "codex-accounts", first.providerId) },
  });
  expect(providers[first.providerId].env).not.toEqual(providers[second.providerId].env);
  expect(providers.primary).toEqual(before.providers.primary);
  expect(f.store.get().agentProfiles).toEqual(before.agentProfiles);
  expect(loadPersistedConfig(f.paseoHome).agents?.providers?.[first.providerId]).toEqual(
    providers[first.providerId],
  );
});

it("reconciles retries after reopening the store without allocating another account", async () => {
  const f = fixture();
  const creationId = randomUUID();
  const first = await createCodexAccount({ ...f, creationId, name: "Work" });
  const reopened = new DaemonConfigStore(f.paseoHome, f.store.get());
  await expect(
    createCodexAccount({ ...f, store: reopened, creationId, name: "Changed after timeout" }),
  ).resolves.toEqual(first);
  expect(Object.keys(reopened.get().providers)).toHaveLength(2);
});

it("rejects blank names, traversal identifiers, and conflicting configurations", async () => {
  const f = fixture();
  await expect(createCodexAccount({ ...f, creationId: randomUUID(), name: "  " })).rejects.toThrow(
    "account name",
  );
  await expect(
    createCodexAccount({ ...f, creationId: "../../existing", name: "Work" }),
  ).rejects.toThrow();
  const creationId = randomUUID();
  const providerId = `codex-account-${creationId}`;
  f.store.patch({
    providers: {
      [providerId]: { extends: "codex", label: "Existing", env: { CODEX_HOME: "/another/home" } },
    },
  });
  await expect(createCodexAccount({ ...f, creationId, name: "Work" })).rejects.toThrow(
    "already in use",
  );
  expect(f.store.get().providers[providerId].env).toEqual({ CODEX_HOME: "/another/home" });
});

it("persists isolated Claude account directories and reconciles retries without changing existing accounts", async () => {
  const { createClaudeAccount } = await import("./create-account.js");
  const f = fixture();
  const before = f.store.get();
  const creationId = randomUUID();
  const first = await createClaudeAccount({ ...f, creationId, name: " Claude Work " });
  const second = await createClaudeAccount({
    ...f,
    creationId: randomUUID(),
    name: "Claude Personal",
  });
  const providers = f.store.get().providers;
  expect(first.name).toBe("Claude Work");
  expect(providers[first.providerId]).toMatchObject({
    extends: "claude",
    label: "Claude Work",
    enabled: true,
    env: {
      CLAUDE_CONFIG_DIR: path.join(f.paseoHome, "claude-accounts", first.providerId),
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_FOUNDRY: "0",
    },
  });
  expect(providers[first.providerId].env).not.toEqual(providers[second.providerId].env);
  expect(providers.primary).toEqual(before.providers.primary);
  expect(f.store.get().agentProfiles).toEqual(before.agentProfiles);
  const reopened = new DaemonConfigStore(f.paseoHome, f.store.get());
  await expect(
    createClaudeAccount({ ...f, store: reopened, creationId, name: "Retry" }),
  ).resolves.toEqual(first);
  expect(loadPersistedConfig(f.paseoHome).agents?.providers?.[first.providerId]).toEqual(
    providers[first.providerId],
  );
});

it("creates only catalog-approved local bindings and applies canonical policy without copying credentials", async () => {
  const f = fixture();
  const binding = {
    installationId: randomUUID(),
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  const initial = MutableDaemonConfigSchema.parse({
    ...f.store.get(),
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const admission: InstallationSettingsAdmission = {
    ...binding,
    installationInstructions: "",
    settings: { ...readInstallationSettings(initial), providerDefinitions: [] },
  };
  const store = new DaemonConfigStore(f.paseoHome, initial, undefined, {
    installationSettingsReader: { read: async () => admission },
  });
  const creationId = randomUUID();
  const providerId = `codex-account-${creationId}`;
  const input = { paseoHome: f.paseoHome, store, creationId, name: "Local requested name" };
  await expect(createCodexAccount(input)).rejects.toThrow("shared provider catalog");
  expect(store.get().providers[providerId]).toBeUndefined();
  admission.settings.providerDefinitions = [
    {
      id: "pending-other",
      providerType: "codex",
      bindings: { host: "not-created-yet" },
      policy: {},
    },
    {
      id: "new-account",
      providerType: "codex",
      bindings: { host: providerId, container: providerId },
      policy: { label: "Canonical name", enabled: true, disallowedTools: ["WebSearch"] },
    },
  ];
  admission.settings.resourceExclusions.host = {
    terminalProfileIds: [],
    metadataProviderIds: [],
    providerIds: ["new-account"],
  };
  await expect(createCodexAccount(input)).rejects.toThrow("excluded");
  expect(store.get().providers[providerId]).toBeUndefined();
  admission.settings.resourceExclusions = {};
  const created = await createCodexAccount(input);
  expect(created).toEqual({ providerId, name: "Canonical name" });
  expect(store.get().providers[providerId]).toEqual({
    extends: "codex",
    label: "Canonical name",
    enabled: true,
    disallowedTools: ["WebSearch"],
    env: { CODEX_HOME: path.join(f.paseoHome, "codex-accounts", providerId) },
  });
  await expect(createCodexAccount(input)).resolves.toEqual(created);
  expect(store.get().providers.primary).toEqual(initial.providers.primary);
  expect(store.get().providers["not-created-yet"]).toBeUndefined();
});

it("does not recreate a removed account on a delayed setup retry", async () => {
  const f = fixture();
  const creationId = randomUUID();
  const account = await createCodexAccount({ ...f, creationId, name: "Retained account" });
  f.store.patch({ providers: { [account.providerId]: { removed: true, enabled: false } } });
  const before = f.store.get();
  await expect(createCodexAccount({ ...f, creationId, name: "Retry" })).rejects.toThrow(
    "Restore it in Settings",
  );
  expect(f.store.get()).toEqual(before);
});
