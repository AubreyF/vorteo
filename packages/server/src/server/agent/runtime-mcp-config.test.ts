import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { withPaseoMcpAuthToken, withRuntimePaseoMcpServer } from "./runtime-mcp-config.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
  test("injects the paseo MCP server with a bearer header when a token is provided", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      headers: { Authorization: "Bearer cap-token" },
    });
  });

  test("omits the header when no token is available", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: null,
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
    });
  });

  test("does not inject when no MCP base URL is configured", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: null,
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers).toBeUndefined();
  });
});

describe("withPaseoMcpAuthToken", () => {
  test("swaps only the injected server's bearer token", () => {
    const injected = withRuntimePaseoMcpServer({
      config: {
        ...BASE_CONFIG,
        mcpServers: { other: { type: "http", url: "https://example.test/mcp" } },
      },
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "worker-token",
    });
    const hosted = withPaseoMcpAuthToken(injected, "host-token");
    expect(hosted.mcpServers?.paseo).toMatchObject({
      headers: { Authorization: "Bearer host-token" },
    });
    expect(hosted.mcpServers?.other).toEqual({ type: "http", url: "https://example.test/mcp" });
  });

  test("leaves a config without the injected server untouched", () => {
    const config = {
      ...BASE_CONFIG,
      mcpServers: { paseo: { type: "http" as const, url: "https://elsewhere.test/mcp" } },
    };
    expect(withPaseoMcpAuthToken(config, "host-token")).toBe(config);
  });
});
