import type {
  ProviderUsageFetcher,
  ProviderUsageFetcherFactoryOptions,
  ProviderUsageFetcherManifestEntry,
} from "./provider.js";
import { ClaudeQuotaProvider } from "./providers/claude.js";
import { claudeSignInMode } from "../../server/agent/providers/claude/sign-in-mode.js";
import { CodexQuotaProvider } from "./providers/codex.js";
import { CopilotQuotaProvider } from "./providers/copilot.js";
import { CursorQuotaProvider } from "./providers/cursor.js";
import { GrokQuotaProvider } from "./providers/grok.js";
import { KimiQuotaProvider } from "./providers/kimi.js";
import { MiniMaxQuotaProvider } from "./providers/minimax.js";
import { ZaiQuotaProvider } from "./providers/zai.js";

export const PROVIDER_USAGE_FETCHERS: readonly ProviderUsageFetcherManifestEntry[] = [
  {
    providerId: "claude",
    create: (options) =>
      new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
      }),
  },
  {
    providerId: "codex",
    create: (options) =>
      new CodexQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
      }),
  },
  {
    providerId: "copilot",
    create: (options) => new CopilotQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "cursor",
    create: (options) => new CursorQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "zai",
    create: (options) => new ZaiQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "grok",
    create: (options) => new GrokQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "kimi",
    create: (options) => new KimiQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "minimax",
    create: (options) => new MiniMaxQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
];

export function createProviderUsageFetchers(
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher[] {
  const configuredCodex = options.providers?.["codex"];
  const fetchers = PROVIDER_USAGE_FETCHERS.flatMap((entry) => {
    if (entry.providerId === "claude") {
      const configured = options.providers?.claude;
      if (configured?.enabled === false) return [];
      const claudeHome = configured?.env?.CLAUDE_CONFIG_DIR;
      return [
        new ClaudeQuotaProvider({
          logger: options.logger,
          fetch: options.fetch,
          claudeHome,
          displayName: configured?.label,
          strictClaudeHome: claudeHome !== undefined,
          signIn: claudeSignInMode(configured?.env),
        }),
      ];
    }
    if (entry.providerId !== "codex") return [entry.create(options)];
    if (configuredCodex?.enabled === false) return [];
    const codexHome = configuredCodex?.env?.["CODEX_HOME"];
    return [
      new CodexQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
        providerId: "codex",
        displayName: configuredCodex?.label ?? "Codex",
        codexHome,
        strictCodexHome: codexHome !== undefined,
      }),
    ];
  });

  for (const [providerId, provider] of Object.entries(options.providers ?? {})) {
    if (providerId !== "claude" && provider.extends === "claude" && provider.enabled !== false) {
      fetchers.push(
        new ClaudeQuotaProvider({
          logger: options.logger,
          fetch: options.fetch,
          providerId,
          displayName: provider.label ?? providerId,
          claudeHome: provider.env?.CLAUDE_CONFIG_DIR,
          strictClaudeHome: true,
          signIn: claudeSignInMode(provider.env),
        }),
      );
      continue;
    }
    if (providerId === "codex" || provider.extends !== "codex" || provider.enabled === false) {
      continue;
    }
    const codexHome = provider.env?.["CODEX_HOME"];
    fetchers.push(
      new CodexQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
        providerId,
        displayName: provider.label ?? providerId,
        codexHome,
        strictCodexHome: true,
      }),
    );
  }

  return fetchers;
}
