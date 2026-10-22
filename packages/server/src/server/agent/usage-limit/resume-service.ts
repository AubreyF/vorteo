import type { Logger } from "pino";
import type { UsageLimitHold } from "@getpaseo/protocol/usage-limit";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";

/** Set by the app on a thread that continues another one elsewhere. */
export const CONTINUED_FROM_LABEL = "paseo:continued-from";

/** What the account's usage reader says right now. */
export type AccountUsageReading =
  | { kind: "limited"; resetsAt: string }
  | { kind: "available" }
  | { kind: "unknown" };

interface UsageLimitResumeOptions {
  agentManager: Pick<
    AgentManager,
    "isRestartDraining" | "resumeAfterUsageLimit" | "updateUsageLimitHold"
  >;
  agentStorage: Pick<AgentStorage, "list">;
  /** Reads the account's usage; used only for stops that reported no reset time. */
  readUsage: (provider: string) => Promise<AccountUsageReading>;
  /** The account's resume switch. Absent configuration means on. */
  autoResumeEnabled: (provider: string) => boolean;
  logger: Logger;
  now?: () => number;
  /** Wait after the reported reset before continuing, so the provider has rolled the window. */
  graceMs?: number;
  /** Minimum gap between two continuations on the same account. */
  staggerMs?: number;
  /** Backoff per attempt for a stop with no reset time and no usage reading. */
  unknownResetRetryMs?: number;
  maxAttempts?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The prompt queued for a thread whose usage limit has reset. */
export function usageLimitContinuationText(
  hold: UsageLimitHold,
  options: { manual: boolean; now: number },
): string {
  const lead = options.manual
    ? "The owner resumed this thread after it stopped at a usage limit."
    : "Your previous turn stopped at a usage limit, which has now reset.";
  const waitedDays = Math.floor((options.now - Date.parse(hold.stoppedAt)) / DAY_MS);
  const longWait =
    waitedDays >= 1
      ? ` This thread waited ${waitedDays === 1 ? "a day" : `${waitedDays} days`} for the reset, so re-read recent messages and the task list before acting.`
      : "";
  return `${lead} Check what was already done, then continue the authorized work, following the owner's latest instructions.${longWait}`;
}

/** Turns a provider usage report into a reading: limited while any window is used up. */
export function readingFromProviderUsage(
  usage: ProviderUsage | undefined,
  now: number,
): AccountUsageReading {
  if (!usage || usage.status !== "available") return { kind: "unknown" };
  const resets = usage.windows
    .filter((window) => (window.usedPct ?? 0) >= 100 || window.remainingPct === 0)
    .map((window) => window.resetsAt)
    .filter((resetsAt): resetsAt is string => !!resetsAt && Date.parse(resetsAt) > now)
    .sort();
  const resetsAt = resets.at(-1);
  return resetsAt ? { kind: "limited", resetsAt } : { kind: "available" };
}

/**
 * Continues threads that stopped at a provider usage limit once the limit resets.
 *
 * One daemon-owned timer scans stored threads every minute. Each account releases one
 * thread at a time, oldest stop first, through the message queue, which survives restarts
 * and leaves owner-paused queues alone.
 */
export class UsageLimitResumeService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private readonly lastRelease = new Map<string, number>();
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly staggerMs: number;
  private readonly unknownResetRetryMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: UsageLimitResumeOptions) {
    this.now = options.now ?? Date.now;
    this.graceMs = options.graceMs ?? 2 * 60_000;
    this.staggerMs = options.staggerMs ?? 2 * 60_000;
    this.unknownResetRetryMs = options.unknownResetRetryMs ?? 30 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Usage-limit resume scan failed");
      });
    }, 60_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped || this.options.agentManager.isRestartDraining()) return;
    this.running = true;
    try {
      const records = await this.options.agentStorage.list();
      const continued = new Set(
        records.map((record) => record.labels[CONTINUED_FROM_LABEL]).filter(Boolean),
      );
      const byProvider = new Map<string, Array<{ id: string; hold: UsageLimitHold }>>();
      for (const record of records) {
        const hold = waitingHold(record);
        if (!hold || continued.has(record.id)) continue;
        const held = byProvider.get(record.provider) ?? [];
        held.push({ id: record.id, hold });
        byProvider.set(record.provider, held);
      }
      for (const [provider, held] of byProvider) {
        if (this.stopped || this.options.agentManager.isRestartDraining()) return;
        if (!this.options.autoResumeEnabled(provider)) continue;
        held.sort((a, b) => a.hold.stoppedAt.localeCompare(b.hold.stoppedAt));
        await this.releaseNext(provider, held);
      }
    } finally {
      this.running = false;
    }
  }

  private async releaseNext(
    provider: string,
    held: Array<{ id: string; hold: UsageLimitHold }>,
  ): Promise<void> {
    const now = this.now();
    const last = this.lastRelease.get(provider);
    if (last !== undefined && now - last < this.staggerMs) return;
    const due = held.filter(({ hold }) => now >= this.dueAt(hold));
    if (!due.length) return;

    // Stops without a reported reset ask the account's usage reader when it frees up.
    if (due.some(({ hold }) => !hold.resetsAt)) {
      const reading = await this.options.readUsage(provider).catch((error: unknown) => {
        this.options.logger.warn({ err: error, provider }, "Usage reading failed");
        return { kind: "unknown" } as const;
      });
      if (reading.kind === "limited") {
        for (const { id, hold } of due)
          if (!hold.resetsAt) await this.setResetsAt(id, reading.resetsAt);
        return;
      }
    }

    for (const { id, hold } of due) {
      if (this.stopped || this.options.agentManager.isRestartDraining()) return;
      if (hold.attempts >= this.maxAttempts) {
        await this.options.agentManager.updateUsageLimitHold(id, (current) =>
          current && !current.releasedAt ? { ...current, gaveUp: true } : undefined,
        );
        continue;
      }
      try {
        const result = await this.options.agentManager.resumeAfterUsageLimit(id, {
          manual: false,
          text: usageLimitContinuationText(hold, { manual: false, now }),
        });
        // A paused queue keeps the thread waiting until the owner resumes the queue.
        if (result === false) continue;
        this.lastRelease.set(provider, now);
        this.options.logger.info({ agentId: id, provider }, "Usage-limit continuation queued");
        return;
      } catch (error) {
        this.options.logger.warn({ err: error, agentId: id }, "Usage-limit continuation failed");
      }
    }
  }

  private dueAt(hold: UsageLimitHold): number {
    if (hold.resetsAt) return Date.parse(hold.resetsAt) + this.graceMs;
    return Date.parse(hold.stoppedAt) + this.unknownResetRetryMs * (hold.attempts + 1);
  }

  private async setResetsAt(agentId: string, resetsAt: string): Promise<void> {
    await this.options.agentManager.updateUsageLimitHold(agentId, (current) =>
      current && !current.releasedAt && !current.resetsAt ? { ...current, resetsAt } : undefined,
    );
  }
}

/** A hold that may continue automatically: not released, opted out, given up or owned elsewhere. */
function waitingHold(record: StoredAgentRecord): UsageLimitHold | null {
  const hold = record.config?.usageLimitHold;
  if (!hold || hold.releasedAt || hold.optOut || hold.gaveUp) return null;
  // A worker team's pause is released together with the hold, so it does not block here.
  if (record.archivedAt || record.internal) return null;
  if (record.owner || record.config?.controllerExecutionId) return null;
  return hold;
}
