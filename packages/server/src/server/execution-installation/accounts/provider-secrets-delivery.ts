import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { isProviderSecretName } from "@getpaseo/protocol/provider-secrets";

const NameSchema = z.string().refine(isProviderSecretName);
const RevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ScopeSchema = z.strictObject({
  installationId: z.string().uuid(),
  serverId: z.string().min(1),
  definitionId: z.string().min(1),
  providerId: z.string().min(1),
});
/**
 * The complete set of coordinator-managed secrets for one local provider. Names the daemon
 * managed before and that are absent here are withdrawn. An empty set withdraws everything.
 */
export const ProviderSecretsDeliverySchema = ScopeSchema.extend({
  revision: RevisionSchema,
  policyRevision: RevisionSchema,
  values: z.record(
    NameSchema,
    z
      .string()
      .min(1)
      .max(16 * 1024),
  ),
  /** Names the owner set explicitly. Only these replace a differing local value. */
  overwrite: z.array(NameSchema),
});
export type ProviderSecretsDelivery = z.infer<typeof ProviderSecretsDeliverySchema>;
export const ProviderSecretsReceiptSchema = ScopeSchema.extend({
  revision: RevisionSchema,
  policyRevision: RevisionSchema,
  digest: DigestSchema,
  phase: z.literal("applied"),
  /** Names whose differing local value was left untouched. */
  conflicts: z.array(NameSchema),
});
export type ProviderSecretsReceipt = z.infer<typeof ProviderSecretsReceiptSchema>;
/** Daemon-local journal. Holds value digests only, never values. */
export const ProviderSecretsJournalSchema = z.strictObject({
  definitionId: z.string().min(1),
  providerId: z.string().min(1),
  revision: RevisionSchema,
  managed: z.record(NameSchema, DigestSchema),
});
export type ProviderSecretsJournal = z.infer<typeof ProviderSecretsJournalSchema>;

export class ProviderSecretsDeliveryError extends Error {
  constructor() {
    super("Provider key synchronization is pending. Retry after reconnecting the environment.");
  }
}

export function providerSecretDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Binds a receipt to the exact delivered values without revealing them. */
export function providerSecretsDeliveryDigest(
  delivery: Pick<ProviderSecretsDelivery, "values" | "overwrite">,
): string {
  const values = Object.keys(delivery.values)
    .sort()
    .map((name) => [name, delivery.values[name]]);
  const overwrite = [...new Set(delivery.overwrite)].sort();
  return createHash("sha256").update(JSON.stringify({ values, overwrite })).digest("hex");
}

/**
 * Withdraw previously delivered names that are no longer wanted and write the current values.
 * A local value that differs from what was delivered is left alone unless the owner set it.
 */
function mergeProviderSecrets(
  env: Record<string, string>,
  owned: Record<string, string>,
  delivery: ProviderSecretsDelivery,
) {
  const next = { ...env };
  const managed: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const [name, digest] of Object.entries(owned)) {
    if (Object.hasOwn(delivery.values, name)) continue;
    // A value changed locally after delivery is no longer ours to remove.
    if (next[name] !== undefined && providerSecretDigest(next[name]) === digest) delete next[name];
  }
  for (const [name, value] of Object.entries(delivery.values)) {
    const current = env[name];
    const ours =
      current === undefined ||
      current === value ||
      (owned[name] !== undefined && providerSecretDigest(current) === owned[name]) ||
      delivery.overwrite.includes(name);
    if (!ours) {
      conflicts.push(name);
      continue;
    }
    next[name] = value;
    managed[name] = providerSecretDigest(value);
  }
  return { env: next, managed, conflicts };
}

export interface ProviderSecretsDeliveryPorts {
  read(): ProviderSecretsJournal | null;
  persist(journal: ProviderSecretsJournal): void;
  /** The local provider env, or null when the binding does not exist or was removed. */
  readEnv(): Record<string, string> | null;
  writeEnv(env: Record<string, string>): Promise<void> | void;
  /** Fresh authority policy must still target this binding and permit this operation. */
  authorize(delivery: ProviderSecretsDelivery): Promise<void>;
}

/** One serialized writer per local provider binding. */
export class ProviderSecretsDeliveryService {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly ports: ProviderSecretsDeliveryPorts) {}

  apply(input: unknown): Promise<ProviderSecretsReceipt> {
    const parsed = ProviderSecretsDeliverySchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new ProviderSecretsDeliveryError());
    const task = this.queue.then(() => this.deliver(parsed.data));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async deliver(delivery: ProviderSecretsDelivery): Promise<ProviderSecretsReceipt> {
    try {
      await this.ports.authorize(delivery);
      const previous = this.ports.read();
      const sameDefinition =
        previous?.definitionId === delivery.definitionId &&
        previous.providerId === delivery.providerId;
      if (previous && sameDefinition && delivery.revision < previous.revision)
        throw new ProviderSecretsDeliveryError();
      const owned = previous?.providerId === delivery.providerId ? previous.managed : {};
      const env = this.ports.readEnv();
      let result: { managed: Record<string, string>; conflicts: string[] } = {
        managed: {},
        conflicts: [],
      };
      if (env === null) {
        // Nothing local to withdraw from; values need the account binding first.
        if (Object.keys(delivery.values).length > 0) throw new ProviderSecretsDeliveryError();
      } else {
        const merged = mergeProviderSecrets(env, owned, delivery);
        if (!isDeepStrictEqual(merged.env, env)) await this.ports.writeEnv(merged.env);
        result = merged;
      }
      // A newly excluded environment cannot receive a successful receipt for values.
      await this.ports.authorize(delivery);
      this.ports.persist({
        definitionId: delivery.definitionId,
        providerId: delivery.providerId,
        revision: delivery.revision,
        managed: result.managed,
      });
      const { values: _values, overwrite: _overwrite, ...scope } = delivery;
      return {
        ...scope,
        digest: providerSecretsDeliveryDigest(delivery),
        phase: "applied",
        conflicts: result.conflicts.sort(),
      };
    } catch {
      throw new ProviderSecretsDeliveryError();
    }
  }
}
