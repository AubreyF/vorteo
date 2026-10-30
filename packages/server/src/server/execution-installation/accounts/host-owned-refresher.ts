import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  projectionReceiptMatches,
  type HostProjectionDelivery,
  type HostProjectionReceipt,
} from "./host-owned-projection.js";

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
  /** `orgId` is the provider's organization or workspace: Claude's org, Codex's ChatGPT account. */
  identity: z
    .strictObject({ email: z.string().nullable(), orgId: z.string().nullable() })
    .nullable(),
  checkedAt: Counter.nullable(),
  refresh: z
    .strictObject({ at: Counter, outcome: z.enum(["refreshed", "unchanged", "failed"]) })
    .nullable(),
  /** Consecutive refreshes of the current Host token that did not produce a newer one. */
  refreshFailures: Counter.default(0),
  /** Consecutive reconciles that left a rotation undelivered, and when to try again. */
  deliveryFailures: Counter.default(0),
  deliveryRetryAt: Counter.nullable().default(null),
  targets: z.array(TargetSchema),
});
export const HostRefreshStateSchema = z.array(RecordSchema);
export type HostRefreshState = z.infer<typeof HostRefreshStateSchema>;
type HostRefreshRecord = HostRefreshState[number];

export interface HostRefreshIdentity {
  email: string | null;
  orgId: string | null;
}

export interface HostRefreshPolicy {
  revision: number;
  removed: boolean;
  /** Dev environments that receive access projections. */
  targets: Array<{ serverId: string; providerId: string; excluded: boolean }>;
}

/** What the refresher needs to know about a Host grant. The refresh token itself never leaves. */
export interface HostGrant {
  expiresAt: number | null;
}

/** Provider rules for one kind of Host-owned credential. */
export interface HostGrantAdapter<G extends HostGrant, P> {
  /** Access-only view for Dev, or null when the grant cannot be projected usefully. */
  project(grant: G | null): P | null;
  digest(projection: P | null): string;
  /** Whether the Host should refresh this grant now. False without a refresh token. */
  needsRefresh(grant: G | null, now: number): boolean;
  /** How long before expiry the refresher starts reading the Host more often. */
  leadMs: number;
  /** Thrown, without detail, for every refusal. */
  error(): Error;
}

export interface HostRefresherPorts<G extends HostGrant, P> {
  installationId: string;
  read(): unknown;
  persist(state: HostRefreshState): void;
  /** Throws when the definition no longer exists or is not a Host-owned account. */
  policy(definitionId: string): HostRefreshPolicy;
  /** The Host account's grant, read from its own CLI storage. Throws when the Host is unreachable. */
  grant(definitionId: string): Promise<G | null>;
  /** Asks the official Host CLI to refresh under its own locks. */
  refresh(definitionId: string): Promise<void>;
  deliver(delivery: HostProjectionDelivery<P>): Promise<HostProjectionReceipt>;
  now(): number;
}

/** Normal cadence for noticing a rotation made by a Host agent or a new sign-in. */
const RECHECK_MS = 5 * 60_000;
/** First retry delay after a failed refresh; it doubles up to RECHECK_MS. */
const REFRESH_RETRY_MS = 60_000;
/** Failed refreshes of one token before an expired grant counts as lost and needs sign-in. */
const REFRESH_FAILURE_LIMIT = 3;
/** First retry delay for an undelivered rotation; it doubles up to RECHECK_MS. */
const DELIVERY_RETRY_MS = 30_000;

/**
 * The coordinator's Host-owned refresh, shared by every provider whose Host CLI keeps a rotating
 * grant. It keeps the Host grant fresh only while a Dev environment can use it, delivers
 * access-only projections in generation and rotation order, and withdraws them on exclusion,
 * removal, sign-out or a missing Host grant. The Host CLI is the only refresh writer. The access
 * token lives in memory for one reconcile; a pending delivery re-reads it from the Host.
 */
export class HostOwnedRefresher<G extends HostGrant, P> {
  private records: HostRefreshState;
  private queue: Promise<void> = Promise.resolve();
  private reconciliation: Promise<void> | null = null;
  private persistenceFailed = false;

  constructor(
    private readonly ports: HostRefresherPorts<G, P>,
    private readonly adapter: HostGrantAdapter<G, P>,
  ) {
    const parsed = HostRefreshStateSchema.safeParse(ports.read());
    if (!parsed.success) throw adapter.error();
    this.records = parsed.data;
    if (new Set(this.records.map((record) => record.definitionId)).size !== this.records.length)
      throw adapter.error();
  }

  status(definitionId: string) {
    if (this.persistenceFailed) throw this.adapter.error();
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
    let policy: HostRefreshPolicy;
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
  connected(definitionId: string, identity: HostRefreshIdentity | null): Promise<void> {
    return this.enqueue(async () => {
      const policy = this.ports.policy(definitionId);
      if (policy.removed) throw this.adapter.error();
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
        digest: this.adapter.digest(null),
      });
    });
  }

  reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const task = this.enqueue(async () => {
      // Accounts are independent (each has its own CLI storage and locks), so one slow refresh
      // cannot push another past its lead. Each reconcile replaces only its own record.
      await Promise.all(
        this.records.map((record) =>
          this.reconcileRecord(record.definitionId).catch(() => {
            // An unreachable Host or Dev leaves this record pending for the next reconcile.
          }),
        ),
      );
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
    let desired: P | null | undefined = null;
    if (next.signedIn && !policy.removed)
      desired = this.isDue(next, now) ? await this.readHost(definitionId, next, now) : undefined;
    if (desired !== undefined) this.rotate(next, desired);
    // Rewrite state only when something changed; idle reconciles stay read-only.
    if (!isDeepStrictEqual(next, current)) this.commit(this.withRecord(next));
    if (desired !== undefined) await this.deliverPending(definitionId, next, desired, now);
  }

  /** Reads the Host grant, refreshing it first when Dev can use it and it is about to expire. */
  private async readHost(
    definitionId: string,
    next: HostRefreshRecord,
    now: number,
  ): Promise<P | null> {
    let grant = await this.ports.grant(definitionId);
    // A newer Host token (a Host agent refreshed it, or the owner signed in) clears failures.
    if (isNewerGrant(next, grant)) next.refreshFailures = 0;
    if (this.shouldRefresh(next, grant, now))
      grant = await this.refreshHost(definitionId, grant, next, now);
    next.checkedAt = now;
    next.expiresAt = grant?.expiresAt ?? null;
    // An expired grant that failed to refresh repeatedly counts as lost: Dev is withdrawn and
    // the owner is asked to sign in again.
    const lost =
      grant !== null &&
      grant.expiresAt !== null &&
      grant.expiresAt <= now &&
      next.refreshFailures >= REFRESH_FAILURE_LIMIT;
    const desired = lost ? null : this.adapter.project(grant);
    next.hostGrant = desired ? "present" : "missing";
    return desired;
  }

  private async refreshHost(
    definitionId: string,
    grant: G | null,
    next: HostRefreshRecord,
    now: number,
  ): Promise<G | null> {
    const before = grant?.expiresAt ?? null;
    try {
      await this.ports.refresh(definitionId);
      const after = await this.ports.grant(definitionId);
      const advanced =
        after !== null && after.expiresAt !== null && (before === null || after.expiresAt > before);
      next.refresh = { at: now, outcome: advanced ? "refreshed" : "unchanged" };
      next.refreshFailures = advanced ? 0 : next.refreshFailures + 1;
      return after;
    } catch {
      next.refresh = { at: now, outcome: "failed" };
      next.refreshFailures += 1;
      return grant;
    }
  }

  private async deliverPending(
    definitionId: string,
    next: HostRefreshRecord,
    desired: P | null,
    now: number,
  ): Promise<void> {
    for (const target of next.targets) {
      if (target.appliedRotation === next.rotation) continue;
      const delivery: HostProjectionDelivery<P> = {
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
        if (!projectionReceiptMatches(receipt, delivery, this.adapter.digest(delivery.access)))
          continue;
        if (this.ports.policy(definitionId).revision !== next.policyRevision) continue;
        target.appliedRotation = next.rotation;
        this.commit(this.withRecord(next));
      } catch {
        // Offline Dev keeps this rotation pending; the token is read again next time.
      }
    }
    // Back off while a rotation stays undelivered, so an offline Dev does not cause a Host
    // read (a Keychain query on macOS) every reconcile.
    const pending = next.targets.some((target) => target.appliedRotation !== next.rotation);
    const failures = pending ? next.deliveryFailures + 1 : 0;
    const retryAt = pending ? now + backoff(DELIVERY_RETRY_MS, failures) : null;
    if (failures === next.deliveryFailures && retryAt === next.deliveryRetryAt) return;
    next.deliveryFailures = failures;
    next.deliveryRetryAt = retryAt;
    this.commit(this.withRecord(next));
  }

  private replace(
    definitionId: string,
    policy: HostRefreshPolicy,
    values: { signedIn: boolean; identity: HostRefreshIdentity | null; digest: string | null },
  ): void {
    const previous = this.records.find((item) => item.definitionId === definitionId);
    const generation = (previous?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw this.adapter.error();
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
        refreshFailures: 0,
        deliveryFailures: 0,
        deliveryRetryAt: null,
        targets: policy.targets.map((target) => ({ ...target, appliedRotation: null })),
      }),
    );
  }

  private withRecord(record: HostRefreshRecord): HostRefreshState {
    return [...this.records.filter((item) => item.definitionId !== record.definitionId), record];
  }

  private commit(next: HostRefreshState): void {
    try {
      this.ports.persist(next);
    } catch {
      this.persistenceFailed = true;
      throw this.adapter.error();
    }
    this.records = next;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(() => {
      if (this.persistenceFailed) throw this.adapter.error();
      return operation();
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private isDue(next: HostRefreshRecord, now: number): boolean {
    // An undelivered rotation waits for its retry time, whatever the token's expiry.
    if (next.targets.some((target) => target.appliedRotation !== next.rotation))
      return next.deliveryRetryAt === null || now >= next.deliveryRetryAt;
    if (next.checkedAt === null || now - next.checkedAt >= RECHECK_MS) return true;
    // After giving up on a token, read once more when it expires (to withdraw Dev); otherwise
    // only the normal cadence looks for a newer grant.
    if (next.refreshFailures >= REFRESH_FAILURE_LIMIT)
      return next.hostGrant === "present" && next.expiresAt !== null && now >= next.expiresAt;
    return (
      next.expiresAt !== null && next.expiresAt - now <= this.adapter.leadMs + REFRESH_RETRY_MS
    );
  }

  private shouldRefresh(next: HostRefreshRecord, grant: G | null, now: number) {
    // Gave up on this token: wait for a newer Host grant or a new sign-in.
    if (next.refreshFailures >= REFRESH_FAILURE_LIMIT) return false;
    // Refresh only for a Dev that received the current rotation; an unreachable Dev could not
    // use a new token, and launching the CLI for it would only spend the account's usage.
    const reachable = next.targets.some(
      (target) => !target.excluded && target.appliedRotation === next.rotation,
    );
    if (!reachable) return false;
    const wait = backoff(REFRESH_RETRY_MS, next.refreshFailures);
    if (next.refresh !== null && now - next.refresh.at < wait) return false;
    return this.adapter.needsRefresh(grant, now);
  }

  /** A changed projection, including a withdrawal, takes the next rotation slot. */
  private rotate(next: HostRefreshRecord, desired: P | null): void {
    const digest = this.adapter.digest(desired);
    if (digest === next.digest) return;
    next.digest = digest;
    next.rotation += 1;
  }
}

function applyPolicy(next: HostRefreshRecord, policy: HostRefreshPolicy): void {
  if (policy.revision === next.policyRevision) return;
  next.policyRevision = policy.revision;
  next.rotation += 1;
  next.targets = policy.targets.map((target) => ({ ...target, appliedRotation: null }));
}

function backoff(base: number, failures: number): number {
  return Math.min(base * 2 ** Math.max(0, failures - 1), RECHECK_MS);
}

function isNewerGrant(next: HostRefreshRecord, grant: HostGrant | null): boolean {
  return (
    grant !== null &&
    grant.expiresAt !== null &&
    (next.expiresAt === null || grant.expiresAt > next.expiresAt)
  );
}
