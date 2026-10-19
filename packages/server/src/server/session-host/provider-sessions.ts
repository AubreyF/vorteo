import type { Logger } from "pino";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import { createAgentSessionPort } from "./agent-session-port.js";
import type { HostedSessionFactory } from "./host.js";
import { HostedOpenRequestSchema } from "./session-contract.js";

/** Builds the provider client a hosted session runs on, from the settings the worker sent. */
export type HostedClientFactory = (input: {
  provider: string;
  runtimeSettings?: ProviderRuntimeSettings;
  logger: Logger;
}) => AgentClient;

/** Phase 1 runs Claude sessions only. */
export const HOSTED_PROVIDERS: readonly string[] = ["claude"];

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
export function createProviderSessionFactory(input: {
  logger: Logger;
  createClient: HostedClientFactory;
  providers?: readonly string[];
}): HostedSessionFactory {
  const providers = input.providers ?? HOSTED_PROVIDERS;
  return async ({ provider, config }) => {
    if (!providers.includes(provider))
      throw new HostedOpenRefusedError(`The session host does not run ${provider} sessions.`);
    const parsed = HostedOpenRequestSchema.safeParse(config);
    if (!parsed.success) throw new HostedOpenRefusedError("The session open request is malformed.");
    const request = parsed.data;
    const client = input.createClient({
      provider,
      runtimeSettings: request.runtimeSettings as ProviderRuntimeSettings | undefined,
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
  };
}
