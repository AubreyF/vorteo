import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { readFrames } from "./frame-reader.js";
import {
  acquireHostLock,
  claimSocketPath,
  preparePrivateDirectory,
  type SessionHostAuditSink,
} from "./host-files.js";
import {
  HelloEnvelopeSchema,
  HelloRequestSchema,
  MAX_FRAME_BYTES,
  MAX_HELLO_FRAME_BYTES,
  SELF_PROBE_RELEASE,
  SESSION_HOST_PROTOCOL_VERSION,
  SessionHostRequestSchema,
  type AttachResult,
  type DroppedEvent,
  type LoggedHistoryPage,
  type HostIdentity,
  type SessionHostCall,
  type SessionHostErrorCode,
  type SessionHostReply,
  type SessionHostRequest,
} from "./protocol.js";
import type { z } from "zod";
import type { SessionListSchema } from "./protocol.js";

type SessionList = z.infer<typeof SessionListSchema>;
import { parseCallResult } from "./session-contract.js";

/**
 * The provider-facing surface of one hosted session. createAgentSessionPort adapts an
 * AgentSession to it inside the host process; the worker only ever sees JSON.
 */
export interface HostedSessionPort {
  /** Performs one validated call other than close; the host checks the result's shape. */
  call(call: Exclude<SessionHostCall, { method: "close" }>): Promise<JsonValue>;
  /** Provider state returned with every attach, as of the newest recorded event. */
  snapshot(): JsonValue;
  subscribe(listener: (event: JsonValue) => void): () => void;
  close(): Promise<void>;
}

export type HostedSessionFactory = (input: {
  provider: string;
  config: JsonValue;
}) => Promise<HostedSessionPort>;

export interface SessionHostLimits {
  /** Unacknowledged events retained per session before reattach must fall back. */
  maxRetainedEvents: number;
  /** Serialized bytes retained per session, for the same fallback. */
  maxRetainedBytes: number;
  /** Serialized bytes retained across all sessions. Past it the oldest events go first. */
  maxTotalRetainedBytes: number;
  maxConnections: number;
  /** An unauthenticated connection is closed after this long. */
  helloTimeoutMs: number;
  /**
   * Live output a worker has not read yet before that connection is dropped. Replay is exempt:
   * it is already bounded by retention, and counting it would drop every large catch-up.
   */
  maxBufferedBytes: number;
  maxFrameBytes: number;
  /**
   * Refused calls and acknowledgements tolerated from one connection, such as a fenced worker
   * retrying in a loop, before it is dropped. Each refusal costs an audit write.
   */
  maxRefusals: number;
  /** Bound on closing each provider session when the host shuts down. */
  closeTimeoutMs: number;
}

const DEFAULT_LIMITS: SessionHostLimits = {
  maxRetainedEvents: 10_000,
  maxRetainedBytes: 32 * 1024 * 1024,
  maxTotalRetainedBytes: 256 * 1024 * 1024,
  maxConnections: 16,
  helloTimeoutMs: 5_000,
  maxBufferedBytes: 2 * MAX_FRAME_BYTES,
  maxFrameBytes: MAX_FRAME_BYTES,
  maxRefusals: 32,
  closeTimeoutMs: 15_000,
};

/** History pages stay well under one frame. */
const HISTORY_PAGE_BYTES = 4 * 1024 * 1024;

/** Room for the event frame envelope around a serialized provider event. */
const EVENT_FRAME_OVERHEAD_BYTES = 1_024;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;

export interface SessionHostOptions {
  socketPath: string;
  /**
   * The capability workers present at hello. A function is resolved only once this host holds
   * the lock and has claimed the socket path, so a host that loses the race to start never
   * replaces the token of the one that won.
   */
  token: string | (() => Promise<string>);
  /** Given to every worker at hello; see the hello reply in the protocol. */
  mcpToken: string;
  openSession: HostedSessionFactory;
  /** Records authentication, attach and detach outcomes. */
  audit?: SessionHostAuditSink;
  /** Reported to workers and the audit log. */
  release?: string;
  limits?: Partial<SessionHostLimits>;
  /**
   * Runs once this host holds the lock and before it listens: work that must never happen while
   * another host serves this directory, such as stopping provider processes a dead host left.
   * A failure here releases the lock and fails the start.
   */
  afterLock?: () => Promise<void>;
}

export interface SessionHost {
  readonly identity: HostIdentity;
  /** Hosted sessions, counting ones still opening, since those already run a provider. */
  sessionCount(): number;
  close(): Promise<void>;
}

interface LoggedEvent {
  seq: number;
  /** Host-wide recording order, so global retention can forget the oldest event first. */
  order: number;
  /** The provider event, serialized once when recorded. */
  json: string;
  bytes: number;
}

interface HostedSessionState {
  provider: string;
  port: HostedSessionPort;
  log: LoggedEvent[];
  retainedBytes: number;
  nextSeq: number;
  /** Events at or below this seq were dropped unacknowledged; replay cannot cover them. */
  truncatedThrough: number;
  /** The current attachment applied events through this seq, so the host forgot them. */
  acknowledgedThrough: number;
  attached: Connection | null;
  /** Set while the provider session closes; it stays attachable so a failed close can retry. */
  closing: boolean;
  unsubscribe: () => void;
}

interface Connection {
  readonly id: string;
  send(reply: SessionHostReply): void;
  /** Counts a refused call or acknowledgement; past the limit the connection is dropped. */
  refused(): void;
  /** Replayed events are exempt from the unread-output limit; live events count toward it. */
  sendEvent(sessionId: string, logged: LoggedEvent, delivery: "live" | "replay"): void;
  destroyed(): boolean;
}

type OutgoingFrame =
  | { kind: "frame"; text: string; bytes: number }
  | { kind: "event"; sessionId: string; logged: LoggedEvent; delivery: "live" | "replay" };

function serializeOutgoing(frame: OutgoingFrame): string {
  if (frame.kind === "frame") return frame.text;
  const { sessionId, logged } = frame;
  return `{"type":"event","sessionId":${JSON.stringify(sessionId)},"seq":${logged.seq},"event":${logged.json}}\n`;
}

function liveBytes(frame: OutgoingFrame): number {
  if (frame.kind === "frame") return frame.bytes;
  return frame.delivery === "live" ? frame.logged.bytes : 0;
}

/**
 * Writes frames in order while respecting socket backpressure. Queued events reference the
 * session log instead of copying it. A worker that stops reading while live output keeps
 * arriving, such as a worker hung in shutdown, is dropped at the limit; its sessions keep running
 * and their retained events wait for the next attachment.
 */
function createOutbox(input: {
  socket: net.Socket;
  maxLiveBytes: number;
  onOverflow(bufferedBytes: number): void;
}): (frame: OutgoingFrame) => void {
  const { socket } = input;
  const queue: OutgoingFrame[] = [];
  let queuedLiveBytes = 0;
  let waitingForDrain = false;

  function flush(): void {
    while (!waitingForDrain && queue.length > 0 && !socket.destroyed) {
      const frame = queue.shift()!;
      queuedLiveBytes -= liveBytes(frame);
      if (!socket.write(serializeOutgoing(frame))) waitingForDrain = true;
    }
  }

  socket.on("drain", () => {
    waitingForDrain = false;
    flush();
  });

  return (frame) => {
    if (socket.destroyed) return;
    queue.push(frame);
    queuedLiveBytes += liveBytes(frame);
    if (queuedLiveBytes > input.maxLiveBytes) {
      input.onOverflow(queuedLiveBytes);
      queue.length = 0;
      socket.destroy();
      return;
    }
    flush();
  };
}

class HostError extends Error {
  constructor(
    readonly code: SessionHostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}

function tokenMatches(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Session host request failed.";
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : message;
}

/** JSON.stringify drops Error fields; keep a provider error's name and message. */
function preserveErrors(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}

function dropped(reason: DroppedEvent["reason"], bytes?: number): string {
  const marker: DroppedEvent = { type: "session_host_event_dropped", reason, bytes };
  return JSON.stringify(marker);
}

/**
 * Owns provider sessions independently of any worker. Sessions keep running when
 * their worker disconnects; a later worker attaches and replays what it missed.
 */
export async function startSessionHost(options: SessionHostOptions): Promise<SessionHost> {
  const limits: SessionHostLimits = { ...DEFAULT_LIMITS, ...options.limits };
  if (limits.maxBufferedBytes < 2 * limits.maxFrameBytes)
    throw new Error("The session host output limit must be at least twice the frame limit.");
  const audit: SessionHostAuditSink = options.audit ?? (() => {});
  const identity: HostIdentity = {
    id: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    release: options.release,
  };
  const sessions = new Map<string, HostedSessionState>();
  /** Session ids whose open is in flight, so a concurrent open cannot leak a second port. */
  const opening = new Set<string>();
  const sockets = new Set<net.Socket>();
  let closing = false;
  /** Set after the lock is held and before the first connection can arrive. */
  let token = "";
  let nextOrder = 1;
  let totalRetainedBytes = 0;

  /** Forgets the oldest retained event; replay and rebuilds below it become unavailable. */
  function forgetOldest(state: HostedSessionState): void {
    const forgotten = state.log.shift();
    if (!forgotten) return;
    state.retainedBytes -= forgotten.bytes;
    totalRetainedBytes -= forgotten.bytes;
    state.truncatedThrough = forgotten.seq;
  }

  function enforceRetention(state: HostedSessionState): void {
    while (
      state.log.length > limits.maxRetainedEvents ||
      state.retainedBytes > limits.maxRetainedBytes
    )
      forgetOldest(state);
    while (totalRetainedBytes > limits.maxTotalRetainedBytes) {
      let oldest: HostedSessionState | null = null;
      for (const candidate of sessions.values()) {
        const head = candidate.log[0];
        if (head && (!oldest || head.order < oldest.log[0]!.order)) oldest = candidate;
      }
      if (!oldest) break;
      forgetOldest(oldest);
    }
  }

  function record(state: HostedSessionState, sessionId: string, event: JsonValue): void {
    let json: string | undefined;
    try {
      json = JSON.stringify(event, preserveErrors);
    } catch {
      json = undefined;
    }
    const seq = state.nextSeq++;
    if (json === undefined) {
      audit({ event: "event_dropped", sessionId, seq, reason: "unserializable" });
      json = dropped("unserializable");
    } else if (Buffer.byteLength(json) > limits.maxFrameBytes - EVENT_FRAME_OVERHEAD_BYTES) {
      audit({ event: "event_dropped", sessionId, seq, reason: "oversized" });
      json = dropped("oversized", Buffer.byteLength(json));
    }
    const logged: LoggedEvent = { seq, order: nextOrder++, json, bytes: Buffer.byteLength(json) };
    state.log.push(logged);
    state.retainedBytes += logged.bytes;
    totalRetainedBytes += logged.bytes;
    enforceRetention(state);
    if (state.attached && !state.attached.destroyed())
      state.attached.sendEvent(sessionId, logged, "live");
  }

  function requireSession(sessionId: string): HostedSessionState {
    const state = sessions.get(sessionId);
    if (!state) throw new HostError("not_found", "This session is not hosted.");
    return state;
  }

  async function open(
    connection: Connection,
    request: Extract<SessionHostRequest, { type: "open" }>,
  ): Promise<AttachResult> {
    if (sessions.has(request.sessionId) || opening.has(request.sessionId))
      throw new HostError("conflict", "This session is already hosted.");
    opening.add(request.sessionId);
    let port: HostedSessionPort;
    try {
      port = await options.openSession({ provider: request.provider, config: request.config });
    } finally {
      opening.delete(request.sessionId);
    }
    if (closing) {
      await port.close().catch(() => {});
      throw new HostError("failed", "The session host is shutting down.");
    }
    const state: HostedSessionState = {
      provider: request.provider,
      port,
      log: [],
      retainedBytes: 0,
      nextSeq: 1,
      truncatedThrough: 0,
      acknowledgedThrough: 0,
      attached: null,
      closing: false,
      unsubscribe: () => {},
    };
    sessions.set(request.sessionId, state);
    state.unsubscribe = port.subscribe((event) => record(state, request.sessionId, event));
    audit({
      event: "open",
      connectionId: connection.id,
      sessionId: request.sessionId,
      provider: request.provider,
    });
    return attachTo(connection, request.sessionId, 0).result;
  }

  /**
   * Validates the replay range and builds the attach result. The caller sends the result and
   * then calls completeAttach in the same tick, so replay precedes every live event.
   */
  function attachTo(
    connection: Connection,
    sessionId: string,
    requestedAfterSeq: number | null,
  ): { result: AttachResult; afterSeq: number } {
    const state = requireSession(sessionId);
    const lastSeq = state.nextSeq - 1;
    // Null attaches at the newest event: no replay, so nothing missed can be refused.
    const afterSeq = requestedAfterSeq ?? lastSeq;
    const replayFloor = Math.max(state.truncatedThrough, state.acknowledgedThrough);
    if (requestedAfterSeq !== null && (afterSeq < replayFloor || afterSeq > lastSeq)) {
      audit({
        event: "attach_refused",
        connectionId: connection.id,
        sessionId,
        afterSeq,
        lastSeq,
        reason: "replay_unavailable",
      });
      throw new HostError(
        "replay_unavailable",
        "Events this worker missed are no longer retained. Fall back to restart continuation.",
      );
    }
    return {
      result: { provider: state.provider, lastSeq, snapshot: state.port.snapshot() },
      afterSeq,
    };
  }

  function completeAttach(connection: Connection, sessionId: string, afterSeq: number): void {
    const state = sessions.get(sessionId);
    if (!state || connection.destroyed()) return;
    let replayed = 0;
    for (const logged of state.log)
      if (logged.seq > afterSeq) {
        connection.sendEvent(sessionId, logged, "replay");
        replayed += 1;
      }
    const previous = state.attached;
    state.attached = connection;
    audit({
      event: "attach",
      connectionId: connection.id,
      sessionId,
      afterSeq,
      lastSeq: state.nextSeq - 1,
      replayed,
    });
    if (previous && previous !== connection && !previous.destroyed()) {
      previous.send({ type: "detached", sessionId });
      audit({ event: "fenced", connectionId: previous.id, sessionId, by: connection.id });
    }
  }

  async function call(
    connection: Connection,
    sessionId: string,
    request: SessionHostCall,
  ): Promise<JsonValue> {
    const state = requireSession(sessionId);
    if (state.attached !== connection) {
      audit({
        event: "call_refused",
        connectionId: connection.id,
        sessionId,
        method: request.method,
        reason: "not_attached",
      });
      connection.refused();
      throw new HostError("not_attached", "Attach to this session before driving it.");
    }
    if (state.closing) throw new HostError("failed", "This session is closing.");
    if (request.method !== "close") {
      const checked = parseCallResult(request.method, await state.port.call(request));
      if (!checked.success)
        throw new HostError("failed", `The provider returned an invalid ${request.method} result.`);
      return checked.data as JsonValue;
    }
    switch (request.method) {
      case "close":
        // Events emitted while closing, such as a canceled turn, are still recorded. A failed
        // close leaves the session hosted so the provider process is never orphaned.
        state.closing = true;
        try {
          await state.port.close();
        } catch (error) {
          state.closing = false;
          audit({ event: "close_failed", connectionId: connection.id, sessionId });
          throw error;
        }
        removeSession(sessionId, state);
        audit({ event: "session_closed", connectionId: connection.id, sessionId });
        return null;
    }
  }

  function acknowledge(connection: Connection, sessionId: string, seq: number): void {
    const state = sessions.get(sessionId);
    // A fenced worker must not make the current one lose replay coverage.
    if (!state || state.attached !== connection || seq > state.nextSeq - 1) {
      audit({ event: "ack_refused", connectionId: connection.id, sessionId, seq });
      connection.refused();
      return;
    }
    // Acknowledged events stay retained: a later worker rebuilds its timeline from them.
    state.acknowledgedThrough = Math.max(state.acknowledgedThrough, seq);
  }

  /** Pages retained events in (afterSeq, throughSeq] to the session's current attachment. */
  function history(
    connection: Connection,
    request: Extract<SessionHostRequest, { type: "history" }>,
  ): LoggedHistoryPage {
    const state = requireSession(request.sessionId);
    if (state.attached !== connection) {
      connection.refused();
      throw new HostError("not_attached", "Attach to this session before reading its history.");
    }
    const events: LoggedHistoryPage["events"] = [];
    let bytes = 0;
    let nextAfterSeq = request.afterSeq;
    let more = false;
    for (const logged of state.log) {
      if (logged.seq <= request.afterSeq) continue;
      if (logged.seq > request.throughSeq) break;
      if (events.length > 0 && bytes + logged.bytes > HISTORY_PAGE_BYTES) {
        more = true;
        break;
      }
      events.push({ seq: logged.seq, event: JSON.parse(logged.json) as JsonValue });
      bytes += logged.bytes;
      nextAfterSeq = logged.seq;
    }
    return { events, nextAfterSeq, more, truncatedThrough: state.truncatedThrough };
  }

  /**
   * Every hosted session for a starting worker. Snapshots that would push the reply past one
   * frame are left out; the worker then attaches those sessions and gets their state from the
   * attach result.
   */
  function list(): SessionList {
    let budget = limits.maxFrameBytes / 2;
    return {
      sessions: [...sessions].map(([sessionId, state]) => {
        let snapshot: JsonValue = state.port.snapshot();
        const bytes = Buffer.byteLength(JSON.stringify(snapshot));
        if (bytes > budget) snapshot = null;
        else budget -= bytes;
        return {
          sessionId,
          provider: state.provider,
          lastSeq: state.nextSeq - 1,
          attached: state.attached !== null && !state.attached.destroyed(),
          snapshot,
        };
      }),
    };
  }

  function removeSession(sessionId: string, state: HostedSessionState): void {
    state.unsubscribe();
    sessions.delete(sessionId);
    totalRetainedBytes -= state.retainedBytes;
    state.log = [];
    state.retainedBytes = 0;
  }

  function serve(socket: net.Socket): void {
    const connectionId = randomUUID();
    if (closing || sockets.size >= limits.maxConnections) {
      audit({ event: "connection_refused", connectionId, reason: closing ? "closing" : "limit" });
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let phase: "greeting" | "ready" | "rejected" = "greeting";
    let selfProbe = false;

    const push = createOutbox({
      socket,
      maxLiveBytes: limits.maxBufferedBytes,
      onOverflow: (bufferedBytes) => audit({ event: "backpressure", connectionId, bufferedBytes }),
    });

    let refusals = 0;
    const connection: Connection = {
      id: connectionId,
      refused: () => {
        refusals += 1;
        if (refusals <= limits.maxRefusals || socket.destroyed) return;
        audit({ event: "refusal_limit", connectionId, refusals });
        socket.destroy();
      },
      send: (frame) => {
        const text = `${JSON.stringify(frame)}\n`;
        push({ kind: "frame", text, bytes: Buffer.byteLength(text) });
      },
      sendEvent: (sessionId, logged, delivery) =>
        push({ kind: "event", sessionId, logged, delivery }),
      destroyed: () => socket.destroyed,
    };

    function fail(requestId: string | null, error: unknown): void {
      connection.send({
        type: "error",
        requestId,
        code: error instanceof HostError ? error.code : "failed",
        message: errorMessage(error),
      });
    }

    /**
     * Connection-level failures end the connection after one error frame. Later frames are
     * ignored, and a peer that never reads cannot hold the socket open.
     */
    function reject(
      code: SessionHostErrorCode,
      message: string,
      reason: string,
      detail: { protocolVersion?: number } = {},
    ): void {
      if (phase === "rejected") return;
      audit({
        event: phase === "ready" ? "frame_rejected" : "hello_rejected",
        connectionId,
        reason,
        ...detail,
      });
      phase = "rejected";
      fail(null, new HostError(code, message));
      socket.end();
      setTimeout(() => socket.destroy(), 1_000).unref();
    }

    const helloTimer = setTimeout(() => {
      if (phase !== "greeting") return;
      audit({ event: "hello_rejected", connectionId, reason: "hello_timeout" });
      phase = "rejected";
      socket.destroy();
    }, limits.helloTimeoutMs);
    helloTimer.unref();

    function greet(frame: unknown): void {
      const envelope = HelloEnvelopeSchema.safeParse(frame);
      if (!envelope.success) {
        reject("unauthorized", "Say hello before using the session host.", "no_hello");
        return;
      }
      if (!tokenMatches(token, envelope.data.token)) {
        reject("unauthorized", "Session host token rejected.", "unauthorized");
        return;
      }
      if (envelope.data.protocolVersion !== SESSION_HOST_PROTOCOL_VERSION) {
        // The peer's version tells the service whether a newer worker is waiting for an upgrade.
        reject("version", "Session host protocol version differs.", "version", {
          protocolVersion: envelope.data.protocolVersion,
        });
        return;
      }
      const hello = HelloRequestSchema.safeParse(frame);
      if (!hello.success) {
        reject("invalid_frame", "Malformed session host hello.", "invalid_frame");
        return;
      }
      phase = "ready";
      clearTimeout(helloTimer);
      reader.setMaxFrameBytes(limits.maxFrameBytes);
      // The watchdog's liveness probe greets as this process every few seconds and never
      // attaches; recording each one would bury the attach history the audit log is for.
      selfProbe =
        hello.data.client.pid === process.pid && hello.data.client.release === SELF_PROBE_RELEASE;
      if (!selfProbe)
        audit({
          event: "hello_accepted",
          connectionId,
          clientPid: hello.data.client.pid,
          clientRelease: hello.data.client.release,
        });
      connection.send({
        type: "hello",
        protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
        host: identity,
        mcpToken: options.mcpToken,
      });
    }

    /** Answers a synchronous request, turning a failure into an error frame. */
    function answer(requestId: string, produce: () => JsonValue): void {
      let value: JsonValue;
      try {
        value = produce();
      } catch (error) {
        fail(requestId, error);
        return;
      }
      connection.send({ type: "result", requestId, value });
    }

    async function openAndAttach(
      request: Extract<SessionHostRequest, { type: "open" }>,
    ): Promise<void> {
      let result: AttachResult;
      try {
        result = await open(connection, request);
      } catch (error) {
        audit({
          event: "open_failed",
          connectionId,
          sessionId: request.sessionId,
          reason: error instanceof HostError ? error.code : "failed",
        });
        fail(request.requestId, error);
        return;
      }
      connection.send({ type: "result", requestId: request.requestId, value: result });
      completeAttach(connection, request.sessionId, 0);
    }

    function dispatch(request: SessionHostRequest): void {
      switch (request.type) {
        case "ack":
          acknowledge(connection, request.sessionId, request.seq);
          return;
        case "release": {
          const state = sessions.get(request.sessionId);
          if (state?.attached === connection) {
            state.attached = null;
            audit({ event: "released", connectionId, sessionId: request.sessionId });
          }
          return;
        }
        case "history":
        case "list":
          answer(request.requestId, () =>
            request.type === "list" ? list() : history(connection, request),
          );
          return;
        case "attach": {
          let attached: { result: AttachResult; afterSeq: number };
          try {
            attached = attachTo(connection, request.sessionId, request.afterSeq);
          } catch (error) {
            if (error instanceof HostError && error.code === "not_found")
              audit({
                event: "attach_refused",
                connectionId,
                sessionId: request.sessionId,
                reason: "not_found",
              });
            fail(request.requestId, error);
            return;
          }
          connection.send({ type: "result", requestId: request.requestId, value: attached.result });
          completeAttach(connection, request.sessionId, attached.afterSeq);
          return;
        }
        case "open":
          void openAndAttach(request);
          return;
        case "call":
          void call(connection, request.sessionId, request.call).then(
            (value) => connection.send({ type: "result", requestId: request.requestId, value }),
            (error: unknown) => fail(request.requestId, error),
          );
          return;
      }
    }

    const reader = readFrames(socket, {
      maxFrameBytes: MAX_HELLO_FRAME_BYTES,
      onOversize: () => reject("invalid_frame", "Session host frame is too large.", "oversize"),
      onFrame: (line) => {
        if (phase === "rejected") return;
        const frame = parseJson(line);
        if (phase === "greeting") {
          greet(frame);
          return;
        }
        const parsed = SessionHostRequestSchema.safeParse(frame);
        if (!parsed.success) {
          reject("invalid_frame", "Malformed session host frame.", "invalid_frame");
          return;
        }
        dispatch(parsed.data);
      },
    });

    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(helloTimer);
      sockets.delete(socket);
      // Sessions deliberately outlive their worker. Only the attachment is released.
      let released = 0;
      for (const state of sessions.values())
        if (state.attached === connection) {
          state.attached = null;
          released += 1;
        }
      if ((phase === "ready" && !selfProbe) || released > 0)
        audit({ event: "disconnected", connectionId, released });
    });
  }

  // The directory is the access boundary, so refuse to listen anywhere less private.
  await preparePrivateDirectory(path.dirname(options.socketPath));
  const lock = await acquireHostLock(options.socketPath);
  const server = net.createServer(serve);
  try {
    await options.afterLock?.();
    await claimSocketPath(options.socketPath);
    token = typeof options.token === "string" ? options.token : await options.token();
    await withPrivateUmask(async () => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      // The private directory is the access boundary; this keeps the socket private as well.
      await chmod(options.socketPath, 0o600);
    });
  } catch (error) {
    server.close();
    await lock.release();
    throw error;
  }
  server.on("error", (error) => audit({ event: "server_error", message: errorMessage(error) }));
  audit({ event: "host_started", hostId: identity.id, pid: identity.pid });

  return {
    identity,
    sessionCount: () => sessions.size + opening.size,
    async close() {
      if (closing) return;
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // A provider that cannot exit must not keep the host from exiting.
      await Promise.all(
        [...sessions].map(async ([sessionId, state]) => {
          removeSession(sessionId, state);
          const outcome = await settleWithin(state.port.close(), limits.closeTimeoutMs);
          if (outcome !== "closed") audit({ event: `close_${outcome}`, sessionId });
        }),
      );
      await lock.release();
      audit({ event: "host_stopped", hostId: identity.id });
    },
  };
}

/** Hosts in this process currently binding, and the mask to restore when the last one is done. */
let privateUmaskUsers = 0;
let restoreUmask = 0;

/**
 * Applies a 077 umask only while the socket is created, so it is never briefly reachable with
 * looser permissions. The mask is process-wide and provider processes inherit it, so it is
 * restored before any provider can start; a counter keeps concurrent binds from restoring early.
 */
async function withPrivateUmask<T>(operation: () => Promise<T>): Promise<T> {
  if (privateUmaskUsers === 0) restoreUmask = process.umask(0o077);
  privateUmaskUsers += 1;
  try {
    return await operation();
  } finally {
    privateUmaskUsers -= 1;
    if (privateUmaskUsers === 0) process.umask(restoreUmask);
  }
}

async function settleWithin(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<"closed" | "failed" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([
      operation.then(
        () => "closed" as const,
        () => "failed" as const,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
