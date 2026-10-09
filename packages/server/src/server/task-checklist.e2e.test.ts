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
