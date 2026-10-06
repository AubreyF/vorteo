import path from "node:path";
import { z } from "zod";
import type { DaemonConfigStore } from "../../server/daemon-config-store.js";

export class AccountCreationError extends Error {}

const AccountEnvironmentSchema = z.record(z.string(), z.string());

interface AccountCreationInput {
  paseoHome: string;
  store: Pick<DaemonConfigStore, "get" | "createProviderAccountBinding">;
  creationId: string;
  name: string;
}

export function createCodexAccount(input: AccountCreationInput) {
  return createAccount(input, "codex", "CODEX_HOME");
}

export function createClaudeAccount(input: AccountCreationInput) {
  return createAccount(input, "claude", "CLAUDE_CONFIG_DIR");
}

/** A retry uses the same provider ID and home, including after a lost response or restart. */
async function createAccount(
  input: AccountCreationInput,
  provider: "codex" | "claude",
  homeVariable: "CODEX_HOME" | "CLAUDE_CONFIG_DIR",
): Promise<{ providerId: string; name: string }> {
  const creationId = z.string().uuid().parse(input.creationId);
  const name = input.name.trim();
  if (!name || name.length > 100)
    throw new AccountCreationError("Enter an account name of 1 to 100 characters.");
  const providerId = `${provider}-account-${creationId}`;
  const home = path.join(input.paseoHome, `${provider}-accounts`, providerId);
  const existing = input.store.get().providers[providerId];
  if (existing) {
    if (existing.removed)
      throw new AccountCreationError(
        "This local connection was removed. Restore it in Settings before signing in.",
      );
    const env = AccountEnvironmentSchema.safeParse(existing.env);
    if (existing.extends !== provider || !env.success || env.data[homeVariable] !== home) {
      throw new AccountCreationError("This account identifier is already in use.");
    }
    if (typeof existing.label !== "string")
      throw new AccountCreationError("The account configuration has no name.");
    return { providerId, name: existing.label };
  }
  const env: Record<string, string> = { [homeVariable]: home };
  if (provider === "claude") {
    // Additional subscription accounts must not use credentials inherited from the daemon.
    Object.assign(env, {
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "",
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "",
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_FOUNDRY: "0",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    });
  }
  // The login session creates the directory. Never copy another account's credentials.
  const saved = await input.store.createProviderAccountBinding(providerId, {
    extends: provider,
    label: name,
    enabled: true,
    env,
  });
  const label = saved.providers[providerId].label;
  return { providerId, name: typeof label === "string" ? label : name };
}
