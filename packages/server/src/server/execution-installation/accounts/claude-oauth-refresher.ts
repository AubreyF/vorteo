import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  accessProjectionDigest,
  ClaudeOAuthDeliveryError,
  type ClaudeAccessProjection,
  type ClaudeOAuthProjectionDelivery,
  type ClaudeOAuthProjectionReceipt,
} from "./claude-oauth-delivery.js";
import {
  CLAUDE_REFRESH_LEAD_MS,
  claudeAccessProjection,
  needsHostRefresh,
  type ClaudeIdentity,
  type ClaudeOAuthGrant,
} from "./claude-oauth-host.js";

const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TargetSchema = z.strictObject({
  serverId: z.string().min(1),
  providerId: z.string().min(1),
  excluded: z.boolean(),
  appliedRotation: Counter.nullable(),
});
/** Secret-free by construction: digests, expiry and identity only, never a token. */
const RecordSchema = z.strictObject({
  definitionId: z.string().min(1),
  generation: Positive,
  rotation: Counter,
  signedIn: z.boolean(),
  hostGrant: z.enum(["present", "missing"]).nullable(),
  policyRevision: Positive,
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  expiresAt: Counter.nullable(),
  identity: z
    .strictObject({ email: z.string().nullable(), orgId: z.string().nullable() })
    .nullable(),
  checkedAt: Counter.nullable(),
  refresh: z
    .strictObject({ at: Counter, outcome: z.enum(["refreshed", "unchanged", "failed"]) })
    .nullable(),
  targets: z.array(TargetSchema),
});
export const ClaudeOAuthStateSchema = z.array(RecordSchema);
export type ClaudeOAuthState = z.infer<typeof ClaudeOAuthStateSchema>;
type ClaudeOAuthRecord = ClaudeOAuthState[number];

export interface ClaudeOAuthPolicy {
  revision: number;
  removed: boolean;
  /** Dev environments that receive access projections. */
  targets: Array<{ serverId: string; providerId: string; excluded: boolean }>;
}

export interface ClaudeOAuthRefresherPorts {
  installationId: string;
  read(): unknown;
  persist(state: ClaudeOAuthState): void;
  /** Throws when the definition no longer exists or is not a full sign-in account. */
  policy(definitionId: string): ClaudeOAuthPolicy;
  /** The Host account's grant, read from its own CLI storage. Throws when the Host is unreachable. */
  grant(definitionId: string): Promise<ClaudeOAuthGrant | null>;
  /** Option A: a tiny official CLI request that lets the CLI refresh under its own locks. */
  refresh(definitionId: string): Promise<void>;
  deliver(delivery: ClaudeOAuthProjectionDelivery): Promise<ClaudeOAuthProjectionReceipt>;
  now(): number;
}

/** Normal cadence for noticing a rotation made by a Host agent or a new sign-in. */
const RECHECK_MS = 5 * 60_000;
/** Near expiry every reconcile reads the grant; a failed refresh is retried after this. */
const REFRESH_RETRY_MS = 60_000;

/**
 * The coordinator's Host-owned refresh. It keeps the Host grant fresh only while a Dev
 * environment can use it, delivers access-only projections in generation and rotation order,
 * and withdraws them on exclusion, removal, sign-out or a missing Host grant. The access token
 * lives in memory for one reconcile; a pending delivery re-reads it from the Host.
 */
export class ClaudeOAuthRefresher {
  private records: ClaudeOAuthState;
  private queue: Promise<void> = Promise.resolve();
  private reconciliation: Promise<void> | null = null;
  private persistenceFailed = false;

  constructor(private readonly ports: ClaudeOAuthRefresherPorts) {
    const parsed = ClaudeOAuthStateSchema.safeParse(ports.read());
    if (!parsed.success) throw new ClaudeOAuthDeliveryError();
    this.records = parsed.data;
    if (new Set(this.records.map((record) => record.definitionId)).size !== this.records.length)
      throw new ClaudeOAuthDeliveryError();
  }

  status(definitionId: string) {
    if (this.persistenceFailed) throw new ClaudeOAuthDeliveryError();
    const record = this.records.find((item) => item.definitionId === definitionId);
    if (!record)
      return {
        signedIn: false,
        needsSignIn: false,
        identity: null,
        expiresAt: null,
        refresh: null,
        environments: [],
      };
    let policy: ClaudeOAuthPolicy;
    try {
      policy = this.ports.policy(definitionId);
    } catch {
      policy = { revision: record.policyRevision, removed: true, targets: record.targets };
    }
    const current = policy.revision === record.policyRevision;
    const usable = record.signedIn && record.hostGrant === "present" && !policy.removed;
    return {
      signedIn: record.signedIn,
      needsSignIn: record.signedIn && record.hostGrant === "missing",
      identity: record.identity,
      expiresAt: record.expiresAt,
      refresh: record.refresh,
      environments: policy.targets.map((target) => {
        let status = record.signedIn ? "pending" : "disconnecting";
        if (target.excluded) status = "excluded";
        else if (
          current &&
          record.targets.some(
            (saved) =>
              saved.serverId === target.serverId &&
              saved.providerId === target.providerId &&
              saved.appliedRotation === record.rotation,
          )
        )
          status = usable ? "ready" : "disconnected";
        return { serverId: target.serverId, status };
      }),
    };
  }

  /** A completed Host sign-in starts a new generation. */
  connected(definitionId: string, identity: ClaudeIdentity | null): Promise<void> {
    return this.enqueue(async () => {
      const policy = this.ports.policy(definitionId);
      if (policy.removed) throw new ClaudeOAuthDeliveryError();
      this.replace(definitionId, policy, { signedIn: true, identity, digest: null });
    });
  }

  /** Sign-out starts a new generation whose only projection is a withdrawal. */
  signedOut(definitionId: string): Promise<void> {
    return this.enqueue(async () => {
      const policy = this.ports.policy(definitionId);
      const previous = this.records.find((item) => item.definitionId === definitionId);
      this.replace(definitionId, policy, {
        signedIn: false,
        identity: previous?.identity ?? null,
        digest: accessProjectionDigest(null),
      });
    });
  }

  reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const task = this.enqueue(async () => {
      for (const original of this.records) {
        try {
          await this.reconcileRecord(original.definitionId);
        } catch {
          // An unreachable Host or Dev leaves this record pending for the next reconcile.
        }
      }
    });
    this.reconciliation = task.finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  private async reconcileRecord(definitionId: string): Promise<void> {
    const policy = this.ports.policy(definitionId);
    const current = this.records.find((item) => item.definitionId === definitionId)!;
    const next = structuredClone(current);
    applyPolicy(next, policy);
    const now = this.ports.now();
    // undefined: the Host was not read this reconcile, so there is nothing new to deliver.
    let desired: ClaudeAccessProjection | null | undefined = null;
    if (next.signedIn && !policy.removed)
      desired = isDue(next, now) ? await this.readHost(definitionId, next, now) : undefined;
    if (desired !== undefined) rotate(next, desired);
    // Rewrite state only when something changed; idle reconciles stay read-only.
    if (!isDeepStrictEqual(next, current)) this.commit(this.withRecord(next));
    if (desired !== undefined) await this.deliverPending(definitionId, next, desired);
  }

  /** Reads the Host grant, refreshing it first when Dev can use it and it is about to expire. */
  private async readHost(
    definitionId: string,
    next: ClaudeOAuthRecord,
    now: number,
  ): Promise<ClaudeAccessProjection | null> {
    let grant = await this.ports.grant(definitionId);
    const devActive = next.targets.some((target) => !target.excluded);
    const retry = next.refresh === null || now - next.refresh.at >= REFRESH_RETRY_MS;
    if (devActive && retry && needsHostRefresh(grant, now))
      grant = await this.refreshHost(definitionId, grant, next, now);
    next.checkedAt = now;
    const desired = claudeAccessProjection(grant);
    next.hostGrant = desired ? "present" : "missing";
    next.expiresAt = desired?.expiresAt ?? null;
    return desired;
  }

  private async refreshHost(
    definitionId: string,
    grant: ClaudeOAuthGrant | null,
    next: ClaudeOAuthRecord,
    now: number,
  ): Promise<ClaudeOAuthGrant | null> {
    const before = grant?.expiresAt ?? null;
    try {
      await this.ports.refresh(definitionId);
      const after = await this.ports.grant(definitionId);
      const advanced =
        after !== null && after.expiresAt !== null && (before === null || after.expiresAt > before);
      next.refresh = { at: now, outcome: advanced ? "refreshed" : "unchanged" };
      return after;
    } catch {
      next.refresh = { at: now, outcome: "failed" };
      return grant;
    }
  }

  private async deliverPending(
    definitionId: string,
    next: ClaudeOAuthRecord,
    desired: ClaudeAccessProjection | null,
  ): Promise<void> {
    for (const target of next.targets) {
      if (target.appliedRotation === next.rotation) continue;
      const delivery: ClaudeOAuthProjectionDelivery = {
        installationId: this.ports.installationId,
        serverId: target.serverId,
        definitionId,
        providerId: target.providerId,
        policyRevision: next.policyRevision,
        generation: next.generation,
        rotation: next.rotation,
        access: target.excluded ? null : desired,
      };
      try {
        const receipt = await this.ports.deliver(delivery);
        if (!receiptMatches(receipt, delivery)) continue;
        if (this.ports.policy(definitionId).revision !== next.policyRevision) continue;
        target.appliedRotation = next.rotation;
        this.commit(this.withRecord(next));
      } catch {
        // Offline Dev keeps this rotation pending; the token is read again next time.
      }
    }
  }

  private replace(
    definitionId: string,
    policy: ClaudeOAuthPolicy,
    values: { signedIn: boolean; identity: ClaudeIdentity | null; digest: string | null },
  ): void {
    const previous = this.records.find((item) => item.definitionId === definitionId);
    const generation = (previous?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new ClaudeOAuthDeliveryError();
    this.commit(
      this.withRecord({
        definitionId,
        generation,
        rotation: 0,
        signedIn: values.signedIn,
        hostGrant: null,
        policyRevision: policy.revision,
        digest: values.digest,
        expiresAt: null,
        identity: values.identity,
        checkedAt: null,
        refresh: null,
        targets: policy.targets.map((target) => ({ ...target, appliedRotation: null })),
      }),
    );
  }

  private withRecord(record: ClaudeOAuthRecord): ClaudeOAuthState {
    return [...this.records.filter((item) => item.definitionId !== record.definitionId), record];
  }

  private commit(next: ClaudeOAuthState): void {
    try {
      this.ports.persist(next);
    } catch {
      this.persistenceFailed = true;
      throw new ClaudeOAuthDeliveryError();
    }
    this.records = next;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(() => {
      if (this.persistenceFailed) throw new ClaudeOAuthDeliveryError();
      return operation();
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}

function applyPolicy(next: ClaudeOAuthRecord, policy: ClaudeOAuthPolicy): void {
  if (policy.revision === next.policyRevision) return;
  next.policyRevision = policy.revision;
  next.rotation += 1;
  next.targets = policy.targets.map((target) => ({ ...target, appliedRotation: null }));
}

function isDue(next: ClaudeOAuthRecord, now: number): boolean {
  if (next.targets.some((target) => target.appliedRotation !== next.rotation)) return true;
  if (next.checkedAt === null || now - next.checkedAt >= RECHECK_MS) return true;
  return (
    next.expiresAt !== null && next.expiresAt - now <= CLAUDE_REFRESH_LEAD_MS + REFRESH_RETRY_MS
  );
}

/** A changed projection, including a withdrawal, takes the next rotation slot. */
function rotate(next: ClaudeOAuthRecord, desired: ClaudeAccessProjection | null): void {
  const digest = accessProjectionDigest(desired);
  if (digest === next.digest) return;
  next.digest = digest;
  next.rotation += 1;
}

function receiptMatches(
  receipt: ClaudeOAuthProjectionReceipt,
  delivery: ClaudeOAuthProjectionDelivery,
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
    receipt.digest === accessProjectionDigest(delivery.access)
  );
}
