import { z } from "zod";
import {
  isProviderSecretName,
  type ProviderSecretEnvironmentStatus,
  type ProviderSecretsStatus,
} from "@getpaseo/protocol/provider-secrets";
import {
  ProviderSecretsDeliveryError,
  providerSecretsDeliveryDigest,
  type ProviderSecretsDelivery,
  type ProviderSecretsReceipt,
} from "./provider-secrets-delivery.js";

const NameSchema = z.string().refine(isProviderSecretName);
const RevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SecretSchema = z.strictObject({
  value: z.string().min(1),
  updatedAt: z.string().datetime(),
  source: z.enum(["owner", "imported"]),
});
const TargetSchema = z.strictObject({
  serverId: z.string().min(1),
  providerId: z.string().min(1),
  excluded: z.boolean(),
  applied: z.boolean(),
  conflicts: z.array(NameSchema),
});
const RecordSchema = z.strictObject({
  definitionId: z.string().min(1),
  revision: RevisionSchema,
  policyRevision: RevisionSchema,
  /** One-time adoption of values already present in environment configuration. */
  scanned: z.boolean(),
  secrets: z.record(NameSchema, SecretSchema),
  conflicts: z.array(z.strictObject({ name: NameSchema, serverIds: z.array(z.string()) })),
  targets: z.array(TargetSchema),
});
export const ProviderSecretsStateSchema = z.array(RecordSchema);
export type ProviderSecretsState = z.infer<typeof ProviderSecretsStateSchema>;
type SecretsRecord = z.infer<typeof RecordSchema>;
type EnvironmentProviders = Record<string, Record<string, string> | undefined>;

export interface ProviderSecretsPolicy {
  revision: number;
  /** Removed, or no longer in the shared catalog. Values are withdrawn and discarded. */
  removed: boolean;
  targets: Array<{ serverId: string; providerId: string; excluded: boolean }>;
}

/** Thrown by `deliver` when a daemon does not advertise providerSecretDelivery. */
export class ProviderSecretsUnsupportedError extends Error {
  constructor() {
    super("The daemon does not support provider key synchronization");
  }
}

interface AuthorityPorts {
  installationId: string;
  read(): unknown;
  persist(state: ProviderSecretsState): void;
  /** Shared definitions eligible for secrets, in catalog order. */
  definitions(): string[];
  policy(definitionId: string): ProviderSecretsPolicy;
  environment(serverId: string): { kind: "host" | "container"; label: string } | undefined;
  /** Every provider env in one environment, for one-time import. Throws when unreachable. */
  readEnvironment(serverId: string): Promise<EnvironmentProviders>;
  deliver(delivery: ProviderSecretsDelivery): Promise<ProviderSecretsReceipt>;
  now(): Date;
}

function last4(value: string): string | null {
  return value.length >= 16 ? value.slice(-4) : null;
}

/**
 * Canonical static provider secrets (API keys and tokens). Values stay in this state and are
 * delivered to daemons only; status views carry names, last four characters and timestamps.
 */
export class ProviderSecretsAuthority {
  private records: ProviderSecretsState;
  private queue: Promise<void> = Promise.resolve();
  private persistenceFailed = false;
  private reconciliation: Promise<void> | null = null;
  /** Last delivery failure per definition and environment. Messages never contain values. */
  private readonly failures = new Map<string, string>();

  constructor(private readonly ports: AuthorityPorts) {
    const parsed = ProviderSecretsStateSchema.safeParse(ports.read());
    if (!parsed.success) throw new ProviderSecretsDeliveryError();
    this.records = parsed.data;
    if (new Set(this.records.map((record) => record.definitionId)).size !== this.records.length)
      throw new ProviderSecretsDeliveryError();
  }

  status(definitionId: string): ProviderSecretsStatus {
    if (this.persistenceFailed) throw new ProviderSecretsDeliveryError();
    const policy = this.ports.policy(definitionId);
    const record = this.records.find((item) => item.definitionId === definitionId);
    const current = record?.policyRevision === policy.revision;
    const environments: ProviderSecretEnvironmentStatus[] = [];
    for (const target of policy.targets) {
      const environment = this.ports.environment(target.serverId);
      if (!environment) continue;
      const entry: ProviderSecretEnvironmentStatus = {
        serverId: target.serverId,
        kind: environment.kind,
        status: "pending",
      };
      const saved = record?.targets.find(
        (item) => item.serverId === target.serverId && item.providerId === target.providerId,
      );
      const failure = this.failures.get(`${definitionId}\0${target.serverId}`);
      if (target.excluded) entry.status = "excluded";
      else if (!record) entry.message = `Checking existing keys in ${environment.label}`;
      else if (current && saved?.applied) {
        entry.status = "delivered";
        if (saved.conflicts.length > 0) {
          entry.status = "failed";
          entry.conflicts = [...saved.conflicts];
          entry.message = `${environment.label} has a different ${saved.conflicts.join(", ")}. Set the key here to replace it.`;
        }
      } else if (failure) {
        entry.status = "failed";
        entry.message = failure;
      } else entry.message = `Reaching ${environment.label}`;
      environments.push(entry);
    }
    return {
      definitionId,
      secrets: Object.entries(record?.secrets ?? {})
        .map(([name, secret]) => ({
          name,
          last4: last4(secret.value),
          updatedAt: secret.updatedAt,
          source: secret.source,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      environments,
      conflicts: structuredClone(record?.conflicts ?? []),
      ready:
        record !== undefined &&
        environments.every((item) => item.status === "delivered" || item.status === "excluded"),
    };
  }

  statuses(): ProviderSecretsStatus[] {
    return this.ports.definitions().map((definitionId) => this.status(definitionId));
  }

  set(definitionId: string, name: string, value: string): Promise<void> {
    if (!isProviderSecretName(name) || value.length === 0)
      return Promise.reject(new ProviderSecretsDeliveryError());
    return this.enqueue(async () => {
      const policy = this.ports.policy(definitionId);
      if (policy.removed) throw new ProviderSecretsDeliveryError();
      const record = this.records.find((item) => item.definitionId === definitionId);
      const secrets = structuredClone(record?.secrets ?? {});
      secrets[name] = { value, updatedAt: this.ports.now().toISOString(), source: "owner" };
      this.replace(definitionId, policy, {
        secrets,
        conflicts: (record?.conflicts ?? []).filter((item) => item.name !== name),
      });
    });
  }

  clear(definitionId: string, name: string): Promise<void> {
    return this.enqueue(async () => {
      const policy = this.ports.policy(definitionId);
      const record = this.records.find((item) => item.definitionId === definitionId);
      const secrets = structuredClone(record?.secrets ?? {});
      delete secrets[name];
      this.replace(definitionId, policy, {
        secrets,
        conflicts: (record?.conflicts ?? []).filter((item) => item.name !== name),
      });
    });
  }

  /** Network reads and deliveries run outside the state lock, so saves stay responsive. */
  reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const task = (async () => {
      if (this.persistenceFailed) throw new ProviderSecretsDeliveryError();
      await this.importExisting();
      await this.enqueue(async () => {
        for (const original of this.records) {
          const policy = this.ports.policy(original.definitionId);
          if (
            policy.revision !== original.policyRevision ||
            (policy.removed && Object.keys(original.secrets).length > 0)
          )
            this.replace(original.definitionId, policy, {
              secrets: policy.removed ? {} : original.secrets,
              conflicts: policy.removed ? [] : original.conflicts,
            });
        }
      });
      for (const record of this.records)
        for (const target of record.targets)
          if (!target.applied) await this.deliverTarget(record, target);
    })();
    this.reconciliation = task.finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  private async deliverTarget(record: SecretsRecord, target: SecretsRecord["targets"][number]) {
    const key = `${record.definitionId}\0${target.serverId}`;
    const label = this.ports.environment(target.serverId)?.label ?? "the environment";
    const values = target.excluded
      ? {}
      : Object.fromEntries(
          Object.entries(record.secrets).map(([name, item]) => [name, item.value]),
        );
    const overwrite = target.excluded
      ? []
      : Object.entries(record.secrets)
          .filter(([, item]) => item.source === "owner")
          .map(([name]) => name)
          .sort();
    const delivery: ProviderSecretsDelivery = {
      installationId: this.ports.installationId,
      serverId: target.serverId,
      definitionId: record.definitionId,
      providerId: target.providerId,
      revision: record.revision,
      policyRevision: record.policyRevision,
      values,
      overwrite,
    };
    try {
      const receipt = await this.ports.deliver(delivery);
      const matching =
        receipt.installationId === delivery.installationId &&
        receipt.serverId === delivery.serverId &&
        receipt.definitionId === delivery.definitionId &&
        receipt.providerId === delivery.providerId &&
        receipt.revision === delivery.revision &&
        receipt.policyRevision === delivery.policyRevision &&
        receipt.digest === providerSecretsDeliveryDigest(delivery);
      if (!matching) throw new ProviderSecretsDeliveryError();
      await this.enqueue(async () => {
        if (this.ports.policy(record.definitionId).revision !== record.policyRevision) return;
        const next = structuredClone(this.records);
        const updated = next.find((item) => item.definitionId === record.definitionId);
        const saved = updated?.targets.find(
          (item) => item.serverId === target.serverId && item.providerId === target.providerId,
        );
        // A save during delivery starts a new generation that still needs its own delivery.
        if (!updated || !saved || updated.revision !== record.revision) return;
        saved.applied = true;
        saved.conflicts = receipt.conflicts.filter((name) => Object.hasOwn(values, name));
        this.commit(next);
        this.failures.delete(key);
      });
    } catch (error) {
      // Offline environments retain pending delivery and retry the identical generation.
      this.failures.set(
        key,
        error instanceof ProviderSecretsUnsupportedError
          ? `Update ${label} to receive shared keys.`
          : `${label} has not received the current keys yet. Retrying.`,
      );
    }
  }

  /** Adopt values that exist in exactly one form across bound environments; report the rest. */
  private async importExisting() {
    const pending = this.ports.definitions().filter((definitionId) => {
      const record = this.records.find((item) => item.definitionId === definitionId);
      return !record?.scanned;
    });
    if (pending.length === 0) return;
    const environments = new Map<string, EnvironmentProviders>();
    for (const definitionId of pending) {
      const policy = this.ports.policy(definitionId);
      if (policy.removed) continue;
      const observed = await this.observe(policy, environments);
      if (observed) await this.enqueue(async () => this.adopt(definitionId, observed));
    }
  }

  private adopt(definitionId: string, observed: Map<string, Map<string, string[]>>) {
    const record = this.records.find((item) => item.definitionId === definitionId);
    // A concurrent reconcile or removal may already have settled this definition.
    const policy = this.ports.policy(definitionId);
    if (record?.scanned || policy.removed) return;
    const secrets = structuredClone(record?.secrets ?? {});
    const conflicts = structuredClone(record?.conflicts ?? []);
    const updatedAt = this.ports.now().toISOString();
    for (const [name, values] of observed) {
      // Owner-set values always win over local copies.
      if (Object.hasOwn(secrets, name) || conflicts.some((item) => item.name === name)) continue;
      if (values.size === 1)
        secrets[name] = { value: [...values.keys()][0]!, updatedAt, source: "imported" };
      else conflicts.push({ name, serverIds: [...new Set([...values.values()].flat())].sort() });
    }
    this.replace(definitionId, policy, { secrets, conflicts, scanned: true });
  }

  /** Secret values per name and the environments holding each, or null if one is unreachable. */
  private async observe(policy: ProviderSecretsPolicy, cache: Map<string, EnvironmentProviders>) {
    const observed = new Map<string, Map<string, string[]>>();
    for (const target of policy.targets) {
      if (target.excluded || !this.ports.environment(target.serverId)) continue;
      let providers = cache.get(target.serverId);
      if (!providers) {
        try {
          providers = await this.ports.readEnvironment(target.serverId);
        } catch {
          return null;
        }
        cache.set(target.serverId, providers);
      }
      for (const [name, value] of Object.entries(providers[target.providerId] ?? {})) {
        if (!isProviderSecretName(name) || value.length === 0) continue;
        const values = observed.get(name) ?? new Map<string, string[]>();
        values.set(value, [...(values.get(value) ?? []), target.serverId]);
        observed.set(name, values);
      }
    }
    return observed;
  }

  private replace(
    definitionId: string,
    policy: ProviderSecretsPolicy,
    change: Pick<SecretsRecord, "secrets" | "conflicts"> & { scanned?: boolean },
  ) {
    const previous = this.records.find((item) => item.definitionId === definitionId);
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new ProviderSecretsDeliveryError();
    const empty = Object.keys(change.secrets).length === 0;
    const targets = policy.targets.map((target) => {
      const saved = previous?.targets.find(
        (item) => item.serverId === target.serverId && item.providerId === target.providerId,
      );
      // Nothing was ever outstanding for this binding, so there is nothing to deliver or withdraw.
      const idle =
        empty &&
        (!previous || (Object.keys(previous.secrets).length === 0 && saved?.applied === true));
      return { ...target, applied: idle, conflicts: [] };
    });
    // Bindings that left the policy still need withdrawal of what they received.
    for (const saved of previous?.targets ?? [])
      if (
        !targets.some(
          (item) => item.serverId === saved.serverId && item.providerId === saved.providerId,
        ) &&
        !(saved.excluded && saved.applied) &&
        (Object.keys(previous!.secrets).length > 0 || !saved.applied)
      )
        targets.push({ ...saved, excluded: true, applied: false, conflicts: [] });
    const next = this.records.filter((item) => item.definitionId !== definitionId);
    next.push({
      definitionId,
      revision,
      policyRevision: policy.revision,
      scanned: change.scanned ?? previous?.scanned ?? false,
      secrets: change.secrets,
      conflicts: change.conflicts,
      targets,
    });
    this.commit(next);
  }

  private commit(next: ProviderSecretsState) {
    try {
      this.ports.persist(next);
    } catch {
      // A failed durable acknowledgement may follow a successful rename. Do not reuse its epoch.
      this.persistenceFailed = true;
      throw new ProviderSecretsDeliveryError();
    }
    this.records = next;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(() => {
      if (this.persistenceFailed) throw new ProviderSecretsDeliveryError();
      return operation();
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
