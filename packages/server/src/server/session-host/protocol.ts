import { z } from "zod";
import { SessionCallSchema } from "./session-contract.js";

export type { SessionHostCall } from "./session-contract.js";

/** Bumped on any incompatible frame change. A worker never attaches across versions. */
export const SESSION_HOST_PROTOCOL_VERSION = 1;

/**
 * Largest newline-delimited frame either side accepts after authentication. Prompts can carry
 * images and events can carry tool output. The host's unread-output limit must stay at least
 * twice this, so one large event cannot drop a healthy worker.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** An unauthenticated peer may send only one small hello frame. */
export const MAX_HELLO_FRAME_BYTES = 4 * 1024;

const IdSchema = z.string().min(1).max(200);
const JsonSchema = z.json();
const SeqSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Free-form identity text for the audit log, never used for authorization. */
const LabelSchema = z.string().max(200);

export const SessionHostErrorCodeSchema = z.enum([
  /** Missing or wrong token, or a frame before hello. The host closes the connection. */
  "unauthorized",
  /** The peer speaks another protocol version. The host closes the connection. */
  "version",
  /** Malformed or oversized frame. The host closes the connection. */
  "invalid_frame",
  /** The session is not hosted, for example because the host restarted. */
  "not_found",
  /** Events after the requested seq were dropped. Fall back to restart continuation. */
  "replay_unavailable",
  /** The caller is not the session's current attachment, so it must stop driving it. */
  "not_attached",
  /** A session with this id is already hosted or opening. */
  "conflict",
  /** The provider operation failed. */
  "failed",
]);
export type SessionHostErrorCode = z.infer<typeof SessionHostErrorCodeSchema>;

/**
 * Every hello starts with these fields in every protocol version, so a host can refuse a
 * mismatched peer with a clear version error instead of a schema failure.
 */
export const HelloEnvelopeSchema = z.looseObject({
  type: z.literal("hello"),
  protocolVersion: z.number().int(),
  token: z.string().min(1).max(512),
});

export const HelloRequestSchema = z
  .object({
    type: z.literal("hello"),
    protocolVersion: z.literal(SESSION_HOST_PROTOCOL_VERSION),
    token: z.string().min(1).max(512),
    /** Reported by the worker for the audit log only. */
    client: z
      .object({
        pid: z.number().int().positive(),
        release: LabelSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type HelloRequest = z.infer<typeof HelloRequestSchema>;

/** Frames a worker sends after a successful hello. */
export const SessionHostRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("open"),
      requestId: IdSchema,
      sessionId: IdSchema,
      provider: IdSchema,
      config: JsonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("attach"),
      requestId: IdSchema,
      sessionId: IdSchema,
      /** Replays every retained event after this seq. Null attaches at the newest event. */
      afterSeq: SeqSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("call"),
      requestId: IdSchema,
      sessionId: IdSchema,
      call: SessionCallSchema,
    })
    .strict(),
  /**
   * The worker has durably applied events through seq. Live replay never starts below it again;
   * the events stay retained so a later worker can rebuild the same timeline.
   */
  z.object({ type: z.literal("ack"), sessionId: IdSchema, seq: SeqSchema }).strict(),
  /** Retained events in (afterSeq, throughSeq], paged, for the attached worker's rebuild. */
  z
    .object({
      type: z.literal("history"),
      requestId: IdSchema,
      sessionId: IdSchema,
      afterSeq: SeqSchema,
      throughSeq: SeqSchema,
    })
    .strict(),
  /** Every hosted session, so a starting worker can decide which ones to attach. */
  z.object({ type: z.literal("list"), requestId: IdSchema }).strict(),
  /** The worker lets go of a session it attached but will not drive; the session keeps running. */
  z.object({ type: z.literal("release"), sessionId: IdSchema }).strict(),
]);
export type SessionHostRequest = z.infer<typeof SessionHostRequestSchema>;

/** Identifies one run of the host process. A new id means every earlier session is gone. */
export const HostIdentitySchema = z
  .object({
    id: IdSchema,
    pid: z.number().int().positive(),
    startedAt: z.string().max(64),
    release: LabelSchema.optional(),
  })
  .strict();
export type HostIdentity = z.infer<typeof HostIdentitySchema>;

/**
 * Stands in for a provider event the host could not deliver, so seqs stay contiguous and the
 * worker learns that something is missing instead of silently skipping it.
 */
export const DroppedEventSchema = z
  .object({
    type: z.literal("session_host_event_dropped"),
    reason: z.enum(["oversized", "unserializable"]),
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type DroppedEvent = z.infer<typeof DroppedEventSchema>;

export const AttachResultSchema = z
  .object({
    provider: IdSchema,
    lastSeq: SeqSchema,
    /** Provider state as of lastSeq, which the worker mirrors. */
    snapshot: JsonSchema,
  })
  .strict();
export type AttachResult = z.infer<typeof AttachResultSchema>;

export const LoggedHistoryPageSchema = z
  .object({
    events: z.array(z.object({ seq: SeqSchema.positive(), event: JsonSchema }).strict()),
    /** Ask again from here while more is true. */
    nextAfterSeq: SeqSchema,
    more: z.boolean(),
    /** Events at or below this seq were dropped by retention, so a rebuild from them is lossy. */
    truncatedThrough: SeqSchema,
  })
  .strict();
export type LoggedHistoryPage = z.infer<typeof LoggedHistoryPageSchema>;

export const HostedSessionSummarySchema = z
  .object({
    sessionId: IdSchema,
    provider: IdSchema,
    lastSeq: SeqSchema,
    /** True while some worker connection is attached. */
    attached: z.boolean(),
    snapshot: JsonSchema,
  })
  .strict();
export type HostedSessionSummary = z.infer<typeof HostedSessionSummarySchema>;

export const SessionListSchema = z
  .object({ sessions: z.array(HostedSessionSummarySchema).max(10_000) })
  .strict();

export const SessionHostReplySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      protocolVersion: z.number().int(),
      host: HostIdentitySchema,
      /**
       * Bearer token for the worker's agent tool endpoint. Hosted providers keep it for the host's
       * lifetime, so every worker that attaches must accept it. Rotates with each host start.
       */
      mcpToken: z.string().min(1).max(512),
    })
    .strict(),
  z.object({ type: z.literal("result"), requestId: IdSchema, value: JsonSchema }).strict(),
  z
    .object({
      type: z.literal("error"),
      /** Null only for connection-level errors, which the host follows by closing the socket. */
      requestId: IdSchema.nullable(),
      code: SessionHostErrorCodeSchema,
      message: z.string().max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      sessionId: IdSchema,
      seq: SeqSchema.positive(),
      event: JsonSchema,
    })
    .strict(),
  /** A newer attachment took this session; the receiving worker must stop driving it. */
  z.object({ type: z.literal("detached"), sessionId: IdSchema }).strict(),
]);
export type SessionHostReply = z.infer<typeof SessionHostReplySchema>;
