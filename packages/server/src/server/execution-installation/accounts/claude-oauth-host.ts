import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  checkProviderLaunchAvailable,
  createProviderEnvSpec,
  resolveProviderLaunch,
} from "../../agent/provider-launch-config.js";
import { ClaudeLoginSession } from "../../agent/providers/claude/login.js";
import { CLAUDE_SIGN_IN_ENV } from "../../agent/providers/claude/sign-in-mode.js";
import {
  claudeKeychainAccount,
  claudeKeychainServiceForConfigDir,
  readClaudeAccountKeychainCredentials,
} from "../../../services/quota-fetcher/providers/claude.js";
import { execCommand } from "../../../utils/spawn.js";
import type { ClaudeAccessProjection } from "./claude-oauth-delivery.js";
import { isTrustedCredentialsFile } from "./claude-oauth-credentials-file.js";

/**
 * Host-side operations the coordinator performs on a full sign-in account's own CLI storage.
 * The coordinator runs as the same user on the Host and receives the account's exact
 * CLAUDE_CONFIG_DIR from the Host daemon, so the CLI derives the same storage it would.
 *
 * Unverified: on macOS the grant is expected in the Keychain item the pinned CLI derives from
 * that directory, with `.credentials.json` only as its fallback. That location comes from static
 * analysis of Claude Code 2.1.284 and awaits the owner's live sign-in check.
 */

/** The CLI refreshes only within 5 minutes of expiry; ask inside that window with margin. */
export const CLAUDE_REFRESH_LEAD_MS = 4 * 60_000;

/**
 * Option A, chosen by the owner: one tiny non-interactive request through the official CLI.
 * The CLI refreshes an expiring grant under its own locks before the model request. The prompt
 * comes first so the variadic `--tools` option cannot consume it. `--bare` is avoided because it
 * disables the stored claude.ai sign-in. `--setting-sources user` keeps only the account's own
 * Vorteo-created settings, as its agents run; the empty working directory has no project or local
 * settings, and `--strict-mcp-config` loads no MCP servers.
 */
export const CLAUDE_REFRESH_REQUEST_ARGS = [
  "-p",
  "Reply with OK.",
  "--model",
  "haiku",
  "--max-turns",
  "1",
  "--tools",
  "",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--setting-sources",
  "user",
  "--output-format",
  "json",
];

/** What the coordinator may hold in memory. The refresh token value is never read out. */
export interface ClaudeOAuthGrant {
  accessToken: string;
  hasRefreshToken: boolean;
  expiresAt: number | null;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

const StorageSchema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
      expiresAt: z.unknown().optional(),
      scopes: z.unknown().optional(),
      subscriptionType: z.string().optional(),
      rateLimitTier: z.string().optional(),
    })
    .optional(),
});

function toGrant(value: unknown): ClaudeOAuthGrant | null {
  const parsed = StorageSchema.safeParse(value);
  const oauth = parsed.success ? parsed.data.claudeAiOauth : undefined;
  if (!oauth?.accessToken) return null;
  return {
    accessToken: oauth.accessToken,
    hasRefreshToken: Boolean(oauth.refreshToken),
    expiresAt:
      typeof oauth.expiresAt === "number" && Number.isSafeInteger(oauth.expiresAt)
        ? oauth.expiresAt
        : null,
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    ...(oauth.subscriptionType ? { subscriptionType: oauth.subscriptionType } : {}),
    ...(oauth.rateLimitTier ? { rateLimitTier: oauth.rateLimitTier } : {}),
  };
}

function readStorageFile(file: string): unknown | null {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    // Same checks as the Dev reader: regular, bounded, owned by this user, not shared-writable.
    if (!isTrustedCredentialsFile(fstatSync(descriptor))) return null;
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

interface GrantReadOptions {
  platform?: NodeJS.Platform;
  readKeychain?: (service: string, account: string) => Promise<unknown | null>;
}

/** Same store order as the pinned CLI, and never the default Keychain item. */
export async function readClaudeOAuthGrant(
  configDir: string,
  options: GrantReadOptions = {},
): Promise<ClaudeOAuthGrant | null> {
  if ((options.platform ?? process.platform) === "darwin") {
    const service = claudeKeychainServiceForConfigDir(configDir);
    if (service === "Claude Code-credentials") return null;
    const readKeychain =
      options.readKeychain ??
      ((name: string, account: string) => readClaudeAccountKeychainCredentials(name, account));
    const item = await readKeychain(service, claudeKeychainAccount());
    if (item !== null && item !== undefined) return toGrant(item);
  }
  return toGrant(readStorageFile(join(configDir, ".credentials.json")));
}

/** Access-only view for Dev. Null when the grant cannot be projected usefully. */
export function claudeAccessProjection(
  grant: ClaudeOAuthGrant | null,
): ClaudeAccessProjection | null {
  if (!grant || grant.expiresAt === null || grant.expiresAt <= 0) return null;
  return {
    accessToken: grant.accessToken,
    expiresAt: grant.expiresAt,
    scopes: grant.scopes,
    ...(grant.subscriptionType ? { subscriptionType: grant.subscriptionType } : {}),
    ...(grant.rateLimitTier ? { rateLimitTier: grant.rateLimitTier } : {}),
  };
}

export function needsHostRefresh(grant: ClaudeOAuthGrant | null, now: number): boolean {
  return Boolean(
    grant?.hasRefreshToken &&
    grant.expiresAt !== null &&
    grant.expiresAt - now <= CLAUDE_REFRESH_LEAD_MS,
  );
}

export interface ClaudeIdentity {
  email: string | null;
  orgId: string | null;
}

interface HostCliOptions {
  run?: typeof execCommand;
  resolveLaunch?: () => Promise<{ executable: string; args: string[] }>;
  tempRoot?: string;
}

async function packagedLaunch(): Promise<{ executable: string; args: string[] }> {
  const launch = await resolveProviderLaunch({ defaultBinary: "claude" });
  const available = await checkProviderLaunchAvailable(launch);
  if (!available.resolvedPath) throw new Error("Claude Code is unavailable on this host.");
  return { executable: available.resolvedPath, args: launch.args };
}

/** The account's launch environment, including the full sign-in isolation overlay. */
function accountEnvironment(configDir: string) {
  return createProviderEnvSpec({
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir, [CLAUDE_SIGN_IN_ENV]: "full" } },
  });
}

export function createClaudeHostCli(options: HostCliOptions = {}) {
  const run = options.run ?? execCommand;
  const resolveLaunch = options.resolveLaunch ?? packagedLaunch;
  return {
    /** Option A. Success is judged by re-reading the grant, not by this request's result. */
    async refresh(configDir: string): Promise<void> {
      const launch = await resolveLaunch();
      const cwd = await mkdtemp(join(options.tempRoot ?? tmpdir(), "vorteo-claude-refresh-"));
      try {
        await run(launch.executable, [...launch.args, ...CLAUDE_REFRESH_REQUEST_ARGS], {
          ...accountEnvironment(configDir),
          cwd,
          // Short enough that a stuck request cannot hold other accounts past their lead.
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    async logout(configDir: string): Promise<void> {
      const launch = await resolveLaunch();
      await run(launch.executable, [...launch.args, "auth", "logout"], {
        ...accountEnvironment(configDir),
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
    },
    /** `auth status` is local only: storage and `.claude.json`, no network, no refresh. */
    async identity(configDir: string): Promise<ClaudeIdentity | null> {
      const launch = await resolveLaunch();
      try {
        const { stdout } = await run(
          launch.executable,
          [...launch.args, "auth", "status", "--json"],
          { ...accountEnvironment(configDir), timeout: 15_000, maxBuffer: 64 * 1024 },
        );
        const status = z
          .object({
            loggedIn: z.boolean(),
            email: z.string().nullish(),
            orgId: z.string().nullish(),
          })
          .parse(JSON.parse(String(stdout)));
        return status.loggedIn
          ? { email: status.email ?? null, orgId: status.orgId ?? null }
          : null;
      } catch {
        return null;
      }
    },
    async loginSession(configDir: string): Promise<ClaudeLoginSession> {
      const launch = await resolveLaunch();
      return new ClaudeLoginSession({
        executable: launch.executable,
        args: launch.args,
        scope: configDir,
        runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir, [CLAUDE_SIGN_IN_ENV]: "full" } },
      });
    },
  };
}
export type ClaudeHostCli = ReturnType<typeof createClaudeHostCli>;
