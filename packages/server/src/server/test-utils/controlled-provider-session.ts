import type {
  AgentCapabilityFlags,
  AgentFeature,
  AgentGoals,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";

export const CONTROLLED_SESSION_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

export interface ControlledSessionOptions {
  /** Reported provider id; the Codex shape is "codex". Defaults to "claude". */
  provider?: string;
  /** Gives the session goal state and the Codex-style /goal and /compact command handling. */
  goals?: boolean;
}

type GoalState = AgentGoals["state"];

/**
 * A provider session whose turn runs until the test ends it, like a long Claude turn. It keeps
 * its state the way the Claude adapter does: updated before each event is emitted. With goals on it
 * also behaves like the Codex adapter: goal state lives in the session and `/goal` runs out of band.
 */
export class ControlledSession implements AgentSession {
  readonly provider: string;
  readonly goals: AgentGoals | undefined;
  readonly commands: string[] = [];
  private goalState: GoalState = { status: "ready", goal: null } as unknown as GoalState;
  private sessionId: string | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pending = new Map<
    string,
    { request: AgentPermissionRequest; resolve: (response: AgentPermissionResponse) => void }
  >();
  private turnId: string | null = null;
  private turnOrdinal = 0;
  private mode = "default";
  private fastMode = false;
  readonly calls: string[] = [];
  closed = false;

  constructor(
    readonly config: AgentSessionConfig,
    private readonly history: AgentStreamEvent[] = [],
    options: ControlledSessionOptions = {},
  ) {
    this.provider = options.provider ?? "claude";
    this.goals = options.goals ? this.controlledGoals() : undefined;
  }

  get capabilities(): AgentCapabilityFlags {
    return { ...CONTROLLED_SESSION_CAPABILITIES, supportsGoals: this.goals !== undefined };
  }

  get id(): string | null {
    return this.sessionId;
  }

  private controlledGoals(): AgentGoals {
    const readState = (): GoalState => this.goalState;
    const settle = (goal: unknown): GoalState => {
      this.goalState = { status: "ready", goal } as unknown as GoalState;
      this.emit({ type: "goal_changed", provider: this.provider, state: this.goalState });
      return this.goalState;
    };
    return {
      get state() {
        return readState();
      },
      read: async () => readState(),
      set: async (input) =>
        settle({ objective: (input as { objective?: string }).objective ?? "", status: "active" }),
      clear: async () => settle(null),
    };
  }

  /** Codex-style commands: /compact always; /goal only with goals on. */
  tryHandleOutOfBand(prompt: AgentPromptInput) {
    if (typeof prompt !== "string" || !prompt.startsWith("/")) return null;
    const [name, ...rest] = prompt.slice(1).split(/\s+/);
    if (name !== "compact" && !(name === "goal" && this.goals)) return null;
    this.commands.push(prompt);
    return {
      intent: name === "goal" && rest.length ? ("goal" as const) : undefined,
      run: async ({ emit }: { emit: (event: AgentStreamEvent) => void }) => {
        if (name === "goal" && rest.length) await this.goals!.set({ objective: rest.join(" ") });
        emit({
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: `${name} handled` },
        });
      },
    };
  }

  get features(): AgentFeature[] {
    return [{ type: "toggle", id: "fast_mode", label: "Fast", value: this.fastMode }];
  }

  emit(event: AgentStreamEvent): void {
    const tagged = this.turnId ? { ...event, turnId: this.turnId } : event;
    for (const subscriber of this.subscribers) subscriber(tagged);
  }

  text(text: string): void {
    this.emit({
      type: "timeline",
      provider: "claude",
      item: { type: "assistant_message", text },
    });
  }

  requestPermission(id: string): Promise<AgentPermissionResponse> {
    const request: AgentPermissionRequest = { id, provider: "claude", name: "Bash", kind: "tool" };
    return new Promise((resolve) => {
      this.pending.set(id, { request, resolve });
      this.emit({ type: "permission_requested", provider: "claude", request });
    });
  }

  complete(): void {
    this.emit({ type: "turn_completed", provider: "claude", usage: { outputTokens: 1 } });
    this.turnId = null;
  }

  async run(): Promise<AgentRunResult> {
    throw new Error("Not used");
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.calls.push(`startTurn:${typeof prompt === "string" ? prompt : "blocks"}`);
    if (!this.sessionId) {
      this.sessionId = "claude-session-1";
      this.emit({ type: "thread_started", provider: "claude", sessionId: this.sessionId });
    }
    this.turnId = `turn-${++this.turnOrdinal}`;
    this.emit({ type: "turn_started", provider: "claude" });
    return { turnId: this.turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* this.history.splice(0);
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: "claude", sessionId: this.sessionId, modeId: this.mode };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [{ id: "default", label: "Default" }];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.mode;
  }

  async setMode(modeId: string): Promise<void> {
    this.mode = modeId;
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (featureId === "fast_mode") this.fastMode = value === true;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`No pending permission request with id '${requestId}'`);
    this.pending.delete(requestId);
    entry.resolve(response);
    this.emit({ type: "permission_resolved", provider: "claude", requestId, resolution: response });
  }

  describePersistence(): AgentPersistenceHandle | null {
    // Like the Claude adapter, the handle's metadata carries the session config.
    return this.sessionId
      ? {
          provider: "claude",
          sessionId: this.sessionId,
          nativeHandle: this.sessionId,
          metadata: { ...this.config },
        }
      : null;
  }

  async interrupt(): Promise<void> {
    this.calls.push("interrupt");
    if (!this.turnId) return;
    this.emit({ type: "turn_canceled", provider: "claude", reason: "Interrupted" });
    this.turnId = null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
