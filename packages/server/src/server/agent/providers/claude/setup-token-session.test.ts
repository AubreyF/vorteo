import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentClient } from "./agent.js";
import { claudeSetupTokenStore } from "./setup-token-runtime.js";
import type { ClaudeQueryInput } from "./query.js";

beforeEach(() => vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", undefined));
afterEach(() => vi.unstubAllEnvs());

test("renewal replaces the process credential and resumes the existing conversation", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-session-credential-"));
  const token = { version: 1, accessToken: `sk-ant-oat01-${"synthetic".repeat(8)}`, createdAt: 1 };
  const closed = vi.fn();
  const queryFactory = vi.fn(
    (_input: ClaudeQueryInput) =>
      ({ close: closed, return: async () => ({ done: true }) }) as unknown as Query,
  );
  const client = new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
    queryFactory,
    resolveBinary: async () => "/not-executed",
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "synthetic-wrong-key" } },
  });
  const session = await client.createSession({ provider: "claude", cwd: home });
  const internal = session as unknown as {
    ensureQuery(): Promise<Query>;
    claudeSessionId: string | null;
  };
  try {
    await claudeSetupTokenStore(home).write(token);
    await internal.ensureQuery();
    const first = queryFactory.mock.calls[0]![0].options;
    expect(first.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(token.accessToken);
    expect(first.env?.ANTHROPIC_API_KEY).toBe("");
    expect(first.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(home, ".vorteo-auth", "secure"));
    await internal.ensureQuery();
    expect(queryFactory).toHaveBeenCalledTimes(1);
    internal.claudeSessionId = "11111111-1111-4111-8111-111111111111";
    const renewed = { ...token, accessToken: `sk-ant-oat01-${"renewed".repeat(8)}`, createdAt: 2 };
    await claudeSetupTokenStore(home).write(renewed);
    await internal.ensureQuery();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(queryFactory).toHaveBeenCalledTimes(2);
    expect(queryFactory.mock.calls[1]![0].options).toMatchObject({
      resume: internal.claudeSessionId,
      env: { CLAUDE_CODE_OAUTH_TOKEN: renewed.accessToken },
    });
  } finally {
    await session.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("managed daemons refuse environment-local Claude login before creating a process", async () => {
  vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", "/synthetic/installation-client.json");
  try {
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      resolveBinary: async () => "/not-executed",
    });
    await expect(client.openAccountLoginSession()).rejects.toThrow(
      "installation subscription controls",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
