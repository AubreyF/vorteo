import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

test("checklist RPCs save edits, broadcast progress, reject dependencies and survive reconnect", async () => {
  const daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const writer = new DaemonClient({ url, appVersion: "0.7.2" });
  let reader = new DaemonClient({ url, appVersion: "0.7.2" });
  try {
    await expect(
      writer.mutateAgentChecklist("not-connected", { operation: "create", text: "Unavailable" }),
    ).rejects.toThrow("Update the daemon");
    await writer.connect();
    await reader.connect();
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
    await writer.close();
    await reader.close();
    await daemon.close();
  }
}, 30000);
