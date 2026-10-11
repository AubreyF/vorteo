import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { EnvironmentSchema } from "./config.js";
import { BridgeStore, canonicalJson } from "./store.js";
import { callbackUrl, signingHeaders, type WebhookTransport } from "./webhook.js";

const Filters = z
  .object({
    environments: z.array(EnvironmentSchema).default(["host", "dev"]),
    workspaceIds: z.array(z.string()).default([]),
  })
  .strict();
const Subscription = z.object({
  name: z.literal("vorteo.attention"),
  arguments: Filters.default({ environments: ["host", "dev"], workspaceIds: [] }),
  delivery: z.object({
    mode: z.literal("webhook"),
    url: z.string(),
    secret: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/)
      .refine((secret) => {
        const size = Buffer.from(secret.slice(6), "base64").length;
        return size >= 24 && size <= 64;
      }),
  }),
  ttlMs: z.number().int().positive().nullable().optional(),
  cursor: z.string().nullable().optional(),
});
const Unsubscribe = Subscription.omit({ delivery: true }).extend({
  delivery: z.object({ mode: z.literal("webhook"), url: z.string() }),
});
const AttentionSchema = z.object({
  environment: EnvironmentSchema,
  serverId: z.string(),
  workspaceId: z.string().nullable(),
  threadId: z.string().nullable(),
  kind: z.enum(["completed", "failed", "permission", "offline", "recovered", "changed", "gap"]),
  summary: z.string().max(2000),
  occurredAt: z.string(),
  sourceCursor: z.object({ epoch: z.string(), seq: z.number() }).optional(),
  operationIds: z.array(z.string()).optional(),
});
export type Attention = z.infer<typeof AttentionSchema>;
const DeliveryRow = z.object({
  subscription_id: z.string(),
  event_id: z.string(),
  url: z.string(),
  secret: z.string(),
  body: z.string(),
  attempts: z.number(),
});
const SubscriptionRow = z.object({ id: z.string(), filters: z.string() });

function subscriptionId(url: string, filters: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ principal: "installation-owner-integration", url, filters }))
    .digest("hex");
}

export class BridgeEvents {
  constructor(
    private readonly store: BridgeStore,
    private readonly transport: WebhookTransport,
    private readonly now: () => number = Date.now,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, filters TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE, event_id TEXT NOT NULL REFERENCES events(id), attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY (subscription_id, event_id));
    `);
  }

  list() {
    return [
      {
        name: "vorteo.attention",
        description:
          "Important changes across native Vorteo workspaces, including new workspaces. Use read tools to inspect evidence before acting.",
        delivery: ["webhook"],
        inputSchema: z.toJSONSchema(Filters),
        payloadSchema: z.toJSONSchema(AttentionSchema),
      },
    ];
  }

  async subscribe(raw: unknown) {
    const input = Subscription.parse(raw);
    if (input.cursor != null)
      throw new Error("Event replay cursors are unsupported; use get_changes for retained history");
    const url = callbackUrl(input.delivery.url).toString();
    const filters = {
      environments: [...new Set(input.arguments.environments)].sort(),
      workspaceIds: [...new Set(input.arguments.workspaceIds)].sort(),
    };
    const id = subscriptionId(url, filters);
    const challenge = randomUUID();
    const body = JSON.stringify({ type: "verification", challenge });
    const headers = signingHeaders({
      secret: input.delivery.secret,
      id: `verification_${randomUUID()}`,
      subscriptionId: id,
      body,
      timestamp: Math.floor(this.now() / 1000),
    });
    const verified = await this.transport({ url, body, headers });
    if (verified.status < 200 || verified.status >= 300)
      throw new Error("Callback verification failed");
    const echo = z.object({ challenge: z.string() }).parse(JSON.parse(verified.body));
    const expected = Buffer.from(challenge);
    const actual = Buffer.from(echo.challenge);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("Callback challenge did not match");
    const ttl = input.ttlMs ?? 24 * 60 * 60 * 1000;
    const expires = this.now() + Math.min(ttl, 7 * 24 * 60 * 60 * 1000);
    this.store.db
      .prepare(`INSERT INTO subscriptions (id, url, secret, filters, expires) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET secret=excluded.secret, expires=excluded.expires`)
      .run(id, url, input.delivery.secret, canonicalJson(filters), expires);
    // Events persist for tool-driven catch-up; replay cursors are not advertised until
    // retention and subscription-boundary ordering can guarantee no skipped deliveries.
    return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
  }

  unsubscribe(raw: unknown): void {
    const input = Unsubscribe.parse(raw);
    const filters = {
      environments: [...new Set(input.arguments.environments)].sort(),
      workspaceIds: [...new Set(input.arguments.workspaceIds)].sort(),
    };
    this.store.db
      .prepare("DELETE FROM subscriptions WHERE id = ?")
      .run(subscriptionId(callbackUrl(input.delivery.url).toString(), filters));
  }

  publish(id: string, raw: Attention): void {
    this.publishBatch([{ id, data: raw }]);
  }

  // The observer's cursor and its durable events commit together. A crash cannot
  // advance past evidence which has not entered the delivery queue.
  publishBatch(
    entries: { id: string; data: Attention }[],
    saveObservation: () => void = () => {},
  ): void {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) this.insert(entry.id, entry.data);
      saveObservation();
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insert(id: string, raw: Attention): void {
    const data = AttentionSchema.parse(raw);
    const body = JSON.stringify({
      eventId: id,
      name: "vorteo.attention",
      timestamp: data.occurredAt,
      data,
      cursor: null,
    });
    const inserted = this.store.db
      .prepare("INSERT OR IGNORE INTO events (id, body) VALUES (?, ?)")
      .run(id, body);
    if (inserted.changes !== 1) return;
    const rows = this.store.db
      .prepare("SELECT id, filters FROM subscriptions WHERE expires > ?")
      .all(this.now());
    for (const value of rows) {
      const row = SubscriptionRow.parse(value);
      const filters = Filters.parse(JSON.parse(row.filters));
      const matches =
        filters.environments.includes(data.environment) &&
        (filters.workspaceIds.length === 0 ||
          data.workspaceId === null ||
          filters.workspaceIds.includes(data.workspaceId));
      // Environment outage/recovery matters even to workspace-filtered observers.
      if (matches)
        this.store.db
          .prepare("INSERT INTO deliveries (subscription_id, event_id, next_at) VALUES (?, ?, ?)")
          .run(row.id, id, this.now());
    }
  }

  async flush(): Promise<void> {
    const rows = this.store.db
      .prepare(`SELECT d.subscription_id, d.event_id, d.attempts, s.url, s.secret, e.body
      FROM deliveries d JOIN subscriptions s ON d.subscription_id=s.id JOIN events e ON e.id=d.event_id
      WHERE d.status='pending' AND d.next_at<=? AND s.expires>? ORDER BY e.seq LIMIT 20`)
      .all(this.now(), this.now());
    for (const value of rows) {
      const row = DeliveryRow.parse(value);
      // Recheck between awaited deliveries: revocation, expiry or secret rotation
      // can happen while an earlier callback in this batch is in flight.
      const active = this.store.db
        .prepare("SELECT secret FROM subscriptions WHERE id=? AND expires>?")
        .get(row.subscription_id, this.now());
      if (!active) continue;
      const headers = signingHeaders({
        secret: z.object({ secret: z.string() }).parse(active).secret,
        id: row.event_id,
        subscriptionId: row.subscription_id,
        body: row.body,
        timestamp: Math.floor(this.now() / 1000),
      });
      let status: number;
      try {
        status = (await this.transport({ url: row.url, headers, body: row.body })).status;
      } catch {
        status = 503;
      }
      const accepted = status >= 200 && status < 300;
      const terminal = status === 410 || status === 413 || row.attempts >= 7;
      let state = "pending";
      if (terminal) state = "failed";
      if (accepted) state = "delivered";
      const next = this.now() + Math.min(300_000, 1000 * 2 ** row.attempts);
      this.store.db
        .prepare(
          "UPDATE deliveries SET status=?, attempts=attempts+1, next_at=? WHERE subscription_id=? AND event_id=?",
        )
        .run(state, next, row.subscription_id, row.event_id);
    }
  }
}
