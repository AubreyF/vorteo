import { mkdir, lstat } from "node:fs/promises";
import { readClaudeSetupFile } from "../../../execution-installation/accounts/claude-setup-file.js";
import {
  ClaudeSetupDeliveryReceiptSchema,
  setupCredentialDigest,
} from "../../../execution-installation/accounts/claude-setup-delivery.js";
import { ClaudeSetupTokenError } from "./setup-token-output.js";
import { join } from "node:path";
import { claudeConfigDir } from "./project-dir.js";
import { ClaudeSetupTokenStore, type ClaudeSetupToken } from "./setup-token-store.js";

export function claudeSetupTokenStore(configDirectory: string): ClaudeSetupTokenStore {
  return new ClaudeSetupTokenStore({ directory: join(configDirectory, ".vorteo-auth") });
}

export async function readClaudeSetupToken(
  env: NodeJS.ProcessEnv,
): Promise<ClaudeSetupToken | null> {
  const config = claudeConfigDir(env);
  const credential = await claudeSetupTokenStore(config).read();
  let receipt: unknown;
  try {
    receipt = readClaudeSetupFile(join(config, ".vorteo-auth", "delivery.json"));
  } catch {
    throw new ClaudeSetupTokenError();
  }
  if (receipt === null) {
    // A managed installation must not launch against an older native account before delivery.
    if (process.env.VORTEO_INSTALLATION_CLIENT_CONFIG) throw new ClaudeSetupTokenError();
    if (credential) await ensureConsumerSecureDirectory(config);
    return credential;
  }
  const parsed = ClaudeSetupDeliveryReceiptSchema.safeParse(receipt);
  if (
    !parsed.success ||
    parsed.data.phase !== "applied" ||
    !parsed.data.active ||
    parsed.data.digest !== setupCredentialDigest(credential) ||
    !credential
  )
    throw new ClaudeSetupTokenError();
  await ensureConsumerSecureDirectory(config);
  return credential;
}

async function ensureConsumerSecureDirectory(config: string): Promise<void> {
  const directory = join(config, ".vorteo-auth", "secure");
  try {
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)
    )
      throw new ClaudeSetupTokenError();
  } catch {
    throw new ClaudeSetupTokenError();
  }
}

/** Applied last, after user/runtime overlays, so another provider cannot silently win precedence. */
export function claudeSetupTokenEnvironment(
  credential: ClaudeSetupToken,
  configDirectory: string,
): Record<string, string> {
  return {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: join(configDirectory, ".vorteo-auth", "secure"),
    CLAUDE_CODE_OAUTH_TOKEN: credential.accessToken,
    CLAUDE_CODE_OAUTH_SCOPES: "user:inference",
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
