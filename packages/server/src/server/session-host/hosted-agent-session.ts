import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  AgentCapabilityFlags,
  AgentFeature,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProviderNotice,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentUsageSession,
  SteerActiveTurnOptions,
  SteerResult,
} from "../agent/agent-sdk-types.js";
import { runProviderTurn } from "../agent/providers/provider-runner.js";
import type { AppliedSeqStore } from "./applied-store.js";
import type { HostedSession, HostedSessionDetachReason } from "./client.js";
import { DroppedEventSchema } from "./protocol.js";
import {
  HostedPortEventSchema,
  HostedSessionSnapshotSchema,
  HostedStreamEventSchema,
  parseCallResult,
  type HostedSessionSnapshot,
  type SessionCallResult,
  type SessionHostCall,
  type SessionHostMethod,
} from "./session-contract.js";

/** Acknowledgements are batched; the host only needs the latest applied seq. */
const ACK_INTERVAL_MS = 250;
/** Events held for a manager that has not subscribed yet, such as replay right after attach. */
const MAX_HELD_EVENTS = 10_000;

export type HostedSessionUnavailableReason = "fenced" | "lost" | "closed";

const UNAVAILABLE_MESSAGES: Record<HostedSessionUnavailableReason, string> = {
  fenced: "Another worker now drives this session.",
  lost: "The session host no longer runs this session.",
  closed: "This session is closed.",
};

export class HostedSessionUnavailableError extends Error {
  constructor(readonly reason: HostedSessionUnavailableReason) {
    super(UNAVAILABLE_MESSAGES[reason]);
    this.name = "HostedSessionUnavailableError";
  }
}

export class HostedSessionResultError extends Error {
  constructor(readonly method: string) {
    super(`The session host returned an invalid result for ${method}.`);
    this.name = "HostedSessionResultError";
  }
}

/** A new attachment after the connection dropped; lossy when some events could not be replayed. */
export interface HostedReattachment {
  channel: HostedSession;
  lossy: boolean;
}

/** The host could not be reached or did not finish the attach yet; trying again may succeed. */
export class HostedReattachPendingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HostedReattachPendingError";
  }
}

/**
 * How long a dropped session keeps trying to reattach before it is treated as lost. A slow or
 * briefly saturated host must not fail a turn its provider is still running.
 */
export interface HostedReattachPolicy {
  windowMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_REATTACH_POLICY: HostedReattachPolicy = {
  windowMs: 60_000,
  initialDelayMs: 250,
  maxDelayMs: 5_000,
};

export interface HostedAgentSessionOptions {
  /** The provider the host runs, before any registry relabeling. */
  provider: string;
  capabilities: AgentCapabilityFlags;
  channel: HostedSession;
  /**
   * Attaches again from afterSeq. Null when the host no longer runs the session; a
   * HostedReattachPendingError when it might still answer.
   */
  reattach(afterSeq: number): Promise<HostedReattachment | null>;
  reattachPolicy?: HostedReattachPolicy;
  /**
   * Usage plugins read the provider environment synchronously. The worker builds it from the
   * same settings it sent to the host, so credentials never travel back from the host.
   */
  usage: { model?: string; env: Record<string, string> };
  /**
   * Where this worker records the last event it applied. The record is written before the host
   * hears about it, so a later worker never treats an unapplied event as applied.
   */
  applied?: { store: AppliedSeqStore; agentId: string; hostId: string };
  /**
   * Set when this worker adopts a session another worker was driving. History is rebuilt from
   * the provider's saved history plus logged events through throughSeq, and later events are held
   * until that history has been read, so no row appears twice.
   */
  rebuild?: { throughSeq: number; lossy: boolean };
  logger: Logger;
}

type CallOf<M extends SessionHostMethod> = Extract<SessionHostCall, { method: M }>;

/** An event waiting for the manager, with the seq it settles; null for worker-made notices. */
interface HeldEntry {
  event: AgentStreamEvent | null;
  seq: number | null;
}

/** Plain JSON for a call argument; the host validates its shape. */
function asJson<T>(value: unknown): T {
  return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as T;
}

/** Saved history carries rows, not lifecycle: the snapshot restores turn and permission state. */
function isHistoryEvent(event: AgentStreamEvent): boolean {
  return event.type === "timeline" || event.type === "provider_subagent";
}

/**
 * Drives a provider session that runs in the session host. It mirrors the state the agent
 * manager reads synchronously, delivers provider events in host order and reattaches when the
 * connection drops, so a worker restart or reconnect does not end the provider's turn.
 *
 * Not hostable, so deliberately absent: goals, initialTimeline, quota observation and admission
 * guards, and out-of-band commands. The Claude adapter implements none of them, and quota-governed
 * sessions are never opened in the host.
 */
export class HostedAgentSession implements AgentSession {
  readonly provider: string;
  readonly capabilities: AgentCapabilityFlags;

  private channel: HostedSession;
  private snapshot: HostedSessionSnapshot;
  /** State entries at or below this seq are already reflected in the snapshot. */
  private snapshotSeq: number;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  /** Events waiting for a first subscriber or, when adopted, for the rebuilt history. */
  private held: HeldEntry[] = [];
  private everSubscribed = false;
  private liveHeld: boolean;
  /** The turn running as of the rebuilt history, from its logged lifecycle events. */
  private rebuiltActiveTurnId: string | null | undefined;
  private status: "attached" | "reattaching" | HostedSessionUnavailableReason = "attached";
  private recovery: Promise<void> | null = null;
  private unsubscribeChannel: () => void = () => {};
  private historyRead = false;
  private model: string | undefined;
  private readonly usageSessionKey = randomUUID();
  /** Every entry at or below this seq has been applied, in order. */
  private appliedSeq: number;
  private ackedSeq: number;
  private ackTimer: NodeJS.Timeout | null = null;
  /** One lossy notice per attachment, however many events it lost. */
  private lossyNoticeShown = false;
  /** Set when the held buffer overflowed, so its flush starts with a lossy notice. */
  private heldOverflowed = false;
  /** Wakes a reattach backoff early, for close(). */
  private wakeRecovery: (() => void) | null = null;
  /** An interrupt asked for while reattaching, sent once the session is attached again. */
  private interruptPending = false;

  constructor(private readonly options: HostedAgentSessionOptions) {
    this.provider = options.provider;
    this.capabilities = options.capabilities;
    this.model = options.usage.model;
    this.channel = options.channel;
    this.snapshot = HostedSessionSnapshotSchema.parse(options.channel.attach.snapshot);
    this.snapshotSeq = options.channel.attach.lastSeq;
    this.liveHeld = options.rebuild !== undefined;
    this.appliedSeq = options.rebuild?.throughSeq ?? 0;
    this.ackedSeq = this.appliedSeq;
    this.bind(options.channel);
  }

  get id(): string | null {
    return this.snapshot.id;
  }

  get features(): AgentFeature[] {
    return this.snapshot.features as unknown as AgentFeature[];
  }

  /** The session's current host-side status, for diagnostics and restart readiness. */
  get hostedStatus(): HostedAgentSession["status"] {
    return this.status;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return this.snapshot.pendingPermissions as AgentPermissionRequest[];
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.snapshot.persistence as AgentPersistenceHandle | null;
  }

  usageSession(): AgentUsageSession | null {
    if (this.status === "closed" || this.status === "lost") return null;
    return {
      provider: this.provider,
      model: this.model,
      env: this.options.usage.env,
      sessionKey: this.usageSessionKey,
    };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    this.everSubscribed = true;
    this.flushHeld();
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Lets held live events through. Reading the rebuilt history does this; the startup path also
   * calls it when loading an adopted agent finished or failed, so events are never held forever.
   */
  releaseLive(): void {
    if (!this.liveHeld) return;
    this.liveHeld = false;
    this.flushHeld();
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (nextPrompt, nextOptions) => this.startTurn(nextPrompt, nextOptions),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.id ?? "",
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    const call: CallOf<"startTurn"> = {
      method: "startTurn",
      prompt: asJson<CallOf<"startTurn">["prompt"]>(prompt),
      ...(options ? { options: asJson<CallOf<"startTurn">["options"]>(options) } : {}),
    };
    return this.invoke(call);
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    const call: CallOf<"steerActiveTurn"> = {
      method: "steerActiveTurn",
      prompt: asJson<CallOf<"steerActiveTurn">["prompt"]>(prompt),
      options: asJson<CallOf<"steerActiveTurn">["options"]>(options),
    };
    return this.invoke(call);
  }

  async interrupt(): Promise<void> {
    // A lost or closed session has nothing left to interrupt.
    if (this.status === "lost" || this.status === "closed" || this.status === "fenced") return;
    if (this.status === "reattaching") {
      // Do not hold a stop button for the whole reconnect window; deliver it on reattach.
      this.interruptPending = true;
      return;
    }
    await this.invoke({ method: "interrupt" });
  }

  async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    const call: CallOf<"respondToPermission"> = {
      method: "respondToPermission",
      requestId,
      response: asJson<CallOf<"respondToPermission">["response"]>(response),
    };
    const result = await this.invoke(call);
    return (result ?? undefined) as AgentPermissionResult | undefined;
  }

  streamHistory(): AsyncGenerator<AgentStreamEvent> {
    return this.readHistory();
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return (await this.invoke({ method: "getRuntimeInfo" })) as AgentRuntimeInfo;
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return (await this.invoke({ method: "getAvailableModes" })) as AgentMode[];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.invoke({ method: "getCurrentMode" });
  }

  async setMode(modeId: string): Promise<void | AgentProviderNotice> {
    const notice = await this.invoke({ method: "setMode", modeId });
    return (notice ?? undefined) as AgentProviderNotice | undefined;
  }

  async setModel(modelId: string | null): Promise<void> {
    await this.invoke({ method: "setModel", modelId });
    this.model = modelId ?? undefined;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void | AgentProviderNotice> {
    const notice = await this.invoke({ method: "setThinkingOption", thinkingOptionId });
    return (notice ?? undefined) as AgentProviderNotice | undefined;
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    await this.invoke({ method: "setFeature", featureId, value: asJson<JsonValue>(value) });
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return (await this.invoke({ method: "listCommands" })) as AgentSlashCommand[];
  }

  async revertConversation(input: { messageId: string }): Promise<void> {
    await this.invoke({ method: "revertConversation", messageId: input.messageId });
  }

  async revertFiles(input: { messageId: string }): Promise<void> {
    await this.invoke({ method: "revertFiles", messageId: input.messageId });
  }

  async revertBoth(input: { messageId: string }): Promise<void> {
    await this.invoke({ method: "revertBoth", messageId: input.messageId });
  }

  async close(): Promise<void> {
    if (this.status === "closed") return;
    const attached = this.status === "attached";
    try {
      // While reattaching, the recovery closes the host session if it gets an attachment back.
      if (attached) await this.invoke({ method: "close" });
      await this.forgetApplied();
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Closing a hosted session did not finish; the host may still run it until the next worker start",
      );
      throw error;
    } finally {
      this.status = "closed";
      this.wakeRecovery?.();
      this.unsubscribeChannel();
      this.subscribers.clear();
      this.held = [];
    }
  }

  private async *readHistory(): AsyncGenerator<AgentStreamEvent> {
    // Like the provider itself, saved history is yielded once per session object.
    if (this.historyRead) return;
    this.historyRead = true;
    let complete = false;
    try {
      yield* this.readProviderHistory();
      if (this.options.rebuild) yield* this.readLoggedHistory(this.options.rebuild);
      complete = true;
    } finally {
      // A failed read can be retried; the manager collects history before it appends rows.
      if (!complete) this.historyRead = false;
      this.releaseLive();
    }
  }

  private async *readProviderHistory(): AsyncGenerator<AgentStreamEvent> {
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: SessionCallResult<"streamHistory"> = await this.invoke({
        method: "streamHistory",
        cursor,
      });
      for (const event of page.events) {
        if (HostedStreamEventSchema.safeParse(event).success)
          yield event as unknown as AgentStreamEvent;
        else this.options.logger.warn("Skipped a malformed history event from the session host");
      }
      cursor = page.nextCursor;
    }
  }

  /** The events the previous worker already showed, read back from the host's log. */
  private async *readLoggedHistory(rebuild: {
    throughSeq: number;
    lossy: boolean;
  }): AsyncGenerator<AgentStreamEvent> {
    let activeTurnId: string | null = null;
    let afterSeq = 0;
    let lossy = rebuild.lossy;
    while (afterSeq < rebuild.throughSeq) {
      const page = await this.channel.history({ afterSeq, throughSeq: rebuild.throughSeq });
      if (!lossy && page.truncatedThrough > 0) {
        lossy = true;
        yield this.historyNotice();
      }
      for (const entry of page.events) {
        const parsed = HostedPortEventSchema.safeParse(entry.event);
        if (!parsed.success || parsed.data.type !== "stream") continue;
        if (!HostedStreamEventSchema.safeParse(parsed.data.event).success) continue;
        const event = parsed.data.event as unknown as AgentStreamEvent;
        if (event.type === "turn_started") activeTurnId = event.turnId ?? activeTurnId;
        if (
          (event.type === "turn_completed" ||
            event.type === "turn_failed" ||
            event.type === "turn_canceled") &&
          (event.turnId === undefined || event.turnId === activeTurnId)
        )
          activeTurnId = null;
        if (isHistoryEvent(event)) yield event;
      }
      if (!page.more) break;
      afterSeq = page.nextAfterSeq;
    }
    if (rebuild.lossy && !lossy) yield this.historyNotice();
    this.rebuiltActiveTurnId = activeTurnId;
  }

  private historyNotice(): AgentStreamEvent {
    return {
      type: "timeline",
      provider: this.provider,
      item: {
        type: "notification",
        level: "warning",
        message: "Some earlier activity from this session could not be restored after a restart.",
      },
    };
  }

  private async invoke<M extends SessionHostMethod>(
    call: CallOf<M>,
  ): Promise<SessionCallResult<M>> {
    if (this.recovery) await this.recovery;
    const status = this.status;
    if (status === "reattaching") throw new HostedSessionUnavailableError("lost");
    if (status !== "attached") throw new HostedSessionUnavailableError(status);
    const value = await this.channel.call(call);
    const result = parseCallResult(call.method as M, value);
    if (!result.success) throw new HostedSessionResultError(call.method);
    return result.data;
  }

  private bind(channel: HostedSession): void {
    this.unsubscribeChannel();
    this.channel = channel;
    this.lossyNoticeShown = false;
    this.unsubscribeChannel = channel.subscribe((value, seq) => this.accept(value, seq));
    channel.onDetached((reason) => this.handleDetached(channel, reason));
  }

  private accept(value: JsonValue, seq: number): void {
    this.emit(this.interpret(value, seq), seq);
  }

  /** Applies state entries to the mirror and turns everything else into an event, or nothing. */
  private interpret(value: JsonValue, seq: number): AgentStreamEvent | null {
    if (DroppedEventSchema.safeParse(value).success) return this.lossyNotice();
    const entry = HostedPortEventSchema.safeParse(value);
    if (!entry.success) {
      this.options.logger.warn({ seq }, "Skipped a malformed entry from the session host");
      return this.lossyNotice();
    }
    if (entry.data.type === "state") {
      if (seq > this.snapshotSeq) {
        this.snapshot = entry.data.snapshot;
        this.snapshotSeq = seq;
      }
      return null;
    }
    if (HostedStreamEventSchema.safeParse(entry.data.event).success)
      return entry.data.event as unknown as AgentStreamEvent;
    this.options.logger.warn({ seq }, "Skipped a malformed event from the session host");
    return this.lossyNotice();
  }

  private holding(): boolean {
    return this.liveHeld || !this.everSubscribed;
  }

  /** Delivers an event in order, or holds it; seq marks how far this worker has applied. */
  private emit(event: AgentStreamEvent | null, seq: number | null): void {
    if (this.holding()) {
      this.held.push({ event, seq });
      if (this.held.length > MAX_HELD_EVENTS) {
        this.held.shift();
        this.heldOverflowed = true;
      }
      return;
    }
    if (event) this.deliver(event);
    if (seq !== null) this.markApplied(seq);
  }

  private flushHeld(): void {
    if (this.holding()) return;
    const held = this.held;
    this.held = [];
    if (this.heldOverflowed) {
      this.heldOverflowed = false;
      const notice = this.lossyNotice();
      if (notice) this.deliver(notice);
    }
    this.resumeTurnIfRunning(held);
    for (const entry of held) {
      if (entry.event) this.deliver(entry.event);
      if (entry.seq !== null) this.markApplied(entry.seq);
    }
  }

  /**
   * A fresh worker registers an adopted session as idle. If a turn was running where the rebuilt
   * history ends, announce it before the held events, so its completion is handled as usual.
   */
  private resumeTurnIfRunning(held: HeldEntry[]): void {
    if (!this.options.rebuild || this.rebuiltActiveTurnId === null) return;
    const turnId = this.rebuiltActiveTurnId ?? this.snapshot.activeTurnId;
    this.rebuiltActiveTurnId = null;
    if (!turnId) return;
    const restartedInHeld = held.some(
      (entry) => entry.event?.type === "turn_started" && entry.event.turnId === turnId,
    );
    if (!restartedInHeld) this.deliver({ type: "turn_started", provider: this.provider, turnId });
  }

  private deliver(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        this.options.logger.warn({ err: error }, "Hosted session subscriber threw");
      }
    }
  }

  private lossyNotice(): AgentStreamEvent | null {
    if (this.lossyNoticeShown) return null;
    this.lossyNoticeShown = true;
    return {
      type: "timeline",
      provider: this.provider,
      item: {
        type: "notification",
        level: "warning",
        message: "Some activity from this session could not be shown after a reconnect.",
      },
    };
  }

  private markApplied(seq: number): void {
    if (seq <= this.appliedSeq) return;
    this.appliedSeq = seq;
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => void this.flushAck(), ACK_INTERVAL_MS);
    this.ackTimer.unref();
  }

  /** Records the applied position durably, then lets the host raise its replay floor. */
  private async flushAck(): Promise<void> {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    const seq = this.appliedSeq;
    const channel = this.channel;
    if (seq <= this.ackedSeq || this.status !== "attached") return;
    const applied = this.options.applied;
    if (applied) {
      try {
        await applied.store.write(applied.agentId, {
          hostId: applied.hostId,
          lastAppliedSeq: seq,
        });
      } catch (error) {
        // Without a durable record the host must keep treating these events as unapplied.
        this.options.logger.warn({ err: error }, "Could not record applied hosted events");
        return;
      }
    }
    if (channel !== this.channel || this.status !== "attached") return;
    channel.acknowledge(seq);
    this.ackedSeq = Math.max(this.ackedSeq, seq);
  }

  private async forgetApplied(): Promise<void> {
    const applied = this.options.applied;
    if (applied) await applied.store.remove(applied.agentId);
  }

  private handleDetached(channel: HostedSession, reason: HostedSessionDetachReason): void {
    if (channel !== this.channel || this.status === "closed") return;
    if (reason === "fenced") {
      this.status = "fenced";
      // A newer worker drives the provider now. Settle this worker's view of the turn without
      // touching the provider, so nothing here waits on a turn it can no longer see.
      this.releaseTurn({
        type: "turn_canceled",
        provider: this.provider,
        reason: "Another worker took over this session.",
      });
      return;
    }
    this.status = "reattaching";
    this.recovery = this.recover(channel.lastSeq()).finally(() => {
      this.recovery = null;
    });
  }

  private async recover(afterSeq: number): Promise<void> {
    const policy = this.options.reattachPolicy ?? DEFAULT_REATTACH_POLICY;
    const deadline = Date.now() + policy.windowMs;
    let delay = policy.initialDelayMs;
    for (;;) {
      let next: HostedReattachment | null;
      try {
        next = await this.options.reattach(afterSeq);
      } catch (error) {
        if (this.isClosed()) return;
        if (Date.now() + delay > deadline) {
          this.options.logger.warn({ err: error }, "The session host did not answer in time");
          this.markLost();
          return;
        }
        await this.backoff(delay);
        if (this.isClosed()) return;
        delay = Math.min(delay * 2, policy.maxDelayMs);
        continue;
      }
      if (this.isClosed()) {
        next?.channel.call({ method: "close" }).catch(() => {});
        return;
      }
      if (!next) {
        this.markLost();
        return;
      }
      this.snapshot = HostedSessionSnapshotSchema.parse(next.channel.attach.snapshot);
      this.snapshotSeq = next.channel.attach.lastSeq;
      this.status = "attached";
      this.bind(next.channel);
      if (next.lossy) this.emit(this.lossyNotice(), null);
      if (this.interruptPending) {
        this.interruptPending = false;
        this.invoke({ method: "interrupt" }).catch((error: unknown) =>
          this.options.logger.warn({ err: error }, "Interrupt after reattach failed"),
        );
      }
      return;
    }
  }

  /** Read through a method: close() can change the status while recovery awaits. */
  private isClosed(): boolean {
    return this.status === "closed";
  }

  private backoff(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      // A backoff must never keep a stopping worker alive.
      timer.unref();
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.wakeRecovery = done;
    }).finally(() => {
      this.wakeRecovery = null;
    });
  }

  /** Ends this worker's view of the running turn and clears what it can no longer answer. */
  private releaseTurn(
    event: Extract<AgentStreamEvent, { type: "turn_failed" | "turn_canceled" }>,
  ): void {
    const turnId = this.snapshot.activeTurnId;
    this.snapshot = { ...this.snapshot, pendingPermissions: [], activeTurnId: null };
    if (turnId) this.emit({ ...event, turnId }, null);
  }

  /** The provider process died with its host. The turn cannot continue in this session. */
  private markLost(): void {
    // The applied record stays: the next worker's startup reconciles it with what the host runs.
    this.status = "lost";
    this.releaseTurn({
      type: "turn_failed",
      provider: this.provider,
      error: "The session host stopped, so this turn could not continue.",
      code: "session_host_lost",
    });
  }
}
