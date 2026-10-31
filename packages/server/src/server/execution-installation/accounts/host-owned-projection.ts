import { z } from "zod";

/**
 * Wire format and Dev-side writer for Host-owned sign-in projections. The Host account's own CLI
 * storage keeps the only grant and the official Host CLI is the only refresh writer. Dev receives
 * access-only projections in generation and rotation order. Provider modules supply the access
 * schema (strict, so a refresh token fails validation) and its digest.
 */
export const ProjectionScopeSchema = z.strictObject({
  installationId: z.string().uuid(),
  serverId: z.string().min(1),
  definitionId: z.string().min(1),
  providerId: z.string().min(1),
});
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const ProjectionBindingRequestSchema = ProjectionScopeSchema.extend({
  policyRevision: Revision,
});

export function projectionDeliverySchema<A extends z.ZodType>(access: A) {
  return ProjectionScopeSchema.extend({
    policyRevision: Revision,
    /** Increments on each sign-in and sign-out. */
    generation: Revision,
    /** Increments on each new access token or withdrawal within a generation. */
    rotation: Counter,
    access: access.nullable(),
  });
}

export interface HostProjectionDelivery<P> {
  installationId: string;
  serverId: string;
  definitionId: string;
  providerId: string;
  policyRevision: number;
  generation: number;
  rotation: number;
  access: P | null;
}

export const ProjectionReceiptSchema = ProjectionScopeSchema.extend({
  policyRevision: Revision,
  generation: Revision,
  rotation: Counter,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["pending", "applied"]),
  active: z.boolean(),
});
export type HostProjectionReceipt = z.infer<typeof ProjectionReceiptSchema>;

export function projectionReceiptMatches(
  receipt: HostProjectionReceipt,
  delivery: HostProjectionDelivery<unknown>,
  digest: string,
): boolean {
  return (
    receipt.installationId === delivery.installationId &&
    receipt.serverId === delivery.serverId &&
    receipt.definitionId === delivery.definitionId &&
    receipt.providerId === delivery.providerId &&
    receipt.policyRevision === delivery.policyRevision &&
    receipt.generation === delivery.generation &&
    receipt.rotation === delivery.rotation &&
    receipt.phase === "applied" &&
    receipt.active === (delivery.access !== null) &&
    receipt.digest === digest
  );
}

export interface HostProjectionPorts<P> {
  /** Fresh authority policy must still target this binding and permit this operation. */
  authorize(delivery: HostProjectionDelivery<P>): Promise<void>;
  read(): HostProjectionReceipt | null;
  persist(receipt: HostProjectionReceipt): void;
  store(access: P | null): Promise<void>;
}

export interface HostProjectionFormat<P> {
  schema: z.ZodType<HostProjectionDelivery<P>>;
  digest(access: P | null): string;
  error(): Error;
}

/** One serialized writer per Dev binding. Its journal holds digests, never tokens. */
export class HostProjectionService<P> {
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly ports: HostProjectionPorts<P>,
    private readonly format: HostProjectionFormat<P>,
  ) {}

  apply(input: unknown): Promise<HostProjectionReceipt> {
    const parsed = this.format.schema.safeParse(input);
    if (!parsed.success) return Promise.reject(this.format.error());
    const task = this.queue.then(() => this.deliver(parsed.data));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async deliver(delivery: HostProjectionDelivery<P>): Promise<HostProjectionReceipt> {
    try {
      await this.ports.authorize(delivery);
      const { access, ...slot } = delivery;
      const digest = this.format.digest(access);
      const previous = this.ports.read();
      if (previous) {
        for (const key of ProjectionScopeSchema.keyof().options)
          if (previous[key] !== delivery[key]) throw this.format.error();
        const older =
          delivery.generation < previous.generation ||
          (delivery.generation === previous.generation && delivery.rotation < previous.rotation);
        const conflicting =
          delivery.generation === previous.generation &&
          delivery.rotation === previous.rotation &&
          digest !== previous.digest;
        if (older || conflicting) throw this.format.error();
      }
      const pending: HostProjectionReceipt = {
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
      const applied: HostProjectionReceipt = { ...pending, phase: "applied" };
      this.ports.persist(applied);
      return applied;
    } catch {
      throw this.format.error();
    }
  }
}
