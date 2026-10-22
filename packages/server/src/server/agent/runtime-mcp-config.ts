import { isToolRelayServer } from "../session-host/tool-relay-config.js";
import type {
  AgentSessionConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "./agent-sdk-types.js";

const PASEO_MCP_SERVER_NAME = "paseo";
const PASEO_MCP_PATHNAME = "/mcp/agents";

export function stripInternalPaseoMcpServer(config: AgentSessionConfig): AgentSessionConfig {
  const mcpServers = config.mcpServers;
  if (!mcpServers) {
    return config;
  }

  const paseoServer = mcpServers[PASEO_MCP_SERVER_NAME];
  if (!paseoServer || !isInternalPaseoMcpServer(paseoServer)) {
    return config;
  }

  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers[PASEO_MCP_SERVER_NAME];

  const next = { ...config };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

export function withRuntimePaseoMcpServer(params: {
  config: AgentSessionConfig;
  agentId: string;
  mcpBaseUrl: string | null;
  /**
   * Capability token authenticating the injected connection to the daemon's
   * Agent MCP endpoint. The daemon password is gated off this route, so without
   * this header the agent's MCP requests are rejected when a password is set.
   */
  mcpAuthToken: string | null;
}): AgentSessionConfig {
  const storedConfig = stripInternalPaseoMcpServer(params.config);
  if (!params.mcpBaseUrl || storedConfig.mcpServers?.[PASEO_MCP_SERVER_NAME]) {
    return storedConfig;
  }

  return {
    ...storedConfig,
    mcpServers: {
      [PASEO_MCP_SERVER_NAME]: {
        type: "http",
        url: `${params.mcpBaseUrl}?callerAgentId=${params.agentId}`,
        ...(params.mcpAuthToken
          ? { headers: { Authorization: `Bearer ${params.mcpAuthToken}` } }
          : {}),
      },
      ...storedConfig.mcpServers,
    },
  };
}

/**
 * Points the injected Paseo server at a different capability token, leaving every other server
 * unchanged. Durable hosted sessions use the session host's token, which outlives this daemon run.
 */
export function withPaseoMcpAuthToken<T extends Pick<AgentSessionConfig, "mcpServers">>(
  config: T,
  token: string,
): T {
  const server = config.mcpServers?.[PASEO_MCP_SERVER_NAME];
  if (!server || !isInternalPaseoMcpServer(server) || server.type === "stdio") return config;
  return {
    ...config,
    mcpServers: {
      ...config.mcpServers,
      [PASEO_MCP_SERVER_NAME]: {
        ...server,
        headers: { ...server.headers, Authorization: `Bearer ${token}` },
      },
    },
  };
}

/**
 * The daemon URL the injected server points at, when the config carries the direct form. The
 * session host opens its tool relay toward this URL.
 */
export function internalPaseoMcpServerUrl(
  config: Pick<AgentSessionConfig, "mcpServers">,
): string | null {
  const server = config.mcpServers?.[PASEO_MCP_SERVER_NAME];
  if (!server || server.type === "stdio" || !isInternalPaseoMcpServer(server)) return null;
  return server.url;
}

/**
 * Replaces the injected direct server with the session host's relay form, leaving every other
 * server unchanged. A config without the injected server is returned as is.
 */
export function withRelayedPaseoMcpServer<T extends Pick<AgentSessionConfig, "mcpServers">>(
  config: T,
  relay: McpStdioServerConfig,
): T {
  const current = config.mcpServers?.[PASEO_MCP_SERVER_NAME];
  if (!current || !isInternalPaseoMcpServer(current)) return config;
  return {
    ...config,
    mcpServers: {
      ...config.mcpServers,
      [PASEO_MCP_SERVER_NAME]: {
        ...relay,
        ...(current.alwaysLoad === true ? { alwaysLoad: true } : {}),
      },
    },
  };
}

/**
 * The injected server in either form: the direct connection the worker injects, or the session
 * host's stdio relay that replaced it inside the host. Both are the daemon's own tools and never
 * belong in a stored config.
 */
function isInternalPaseoMcpServer(config: McpServerConfig): boolean {
  if (config.type === "stdio") return isToolRelayServer(config);
  if (config.type !== "http" && config.type !== "sse") {
    return false;
  }

  try {
    return new URL(config.url).pathname === PASEO_MCP_PATHNAME;
  } catch {
    return false;
  }
}
