import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import {
  createToolRelay,
  isToolRelayServer,
  TOOL_RELAY_UNAVAILABLE_CODE,
  toolRelayBridgePath,
  toolRelaySocketPath,
  type ToolRelay,
} from "./tool-relay.js";

const TOKEN = "host-token";
const logger = pino({ level: "silent" });

/**
 * A stateless MCP-shaped endpoint: one POST per message, JSON or SSE replies, 202 for
 * notifications, 401 without the host token. Every request is counted so a test can prove what
 * was and was not retried.
 */
interface FakeDaemon {
  url: string;
  port: number;
  requests: { method: string; id: unknown }[];
  /** Requests refused for a wrong token; they are not recorded above. */
  unauthorized: number;
  /** Replies as an SSE stream that breaks after the first bytes when set. */
  breakAfterBytes: boolean;
  close(): Promise<void>;
}

async function startFakeDaemon(port = 0): Promise<FakeDaemon> {
  const daemon: FakeDaemon = {
    url: "",
    port: 0,
    requests: [],
    unauthorized: 0,
    breakAfterBytes: false,
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      daemon.unauthorized += 1;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body) as { method?: string; id?: unknown };
      daemon.requests.push({ method: message.method ?? "", id: message.id });
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (daemon.breakAfterBytes) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": partial\n\n");
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (message.method === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { via: "sse" } })}\n\n`,
        );
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echo: message.method } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  daemon.port = address.port;
  daemon.url = `http://127.0.0.1:${address.port}/mcp/agents?callerAgentId=agent-1`;
  daemon.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return daemon;
}

/** A line client on the relay socket, as the bridge presents the provider. */
class LineClient {
  readonly lines: string[] = [];
  private readonly socket: net.Socket;
  private buffered = "";
  private waiters: (() => void)[] = [];
  closed = false;

  constructor(socketPath: string) {
    this.socket = net.createConnection(socketPath);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.buffered += chunk;
      let newline = this.buffered.indexOf("\n");
      while (newline !== -1) {
        this.lines.push(this.buffered.slice(0, newline));
        this.buffered = this.buffered.slice(newline + 1);
        newline = this.buffered.indexOf("\n");
      }
      for (const waiter of this.waiters.splice(0)) waiter();
    });
    this.socket.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter();
    });
    this.socket.on("error", () => {});
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }

  send(message: unknown): void {
    this.socket.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }

  async next(count = 1, timeoutMs = 10_000): Promise<unknown[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.length < count) {
      if (this.closed) throw new Error("The relay closed the connection.");
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} lines.`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
    return this.lines.splice(0, count).map((line) => JSON.parse(line) as unknown);
  }

  async untilClosed(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error("The relay kept the connection open.");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  end(): void {
    this.socket.destroy();
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanups.splice(0).toReversed()) await step();
});

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "relay-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function relayFor(
  daemonUrl: string,
  overrides: Partial<Parameters<typeof createToolRelay>[0]> = {},
): Promise<{ relay: ToolRelay; directory: string }> {
  const directory = tempDirectory();
  const relay = createToolRelay({ directory, token: TOKEN, logger, ...overrides });
  cleanups.push(() => relay.closeAll());
  return { relay, directory };
}

async function connect(socketPath: string): Promise<LineClient> {
  const client = new LineClient(socketPath);
  cleanups.push(() => client.end());
  await client.ready();
  return client;
}

describe("tool relay", () => {
  test("relays a request, an SSE reply and a notification, and leaves bodies untouched", async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    const { relay, directory } = await relayFor(daemon.url);
    const session = await relay.open("session-1", daemon.url);
    expect(session).not.toBeNull();
    expect(session!.socketPath).toBe(toolRelaySocketPath(directory, "session-1"));
    expect(statSync(session!.socketPath).mode & 0o777).toBe(0o600);
    expect(isToolRelayServer(session!.server)).toBe(true);
    expect(session!.server.args?.[0]).toBe(toolRelayBridgePath());

    const client = await connect(session!.socketPath);
    client.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(await client.next()).toEqual([
      { jsonrpc: "2.0", id: 1, result: { echo: "tools/list" } },
    ]);
    client.send({ jsonrpc: "2.0", id: "two", method: "sse" });
    expect(await client.next()).toEqual([{ jsonrpc: "2.0", id: "two", result: { via: "sse" } }]);
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    client.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(await client.next()).toEqual([{ jsonrpc: "2.0", id: 3, result: { echo: "ping" } }]);
    expect(daemon.requests.map((entry) => entry.method)).toEqual([
      "tools/list",
      "sse",
      "notifications/initialized",
      "ping",
    ]);
    expect(relay.sessionCount()).toBe(1);
    await relay.close("session-1");
    expect(existsSync(session!.socketPath)).toBe(false);
    expect(relay.sessionCount()).toBe(0);
  });

  test("holds a message while no daemon answers and delivers it once one does", async () => {
    const probe = await startFakeDaemon();
    const { url, port } = probe;
    await probe.close();
    const { relay } = await relayFor(url, { retryMs: 50 });
    const session = await relay.open("session-1", url);
    const client = await connect(session!.socketPath);
    const sentAt = Date.now();
    client.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x" } });
    client.send({ jsonrpc: "2.0", id: 8, method: "second" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.lines).toEqual([]);

    const daemon = await startFakeDaemon(port);
    cleanups.push(() => daemon.close());
    const replies = await client.next(2);
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: 7, result: { echo: "tools/call" } },
      { jsonrpc: "2.0", id: 8, result: { echo: "second" } },
    ]);
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(300);
    // The daemon saw each message exactly once, in order.
    expect(daemon.requests.map((entry) => entry.id)).toEqual([7, 8]);
  });

  test("answers a held request with an error once the hold bound passes", async () => {
    const probe = await startFakeDaemon();
    const { url } = probe;
    await probe.close();
    let now = 1_000;
    const { relay } = await relayFor(url, { retryMs: 20, holdMs: 500, now: () => now });
    const session = await relay.open("session-1", url);
    const client = await connect(session!.socketPath);
    client.send({ jsonrpc: "2.0", id: 9, method: "tools/call" });
    client.send({ jsonrpc: "2.0", method: "notifications/progress" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.lines).toEqual([]);
    now += 600;
    const [reply] = await client.next();
    expect(reply).toMatchObject({
      jsonrpc: "2.0",
      id: 9,
      error: { code: TOOL_RELAY_UNAVAILABLE_CODE },
    });
    // The notification was dropped without a reply, and the connection stays usable.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.lines).toEqual([]);
    expect(client.closed).toBe(false);
  });

  test("never retries after the daemon started answering", async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    daemon.breakAfterBytes = true;
    const { relay } = await relayFor(daemon.url, { retryMs: 20, holdMs: 5_000 });
    const session = await relay.open("session-1", daemon.url);
    const client = await connect(session!.socketPath);
    client.send({ jsonrpc: "2.0", id: 10, method: "tools/call" });
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: 10, error: { code: TOOL_RELAY_UNAVAILABLE_CODE } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(daemon.requests).toHaveLength(1);
  });

  test("a rejected token is answered at once, not held", async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    const { relay } = await relayFor(daemon.url, { token: "wrong", retryMs: 20, holdMs: 5_000 });
    const session = await relay.open("session-1", daemon.url);
    const client = await connect(session!.socketPath);
    client.send({ jsonrpc: "2.0", id: 11, method: "tools/list" });
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: 11, error: { code: TOOL_RELAY_UNAVAILABLE_CODE } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(daemon.unauthorized).toBe(1);
    expect(daemon.requests).toEqual([]);
  });

  test("a malformed line gets a parse error and closes the connection", async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    const { relay } = await relayFor(daemon.url);
    const session = await relay.open("session-1", daemon.url);
    const client = await connect(session!.socketPath);
    client.send("{not json");
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: null, error: { code: -32_700 } });
    await client.untilClosed();
    expect(daemon.requests).toEqual([]);

    const other = await connect(session!.socketPath);
    other.send({ jsonrpc: "2.0", id: 12, method: "ping" });
    expect(await other.next()).toEqual([{ jsonrpc: "2.0", id: 12, result: { echo: "ping" } }]);
  });

  test("bounds the messages waiting on a connection", async () => {
    const probe = await startFakeDaemon();
    const { url } = probe;
    await probe.close();
    const { relay } = await relayFor(url, { retryMs: 20, holdMs: 60_000 });
    const session = await relay.open("session-1", url);
    const client = await connect(session!.socketPath);
    for (let index = 0; index < 65; index += 1)
      client.send({ jsonrpc: "2.0", id: index, method: "tools/call" });
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: 64, error: { code: TOOL_RELAY_UNAVAILABLE_CODE } });
    await client.untilClosed();
  });

  test("reopening a session replaces its socket, and closing all removes every socket", async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    const { relay } = await relayFor(daemon.url);
    const first = await relay.open("session-1", daemon.url);
    const firstClient = await connect(first!.socketPath);
    const second = await relay.open("session-1", daemon.url);
    expect(second!.socketPath).toBe(first!.socketPath);
    await firstClient.untilClosed();
    const client = await connect(second!.socketPath);
    client.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(await client.next()).toHaveLength(1);
    await relay.open("session-2", daemon.url);
    expect(relay.sessionCount()).toBe(2);
    await relay.closeAll();
    expect(relay.sessionCount()).toBe(0);
    expect(existsSync(second!.socketPath)).toBe(false);
  });

  test("refuses a socket path too long for the platform", async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    const directory = path.join(tempDirectory(), "x".repeat(90));
    const relay = createToolRelay({ directory, token: TOKEN, logger });
    expect(await relay.open("session-1", daemon.url)).toBeNull();
    expect(relay.sessionCount()).toBe(0);
  });

  test("the shipped bridge carries a request through the relay", async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    const { relay } = await relayFor(daemon.url);
    const session = await relay.open("session-1", daemon.url);
    const bridge = spawn(session!.server.command, session!.server.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => {
      bridge.kill("SIGKILL");
    });
    const reply = new Promise<string>((resolve) => {
      let out = "";
      bridge.stdout.setEncoding("utf8");
      bridge.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.includes("\n")) resolve(out.slice(0, out.indexOf("\n")));
      });
    });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    expect(JSON.parse(await reply)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { echo: "initialize" },
    });
  });

  test("recognises only the relay's own stdio form", () => {
    expect(
      isToolRelayServer({
        type: "stdio",
        command: "/usr/bin/node",
        args: [
          "/r/dist/scripts/mcp-stdio-socket-bridge-cli.mjs",
          "--socket",
          "/h/session-host/tools/ab.sock",
        ],
      }),
    ).toBe(true);
    expect(
      isToolRelayServer({
        type: "stdio",
        command: "/usr/bin/node",
        args: ["/r/dist/scripts/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/voice.sock"],
      }),
    ).toBe(false);
    expect(isToolRelayServer({ type: "http" })).toBe(false);
    expect(isToolRelayServer({ type: "stdio", command: "npx", args: ["some-server"] })).toBe(false);
  });
});
