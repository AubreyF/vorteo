import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeQuotaProvider } from "./claude.js";
import { ClaudeAgentClient } from "../../../server/agent/providers/claude/agent.js";
import type { AgentClient } from "../../../server/agent/agent-sdk-types.js";
import { ProviderResetService } from "../reset-service.js";
import { ResetCreditStore } from "../reset-store.js";
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});
const logger = pino({ level: "silent" });

test.each(["malformed", JSON.stringify({ accessToken: "synthetic-expired", expiresAt: 1 }), ""])(
  "managed artifact %s never invokes native credential readers or provider operations",
  async (artifact) => {
    const home = await fs.mkdtemp(join(tmpdir(), "claude-managed-usage-"));
    homes.push(home);
    await fs.mkdir(join(home, ".vorteo-auth"));
    await fs.writeFile(join(home, ".vorteo-auth", "claude-setup-token.json"), artifact);
    await fs.writeFile(
      join(home, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-other-account" } }),
    );
    const keychain = vi.fn();
    const fetch = vi.fn();
    const readFile = vi.spyOn(fs, "readFile");
    const provider = new ClaudeQuotaProvider({
      logger,
      claudeHome: home,
      platform: "darwin",
      claudeKeychainReader: keychain,
      fetch,
    });
    expect(await provider.fetchUsage()).toMatchObject({
      status: "unavailable",
      planLabel: null,
      windows: [],
    });
    const client: AgentClient = new ClaudeAgentClient({
      logger,
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: home } },
      resolveBinary: async () => "/not-executed",
    });
    const reset = new ProviderResetService({
      store: new ResetCreditStore(join(home, "resets")),
      getClient: () => client,
      refreshUsage: fetch,
      logger,
    });
    expect(await reset.read("claude")).toMatchObject({
      canRedeem: false,
      snapshot: { status: "unsupported" },
    });
    await expect(reset.prepare("claude", "synthetic-other-account")).rejects.toThrow("unavailable");
    expect(readFile).not.toHaveBeenCalled();
    expect(keychain).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

test("managed installation usage cannot read native credentials before first delivery", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "claude-before-delivery-"));
  homes.push(home);
  await fs.writeFile(
    join(home, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-old-native" } }),
  );
  const readFile = vi.spyOn(fs, "readFile");
  const keychain = vi.fn();
  const fetch = vi.fn();
  vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", "/synthetic/installation-client.json");
  const provider = new ClaudeQuotaProvider({
    logger,
    claudeHome: home,
    platform: "darwin",
    claudeKeychainReader: keychain,
    fetch,
  });
  expect(await provider.fetchUsage()).toMatchObject({ status: "unavailable" });
  expect(readFile).not.toHaveBeenCalled();
  expect(keychain).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
