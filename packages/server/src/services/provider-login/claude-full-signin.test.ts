import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { ClaudeAccountCreateRequestSchema } from "@getpaseo/protocol/provider-login";
import { DaemonConfigStore } from "../../server/daemon-config-store.js";
import { createClaudeAccount } from "./create-account.js";
import { ClaudeAgentClient } from "../../server/agent/providers/claude/agent.js";
import { createProviderEnv } from "../../server/agent/provider-launch-config.js";
import {
  deleteManagedProviderCredentials,
  planProviderRemoval,
  signOutClaudeFullSignIn,
} from "./removal.js";
import { ClaudeLoginSession } from "../../server/agent/providers/claude/login.js";
import { ClaudeSetupTokenLoginSession } from "../../server/agent/providers/claude/setup-token-login.js";
import {
  claudeSetupTokenStore,
  readClaudeSetupToken,
} from "../../server/agent/providers/claude/setup-token-runtime.js";
import {
  CLAUDE_SIGN_IN_ENV,
  claudeSignInMode,
} from "../../server/agent/providers/claude/sign-in-mode.js";

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function temporary(prefix: string) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  homes.push(directory);
  return directory;
}
function fixture() {
  const paseoHome = temporary("claude-full-accounts-");
  const initial = MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } });
  return { paseoHome, store: new DaemonConfigStore(paseoHome, initial) };
}
const SYNTHETIC_SETUP_TOKEN = {
  version: 1,
  accessToken: "sk-ant-oat01-synthetic_test_token_not_real_0123456789",
  createdAt: 1,
};

it("accepts an optional sign-in type and keeps setup-token as the default", () => {
  const base = {
    type: "provider.claude.create_account.request",
    requestId: "r",
    creationId: randomUUID(),
    name: "Work",
  };
  expect(ClaudeAccountCreateRequestSchema.parse(base).signIn).toBeUndefined();
  expect(ClaudeAccountCreateRequestSchema.parse({ ...base, signIn: "full" }).signIn).toBe("full");
  expect(() => ClaudeAccountCreateRequestSchema.parse({ ...base, signIn: "keychain" })).toThrow();
});

it("marks a full sign-in account in its binding and keeps credential isolation", async () => {
  const f = fixture();
  const full = await createClaudeAccount({
    ...f,
    creationId: randomUUID(),
    name: "Max",
    signIn: "full",
  });
  const token = await createClaudeAccount({ ...f, creationId: randomUUID(), name: "Token" });
  const providers = f.store.get().providers;
  const fullEnv = providers[full.providerId].env ?? {};
  expect(fullEnv[CLAUDE_SIGN_IN_ENV]).toBe("full");
  expect(fullEnv.CLAUDE_CONFIG_DIR).toBe(
    path.join(f.paseoHome, "claude-accounts", full.providerId),
  );
  // Inherited daemon credentials stay cleared for both types.
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
    expect(fullEnv[key]).toBe("");
  expect(providers[token.providerId].env?.[CLAUDE_SIGN_IN_ENV]).toBeUndefined();
  expect(claudeSignInMode(fullEnv)).toBe("full");
  expect(claudeSignInMode(providers[token.providerId].env)).toBe("setup-token");
});

it("retries keep the original type and a changed type is refused", async () => {
  const f = fixture();
  const creationId = randomUUID();
  const first = await createClaudeAccount({ ...f, creationId, name: "Max", signIn: "full" });
  await expect(
    createClaudeAccount({ ...f, creationId, name: "Max", signIn: "full" }),
  ).resolves.toEqual(first);
  await expect(createClaudeAccount({ ...f, creationId, name: "Max" })).rejects.toThrow(
    "already in use",
  );
  const tokenId = randomUUID();
  await createClaudeAccount({ ...f, creationId: tokenId, name: "Token" });
  await expect(
    createClaudeAccount({ ...f, creationId: tokenId, name: "Token", signIn: "full" }),
  ).rejects.toThrow("already in use");
});

it("never injects a setup token for a full sign-in account, managed or not", async () => {
  const home = temporary("claude-full-home-");
  // A stray setup token in the full account's home must be ignored.
  await claudeSetupTokenStore(home).write(SYNTHETIC_SETUP_TOKEN);
  const full = { CLAUDE_CONFIG_DIR: home, [CLAUDE_SIGN_IN_ENV]: "full" };
  await expect(readClaudeSetupToken(full)).resolves.toBeNull();
  // Without a delivery receipt a managed setup-token account is refused, a full account is not.
  vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", "/managed/client.json");
  await expect(readClaudeSetupToken(full)).resolves.toBeNull();
  await expect(readClaudeSetupToken({ CLAUDE_CONFIG_DIR: home })).rejects.toThrow();
});

it("opens web sign-in for a full account and setup-token sign-in otherwise", async () => {
  vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", "");
  delete process.env.VORTEO_INSTALLATION_CLIENT_CONFIG;
  const bin = temporary("claude-fake-cli-");
  const executable = path.join(bin, "claude");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const logger = pino({ level: "silent" });
  const open = async (env: Record<string, string>) => {
    const client = new ClaudeAgentClient({
      logger,
      runtimeSettings: { command: { mode: "replace", argv: [executable] }, env },
    });
    const session = await client.openAccountLoginSession();
    await session.dispose();
    return session;
  };
  const fullHome = temporary("claude-full-login-");
  const tokenHome = temporary("claude-token-login-");
  const full = await open({ CLAUDE_CONFIG_DIR: fullHome, [CLAUDE_SIGN_IN_ENV]: "full" });
  const token = await open({ CLAUDE_CONFIG_DIR: tokenHome });
  expect(full).toBeInstanceOf(ClaudeLoginSession);
  expect(full.scope).toBe(fullHome);
  expect(token).toBeInstanceOf(ClaudeSetupTokenLoginSession);
});

it("launches a full account only against its own config directory's grant", () => {
  const inherited = {
    PATH: "/usr/bin",
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "/shared/secure",
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "synthetic-inherited-refresh",
    CLAUDE_CODE_OAUTH_SCOPES: "user:inference",
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    CLAUDE_CODE_USE_BEDROCK: "1",
  };
  const full = createProviderEnv({
    baseEnv: inherited,
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: "/accounts/full", [CLAUDE_SIGN_IN_ENV]: "full" } },
  });
  expect(full.CLAUDE_CONFIG_DIR).toBe("/accounts/full");
  expect(full[CLAUDE_SIGN_IN_ENV]).toBe("full");
  // Absent, never empty: an empty value would select the shared default Keychain item.
  expect("CLAUDE_SECURESTORAGE_CONFIG_DIR" in full).toBe(false);
  expect("CLAUDE_CODE_OAUTH_SCOPES" in full).toBe(false);
  expect("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST" in full).toBe(false);
  expect(full.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("");
  expect(full.CLAUDE_CODE_USE_BEDROCK).toBe("0");
  expect(full.PATH).toBe("/usr/bin");
  // Setup-token launches are unchanged here; their credential overlay is applied per launch.
  const token = createProviderEnv({
    baseEnv: inherited,
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: "/accounts/token" } },
  });
  expect(token.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/shared/secure");
  expect(token.CLAUDE_CODE_USE_BEDROCK).toBe("1");
});

it("ignores a sign-in marker inherited from the daemon's own environment", async () => {
  const home = temporary("claude-inherited-marker-");
  await claudeSetupTokenStore(home).write(SYNTHETIC_SETUP_TOKEN);
  const env = createProviderEnv({
    baseEnv: { [CLAUDE_SIGN_IN_ENV]: "full" },
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: home } },
  });
  expect(env[CLAUDE_SIGN_IN_ENV]).toBeUndefined();
  expect(claudeSignInMode(env)).toBe("setup-token");
  await expect(readClaudeSetupToken(env)).resolves.toMatchObject({
    accessToken: SYNTHETIC_SETUP_TOKEN.accessToken,
  });
});

it("keeps refusing local sign-in inside a managed installation for both types", async () => {
  vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", "/managed/client.json");
  const client = new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
    runtimeSettings: {
      env: { CLAUDE_CONFIG_DIR: temporary("claude-managed-"), [CLAUDE_SIGN_IN_ENV]: "full" },
    },
  });
  await expect(client.openAccountLoginSession()).rejects.toThrow(
    "installation subscription controls",
  );
});

describe("removing a full sign-in account", () => {
  const ACCOUNT = "claude-account-00000000-0000-4000-8000-000000000001";
  function removalFixture(exitCode: number, signIn?: "full") {
    const paseoHome = temporary("claude-removal-");
    const home = path.join(paseoHome, "claude-accounts", ACCOUNT);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, ".credentials.json"), "{}");
    const record = path.join(paseoHome, "logout-record");
    const cli = path.join(paseoHome, "fake-claude");
    writeFileSync(
      cli,
      `#!/bin/sh\nprintf '%s|%s' "$CLAUDE_CONFIG_DIR" "$*" > "$RECORD"\nexit ${exitCode}\n`,
    );
    chmodSync(cli, 0o755);
    const input = {
      paseoHome,
      providerId: ACCOUNT,
      defaultCodexHome: temporary("codex-default-"),
      defaultClaudeHome: temporary("claude-default-"),
      providers: {
        [ACCOUNT]: {
          extends: "claude",
          label: "Max",
          command: [cli],
          env: {
            CLAUDE_CONFIG_DIR: home,
            RECORD: record,
            ...(signIn ? { [CLAUDE_SIGN_IN_ENV]: signIn } : {}),
          },
        },
      },
    };
    return { input, home, record };
  }

  it("signs out with the account's own CLI and directory, then deletes it", async () => {
    const { input, home, record } = removalFixture(0, "full");
    const { revision } = planProviderRemoval(input);
    await expect(signOutClaudeFullSignIn(input, revision)).resolves.toBeNull();
    expect(readFileSync(record, "utf8")).toBe(`${home}|auth logout`);
    deleteManagedProviderCredentials(input, revision);
    expect(existsSync(home)).toBe(false);
  });

  it("reports a failed sign-out without blocking deletion", async () => {
    const { input, home } = removalFixture(1, "full");
    const { revision } = planProviderRemoval(input);
    const warning = await signOutClaudeFullSignIn(input, revision);
    expect(warning).toContain("Claude sign-out did not finish for Max");
    deleteManagedProviderCredentials(input, revision);
    expect(existsSync(home)).toBe(false);
  });

  it("runs nothing for setup-token accounts or a stale review", async () => {
    const token = removalFixture(0);
    await expect(
      signOutClaudeFullSignIn(token.input, planProviderRemoval(token.input).revision),
    ).resolves.toBeNull();
    expect(existsSync(token.record)).toBe(false);
    const full = removalFixture(0, "full");
    await expect(signOutClaudeFullSignIn(full.input, "stale")).resolves.toBeNull();
    expect(existsSync(full.record)).toBe(false);
  });
});
