import type { Logger } from "pino";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "../agent-loading.js";
import { blockedReviewDue, BLOCKED_REVIEW_INTERVAL_MS } from "./blocked-review.js";

interface ReviewServiceOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  now?: () => number;
}

/** One daemon-owned timer reviews existing threads; it never creates a thread or schedule. */
export class BlockedTaskReviewService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private readonly attempts = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: ReviewServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Blocked-task review scan failed");
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
      for (const record of records) {
        if (this.stopped || this.options.agentManager.isRestartDraining()) return;
        const now = this.now();
        const attempted = this.attempts.get(record.id);
        const recentlyAttempted =
          attempted !== undefined && now - attempted < BLOCKED_REVIEW_INTERVAL_MS;
        if (recentlyAttempted || !blockedReviewDue(record, now)) continue;
        this.attempts.set(record.id, now);
        await this.review(record.id);
      }
    } finally {
      this.running = false;
    }
  }

  private async review(agentId: string): Promise<void> {
    try {
      await ensureUnarchivedAgentLoaded(agentId, this.options);
      const stream = await this.options.agentManager.startBlockedTaskReview(
        agentId,
        () => !this.stopped,
      );
      if (!stream) return;
      for await (const event of stream) {
        // AgentManager owns timeline delivery, usage accounting and lifecycle updates.
        void event;
      }
    } catch (error) {
      // Failed preparation or inference must not retry every scheduler tick.
      this.options.logger.warn({ err: error, agentId }, "Blocked-task review could not complete");
    }
  }
}
