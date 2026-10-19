import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import {
  ClaudeQuotaProvider,
  claudeKeychainAccount,
  claudeKeychainServiceForConfigDir,
  readClaudeAccountKeychainCredentials,
} from "./claude.js";
import { createProviderUsageFetchers } from "../manifest.js";
import { CLAUDE_SIGN_IN_ENV } from "../../../server/agent/providers/claude/sign-in-mode.js";

const logger = pino({ level: "silent" });
const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    homes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function home() {
  const directory = await mkdtemp(join(tmpdir(), "claude-full-quota-"));
  homes.push(directory);
  return directory;
}
const usageResponse = () =>
  Response.json({ five_hour: { utilization: 21 }, seven_day: { utilization: 63 } });
const credentials = (accessToken: string) => ({
  claudeAiOauth: { accessToken, subscriptionType: "max", rateLimitTier: "default_claude_max_20x" },
});

it("shows a full sign-in account's usage from its own credentials inside a managed installation", async () => {
  vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", "/managed/client.json");
  const account = await home();
  await writeFile(join(account, ".credentials.json"), JSON.stringify(credentials("full-token")));
  const tokens: Array<string | null> = [];
  const provider = new ClaudeQuotaProvider({
    logger,
    providerId: "claude-account-full",
    claudeHome: account,
    strictClaudeHome: true,
    signIn: "full",
    platform: "linux",
    fetch: async (url, init) => {
      expect(String(url)).toBe("https://api.anthropic.com/api/oauth/usage");
      tokens.push(new Headers(init?.headers).get("Authorization"));
      return usageResponse();
    },
  });
  const usage = await provider.fetchUsage();
  expect(tokens).toEqual(["Bearer full-token"]);
  expect(usage.status).toBe("available");
  expect(usage.planLabel).toBe("Max 20x");
  expect(usage.windows.map((window) => [window.id, window.usedPct])).toEqual([
    ["five_hour", 21],
    ["weekly", 63],
  ]);
});

it("keeps a setup-token account truthfully unavailable even with native credentials present", async () => {
  const account = await home();
  await mkdir(join(account, ".vorteo-auth"));
  await writeFile(join(account, ".credentials.json"), JSON.stringify(credentials("older-grant")));
  const fetch = vi.fn();
  const usage = await new ClaudeQuotaProvider({
    logger,
    providerId: "claude-account-token",
    claudeHome: account,
    strictClaudeHome: true,
    fetch,
  }).fetchUsage();
  expect(fetch).not.toHaveBeenCalled();
  expect(usage.status).toBe("unavailable");
  expect(usage.details?.[0]?.id).toBe("claude-setup-token");
});

it("reads only the full account's own Keychain item on macOS and never the default item", async () => {
  const account = await home();
  const defaultReader = vi.fn(async () => credentials("default-item"));
  const accountReader = vi.fn(async () => credentials("account-item"));
  const tokens: Array<string | null> = [];
  const usage = await new ClaudeQuotaProvider({
    logger,
    providerId: "claude-account-full",
    claudeHome: account,
    strictClaudeHome: true,
    signIn: "full",
    platform: "darwin",
    claudeKeychainReader: defaultReader,
    claudeAccountKeychainReader: accountReader,
    fetch: async (_url, init) => {
      tokens.push(new Headers(init?.headers).get("Authorization"));
      return usageResponse();
    },
  }).fetchUsage();
  expect(defaultReader).not.toHaveBeenCalled();
  expect(accountReader).toHaveBeenCalledTimes(1);
  const [service, keychainAccount] = accountReader.mock.calls[0]!;
  expect(service).toBe(claudeKeychainServiceForConfigDir(account));
  expect(service).not.toBe("Claude Code-credentials");
  expect(keychainAccount).toBe(claudeKeychainAccount());
  expect(tokens).toEqual(["Bearer account-item"]);
  expect(usage.status).toBe("available");
});

it("follows the CLI's macOS store order: the account's Keychain item wins over a fallback file", async () => {
  const account = await home();
  await writeFile(join(account, ".credentials.json"), JSON.stringify(credentials("fallback-file")));
  const tokens: Array<string | null> = [];
  const read = (item: unknown) =>
    new ClaudeQuotaProvider({
      logger,
      providerId: "claude-account-full",
      claudeHome: account,
      strictClaudeHome: true,
      signIn: "full",
      platform: "darwin",
      claudeKeychainReader: vi.fn(),
      claudeAccountKeychainReader: async () => item,
      fetch: async (_url, init) => {
        tokens.push(new Headers(init?.headers).get("Authorization"));
        return usageResponse();
      },
    }).fetchUsage();
  await read(credentials("keychain-item"));
  await read(null);
  expect(tokens).toEqual(["Bearer keychain-item", "Bearer fallback-file"]);
});

it("derives the pinned CLI's per-config-directory Keychain service", () => {
  // Claude Code 2.1.284 wN("-credentials"): sha256(NFC config dir), first eight hex digits.
  expect(
    claudeKeychainServiceForConfigDir(
      "/Users/example/.paseo/claude-accounts/claude-account-00000000-0000-4000-8000-000000000001",
    ),
  ).toBe("Claude Code-credentials-bf4f7b55");
  // The CLI hashes the raw variable: a trailing slash names a different item.
  expect(
    claudeKeychainServiceForConfigDir(
      "/Users/example/.paseo/claude-accounts/claude-account-00000000-0000-4000-8000-000000000001/",
    ),
  ).toBe("Claude Code-credentials-c98bfc8f");
  expect(claudeKeychainServiceForConfigDir("/accounts/a")).not.toBe(
    claudeKeychainServiceForConfigDir("/accounts/b"),
  );
  // An explicit CLAUDE_CONFIG_DIR is always suffixed, even when it names ~/.claude.
  expect(claudeKeychainServiceForConfigDir(join(homedir(), ".claude"))).not.toBe(
    "Claude Code-credentials",
  );
});

it("asks the Keychain for one exact service and account, never a service-only match", async () => {
  const calls: string[][] = [];
  const value = await readClaudeAccountKeychainCredentials("svc", "acct", async (args) => {
    calls.push(args);
    return JSON.stringify(credentials("x"));
  });
  expect(calls).toEqual([["find-generic-password", "-a", "acct", "-w", "-s", "svc"]]);
  expect(value).toEqual(credentials("x"));
});

it("reports sign-in needed without any lookup outside the account when credentials are missing", async () => {
  const account = await home();
  const defaultReader = vi.fn();
  const accountReader = vi.fn(async () => null);
  const fetch = vi.fn();
  const usage = await new ClaudeQuotaProvider({
    logger,
    providerId: "claude-account-full",
    claudeHome: account,
    strictClaudeHome: true,
    signIn: "full",
    platform: "darwin",
    claudeKeychainReader: defaultReader,
    claudeAccountKeychainReader: accountReader,
    fetch,
  }).fetchUsage();
  expect(fetch).not.toHaveBeenCalled();
  expect(defaultReader).not.toHaveBeenCalled();
  expect(usage.status).toBe("unavailable");
  expect(usage.details?.[0]?.id).toBe("claude-sign-in");
  // No home at all: nothing is read.
  await new ClaudeQuotaProvider({
    logger,
    providerId: "claude-account-full",
    strictClaudeHome: true,
    signIn: "full",
    platform: "darwin",
    claudeKeychainReader: defaultReader,
    claudeAccountKeychainReader: accountReader,
    fetch,
  }).fetchUsage();
  expect(accountReader).toHaveBeenCalledTimes(1);
});

it("gives sign-in recovery instructions when the full account's grant is rejected", async () => {
  const account = await home();
  await writeFile(join(account, ".credentials.json"), JSON.stringify(credentials("revoked")));
  const usage = await new ClaudeQuotaProvider({
    logger,
    providerId: "claude-account-full",
    claudeHome: account,
    strictClaudeHome: true,
    signIn: "full",
    platform: "linux",
    fetch: async () => new Response(null, { status: 401 }),
  }).fetchUsage();
  expect(usage.status).toBe("unavailable");
  expect(usage.authRecovery?.instructions).toContain("Sign in with Claude again");
});

it("routes each binding to its own type through the manifest", async () => {
  vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", "/managed/client.json");
  const full = await home();
  const token = await home();
  await writeFile(join(full, ".credentials.json"), JSON.stringify(credentials("full-token")));
  await writeFile(join(token, ".credentials.json"), JSON.stringify(credentials("token-home")));
  const tokens: Array<string | null> = [];
  const fetchers = createProviderUsageFetchers({
    logger,
    providers: {
      claude: { enabled: false },
      "claude-account-full": {
        extends: "claude",
        label: "Max",
        env: { CLAUDE_CONFIG_DIR: full, [CLAUDE_SIGN_IN_ENV]: "full" },
      },
      "claude-account-token": {
        extends: "claude",
        label: "Token",
        env: { CLAUDE_CONFIG_DIR: token },
      },
    },
    fetch: async (_url, init) => {
      tokens.push(new Headers(init?.headers).get("Authorization"));
      return usageResponse();
    },
  });
  const byId = (id: string) => fetchers.find((fetcher) => fetcher.providerId === id)!;
  expect((await byId("claude-account-full").fetchUsage()).status).toBe("available");
  expect((await byId("claude-account-token").fetchUsage()).status).toBe("unavailable");
  expect(tokens).toEqual(["Bearer full-token"]);
});

it("says usage refreshes on the next turn when an expired grant can still refresh", async () => {
  const account = await home();
  const write = (oauth: Record<string, unknown>) =>
    writeFile(
      join(account, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "a", subscriptionType: "max", ...oauth } }),
    );
  const fetch = vi.fn(async () => usageResponse());
  const provider = new ClaudeQuotaProvider({
    logger,
    providerId: "claude-account-full",
    claudeHome: account,
    strictClaudeHome: true,
    signIn: "full",
    platform: "linux",
    fetch,
    now: () => 2_000,
  });
  await write({ expiresAt: 1_000, refreshToken: "synthetic-refresh" });
  const pending = await provider.fetchUsage();
  expect(fetch).not.toHaveBeenCalled();
  expect(pending.status).toBe("unavailable");
  expect(pending.details?.[0]?.id).toBe("claude-refresh-pending");
  expect(pending.authRecovery).toBeUndefined();
  // A token that is still valid is read normally.
  await write({ expiresAt: 3_000, refreshToken: "synthetic-refresh" });
  expect((await provider.fetchUsage()).status).toBe("available");
  // Without a refresh token the endpoint decides, and a rejection asks for sign-in.
  fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await write({ expiresAt: 1_000 });
  expect((await provider.fetchUsage()).authRecovery?.instructions).toContain(
    "Sign in with Claude again",
  );
});
