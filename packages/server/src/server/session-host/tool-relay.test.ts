import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import {
  createToolRelay,
  isToolRelayServer,
  TOOL_RELAY_BRIDGE_FILE_NAME,
  TOOL_RELAY_UNAVAILABLE_CODE,
  TOOL_RELAY_UNKNOWN_OUTCOME_CODE,
  toolRelayBridgePath,
  toolRelaySocketPath,
  type ToolRelay,
} from "./tool-relay.js";

const TOKEN = "host-token";
const logger = pino({ level: "silent" });

/**
 * A stateless MCP-shaped endpoint behaving like the daemon's: SSE headers go out as soon as a
 * request arrives, the reply follows as one event, notifications get 202, a wrong token gets 401.
 * Every accepted request is counted so a test can prove what was and was not repeated, and
 * requests can be held open, dropped or broken at chosen points.
 */
interface FakeDaemon {
  url: string;
  port: number;
  /** Requests that passed the token check, in order. */
  requests: { method: string; id: unknown }[];
  /** Requests refused for a wrong token; they are not recorded above. */
  unauthorized: number;
  /** Rejects this many requests with 401 before accepting, as a worker without the host token. */
  rejectFirst: number;
  /** Answers this method with the given HTTP status instead of a reply. */
  failStatus: Map<string, number>;
  /** Drops this many connections before any headers: a worker killed on receipt. */
  dieBeforeHeaders: number;
  /** Sends headers for this many requests, then breaks the stream before the reply. */
  breakAfterHeaders: number;
  /** Sends headers for this many requests, then ends the stream cleanly with no reply. */
  endWithoutReply: number;
  /** Replies as plain JSON instead of SSE. */
  json: boolean;
  /** Request ids whose stream stays open until release(id) is called. */
  hold: Set<unknown>;
  /** Ids of held requests whose connection the client closed before any reply. */
  closedWhileHeld: unknown[];
  release(id: unknown): void;
  /** Stops accepting connections while existing streams stay open; listen() resumes. */
  stopListening(): Promise<void>;
  listen(): Promise<void>;
  close(): Promise<void>;
}

async function startFakeDaemon(port = 0): Promise<FakeDaemon> {
  const held = new Map<unknown, () => void>();
  const sockets = new Set<net.Socket>();
  let server: http.Server | null = null;
  const daemon: FakeDaemon = {
    url: "",
    port,
    requests: [],
    unauthorized: 0,
    rejectFirst: 0,
    failStatus: new Map(),
    dieBeforeHeaders: 0,
    breakAfterHeaders: 0,
    endWithoutReply: 0,
    json: false,
    hold: new Set(),
    closedWhileHeld: [],
    release(id) {
      held.get(id)?.();
      held.delete(id);
    },
    stopListening: async () => {
      const current = server;
      server = null;
      // close() stops accepting at once; its callback would wait for the open streams to end.
      current?.close();
    },
    async listen() {
      server = http.createServer(handle);
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      const target = server;
      await new Promise<void>((resolve) => target.listen(daemon.port, "127.0.0.1", resolve));
      daemon.port = (target.address() as net.AddressInfo).port;
      daemon.url = `http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=agent-1`;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await daemon.stopListening();
    },
  };

  function reply(res: http.ServerResponse, message: unknown): void {
    if (daemon.json) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message));
      return;
    }
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    res.end();
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers.authorization !== `Bearer ${TOKEN}` || daemon.rejectFirst > 0) {
      if (daemon.rejectFirst > 0) daemon.rejectFirst -= 1;
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
      const method = message.method ?? "";
      daemon.requests.push({ method, id: message.id });
      if (daemon.dieBeforeHeaders > 0) {
        daemon.dieBeforeHeaders -= 1;
        req.socket.destroy();
        return;
      }
      const status = daemon.failStatus.get(method);
      if (status) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "failed" }));
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        method === "tools/call" ? { content: [{ type: "text", text: "ran" }] } : { echo: method };
      const answer = { jsonrpc: "2.0", id: message.id, result };
      if (daemon.json) {
        reply(res, answer);
        return;
      }
      // As the daemon does: headers at once, the reply when the tool finishes.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      if (daemon.breakAfterHeaders > 0) {
        daemon.breakAfterHeaders -= 1;
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (daemon.endWithoutReply > 0) {
        daemon.endWithoutReply -= 1;
        setTimeout(() => res.end(), 20);
        return;
      }
      if (daemon.hold.has(message.id)) {
        held.set(message.id, () => reply(res, answer));
        res.once("close", () => {
          if (held.has(message.id)) daemon.closedWhileHeld.push(message.id);
        });
        return;
      }
      setTimeout(() => reply(res, answer), 10);
    });
  }

  await daemon.listen();
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

async function daemonFor(): Promise<FakeDaemon> {
  const daemon = await startFakeDaemon();
  cleanups.push(() => daemon.close());
  return daemon;
}

async function relayFor(
  overrides: Partial<Parameters<typeof createToolRelay>[0]> = {},
): Promise<{ relay: ToolRelay; directory: string }> {
  const directory = tempDirectory();
  const relay = createToolRelay({ directory, token: TOKEN, logger, ...overrides });
  cleanups.push(() => relay.closeAll());
  return { relay, directory };
}

/** A relay session on a fresh daemon with a connected line client, the common test setup. */
async function connectedRelay(
  daemon: FakeDaemon,
  overrides: Partial<Parameters<typeof createToolRelay>[0]> = { retryMs: 20, holdMs: 5_000 },
) {
  const { relay, directory } = await relayFor(overrides);
  const session = await relay.open("session-1", daemon.url);
  if (!session) throw new Error("relay refused the session");
  const client = new LineClient(session.socketPath);
  cleanups.push(() => client.end());
  await client.ready();
  return { relay, directory, session, client };
}

const call = (id: unknown, name = "send") => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name },
});
const ran = (id: unknown) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: "ran" }] },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("tool relay", () => {
  test("relays requests, SSE and JSON replies and notifications, and leaves bodies untouched", async () => {
    const daemon = await daemonFor();
    const { relay, directory, session, client } = await connectedRelay(daemon);
    expect(session.socketPath).toBe(toolRelaySocketPath(directory, "session-1"));
    expect(statSync(session.socketPath).mode & 0o777).toBe(0o600);
    expect(isToolRelayServer(session.server)).toBe(true);
    // The provider runs the host's pinned copy of the shipped bridge, not the release file.
    const script = session.server.args![0]!;
    expect(script.startsWith(path.join(directory, "tools"))).toBe(true);
    expect(readFileSync(script)).toEqual(readFileSync(toolRelayBridgePath()));

    client.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(await client.next()).toEqual([
      { jsonrpc: "2.0", id: 1, result: { echo: "tools/list" } },
    ]);
    client.send(call("two"));
    expect(await client.next()).toEqual([ran("two")]);
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    daemon.json = true;
    client.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(await client.next()).toEqual([{ jsonrpc: "2.0", id: 3, result: { echo: "ping" } }]);
    expect(daemon.requests.map((entry) => entry.method)).toEqual([
      "tools/list",
      "tools/call",
      "notifications/initialized",
      "ping",
    ]);
    expect(relay.sessionCount()).toBe(1);
    await relay.close("session-1");
    expect(existsSync(session.socketPath)).toBe(false);
    expect(relay.sessionCount()).toBe(0);
  });

  test("a tool call whose reply stream breaks after the headers is answered as unknown, once", async () => {
    const daemon = await daemonFor();
    daemon.breakAfterHeaders = 1;
    const { client } = await connectedRelay(daemon);
    client.send(call(21));
    const [reply] = await client.next();
    expect(reply).toMatchObject({
      id: 21,
      error: { code: TOOL_RELAY_UNKNOWN_OUTCOME_CODE, message: expect.stringContaining("unknown") },
    });
    await settle();
    expect(daemon.requests.map((entry) => entry.id)).toEqual([21]);
    // The connection stays usable.
    client.send(call(22));
    expect(await client.next()).toEqual([ran(22)]);
    expect(client.lines).toEqual([]);
  });

  test("a tool call the daemon dropped before any headers is answered as unknown, once", async () => {
    const daemon = await daemonFor();
    daemon.dieBeforeHeaders = 1;
    const { client } = await connectedRelay(daemon);
    client.send(call(23));
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: 23, error: { code: TOOL_RELAY_UNKNOWN_OUTCOME_CODE } });
    await settle();
    expect(daemon.requests.map((entry) => entry.id)).toEqual([23]);
  });

  test("a reply stream that ends cleanly without the reply answers the call as unknown", async () => {
    const daemon = await daemonFor();
    daemon.endWithoutReply = 1;
    const { client } = await connectedRelay(daemon);
    client.send(call(24));
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: 24, error: { code: TOOL_RELAY_UNKNOWN_OUTCOME_CODE } });
    expect(daemon.requests).toHaveLength(1);
  });

  test("a read-only request is repeated after its stream breaks or ends without a reply", async () => {
    const daemon = await daemonFor();
    daemon.breakAfterHeaders = 1;
    daemon.endWithoutReply = 1;
    const { client } = await connectedRelay(daemon);
    client.send({ jsonrpc: "2.0", id: 25, method: "tools/list" });
    expect(await client.next()).toEqual([
      { jsonrpc: "2.0", id: 25, result: { echo: "tools/list" } },
    ]);
    expect(daemon.requests.map((entry) => entry.id)).toEqual([25, 25, 25]);
  });

  test("a failed status for one call never touches another call still streaming", async () => {
    const daemon = await daemonFor();
    daemon.hold.add("A");
    daemon.failStatus.set("tools/list", 500);
    const { client } = await connectedRelay(daemon);
    client.send(call("A"));
    await settle();
    client.send({ jsonrpc: "2.0", id: "B", method: "tools/list" });
    const [replyB] = await client.next();
    expect(replyB).toMatchObject({ id: "B", error: { code: TOOL_RELAY_UNAVAILABLE_CODE } });
    daemon.failStatus.clear();
    client.send(call("C"));
    expect(await client.next()).toEqual([ran("C")]);
    // A is still running; nothing has been said about it.
    await settle();
    expect(client.lines).toEqual([]);
    daemon.release("A");
    expect(await client.next()).toEqual([ran("A")]);
    await settle();
    expect(client.lines).toEqual([]);
    expect(daemon.requests.map((entry) => entry.id)).toEqual(["A", "B", "C"]);
  });

  test("a tool call refused with a failed status is answered as unknown", async () => {
    const daemon = await daemonFor();
    daemon.failStatus.set("tools/call", 500);
    const { client } = await connectedRelay(daemon);
    client.send(call(26));
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: 26, error: { code: TOOL_RELAY_UNKNOWN_OUTCOME_CODE } });
    expect(daemon.requests).toHaveLength(1);
  });

  test("a call held through a refused connection never touches another call still streaming", async () => {
    const daemon = await daemonFor();
    daemon.hold.add("A");
    const { client } = await connectedRelay(daemon);
    client.send(call("A"));
    await settle();
    // The daemon stops listening with A's stream open: B is refused and held.
    await daemon.stopListening();
    client.send(call("B"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.lines).toEqual([]);
    await daemon.listen();
    expect(await client.next()).toEqual([ran("B")]);
    daemon.release("A");
    expect(await client.next()).toEqual([ran("A")]);
    await settle();
    expect(client.lines).toEqual([]);
    expect(daemon.requests.map((entry) => entry.id)).toEqual(["A", "B"]);
  });

  test("holds messages while no daemon listens and delivers each once when one appears", async () => {
    const probe = await startFakeDaemon();
    const { url, port } = probe;
    await probe.close();
    const { relay } = await relayFor({ retryMs: 50 });
    const session = await relay.open("session-1", url);
    const client = new LineClient(session!.socketPath);
    cleanups.push(() => client.end());
    await client.ready();
    const sentAt = Date.now();
    client.send(call(7));
    client.send({ jsonrpc: "2.0", id: 8, method: "tools/list" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.lines).toEqual([]);

    const daemon = await startFakeDaemon(port);
    cleanups.push(() => daemon.close());
    expect(await client.next(2)).toEqual([
      ran(7),
      { jsonrpc: "2.0", id: 8, result: { echo: "tools/list" } },
    ]);
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(300);
    expect(daemon.requests.map((entry) => entry.id)).toEqual([7, 8]);
  });

  test("answers a held request with an error once the hold bound passes", async () => {
    const probe = await startFakeDaemon();
    const { url } = probe;
    await probe.close();
    let now = 1_000;
    const { relay } = await relayFor({ retryMs: 20, holdMs: 500, now: () => now });
    const session = await relay.open("session-1", url);
    const client = new LineClient(session!.socketPath);
    cleanups.push(() => client.end());
    await client.ready();
    client.send(call(9));
    client.send({ jsonrpc: "2.0", method: "notifications/progress" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.lines).toEqual([]);
    now += 600;
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: 9, error: { code: TOOL_RELAY_UNAVAILABLE_CODE } });
    // The notification was dropped without a reply, and the connection stays usable.
    await settle();
    expect(client.lines).toEqual([]);
    expect(client.closed).toBe(false);
  });

  test("a failed or abandoned notification produces no line at all", async () => {
    const daemon = await daemonFor();
    daemon.failStatus.set("notifications/progress", 500);
    let now = 1_000;
    const { client } = await connectedRelay(daemon, { retryMs: 20, holdMs: 500, now: () => now });
    client.send({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
    client.send({ jsonrpc: "2.0", id: 31, method: "ping" });
    expect(await client.next()).toEqual([{ jsonrpc: "2.0", id: 31, result: { echo: "ping" } }]);
    expect(daemon.requests.map((entry) => entry.method)).toEqual([
      "notifications/progress",
      "ping",
    ]);

    // The same notification held while nothing listens, past the bound: still no line.
    await daemon.stopListening();
    client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} });
    await settle();
    now += 600;
    await settle();
    expect(client.lines).toEqual([]);
    await daemon.listen();
    client.send({ jsonrpc: "2.0", id: 32, method: "ping" });
    expect(await client.next()).toEqual([{ jsonrpc: "2.0", id: 32, result: { echo: "ping" } }]);
    expect(client.lines).toEqual([]);
  });

  test("closing the provider's connection ends its calls at the daemon", async () => {
    const daemon = await daemonFor();
    daemon.hold.add("A");
    const { client } = await connectedRelay(daemon);
    client.send(call("A"));
    await settle();
    expect(daemon.requests.map((entry) => entry.id)).toEqual(["A"]);
    client.end();
    const deadline = Date.now() + 5_000;
    while (daemon.closedWhileHeld.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(daemon.closedWhileHeld).toEqual(["A"]);
  });

  test("a rejected token is held for a worker that has the host token, then delivered once", async () => {
    const daemon = await daemonFor();
    daemon.rejectFirst = 2;
    const { client } = await connectedRelay(daemon);
    client.send(call(11));
    expect(await client.next()).toEqual([ran(11)]);
    expect(daemon.unauthorized).toBe(2);
    expect(daemon.requests.map((entry) => entry.id)).toEqual([11]);
  });

  test("a token the daemon never accepts fails at the hold bound", async () => {
    const daemon = await daemonFor();
    let now = 1_000;
    const { client } = await connectedRelay(daemon, {
      token: "wrong",
      retryMs: 20,
      holdMs: 500,
      now: () => now,
    });
    client.send({ jsonrpc: "2.0", id: 12, method: "tools/list" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.lines).toEqual([]);
    now += 600;
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: 12, error: { code: TOOL_RELAY_UNAVAILABLE_CODE } });
    expect(daemon.requests).toEqual([]);
  });

  test("a malformed line gets a parse error and closes the connection", async () => {
    const daemon = await daemonFor();
    const { session, client } = await connectedRelay(daemon);
    client.send("{not json");
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: null, error: { code: -32_700 } });
    await client.untilClosed();
    expect(daemon.requests).toEqual([]);

    const other = new LineClient(session.socketPath);
    cleanups.push(() => other.end());
    await other.ready();
    other.send({ jsonrpc: "2.0", id: 13, method: "ping" });
    expect(await other.next()).toEqual([{ jsonrpc: "2.0", id: 13, result: { echo: "ping" } }]);
  });

  test("bounds the messages waiting on a connection", async () => {
    const probe = await startFakeDaemon();
    const { url } = probe;
    await probe.close();
    const { relay } = await relayFor({ retryMs: 20, holdMs: 60_000 });
    const session = await relay.open("session-1", url);
    const client = new LineClient(session!.socketPath);
    cleanups.push(() => client.end());
    await client.ready();
    for (let index = 0; index < 66; index += 1) client.send(call(index));
    const [reply] = await client.next();
    expect(reply).toMatchObject({ id: 65, error: { code: TOOL_RELAY_UNAVAILABLE_CODE } });
    await client.untilClosed();
  });

  test("reopening a session replaces its socket, and closing all removes every socket", async () => {
    const daemon = await daemonFor();
    const { relay } = await relayFor();
    const first = await relay.open("session-1", daemon.url);
    const firstClient = new LineClient(first!.socketPath);
    cleanups.push(() => firstClient.end());
    await firstClient.ready();
    const second = await relay.open("session-1", daemon.url);
    expect(second!.socketPath).toBe(first!.socketPath);
    await firstClient.untilClosed();
    const client = new LineClient(second!.socketPath);
    cleanups.push(() => client.end());
    await client.ready();
    client.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(await client.next()).toHaveLength(1);
    await relay.open("session-2", daemon.url);
    expect(relay.sessionCount()).toBe(2);
    await relay.closeAll();
    expect(relay.sessionCount()).toBe(0);
    expect(existsSync(second!.socketPath)).toBe(false);
  });

  test("refuses a socket path too long for the platform", async () => {
    const daemon = await daemonFor();
    const directory = path.join(tempDirectory(), "x".repeat(90));
    const relay = createToolRelay({ directory, token: TOKEN, logger });
    expect(await relay.open("session-1", daemon.url)).toBeNull();
    expect(relay.sessionCount()).toBe(0);
  });

  test("the shipped bridge carries a request through the relay", async () => {
    const daemon = await daemonFor();
    const { relay } = await relayFor();
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

  test("keeps serving its bridge after the release it started from is deleted", async () => {
    const daemon = await daemonFor();
    const release = tempDirectory();
    const shipped = path.join(release, TOOL_RELAY_BRIDGE_FILE_NAME);
    writeFileSync(shipped, readFileSync(toolRelayBridgePath()));
    const { relay } = await relayFor({ bridgePath: shipped });
    rmSync(release, { recursive: true, force: true });
    const session = await relay.open("session-1", daemon.url);
    const script = session!.server.args![0]!;
    expect(script.startsWith(release)).toBe(false);
    expect(existsSync(script)).toBe(true);
    expect(isToolRelayServer(session!.server)).toBe(true);
    // A pinned copy removed by cleanup is restored from memory on the next open.
    rmSync(script);
    const next = await relay.open("session-2", daemon.url);
    expect(existsSync(next!.server.args![0]!)).toBe(true);
  });

  test("replaces a modified or linked bridge copy with the exact shipped bytes", async () => {
    const daemon = await daemonFor();
    const shipped = readFileSync(toolRelayBridgePath());
    const { relay, directory } = await relayFor();
    const first = await relay.open("session-1", daemon.url);
    const pinned = first!.server.args![0]!;
    // A truncated copy under the expected name is rewritten before the next provider uses it.
    writeFileSync(pinned, "process.exit(1)\n");
    const second = await relay.open("session-2", daemon.url);
    expect(second!.server.args![0]).toBe(pinned);
    expect(readFileSync(pinned)).toEqual(shipped);
    // A link at that name is replaced by a regular file; its target is left untouched.
    const elsewhere = path.join(directory, "elsewhere.mjs");
    writeFileSync(elsewhere, "process.exit(1)\n");
    rmSync(pinned);
    symlinkSync(elsewhere, pinned);
    await relay.open("session-3", daemon.url);
    expect(lstatSync(pinned).isSymbolicLink()).toBe(false);
    expect(readFileSync(pinned)).toEqual(shipped);
    expect(readFileSync(elsewhere, "utf8")).toBe("process.exit(1)\n");
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
