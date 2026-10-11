import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

test("two connected clients share sidebar order and expansion across reconnect", async () => {
  const daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const writer = new DaemonClient({ url, appVersion: "0.7.2" });
  let reader = new DaemonClient({ url, appVersion: "0.7.2" });
  try {
    await writer.connect();
    await reader.connect();
    await writer.changeSidebarState({
      type: "initialize",
      state: { projectOrder: ["first", "second"] },
    });
    await writer.changeSidebarState({
      type: "patch",
      patch: {
        projectOrder: ["second", "first"],
        workspaceOrderByProject: { first: ["two", "one"] },
        collapsedProjects: { second: true },
      },
    });
    expect((await reader.readSidebarState()).snapshot.state).toMatchObject({
      projectOrder: ["second", "first"],
      workspaceOrderByProject: { first: ["two", "one"] },
      collapsedProjects: { second: true },
    });
    await reader.changeSidebarState({
      type: "patch",
      patch: { collapsedProjects: { second: false, first: true } },
    });
    expect((await writer.readSidebarState()).snapshot.state?.collapsedProjects).toEqual({
      first: true,
      second: false,
    });
    await reader.close();
    reader = new DaemonClient({ url, appVersion: "0.7.2" });
    await reader.connect();
    expect((await reader.readSidebarState()).snapshot).toEqual(
      (await writer.readSidebarState()).snapshot,
    );
  } finally {
    await writer.close();
    await reader.close();
    await daemon.close();
  }
}, 30000);
