import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CLAUDE_REFRESH_LEAD_MS,
  CLAUDE_REFRESH_REQUEST_ARGS,
  claudeAccessProjection,
  createClaudeHostCli,
  needsHostRefresh,
  readClaudeOAuthGrant,
} from "./claude-oauth-host.js";
import {
  claudeKeychainAccount,
  claudeKeychainServiceForConfigDir,
} from "../../../services/quota-fetcher/providers/claude.js";
import { ClaudeLoginSession } from "../../agent/providers/claude/login.js";
import { CLAUDE_SIGN_IN_ENV } from "../../agent/providers/claude/sign-in-mode.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temporary(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
const storage = (oauth: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: oauth });
const launch = async () => ({ executable: "/fake/claude", args: ["--launch-arg"] });

it("runs Option A as one tool-less print request in the account's environment", async () => {
  const configDir = temporary("claude-oauth-account-");
  const calls: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> = [];
  let cwdDuringRun = "";
  const run = vi.fn(async (executable: string, args: string[], options?: object) => {
    const record = options as Record<string, unknown>;
    cwdDuringRun = String(record.cwd);
    expect(existsSync(cwdDuringRun)).toBe(true);
    calls.push({ executable, args, options: record });
    return { stdout: "{}", stderr: "" };
  });
  const cli = createClaudeHostCli({ run: run as never, resolveLaunch: launch });
  await cli.refresh(configDir);
  expect(calls[0]!.executable).toBe("/fake/claude");
  expect(calls[0]!.args).toEqual(["--launch-arg", ...CLAUDE_REFRESH_REQUEST_ARGS]);
  expect(CLAUDE_REFRESH_REQUEST_ARGS.slice(0, 2)).toEqual(["-p", "Reply with OK."]);
  expect(CLAUDE_REFRESH_REQUEST_ARGS).toContain("--no-session-persistence");
  expect(CLAUDE_REFRESH_REQUEST_ARGS).not.toContain("--bare");
  const tools = CLAUDE_REFRESH_REQUEST_ARGS.indexOf("--tools");
  expect(CLAUDE_REFRESH_REQUEST_ARGS[tools + 1]).toBe("");
  const overlay = calls[0]!.options.envOverlay as Record<string, string | undefined>;
  expect(overlay.CLAUDE_CONFIG_DIR).toBe(configDir);
  expect(overlay[CLAUDE_SIGN_IN_ENV]).toBe("full");
  expect("CLAUDE_SECURESTORAGE_CONFIG_DIR" in overlay).toBe(true);
  expect(overlay.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  expect(calls[0]!.options.timeout).toBe(60_000);
  // The scratch working directory is removed afterwards.
  expect(existsSync(cwdDuringRun)).toBe(false);
});

it("reads the grant from the account's own storage without exposing the refresh token", async () => {
  const configDir = temporary("claude-oauth-grant-");
  writeFileSync(
    join(configDir, ".credentials.json"),
    storage({
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: 1_900_000_000_000,
      scopes: ["user:inference", "user:profile", 7],
      subscriptionType: "max",
    }),
  );
  const grant = await readClaudeOAuthGrant(configDir, { platform: "linux" });
  expect(grant).toEqual({
    accessToken: "synthetic-access",
    hasRefreshToken: true,
    expiresAt: 1_900_000_000_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
  });
  expect(JSON.stringify(grant)).not.toContain("synthetic-refresh");
  const projection = claudeAccessProjection(grant);
  expect(projection).toEqual({
    accessToken: "synthetic-access",
    expiresAt: 1_900_000_000_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
  });
  expect(claudeAccessProjection({ ...grant!, expiresAt: null })).toBeNull();
});

it("uses only the account's own Keychain item on macOS, with the file as its fallback", async () => {
  const configDir = temporary("claude-oauth-keychain-");
  writeFileSync(join(configDir, ".credentials.json"), storage({ accessToken: "synthetic-file" }));
  const readKeychain = vi.fn(async () => JSON.parse(storage({ accessToken: "synthetic-item" })));
  const fromItem = await readClaudeOAuthGrant(configDir, { platform: "darwin", readKeychain });
  expect(fromItem?.accessToken).toBe("synthetic-item");
  expect(readKeychain).toHaveBeenCalledWith(
    claudeKeychainServiceForConfigDir(configDir),
    claudeKeychainAccount(),
  );
  expect(readKeychain.mock.calls[0]![0]).not.toBe("Claude Code-credentials");
  readKeychain.mockResolvedValueOnce(null);
  const fromFile = await readClaudeOAuthGrant(configDir, { platform: "darwin", readKeychain });
  expect(fromFile?.accessToken).toBe("synthetic-file");
});

it("refuses a symbolic-link credentials file", async () => {
  const configDir = temporary("claude-oauth-link-");
  const elsewhere = join(temporary("claude-oauth-elsewhere-"), "grant.json");
  writeFileSync(elsewhere, storage({ accessToken: "synthetic-elsewhere" }));
  symlinkSync(elsewhere, join(configDir, ".credentials.json"));
  await expect(readClaudeOAuthGrant(configDir, { platform: "linux" })).resolves.toBeNull();
});

it("asks for a refresh only inside the lead window and only with a refresh token", () => {
  const now = 1_000_000;
  const grant = {
    accessToken: "synthetic",
    hasRefreshToken: true,
    expiresAt: now + CLAUDE_REFRESH_LEAD_MS,
    scopes: [],
  };
  expect(needsHostRefresh(grant, now)).toBe(true);
  expect(needsHostRefresh({ ...grant, expiresAt: now + CLAUDE_REFRESH_LEAD_MS + 1 }, now)).toBe(
    false,
  );
  expect(needsHostRefresh({ ...grant, expiresAt: now - 1 }, now)).toBe(true);
  expect(needsHostRefresh({ ...grant, hasRefreshToken: false }, now)).toBe(false);
  expect(needsHostRefresh({ ...grant, expiresAt: null }, now)).toBe(false);
  expect(needsHostRefresh(null, now)).toBe(false);
});

it("reads identity from local auth status, signs out and opens sign-in for the exact directory", async () => {
  const configDir = temporary("claude-oauth-identity-");
  const run = vi.fn(async (_executable: string, args: string[]) =>
    args.includes("status")
      ? {
          stdout: JSON.stringify({ loggedIn: true, email: "owner@example.com", orgId: "org-1" }),
          stderr: "",
        }
      : { stdout: "", stderr: "" },
  );
  const cli = createClaudeHostCli({ run: run as never, resolveLaunch: launch });
  await expect(cli.identity(configDir)).resolves.toEqual({
    email: "owner@example.com",
    orgId: "org-1",
  });
  await cli.logout(configDir);
  expect(run.mock.calls.at(-1)![1]).toEqual(["--launch-arg", "auth", "logout"]);
  run.mockRejectedValueOnce(Object.assign(new Error("signed out"), { code: 1 }));
  await expect(cli.identity(configDir)).resolves.toBeNull();
  const session = await cli.loginSession(configDir);
  expect(session).toBeInstanceOf(ClaudeLoginSession);
  expect(session.scope).toBe(configDir);
});

it("trusts the Host credentials file only with the Dev reader's checks", async () => {
  const configDir = temporary("claude-oauth-trust-");
  const file = join(configDir, ".credentials.json");
  writeFileSync(file, storage({ accessToken: "synthetic-access", expiresAt: 1_900_000_000_000 }));
  chmodSync(file, 0o666);
  await expect(readClaudeOAuthGrant(configDir, { platform: "linux" })).resolves.toBeNull();
  chmodSync(file, 0o600);
  await expect(readClaudeOAuthGrant(configDir, { platform: "linux" })).resolves.toMatchObject({
    accessToken: "synthetic-access",
  });
});

it("treats the CLI's dead-token marker as no grant", async () => {
  const configDir = temporary("claude-oauth-dead-");
  writeFileSync(
    join(configDir, ".credentials.json"),
    storage({ accessToken: "", refreshToken: "", expiresAt: 0 }),
  );
  await expect(readClaudeOAuthGrant(configDir, { platform: "linux" })).resolves.toBeNull();
  expect(
    claudeAccessProjection({
      accessToken: "synthetic",
      hasRefreshToken: false,
      expiresAt: 0,
      scopes: [],
    }),
  ).toBeNull();
});
