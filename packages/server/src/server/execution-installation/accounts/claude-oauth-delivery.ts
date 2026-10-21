import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Host-owned Claude refresh: the Host account's own CLI store keeps the only grant and the
 * official Host CLI is the only refresh writer. Dev receives access-only projections, which
 * its CLI re-reads from `.credentials.json` before each request. A projection never carries a
 * refresh token: without one the Dev CLI never refreshes or persists tokens itself.
 */
const ScopeSchema = z.strictObject({
  installationId: z.string().uuid(),
  serverId: z.string().min(1),
  definitionId: z.string().min(1),
  providerId: z.string().min(1),
});
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Strict: a `refreshToken` field fails validation and the delivery is refused. */
export const ClaudeAccessProjectionSchema = z.strictObject({
  accessToken: z.string().min(1).max(8192),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scopes: z.array(z.string().min(1).max(256)).max(64),
  subscriptionType: z.string().min(1).max(256).optional(),
  rateLimitTier: z.string().min(1).max(256).optional(),
});
export type ClaudeAccessProjection = z.infer<typeof ClaudeAccessProjectionSchema>;

export const ClaudeOAuthBindingRequestSchema = ScopeSchema.extend({ policyRevision: Revision });
export type ClaudeOAuthBindingRequest = z.infer<typeof ClaudeOAuthBindingRequestSchema>;
/** The exact raw CLAUDE_CONFIG_DIR string: the CLI derives its macOS Keychain item from it. */
export const ClaudeOAuthBindingResponseSchema = z.strictObject({
  providerId: z.string().min(1),
  configDir: z.string().startsWith("/"),
});

export const ClaudeOAuthProjectionDeliverySchema = ScopeSchema.extend({
  policyRevision: Revision,
  /** Increments on each sign-in and sign-out. */
  generation: Revision,
  /** Increments on each new access token or withdrawal within a generation. */
  rotation: Counter,
  access: ClaudeAccessProjectionSchema.nullable(),
});
export type ClaudeOAuthProjectionDelivery = z.infer<typeof ClaudeOAuthProjectionDeliverySchema>;
export const ClaudeOAuthProjectionReceiptSchema = ScopeSchema.extend({
  policyRevision: Revision,
  generation: Revision,
  rotation: Counter,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["pending", "applied"]),
  active: z.boolean(),
});
export type ClaudeOAuthProjectionReceipt = z.infer<typeof ClaudeOAuthProjectionReceiptSchema>;

export class ClaudeOAuthDeliveryError extends Error {
  constructor() {
    super("Claude sign-in synchronization is pending. Retry after reconnecting the environment.");
  }
}

/** Key order is fixed so the coordinator and Dev compute the same digest. */
export function accessProjectionDigest(access: ClaudeAccessProjection | null): string {
  const canonical = access && {
    accessToken: access.accessToken,
    expiresAt: access.expiresAt,
    scopes: access.scopes,
    subscriptionType: access.subscriptionType ?? null,
    rateLimitTier: access.rateLimitTier ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface ClaudeOAuthProjectionPorts {
  /** Fresh authority policy must still target this binding and permit this operation. */
  authorize(delivery: ClaudeOAuthProjectionDelivery): Promise<void>;
  read(): ClaudeOAuthProjectionReceipt | null;
  persist(receipt: ClaudeOAuthProjectionReceipt): void;
  store(access: ClaudeAccessProjection | null): Promise<void>;
}

/** One serialized writer per Dev binding. Its journal holds digests, never tokens. */
export class ClaudeOAuthProjectionService {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly ports: ClaudeOAuthProjectionPorts) {}

  apply(input: unknown): Promise<ClaudeOAuthProjectionReceipt> {
    const parsed = ClaudeOAuthProjectionDeliverySchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new ClaudeOAuthDeliveryError());
    const task = this.queue.then(() => this.deliver(parsed.data));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async deliver(
    delivery: ClaudeOAuthProjectionDelivery,
  ): Promise<ClaudeOAuthProjectionReceipt> {
    try {
      await this.ports.authorize(delivery);
      const { access, ...slot } = delivery;
      const digest = accessProjectionDigest(access);
      const previous = this.ports.read();
      if (previous) {
        for (const key of ScopeSchema.keyof().options)
          if (previous[key] !== delivery[key]) throw new ClaudeOAuthDeliveryError();
        const older =
          delivery.generation < previous.generation ||
          (delivery.generation === previous.generation && delivery.rotation < previous.rotation);
        const conflicting =
          delivery.generation === previous.generation &&
          delivery.rotation === previous.rotation &&
          digest !== previous.digest;
        if (older || conflicting) throw new ClaudeOAuthDeliveryError();
      }
      const pending: ClaudeOAuthProjectionReceipt = {
        ...slot,
        digest,
        phase: "pending",
        active: access !== null,
      };
      this.ports.persist(pending);
      // Rewriting an applied slot is idempotent and repairs a file removed by a local logout.
      await this.ports.store(access);
      // A newly excluded binding cannot receive a successful applied receipt.
      await this.ports.authorize(delivery);
      const applied: ClaudeOAuthProjectionReceipt = { ...pending, phase: "applied" };
      this.ports.persist(applied);
      return applied;
    } catch {
      throw new ClaudeOAuthDeliveryError();
    }
  }
}
