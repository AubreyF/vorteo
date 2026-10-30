import { closeSync, constants, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isTrustedCredentialsFile, replaceAtomically } from "./claude-oauth-credentials-file.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import { CodexSignInDeliveryError, type CodexAccessProjection } from "./codex-signin-delivery.js";

/** Codex keeps ChatGPT sign-in in `<CODEX_HOME>/auth.json` with its default file storage. */
const AUTH_FILE = "auth.json";
/** Coordinator-owned state inside the account home: the receipt journal and rollback copy. */
export const CODEX_SIGNIN_STATE_DIRECTORY = ".vorteo-signin";
const LOCAL_SIGN_IN_COPY = "local-sign-in.json";

const ExistingSchema = z.object({
  tokens: z
    .object({ refresh_token: z.string().optional(), account_id: z.string().nullish() })
    .nullish(),
});

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

/** The current file, or null when there is none. A symbolic link or foreign file is refused. */
function readExisting(file: string): Record<string, unknown> | null {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw new CodexSignInDeliveryError();
  }
  try {
    if (!isTrustedCredentialsFile(fstatSync(descriptor))) throw new CodexSignInDeliveryError();
    try {
      const parsed: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      // Codex treats unreadable storage as signed out.
      return {};
    }
  } finally {
    closeSync(descriptor);
  }
}

/** A file holding a refresh token came from a sign-in made in this environment. */
function localSignIn(existing: Record<string, unknown> | null) {
  const parsed = ExistingSchema.safeParse(existing);
  const tokens = parsed.success ? parsed.data.tokens : undefined;
  return tokens?.refresh_token ? { accountId: tokens.account_id ?? null } : null;
}

/**
 * Write an access-only projection into the account's `auth.json`, or remove it for a withdrawal.
 * The caller has already verified that `home` is the binding's owned account directory.
 *
 * An earlier sign-in made in this environment is replaced only when it belongs to the same
 * ChatGPT account, and a copy is kept once as rollback material. A different or unverifiable
 * account is refused and stays in place. A withdrawal never removes such a local sign-in.
 */
export function writeCodexAccessProjection(
  home: string,
  access: CodexAccessProjection | null,
): void {
  const file = join(home, AUTH_FILE);
  const existing = readExisting(file);
  const local = localSignIn(existing);
  if (!access) {
    if (existing && !local) {
      try {
        unlinkSync(file);
      } catch (error) {
        if (code(error) !== "ENOENT") throw new CodexSignInDeliveryError();
      }
    }
    return;
  }
  if (local) {
    if (!access.accountId || local.accountId !== access.accountId)
      throw new CodexSignInDeliveryError();
    const copy = join(home, CODEX_SIGNIN_STATE_DIRECTORY, LOCAL_SIGN_IN_COPY);
    if (readClaudeSetupFile(copy) === null) writeClaudeSetupFile(copy, existing);
  }
  // An empty refresh token, never a real one: Dev Codex cannot rotate the Host's grant, and
  // after a rejected request it reloads this file before it tries to refresh.
  const contents = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: access.idToken,
      access_token: access.accessToken,
      refresh_token: "",
      account_id: access.accountId,
    },
    last_refresh: access.lastRefresh,
  };
  replaceAtomically(home, file, JSON.stringify(contents, null, 2));
}
