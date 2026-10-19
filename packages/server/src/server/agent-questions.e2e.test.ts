import path from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentStorage } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

// These standalone test homes must not inherit the installed daemon launcher binding.
beforeEach(() => vi.stubEnv("VORTEO_INSTALLATION_CLIENT_CONFIG", undefined));
afterEach(() => vi.unstubAllEnvs());

const questionId = "44444444-4444-4444-8444-444444444444";

test("agents ask through MCP and the owner's answer is saved, journaled and delivered once", async () => {
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients(),
    mcpEnabled: true,
  });
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const owner = new DaemonClient({ url, appVersion: "0.7.2" });
  const mcp = new McpClient({ name: "questions-test", version: "1.0.0" });
  try {
    await owner.connect();
    await owner.fetchAgents({ subscribe: {} });
    const agent = await owner.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome },
    });
    await owner.mutateAgentChecklist(agent.id, { operation: "create", id: "ship", text: "Ship" });
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
    const ask = {
      operation: "ask",
      id: questionId,
      question: "Which region should the beta use?",
      why: "Provisioning waits for this choice.",
      recommendedDefault: "us-east",
      blocks: ["ship"],
    };
    const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["get_questions", "update_questions"]));
    const { recommendedDefault: _omitted, ...withoutDefault } = ask;
    for (const mutation of [
      withoutDefault,
      { operation: "answer", id: questionId, answer: "us-east" },
      { ...ask, blocks: ["missing"] },
    ])
      expect(
        (await mcp.callTool({ name: "update_questions", arguments: { mutation } })).isError,
      ).toBe(true);
    const asked = await mcp.callTool({ name: "update_questions", arguments: { mutation: ask } });
    expect(asked.isError).not.toBe(true);
    const snapshot = await owner.waitForAgentUpsert(
      agent.id,
      (value) => value.questions?.[0]?.status === "open",
    );
    expect(snapshot.questions?.[0]).toMatchObject({
      question: ask.question,
      recommendedDefault: "us-east",
      blocks: ["ship"],
      askedBy: agent.id,
    });

    const answered = await owner.answerAgentQuestion(agent.id, questionId, " eu-west ");
    expect(answered[0]).toMatchObject({
      status: "answered",
      answer: "eu-west",
      answeredBy: "owner",
    });
    expect(await owner.answerAgentQuestion(agent.id, questionId, "eu-west")).toEqual(answered);
    await expect(owner.answerAgentQuestion(agent.id, questionId, "us-east")).rejects.toThrow(
      "already answered",
    );
    const journaled = await owner.waitForAgentUpsert(
      agent.id,
      (value) => value.journal?.length === 1,
    );
    expect(journaled.journal?.[0]?.text).toBe(
      'Owner answered "Which region should the beta use?": eu-west',
    );
    await expect
      .poll(async () => {
        const timeline = await owner.fetchAgentTimeline(agent.id);
        return timeline.entries.filter(
          (entry) =>
            entry.item.type === "user_message" && entry.item.text.includes("Answer: eu-west"),
        ).length;
      })
      .toBe(1);
    expect(
      (await mcp.callTool({ name: "get_questions", arguments: {} })).structuredContent,
    ).toEqual({ questions: answered });
    expect(
      (
        await mcp.callTool({
          name: "update_questions",
          arguments: { mutation: { operation: "withdraw", id: questionId } },
        })
      ).isError,
    ).toBe(true);

    await daemon.daemon.agentManager.flush();
    const storage = new AgentStorage(path.join(daemon.paseoHome, "agents"), createTestLogger());
    expect((await storage.get(agent.id))?.questions).toEqual(answered);
  } finally {
    await mcp.close();
    await owner.close();
    await daemon.close();
  }
}, 30000);
