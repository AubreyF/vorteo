import { randomUUID } from "node:crypto";
import net from "node:net";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { readFrames } from "./frame-reader.js";
import {
  AttachResultSchema,
  LoggedHistoryPageSchema,
  SessionListSchema,
  type HostedSessionSummary,
  type LoggedHistoryPage,
  MAX_FRAME_BYTES,
  SESSION_HOST_PROTOCOL_VERSION,
  SessionHostReplySchema,
  type AttachResult,
  type HelloRequest,
  type HostIdentity,
  type SessionHostCall,
  type SessionHostErrorCode,
  type SessionHostRequest,
} from "./protocol.js";

export class SessionHostClientError extends Error {
  constructor(
    /** unavailable: nothing is listening, so no host is running. */
    readonly code: SessionHostErrorCode | "disconnected" | "timeout" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SessionHostClientError";
  }
}

export type HostedEventListener = (event: JsonValue, seq: number) => void;

interface Greeting {
  host: HostIdentity;
  mcpToken: string;
}

/** A worker's handle on one hosted session. It tracks the last delivered seq for reattach. */
export interface HostedSession {
  readonly sessionId: string;
  readonly attach: AttachResult;
  lastSeq(): number;
  subscribe(listener: HostedEventListener): () => void;
  /**
   * Called once when this worker stops driving the session: fenced by a newer attachment, the
   * connection ended, or the host skipped events. After a gap, attach again from lastSeq().
   */
  onDetached(listener: (reason: HostedSessionDetachReason) => void): void;
  acknowledge(seq: number): void;
  /** Sends one session call. The caller checks the result against the method's contract. */
  call(call: SessionHostCall): Promise<JsonValue>;
  /** Retained events in (afterSeq, throughSeq], one page at a time. Needs the attachment. */
  history(input: { afterSeq: number; throughSeq: number }): Promise<LoggedHistoryPage>;
  /** Lets go of the attachment without closing the session; this handle stops receiving. */
  release(): void;
}

export type HostedSessionDetachReason = "fenced" | "disconnected" | "gap";

export interface SessionHostClient {
  /** The host run this connection authenticated to. */
  readonly host: HostIdentity;
  /** Bearer token the worker's agent tool endpoint must accept for hosted providers. */
  readonly mcpToken: string;
  /** True once the connection has ended. */
  readonly closed: boolean;
  /** Every session the host runs, so a starting worker can decide which ones to attach. */
  list(): Promise<HostedSessionSummary[]>;
  open(input: { sessionId: string; provider: string; config: JsonValue }): Promise<HostedSession>;
  /** afterSeq null attaches at the newest event, without replay. */
  attach(input: { sessionId: string; afterSeq: number | null }): Promise<HostedSession>;
  /** Called once when the connection ends for any reason. */
  onClose(listener: (error: SessionHostClientError) => void): void;
  close(): void;
}

export interface ConnectSessionHostOptions {
  socketPath: string;
  token: string;
  /** Reported to the host audit log. */
  release?: string;
  /** Bounds connecting and the hello exchange together. */
  connectTimeoutMs?: number;
}

interface SessionChannel {
  events: HostedEventListener[];
  /** Holds replay and live events until the first subscriber, so none are skipped. */
  buffered: [JsonValue, number][] | null;
  detached: ((reason: HostedSessionDetachReason) => void)[];
  /** Kept so a listener registered after the detach still learns why. */
  detachedReason: HostedSessionDetachReason | null;
  lastSeq: number;
}

function detachChannel(channel: SessionChannel, reason: HostedSessionDetachReason): void {
  if (channel.detachedReason) return;
  channel.detachedReason = reason;
  for (const listener of channel.detached.splice(0)) listener(reason);
}

export async function connectSessionHost(
  options: ConnectSessionHostOptions,
): Promise<SessionHostClient> {
  const socket = net.createConnection(options.socketPath);
  const pending = new Map<
    string,
    {
      resolve: (value: JsonValue) => void;
      reject: (error: Error) => void;
      /** Runs when the result frame is read, before any later frame. */
      onResult?: (value: JsonValue) => void;
    }
  >();
  const channels = new Map<string, SessionChannel>();
  const closeListeners: ((error: SessionHostClientError) => void)[] = [];
  let greeted: ((result: Greeting | Error) => void) | null = null;
  let closeError: SessionHostClientError | null = null;

  /** Ends the connection and settles everything waiting on it, exactly once. */
  function terminate(error: SessionHostClientError): void {
    if (closeError) return;
    closeError = error;
    socket.destroy();
    greeted?.(error);
    greeted = null;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    // Connection listeners run first, so sessions that reattach never reuse this connection.
    for (const listener of closeListeners.splice(0)) listener(error);
    for (const channel of channels.values()) detachChannel(channel, "disconnected");
    channels.clear();
  }

  function handleFrame(line: string): void {
    const parsed = SessionHostReplySchema.safeParse(parseLine(line));
    if (!parsed.success) {
      // A frame this worker cannot read may hide an event. Fail closed; reattach replays it.
      terminate(
        new SessionHostClientError("invalid_frame", "Session host sent a malformed frame."),
      );
      return;
    }
    const reply = parsed.data;
    switch (reply.type) {
      case "hello":
        if (reply.protocolVersion !== SESSION_HOST_PROTOCOL_VERSION) {
          terminate(new SessionHostClientError("version", "Session host protocol differs."));
          return;
        }
        greeted?.({ host: reply.host, mcpToken: reply.mcpToken });
        greeted = null;
        return;
      case "event": {
        const channel = channels.get(reply.sessionId);
        // Replay may overlap what this worker already applied; seq makes delivery idempotent.
        if (!channel || reply.seq <= channel.lastSeq) return;
        if (reply.seq !== channel.lastSeq + 1) {
          // Only this session lost its place; the connection's other sessions stay attached.
          channels.delete(reply.sessionId);
          detachChannel(channel, "gap");
          return;
        }
        channel.lastSeq = reply.seq;
        if (channel.buffered) channel.buffered.push([reply.event, reply.seq]);
        else for (const listener of channel.events) listener(reply.event, reply.seq);
        return;
      }
      case "detached": {
        const channel = channels.get(reply.sessionId);
        channels.delete(reply.sessionId);
        if (channel) detachChannel(channel, "fenced");
        return;
      }
      case "result": {
        const waiter = pending.get(reply.requestId);
        pending.delete(reply.requestId);
        waiter?.onResult?.(reply.value);
        waiter?.resolve(reply.value);
        return;
      }
      case "error": {
        const error = new SessionHostClientError(reply.code, reply.message);
        // The host follows a connection-level error by closing the socket.
        if (reply.requestId === null) {
          terminate(error);
          return;
        }
        pending.get(reply.requestId)?.reject(error);
        pending.delete(reply.requestId);
        return;
      }
    }
  }

  readFrames(socket, {
    maxFrameBytes: MAX_FRAME_BYTES,
    onFrame: handleFrame,
    onOversize: () =>
      terminate(new SessionHostClientError("invalid_frame", "Session host frame is too large.")),
  });
  let connected = false;
  socket.once("connect", () => {
    connected = true;
  });
  socket.on("close", () =>
    terminate(new SessionHostClientError("disconnected", "Session host connection closed.")),
  );
  socket.on("error", (error: NodeJS.ErrnoException) => {
    if (!connected)
      terminate(
        new SessionHostClientError(
          "unavailable",
          `Session host is not accepting connections (${error.code ?? "unknown"}).`,
        ),
      );
    socket.destroy();
  });

  function send(request: SessionHostRequest | HelloRequest): void {
    if (closeError) throw closeError;
    socket.write(`${JSON.stringify(request)}\n`);
  }

  function call(
    frame: (requestId: string) => SessionHostRequest,
    onResult?: (value: JsonValue) => void,
  ): Promise<JsonValue> {
    if (closeError) return Promise.reject(closeError);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject, onResult });
      send(frame(requestId));
    });
  }

  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const { host, mcpToken } = await new Promise<Greeting>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        terminate(new SessionHostClientError("timeout", "Session host did not answer in time.")),
      connectTimeoutMs,
    );
    greeted = (result) => {
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    socket.once("connect", () =>
      send({
        type: "hello",
        protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
        token: options.token,
        client: { pid: process.pid, ...(options.release ? { release: options.release } : {}) },
      }),
    );
  });

  function hosted(sessionId: string, channel: SessionChannel, attach: AttachResult): HostedSession {
    return {
      sessionId,
      attach,
      lastSeq: () => channel.lastSeq,
      subscribe(listener) {
        for (const [event, seq] of channel.buffered?.splice(0) ?? []) listener(event, seq);
        channel.buffered = null;
        channel.events.push(listener);
        return () => {
          channel.events = channel.events.filter((item) => item !== listener);
        };
      },
      onDetached(listener) {
        if (channel.detachedReason) listener(channel.detachedReason);
        else channel.detached.push(listener);
      },
      acknowledge(seq) {
        if (closeError || channels.get(sessionId) !== channel) return;
        send({ type: "ack", sessionId, seq });
      },
      async call(hostCall) {
        const value = await call((requestId) => ({
          type: "call",
          requestId,
          sessionId,
          call: hostCall,
        }));
        if (hostCall.method === "close" && channels.get(sessionId) === channel)
          channels.delete(sessionId);
        return value;
      },
      release() {
        if (channels.get(sessionId) !== channel) return;
        channels.delete(sessionId);
        if (!closeError) send({ type: "release", sessionId });
      },
      async history({ afterSeq, throughSeq }) {
        const value = await call((requestId) => ({
          type: "history",
          requestId,
          sessionId,
          afterSeq,
          throughSeq,
        }));
        const page = LoggedHistoryPageSchema.safeParse(value);
        if (!page.success)
          throw new SessionHostClientError("invalid_frame", "Session host sent a malformed page.");
        return page.data;
      },
    };
  }

  /** The channel exists before the request so same-tick replay is buffered, not dropped. */
  async function bind(
    sessionId: string,
    afterSeq: number | null,
    frame: (requestId: string) => SessionHostRequest,
  ): Promise<HostedSession> {
    if (channels.has(sessionId))
      throw new SessionHostClientError("conflict", "This connection already drives the session.");
    const channel: SessionChannel = {
      events: [],
      buffered: [],
      detached: [],
      detachedReason: null,
      lastSeq: afterSeq ?? 0,
    };
    channels.set(sessionId, channel);
    try {
      const attach = AttachResultSchema.parse(
        await call(frame, (value) => {
          // Attaching at the newest event replays nothing; live events continue from lastSeq.
          if (afterSeq !== null) return;
          const parsed = AttachResultSchema.safeParse(value);
          if (parsed.success) channel.lastSeq = parsed.data.lastSeq;
        }),
      );
      return hosted(sessionId, channel, attach);
    } catch (error) {
      if (channels.get(sessionId) === channel) channels.delete(sessionId);
      throw error;
    }
  }

  return {
    host,
    mcpToken,
    async list() {
      const value = await call((requestId) => ({ type: "list", requestId }));
      const parsed = SessionListSchema.safeParse(value);
      if (!parsed.success)
        throw new SessionHostClientError("invalid_frame", "Session host sent a malformed list.");
      return parsed.data.sessions;
    },
    get closed() {
      return closeError !== null;
    },
    open: ({ sessionId, provider, config }) =>
      bind(sessionId, 0, (requestId) => ({ type: "open", requestId, sessionId, provider, config })),
    attach: ({ sessionId, afterSeq }) =>
      bind(sessionId, afterSeq, (requestId) => ({
        type: "attach",
        requestId,
        sessionId,
        afterSeq,
      })),
    onClose(listener) {
      if (closeError) listener(closeError);
      else closeListeners.push(listener);
    },
    close: () =>
      terminate(new SessionHostClientError("disconnected", "Session host connection closed.")),
  };
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
