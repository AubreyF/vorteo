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

export class HostedSessionConflictError extends Error {
  constructor(readonly agentId: string) {
    super("This agent's session is still running in the session host.");
    this.name = "HostedSessionConflictError";
  }
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
      logger,
    });
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

  async function open(params: {
    request: HostedOpenRequest;
    agentId: string;
    config: AgentSessionConfig;
    launchContext: AgentLaunchContext;
  }): Promise<AgentSession | null> {
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
      // Never start a second provider process for a session the host still runs.
      if (error instanceof SessionHostClientError && error.code === "conflict")
        throw new HostedSessionConflictError(params.agentId);
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
