import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  AgentCapabilityFlags,
  AgentFeature,
  AgentGoals,
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
import type { AgentMetadata, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { stripInternalPaseoMcpServer } from "../agent/runtime-mcp-config.js";
import { StaleProviderSessionError } from "../agent/stale-provider-session-error.js";
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
/** Live events of an adopted session whose history is never read are delivered after this. */
const REBUILD_UNREAD_RELEASE_MS = 120_000;
/**
 * Once its history has been read, an adopted session waits this long for the manager to commit
 * the rows before it delivers live events anyway. Reading itself has no deadline: a slow read must
 * not let live rows overtake the history they follow.
 */
const REBUILD_APPLY_RELEASE_MS = 30_000;

export type HostedSessionUnavailableReason = "fenced" | "lost" | "closed" | "detached";

const UNAVAILABLE_MESSAGES: Record<HostedSessionUnavailableReason, string> = {
  fenced: "Another worker now drives this session.",
  lost: "The session host no longer runs this session.",
  closed: "This session is closed.",
  detached: "This worker released the session for the next worker.",
};

export class HostedSessionUnavailableError extends Error {
  constructor(readonly reason: HostedSessionUnavailableReason) {
    super(UNAVAILABLE_MESSAGES[reason]);
    this.name = "HostedSessionUnavailableError";
  }
}

/**
 * The host still runs the session but has not answered within the reattach window. The caller can
 * try again: the turn keeps running in the host, and this session reattaches when it answers.
 * Deliberately not a stale-session error, whose reload would close the turn it waits to save.
 */
export class HostedSessionReconnectingError extends Error {
  constructor() {
    super("The session host is not answering yet. The running turn continues; try again shortly.");
    this.name = "HostedSessionReconnectingError";
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
  /**
   * While the host process is still alive, reattaching continues past windowMs up to this long.
   * A live host either answers again or its watchdog kills it, so giving up sooner would start a
   * second provider beside one that may still run.
   */
  aliveWindowMs?: number;
  /**
   * How long an open waits for a host that was killed, not stopped, to be restarted by launchd
   * before the session starts in the worker instead. Covers launchd's restart throttle and the
   * host's startup; a stopped host removed its socket and is never waited for.
   */
  returnWindowMs?: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_REATTACH_POLICY: Required<HostedReattachPolicy> = {
  windowMs: 60_000,
  aliveWindowMs: 300_000,
  returnWindowMs: 15_000,
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
   * What the host lock proves. "gone" (no lock, or a holder pid that no longer exists) means the
   * host took the session with it. "alive" includes a lock that cannot be checked. Absent means
   * unknown: the session waits out the reattach window, with no extension.
   */
  hostState?(): Promise<"gone" | "alive">;
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
  /** Called once when the host no longer runs the session, so the agent can continue elsewhere. */
  onLost?(): void;
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

/** Providers whose sessions handle slash commands without a model turn (Codex: /compact, /goal). */
const OUT_OF_BAND_PROVIDERS = new Set(["codex"]);

/**
 * The same split the Codex adapter applies to a prompt, so the worker decides synchronously
 * whether a prompt is a command the host will run out of band.
 */
function parseSlashCommand(prompt: AgentPromptInput): { name: string; args: string } | null {
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/") || trimmed.length <= 1) return null;
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  const name = space === -1 ? body : body.slice(0, space);
  if (!name || name.includes("/")) return null;
  return { name, args: space === -1 ? "" : body.slice(space + 1).trim() };
}

/** Codex records a goal intent only for `/goal <objective>`, not for pause, resume, clear or usage. */
function goalIntent(args: string): "goal" | undefined {
  const lower = args.trim().toLowerCase();
  return lower && !["pause", "resume", "clear"].includes(lower) ? "goal" : undefined;
}

/**
 * Drives a provider session that runs in the session host. It mirrors the state the agent
 * manager reads synchronously, delivers provider events in host order and reattaches when the
 * connection drops, so a worker restart or reconnect does not end the provider's turn.
 *
 * Goals and out-of-band commands cross the boundary as calls when the hosted session supports
 * them. Deliberately absent: initialTimeline, quota observation and admission guards; quota-governed
 * sessions are never opened in the host.
 */
export class HostedAgentSession implements AgentSession {
  readonly provider: string;
  /** Goal state and commands, present only when the hosted session supports goals. */
  readonly goals: AgentGoals | undefined;

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
  private persistenceSource: AgentPersistenceHandle | null = null;
  private persistenceView: AgentPersistenceHandle | null = null;
  /** Delivers held live events if the rebuilt history is never read or never applied. */
  private releaseTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: HostedAgentSessionOptions) {
    this.provider = options.provider;
    this.model = options.usage.model;
    this.channel = options.channel;
    this.snapshot = HostedSessionSnapshotSchema.parse(options.channel.attach.snapshot);
    this.snapshotSeq = options.channel.attach.lastSeq;
    this.liveHeld = options.rebuild !== undefined;
    this.appliedSeq = options.rebuild?.throughSeq ?? 0;
    this.ackedSeq = this.appliedSeq;
    // Whether a session supports goals is fixed when the provider starts it, so the manager's
    // truthiness check on `goals` can be answered once from the attach snapshot.
    this.goals = this.snapshot.goals != null ? this.hostedGoals() : undefined;
    this.bind(options.channel);
    if (this.liveHeld)
      this.armRelease(REBUILD_UNREAD_RELEASE_MS, "Hosted history was not read in time");
  }

  get id(): string | null {
    return this.snapshot.id;
  }

  /** The hosted session's own capabilities when the host reports them; the client's otherwise. */
  get capabilities(): AgentCapabilityFlags {
    return (
      (this.snapshot.capabilities as AgentCapabilityFlags | undefined) ?? this.options.capabilities
    );
  }

  get features(): AgentFeature[] {
    return this.snapshot.features as unknown as AgentFeature[];
  }

  /**
   * Codex handles /compact and, with goals on, /goal without a model turn. Recognition mirrors
   * the adapter and stays local; the command itself runs in the host, and the events it emitted
   * are dispatched here as the manager expects from an in-process handler.
   */
  tryHandleOutOfBand(
    prompt: AgentPromptInput,
  ): ReturnType<NonNullable<AgentSession["tryHandleOutOfBand"]>> {
    if (!OUT_OF_BAND_PROVIDERS.has(this.provider)) return null;
    const command = parseSlashCommand(prompt);
    if (!command) return null;
    if (command.name !== "compact" && !(command.name === "goal" && this.goals)) return null;
    const text = prompt as string;
    return {
      ...(command.name === "goal" ? { intent: goalIntent(command.args) } : {}),
      run: async ({ emit }) => {
        const result = await this.invoke({ method: "outOfBand", prompt: text });
        // The manager shows a thrown error; a silent return would swallow the command.
        if (!result.handled) throw new Error("The hosted session does not handle this command.");
        for (const event of result.events)
          if (HostedStreamEventSchema.safeParse(event).success)
            emit(event as unknown as AgentStreamEvent);
      },
    };
  }

  /**
   * Goal reads and writes cross to the provider. The mirror follows the returned state, and the
   * host's state entries keep it current between calls, so `state` reads like an in-process one.
   */
  private hostedGoals(): AgentGoals {
    type GoalState = AgentGoals["state"];
    const readState = (): GoalState => this.snapshot.goals as unknown as GoalState;
    const apply = (state: GoalState): GoalState => {
      this.snapshot = { ...this.snapshot, goals: state as HostedSessionSnapshot["goals"] };
      return state;
    };
    const call = async (request: CallOf<"goalsRead" | "goalsSet" | "goalsClear">) =>
      apply((await this.invoke(request)) as GoalState);
    return {
      get state(): GoalState {
        return readState();
      },
      read: () => call({ method: "goalsRead" }),
      set: (input) =>
        call({ method: "goalsSet", input: asJson<CallOf<"goalsSet">["input"]>(input) }),
      clear: () => call({ method: "goalsClear" }),
    };
  }

  /** The session's current host-side status, for diagnostics and restart readiness. */
  get hostedStatus(): HostedAgentSession["status"] {
    return this.status;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return this.snapshot.pendingPermissions as AgentPermissionRequest[];
  }

  describePersistence(): AgentPersistenceHandle | null {
    const handle = this.snapshot.persistence as AgentPersistenceHandle | null;
    if (handle !== this.persistenceSource) {
      this.persistenceSource = handle;
      // The injected tool server carries the host's bearer token, which outlives this worker.
      // Resume injects it again, so persisted handles never need it.
      this.persistenceView = handle?.metadata
        ? {
            ...handle,
            metadata: stripInternalPaseoMcpServer(
              handle.metadata as unknown as AgentSessionConfig,
            ) as unknown as AgentMetadata,
          }
        : handle;
    }
    return this.persistenceView;
  }

  /**
   * The provider runs outside this worker and outlives it. A session that is reattaching counts:
   * its provider is still in the host, so a restart must neither wrap up nor interrupt its turn.
   */
  isDurablyHosted(): boolean {
    return this.status === "attached" || this.status === "reattaching";
  }

  /**
   * Worker shutdown: record what was applied, then let go without closing the host session, so
   * the provider keeps running and the next worker takes it over.
   */
  async detach(): Promise<void> {
    if (this.status !== "attached" && this.status !== "reattaching") return;
    if (this.status === "attached") await this.flushAck();
    // Reattaching has no channel to acknowledge on, but the record still tells the next worker
    // which events this one applied.
    else await this.recordApplied(this.appliedSeq);
    // Closed, fenced or lost while the record was written: nothing is left to hand over.
    if (!this.isDurablyHosted()) return;
    const wasAttached = this.isAttached();
    this.status = "detached";
    this.wakeRecovery?.();
    this.unsubscribeChannel();
    // Not required, since the next attach fences this one, but it puts the handoff in the audit log.
    if (wasAttached) this.channel.release();
    this.clearReleaseTimer();
    this.subscribers.clear();
    this.held = [];
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

  /** The manager committed the rebuilt history rows, so held live events go after them. */
  historyApplied(): void {
    this.releaseLive();
  }

  /**
   * Lets held live events through. historyApplied does this; the startup path also calls it when
   * loading an adopted agent finished or failed, so events are never held forever.
   */
  releaseLive(): void {
    this.clearReleaseTimer();
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
    // A lost, closed or released session has nothing left to interrupt here.
    if (this.status !== "attached" && this.status !== "reattaching") return;
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

  async closeIfIdle(): Promise<void> {
    // COMPAT(conditionalIdleClose): added in v0.11.0-beta.3.vorteo.882; remove once the host floor supports it.
    // Never send an unknown method to an old host or fall back to unconditional close.
    if (this.snapshot.capabilities?.conditionalIdleClose !== true)
      throw new Error("Session host does not support conditional idle close.");
    if (this.status === "reattaching") throw new HostedSessionReconnectingError();
    if (this.status !== "attached") throw new HostedSessionUnavailableError(this.status);
    await this.invoke({ method: "closeIfIdle" });
    // A refusal must leave attachment, applied record and subscribers intact.
    await this.forgetApplied();
    this.finishClose();
  }

  private finishClose(): void {
    this.status = "closed";
    this.wakeRecovery?.();
    this.unsubscribeChannel();
    this.clearReleaseTimer();
    this.subscribers.clear();
    this.held = [];
  }

  async close(): Promise<void> {
    if (this.status === "closed" || this.status === "detached") return;
    const status = this.status;
    try {
      // While reattaching, the recovery closes the host session if it gets an attachment back.
      // Only a close that reached the host may forget the applied record: a fenced worker would
      // otherwise delete the record its successor just wrote for the same agent.
      if (status === "attached") {
        await this.invoke({ method: "close" });
        await this.forgetApplied();
      }
      // The host no longer runs a lost session, and its agent is moving to a fresh session. A
      // record left behind would make the next startup report the agent lost a second time.
      if (status === "lost") await this.forgetApplied();
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Closing a hosted session did not finish; the host may still run it until the next worker start",
      );
      throw error;
    } finally {
      this.finishClose();
    }
  }

  private async *readHistory(): AsyncGenerator<AgentStreamEvent> {
    // Like the provider itself, saved history is yielded once per session object.
    if (this.historyRead) return;
    this.historyRead = true;
    // However long the read takes, live events stay behind the history they follow.
    this.clearReleaseTimer();
    let complete = false;
    try {
      yield* this.readProviderHistory();
      if (this.options.rebuild) yield* this.readLoggedHistory(this.options.rebuild);
      complete = true;
    } finally {
      // A failed read can be retried; the manager collects history before it appends rows, and
      // signals historyApplied once they are committed, which releases the held live events.
      if (!complete) this.historyRead = false;
      if (this.liveHeld && !this.isFinished())
        this.armRelease(
          complete ? REBUILD_APPLY_RELEASE_MS : REBUILD_UNREAD_RELEASE_MS,
          complete
            ? "Rebuilt hosted history was not applied in time"
            : "Hosted history read failed",
        );
    }
  }

  /** Delivers held live events after ms unless history is applied, read or the session ends. */
  private armRelease(ms: number, reason: string): void {
    this.clearReleaseTimer();
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (!this.liveHeld) return;
      this.options.logger.warn(`${reason}; delivering live events`);
      this.releaseLive();
    }, ms);
    this.releaseTimer.unref();
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
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
    if (this.recovery) await this.waitForRecovery();
    const status = this.status;
    // A lost session is stale: the prompt path reloads the agent and retries on a fresh session.
    if (status === "lost") throw new StaleProviderSessionError(this.snapshot.id ?? "hosted");
    if (status === "reattaching") throw new HostedSessionReconnectingError();
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
    // Without a durable record the host must keep treating these events as unapplied.
    if (!(await this.recordApplied(seq))) return;
    if (channel !== this.channel || this.status !== "attached") return;
    channel.acknowledge(seq);
    this.ackedSeq = Math.max(this.ackedSeq, seq);
  }

  /** Writes the applied record. False when it could not be written. */
  private async recordApplied(seq: number): Promise<boolean> {
    const applied = this.options.applied;
    if (!applied || seq <= this.ackedSeq) return true;
    try {
      await applied.store.write(applied.agentId, { hostId: applied.hostId, lastAppliedSeq: seq });
      return true;
    } catch (error) {
      this.options.logger.warn({ err: error }, "Could not record applied hosted events");
      return false;
    }
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
    const started = Date.now();
    const deadline = started + policy.windowMs;
    const aliveDeadline = started + Math.max(policy.windowMs, policy.aliveWindowMs ?? 0);
    let delay = policy.initialDelayMs;
    for (;;) {
      let next: HostedReattachment | null;
      try {
        next = await this.options.reattach(afterSeq);
      } catch (error) {
        if (this.isFinished()) return;
        const host = await this.hostState();
        if (this.isFinished()) return;
        // A dead host ran nothing that waiting could bring back, and it can never run a second
        // provider, so the session is lost at once rather than after the window.
        if (host === "gone") {
          this.options.logger.warn({ err: error }, "The session host is gone");
          this.markLost();
          return;
        }
        const until = host === "alive" ? aliveDeadline : deadline;
        if (Date.now() + delay > until) {
          this.options.logger.warn({ err: error }, "The session host did not answer in time");
          this.markLost();
          return;
        }
        await this.backoff(delay);
        if (this.isFinished()) return;
        delay = Math.min(delay * 2, policy.maxDelayMs);
        continue;
      }
      if (this.isFinished()) {
        // A closed session ends in the host as well; a released one stays for the next worker.
        if (this.isClosed()) next?.channel.call({ method: "close" }).catch(() => {});
        else next?.channel.release();
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

  /**
   * Waits for a reattach in progress, but no longer than the reattach window. A live host can keep
   * a session reattaching for minutes; a caller such as a permission answer gets an answer sooner.
   */
  private async waitForRecovery(): Promise<void> {
    const recovery = this.recovery;
    if (!recovery) return;
    const windowMs = (this.options.reattachPolicy ?? DEFAULT_REATTACH_POLICY).windowMs;
    let timer: NodeJS.Timeout | undefined;
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, windowMs);
      timer.unref();
    });
    try {
      await Promise.race([recovery, elapsed]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The host lock's verdict. A live host earns time past the reattach window, up to the alive
   * window. A failed check counts as alive: cancelling a live turn on a read error would be worse.
   */
  private async hostState(): Promise<"gone" | "alive" | "unknown"> {
    if (!this.options.hostState) return "unknown";
    try {
      return await this.options.hostState();
    } catch {
      return "alive";
    }
  }

  /** Read through a method: close() can change the status while recovery awaits. */
  private isClosed(): boolean {
    return this.status === "closed";
  }

  /** Closed, or released to the next worker by detach(); either way recovery must stop. */
  private isFinished(): boolean {
    return this.status === "closed" || this.status === "detached";
  }

  /** Read through a method: detach() awaits the record write before reading it. */
  private isAttached(): boolean {
    return this.status === "attached";
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

  /**
   * The provider process ended with its host. Like a restart, the turn is canceled here and the
   * agent continues from a queued continuation on a fresh session. The applied record stays until
   * the agent moves to that session, so a worker that stops first leaves it for the next startup.
   */
  private markLost(): void {
    this.status = "lost";
    this.releaseTurn({
      type: "turn_canceled",
      provider: this.provider,
      reason: "The session host stopped. This task continues from a queued continuation.",
    });
    try {
      this.options.onLost?.();
    } catch (error) {
      this.options.logger.warn({ err: error }, "Hosted session loss handler threw");
    }
  }
}
