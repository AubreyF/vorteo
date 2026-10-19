import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  FetchAgentsResponseMessageSchema,
  FetchWorkspacesResponseMessageSchema,
} from "@getpaseo/protocol/messages";
import type { ReadClient, DaemonAccess } from "./daemon.js";
import { BridgeStore } from "./store.js";
import { BridgeTools } from "./tools.js";
import type { BridgeConfig } from "./config.js";

class MemoryDaemon implements DaemonAccess {
  readonly calls: { name: string; input: Record<string, unknown> }[] = [];
  outcome: "success" | "rejected" | "disconnected" = "success";
  available = true;
  reads: ReadClient | null = null;
  catalog: Tool[] = [
    { name: "send_agent_prompt", inputSchema: { type: "object" } },
    { name: "restart_daemon", inputSchema: { type: "object" } },
  ];
  async readClient(): Promise<ReadClient> {
    if (!this.available) throw new Error("Daemon offline");
    if (this.reads) return this.reads;
    throw new Error("Read connection was not used by this test");
  }
  async listTools(): Promise<Tool[]> {
    if (!this.available) throw new Error("Daemon offline");
    return this.catalog;
  }
  async callTool(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
    this.calls.push({ name, input });
    if (this.outcome === "disconnected") throw new Error("Lost response");
    return {
      isError: this.outcome === "rejected",
      content: [{ type: "text", text: this.outcome }],
    };
  }
  async close(): Promise<void> {}
}
const config: BridgeConfig = {
  port: 18777,
  token: "test-token",
  stateDirectory: "/unused",
  origin: "https://vorteo.example",
  host: { endpoint: "127.0.0.1:1", password: "host", serverId: "host-server" },
  dev: { endpoint: "127.0.0.1:2", password: "dev", serverId: "dev-server" },
};
const stores: BridgeStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-tools-"));
  directories.push(directory);
  const store = new BridgeStore(path.join(directory, "bridge.sqlite"));
  stores.push(store);
  const host = new MemoryDaemon();
  const dev = new MemoryDaemon();
  const tools = new BridgeTools(config, store, { host, dev });
  await tools.discover();
  return { store, host, dev, tools };
}
const request = {
  environment: "dev",
  serverId: "dev-server",
  operationId: "12345678-1234-4234-8234-123456789012",
  input: { agentId: "thread", prompt: "Inspect the diff" },
};

describe("write dispatch", () => {
  it("retains discovery after restart while both environments are offline", async () => {
    const { tools, host, dev, store } = await fixture();
    await tools.close();
    host.available = false;
    dev.available = false;
    const recovered = new BridgeTools(config, store, { host, dev });
    await recovered.discover();
    expect(recovered.list().map((tool) => tool.name)).toContain("send_agent_prompt");
    expect(recovered.list().map((tool) => tool.name)).not.toContain("restart_daemon");
    await recovered.close();
  });

  it("routes once to the chosen environment and rejects cross-environment identity mistakes", async () => {
    const { tools, host, dev, store } = await fixture();
    await expect(
      tools.call("send_agent_prompt", { ...request, serverId: "host-server" }),
    ).rejects.toThrow("Environment and server ID do not match");
    await tools.call("send_agent_prompt", request);
    await tools.call("send_agent_prompt", request);
    await tools.close();
    expect(host.calls).toEqual([]);
    expect(dev.calls).toEqual([
      {
        name: "send_agent_prompt",
        input: {
          agentId: "thread",
          background: true,
          prompt:
            "[Vorteo integration request from Nova. This is an agent-mediated instruction, not a retained owner message. Preserve existing authorization and installation approval boundaries.]\n\nInspect the diff",
        },
      },
    ]);
    expect(store.operation(request.operationId).status).toBe("succeeded");
    expect(tools.list().map((tool) => tool.name)).not.toContain("restart_daemon");
  });

  it("records explicit daemon rejection as failed", async () => {
    const { tools, dev, store } = await fixture();
    dev.outcome = "rejected";
    await tools.call("send_agent_prompt", request);
    await tools.close();
    expect(store.operation(request.operationId).status).toBe("failed");
  });

  it("does not replay a write after a lost response", async () => {
    const { tools, dev, store } = await fixture();
    dev.outcome = "disconnected";
    await tools.call("send_agent_prompt", request);
    await tools.close();
    await tools.call("send_agent_prompt", request);
    expect(store.operation(request.operationId).status).toBe("unknown");
    expect(dev.calls).toHaveLength(1);
  });
});

it("keeps Host and Dev schemas separate and validates against the selected environment", async () => {
  const { tools, host, dev, store } = await fixture();
  host.catalog = [
    {
      name: "send_agent_prompt",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: { prompt: { type: "string" } },
      },
    },
  ];
  dev.catalog = [
    {
      name: "send_agent_prompt",
      inputSchema: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string" } },
      },
    },
  ];
  await tools.discover();
  const tool = tools.list().find((entry) => entry.name === "send_agent_prompt");
  expect(tool?.inputSchema.oneOf).toHaveLength(2);
  await expect(tools.call("send_agent_prompt", request)).rejects.toThrow("schema");
  expect(dev.calls).toEqual([]);
  expect(store.hasOperation(request.operationId)).toBe(false);
  await tools.call("send_agent_prompt", {
    ...request,
    environment: "host",
    serverId: "host-server",
  });
  await tools.close();
  expect(host.calls).toHaveLength(1);
});
it("removes withdrawn tools only from that environment and retains receipts across withdrawal", async () => {
  const { tools, dev, host } = await fixture();
  await tools.call("send_agent_prompt", request);
  await tools.close();
  dev.catalog = [];
  await tools.discover();
  expect(
    tools.list().find((tool) => tool.name === "send_agent_prompt")?.inputSchema.oneOf,
  ).toHaveLength(1);
  await expect(
    tools.call("send_agent_prompt", {
      ...request,
      operationId: "12345678-1234-4234-8234-123456789013",
    }),
  ).rejects.toThrow("unavailable");
  dev.available = false;
  expect(await tools.call("send_agent_prompt", request)).toMatchObject({ status: "succeeded" });
  expect(dev.calls).toHaveLength(1);
  expect(host.calls).toHaveLength(0);
});
it("does not dispatch new writes from a stale offline catalog or expose generic permission approval", async () => {
  const { tools, dev, store } = await fixture();
  dev.catalog.push({ name: "respond_to_permission", inputSchema: { type: "object" } });
  await tools.discover();
  expect(tools.list().map((tool) => tool.name)).not.toContain("respond_to_permission");
  await expect(tools.call("respond_to_permission", request)).rejects.toThrow("not available");
  dev.available = false;
  await expect(tools.call("send_agent_prompt", request)).rejects.toThrow("offline");
  expect(store.hasOperation(request.operationId)).toBe(false);
  expect(dev.calls).toEqual([]);
});

function unused(): never {
  throw new Error("Unused read");
}
function inventory(count: number): ReadClient {
  function agent(index: number) {
    return {
      id: String(index),
      provider: "codex",
      cwd: "/fixture",
      workspaceId: "same-name",
      model: null,
      createdAt: "2026-10-11T00:00:00Z",
      updatedAt: "2026-10-11T00:00:00Z",
      lastUserMessageAt: null,
      status: "idle",
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: `Thread ${index}`,
      attentionReason: index === count - 1 ? "permission" : null,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: false,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      },
    };
  }
  return {
    fetchAgents: async (options) => {
      const offset = Number(options?.page?.cursor ?? 0);
      const limit = options?.page?.limit ?? 50;
      return FetchAgentsResponseMessageSchema.parse({
        type: "fetch_agents_response",
        payload: {
          requestId: "fixture",
          entries: Array.from({ length: Math.min(limit, count - offset) }, (_, index) => ({
            agent: agent(index + offset),
            project: {
              projectKey: "fixture",
              projectName: "fixture",
              checkout: {
                cwd: "/fixture",
                isGit: false,
                currentBranch: null,
                remoteUrl: null,
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              },
            },
          })),
          pageInfo: {
            hasMore: offset + limit < count,
            nextCursor: offset + limit < count ? String(offset + limit) : null,
            prevCursor: null,
          },
        },
      }).payload;
    },
    fetchWorkspaces: async () =>
      FetchWorkspacesResponseMessageSchema.parse({
        type: "fetch_workspaces_response",
        payload: {
          requestId: "fixture",
          entries: [
            {
              id: "same-name",
              projectId: "fixture",
              projectDisplayName: "Fixture",
              projectRootPath: "/fixture",
              projectKind: "directory",
              workspaceKind: "directory",
              name: "Same name",
              status: "done",
              activityAt: null,
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      }).payload,
    fetchAgentTimeline: unused,
    searchAgentTimeline: unused,
    readFile: unused,
    getCheckoutDiff: unused,
    observeAgents: unused,
  };
}
it("bounds overview output, prioritizes attention beyond the first page and qualifies identical workspace names", async () => {
  const { tools, host, dev } = await fixture();
  host.reads = inventory(205);
  dev.reads = inventory(1);
  await host.reads.fetchWorkspaces();
  await host.reads.fetchAgents();
  const result = await tools.overview();
  expect(result).toMatchObject({
    environments: [
      {
        environment: "host",
        serverId: "host-server",
        threadCount: 205,
        truncated: true,
        agents: expect.arrayContaining([
          expect.objectContaining({ id: "204", attentionReason: "permission" }),
        ]),
      },
      { environment: "dev", serverId: "dev-server", threadCount: 1 },
    ],
  });
  const overview = JSON.parse(JSON.stringify(result));
  expect(overview.environments[0].agents).toHaveLength(100);
  expect(overview.environments[0].agents[0].id).toBe("204");
  expect(overview.environments[0].agents[0].url).toContain("host-server");
  expect(
    await tools.call("list_workspaces", { environment: "dev", serverId: "dev-server" }),
  ).toMatchObject({
    environment: "dev",
    serverId: "dev-server",
    observedAt: expect.any(String),
    data: { entries: [{ id: "same-name" }] },
  });
  dev.available = false;
  expect(await tools.overview()).toMatchObject({
    environments: [
      { status: "connected" },
      { status: "unavailable", workspaces: null, agents: null },
    ],
  });
});

it("paginates retained events with an explicit continuation and source event IDs", async () => {
  const { tools, store } = await fixture();
  store.db.exec(
    "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, body TEXT NOT NULL)",
  );
  const insert = store.db.prepare("INSERT INTO events (id, body) VALUES (?, ?)");
  insert.run(
    "one",
    JSON.stringify({ eventId: "one", data: { environment: "host", serverId: "host-server" } }),
  );
  insert.run(
    "two",
    JSON.stringify({ eventId: "two", data: { environment: "dev", serverId: "dev-server" } }),
  );
  expect(await tools.call("get_changes", { limit: 1 })).toMatchObject({
    nextAfter: 1,
    hasMore: true,
    changes: [{ cursor: 1, event: { eventId: "one" } }],
  });
  expect(await tools.call("get_changes", { after: 1, limit: 1 })).toMatchObject({
    nextAfter: 2,
    hasMore: false,
    changes: [{ cursor: 2, event: { eventId: "two" } }],
  });
});
