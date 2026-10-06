import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { planProviderRemoval, deleteManagedProviderCredentials } from "./removal.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "provider-removal-"));
  homes.push(paseoHome);
  const providerId = "codex-account-11111111-1111-4111-8111-111111111111";
  const home = path.join(paseoHome, "codex-accounts", providerId);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "auth.json"), "test credential", { mode: 0o600 });
  const providers = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: { [providerId]: { extends: "codex", label: "Work", env: { CODEX_HOME: home } } },
  }).providers;
  return {
    paseoHome,
    providerId,
    home,
    providers,
    defaultCodexHome: path.join(paseoHome, "external"),
    defaultClaudeHome: path.join(paseoHome, "external-claude"),
  };
}

it("deletes an exclusively managed account including credentials without touching external files", () => {
  const f = fixture();
  mkdirSync(f.defaultCodexHome);
  const externalAuth = path.join(f.defaultCodexHome, "auth.json");
  writeFileSync(externalAuth, "external credential");
  symlinkSync(f.defaultCodexHome, path.join(f.home, "external-link"));
  const plan = planProviderRemoval(f);
  expect(plan.credentials).toBe("managed");
  deleteManagedProviderCredentials(f, plan.revision);
  expect(existsSync(f.home)).toBe(false);
  expect(existsSync(externalAuth)).toBe(true);
});

it("retains shared credentials even when the other connection is disabled or uses a symlink", () => {
  const f = fixture();
  const alias = path.join(f.paseoHome, "alias");
  symlinkSync(f.home, alias);
  f.providers.other = {
    extends: "codex",
    label: "Other account",
    enabled: false,
    env: { CODEX_HOME: alias },
  };
  const plan = planProviderRemoval(f);
  expect(plan.credentials).toBe("shared");
  expect(plan.sharedWith).toEqual(["Other account"]);
  deleteManagedProviderCredentials(f, plan.revision);
  expect(existsSync(path.join(f.home, "auth.json"))).toBe(true);
});

it("retains external CLI credentials and rejects changed confirmation revisions", () => {
  const f = fixture();
  const plan = planProviderRemoval(f);
  f.providers[f.providerId].env = { CODEX_HOME: f.defaultCodexHome };
  expect(() => deleteManagedProviderCredentials(f, plan.revision)).toThrow("changed");
  expect(planProviderRemoval(f).credentials).toBe("shared");
  f.providers[f.providerId].env = { CODEX_HOME: path.join(f.paseoHome, "another-cli") };
  expect(planProviderRemoval(f).credentials).toBe("external");
  expect(existsSync(path.join(f.home, "auth.json"))).toBe(true);
});

it("does not treat symlink escapes or arbitrary directory names as managed accounts", () => {
  const f = fixture();
  rmSync(f.home, { recursive: true });
  mkdirSync(f.defaultCodexHome);
  symlinkSync(f.defaultCodexHome, f.home);
  expect(planProviderRemoval(f).credentials).toBe("shared");
  f.providers[f.providerId].env = {
    CODEX_HOME: path.join(f.paseoHome, "codex-accounts", "unowned"),
  };
  expect(planProviderRemoval(f).credentials).toBe("external");
});

it("handles accounts that have never signed in and refuses built-in deletion", () => {
  const f = fixture();
  rmSync(f.home, { recursive: true });
  const plan = planProviderRemoval(f);
  expect(() => deleteManagedProviderCredentials(f, plan.revision)).not.toThrow();
  f.providers.codex = { enabled: true };
  expect(() => planProviderRemoval({ ...f, providerId: "codex" })).toThrow("Built-in");
});

it("rejects legacy config removal that would orphan managed credentials, including shared batches", async () => {
  const { DaemonConfigStore } = await import("../../server/daemon-config-store.js");
  const f = fixture();
  const store = new DaemonConfigStore(
    f.paseoHome,
    MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false }, providers: f.providers }),
  );
  expect(() => store.patch({ removeProviders: [f.providerId] })).toThrow("connection deletion");
  store.patch({
    providers: { alias: { extends: "codex", label: "Alias", env: { CODEX_HOME: f.home } } },
  });
  expect(() => store.patch({ removeProviders: [f.providerId, "alias"] })).toThrow(
    "connection deletion",
  );
  store.patch({ removeProviders: [f.providerId] });
  expect(existsSync(path.join(f.home, "auth.json"))).toBe(true);
  const input = { ...f, providerId: "alias", providers: store.get().providers };
  const plan = planProviderRemoval(input);
  deleteManagedProviderCredentials(input, plan.revision);
  store.patch({ removeProviders: ["alias"] });
  expect(existsSync(f.home)).toBe(false);
});

it("refuses a managed-directory symlink instead of claiming its target credentials were deleted", () => {
  const f = fixture();
  const target = path.join(
    f.paseoHome,
    "codex-accounts",
    "codex-account-22222222-2222-4222-8222-222222222222",
  );
  mkdirSync(target);
  writeFileSync(path.join(target, "auth.json"), "test credential");
  rmSync(f.home, { recursive: true });
  symlinkSync(target, f.home);
  const plan = planProviderRemoval(f);
  expect(plan.credentials).toBe("managed");
  expect(() => deleteManagedProviderCredentials(f, plan.revision)).toThrow("symbolic link");
  expect(existsSync(path.join(target, "auth.json"))).toBe(true);
});

it("removes only exclusively managed Claude files and preserves aliases and external CLI homes", () => {
  const f = fixture();
  const providerId = f.providerId.replace("codex", "claude");
  const home = path.join(f.paseoHome, "claude-accounts", providerId);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".credentials.json"), "test credential");
  const input = {
    ...f,
    providerId,
    defaultClaudeHome: path.join(f.paseoHome, "external-claude"),
    providers: MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      providers: {
        [providerId]: { extends: "claude", env: { CLAUDE_CONFIG_DIR: home } },
        alias: { extends: "claude", enabled: false, env: { CLAUDE_CONFIG_DIR: home } },
      },
    }).providers,
  };
  const shared = planProviderRemoval(input);
  expect(shared.credentials).toBe("shared");
  deleteManagedProviderCredentials(input, shared.revision);
  expect(existsSync(home)).toBe(true);
  delete input.providers.alias;
  const exclusive = planProviderRemoval(input);
  expect(exclusive.credentials).toBe("managed");
  expect(() => deleteManagedProviderCredentials(input, shared.revision)).toThrow("changed");
  deleteManagedProviderCredentials(input, exclusive.revision);
  expect(existsSync(home)).toBe(false);
  expect(existsSync(f.home)).toBe(true);
  input.providers[providerId].env = { CLAUDE_CONFIG_DIR: input.defaultClaudeHome };
  expect(planProviderRemoval(input).credentials).toBe("shared");
});

it("requires managed deletion before a legacy config patch can remove a Claude account", async () => {
  const { DaemonConfigStore } = await import("../../server/daemon-config-store.js");
  const { createClaudeAccount } = await import("./create-account.js");
  const f = fixture();
  const store = new DaemonConfigStore(
    f.paseoHome,
    MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      providers: {},
    }),
  );
  const { providerId } = await createClaudeAccount({
    paseoHome: f.paseoHome,
    store,
    name: "Work",
    creationId: "33333333-3333-4333-8333-333333333333",
  });
  const home = path.join(f.paseoHome, "claude-accounts", providerId);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".credentials.json"), "test credential");
  expect(() => store.patch({ removeProviders: [providerId] })).toThrow("connection deletion");
  const input = { ...f, providerId, providers: store.get().providers };
  deleteManagedProviderCredentials(input, planProviderRemoval(input).revision);
  expect(() => store.patch({ removeProviders: [providerId] })).not.toThrow();
});

for (const providerId of ["antigravity", "muse"]) {
  it(`allows deleting ${providerId} without touching CLI credentials`, () => {
    const f = fixture();
    f.providers[providerId] = { enabled: false };
    const input = { ...f, providerId };
    const plan = planProviderRemoval(input);
    expect(plan.credentials).toBe("external");
    expect(deleteManagedProviderCredentials(input, plan.revision)).toEqual(plan);
    expect(existsSync(path.join(f.home, "auth.json"))).toBe(true);
  });
}

it("retains deletion confirmation across policy projection but rejects account identity changes", () => {
  const f = fixture();
  const plan = planProviderRemoval(f);
  f.providers[f.providerId].enabled = false;
  f.providers[f.providerId].models = [{ id: "new-model", label: "New model" }];
  f.providers.unrelated = {
    extends: "codex",
    label: "Unrelated",
    env: { CODEX_HOME: path.join(f.paseoHome, "unrelated") },
  };
  expect(planProviderRemoval(f).revision).toBe(plan.revision);
  f.providers[f.providerId].installationAccountId = "799c2e5f-63c0-4776-90f6-d094a4b718c5";
  expect(() => deleteManagedProviderCredentials(f, plan.revision)).toThrow("changed");
  expect(existsSync(path.join(f.home, "auth.json"))).toBe(true);
  delete f.providers[f.providerId].installationAccountId;
  f.providers[f.providerId].env!.EXTRA_TOKEN = "changed credential";
  expect(() => deleteManagedProviderCredentials(f, plan.revision)).toThrow("changed");
  expect(existsSync(path.join(f.home, "auth.json"))).toBe(true);
  delete f.providers[f.providerId].env!.EXTRA_TOKEN;
  f.providers[f.providerId].label = "Different account name";
  expect(() => deleteManagedProviderCredentials(f, plan.revision)).toThrow("changed");
  expect(existsSync(path.join(f.home, "auth.json"))).toBe(true);
});
