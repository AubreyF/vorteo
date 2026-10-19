import type {
  AgentCapabilityFlags,
  AgentFeature,
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

/**
 * A provider session whose turn runs until the test ends it, like a long Claude turn. It keeps
 * its state the way the Claude adapter does: updated before each event is emitted.
 */
export class ControlledSession implements AgentSession {
  readonly provider = "claude";
  readonly capabilities = CONTROLLED_SESSION_CAPABILITIES;
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
  ) {}

  get id(): string | null {
    return this.sessionId;
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
    return this.sessionId
      ? { provider: "claude", sessionId: this.sessionId, nativeHandle: this.sessionId }
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
