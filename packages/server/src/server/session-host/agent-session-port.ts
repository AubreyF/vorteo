import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  AgentPermissionResponse,
  AgentPromptInput,
  AgentRunOptions,
  AgentSession,
  AgentStreamEvent,
  SteerActiveTurnOptions,
} from "../agent/agent-sdk-types.js";
import type { HostedSessionPort } from "./host.js";
import type {
  HostedPortEvent,
  HostedSessionSnapshot,
  SessionHostCall,
  SessionHostMethod,
} from "./session-contract.js";

type CallOf<M extends SessionHostMethod> = Extract<SessionHostCall, { method: M }>;

/** History pages stay well under one frame even when events are large. */
const HISTORY_PAGE_BYTES = 4 * 1024 * 1024;

export class HostedCallUnsupportedError extends Error {
  constructor(readonly method: string) {
    super(`This provider session does not support ${method}.`);
    this.name = "HostedCallUnsupportedError";
  }
}

/**
 * Plain JSON for a provider value. JSON.stringify drops Error fields, so errors keep their name
 * and message. Throws when the value cannot be represented.
 */
export function toHostedJson(value: unknown): JsonValue {
  const encoded = JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error ? { name: item.name, message: item.message } : item,
  );
  if (encoded === undefined) throw new Error("A provider value is not JSON-serializable.");
  return JSON.parse(encoded) as JsonValue;
}

/**
 * Follows the running turn from events. Providers tag each event with the foreground or
 * autonomous turn it belongs to, so a turn started without a worker call is tracked too.
 */
function nextActiveTurnId(current: string | null, event: AgentStreamEvent): string | null {
  if (event.type === "turn_started") return event.turnId ?? current;
  if (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  )
    return event.turnId === undefined || event.turnId === current ? null : current;
  return current;
}

/**
 * Adapts a provider AgentSession running inside the session host to the host's port. The session
 * is driven only through validated calls; its events and a snapshot of the state a worker reads
 * synchronously are recorded in order, so a worker attaching later sees the same sequence.
 */
export async function createAgentSessionPort(session: AgentSession): Promise<HostedSessionPort> {
  // A resumed provider yields its saved history once. Keep it for every worker that attaches.
  const history: JsonValue[] = [];
  for await (const event of session.streamHistory()) history.push(toHostedJson(event));

  const listeners = new Set<(event: JsonValue) => void>();
  let activeTurnId: string | null = null;
  let lastSnapshot = "";

  function snapshot(): HostedSessionSnapshot {
    return {
      id: session.id,
      persistence: session.describePersistence() as HostedSessionSnapshot["persistence"],
      pendingPermissions:
        session.getPendingPermissions() as HostedSessionSnapshot["pendingPermissions"],
      features: (session.features ?? []) as unknown as HostedSessionSnapshot["features"],
      activeTurnId,
      // Goal state and per-session capabilities, so the worker mirrors what this session supports.
      goals: session.goals
        ? (toHostedJson(session.goals.state) as HostedSessionSnapshot["goals"])
        : null,
      // This adapter ships with the host that implements atomic conditional close.
      capabilities: {
        ...(toHostedJson(session.capabilities) as HostedSessionSnapshot["capabilities"]),
        conditionalIdleClose: true,
      },
    };
  }

  function emit(event: HostedPortEvent): void {
    for (const listener of listeners) listener(event as JsonValue);
  }

  /** Records a state entry only when what the worker mirrors actually changed. */
  function publishState(): void {
    const current = toHostedJson(snapshot());
    const serialized = JSON.stringify(current);
    if (serialized === lastSnapshot) return;
    lastSnapshot = serialized;
    emit({ type: "state", snapshot: current as HostedSessionSnapshot });
  }

  session.subscribe((event) => {
    activeTurnId = nextActiveTurnId(activeTurnId, event);
    // A provider updates its own state before emitting, so the worker applies the state entry
    // first: a synchronous read while it handles the event sees what an in-process read would.
    publishState();
    // The host serializes the event; a value it cannot encode becomes a dropped-event marker.
    emit({ type: "stream", event: event as unknown as JsonValue });
  });
  publishState();

  function historyPage(cursor: number): JsonValue {
    const events: JsonValue[] = [];
    let bytes = 0;
    let next = cursor;
    while (next < history.length) {
      const size = JSON.stringify(history[next]).length;
      if (events.length > 0 && bytes + size > HISTORY_PAGE_BYTES) break;
      events.push(history[next]!);
      bytes += size;
      next += 1;
    }
    return { events, nextCursor: next < history.length ? next : null };
  }

  function requireMember<T>(member: T | undefined, method: string): T {
    if (member === undefined) throw new HostedCallUnsupportedError(method);
    return member;
  }

  /** One handler per call; each returns the provider's answer for the host to encode. */
  const handlers: {
    [M in Exclude<SessionHostMethod, "close" | "closeIfIdle">]: (
      call: CallOf<M>,
    ) => Promise<unknown>;
  } = {
    async startTurn(call) {
      const result = await session.startTurn(
        call.prompt as AgentPromptInput,
        call.options as AgentRunOptions | undefined,
      );
      activeTurnId = result.turnId;
      return result;
    },
    async steerActiveTurn(call) {
      if (!session.steerActiveTurn) return { status: "unavailable" };
      return session.steerActiveTurn(
        call.prompt as AgentPromptInput,
        call.options as SteerActiveTurnOptions,
      );
    },
    async interrupt() {
      await session.interrupt();
      return null;
    },
    async respondToPermission(call) {
      const result = await session.respondToPermission(
        call.requestId,
        call.response as AgentPermissionResponse,
      );
      return result ?? null;
    },
    async setMode(call) {
      return (await session.setMode(call.modeId)) ?? null;
    },
    async setModel(call) {
      await requireMember(session.setModel, call.method).call(session, call.modelId);
      return null;
    },
    async setThinkingOption(call) {
      const set = requireMember(session.setThinkingOption, call.method);
      return (await set.call(session, call.thinkingOptionId)) ?? null;
    },
    async setFeature(call) {
      await requireMember(session.setFeature, call.method).call(
        session,
        call.featureId,
        call.value,
      );
      return null;
    },
    getRuntimeInfo: () => session.getRuntimeInfo(),
    getAvailableModes: () => session.getAvailableModes(),
    getCurrentMode: () => session.getCurrentMode(),
    async listCommands() {
      return (await session.listCommands?.()) ?? [];
    },
    async streamHistory(call) {
      return historyPage(call.cursor);
    },
    async revertConversation(call) {
      const revert = requireMember(session.revertConversation, call.method);
      await revert.call(session, { messageId: call.messageId });
      return null;
    },
    async revertFiles(call) {
      await requireMember(session.revertFiles, call.method).call(session, {
        messageId: call.messageId,
      });
      return null;
    },
    async revertBoth(call) {
      await requireMember(session.revertBoth, call.method).call(session, {
        messageId: call.messageId,
      });
      return null;
    },
    async goalsRead(call) {
      return requireMember(session.goals, call.method).read();
    },
    async goalsSet(call) {
      return requireMember(session.goals, call.method).set(
        call.input as Parameters<NonNullable<AgentSession["goals"]>["set"]>[0],
      );
    },
    async goalsClear(call) {
      return requireMember(session.goals, call.method).clear();
    },
    async outOfBand(call) {
      // The handler's events are returned, not logged: the worker dispatches them itself, the way
      // it does for a local session, so nothing is shown twice.
      const handler = session.tryHandleOutOfBand?.(call.prompt);
      if (!handler) return { handled: false, events: [] };
      const events: JsonValue[] = [];
      await handler.run({ emit: (event) => events.push(toHostedJson(event)) });
      return {
        handled: true,
        ...(handler.intent ? { intent: handler.intent } : {}),
        events,
      };
    },
  };

  function dispatch(
    call: Exclude<SessionHostCall, { method: "close" | "closeIfIdle" }>,
  ): Promise<unknown> {
    const handler = handlers[call.method] as (call: SessionHostCall) => Promise<unknown>;
    return handler(call);
  }

  return {
    async call(call) {
      try {
        return toHostedJson(await dispatch(call));
      } finally {
        // Calls such as setMode change mirrored state without emitting an event.
        publishState();
      }
    },
    snapshot: () => toHostedJson(snapshot()),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => session.close(),
  };
}
