import { requireClaudeAuthentication } from "./authentication.js";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claudeSetupTokenStore,
  readClaudeSetupToken,
  claudeSetupTokenEnvironment,
} from "./setup-token-runtime.js";
import { setupCredentialDigest } from "../../../execution-installation/accounts/claude-setup-delivery.js";
import { writeClaudeSetupFile } from "../../../execution-installation/accounts/claude-setup-file.js";
beforeEach(() => vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", undefined));
afterEach(() => vi.unstubAllEnvs());

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const token = { version: 1, accessToken: `sk-ant-oat01-${"synthetic".repeat(8)}`, createdAt: 1 };
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  homes.push(home);
  await claudeSetupTokenStore(home).write(token);
  return {
    home,
    env: { CLAUDE_CONFIG_DIR: home },
    receipt: join(home, ".vorteo-auth", "delivery.json"),
  };
}
function receipt() {
  return {
    installationId: "11111111-1111-4111-8111-111111111111",
    serverId: "dev",
    definitionId: "one",
    providerId: "claude-account-one",
    revision: 1,
    policyRevision: 1,
    digest: setupCredentialDigest(token),
    phase: "applied",
    active: true,
  };
}
test("pending, mismatched and revoked receipts prevent native credential fallback", async () => {
  const f = await fixture();
  for (const patch of [{ phase: "pending" }, { digest: "0".repeat(64) }, { active: false }]) {
    writeClaudeSetupFile(f.receipt, { ...receipt(), ...patch });
    await expect(readClaudeSetupToken(f.env)).rejects.toThrow("Claude");
  }
  writeClaudeSetupFile(f.receipt, receipt());
  expect(await readClaudeSetupToken(f.env)).toEqual(token);
  await claudeSetupTokenStore(f.home).remove();
  await expect(readClaudeSetupToken(f.env)).rejects.toThrow("Claude");
});
test("consumer storage is separate from preserved project history and native credential files", async () => {
  const f = await fixture();
  await mkdir(join(f.home, "projects"));
  await writeFile(join(f.home, "projects", "history.jsonl"), "history");
  expect(await readClaudeSetupToken(f.env)).toEqual(token);
  const env = claudeSetupTokenEnvironment(token, f.home);
  expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(f.home, ".vorteo-auth", "secure"));
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBe("");
  expect(env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("");
});
test("malformed or linked receipts fail with sanitized errors", async () => {
  const f = await fixture();
  await writeFile(f.receipt, `malformed ${token.accessToken}`, { mode: 0o600 });
  await expect(readClaudeSetupToken(f.env)).rejects.not.toThrow(token.accessToken);
  await rm(f.receipt);
  await symlink(join(f.home, ".vorteo-auth", "claude-setup-token.json"), f.receipt);
  await expect(readClaudeSetupToken(f.env)).rejects.toThrow("Claude");
});

test("setup-token readiness requires CLI-confirmed OAuth token routing and global options precede the subcommand", async () => {
  const f = await fixture();
  for (const authMethod of ["api_key", "oauth_token"]) {
    const check = requireClaudeAuthentication({
      executable: "/not-executed",
      args: [],
      runtimeSettings: { env: f.env },
      run: async (_command, args) => {
        expect(args).toEqual([
          "--settings",
          JSON.stringify({ apiKeyHelper: "" }),
          "auth",
          "status",
        ]);
        return {
          stdout: JSON.stringify({ loggedIn: true, authMethod, apiProvider: "firstParty" }),
          stderr: "",
        };
      },
    });
    if (authMethod === "oauth_token") await expect(check).resolves.toBeUndefined();
    else await expect(check).rejects.toMatchObject({ code: "CHECK_FAILED" });
  }
});

test("a managed daemon cannot use an unbound token or fall back before first delivery", async () => {
  const f = await fixture();
  vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", "/synthetic/installation-client.json");
  try {
    await expect(readClaudeSetupToken(f.env)).rejects.toThrow("Claude");
    await claudeSetupTokenStore(f.home).remove();
    await expect(readClaudeSetupToken(f.env)).rejects.toThrow("Claude");
  } finally {
    vi.unstubAllEnvs();
  }
});
