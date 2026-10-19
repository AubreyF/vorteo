import { z } from "zod";
import {
  ClaudeSetupTokenSchema,
  type ClaudeSetupToken,
} from "../../agent/providers/claude/setup-token-store.js";
import {
  ClaudeSetupDeliveryError,
  setupCredentialDigest,
  type ClaudeSetupDelivery,
  type ClaudeSetupDeliveryReceipt,
} from "./claude-setup-delivery.js";

const TargetSchema = z.strictObject({
  serverId: z.string().min(1),
  providerId: z.string().min(1),
  excluded: z.boolean(),
  applied: z.boolean(),
});
const RecordSchema = z.strictObject({
  definitionId: z.string().min(1),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  policyRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  credential: ClaudeSetupTokenSchema.nullable(),
  targets: z.array(TargetSchema),
});
export const ClaudeSetupAuthorityStateSchema = z.array(RecordSchema);
export type ClaudeSetupAuthorityState = z.infer<typeof ClaudeSetupAuthorityStateSchema>;
export interface ClaudeSetupPolicy {
  revision: number;
  removed: boolean;
  targets: Array<{ serverId: string; providerId: string; excluded: boolean }>;
}
interface AuthorityPorts {
  installationId: string;
  read(): unknown;
  persist(state: ClaudeSetupAuthorityState): void;
  policy(definitionId: string): ClaudeSetupPolicy;
  deliver(delivery: ClaudeSetupDelivery): Promise<ClaudeSetupDeliveryReceipt>;
}

/** Canonical setup tokens stay here. Public status deliberately constructs a secret-free view. */
export class ClaudeSetupAuthority {
  private records: ClaudeSetupAuthorityState;
  private queue: Promise<void> = Promise.resolve();
  private persistenceFailed = false;
  private reconciliation: Promise<void> | null = null;
  constructor(private readonly ports: AuthorityPorts) {
    const parsed = ClaudeSetupAuthorityStateSchema.safeParse(ports.read());
    if (!parsed.success) throw new ClaudeSetupDeliveryError();
    this.records = parsed.data;
    if (new Set(this.records.map((record) => record.definitionId)).size !== this.records.length)
      throw new ClaudeSetupDeliveryError();
  }

  status(definitionId: string) {
    if (this.persistenceFailed) throw new ClaudeSetupDeliveryError();
    const record = this.records.find((item) => item.definitionId === definitionId);
    if (!record) return { connected: false, environments: [] };
    const policy = this.ports.policy(definitionId);
    const current = policy.revision === record.policyRevision;
    return {
      connected: record.credential !== null && !policy.removed,
      environments: policy.targets.map((target) => {
        let status = record.credential ? "pending" : "disconnecting";
        if (target.excluded) status = "excluded";
        else if (
          current &&
          record.targets.some(
            (saved) =>
              saved.serverId === target.serverId &&
              saved.providerId === target.providerId &&
              saved.applied,
          )
        ) {
          status = record.credential ? "ready" : "disconnected";
        }
        return { serverId: target.serverId, status };
      }),
    };
  }

  save(definitionId: string, input: unknown, signal?: AbortSignal): Promise<void> {
    const credential = ClaudeSetupTokenSchema.safeParse(input);
    if (!credential.success) return Promise.reject(new ClaudeSetupDeliveryError());
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      const policy = this.ports.policy(definitionId);
      if (policy.removed) throw new ClaudeSetupDeliveryError();
      this.replace(definitionId, credential.data, policy);
    });
  }

  signOut(definitionId: string): Promise<void> {
    return this.enqueue(async () => {
      this.replace(definitionId, null, this.ports.policy(definitionId));
    });
  }

  reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const task = this.enqueue(async () => {
      for (const original of this.records) {
        const policy = this.ports.policy(original.definitionId);
        if (policy.revision !== original.policyRevision || (policy.removed && original.credential))
          this.replace(original.definitionId, policy.removed ? null : original.credential, policy);
        const record = this.records.find((item) => item.definitionId === original.definitionId)!;
        for (const target of record.targets) {
          if (target.applied) continue;
          const credential = target.excluded ? null : record.credential;
          const delivery: ClaudeSetupDelivery = {
            installationId: this.ports.installationId,
            serverId: target.serverId,
            definitionId: record.definitionId,
            providerId: target.providerId,
            revision: record.revision,
            policyRevision: record.policyRevision,
            credential,
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
              receipt.phase === "applied" &&
              receipt.active === (credential !== null) &&
              receipt.digest === setupCredentialDigest(credential);
            if (
              !matching ||
              this.ports.policy(record.definitionId).revision !== record.policyRevision
            )
              continue;
            const next = structuredClone(this.records);
            const updated = next.find((item) => item.definitionId === record.definitionId)!;
            updated.targets.find(
              (item) => item.serverId === target.serverId && item.providerId === target.providerId,
            )!.applied = true;
            this.commit(next);
          } catch {
            // Offline environments retain pending delivery and retry the identical generation.
          }
        }
      }
    });
    this.reconciliation = task.finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  private replace(
    definitionId: string,
    credential: ClaudeSetupToken | null,
    policy: ClaudeSetupPolicy,
  ) {
    const previous = this.records.find((item) => item.definitionId === definitionId);
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new ClaudeSetupDeliveryError();
    const next = this.records.filter((item) => item.definitionId !== definitionId);
    next.push({
      definitionId,
      credential,
      revision,
      policyRevision: policy.revision,
      targets: policy.targets.map((target) => ({ ...target, applied: false })),
    });
    this.commit(next);
  }

  private commit(next: ClaudeSetupAuthorityState) {
    try {
      this.ports.persist(next);
    } catch {
      // A failed durable acknowledgement may follow a successful rename. Do not reuse its epoch.
      this.persistenceFailed = true;
      throw new ClaudeSetupDeliveryError();
    }
    this.records = next;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(() => {
      if (this.persistenceFailed) throw new ClaudeSetupDeliveryError();
      return operation();
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
