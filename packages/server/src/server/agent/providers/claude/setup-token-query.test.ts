import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { expect, test, vi } from "vitest";
import * as spawn from "../../../../utils/spawn.js";
import { claudeQuery } from "./query.js";
import { claudeSetupTokenEnvironment } from "./setup-token-runtime.js";

test("the actual spawn overlay retains authority credentials after runtime and launch overrides", () => {
  const credential = {
    version: 1 as const,
    accessToken: `sk-ant-oat01-${"synthetic".repeat(8)}`,
    createdAt: 1,
  };
  const child = new EventEmitter() as ChildProcess;
  const spawnProcess = vi.spyOn(spawn, "spawnProcess").mockReturnValue(child);
  let options: Options | undefined;
  try {
    claudeQuery(
      { prompt: "synthetic", options: {} },
      {
        runtimeSettings: {
          env: { CLAUDE_CODE_OAUTH_TOKEN: "wrong-runtime", ANTHROPIC_API_KEY: "wrong-key" },
        },
        launchEnv: { CLAUDE_CODE_OAUTH_TOKEN: "wrong-launch" },
        authEnv: claudeSetupTokenEnvironment(credential, "/synthetic/config"),
        queryFactory: (input) => {
          options = input.options;
          return {} as Query;
        },
      },
    );
    options?.spawnClaudeCodeProcess?.({
      command: "/synthetic/claude",
      args: [],
      cwd: "/synthetic",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "wrong-sdk" },
      signal: new AbortController().signal,
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]![2]).toMatchObject({
      envOverlay: {
        CLAUDE_CODE_OAUTH_TOKEN: credential.accessToken,
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/synthetic/config/.vorteo-auth/secure",
      },
    });
  } finally {
    vi.restoreAllMocks();
  }
});
