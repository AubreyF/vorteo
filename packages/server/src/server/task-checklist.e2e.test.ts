import path from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

test("checklist RPCs save edits, broadcast progress, reject dependencies and survive reconnect", async () => {
  const daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const writer = new DaemonClient({ url, appVersion: "0.7.2" });
  const legacy = new DaemonClient({
    url,
    appVersion: "0.7.2",
    capabilities: { checklist_blocked_status: false },
  });
  let reader = new DaemonClient({ url, appVersion: "0.7.2" });
  try {
    await expect(
      writer.mutateAgentChecklist("not-connected", { operation: "create", text: "Unavailable" }),
    ).rejects.toThrow("Update the daemon");
    await writer.connect();
    await reader.connect();
    await legacy.connect();
    await legacy.fetchAgents({ subscribe: {} });
    await reader.fetchAgents({ subscribe: {} });
    const agent = await writer.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome },
    });
    expect(await writer.getAgentChecklist(agent.id)).toEqual([]);
    await writer.mutateAgentChecklist(agent.id, {
      operation: "create",
      id: "api",
      text: "API",
      description: "Clients can update tasks",
    });
    await writer.mutateAgentChecklist(agent.id, {
      operation: "update",
      id: "api",
      status: "blocked",
    });
    await reader.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.tasks?.[0].status === "blocked",
    );
    await legacy.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.tasks?.[0].status === "pending",
    );
    expect((await reader.getAgentChecklist(agent.id))[0]).toMatchObject({
      status: "blocked",
      completed: false,
    });
    const legacyTask = (await legacy.getAgentChecklist(agent.id))[0];
    expect(legacyTask).toMatchObject({ status: "pending", completed: false });
    await expect(
      legacy.mutateAgentChecklist(agent.id, {
        operation: "update",
        id: "api",
        expectedTask: legacyTask,
        status: "completed",
      }),
    ).rejects.toThrow("changed while you were editing");
    await reader.close();
    reader = new DaemonClient({ url, appVersion: "0.7.2" });
    await reader.connect();
    await reader.fetchAgents({ subscribe: {} });
    expect((await reader.getAgentChecklist(agent.id))[0].status).toBe("blocked");
    await writer.mutateAgentChecklist(agent.id, {
      operation: "create",
      id: "ui",
      text: "Card",
      blockedBy: ["api"],
    });
    await expect(
      writer.mutateAgentChecklist(agent.id, { operation: "update", id: "ui", status: "completed" }),
    ).rejects.toThrow("Complete dependency api");
    await writer.mutateAgentChecklist(agent.id, {
      operation: "update",
      id: "api",
      status: "completed",
    });
    await reader.waitForAgentUpsert(agent.id, (snapshot) => snapshot.tasks?.[0].completed === true);
    expect((await reader.getAgentChecklist(agent.id)).map((task) => task.completed)).toEqual([
      true,
      false,
    ]);
    await reader.close();
    reader = new DaemonClient({ url, appVersion: "0.7.2" });
    await reader.connect();
    expect((await reader.getAgentChecklist(agent.id))[0]).toMatchObject({
      id: "api",
      completed: true,
      description: "Clients can update tasks",
    });
    await writer.mutateAgentChecklist(agent.id, {
      operation: "update",
      id: "api",
      status: "pending",
    });
    expect((await reader.getAgentChecklist(agent.id))[0].completed).toBe(false);
    await writer.archiveAgent(agent.id);
    await expect(
      writer.mutateAgentChecklist(agent.id, { operation: "delete", id: "api" }),
    ).rejects.toThrow("archived");
  } finally {
    await legacy.close();
    await writer.close();
    await reader.close();
    await daemon.close();
  }
}, 30000);

test("journal tools append durably, broadcast in order and reject edits and cross-thread calls", async () => {
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients(),
    mcpEnabled: true,
  });
  const reader = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  const mcp = new McpClient({ name: "journal-test", version: "1.0.0" });
  try {
    await reader.connect();
    await reader.fetchAgents({ subscribe: {} });
    const agent = await reader.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome },
    });
    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${agent.id}`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${daemon.daemon.agentManager.getMcpAuthToken()}` },
          },
        },
      ),
    );
    const first = {
      entryId: "11111111-1111-4111-8111-111111111111",
      text: "Chose atomic persistence because journal entries must survive recovery.",
    };
    const second = {
      entryId: "22222222-2222-4222-8222-222222222222",
      text: "Validated the persisted result.",
    };
    const appended = await mcp.callTool({ name: "append_journal", arguments: first });
    expect(appended.isError).not.toBe(true);
    expect(
      (await mcp.callTool({ name: "append_journal", arguments: first })).structuredContent,
    ).toEqual(appended.structuredContent);
    expect((await mcp.callTool({ name: "append_journal", arguments: second })).isError).not.toBe(
      true,
    );
    const snapshot = await reader.waitForAgentUpsert(
      agent.id,
      (value) => value.journal?.length === 2,
    );
    expect(snapshot.journal?.map((entry) => entry.text)).toEqual([first.text, second.text]);
    expect(snapshot.journal?.map((entry) => entry.sequence)).toEqual([1, 2]);
    const read = await mcp.callTool({ name: "get_journal", arguments: {} });
    expect(read.structuredContent).toEqual({ entries: snapshot.journal });
    for (const args of [
      { ...first, text: "Rewrite history" },
      { ...first, agentId: "another-thread" },
      { ...first, timestamp: "2000-01-01T00:00:00Z" },
      { entryId: "33333333-3333-4333-8333-333333333333", text: " " },
    ])
      expect((await mcp.callTool({ name: "append_journal", arguments: args })).isError).toBe(true);
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("update_journal");
    await daemon.daemon.agentManager.flush();
    const storage = new AgentStorage(path.join(daemon.paseoHome, "agents"), createTestLogger());
    expect((await storage.get(agent.id))?.journal).toEqual(snapshot.journal);
    await reader.archiveAgent(agent.id);
    expect(
      (
        await mcp.callTool({
          name: "append_journal",
          arguments: { entryId: "33333333-3333-4333-8333-333333333333", text: "After archive" },
        })
      ).isError,
    ).toBe(true);
    expect((await mcp.callTool({ name: "get_journal", arguments: {} })).structuredContent).toEqual({
      entries: snapshot.journal,
    });
  } finally {
    await mcp.close();
    await reader.close();
    await daemon.close();
  }
}, 30000);
