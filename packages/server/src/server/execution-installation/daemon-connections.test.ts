import { afterEach, expect, test, vi } from "vitest";
import { createInstallationDaemonConnections } from "./daemon-connections.js";

afterEach(() => {
  vi.useRealTimers();
});

class FakeClient {
  state: "connected" | "disconnected" = "connected";
  closed = 0;
  constructor(readonly id: number) {}
  getConnectionState() {
    return { status: this.state } as const;
  }
  async close() {
    this.closed += 1;
    this.state = "disconnected";
  }
  describe() {
    return `client ${this.id}`;
  }
}

function fixture(idleMs = 60_000) {
  const opened: FakeClient[] = [];
  const connections = createInstallationDaemonConnections(
    async () => {
      const client = new FakeClient(opened.length + 1);
      opened.push(client);
      return client;
    },
    { idleMs },
  );
  return { opened, connections };
}

test("repeated passes reuse one connection per environment", async () => {
  const { opened, connections } = fixture();
  for (let pass = 0; pass < 5; pass += 1) {
    const host = await connections.connect("host");
    const container = await connections.connect("container");
    expect(host.describe()).toBe("client 1");
    await host.close();
    await container.close();
  }
  expect(opened).toHaveLength(2);
  expect(opened.every((client) => client.closed === 0)).toBe(true);
});

test("concurrent passes share the connection that is still opening", async () => {
  const { opened, connections } = fixture();
  const [first, second] = await Promise.all([
    connections.connect("host"),
    connections.connect("host"),
  ]);
  await first.close();
  await second.close();
  expect(opened).toHaveLength(1);
});

test("a dropped connection is replaced on the next use", async () => {
  const { opened, connections } = fixture();
  const lease = await connections.connect("host");
  await lease.close();
  opened[0].state = "disconnected";
  const next = await connections.connect("host");
  expect(next.describe()).toBe("client 2");
  expect(opened[0].closed).toBe(1);
});

test("a connection that drops during a lease is retired when the lease ends", async () => {
  const { opened, connections } = fixture();
  const lease = await connections.connect("host");
  opened[0].state = "disconnected";
  await lease.close();
  expect(opened[0].closed).toBe(1);
  expect((await connections.connect("host")).describe()).toBe("client 2");
});

test("an idle connection closes, and a busy one stays open", async () => {
  vi.useFakeTimers();
  const { opened, connections } = fixture(1000);
  const busy = await connections.connect("host");
  const done = await connections.connect("host");
  await done.close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(opened[0].closed).toBe(0);
  await busy.close();
  await vi.advanceTimersByTimeAsync(999);
  expect(opened[0].closed).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(opened[0].closed).toBe(1);
});

test("closing a lease twice does not release another caller's lease", async () => {
  vi.useFakeTimers();
  const { opened, connections } = fixture(1000);
  const first = await connections.connect("host");
  const second = await connections.connect("host");
  await first.close();
  await first.close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(opened[0].closed).toBe(0);
  await second.close();
});

test("a failed connection attempt is not cached", async () => {
  let attempts = 0;
  const connections = createInstallationDaemonConnections(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("daemon unavailable");
    return new FakeClient(attempts);
  });
  await expect(connections.connect("host")).rejects.toThrow("daemon unavailable");
  expect((await connections.connect("host")).describe()).toBe("client 2");
});

test("shutdown closes every shared connection", async () => {
  const { opened, connections } = fixture();
  await (await connections.connect("host")).close();
  await (await connections.connect("container")).close();
  connections.close();
  await Promise.resolve();
  expect(opened.map((client) => client.closed)).toEqual([1, 1]);
});
