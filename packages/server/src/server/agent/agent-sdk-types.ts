import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProviderLoginSession } from "../../services/provider-login/session.js";
import type {
  AgentFeature,
  AgentFeatureSelect,
  AgentFeatureToggle,
  AgentProviderNotice,
  AgentTaskItem,
  JsonValue,
  ProviderOptions,
  ToolPolicy,
} from "@getpaseo/protocol/agent-types";
import type { AgentAttachment, AgentProfileLaunch } from "@getpaseo/protocol/messages";
import type {
  QuotaReserveConfig,
  QuotaReserveLaunchPolicy,
} from "@getpaseo/protocol/quota-reserve";
import type {
  ProviderResetAttempt,
  ProviderResetOutcome,
  ProviderResetSnapshot,
} from "@getpaseo/protocol/provider-reset";
import type { PaseoToolCatalog } from "./tools/types.js";

export type {
  AgentFeature,
  AgentFeatureSelect,
  AgentFeatureToggle,
  AgentProviderNotice,
  AgentTaskItem,
};

export type AgentProvider = string;

export interface AgentMetadata {
  [key: string]: unknown;
}

/**
 * Stdio-based MCP server (spawns a subprocess).
 */
export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * HTTP-based MCP server.
 */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * SSE-based MCP server (Server-Sent Events over HTTP).
 */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * Canonical MCP server configuration.
 * Discriminated union by `type` field.
 * Each provider normalizes this to their expected format.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export interface AgentMode {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  colorTier?: string;
  isUnattended?: boolean;
}

export type ProviderStatus = "ready" | "loading" | "error" | "unavailable";

export interface AgentModelDefinition {
  provider: AgentProvider;
  id: string;
  aliases?: string[];
  isSelectable?: boolean;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
  contextWindowMaxTokens?: number;
  localEndpoint?: {
    status: "reachable" | "unreachable";
    checkedAt: string;
  };
  thinkingOptions?: AgentSelectOption[];
  defaultThinkingOptionId?: string;
}

export interface AgentSelectOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
}

export function normalizeAgentModelDefinition(model: AgentModelDefinition): AgentModelDefinition {
  const defaultThinkingOptionId =
    model.defaultThinkingOptionId ?? model.thinkingOptions?.find((option) => option.isDefault)?.id;
  if (!defaultThinkingOptionId || defaultThinkingOptionId === model.defaultThinkingOptionId) {
    return model;
  }
  return { ...model, defaultThinkingOptionId };
}

export function filterSelectableAgentModels(
  models: AgentModelDefinition[] | undefined,
): AgentModelDefinition[] {
  return models?.filter((model) => model.isSelectable !== false) ?? [];
}

export interface ProviderSnapshotEntry {
  provider: AgentProvider;
  status: ProviderStatus;
  enabled: boolean;
  source?: "builtin" | "custom";
  error?: string;
  models?: AgentModelDefinition[];
  modes?: AgentMode[];
  fetchedAt?: string;
  label?: string;
  description?: string;
  iconSvg?: string;
  defaultModeId?: string | null;
}

export interface AgentCreateConfigParent {
  provider: AgentProvider;
  modeId: string | null;
  isUnattended: boolean;
}

export interface ResolveAgentCreateConfigInput {
  provider: AgentProvider;
  requestedMode: string | undefined;
  featureValues: Record<string, unknown> | undefined;
  parent: AgentCreateConfigParent | null;
  unattended: boolean;
  availableModes: AgentMode[] | undefined;
}

export interface ResolveAgentCreateConfigResult {
  modeId: string | undefined;
  featureValues: Record<string, unknown> | undefined;
}

export interface AgentCreateConfigUnattendedInput {
  modeId: string | null;
  config: AgentSessionConfig;
  features?: AgentFeature[];
  availableModes: AgentMode[];
}

export interface AgentCapabilityFlags {
  [capability: string]: boolean | undefined;
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsSessionListing?: boolean;
  supportsDynamicModes: boolean;
  supportsMcpServers: boolean;
  supportsNativePaseoTools?: boolean;
  supportsReasoningStream: boolean;
  supportsToolInvocations: boolean;
  supportsRewindConversation?: boolean;
  supportsRewindFiles?: boolean;
  supportsRewindBoth?: boolean;
}

export interface AgentPersistenceHandle {
  provider: AgentProvider;
  sessionId: string;
  /** Provider specific handle (Codex thread id, Claude resume token, etc). */
  nativeHandle?: string;
  metadata?: AgentMetadata;
}

export type AgentPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | AgentAttachment;

export type AgentPromptInput = string | AgentPromptContentBlock[];

export interface AgentRunOptions {
  queuedMessage?: import("@getpaseo/protocol/message-queue").QueueItem;
  intent?: "goal";
  outputSchema?: unknown;
  resumeFrom?: AgentPersistenceHandle;
  maxThinkingTokens?: number;
  clientMessageId?: string;
}

export interface AgentSteerOptions extends AgentRunOptions {
  /** Deny permissions that block this steer. An accepted steer must honor this contract. */
  clearPendingPermissions?: boolean;
}

export type SteerResult = { status: "accepted" } | { status: "unavailable" };

export interface SteerActiveTurnOptions extends AgentSteerOptions {
  expectedTurnId: string;
}

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export const TOOL_CALL_ICON_NAMES = [
  "wrench",
  "square_terminal",
  "eye",
  "pencil",
  "search",
  "bot",
  "sparkles",
  "brain",
  "mic_vocal",
] as const;

export type ToolCallIconName = (typeof TOOL_CALL_ICON_NAMES)[number];

export type ToolCallDetail =
  | {
      type: "shell";
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
    }
  | {
      type: "read";
      filePath: string;
      content?: string;
      offset?: number;
      limit?: number;
    }
  | {
      type: "edit";
      filePath: string;
      oldString?: string;
      newString?: string;
      unifiedDiff?: string;
    }
  | {
      type: "write";
      filePath: string;
      content?: string;
    }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      webResults?: Array<{
        title: string;
        url: string;
      }>;
      annotations?: string[];
      numFiles?: number;
      numMatches?: number;
      durationMs?: number;
      durationSeconds?: number;
      truncated?: boolean;
      mode?: "content" | "files_with_matches" | "count";
    }
  | {
      type: "fetch";
      url: string;
      prompt?: string;
      result?: string;
      code?: number;
      codeText?: string;
      bytes?: number;
      durationMs?: number;
    }
  | {
      type: "worktree_setup";
      worktreePath: string;
      branchName: string;
      log: string;
      commands: Array<{
        index: number;
        command: string;
        cwd: string;
        log: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        durationMs?: number;
      }>;
      truncated?: boolean;
    }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      log: string;
      actions?: Array<{
        index: number;
        toolName: string;
        summary?: string;
      }>;
    }
  | {
      type: "plain_text";
      label?: string;
      text?: string;
      icon?: ToolCallIconName;
    }
  | {
      type: "plan";
      text: string;
    }
  | {
      type: "unknown";
      input: unknown;
      output: unknown;
    };

interface ToolCallBase {
  [key: string]: unknown;
  type: "tool_call";
  callId: string;
  name: string;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
}

type ToolCallRunningTimelineItem = ToolCallBase & {
  status: "running";
  error: null;
};

type ToolCallCompletedTimelineItem = ToolCallBase & {
  status: "completed";
  error: null;
};

type ToolCallFailedTimelineItem = ToolCallBase & {
  status: "failed";
  error: unknown;
};

type ToolCallCanceledTimelineItem = ToolCallBase & {
  status: "canceled";
  error: null;
};

export type ToolCallTimelineItem =
  | ToolCallRunningTimelineItem
  | ToolCallCompletedTimelineItem
  | ToolCallFailedTimelineItem
  | ToolCallCanceledTimelineItem;

export interface CompactionTimelineItem {
  [key: string]: unknown;
  type: "compaction";
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export interface PluginTimelineItem {
  type: "plugin";
  id: string;
  pluginId: string;
  kind: string;
  version: number;
  data: JsonValue;
}

export type AgentTimelineItem =
  | {
      type: "user_message";
      text: string;
      messageId?: string;
      clientMessageId?: string;
      intent?: "goal";
      queue?: import("@getpaseo/protocol/message-queue").QueuePresentation;
    }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCallTimelineItem
  | { type: "todo"; items: AgentTaskItem[] }
  | { type: "error"; message: string }
  | {
      type: "notification";
      level: "info" | "warning" | "error";
      message: string;
    }
  | CompactionTimelineItem
  | PluginTimelineItem;

export type AgentStreamEvent =
  | {
      type: "goal_changed";
      provider: AgentProvider;
      state: import("@getpaseo/protocol/agent-goals").AgentGoalState;
    }
  | { type: "thread_started"; sessionId: string; provider: AgentProvider }
  | { type: "turn_started"; provider: AgentProvider; turnId?: string }
  | { type: "turn_completed"; provider: AgentProvider; usage?: AgentUsage; turnId?: string }
  | { type: "usage_updated"; provider: AgentProvider; usage: AgentUsage; turnId?: string }
  | {
      type: "mode_changed";
      provider: AgentProvider;
      currentModeId: string | null;
      availableModes: AgentMode[];
    }
  | { type: "model_changed"; provider: AgentProvider; runtimeInfo: AgentRuntimeInfo }
  | {
      type: "thinking_option_changed";
      provider: AgentProvider;
      thinkingOptionId: string | null;
    }
  | {
      type: "turn_failed";
      provider: AgentProvider;
      error: string;
      code?: string;
      diagnostic?: string;
      turnId?: string;
    }
  | { type: "turn_canceled"; provider: AgentProvider; reason: string; turnId?: string }
  | {
      type: "timeline";
      item: AgentTimelineItem;
      provider: AgentProvider;
      turnId?: string;
      timestamp?: string;
    }
  | {
      type: "permission_requested";
      provider: AgentProvider;
      request: AgentPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      provider: AgentProvider;
      requestId: string;
      resolution: AgentPermissionResponse;
      turnId?: string;
    }
  | {
      type: "attention_required";
      provider: AgentProvider;
      reason: "finished" | "error" | "permission";
      timestamp: string;
    }
  | {
      type: "provider_subagent";
      provider: AgentProvider;
      event: import("./provider-subagents/store.js").ProviderSubagentInputEvent;
    };

export function getAgentStreamEventTurnId(event: AgentStreamEvent): string | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

export type AgentPermissionRequestKind = "tool" | "plan" | "question" | "mode" | "other";

export type AgentPermissionUpdate = AgentMetadata;

export interface AgentPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
  intent?: "implement" | "implement_resume" | "dismiss";
}

export interface AgentPermissionRequest {
  id: string;
  provider: AgentProvider;
  name: string;
  kind: AgentPermissionRequestKind;
  title?: string;
  description?: string;
  input?: AgentMetadata;
  detail?: ToolCallDetail;
  suggestions?: AgentPermissionUpdate[];
  actions?: AgentPermissionAction[];
  metadata?: AgentMetadata;
}

export type AgentPermissionResponse =
  | {
      behavior: "allow";
      selectedActionId?: string;
      updatedInput?: AgentMetadata;
      updatedPermissions?: AgentPermissionUpdate[];
    }
  | {
      behavior: "deny";
      selectedActionId?: string;
      message?: string;
      interrupt?: boolean;
    };

export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  usage?: AgentUsage;
  timeline: AgentTimelineItem[];
  canceled?: boolean;
}

export interface AgentRuntimeInfo {
  provider: AgentProvider;
  sessionId: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  modeId?: string | null;
  extra?: AgentMetadata;
}

export type AgentSlashCommandKind = "command" | "skill";

/**
 * Represents a slash command available in an agent session.
 * Commands are executed by sending them as prompts with / prefix.
 */
export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: AgentSlashCommandKind;
}

export interface ListImportableSessionsOptions {
  providerOptions?: ProviderOptions;
  limit?: number;
  /** Optional case-insensitive descriptor search text. */
  query?: string;
  /**
   * Maximum number of cheap persisted-session candidates to inspect before
   * applying the result limit. Providers must cap this at 500.
   */
  scanLimit?: number;
  /**
   * Optional cwd hint. Providers that can cheaply pre-filter importable
   * sessions by working directory should do so before doing expensive work.
   */
  cwd?: string;
}

export interface ImportableProviderSession {
  providerHandleId: string;
  cwd: string;
  title: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  lastActivityAt: Date;
}

export interface ImportProviderSessionInput {
  providerHandleId: string;
  cwd: string;
}

export interface ImportProviderSessionContext {
  config: AgentSessionConfig;
  storedConfig: AgentSessionConfig;
  launchContext?: AgentLaunchContext;
}

export interface ImportedTimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
}

export interface ImportedProviderSession {
  session: AgentSession;
  config: AgentSessionConfig;
  persistence: AgentPersistenceHandle;
  timeline: ImportedTimelineEntry[];
  providerSubagentEvents?: Extract<AgentStreamEvent, { type: "provider_subagent" }>[];
}

export interface AgentSessionConfig {
  provider: AgentProvider;
  /** Trusted controller registration only. Ordinary launch/resume must refuse. */
  controllerExecutionId?: string;
  profileId?: string;
  quotaReservePolicy?: QuotaReserveLaunchPolicy;
  profileLaunch?: AgentProfileLaunch;
  quotaPausedAt?: string;
  quotaResetAt?: string;
  quotaReserve?: QuotaReserveConfig;
  cwd: string;
  /**
   * Provider-agnostic system/developer instruction string.
   * Mapped by each provider to its native instruction field.
   */
  systemPrompt?: string;
  /**
   * Daemon-level instructions appended at runtime. This is deliberately not
   * persisted into agent config so daemon setting changes apply cleanly.
   */
  daemonAppendSystemPrompt?: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  title?: string | null;
  providerOptions?: ProviderOptions;
  toolPolicy?: ToolPolicy;
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   * They are used for ephemeral system tasks like commit/PR generation.
   */
  internal?: boolean;
}

export interface AgentLaunchContext {
  agentId?: string;
  env?: Record<string, string>;
  /**
   * Runtime-only internal Paseo tools. This must never be persisted into
   * AgentSessionConfig; providers may adapt it to their native tool surface.
   */
  paseoTools?: PaseoToolCatalog;
}

export interface AgentCreateSessionOptions {
  /**
   * Whether the provider should leave a durable native session behind.
   * Defaults to true. Providers that cannot honor false should no-op.
   */
  persistSession?: boolean;
}

/** What a resumed session is for: driving the agent, or reading what it already did. */
export type AgentResumePurpose = "interactive" | "history";

/** Runtime-only intent for a persisted-session resume. Never persist this option. */
export interface AgentResumeSessionOptions {
  /** Defaults to interactive. History loading may be read-only for archived native sessions. */
  purpose?: AgentResumePurpose;
}

/**
 * Returned by respondToPermission when the permission resolution requires
 * a follow-up turn (e.g. Codex plan approval → implementation).
 */
export interface AgentPermissionResult {
  followUpPrompt?: AgentPromptInput;
}

export interface QuotaAdmissionRequest {
  observation: import("@getpaseo/protocol/quota-governor").QuotaObservation;
  operation: "start" | "steer" | "compact";
  threadId: string | null;
  nativeTurnId: string | null;
}

export interface QuotaAdmissionPermit {
  /** Synchronously reject expired or revoked execution/policy/authentication authority. */
  assertValidForDispatch(): void;
}

/**
 * Runtime-only coordinator boundary. A denial must throw, without awaiting
 * interruption of the admitting session: its pending start is waiting on this hook.
 */
export type QuotaAdmissionGuard = (request: QuotaAdmissionRequest) => Promise<QuotaAdmissionPermit>;

/** Trusted runtime input, never accepted from a worker tool or persisted as a callback. */
export interface QuotaGovernedSessionInput {
  /** Host-local retained placement, supplied only by the trusted controller. */
  placement?: {
    hostId: string;
    projectId: string;
    projectRoot: string;
    projectKey: string;
    workspaceId: string;
  };
  /** Trusted controller callbacks, never accepted from public agent config. */
  inspection?: {
    executionId: string;
    title: string;
    stop(): Promise<void>;
    assertSettled(): Promise<void>;
  };
  config: AgentSessionConfig;
  account: import("@getpaseo/protocol/quota-governor").QuotaAccount;
  guard: QuotaAdmissionGuard;
  /** Coordinator-selected native profile. The coordinator must verify its filesystem and tool policy. */
  permissionProfile?: string;
  /** Trusted host callback only. Tokens travel over provider stdin, never worker configuration. */
  externalChatgptAuth?: {
    assertCurrent(): void;
    readTokens(reason: "initial" | "unauthorized"): Promise<{
      accessToken: string;
      chatgptAccountId: string;
      chatgptPlanType?: string | null;
    }>;
  };
  /** Trusted launcher owns its environment and settlement of every descendant. */
  processCustody?: {
    spawn(command: string, args: string[]): Promise<ChildProcessWithoutNullStreams>;
    settle(child: ChildProcessWithoutNullStreams): Promise<void>;
  };
  launchContext?: AgentLaunchContext;
  resumeHandle?: AgentPersistenceHandle;
}

export interface CapturedQuotaExecutionClient {
  openSession(input: QuotaGovernedSessionInput): Promise<AgentSession>;
  /** Call inside the execution authority guard, including immediately before dispatch. */
  assertCurrent(): void;
}

/** Retains trusted cleanup custody when native construction cannot prove disposal. */
export class QuotaConstructionCleanupError extends Error {
  constructor(readonly retryCleanup: () => Promise<void>) {
    super("Quota session construction cleanup is unresolved; account construction is fenced.");
    this.name = "QuotaConstructionCleanupError";
  }
}

export interface AgentGoals {
  readonly state: import("@getpaseo/protocol/agent-goals").AgentGoalState;
  read(): Promise<import("@getpaseo/protocol/agent-goals").AgentGoalState>;
  set(
    input: import("@getpaseo/protocol/agent-goals").AgentGoalSetInput,
  ): Promise<import("@getpaseo/protocol/agent-goals").AgentGoalState>;
  clear(): Promise<import("@getpaseo/protocol/agent-goals").AgentGoalState>;
}

export interface AgentUsageSession {
  provider: string;
  model?: string;
  env: Record<string, string>;
  sessionKey: string;
}

export interface AgentSession {
  usageSession?(): AgentUsageSession | null;
  readonly provider: AgentProvider;
  readonly id: string | null;
  readonly capabilities: AgentCapabilityFlags;
  readonly features?: AgentFeature[];
  readonly goals?: AgentGoals;
  /** New provider-owned rows to commit on registration. streamHistory must also
   * replay them at their original timestamps; restored sessions omit old rows. */
  readonly initialTimeline?: ImportedTimelineEntry[];
  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }>;
  steerActiveTurn?(prompt: AgentPromptInput, options: SteerActiveTurnOptions): Promise<SteerResult>;
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  streamHistory(): AsyncGenerator<AgentStreamEvent>;
  getRuntimeInfo(): Promise<AgentRuntimeInfo>;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode(modeId: string): Promise<void | AgentProviderNotice>;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
  describePersistence(): AgentPersistenceHandle | null;
  /** Read quota through this execution's own authenticated provider connection. */
  readQuotaObservation?(): Promise<import("@getpaseo/protocol/quota-governor").QuotaObservation>;
  /** Trusted coordinator hook; sticky for this session and absent from worker RPC inputs. */
  setQuotaAdmissionGuard?(guard: QuotaAdmissionGuard): void;
  /**
   * Resolve once every foreground turn that predates this call can no longer run or become active.
   * Calling while already idle is a successful no-op. Reject only when foreground ownership is
   * still uncertain.
   */
  interrupt(): Promise<void>;
  /** Release live runtime resources without archiving or deleting the durable native session. */
  close(): Promise<void>;
  listCommands?(): Promise<AgentSlashCommand[]>;
  setModel?(modelId: string | null): Promise<void>;
  setThinkingOption?(thinkingOptionId: string | null): Promise<void | AgentProviderNotice>;
  setFeature?(featureId: string, value: unknown): Promise<void>;
  revertConversation?(input: { messageId: string }): Promise<void>;
  revertFiles?(input: { messageId: string }): Promise<void>;
  revertBoth?(input: { messageId: string }): Promise<void>;
  /**
   * Out-of-band prompt handler. When non-null, the manager runs the returned
   * handler instead of allocating a turn. The handler emits stream events
   * directly via the provided `emit` callback, which routes through the
   * manager's persistence + broadcast pipeline. The active foreground turn
   * (if any) is left untouched, so this is how mid-turn side-effect commands
   * (e.g. /goal pause) reach the provider without canceling the running turn.
   */
  tryHandleOutOfBand?(prompt: AgentPromptInput): {
    intent?: "goal";
    run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void>;
  } | null;
}

export type FetchCatalogOptions = { providerOptions?: ProviderOptions } & (
  | {
      scope: "global";
      force: boolean;
    }
  | {
      scope: "workspace";
      cwd: string;
      force: boolean;
    }
);

export interface ProviderRefreshContext {
  readonly signal: AbortSignal;
  /** Track an upstream operation so timeout errors identify the work still pending. */
  runActivity<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

export interface ProviderCatalog {
  models: AgentModelDefinition[];
  modes: AgentMode[];
  defaultModeId?: string | null;
}

export interface ResolveAgentDefaultModeInput {
  config: AgentSessionConfig;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ProviderQuotaObservationSession {
  read(): Promise<import("@getpaseo/protocol/quota-governor").QuotaObservation>;
  dispose(): Promise<void>;
}

/** Providers may report this only after confirming disposal of a failed observer. */
export class QuotaObserverDisposedError extends Error {
  constructor() {
    super("Quota observer initialization failed after confirmed disposal.");
  }
}

export interface ProviderResetCreditSession {
  readonly canRedeem: boolean;
  readonly canSelectCredit?: boolean;
  read(): Promise<ProviderResetSnapshot>;
  consume(attempt: ProviderResetAttempt): Promise<ProviderResetOutcome>;
  dispose(): Promise<void>;
}

export interface AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;
  createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession>;
  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession>;
  /** Equal keys share availability and catalogue discovery within this configured client.
   * Include the execution environment and effective configuration; omit to use target identity.
   * force must not affect identity. Resolve before every cache lookup. */
  getCatalogCacheKey?(options: FetchCatalogOptions): Promise<string | undefined>;
  /**
   * Discover models and modes together. Implementations may use one upstream
   * process, separate upstream calls, static modes, or private helpers; callers
   * outside the provider do not get separate runtime model/mode probes.
   * The registry is responsible for merging configured model overrides.
   * ProviderSnapshotManager supplies a shared context. Providers must pass its
   * signal downstream and finish resource cleanup before rejecting on abort.
   */
  fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog>;
  /** Apply provider-owned defaults to a model supplied through provider configuration. */
  resolveConfiguredModel?(model: AgentModelDefinition): AgentModelDefinition;
  resolveDefaultModeId?(input: ResolveAgentDefaultModeInput): Promise<string | undefined>;
  resolveCreateConfig?(input: ResolveAgentCreateConfigInput): ResolveAgentCreateConfigResult;
  isCreateConfigUnattended?(input: AgentCreateConfigUnattendedInput): boolean;
  listCommands?(config: AgentSessionConfig): Promise<AgentSlashCommand[]>;
  listFeatures?(config: AgentSessionConfig): Promise<AgentFeature[]>;
  listImportableSessions?(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]>;
  importSession?(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession>;
  /**
   * Check availability in the catalogue target when supplied (CLI binary is installed).
   * Returns true if available, false otherwise.
   */
  isAvailable(signal?: AbortSignal, options?: FetchCatalogOptions): Promise<boolean>;
  getDiagnostic?(): Promise<{ diagnostic: string }>;
  /** Account management only. Never attach this operation to the agent tool catalog. */
  openResetCreditSession?(): Promise<ProviderResetCreditSession>;
  /** Read-only account telemetry. This connection must never start inference. */
  openQuotaObservationSession?(): Promise<ProviderQuotaObservationSession>;
  /** Construct protection before native connection. Unsupported providers must not fall back. */
  openQuotaGovernedSession?(input: QuotaGovernedSessionInput): Promise<AgentSession>;
  openAccountLoginSession?(): Promise<ProviderLoginSession>;
  /**
   * Archive a durable native session (best-effort). Runtime release belongs to AgentSession.close().
   * Called when Paseo archives an agent so the provider's own UI reflects the same state.
   */
  archiveNativeSession?(handle: AgentPersistenceHandle): Promise<void>;
  /**
   * Unarchive a durable native session in the provider.
   * Called before Paseo clears its archived flag so provider resume can succeed.
   */
  unarchiveNativeSession?(handle: AgentPersistenceHandle): Promise<void>;
  /**
   * Release any provider-owned resources held by this client (background
   * processes, sockets, cached subprocesses, etc.). Called when the daemon
   * shuts down. Must be idempotent.
   */
  shutdown?(): Promise<void>;
}
