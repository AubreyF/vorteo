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
  async send(input: WebhookRequest): Promise<WebhookResponse> {
    const body = JSON.parse(input.body);
    if (body.type === "verification")
      return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
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
