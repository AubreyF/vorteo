/**
 * How a Claude account binding authenticates. The marker lives in the binding's
 * environment so every consumer that already receives the binding (provider runtime,
 * login, quota manifest, installation projection) sees the same type without another
 * schema. It is not a credential.
 *
 * - "setup-token": the original type. A long-lived inference-only token is saved under
 *   `<CLAUDE_CONFIG_DIR>/.vorteo-auth` and injected per launch. Usage is unavailable.
 * - "full": `claude auth login --claudeai`. The CLI owns OAuth storage and refresh for the
 *   account's own CLAUDE_CONFIG_DIR, which also authorizes the usage endpoint.
 */
export const CLAUDE_SIGN_IN_ENV = "VORTEO_CLAUDE_SIGN_IN";

export type ClaudeSignInMode = "setup-token" | "full";

/** An absent or unknown marker is a setup-token account, so existing bindings keep their type. */
export function claudeSignInMode(
  env: Readonly<Record<string, string | undefined>> | undefined,
): ClaudeSignInMode {
  return env?.[CLAUDE_SIGN_IN_ENV] === "full" ? "full" : "setup-token";
}

export function claudeSignInEnvironment(mode: ClaudeSignInMode): Record<string, string> {
  return mode === "full" ? { [CLAUDE_SIGN_IN_ENV]: "full" } : {};
}

/**
 * Applied after every other overlay for a full sign-in account, so the CLI can use only the
 * OAuth grant stored for the account's own CLAUDE_CONFIG_DIR. Inherited daemon variables could
 * otherwise sign it in as someone else, switch it off the subscription, or move its storage.
 * `undefined` removes a variable. CLAUDE_SECURESTORAGE_CONFIG_DIR must be absent rather than
 * empty: Claude Code 2.1.284 maps an empty value to the shared default Keychain item and
 * `~/.claude/.credentials.json`.
 */
export function claudeFullSignInEnvironment(): Record<string, string | undefined> {
  return {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
    CLAUDE_CODE_OAUTH_SCOPES: undefined,
    CLAUDE_CODE_OAUTH_CLIENT_ID: undefined,
    CLAUDE_CODE_CUSTOM_OAUTH_URL: undefined,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "",
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_PROFILE: "",
    ANTHROPIC_FEDERATION_RULE_ID: "",
    ANTHROPIC_ORGANIZATION_ID: "",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
  };
}

/**
 * The marker comes only from a binding. A daemon started from inside a full account's agent
 * shell inherits it in process.env; reading it there would turn every setup-token account in
 * that daemon into a full sign-in account.
 */
export function applyClaudeSignInEnvironment(overlay: Record<string, string | undefined>): void {
  if (!(CLAUDE_SIGN_IN_ENV in overlay)) overlay[CLAUDE_SIGN_IN_ENV] = undefined;
  if (claudeSignInMode(overlay) === "full") Object.assign(overlay, claudeFullSignInEnvironment());
}
