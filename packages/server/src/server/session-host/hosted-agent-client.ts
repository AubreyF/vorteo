import type { Logger } from "pino";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import { createProviderEnv } from "../agent/provider-launch-config.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import { SessionHostClientError, type HostedSession, type SessionHostClient } from "./client.js";
import type { SessionHostConnector } from "./connector.js";
import {
  DEFAULT_REATTACH_POLICY,
  HostedAgentSession,
  HostedReattachPendingError,
  type HostedReattachment,
  type HostedReattachPolicy,
} from "./hosted-agent-session.js";
import type { HostedOpenRequest } from "./session-contract.js";
import type { AppliedSeqStore } from "./applied-store.js";
import { withPaseoMcpAuthToken } from "../agent/runtime-mcp-config.js";

/** What a provider client needs to route eligible sessions through the session host. */
export interface HostedSessionRouting {
  connector: SessionHostConnector;
  /** Read for every new session, so the setting can be turned off without a restart. */
  isEnabled(): boolean;
  logger: Logger;
  /** How long and how often a hosted session keeps trying to reattach. Defaults suit production. */
  reattach?: HostedReattachPolicy;
  /** Records the last event each hosted agent applied, for the next worker's rebuild. */
  applied?: AppliedSeqStore;
  /** Sessions attached at startup and waiting for their agent to load. */
  adoptions?: Map<string, HostedAdoption>;
  /** Called when the host no longer runs an agent's session, so the agent continues elsewhere. */
  onSessionLost?(agentId: string): void;
}

/**
 * A running hosted session this worker attached at startup. Loading its agent adopts it instead of
 * starting a provider: the attachment was made after the events this worker's predecessor applied.
 */
export interface HostedAdoption {
  channel: HostedSession;
  hostId: string;
  throughSeq: number;
  lossy: boolean;
  /** Receives the adopted session, so startup can release its held events. */
  onAdopted?(session: HostedAgentSession): void;
}

/**
 * The host still holds this agent's session but did not answer within the reattach window.
 * Starting the agent in the worker would put a second provider on its conversation.
 */
export class SessionHostUnresponsiveError extends Error {
  constructor(readonly agentId: string) {
    super(
      "The session host still runs this agent's session but is not answering. Try again shortly.",
    );
    this.name = "SessionHostUnresponsiveError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

interface EligibilityInput {
  config: AgentSessionConfig;
  launchContext?: AgentLaunchContext;
  persistSession?: boolean;
}

/**
 * Only real, persistent agent sessions are hosted. Throwaway sessions (command discovery passes no
 * agent id), internal helpers and non-persistent runs stay in the worker, where they already end
 * with the operation that started them.
 */
function isHostable(input: EligibilityInput): input is EligibilityInput & {
  launchContext: AgentLaunchContext & { agentId: string };
} {
  return (
    typeof input.launchContext?.agentId === "string" &&
    input.launchContext.agentId.length > 0 &&
    input.persistSession !== false &&
    input.config.internal !== true
  );
}

function toJson<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/**
 * Wraps a provider client so eligible sessions run in the session host when durable sessions are
 * enabled and the host answers. Everything else, including catalog discovery and every session the
 * host cannot take, uses the wrapped client unchanged.
 */
export function createHostedAgentClient(input: {
  inner: AgentClient;
  runtimeSettings?: ProviderRuntimeSettings;
  routing: HostedSessionRouting;
}): AgentClient {
  const { inner, routing } = input;
  const logger = routing.logger.child({ module: "session-host", provider: inner.provider });

  /**
   * Null means the host no longer runs the session. Anything short of that, such as a host that is
   * slow to answer or at its connection limit, throws HostedReattachPendingError so the session
   * tries again instead of failing a turn the provider is still running.
   */
  function reattacher(agentId: string) {
    return async (afterSeq: number): Promise<HostedReattachment | null> => {
      const client = await routing.connector.connect({ force: true });
      if (!client) throw new HostedReattachPendingError("The session host is not answering yet.");
      try {
        return { channel: await client.attach({ sessionId: agentId, afterSeq }), lossy: false };
      } catch (error) {
        if (error instanceof SessionHostClientError && error.code === "not_found") return null;
        if (!(error instanceof SessionHostClientError) || error.code !== "replay_unavailable")
          throw new HostedReattachPendingError("Reattaching did not finish.", { cause: error });
      }
      // Keep the turn running and mark what was missed rather than ending the session.
      return { channel: await client.attach({ sessionId: agentId, afterSeq: null }), lossy: true };
    };
  }

  function hostedSession(params: {
    channel: HostedSession;
    agentId: string;
    hostId: string;
    model: string | undefined;
    launchEnv: Record<string, string> | undefined;
    rebuild?: { throughSeq: number; lossy: boolean };
  }): HostedAgentSession {
    return new HostedAgentSession({
      provider: inner.provider,
      capabilities: inner.capabilities,
      channel: params.channel,
      reattach: reattacher(params.agentId),
      reattachPolicy: routing.reattach,
      hostState: () => routing.connector.hostState(),
      usage: {
        model: params.model,
        env: createProviderEnv({
          baseEnv: process.env,
          runtimeSettings: input.runtimeSettings,
          overlays: [params.launchEnv],
        }) as Record<string, string>,
      },
      applied: routing.applied
        ? { store: routing.applied, agentId: params.agentId, hostId: params.hostId }
        : undefined,
      rebuild: params.rebuild,
      onLost: () => routing.onSessionLost?.(params.agentId),
      logger,
    });
  }

  /**
   * Attaches to a session the host already runs for this agent and rebuilds it like a startup
   * takeover. Null when the host does not run it after all.
   */
  async function attachExisting(params: {
    client: SessionHostClient;
    agentId: string;
    model: string | undefined;
    launchEnv: Record<string, string> | undefined;
  }): Promise<HostedAgentSession | null> {
    const { client, agentId } = params;
    const record = await routing.applied?.read(agentId);
    const afterSeq = record && record.hostId === client.host.id ? record.lastAppliedSeq : 0;
    let channel: HostedSession;
    let throughSeq = afterSeq;
    let lossy = false;
    try {
      channel = await client.attach({ sessionId: agentId, afterSeq });
    } catch (error) {
      if (!(error instanceof SessionHostClientError)) throw error;
      if (error.code === "not_found") return null;
      if (error.code !== "replay_unavailable") throw error;
      channel = await client.attach({ sessionId: agentId, afterSeq: null });
      throughSeq = channel.attach.lastSeq;
      lossy = true;
    }
    logger.info({ agentId, throughSeq }, "Took over a running hosted session on demand");
    return hostedSession({
      channel,
      agentId,
      hostId: client.host.id,
      model: params.model,
      launchEnv: params.launchEnv,
      rebuild: { throughSeq, lossy },
    });
  }

  /**
   * Connects before a decision that would otherwise start the provider in the worker. A host that
   * is alive but slow gets the reattach window to answer; a host that is gone answers null at once.
   * Unlike a running session, a load does not wait out the longer alive window: the caller sees an
   * error after the reattach window and can try again, and a continuation retried in the meantime
   * repeats the wait until the watchdog has replaced the host.
   */
  async function connectWhileHostLives(agentId: string): Promise<SessionHostClient | null> {
    const policy = routing.reattach ?? DEFAULT_REATTACH_POLICY;
    const deadline = Date.now() + policy.windowMs;
    let delay = policy.initialDelayMs;
    for (;;) {
      const client = await routing.connector.connect({ force: true });
      if (client) return client;
      if ((await routing.connector.hostState()) === "gone") return null;
      if (Date.now() + delay > deadline) throw new SessionHostUnresponsiveError(agentId);
      await sleep(delay);
      delay = Math.min(delay * 2, policy.maxDelayMs);
    }
  }

  /**
   * An agent with an applied record may still have its session in the host, even after the
   * setting was turned off. Starting it in the worker would run two providers on one
   * conversation, so the host is asked first. A record the host no longer backs is dropped, and
   * so is one whose host is gone, since the agent now runs in the worker.
   */
  async function remnant(
    agentId: string | undefined,
    model: string | undefined,
    launchEnv: Record<string, string> | undefined,
  ): Promise<HostedAgentSession | null> {
    if (!agentId || !routing.applied || !(await routing.applied.read(agentId))) return null;
    const client = await connectWhileHostLives(agentId);
    const session = client ? await attachExisting({ client, agentId, model, launchEnv }) : null;
    if (!session) await routing.applied.remove(agentId);
    return session;
  }

  /** Hosted providers outlive this worker, so their tool server uses the host's token. */
  function withHostToken(request: HostedOpenRequest, token: string): HostedOpenRequest {
    const config = withPaseoMcpAuthToken(request.config as unknown as AgentSessionConfig, token);
    const overrides = request.overrides
      ? withPaseoMcpAuthToken(request.overrides as Partial<AgentSessionConfig>, token)
      : undefined;
    return {
      ...request,
      config: config as unknown as HostedOpenRequest["config"],
      ...(overrides ? { overrides: overrides as HostedOpenRequest["overrides"] } : {}),
    };
  }

  async function open(
    params: {
      request: HostedOpenRequest;
      agentId: string;
      config: AgentSessionConfig;
      launchContext: AgentLaunchContext;
    },
    retried = false,
  ): Promise<AgentSession | null> {
    const client: SessionHostClient | null = await routing.connector.connect();
    if (!client) return null;
    let channel: HostedSession;
    try {
      channel = await client.open({
        sessionId: params.agentId,
        provider: inner.provider,
        config: withHostToken(params.request, client.mcpToken) as unknown as JsonValue,
      });
    } catch (error) {
      // The host already runs this agent's session: take it over rather than start another.
      if (error instanceof SessionHostClientError && error.code === "conflict") {
        const existing = await attachExisting({
          client,
          agentId: params.agentId,
          model: params.config.model,
          launchEnv: params.launchContext.env,
        });
        if (existing) return existing;
        // It ended between the open and the attach: open once more, never loop.
        return retried ? null : open(params, true);
      }
      logger.warn(
        { err: error, agentId: params.agentId },
        "The session host could not open a session; it runs in the worker",
      );
      return null;
    }
    logger.info({ agentId: params.agentId, kind: params.request.kind }, "Opened a hosted session");
    return hostedSession({
      channel,
      agentId: params.agentId,
      hostId: client.host.id,
      model: params.config.model,
      launchEnv: params.launchContext.env,
    });
  }

  /**
   * A session attached at startup is adopted whichever way its agent loads, and even if the
   * setting was turned off since, so the turn it is running can finish.
   */
  function adopt(
    config: AgentSessionConfig,
    launchContext: AgentLaunchContext | undefined,
  ): HostedAgentSession | null {
    const agentId = launchContext?.agentId;
    const adoption = agentId ? routing.adoptions?.get(agentId) : undefined;
    if (!agentId || !adoption) return null;
    routing.adoptions?.delete(agentId);
    const session = hostedSession({
      channel: adoption.channel,
      agentId,
      hostId: adoption.hostId,
      model: config.model,
      launchEnv: launchContext?.env,
      rebuild: { throughSeq: adoption.throughSeq, lossy: adoption.lossy },
    });
    adoption.onAdopted?.(session);
    logger.info({ agentId, throughSeq: adoption.throughSeq }, "Adopted a hosted session");
    return session;
  }

  async function createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const adopted = adopt(config, launchContext);
    if (adopted) return adopted;
    const eligibility = { config, launchContext, persistSession: options?.persistSession };
    if (routing.isEnabled() && isHostable(eligibility)) {
      const hosted = await open({
        agentId: eligibility.launchContext.agentId,
        config,
        launchContext: eligibility.launchContext,
        request: {
          kind: "create",
          agentId: eligibility.launchContext.agentId,
          config: toJson(config),
          launchEnv: launchContext?.env,
          runtimeSettings: input.runtimeSettings ? toJson(input.runtimeSettings) : undefined,
          persistSession: options?.persistSession,
        },
      });
      if (hosted) return hosted;
    }
    const existing = await remnant(launchContext?.agentId, config.model, launchContext?.env);
    if (existing) return existing;
    return inner.createSession(config, launchContext, options);
  }

  async function resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: Parameters<AgentClient["resumeSession"]>[3],
  ): Promise<AgentSession> {
    const config = {
      ...(handle.metadata as Partial<AgentSessionConfig> | undefined),
      ...overrides,
    } as AgentSessionConfig;
    const eligibility = { config, launchContext };
    const adopted = options?.purpose === "history" ? null : adopt(config, launchContext);
    if (adopted) return adopted;
    // Reading saved history needs no running provider, so it stays in the worker.
    if (options?.purpose !== "history" && routing.isEnabled() && isHostable(eligibility)) {
      const hosted = await open({
        agentId: eligibility.launchContext.agentId,
        config,
        launchContext: eligibility.launchContext,
        request: {
          kind: "resume",
          agentId: eligibility.launchContext.agentId,
          config: toJson({ ...config, provider: inner.provider, cwd: config.cwd ?? "" }),
          launchEnv: launchContext?.env,
          runtimeSettings: input.runtimeSettings ? toJson(input.runtimeSettings) : undefined,
          handle: toJson(handle),
          overrides: overrides ? toJson(overrides) : undefined,
        },
      });
      if (hosted) return hosted;
    }
    if (options?.purpose !== "history") {
      const existing = await remnant(launchContext?.agentId, config.model, launchContext?.env);
      if (existing) return existing;
    }
    return inner.resumeSession(handle, overrides, launchContext, options);
  }

  // Every member forwards unless the host changes it, so new client capabilities are not lost.
  return {
    provider: inner.provider,
    get capabilities() {
      return inner.capabilities;
    },
    createSession,
    resumeSession,
    getCatalogCacheKey: inner.getCatalogCacheKey?.bind(inner),
    fetchCatalog: (options, context) => inner.fetchCatalog(options, context),
    resolveConfiguredModel: inner.resolveConfiguredModel?.bind(inner),
    resolveDefaultModeId: inner.resolveDefaultModeId?.bind(inner),
    resolveCreateConfig: inner.resolveCreateConfig?.bind(inner),
    isCreateConfigUnattended: inner.isCreateConfigUnattended?.bind(inner),
    listCommands: inner.listCommands?.bind(inner),
    listFeatures: inner.listFeatures?.bind(inner),
    listImportableSessions: inner.listImportableSessions?.bind(inner),
    importSession: inner.importSession?.bind(inner),
    isAvailable: (signal, options) => inner.isAvailable(signal, options),
    getDiagnostic: inner.getDiagnostic?.bind(inner),
    openResetCreditSession: inner.openResetCreditSession?.bind(inner),
    openQuotaObservationSession: inner.openQuotaObservationSession?.bind(inner),
    // Quota-governed sessions need trusted in-process callbacks; they never run in the host.
    openQuotaGovernedSession: inner.openQuotaGovernedSession?.bind(inner),
    openAccountLoginSession: inner.openAccountLoginSession?.bind(inner),
    archiveNativeSession: inner.archiveNativeSession?.bind(inner),
    unarchiveNativeSession: inner.unarchiveNativeSession?.bind(inner),
    shutdown: inner.shutdown?.bind(inner),
  } satisfies { [K in keyof Required<AgentClient>]: AgentClient[K] };
}
