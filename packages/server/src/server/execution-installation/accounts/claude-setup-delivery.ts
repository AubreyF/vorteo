import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ClaudeSetupTokenSchema,
  type ClaudeSetupToken,
} from "../../agent/providers/claude/setup-token-store.js";

const ScopeSchema = z.strictObject({
  installationId: z.string().uuid(),
  serverId: z.string().min(1),
  definitionId: z.string().min(1),
  providerId: z.string().min(1),
});
export const ClaudeSetupDeliverySchema = ScopeSchema.extend({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  policyRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  credential: ClaudeSetupTokenSchema.nullable(),
});
export type ClaudeSetupDelivery = z.infer<typeof ClaudeSetupDeliverySchema>;
export const ClaudeSetupDeliveryReceiptSchema = ScopeSchema.extend({
  revision: z.number().int().positive(),
  policyRevision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["pending", "applied"]),
  active: z.boolean(),
});
export type ClaudeSetupDeliveryReceipt = z.infer<typeof ClaudeSetupDeliveryReceiptSchema>;
export interface ClaudeSetupDeliveryPorts {
  read(): ClaudeSetupDeliveryReceipt | null;
  persist(receipt: ClaudeSetupDeliveryReceipt): void;
  store(credential: ClaudeSetupToken | null): Promise<void>;
  /** Fresh authority policy must still target this exact binding and permit this operation. */
  authorize(delivery: ClaudeSetupDelivery): Promise<void>;
}
export class ClaudeSetupDeliveryError extends Error {
  constructor() {
    super(
      "Claude subscription synchronization is pending. Retry after reconnecting the environment.",
    );
  }
}
export function setupCredentialDigest(credential: ClaudeSetupToken | null): string {
  return createHash("sha256").update(JSON.stringify(credential)).digest("hex");
}

/** One serialized writer per local binding. The journal contains no credential values. */
export class ClaudeSetupDeliveryService {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly ports: ClaudeSetupDeliveryPorts) {}

  apply(input: unknown): Promise<ClaudeSetupDeliveryReceipt> {
    const parsed = ClaudeSetupDeliverySchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new ClaudeSetupDeliveryError());
    const task = this.queue.then(() => this.deliver(parsed.data));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async deliver(delivery: ClaudeSetupDelivery): Promise<ClaudeSetupDeliveryReceipt> {
    try {
      await this.ports.authorize(delivery);
      const { credential, ...scopeAndRevision } = delivery;
      const digest = setupCredentialDigest(credential);
      const previous = this.ports.read();
      if (previous) {
        for (const key of ScopeSchema.keyof().options)
          if (previous[key] !== delivery[key]) throw new ClaudeSetupDeliveryError();
        const old = delivery.revision < previous.revision;
        const changed =
          delivery.revision === previous.revision &&
          (digest !== previous.digest || delivery.policyRevision !== previous.policyRevision);
        if (old || changed) throw new ClaudeSetupDeliveryError();
      }
      const pending: ClaudeSetupDeliveryReceipt = {
        ...scopeAndRevision,
        digest,
        phase: "pending",
        active: credential !== null,
      };
      this.ports.persist(pending);
      await this.ports.store(credential);
      // A newly excluded connection cannot receive a successful applied receipt.
      await this.ports.authorize(delivery);
      const applied: ClaudeSetupDeliveryReceipt = { ...pending, phase: "applied" };
      this.ports.persist(applied);
      return applied;
    } catch {
      throw new ClaudeSetupDeliveryError();
    }
  }
}
