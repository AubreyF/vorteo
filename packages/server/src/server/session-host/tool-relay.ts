import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import type { McpStdioServerConfig } from "../agent/agent-sdk-types.js";
import {
  isToolRelayServer,
  TOOL_RELAY_BRIDGE_FILE_NAME,
  TOOL_RELAY_DIRECTORY_NAME,
} from "./tool-relay-config.js";

export { isToolRelayServer, TOOL_RELAY_BRIDGE_FILE_NAME, TOOL_RELAY_DIRECTORY_NAME };

/**
 * The tool relay: hosted providers reach the daemon's agent tool endpoint through the session
 * host instead of directly. The host serves one unix socket per hosted session and speaks the MCP
 * stdio framing on it (one JSON-RPC message per line); the provider connects through the shipped
 * stdio-to-socket bridge, configured as an ordinary stdio tool server. The host turns each
 * inbound message into one POST to the daemon's stateless endpoint with its own token, reads the
 * JSON or SSE reply itself, and writes the reply back as one line.
 *
 * While no worker listens, which happens for seconds after a worker kill or during a graceful
 * swap, the direct connection used to fail the tool call. The relay holds a message whose POST
 * never reached a daemon, retrying until one answers or the hold bound passes. Each request's fate
 * is decided from its own response alone: a tool call whose reply stream breaks or ends without a
 * reply after the daemon may have run it is answered as unknown, never repeated, and never
 * disturbs the other calls in flight on the same connection.
 */

/** JSON-RPC error code for a message no daemon answered within the hold bound. */
export const TOOL_RELAY_UNAVAILABLE_CODE = -32000;
export const TOOL_RELAY_UNAVAILABLE_MESSAGE =
  "Vorteo tools are unavailable while the daemon restarts";
/** JSON-RPC error code for a call the daemon received but may or may not have finished. */
export const TOOL_RELAY_UNKNOWN_OUTCOME_CODE = -32001;
export const TOOL_RELAY_UNKNOWN_OUTCOME_MESSAGE =
  "The daemon restarted during this call; its outcome is unknown. Check before repeating it.";
/**
 * Methods that do no work, so repeating one is harmless. Everything else, tools/call above all,
 * is repeated only when the request certainly never reached a daemon.
 */
const READ_ONLY_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
]);
/** Connection failures that happen before any byte of the request is delivered. */
const NEVER_DELIVERED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);
export const DEFAULT_TOOL_RELAY_HOLD_MS = 60_000;
const DEFAULT_RETRY_MS = 500;
/** Unix socket paths are limited by the kernel; macOS allows 104 bytes including the terminator. */
const MAX_SOCKET_PATH_BYTES = 103;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_CONNECTIONS_PER_SESSION = 8;
const MAX_QUEUED_MESSAGES = 64;
const MAX_QUEUED_BYTES = 1024 * 1024;
const PARSE_ERROR_CODE = -32_700;

export type ToolRelayFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface ToolRelayOptions {
  /** The session host directory; sockets go in its tools subdirectory. */
  directory: string;
  /** The host's own token, which every worker accepts at the agent tool endpoint. */
  token: string;
  logger: Logger;
  /** Defaults to the bridge shipped with this host's release. */
  bridgePath?: string;
  /** How long a message whose POST never reached a daemon is retried. */
  holdMs?: number;
  retryMs?: number;
  fetch?: ToolRelayFetch;
  now?: () => number;
}

export interface ToolRelaySession {
  socketPath: string;
  /** The tool server config the provider is given instead of the direct connection. */
  server: McpStdioServerConfig;
  close(): Promise<void>;
}

export interface ToolRelay {
  /**
   * Starts relaying for a session to the daemon endpoint the worker injected. Returns null when
   * the socket path would be too long for the platform; the caller then keeps the direct
   * connection.
   */
  open(sessionId: string, url: string): Promise<ToolRelaySession | null>;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
  sessionCount(): number;
}

/** The bridge shipped with the release this module runs from, in source and built layouts alike. */
export function toolRelayBridgePath(): string {
  return fileURLToPath(new URL(`../../../scripts/${TOOL_RELAY_BRIDGE_FILE_NAME}`, import.meta.url));
}

/**
 * Copies the bridge into the host's private directory and returns the copy's path. The host can
 * outlive the release it started from: release cleanup may delete that tree while sessions keep
 * the host running, and providers launched afterwards would get a bridge path that no longer
 * exists. The bridge depends only on Node built-ins, so a copy runs anywhere. Its file name is
 * kept so worker-side recognition of the relay form still matches.
 */
export function pinToolRelayBridge(directory: string, source: Buffer): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const folder = path.join(directory, `bridge-${digest}`);
  const target = path.join(folder, TOOL_RELAY_BRIDGE_FILE_NAME);
  // A copy is reused only when it is a regular file, not a link, holding exactly these bytes.
  if (isExactRegularFile(target, source)) return target;
  if (lstatOrNull(folder)?.isDirectory() === false) rmSync(folder, { force: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!lstatSync(folder).isDirectory())
    throw new Error("The tool relay bridge folder is not a directory.");
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, source, { mode: 0o600, flag: "wx" });
  // rename replaces a stale file or a link itself, never the link's target.
  renameSync(temporary, target);
  return target;
}

function lstatOrNull(file: string) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

function isExactRegularFile(file: string, expected: Buffer): boolean {
  const info = lstatOrNull(file);
  if (!info?.isFile() || info.size !== expected.length) return false;
  return readFileSync(file).equals(expected);
}

/** The socket path for a session; the id is hashed so the path never carries user-chosen text. */
export function toolRelaySocketPath(directory: string, sessionId: string): string {
  const name = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return path.join(directory, TOOL_RELAY_DIRECTORY_NAME, `${name}.sock`);
}

type JsonRpcId = string | number;

/** Whether repeating the message cannot do work twice: a notification or a read-only method. */
function isRepeatable(message: JSONRPCMessage): boolean {
  if (!("method" in message)) return true;
  if (!("id" in message) || message.id === undefined) return true;
  return READ_ONLY_METHODS.has(message.method);
}

/**
 * Whether a failed send never delivered the request: the connection was refused or the host was
 * unreachable. fetch wraps the socket error as the cause, sometimes inside an AggregateError when
 * several addresses were tried.
 */
function neverDelivered(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof code === "string" && NEVER_DELIVERED_CODES.has(code)) return true;
  if (Array.isArray(errors) && errors.length > 0)
    return errors.every((inner) => neverDelivered(inner, depth + 1));
  return neverDelivered(cause, depth + 1);
}

function errorReply(id: JsonRpcId | null, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`;
}

/** The id of a request; null for a notification. */
function requestId(message: JSONRPCMessage): JsonRpcId | null {
  if (!("method" in message)) return null;
  return (message as { id?: JsonRpcId }).id ?? null;
}

/** The id a response or error answers; null for a message from the daemon that answers nothing. */
function replyId(message: JSONRPCMessage): JsonRpcId | null {
  if ("method" in message) return null;
  return (message as { id?: JsonRpcId | null }).id ?? null;
}

function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Reads an SSE body and yields the data of each event. Only the `data` field matters here: the
 * daemon's stateless endpoint sends one JSON-RPC message per event and never resumes a stream.
 */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  let data: string[] = [];
  const reader = body.getReader();
  const flush = function* (): Generator<string> {
    if (data.length > 0) yield data.join("\n");
    data = [];
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      if (line === "") yield* flush();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      newline = buffered.indexOf("\n");
    }
  }
  if (buffered.startsWith("data:")) data.push(buffered.slice(5).replace(/^ /, ""));
  yield* flush();
}

interface Queued {
  message: JSONRPCMessage;
  bytes: number;
  /** When the first attempt failed; the hold is measured from here. */
  heldSince: number | null;
}

interface ConnectionOptions {
  url: URL;
  token: string;
  holdMs: number;
  retryMs: number;
  fetch: ToolRelayFetch;
  now: () => number;
  logger: Logger;
}

/** What became of one POST, once its reply was read or its failure understood. */
type Outcome =
  /** A reply reached the provider, or the message needed none. */
  | { kind: "done" }
  /** The request certainly never ran; it may be repeated. */
  | { kind: "undelivered"; error: unknown }
  /** The daemon rejected the token: the worker has not learned it yet; repeating is safe. */
  | { kind: "unauthorized" }
  /** The daemon answered the request with a failure status. */
  | { kind: "refused"; status: number }
  /** The request reached the daemon, and its reply never arrived whole. */
  | { kind: "interrupted"; error: unknown };

/**
 * One provider connection: lines in, one POST per message, replies back as lines. Messages are
 * sent in order, one at a time until each is accepted, so a held message keeps its place; their
 * replies then stream in independently, and each request is answered exactly once from its own
 * response.
 */
function serveConnection(socket: net.Socket, options: ConnectionOptions): void {
  const queue: Queued[] = [];
  let queuedBytes = 0;
  /** Requests whose reply has not been written yet; a request is answered exactly once. */
  const pending = new Set<JsonRpcId>();
  /** Ends every POST of this connection when the provider's connection closes. */
  const aborter = new AbortController();
  let pumping = false;
  let closed = false;
  let buffered = "";

  /** Closed by either side, or ending after a refused message; nothing more is read or sent. */
  function isClosed(): boolean {
    return closed || socket.writableEnded;
  }

  function writeLine(line: string): void {
    if (!isClosed()) socket.write(line);
  }

  /**
   * Writes the request's error once; later outcomes for the same request are ignored. A
   * notification gets no reply of any kind, as JSON-RPC requires: its failure is only logged.
   */
  function answer(id: JsonRpcId | null, code: number, message: string): void {
    if (id === null) {
      options.logger.debug({ code, message }, "A relayed notification was dropped");
      return;
    }
    if (!pending.delete(id)) return;
    writeLine(errorReply(id, code, message));
  }

  function deliver(message: JSONRPCMessage): void {
    const id = replyId(message);
    if (id !== null && !pending.delete(id)) return;
    writeLine(`${JSON.stringify(message)}\n`);
  }

  /** Reads the response body to its end, delivering each JSON-RPC message it carries. */
  async function consume(response: Response, id: JsonRpcId | null): Promise<Outcome> {
    const type = mediaType(response);
    try {
      if (type === "application/json") {
        const data: unknown = await response.json();
        for (const item of Array.isArray(data) ? data : [data])
          deliver(JSONRPCMessageSchema.parse(item));
      } else if (type === "text/event-stream") {
        if (!response.body) throw new Error("The daemon's reply had no body.");
        for await (const data of sseEvents(response.body)) {
          const parsed = JSONRPCMessageSchema.safeParse(JSON.parse(data));
          if (parsed.success) deliver(parsed.data);
        }
      } else {
        await response.body?.cancel();
        throw new Error(`The daemon answered with an unexpected content type: ${type || "none"}.`);
      }
    } catch (error) {
      return { kind: "interrupted", error };
    }
    // The stream ended cleanly, yet the request is still waiting: its reply was never sent.
    if (id !== null && pending.has(id))
      return { kind: "interrupted", error: new Error("The reply stream ended without a reply.") };
    return { kind: "done" };
  }

  /**
   * One POST; resolves once the reply is fully read or the failure is understood. onAccepted
   * fires as soon as the daemon has the request and is answering it.
   */
  async function post(item: Queued, onAccepted: () => void): Promise<Outcome> {
    let response: Response;
    try {
      response = await options.fetch(options.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(item.message),
        signal: aborter.signal,
      });
    } catch (error) {
      return neverDelivered(error)
        ? { kind: "undelivered", error }
        : { kind: "interrupted", error };
    }
    if (response.status === 401) {
      await response.body?.cancel();
      return { kind: "unauthorized" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "refused", status: response.status };
    }
    if (response.status === 202) {
      await response.body?.cancel();
      return { kind: "done" };
    }
    onAccepted();
    return consume(response, requestId(item.message));
  }

  /** Whether a message may be sent again after this outcome, and the hold is not spent. */
  function mayRepeat(item: Queued, outcome: Outcome): boolean {
    if (outcome.kind === "done") return false;
    const repeatable = isRepeatable(item.message);
    const safe =
      outcome.kind === "undelivered" ||
      outcome.kind === "unauthorized" ||
      (repeatable && outcome.kind !== "refused");
    if (!safe) return false;
    const now = options.now();
    if (item.heldSince === null) {
      item.heldSince = now;
      options.logger.info(
        {
          err: "error" in outcome ? outcome.error : undefined,
          outcome: outcome.kind,
          holdMs: options.holdMs,
        },
        "No daemon answered a relayed tool message; holding it for a worker",
      );
    }
    return now - item.heldSince < options.holdMs;
  }

  /** Answers a request whose message will not be sent again. */
  function settle(item: Queued, outcome: Outcome): void {
    const id = requestId(item.message);
    if (outcome.kind === "done") return;
    // Once the request reached a daemon, a failed status or a broken reply says nothing about
    // whether the tool ran. Only a repeatable message may be reported as merely unavailable.
    const reached = outcome.kind === "interrupted" || outcome.kind === "refused";
    if (reached && !isRepeatable(item.message)) {
      options.logger.warn(
        {
          err: "error" in outcome ? outcome.error : undefined,
          status: "status" in outcome ? outcome.status : undefined,
          method: (item.message as { method?: string }).method,
        },
        "A relayed tool call failed after it may have reached a daemon; not repeated",
      );
      answer(id, TOOL_RELAY_UNKNOWN_OUTCOME_CODE, TOOL_RELAY_UNKNOWN_OUTCOME_MESSAGE);
      return;
    }
    if (outcome.kind === "refused")
      options.logger.warn({ status: outcome.status }, "The daemon refused a relayed tool message");
    answer(id, TOOL_RELAY_UNAVAILABLE_CODE, TOOL_RELAY_UNAVAILABLE_MESSAGE);
  }

  /**
   * Sends one message until it is accepted or given up. Resolves once the daemon has taken the
   * request (headers arrived) or the message is settled; the reply body is read in the
   * background, and a repeatable request whose reply breaks is queued again from there.
   */
  async function dispatch(item: Queued): Promise<void> {
    for (;;) {
      if (isClosed()) return;
      let signalAccepted: () => void = () => {};
      const accepted = new Promise<void>((resolve) => {
        signalAccepted = resolve;
      });
      const outcome = post(item, () => signalAccepted());
      // Headers arriving means the daemon has the request; the next message may go out while
      // this reply streams. A failure before headers settles the outcome instead.
      const first = await Promise.race([
        outcome.then(() => "settled" as const),
        accepted.then(() => "accepted" as const),
      ]);
      if (first === "accepted") {
        void outcome.then((result) => finishLater(item, result));
        return;
      }
      const result = await outcome;
      if (result.kind === "done") return;
      if (!mayRepeat(item, result)) {
        settle(item, result);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, options.retryMs));
    }
  }

  /** Ends a request whose reply streamed in the background: repeat it, answer it, or nothing. */
  function finishLater(item: Queued, result: Outcome): void {
    if (result.kind === "done" || isClosed()) return;
    if (mayRepeat(item, result)) requeue(item);
    else settle(item, result);
  }

  /** Puts a repeatable message back at the head of the queue after a short pause. */
  function requeue(item: Queued): void {
    setTimeout(() => {
      if (isClosed()) return;
      queue.unshift(item);
      queuedBytes += item.bytes;
      void pump();
    }, options.retryMs);
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && !isClosed()) {
        const item = queue.shift()!;
        queuedBytes -= item.bytes;
        const id = requestId(item.message);
        if (id !== null) pending.add(id);
        await dispatch(item);
      }
    } finally {
      pumping = false;
    }
  }

  function fail(id: JsonRpcId | null, code: number, message: string, andClose: boolean): void {
    if (isClosed()) return;
    if (id !== null || code === PARSE_ERROR_CODE) writeLine(errorReply(id, code, message));
    if (andClose) socket.end();
  }

  function accept(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(null, PARSE_ERROR_CODE, "The relayed line is not JSON", true);
      return;
    }
    const message = JSONRPCMessageSchema.safeParse(parsed);
    if (!message.success) {
      fail(null, PARSE_ERROR_CODE, "The relayed line is not a JSON-RPC message", true);
      return;
    }
    const bytes = Buffer.byteLength(line);
    if (queue.length >= MAX_QUEUED_MESSAGES || queuedBytes + bytes > MAX_QUEUED_BYTES) {
      fail(
        requestId(message.data),
        TOOL_RELAY_UNAVAILABLE_CODE,
        `${TOOL_RELAY_UNAVAILABLE_MESSAGE}; too many messages are waiting`,
        true,
      );
      return;
    }
    queue.push({ message: message.data, bytes, heldSince: null });
    queuedBytes += bytes;
    void pump();
  }

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    if (isClosed()) return;
    buffered += chunk;
    if (Buffer.byteLength(buffered) > MAX_LINE_BYTES && !buffered.includes("\n")) {
      fail(null, PARSE_ERROR_CODE, "The relayed line is too long", true);
      return;
    }
    let newline = buffered.indexOf("\n");
    while (newline !== -1 && !isClosed()) {
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      if (line.trim().length > 0) accept(line);
      newline = buffered.indexOf("\n");
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
    queue.length = 0;
    queuedBytes = 0;
    pending.clear();
    // The provider is gone: end its calls at the daemon too, so a long tool call stops running.
    aborter.abort();
  });
}

export function createToolRelay(options: ToolRelayOptions): ToolRelay {
  const bridgePath = options.bridgePath ?? toolRelayBridgePath();
  const holdMs = options.holdMs ?? DEFAULT_TOOL_RELAY_HOLD_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const relayFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, ToolRelaySession>();
  const directory = path.join(options.directory, TOOL_RELAY_DIRECTORY_NAME);
  const logger = options.logger.child({ module: "tool-relay" });
  if (!existsSync(bridgePath))
    throw new Error(`The tool relay bridge is missing at ${bridgePath}.`);
  // Keep the bytes so a pinned copy removed later can be restored without the release tree.
  const bridgeSource = readFileSync(bridgePath);
  pinToolRelayBridge(directory, bridgeSource);

  async function open(sessionId: string, url: string): Promise<ToolRelaySession | null> {
    const socketPath = toolRelaySocketPath(options.directory, sessionId);
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      logger.warn(
        "The tool relay socket path is too long; the session keeps its direct connection",
      );
      return null;
    }
    const existing = sessions.get(sessionId);
    if (existing) await existing.close();
    const target = new URL(url);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rm(socketPath, { force: true });
    const connections = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      if (connections.size >= MAX_CONNECTIONS_PER_SESSION) {
        socket.destroy();
        return;
      }
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      serveConnection(socket, {
        url: target,
        token: options.token,
        holdMs,
        retryMs,
        fetch: relayFetch,
        now,
        logger,
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    const session: ToolRelaySession = {
      socketPath,
      server: {
        type: "stdio",
        command: process.execPath,
        args: [pinToolRelayBridge(directory, bridgeSource), "--socket", socketPath],
      },
      async close() {
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
        for (const socket of connections) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(socketPath, { force: true });
      },
    };
    sessions.set(sessionId, session);
    logger.debug({ sessionId }, "Tool relay socket opened");
    return session;
  }

  return {
    open,
    async close(sessionId) {
      await sessions.get(sessionId)?.close();
    },
    async closeAll() {
      await Promise.all([...sessions.values()].map((session) => session.close()));
    },
    sessionCount: () => sessions.size,
  };
}
