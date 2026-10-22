import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
 * inbound message into a POST to the daemon's stateless endpoint with its own token and writes the
 * daemon's reply back as one line.
 *
 * While no worker listens, which happens for seconds after a worker kill or during a graceful
 * swap, the direct connection used to fail the tool call. The relay holds a message whose POST
 * never reached a daemon, retrying until one answers or the hold bound passes. A failure after the
 * daemon started answering is never retried, since the tool may already have run.
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

type Attempt =
  | { outcome: "sent" }
  | { outcome: "retry" }
  | { outcome: "failed"; code: number; message: string };

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

/**
 * One provider connection: lines in, POSTs out, replies back as lines. Messages are sent one at
 * a time so a held message keeps its order and a response is always matched to its request.
 */
function serveConnection(socket: net.Socket, options: ConnectionOptions): void {
  const queue: Queued[] = [];
  let queuedBytes = 0;
  /** Requests sent to the daemon whose reply has not arrived. */
  const pending = new Set<JsonRpcId>();
  let pumping = false;
  let closed = false;
  let buffered = "";
  /** Set by the fetch wrapper once the daemon started answering the current message. */
  let responded = false;

  const transport = new StreamableHTTPClientTransport(options.url, {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
    fetch: async (url, init) => {
      const response = await options.fetch(url, init);
      responded = true;
      return response;
    },
  });
  // The transport is not an event target; its callbacks are plain properties.
  Object.assign(transport, {
    onmessage: (message: JSONRPCMessage) => {
      const id = replyId(message);
      if (id !== null) pending.delete(id);
      if (!isClosed()) socket.write(`${JSON.stringify(message)}\n`);
    },
    onerror: (error: Error) => {
      // A reply stream that broke after the daemon started answering: the tool may have run, so
      // the waiting requests get an error rather than a retry.
      if (pending.size === 0) return;
      options.logger.warn(
        { err: error, requests: pending.size },
        "The daemon's tool reply stream failed; answering the waiting requests with an error",
      );
      for (const id of pending)
        socket.write(errorReply(id, TOOL_RELAY_UNAVAILABLE_CODE, TOOL_RELAY_UNAVAILABLE_MESSAGE));
      pending.clear();
    },
  });

  /** Closed by either side, or ending after a refused message; nothing more is read or sent. */
  function isClosed(): boolean {
    return closed || socket.writableEnded;
  }

  function fail(id: JsonRpcId | null, code: number, message: string, andClose: boolean): void {
    if (isClosed()) return;
    if (id !== null || code === PARSE_ERROR_CODE) socket.write(errorReply(id, code, message));
    if (andClose) socket.end();
  }

  const unavailable: Attempt = {
    outcome: "failed",
    code: TOOL_RELAY_UNAVAILABLE_CODE,
    message: TOOL_RELAY_UNAVAILABLE_MESSAGE,
  };

  async function attempt(item: Queued): Promise<Attempt> {
    responded = false;
    try {
      await transport.send(item.message);
      return { outcome: "sent" };
    } catch (error) {
      if (responded) {
        options.logger.warn(
          { err: error },
          "The daemon answered a relayed tool message with a failure; not retried",
        );
        return unavailable;
      }
      // A request that may have reached a daemon is repeated only when repeating it does no
      // work. A tool call whose worker died mid-request might have run: the caller must check.
      if (!isRepeatable(item.message) && !neverDelivered(error)) {
        options.logger.warn(
          { err: error, method: (item.message as { method?: string }).method },
          "A relayed tool call failed after it may have reached a daemon; not retried",
        );
        return {
          outcome: "failed",
          code: TOOL_RELAY_UNKNOWN_OUTCOME_CODE,
          message: TOOL_RELAY_UNKNOWN_OUTCOME_MESSAGE,
        };
      }
      const now = options.now();
      if (item.heldSince === null) {
        item.heldSince = now;
        options.logger.info(
          { err: error, holdMs: options.holdMs },
          "No daemon answered a relayed tool message; holding it for a worker",
        );
      }
      return now - item.heldSince < options.holdMs ? { outcome: "retry" } : unavailable;
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && !isClosed()) {
        const item = queue[0]!;
        const result = await attempt(item);
        if (result.outcome === "retry") {
          await new Promise((resolve) => setTimeout(resolve, options.retryMs));
          continue;
        }
        queue.shift();
        queuedBytes -= item.bytes;
        const id = requestId(item.message);
        if (result.outcome === "sent") {
          if (id !== null) pending.add(id);
        } else {
          fail(id, result.code, result.message, false);
        }
      }
    } finally {
      pumping = false;
    }
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
    void transport.close().catch(() => {});
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
        args: [bridgePath, "--socket", socketPath],
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
