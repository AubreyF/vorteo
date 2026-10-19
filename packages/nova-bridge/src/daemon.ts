import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";
import {
  CallToolResultSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Target } from "./config.js";

export type ReadClient = Pick<
  DaemonClient,
  "fetchAgentTimeline" | "searchAgentTimeline" | "readFile" | "getCheckoutDiff" | "observeAgents"
> & {
  // Inventory reads never acquire owned subscriptions. Keep their overloads
  // separate from observeAgents so adapters cannot accidentally leak one.
  fetchAgents(
    options?: Omit<NonNullable<Parameters<DaemonClient["fetchAgents"]>[0]>, "subscribe"> & {
      subscribe?: never;
    },
  ): ReturnType<DaemonClient["fetchAgents"]>;
  fetchWorkspaces(
    options?: Omit<NonNullable<Parameters<DaemonClient["fetchWorkspaces"]>[0]>, "subscribe"> & {
      subscribe?: never;
    },
  ): ReturnType<DaemonClient["fetchWorkspaces"]>;
};
export interface DaemonAccess {
  readClient(): Promise<ReadClient>;
  listTools(): Promise<Tool[]>;
  callTool(name: string, input: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
export interface ToolSession {
  list(cursor?: string): Promise<{ tools: Tool[]; nextCursor?: string }>;
  call(name: string, input: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
export interface DaemonPorts {
  connect(): Promise<void>;
  connected(): boolean;
  serverId(): string | null;
  read: ReadClient;
  openTools(): Promise<ToolSession>;
  close(): Promise<void>;
}

function nativePorts(target: Target): DaemonPorts {
  const client = new DaemonClient({
    url: `ws://${target.endpoint}/ws`,
    password: target.password,
    expectedServerId: target.serverId,
    clientId: `nova-bridge-${randomUUID()}`,
    clientType: "mcp",
    connectTimeoutMs: 5000,
    reconnect: { enabled: true },
    webSocketFactory: (url, options) => {
      const socket = new WebSocket(url, options?.protocols, { headers: options?.headers });
      return {
        get readyState() {
          return socket.readyState;
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        on: (event, listener) => {
          socket.on(event, listener);
        },
        off: (event, listener) => {
          socket.off(event, listener);
        },
      };
    },
  });
  return {
    connect: () => client.connect(),
    connected: () => client.getConnectionState().status === "connected",
    serverId: () => client.getLastServerInfoMessage()?.serverId ?? null,
    read: client,
    close: () => client.close(),
    async openTools() {
      const mcp = new Client({ name: "vorteo-nova-bridge", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://${target.endpoint}/mcp/agents`),
        {
          requestInit: { headers: { Authorization: `Bearer ${target.password}` } },
        },
      );
      try {
        await mcp.connect(transport);
      } catch (error) {
        await mcp.close();
        throw error;
      }
      return {
        list: (cursor) => mcp.listTools({ cursor }),
        call: async (name, input) =>
          CallToolResultSchema.parse(await mcp.callTool({ name, arguments: input })),
        close: () => mcp.close(),
      };
    },
  };
}

/** Reads use the identity-verified socket; writes use the native MCP tool path.
 * Top-level machine-origin attribution is a separately verified server contract. */
export class DaemonConnection implements DaemonAccess {
  private connecting: Promise<void> | null = null;
  private readonly ports: DaemonPorts;
  constructor(
    private readonly target: Target,
    ports?: DaemonPorts,
  ) {
    this.ports = ports ?? nativePorts(target);
  }
  async readClient(): Promise<ReadClient> {
    if (!this.connecting)
      this.connecting = this.ports.connect().catch((error: unknown) => {
        this.connecting = null;
        throw error;
      });
    await this.connecting;
    if (!this.ports.connected()) throw new Error("Daemon is disconnected");
    if (this.ports.serverId() !== this.target.serverId)
      throw new Error("Daemon identity was not verified");
    return this.ports.read;
  }
  private async withTools<T>(run: (session: ToolSession) => Promise<T>): Promise<T> {
    await this.readClient();
    const session = await this.ports.openTools();
    try {
      return await run(session);
    } finally {
      await session.close();
    }
  }
  async listTools(): Promise<Tool[]> {
    return this.withTools(async (session) => {
      const tools: Tool[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await session.list(cursor);
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("Repeated tool catalog cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return tools;
    });
  }
  async callTool(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
    return this.withTools((session) => session.call(name, input));
  }
  async close(): Promise<void> {
    await this.ports.close();
  }
}
