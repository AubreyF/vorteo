import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  loadPersistedConfig,
  editPersistedConfig,
  mutatePersistedConfig,
  withPersistedConfigWriter,
  PersistedConfigSchema,
  readPersistedConfig,
  savePersistedConfig,
} from "./persisted-config.js";
import { ConfigWriterError } from "./config-writer.js";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "./private-files.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function createTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-config-"));
}

function captureConfigFailure(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected configuration operation to reject");
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe("PersistedConfigSchema daemon auth config", () => {
  test("accepts optional daemon password hash", () => {
    const hash = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        auth: { password: hash },
      },
    });

    expect(parsed.daemon?.auth?.password).toBe(hash);
  });
});

describe("PersistedConfigSchema daemon append system prompt config", () => {
  test("accepts optional append system prompt", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        appendSystemPrompt: "Prefer terse replies.",
      },
    });

    expect(parsed.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });
});

describe("PersistedConfigSchema daemon browser tools config", () => {
  test("accepts optional browser tools opt-in", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        browserTools: { enabled: true },
      },
    });

    expect(parsed.daemon?.browserTools?.enabled).toBe(true);
  });
});

describe("PersistedConfigSchema daemon relay config", () => {
  test("accepts optional relay TLS setting", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        relay: {
          enabled: true,
          endpoint: "relay.example.com:443",
          publicEndpoint: "public.example.com:443",
          useTls: true,
        },
      },
    });

    expect(parsed.daemon?.relay?.useTls).toBe(true);
  });
});

describe("PersistedConfigSchema daemon trusted proxy config", () => {
  test("accepts optional trusted proxy ranges", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        trustedProxies: ["loopback", "172.16.0.0/12"],
      },
    });

    expect(parsed.daemon?.trustedProxies).toEqual(["loopback", "172.16.0.0/12"]);
  });

  test("accepts explicit trust-all proxy config", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        trustedProxies: true,
      },
    });

    expect(parsed.daemon?.trustedProxies).toBe(true);
  });
});

describe("PersistedConfigSchema daemon web UI feature config", () => {
  test("accepts optional web UI enable flag and dist dir", () => {
    const parsed = PersistedConfigSchema.parse({
      features: {
        webUi: {
          enabled: true,
          distDir: "web-ui-dist",
        },
      },
    });

    expect(parsed.features?.webUi).toEqual({
      enabled: true,
      distDir: "web-ui-dist",
    });
  });
});

describe("PersistedConfigSchema worktrees config", () => {
  test("accepts optional worktree root", () => {
    const parsed = PersistedConfigSchema.parse({
      worktrees: {
        root: "/mnt/fast/paseo-worktrees",
      },
    });

    expect(parsed.worktrees?.root).toBe("/mnt/fast/paseo-worktrees");
  });

  test("accepts service port allocation", () => {
    const parsed = PersistedConfigSchema.parse({
      worktrees: {
        servicePorts: { range: "3000-4000" },
      },
    });

    expect(parsed.worktrees?.servicePorts).toEqual({ range: "3000-4000" });
  });
});

describe("PersistedConfigSchema provider credentials", () => {
  test("accepts separate OpenAI STT and TTS credentials", () => {
    const parsed = PersistedConfigSchema.parse({
      providers: {
        openai: {
          stt: {
            apiKey: " stt-secret ",
            baseUrl: " https://stt.example.com/v1 ",
          },
          tts: {
            apiKey: " tts-secret ",
            baseUrl: " https://tts.example.com/v1 ",
          },
        },
      },
    });

    expect(parsed.providers?.openai?.stt?.apiKey).toBe("stt-secret");
    expect(parsed.providers?.openai?.stt?.baseUrl).toBe("https://stt.example.com/v1");
    expect(parsed.providers?.openai?.tts?.apiKey).toBe("tts-secret");
    expect(parsed.providers?.openai?.tts?.baseUrl).toBe("https://tts.example.com/v1");
  });
});

describe("PersistedConfigSchema daemon append system prompt", () => {
  test("accepts optional append system prompt", () => {
    const parsed = PersistedConfigSchema.parse({
      daemon: {
        appendSystemPrompt: "Prefer terse replies.",
      },
    });

    expect(parsed.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });
});

describe("PersistedConfigSchema agent provider runtime settings", () => {
  test("legacy append entries are skipped during migration", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "append",
              args: ["--chrome"],
            },
            env: {
              FOO: "bar",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers).toEqual({});
  });

  test("accepts provider command replace argv", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          codex: {
            command: {
              mode: "replace",
              argv: ["docker", "run", "--rm", "my-codex-wrapper"],
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.codex?.command).toEqual([
      "docker",
      "run",
      "--rm",
      "my-codex-wrapper",
    ]);
  });

  test("rejects replace command without argv", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          opencode: {
            command: {
              mode: "replace",
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("accepts metadata generation provider fallbacks", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        metadataGeneration: {
          providers: [
            { provider: "claude", model: "haiku" },
            { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
          ],
        },
      },
    });

    expect(parsed.agents?.metadataGeneration).toEqual({
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
      ],
    });
  });

  test("accepts a custom provider catalog refresh timeout", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: { catalogRefreshTimeoutMs: 180_000 },
    });

    expect(parsed.agents?.catalogRefreshTimeoutMs).toBe(180_000);
  });

  test("rejects provider catalog refresh timeouts that overflow Node timers", () => {
    expect(() =>
      PersistedConfigSchema.parse({ agents: { catalogRefreshTimeoutMs: 2_147_483_648 } }),
    ).toThrow();
  });
});

describe("provider overrides (new format)", () => {
  test("override built-in provider with command and env", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: ["/opt/custom/claude"],
            env: {
              ANTHROPIC_API_KEY: "sk-test",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({
      command: ["/opt/custom/claude"],
      env: {
        ANTHROPIC_API_KEY: "sk-test",
      },
    });
  });

  test("new provider extending claude with label", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
            label: "ZAI",
          },
        },
      },
    });

    expect(parsed.agents?.providers?.zai).toEqual({
      extends: "claude",
      label: "ZAI",
    });
  });

  test("new provider extending acp with command", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          "my-agent": {
            extends: "acp",
            label: "My Agent",
            command: ["my-agent", "--acp"],
          },
        },
      },
    });

    expect(parsed.agents?.providers?.["my-agent"]).toEqual({
      extends: "acp",
      label: "My Agent",
      command: ["my-agent", "--acp"],
    });
  });

  test("enabled: false accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            enabled: false,
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude?.enabled).toBe(false);
  });

  test("models array accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
            label: "ZAI",
            models: [
              {
                id: "zai-fast",
                label: "ZAI Fast",
                isDefault: true,
              },
            ],
          },
        },
      },
    });

    expect(parsed.agents?.providers?.zai?.models).toEqual([
      {
        id: "zai-fast",
        label: "ZAI Fast",
        isDefault: true,
      },
    ]);
  });

  test("additionalModels array accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
            label: "ZAI",
            additionalModels: [
              {
                id: "zai-fast",
                label: "ZAI Fast",
                isDefault: true,
              },
            ],
          },
        },
      },
    });

    expect(parsed.agents?.providers?.zai?.additionalModels).toEqual([
      {
        id: "zai-fast",
        label: "ZAI Fast",
        isDefault: true,
      },
    ]);
  });

  test("order field accepted", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            order: 1,
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude?.order).toBe(1);
  });

  test("accepts a plugin override before plugin registration", () => {
    const override = { enabled: false, command: ["/opt/agent"], env: { LOGIN: "yes" } };
    const parsed = PersistedConfigSchema.parse({
      agents: { providers: { "plugin-agent": override } },
    });
    expect(parsed.agents?.providers?.["plugin-agent"]).toEqual(override);
  });

  test.each(["plugin.agent", "plugin_agent"])(
    "keeps %s outside the config provider ID alphabet",
    (id) => {
      expect(
        PersistedConfigSchema.safeParse({ agents: { providers: { [id]: { enabled: false } } } })
          .success,
      ).toBe(false);
    },
  );

  test("new provider without label → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          zai: {
            extends: "claude",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("extends: acp without command → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          "my-agent": {
            extends: "acp",
            label: "My Agent",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("extends unknown provider → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          zai: {
            extends: "unknown",
            label: "ZAI",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("invalid provider ID format → error", () => {
    const result = PersistedConfigSchema.safeParse({
      agents: {
        providers: {
          ZAI: {
            extends: "claude",
            label: "ZAI",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("old format with mode: replace auto-migrates", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "replace",
              argv: ["docker", "run", "--rm", "claude"],
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({
      command: ["docker", "run", "--rm", "claude"],
    });
  });

  test("old format with mode: default auto-migrates", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "default",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({});
  });

  test("old format env preserved during migration", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "default",
            },
            env: {
              FOO: "bar",
            },
          },
        },
      },
    });

    expect(parsed.agents?.providers?.claude).toEqual({
      env: {
        FOO: "bar",
      },
    });
  });

  test("mixed old and new format entries both work", () => {
    const parsed = PersistedConfigSchema.parse({
      agents: {
        providers: {
          claude: {
            command: {
              mode: "replace",
              argv: ["custom-claude"],
            },
          },
          zai: {
            extends: "claude",
            label: "ZAI",
            command: ["zai"],
          },
        },
      },
    });

    expect(parsed.agents?.providers).toEqual({
      claude: {
        command: ["custom-claude"],
      },
      zai: {
        extends: "claude",
        label: "ZAI",
        command: ["zai"],
      },
    });
  });
});

describe("PersistedConfigSchema logging config", () => {
  test("accepts destination-specific logging config", () => {
    const parsed = PersistedConfigSchema.parse({
      log: {
        console: {
          level: "info",
          format: "pretty",
        },
        file: {
          level: "trace",
          path: "daemon.log",
          rotate: {
            maxSize: "10m",
            maxFiles: 2,
          },
        },
      },
    });

    expect(parsed.log?.console?.level).toBe("info");
    expect(parsed.log?.file?.level).toBe("trace");
    expect(parsed.log?.file?.rotate?.maxFiles).toBe(2);
  });

  test("accepts legacy logging config fields", () => {
    const parsed = PersistedConfigSchema.parse({
      log: {
        level: "debug",
        format: "json",
      },
    });

    expect(parsed.log?.level).toBe("debug");
    expect(parsed.log?.format).toBe("json");
  });

  test("rejects unknown logging config fields", () => {
    const result = PersistedConfigSchema.safeParse({
      log: {
        console: {
          level: "info",
          color: "red",
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("PersistedConfigSchema voice mode config", () => {
  test("accepts a dedicated turn detection provider", () => {
    const parsed = PersistedConfigSchema.parse({
      features: {
        voiceMode: {
          turnDetection: {
            provider: "local",
          },
        },
      },
    });

    expect(parsed.features?.voiceMode?.turnDetection?.provider).toBe("local");
  });

  test("accepts trimmed STT language fields", () => {
    const parsed = PersistedConfigSchema.parse({
      features: {
        dictation: {
          stt: {
            language: " fr ",
          },
        },
        voiceMode: {
          stt: {
            language: " de ",
          },
        },
      },
    });

    expect(parsed.features?.dictation?.stt?.language).toBe("fr");
    expect(parsed.features?.voiceMode?.stt?.language).toBe("de");
  });
});

describe("loadPersistedConfig", () => {
  test("materializes relay disabled for a new Vorteo home", () => {
    const home = createTempHome();
    try {
      const config = loadPersistedConfig(home);
      expect(config.daemon?.relay?.enabled).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("accepts the documented config schema marker", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            $schema: "https://paseo.sh/schemas/paseo.config.v1.json",
            version: 1,
            daemon: {
              listen: "127.0.0.1:6767",
              hostnames: ["localhost", ".localhost"],
              mcp: { enabled: true },
            },
          },
          null,
          2,
        )}\n`,
      );

      const config = loadPersistedConfig(home);

      expect(config.daemon?.listen).toBe("127.0.0.1:6767");
      expect(config.daemon?.hostnames).toEqual(["localhost", ".localhost"]);
      expect(config.daemon?.mcp?.enabled).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("loads a config that still uses the removed providers.openai.voice block", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            version: 1,
            providers: {
              openai: {
                apiKey: "global-key",
                voice: { apiKey: "voice-key", baseUrl: "https://voice.example.com/v1" },
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const config = loadPersistedConfig(home);

      expect(config.providers?.openai?.apiKey).toBe("global-key");
      expect((config.providers?.openai as Record<string, unknown>)?.voice).toBeUndefined();
      expect(config.providers?.openai?.stt).toBeUndefined();
      expect(config.providers?.openai?.tts).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("config.json saved with a UTF-8 byte order mark", () => {
  // Windows Notepad writes this shape: a BOM, then CRLF line endings.
  const notepadConfig =
    '﻿{\r\n  "version": 1,\r\n  "daemon": { "listen": "127.0.0.1:6767" }\r\n}\r\n';

  test("loadPersistedConfig reads it", () => {
    const home = createTempHome();
    try {
      writeFileSync(path.join(home, "config.json"), notepadConfig);

      expect(loadPersistedConfig(home).daemon?.listen).toBe("127.0.0.1:6767");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("readPersistedConfig reads it", () => {
    const home = createTempHome();
    try {
      writeFileSync(path.join(home, "config.json"), notepadConfig);

      expect(readPersistedConfig(home).daemon?.listen).toBe("127.0.0.1:6767");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("readPersistedConfig with an unreadable config.json", () => {
  test("names the file when it is not valid JSON", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(configPath, '{"version":1,');

      expect(() => readPersistedConfig(home)).toThrow(`[Config] Invalid JSON in ${configPath}: `);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("names the file and the field when it does not match the schema", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(configPath, '{"daemon":{"listen":5}}');

      expect(() => readPersistedConfig(home)).toThrow(
        `[Config] Invalid config in ${configPath}:\n  - daemon.listen: `,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("persisted config file permissions", () => {
  test("initializes config.json with private permissions", () => {
    const home = createTempHome();
    try {
      loadPersistedConfig(home);

      expect(modeOf(path.join(home, "config.json"))).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs permissive config.json permissions when loading", () => {
    const home = createTempHome();
    const configPath = path.join(home, "config.json");
    try {
      writeFileSync(configPath, "{}\n", { mode: PERMISSIVE_FILE_MODE });
      chmodSync(configPath, PERMISSIVE_FILE_MODE);

      loadPersistedConfig(home);

      expect(modeOf(configPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("saves config.json with private permissions", () => {
    const parent = createTempHome();
    const home = path.join(parent, "home");
    try {
      savePersistedConfig(home, {
        providers: {
          openai: {
            apiKey: "secret",
          },
        },
      });

      expect(modeOf(home)).toBe(PRIVATE_DIRECTORY_MODE);
      expect(modeOf(path.join(home, "config.json"))).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("persisted settings writer ownership", () => {
  test("refuses initialization, ordinary saves and field edits while another writer owns the file", () => {
    const home = createTempHome();
    try {
      function initialize() {
        loadPersistedConfig(home);
      }
      function save() {
        savePersistedConfig(home, {});
      }
      function edit() {
        editPersistedConfig(home, "daemon.listen", { value: "127.0.0.1:9999" });
      }
      withPersistedConfigWriter(home, (writer) => {
        expect(initialize).toThrow("busy");
        expect(save).toThrow("busy");
        expect(edit).toThrow("busy");
        writer.save({ daemon: { listen: "127.0.0.1:6767" } });
      });
      expect(readPersistedConfig(home).daemon?.listen).toBe("127.0.0.1:6767");
      expect(() => loadPersistedConfig(home)).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a competing exported writer in a separate process", () => {
    const home = createTempHome();
    const modulePath = fileURLToPath(new URL("./persisted-config.ts", import.meta.url));
    try {
      withPersistedConfigWriter(home, (writer) => {
        writer.save({ daemon: { listen: "127.0.0.1:6767" } });
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `import {savePersistedConfig} from ${JSON.stringify(modulePath)}; try { savePersistedConfig(process.argv[1], {}); process.exitCode=1; } catch(error) { if(error.code !== "busy") throw error; }`,
            home,
          ],
          { encoding: "utf8", timeout: 10000 },
        );
        expect({ status: child.status, stderr: child.stderr, error: child.error }).toEqual({
          status: 0,
          stderr: "",
          error: undefined,
        });
      });
      expect(readPersistedConfig(home).daemon?.listen).toBe("127.0.0.1:6767");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects stale exported read snapshots and rebases selected prompt fields on fresh settings", () => {
    const home = createTempHome();
    try {
      savePersistedConfig(home, { daemon: { listen: "127.0.0.1:6767" } });
      const stale = readPersistedConfig(home);
      editPersistedConfig(home, "daemon.listen", { value: "127.0.0.1:9999" });
      expect(() => savePersistedConfig(home, stale)).toThrow("stale_input");
      mutatePersistedConfig(home, (fresh) => ({
        ...fresh,
        daemon: { ...fresh.daemon, relay: { enabled: false } },
      }));
      expect(readPersistedConfig(home).daemon).toEqual({
        listen: "127.0.0.1:9999",
        relay: { enabled: false },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses rollback over an unfenced file change and retains that file", () => {
    const home = createTempHome();
    try {
      savePersistedConfig(home, { daemon: { listen: "127.0.0.1:6767" } });
      function interfere(writer: Parameters<Parameters<typeof withPersistedConfigWriter>[1]>[0]) {
        const previous = writer.read();
        writer.save({ daemon: { listen: "127.0.0.1:9999" } });
        writeFileSync(
          path.join(home, "config.json"),
          JSON.stringify({ daemon: { listen: "127.0.0.1:8888" } }),
        );
        writer.save(previous);
      }
      expect(() => withPersistedConfigWriter(home, interfere)).toThrow("stale_input");
      expect(readPersistedConfig(home).daemon?.listen).toBe("127.0.0.1:8888");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("revokes a retained writer and preserves a replacement lock on ownership loss", () => {
    const home = createTempHome();
    let retained: Parameters<Parameters<typeof withPersistedConfigWriter>[1]>[0] | undefined;
    try {
      withPersistedConfigWriter(home, (writer) => {
        retained = writer;
      });
      expect(() => retained?.save({})).toThrow("ownership_lost");
      function replaceLock() {
        writeFileSync(path.join(home, ".config-writer.lock"), "replacement");
      }
      expect(() => withPersistedConfigWriter(home, replaceLock)).toThrow("ownership_lost");
      expect(() => savePersistedConfig(home, {})).toThrow("busy");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("types arbitrary callback rejection after persistence and preserves its exact cause", () => {
    const home = createTempHome();
    const original = new Error("Callback failed after save");
    function persistThenFail(
      writer: Parameters<Parameters<typeof withPersistedConfigWriter>[1]>[0],
    ) {
      writer.save({ daemon: { listen: "127.0.0.1:9999" } });
      throw original;
    }
    try {
      const failure = captureConfigFailure(() => withPersistedConfigWriter(home, persistThenFail));
      expect(failure).toBeInstanceOf(ConfigWriterError);
      expect(failure).toMatchObject({ code: "uncertain", writeAttempted: true, cause: original });
      expect(readPersistedConfig(home).daemon?.listen).toBe("127.0.0.1:9999");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("preserves a callback rejection before any write", () => {
    const home = createTempHome();
    const original = new Error("Callback rejected before save");
    function failBeforeWrite() {
      throw original;
    }
    try {
      expect(captureConfigFailure(() => withPersistedConfigWriter(home, failBeforeWrite))).toBe(
        original,
      );
      expect(readPersistedConfig(home)).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "types final reread failure after persistence and retains its filesystem cause",
    () => {
      const home = createTempHome();
      function persistThenBlockRead(
        writer: Parameters<Parameters<typeof withPersistedConfigWriter>[1]>[0],
      ) {
        writer.save({ daemon: { listen: "127.0.0.1:9999" } });
        chmodSync(path.join(home, "config.json"), 0o000);
      }
      try {
        const failure = captureConfigFailure(() =>
          withPersistedConfigWriter(home, persistThenBlockRead),
        );
        expect(failure).toBeInstanceOf(ConfigWriterError);
        expect(failure).toMatchObject({
          code: "uncertain",
          writeAttempted: true,
          cause: { code: "EACCES" },
        });
        chmodSync(path.join(home, "config.json"), 0o600);
        expect(readPersistedConfig(home).daemon?.listen).toBe("127.0.0.1:9999");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports lock-release permission failure after persistence as potentially committed",
    () => {
      const home = createTempHome();
      let failure: unknown;
      function persist(writer: Parameters<Parameters<typeof withPersistedConfigWriter>[1]>[0]) {
        writer.save({ daemon: { listen: "127.0.0.1:9999" } });
        chmodSync(home, 0o500);
      }
      try {
        try {
          withPersistedConfigWriter(home, persist);
        } catch (error) {
          failure = error;
        } finally {
          chmodSync(home, 0o700);
        }
        expect(failure).toBeInstanceOf(ConfigWriterError);
        expect(failure).toMatchObject({ code: "ownership_lost", writeAttempted: true });
        expect(readPersistedConfig(home).daemon?.listen).toBe("127.0.0.1:9999");
        expect(() => savePersistedConfig(home, {})).toThrow("busy");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test("reports a logger failure after persistence as potentially committed", () => {
    const home = createTempHome();
    try {
      expect(() =>
        savePersistedConfig(
          home,
          { daemon: { listen: "127.0.0.1:9999" } },
          {
            child() {
              return this;
            },
            info() {
              throw new Error("listener failed");
            },
          },
        ),
      ).toThrow("uncertain");
      expect(readPersistedConfig(home).daemon?.listen).toBe("127.0.0.1:9999");
      expect(() =>
        editPersistedConfig(home, "daemon.listen", { value: "127.0.0.1:8888" }),
      ).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
