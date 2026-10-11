import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeStore } from "./store.js";
import { BridgeEvents, type Attention } from "./events.js";
import {
  publicAddress,
  callbackUrl,
  type WebhookRequest,
  type WebhookResponse,
} from "./webhook.js";

class Receiver {
  readonly deliveries: WebhookRequest[] = [];
  status = 200;
  readonly verifications: WebhookRequest[] = [];
  verify = true;
  async send(input: WebhookRequest): Promise<WebhookResponse> {
    const body = JSON.parse(input.body);
    if (body.type === "verification") {
      this.verifications.push(input);
      return {
        status: 200,
        body: JSON.stringify({ challenge: this.verify ? body.challenge : "wrong" }),
      };
    }
    this.deliveries.push(input);
    return { status: this.status, body: "" };
  }
}
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
const subscription = {
  name: "vorteo.attention",
  arguments: { environments: ["dev"], workspaceIds: [] },
  delivery: {
    mode: "webhook",
    url: "https://receiver.example/events",
    secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
  },
};
const attention: Attention = {
  environment: "dev",
  serverId: "dev-server",
  workspaceId: "workspace",
  threadId: "thread",
  kind: "completed",
  summary: "Work completed",
  occurredAt: "2026-10-08T00:00:00Z",
};

describe("event delivery", () => {
  it("stops a batch after the subscription is revoked during delivery", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nova-events-"));
    directories.push(directory);
    const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
    const receiver = new Receiver();
    const events = new BridgeEvents(store, async (input) => {
      const response = await receiver.send(input);
      if (JSON.parse(input.body).type !== "verification") events.unsubscribe(subscription);
      return response;
    });
    try {
      await events.subscribe(subscription);
      events.publish("first", attention);
      events.publish("second", attention);
      await events.flush();
      expect(receiver.deliveries.map((entry) => entry.headers["webhook-id"])).toEqual(["first"]);
    } finally {
      store.close();
    }
  });

  it.each([410, 413])("does not retry terminal receiver status %s", async (status) => {
    const directory = mkdtempSync(path.join(tmpdir(), "nova-events-"));
    directories.push(directory);
    const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
    const receiver = new Receiver();
    let now = Date.now();
    const events = new BridgeEvents(
      store,
      (input) => receiver.send(input),
      () => now,
    );
    try {
      await events.subscribe(subscription);
      events.publish("terminal", attention);
      receiver.status = status;
      await events.flush();
      now += 60_000;
      await events.flush();
      expect(receiver.deliveries).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("does not deliver after subscription expiry", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nova-events-"));
    directories.push(directory);
    const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
    const receiver = new Receiver();
    let now = Date.now();
    const events = new BridgeEvents(
      store,
      (input) => receiver.send(input),
      () => now,
    );
    try {
      await events.subscribe({ ...subscription, ttlMs: 1000 });
      events.publish("expired", attention);
      now += 1001;
      await events.flush();
      expect(receiver.deliveries).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("recovers pending delivery after restart, preserves event IDs, filters environments, and deduplicates", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nova-events-"));
    directories.push(directory);
    const file = path.join(directory, "bridge.sqlite");
    let now = Date.parse("2026-10-08T00:00:00Z");
    const receiver = new Receiver();
    const first = new BridgeStore(file);
    const events = new BridgeEvents(
      first,
      (input) => receiver.send(input),
      () => now,
    );
    const receipt = await events.subscribe(subscription);
    expect((await events.subscribe(subscription)).id).toBe(receipt.id);
    events.publish("event-one", attention);
    events.publish("event-one", attention);
    events.publish("host-event", { ...attention, environment: "host" });
    receiver.status = 503;
    await events.flush();
    first.close();
    now += 2000;
    receiver.status = 200;
    const reopened = new BridgeStore(file);
    const recovered = new BridgeEvents(
      reopened,
      (input) => receiver.send(input),
      () => now,
    );
    await recovered.flush();
    await recovered.flush();
    expect(receiver.deliveries.map((item) => item.headers["webhook-id"])).toEqual([
      "event-one",
      "event-one",
    ]);
    expect(receiver.deliveries[0]?.body).toBe(receiver.deliveries[1]?.body);
    expect(receiver.deliveries[0]?.headers["webhook-signature"]).not.toBe(
      receiver.deliveries[1]?.headers["webhook-signature"],
    );
    recovered.unsubscribe(subscription);
    recovered.publish("after-revoke", attention);
    await recovered.flush();
    expect(receiver.deliveries).toHaveLength(2);
    reopened.close();
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.100.100.100",
    "198.18.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
  ])("blocks non-public callback address %s", (address) => {
    expect(publicAddress(address)).toBe(false);
  });

  it("permits global addresses and rejects callback URL credentials", () => {
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
    expect(() => callbackUrl("https://user:password@example.com/")).toThrow("Callback must be");
  });
});

it("rejects unsupported replay cursors instead of silently skipping history", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-events-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  const receiver = new Receiver();
  const events = new BridgeEvents(store, (input) => receiver.send(input));
  try {
    await expect(events.subscribe({ ...subscription, cursor: "unhandled-cursor" })).rejects.toThrow(
      "replay cursors",
    );
    expect(store.db.prepare("SELECT * FROM subscriptions").all()).toHaveLength(0);
  } finally {
    store.close();
  }
});

it("defines the subscription boundary: earlier events remain for catch-up, later ones queue once", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-events-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  const receiver = new Receiver();
  const events = new BridgeEvents(store, (input) => receiver.send(input));
  try {
    events.publish("before", attention);
    await events.subscribe(subscription);
    events.publish("after", attention);
    await events.subscribe(subscription);
    events.publish("after", attention);
    await events.flush();
    expect(
      store.db
        .prepare("SELECT id FROM events ORDER BY seq")
        .all()
        .map((row) => row.id),
    ).toEqual(["before", "after"]);
    expect(receiver.deliveries.map((request) => request.headers["webhook-id"])).toEqual(["after"]);
  } finally {
    store.close();
  }
});

it("delivers environment outages to workspace-filtered subscribers", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-events-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  const receiver = new Receiver();
  const events = new BridgeEvents(store, (input) => receiver.send(input));
  try {
    await events.subscribe({
      ...subscription,
      arguments: { environments: ["dev"], workspaceIds: ["workspace"] },
    });
    events.publish("offline", { ...attention, kind: "offline", workspaceId: null, threadId: null });
    await events.flush();
    expect(receiver.deliveries).toHaveLength(1);
  } finally {
    store.close();
  }
});

it("bounds cached callback verification across refreshes and restart without sliding expiry", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-cache-"));
  directories.push(directory);
  const file = path.join(directory, "bridge.sqlite");
  const receiver = new Receiver();
  let now = 1000;
  const first = new BridgeStore(file);
  const events = new BridgeEvents(
    first,
    (input) => receiver.send(input),
    () => now,
  );
  await events.subscribe(subscription);
  now += 299999;
  await events.subscribe(subscription);
  expect(receiver.verifications).toHaveLength(1);
  first.close();
  const second = new BridgeStore(file);
  try {
    const recovered = new BridgeEvents(
      second,
      (input) => receiver.send(input),
      () => now,
    );
    await recovered.subscribe(subscription);
    expect(receiver.verifications).toHaveLength(1);
    now += 1;
    await recovered.subscribe(subscription);
    expect(receiver.verifications).toHaveLength(2);
    recovered.unsubscribe(subscription);
    await recovered.subscribe(subscription);
    expect(receiver.verifications).toHaveLength(3);
  } finally {
    second.close();
  }
});

it("verifies changed secrets before replacing active state and scopes cache by callback", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-cache-failure-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  const receiver = new Receiver();
  const events = new BridgeEvents(store, (input) => receiver.send(input));
  const replacement = {
    ...subscription,
    delivery: {
      ...subscription.delivery,
      secret: `whsec_${Buffer.alloc(32, 2).toString("base64")}`,
    },
  };
  try {
    const receipt = await events.subscribe(subscription);
    receiver.verify = false;
    await expect(events.subscribe(replacement)).rejects.toThrow("challenge did not match");
    expect(
      store.db.prepare("SELECT secret FROM subscriptions WHERE id=?").get(receipt.id)?.secret,
    ).toBe(subscription.delivery.secret);
    expect(store.db.prepare("SELECT * FROM subscription_signing_keys").all()).toEqual([]);
    receiver.verify = true;
    await events.subscribe(replacement);
    await events.subscribe(replacement);
    expect(receiver.verifications).toHaveLength(3);
    await events.subscribe({
      ...replacement,
      arguments: { environments: ["host"], workspaceIds: [] },
    });
    expect(receiver.verifications).toHaveLength(3);
    await events.subscribe({
      ...replacement,
      delivery: { ...replacement.delivery, url: "https://other.example/events" },
    });
    expect(receiver.verifications).toHaveLength(4);
  } finally {
    store.close();
  }
});

function expectedSignature(request: WebhookRequest, secret: string): string {
  const signed = `${request.headers["webhook-id"]}.${request.headers["webhook-timestamp"]}.${request.body}`;
  return `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(signed)
    .digest("base64")}`;
}

it("persists old/new signatures across restart, does not slide overlap, and expires at its boundary", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-rotation-"));
  directories.push(directory);
  const file = path.join(directory, "bridge.sqlite");
  const receiver = new Receiver();
  let now = 1000;
  const first = new BridgeStore(file);
  const events = new BridgeEvents(
    first,
    (input) => receiver.send(input),
    () => now,
  );
  const replacement = {
    ...subscription,
    delivery: {
      ...subscription.delivery,
      secret: `whsec_${Buffer.alloc(32, 2).toString("base64")}`,
    },
  };
  await events.subscribe(subscription);
  now += 1000;
  await events.subscribe(replacement);
  events.publish("pending", attention);
  first.close();
  const second = new BridgeStore(file);
  try {
    const recovered = new BridgeEvents(
      second,
      (input) => receiver.send(input),
      () => now,
    );
    now += 299999;
    await recovered.subscribe(replacement);
    await recovered.flush();
    const delivered = receiver.deliveries[0]!;
    expect(delivered.headers["webhook-signature"].split(" ")).toEqual([
      expectedSignature(delivered, replacement.delivery.secret),
      expectedSignature(delivered, subscription.delivery.secret),
    ]);
    now += 1;
    recovered.publish("after-overlap", attention);
    await recovered.flush();
    const after = receiver.deliveries[1]!;
    expect(after.headers["webhook-signature"]).toBe(
      expectedSignature(after, replacement.delivery.secret),
    );
    recovered.unsubscribe(replacement);
    expect(second.db.prepare("SELECT * FROM subscription_signing_keys").all()).toEqual([]);
  } finally {
    second.close();
  }
});

it("does not retain expired subscription keys when recreating a subscription", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-expired-key-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  const receiver = new Receiver();
  let now = 1000;
  const events = new BridgeEvents(
    store,
    (input) => receiver.send(input),
    () => now,
  );
  try {
    await events.subscribe({ ...subscription, ttlMs: 1000 });
    now += 1000;
    const replacement = {
      ...subscription,
      delivery: {
        ...subscription.delivery,
        secret: `whsec_${Buffer.alloc(32, 2).toString("base64")}`,
      },
    };
    await events.subscribe(replacement);
    events.publish("recreated", attention);
    await events.flush();
    const delivered = receiver.deliveries[0]!;
    expect(delivered.headers["webhook-signature"]).toBe(
      expectedSignature(delivered, replacement.delivery.secret),
    );
  } finally {
    store.close();
  }
});

it("accepts exactly 256 KiB of full UTF8 JSON and atomically refuses one byte more", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-size-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  const receiver = new Receiver();
  const events = new BridgeEvents(store, (input) => receiver.send(input));
  try {
    await events.subscribe(subscription);
    const data = { ...attention, serverId: "" };
    const empty = JSON.stringify({
      eventId: "boundary",
      name: "vorteo.attention",
      timestamp: data.occurredAt,
      data,
      cursor: null,
    });
    const remaining = 262144 - Buffer.byteLength(empty, "utf8");
    data.serverId = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
    events.publish("boundary", data);
    await events.flush();
    expect(Buffer.byteLength(receiver.deliveries[0]!.body, "utf8")).toBe(262144);
    expect(receiver.deliveries[0]!.headers["webhook-signature"]).toBe(
      expectedSignature(receiver.deliveries[0]!, subscription.delivery.secret),
    );
    let advanced = false;
    expect(() =>
      events.publishBatch(
        [
          { id: "rollback", data: attention },
          { id: "oversize", data: { ...data, serverId: data.serverId + "x" } },
        ],
        () => {
          advanced = true;
        },
      ),
    ).toThrow("256 KiB");
    expect(advanced).toBe(false);
    expect(store.db.prepare("SELECT id FROM events").all()).toEqual([{ id: "boundary" }]);
  } finally {
    store.close();
  }
});

it("marks retained oversized deliveries failed without sending or retrying them", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-legacy-size-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  const receiver = new Receiver();
  const events = new BridgeEvents(store, (input) => receiver.send(input));
  try {
    await events.subscribe(subscription);
    events.publish("legacy", attention);
    store.db.prepare("UPDATE events SET body=? WHERE id=?").run("é".repeat(131073), "legacy");
    await events.flush();
    await events.flush();
    expect(receiver.deliveries).toEqual([]);
    expect(store.db.prepare("SELECT status FROM deliveries").all()).toEqual([{ status: "failed" }]);
  } finally {
    store.close();
  }
});

it("keeps independent deadlines for consecutive key rotations", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-rapid-rotation-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  const receiver = new Receiver();
  let now = 0;
  const events = new BridgeEvents(
    store,
    (input) => receiver.send(input),
    () => now,
  );
  const secondSecret = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
  const thirdSecret = `whsec_${Buffer.alloc(32, 3).toString("base64")}`;
  try {
    await events.subscribe(subscription);
    now = 1000;
    await events.subscribe({
      ...subscription,
      delivery: { ...subscription.delivery, secret: secondSecret },
    });
    now = 2000;
    await events.subscribe({
      ...subscription,
      delivery: { ...subscription.delivery, secret: thirdSecret },
    });
    events.publish("three-keys", attention);
    await events.flush();
    const first = receiver.deliveries[0]!;
    expect(first.headers["webhook-signature"].split(" ")).toEqual([
      expectedSignature(first, thirdSecret),
      expectedSignature(first, subscription.delivery.secret),
      expectedSignature(first, secondSecret),
    ]);
    now = 301000;
    events.publish("two-keys", attention);
    await events.flush();
    const second = receiver.deliveries[1]!;
    expect(second.headers["webhook-signature"].split(" ")).toEqual([
      expectedSignature(second, thirdSecret),
      expectedSignature(second, secondSecret),
    ]);
    now = 302000;
    events.publish("one-key", attention);
    await events.flush();
    const third = receiver.deliveries[2]!;
    expect(third.headers["webhook-signature"]).toBe(expectedSignature(third, thirdSecret));
    expect(store.db.prepare("SELECT * FROM subscription_signing_keys").all()).toEqual([]);
  } finally {
    store.close();
  }
});

it("never signs with the retired key past its original subscription expiry", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-short-overlap-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  const receiver = new Receiver();
  let now = 1000;
  const events = new BridgeEvents(
    store,
    (input) => receiver.send(input),
    () => now,
  );
  const secret = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
  try {
    await events.subscribe({ ...subscription, ttlMs: 2000 });
    now = 2000;
    await events.subscribe({ ...subscription, delivery: { ...subscription.delivery, secret } });
    now = 2999;
    events.publish("before-expiry", attention);
    await events.flush();
    const before = receiver.deliveries[0]!;
    expect(before.headers["webhook-signature"].split(" ")).toEqual([
      expectedSignature(before, secret),
      expectedSignature(before, subscription.delivery.secret),
    ]);
    now = 3000;
    events.publish("at-expiry", attention);
    await events.flush();
    const after = receiver.deliveries[1]!;
    expect(after.headers["webhook-signature"]).toBe(expectedSignature(after, secret));
  } finally {
    store.close();
  }
});

class PausedReceiver extends Receiver {
  pauseNext(): () => void {
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.barrier = barrier;
    return release;
  }
  private barrier: Promise<void> | null = null;
  override async send(input: WebhookRequest): Promise<WebhookResponse> {
    const barrier = this.barrier;
    if (JSON.parse(input.body).type === "verification" && barrier) {
      this.barrier = null;
      await barrier;
    }
    return super.send(input);
  }
}

describe("subscription cancellation ordering", () => {
  it.each(["first", "refresh", "cached"])(
    "cancels a pending %s subscribe without restoring cache or delivery",
    async (mode) => {
      const directory = mkdtempSync(path.join(tmpdir(), "nova-cancel-"));
      directories.push(directory);
      const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
      const receiver = new PausedReceiver();
      const events = new BridgeEvents(store, (input) => receiver.send(input));
      try {
        if (mode !== "first") await events.subscribe(subscription);
        const input = {
          ...subscription,
          delivery: {
            ...subscription.delivery,
            secret:
              mode === "refresh"
                ? `whsec_${Buffer.alloc(32, 2).toString("base64")}`
                : subscription.delivery.secret,
          },
        };
        const release = receiver.pauseNext();
        const pending = events.subscribe(input);
        const rejected = expect(pending).rejects.toThrow("Subscription canceled");
        events.unsubscribe(subscription);
        events.unsubscribe(subscription);
        release();
        await rejected;
        expect(store.db.prepare("SELECT * FROM subscriptions").all()).toHaveLength(0);
        expect(store.db.prepare("SELECT * FROM callback_verifications").all()).toHaveLength(0);
        expect(store.db.prepare("SELECT * FROM subscription_signing_keys").all()).toHaveLength(0);
        events.publish("canceled", attention);
        await events.flush();
        expect(receiver.deliveries).toHaveLength(0);
        await events.subscribe(subscription);
        events.publish("resubscribed", attention);
        await events.flush();
        expect(receiver.deliveries.map((entry) => entry.headers["webhook-id"])).toEqual([
          "resubscribed",
        ]);
      } finally {
        store.close();
      }
    },
  );
});

it.each(["completed", "pending"])(
  "keeps a later %s generation independent of stale verification completion",
  async (state) => {
    const directory = mkdtempSync(path.join(tmpdir(), "nova-generation-"));
    directories.push(directory);
    const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
    const receiver = new PausedReceiver();
    const events = new BridgeEvents(store, (input) => receiver.send(input));
    const fresh = {
      ...subscription,
      delivery: {
        ...subscription.delivery,
        secret: `whsec_${Buffer.alloc(32, 3).toString("base64")}`,
      },
    };
    try {
      const releaseOld = receiver.pauseNext();
      const old = events.subscribe(subscription);
      const oldRejected = expect(old).rejects.toThrow("Subscription canceled");
      events.unsubscribe(subscription);
      const releaseNew = receiver.pauseNext();
      const newer = events.subscribe(fresh);
      if (state === "completed") {
        releaseNew();
        await newer;
      }
      releaseOld();
      await oldRejected;
      if (state === "pending") {
        const newRejected = expect(newer).rejects.toThrow("Subscription canceled");
        events.unsubscribe(fresh);
        releaseNew();
        await newRejected;
        expect(store.db.prepare("SELECT * FROM callback_verifications").all()).toHaveLength(0);
        await events.subscribe(fresh);
      }
      expect(store.db.prepare("SELECT secret FROM subscriptions").all()).toEqual([
        { secret: fresh.delivery.secret },
      ]);
      // An unchanged refresh must use the fresh secret's verification cache.
      const challenges = receiver.verifications.length;
      await events.subscribe(fresh);
      expect(receiver.verifications).toHaveLength(challenges);
      events.publish("fresh-generation", attention);
      await events.flush();
      expect(receiver.deliveries).toHaveLength(1);
    } finally {
      store.close();
    }
  },
);

it.each(["filters", "callback"])(
  "does not cancel an unrelated pending subscription with different %s",
  async (difference) => {
    const directory = mkdtempSync(path.join(tmpdir(), "nova-independent-"));
    directories.push(directory);
    const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
    const receiver = new PausedReceiver();
    const events = new BridgeEvents(store, (input) => receiver.send(input));
    const other = {
      ...subscription,
      arguments: {
        ...subscription.arguments,
        workspaceIds: difference === "filters" ? ["workspace"] : [],
      },
      delivery: {
        ...subscription.delivery,
        url:
          difference === "callback" ? "https://receiver.example/other" : subscription.delivery.url,
      },
    };
    try {
      const releaseCanceled = receiver.pauseNext();
      const canceled = events.subscribe(subscription);
      const rejected = expect(canceled).rejects.toThrow("Subscription canceled");
      const releaseOther = receiver.pauseNext();
      const independent = events.subscribe(other);
      events.unsubscribe(subscription);
      releaseCanceled();
      await rejected;
      releaseOther();
      const receipt = await independent;
      expect(store.db.prepare("SELECT id FROM subscriptions").all()).toEqual([{ id: receipt.id }]);
      events.publish("independent", attention);
      await events.flush();
      expect(receiver.deliveries).toHaveLength(1);
      expect(receiver.deliveries[0]?.headers["X-MCP-Subscription-Id"]).toBe(receipt.id);
    } finally {
      store.close();
    }
  },
);

it("invalidates all concurrent attempts for the same canonical identity", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-concurrent-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  const receiver = new PausedReceiver();
  const events = new BridgeEvents(store, (input) => receiver.send(input));
  try {
    const releaseFirst = receiver.pauseNext();
    const first = events.subscribe(subscription);
    const firstRejected = expect(first).rejects.toThrow("Subscription canceled");
    const releaseSecond = receiver.pauseNext();
    const second = events.subscribe(subscription);
    const secondRejected = expect(second).rejects.toThrow("Subscription canceled");
    events.unsubscribe({
      ...subscription,
      arguments: { environments: ["dev", "dev"], workspaceIds: [] },
    });
    releaseFirst();
    await firstRejected;
    releaseSecond();
    await secondRejected;
    expect(store.db.prepare("SELECT * FROM subscriptions").all()).toHaveLength(0);
    expect(store.db.prepare("SELECT * FROM callback_verifications").all()).toHaveLength(0);
    await events.subscribe(subscription);
    events.publish("after-concurrent-cancellation", attention);
    await events.flush();
    expect(receiver.deliveries).toHaveLength(1);
  } finally {
    store.close();
  }
});
