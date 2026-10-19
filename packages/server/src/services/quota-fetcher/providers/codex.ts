import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  balanceToneFromRemaining,
  toneFromUsedPct,
  fetchProviderApi,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const CodexAuthSchema = z.object({
  tokens: z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().optional(),
      account_id: z.string().optional(),
    })
    .optional(),
});

const CodexWindowSchema = z.object({
  used_percent: ApiNumberSchema.optional(),
  reset_at: ApiNumberSchema.optional(),
  limit_window_seconds: ApiNumberSchema.positive().optional(),
});

const CodexUsageResponseSchema = z.object({
  plan_type: z.string().optional(),
  email: z.string().optional(),
  rate_limit: z
    .object({
      primary_window: CodexWindowSchema.nullish(),
      secondary_window: CodexWindowSchema.nullish(),
    })
    .nullish(),
  code_review_rate_limit: z
    .object({
      primary_window: CodexWindowSchema.nullish(),
    })
    .nullish(),
  credits: z
    .object({
      has_credits: z.boolean().optional(),
      unlimited: z.boolean().optional(),
      balance: ApiNumberSchema.optional(),
    })
    .nullish(),
});

type CodexAuth = z.infer<typeof CodexAuthSchema>;
type CodexWindow = z.infer<typeof CodexWindowSchema>;
type CodexUsageResponse = z.infer<typeof CodexUsageResponseSchema>;

interface CodexQuotaProviderOptions {
  logger: Logger;
  codexHome?: string;
  providerId?: string;
  displayName?: string;
  strictCodexHome?: boolean;
  fetch?: ProviderApiFetch;
}

function codexWindow(
  window: CodexWindow | null | undefined,
): { usedPct: number; resetsAt: string | null } | null {
  if (!window || window.used_percent === undefined) return null;
  return {
    usedPct: window.used_percent,
    resetsAt: window.reset_at != null ? new Date(window.reset_at * 1000).toISOString() : null,
  };
}

function windowLabel(window: CodexWindow | null | undefined, fallback: string): string {
  const seconds = window?.limit_window_seconds;
  if (seconds === undefined) return fallback;
  if (seconds === 604800) return "Weekly";
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  if (seconds % 60 === 0) return `${seconds / 60}-minute`;
  return `${seconds}-second`;
}

export class CodexQuotaProvider implements ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;

  private readonly codexHome: string | null;
  private readonly strictCodexHome: boolean;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: CodexQuotaProviderOptions) {
    this.providerId = options.providerId ?? "codex";
    this.displayName = options.displayName ?? "Codex";
    this.strictCodexHome = options.strictCodexHome ?? false;
    this.codexHome = this.strictCodexHome
      ? (options.codexHome ?? null)
      : options.codexHome || process.env["CODEX_HOME"] || join(homedir(), ".codex");
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const credentials = await this.readCodexAuth();
    const auth = credentials?.auth;
    const accessToken = auth?.tokens?.access_token;
    if (!credentials || !auth || !accessToken) {
      return unavailableUsage(this);
    }

    const { account_id } = auth.tokens ?? {};
    const resp = await this.callCodexApi(accessToken, account_id);

    if (resp === "AUTH_REJECTED") {
      const home = "'" + credentials.home.replaceAll("'", "'\"'\"'") + "'";
      return {
        ...unavailableUsage(this),
        authRecovery: {
          method: "device_code",
          instructions: `Open a terminal on this account’s host and run:\nCODEX_HOME=${home} codex login --device-auth\nOpen the URL printed by Codex, enter its device code, and sign in to the intended account. Then check the connection below.`,
        },
      };
    }

    if (resp === "NEEDS_AUTH") {
      // Read-only on credentials; the Codex CLI owns refresh. See docs/providers.md.
      return unavailableUsage(this);
    }

    return this.toUsage(resp);
  }

  private toUsage(resp: CodexUsageResponse): ProviderUsage {
    const session = codexWindow(resp.rate_limit?.primary_window);
    const weekly = codexWindow(resp.rate_limit?.secondary_window);
    const codeReview = codexWindow(resp.code_review_rate_limit?.primary_window);
    const windows: ProviderUsageWindow[] = [];
    const limits = resp.rate_limit;
    const applicabilityKnown =
      limits != null &&
      limits.primary_window !== undefined &&
      limits.secondary_window !== undefined;
    let reserveWindowIds: string[] | undefined;
    if (applicabilityKnown) {
      reserveWindowIds = [];
      if (limits.primary_window !== null) reserveWindowIds.push("session");
      if (limits.secondary_window !== null) reserveWindowIds.push("weekly");
    }

    if (session) {
      windows.push(
        windowFromUsedPct({
          id: "session",
          // Keep the existing window id stable; primary is not necessarily a session limit.
          label: windowLabel(resp.rate_limit?.primary_window, "Session"),
          utilizationPct: session.usedPct,
          resetsAt: session.resetsAt,
          tone: toneFromUsedPct(session.usedPct),
        }),
      );
    }
    if (weekly) {
      windows.push(
        windowFromUsedPct({
          id: "weekly",
          label: windowLabel(resp.rate_limit?.secondary_window, "Weekly"),
          utilizationPct: weekly.usedPct,
          resetsAt: weekly.resetsAt,
          tone: toneFromUsedPct(weekly.usedPct),
        }),
      );
    }
    if (codeReview) {
      windows.push(
        windowFromUsedPct({
          id: "code_review",
          label: "Code review",
          utilizationPct: codeReview.usedPct,
          resetsAt: codeReview.resetsAt,
          tone: toneFromUsedPct(codeReview.usedPct),
        }),
      );
    }

    const balances: ProviderUsageBalance[] = [];
    if (resp.credits?.balance !== undefined) {
      balances.push({
        id: "credits",
        label: "Credits",
        remaining: resp.credits.balance,
        unit: "credits",
        tone: balanceToneFromRemaining(resp.credits.balance),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: resp.plan_type ?? null,
      windows,
      ...(reserveWindowIds === undefined ? {} : { reserveWindowIds }),
      balances,
      details: [],
      error: null,
    };
  }

  private async readCodexAuth(): Promise<{ auth: CodexAuth; home: string } | null> {
    let candidates: string[];
    if (this.strictCodexHome) {
      candidates = this.codexHome ? [join(this.codexHome, "auth.json")] : [];
    } else {
      candidates = [
        ...(process.env["CODEX_HOME"] ? [join(process.env["CODEX_HOME"], "auth.json")] : []),
        join(homedir(), ".config", "codex", "auth.json"),
        ...(this.codexHome ? [join(this.codexHome, "auth.json")] : []),
      ];
    }
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const auth = CodexAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
        if (auth.tokens?.access_token) return { auth, home: dirname(path) };
      } catch {
        continue;
      }
    }
    return null;
  }

  private async callCodexApi(
    token: string,
    accountId?: string,
  ): Promise<CodexUsageResponse | "NEEDS_AUTH" | "AUTH_REJECTED"> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://chatgpt.com/backend-api/wham/usage",
      {
        headers,
      },
    );
    if (res.status === 401) return "AUTH_REJECTED";
    if (res.status === 403) return "NEEDS_AUTH";
    if (!res.ok) throw new Error(`Codex usage API returned ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) return "NEEDS_AUTH";
    return CodexUsageResponseSchema.parse(JSON.parse(text));
  }
}
