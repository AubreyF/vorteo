import type { Logger } from "pino";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import {
  internalPaseoMcpServerUrl,
  withRelayedPaseoMcpServer,
} from "../agent/runtime-mcp-config.js";
import { createAgentSessionPort } from "./agent-session-port.js";
import type { HostedSessionFactory, HostedSessionPort } from "./host.js";
import { HostedOpenRequestSchema, type HostedOpenRequest } from "./session-contract.js";
import { isToolRelayServer } from "./tool-relay-config.js";
import type { ToolRelay, ToolRelaySession } from "./tool-relay.js";

/** Builds the provider client a hosted session runs on, from the settings the worker sent. */
export type HostedClientFactory = (input: {
  provider: string;
  runtimeSettings?: ProviderRuntimeSettings;
  /** A derived provider (an account) the worker would have built the client for. */
  customProvider?: { id: string; label: string; extends: string };
  logger: Logger;
}) => AgentClient;

/** Phase 1 ran Claude only; phase 2 adds Codex. Derived account providers report these base ids. */
export const HOSTED_PROVIDERS: readonly string[] = ["claude", "codex"];

export class HostedOpenRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedOpenRefusedError";
  }
}

/**
 * Turns a worker's open request into a provider session inside the host. Requests carry
 * credentials in their environment, so validation errors never echo the request.
 */
type McpServers = Pick<AgentSessionConfig, "mcpServers">;

/**
 * Points the provider at the relay instead of the daemon: the worker's direct server becomes the
 * relay's stdio form in whichever part of the request carries it, and a relay left in a saved
 * handle by an earlier host is dropped, since its socket is gone.
 */
function withRelay(request: HostedOpenRequest, relay: ToolRelaySession): HostedOpenRequest {
  const next = { ...request };
  next.config = withRelayedPaseoMcpServer(
    request.config as McpServers,
    relay.server,
  ) as typeof request.config;
  if (request.overrides)
    next.overrides = withRelayedPaseoMcpServer(
      request.overrides as McpServers,
      relay.server,
    ) as typeof request.overrides;
  return next;
}

function withoutStaleRelay(request: HostedOpenRequest): HostedOpenRequest {
  const handle = request.handle;
  const servers = (handle?.metadata as McpServers | undefined)?.mcpServers;
  const paseo = servers?.paseo;
  if (!handle || !servers || !paseo || !isToolRelayServer(paseo)) return request;
  const { paseo: _stale, ...kept } = servers;
  const metadata = { ...handle.metadata, mcpServers: kept } as unknown as typeof handle.metadata;
  return { ...request, handle: { ...handle, metadata } };
}

/** The daemon URL the worker injected for this session's tools, in the part of the request that carries it. */
function directToolUrl(request: HostedOpenRequest): string | null {
  const carrier = request.kind === "create" ? request.config : request.overrides;
  return carrier ? internalPaseoMcpServerUrl(carrier as McpServers) : null;
}

/** A port whose close also ends the session's relay. */
function withRelayClose(port: HostedSessionPort, relay: ToolRelaySession): HostedSessionPort {
  return {
    ...port,
    async close() {
      try {
        await port.close();
      } finally {
        await relay.close();
      }
    },
  };
}

export function createProviderSessionFactory(input: {
  logger: Logger;
  createClient: HostedClientFactory;
  providers?: readonly string[];
  /** When present, hosted providers reach the daemon's tools through the host. */
  toolRelay?: ToolRelay | null;
}): HostedSessionFactory {
  const providers = input.providers ?? HOSTED_PROVIDERS;
  return async ({ sessionId, provider, config }) => {
    if (!providers.includes(provider))
      throw new HostedOpenRefusedError(`The session host does not run ${provider} sessions.`);
    const parsed = HostedOpenRequestSchema.safeParse(config);
    if (!parsed.success) throw new HostedOpenRefusedError("The session open request is malformed.");
    let request = withoutStaleRelay(parsed.data);
    let relay: ToolRelaySession | null = null;
    const url = input.toolRelay ? directToolUrl(request) : null;
    if (url && input.toolRelay) {
      relay = await input.toolRelay.open(sessionId, url);
      if (relay) request = withRelay(request, relay);
    }
    try {
      const port = await openProviderSession(input, provider, request);
      return relay ? withRelayClose(port, relay) : port;
    } catch (error) {
      await relay?.close();
      throw error;
    }
  };
}

async function openProviderSession(
  input: { logger: Logger; createClient: HostedClientFactory },
  provider: string,
  request: HostedOpenRequest,
): Promise<HostedSessionPort> {
  {
    const client = input.createClient({
      provider,
      runtimeSettings: request.runtimeSettings as ProviderRuntimeSettings | undefined,
      ...(request.customProvider ? { customProvider: request.customProvider } : {}),
      logger: input.logger,
    });
    const launchContext: AgentLaunchContext = { agentId: request.agentId, env: request.launchEnv };
    let session;
    if (request.kind === "create") {
      session = await client.createSession(
        request.config as AgentSessionConfig,
        launchContext,
        request.persistSession === undefined
          ? undefined
          : { persistSession: request.persistSession },
      );
    } else {
      if (!request.handle)
        throw new HostedOpenRefusedError("Resuming a session requires its persistence handle.");
      session = await client.resumeSession(
        request.handle as AgentPersistenceHandle,
        request.overrides as Partial<AgentSessionConfig> | undefined,
        launchContext,
      );
    }
    try {
      return await createAgentSessionPort(session);
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
  }
}
