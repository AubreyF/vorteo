import { createThreadGoalTools } from "./agent/tools/thread-goal.js";
import path from "node:path";
import { AgentStorage } from "./agent/agent-storage.js";
import { expect, test } from "vitest";
import { AgentGoalSetInputSchema, type AgentGoal } from "@getpaseo/protocol/agent-goals";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { CodexAppServerAgentSession } from "./agent/providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./agent/providers/codex/test-utils/fake-app-server.js";

test("goal RPCs project native updates to subscribers, history and reconnect snapshots", async () => {
  let nativeGoal: AgentGoal | null = null;
  const native = createFakeCodexAppServer({
    "thread/goal/get": () => ({ goal: nativeGoal }),
    "thread/goal/set": (params) => {
      const input = AgentGoalSetInputSchema.parse(params);
      nativeGoal = {
        threadId: "thread-1",
        objective: input.objective ?? nativeGoal?.objective ?? "",
        status: input.status ?? nativeGoal?.status ?? "active",
        tokenBudget:
          input.tokenBudget === undefined ? (nativeGoal?.tokenBudget ?? null) : input.tokenBudget,
        tokensUsed: nativeGoal?.tokensUsed ?? 0,
        timeUsedSeconds: nativeGoal?.timeUsedSeconds ?? 0,
        createdAt: 100,
        updatedAt: 100,
      };
      return { goal: nativeGoal };
    },
    "thread/goal/clear": () => {
      nativeGoal = null;
      return { cleared: true };
    },
  });
  const clients = createTestAgentClients();
  clients.codex!.createSession = async (config) => {
    const session = new CodexAppServerAgentSession(
      config,
      null,
      createTestLogger(),
      async () => native.child,
      {},
      false,
      true,
    );
    await session.connect();
    return session;
  };
  const daemon = await createTestPaseoDaemon({ agentClients: clients });
  const first = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  let second = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  try {
    await first.connect();
    await second.connect();
    const observation = second.observeAgents();
    await observation.ready;
    const agent = await first.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome },
      initialGoal: { objective: "First goal", status: "paused" },
    });
    expect(agent.capabilities.supportsGoals).toBe(true);
    expect(await first.getAgentGoal(agent.id)).toMatchObject({
      status: "ready",
      goal: { objective: "First goal", status: "paused" },
    });
    await first.clearAgentGoal(agent.id);
    const created = await first.setAgentGoal(agent.id, {
      objective: "Ship the goal bar",
      status: "paused",
      tokenBudget: 1000,
    });
    expect(created.goal).toMatchObject({
      objective: "Ship the goal bar",
      status: "paused",
      tokenBudget: 1000,
    });
    await second.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.goalState?.goal?.objective === "Ship the goal bar",
    );
    await first.setAgentGoal(agent.id, { tokenBudget: null });
    expect((await second.getAgentGoal(agent.id)).goal).toMatchObject({
      status: "paused",
      tokenBudget: null,
    });
    const tools = createThreadGoalTools(daemon.daemon.agentManager, agent.id);
    const edit = tools.find((tool) => tool.name === "update_thread_goal")!;
    const current = await first.getAgentGoal(agent.id);
    const { threadId, objective, status, createdAt, updatedAt, tokenBudget } = current.goal!;
    await edit.handler(
      {
        expectedGoal: { threadId, objective, status, createdAt, updatedAt, tokenBudget },
        objective: "Ship the goal tools",
      },
      {},
    );
    await second.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.goalState?.goal?.objective === "Ship the goal tools",
    );
    expect((await first.getAgentGoal(agent.id)).goal).toMatchObject({
      ...current.goal,
      objective: "Ship the goal tools",
      status: "paused",
    });
    const timeline = await first.fetchAgentTimeline(agent.id);
    expect(JSON.stringify(timeline)).toContain('"intent":"goal"');
    await daemon.daemon.agentManager.flush();
    await daemon.daemon.agentStorage.flush();
    const reopenedStorage = new AgentStorage(
      path.join(daemon.paseoHome, "agents"),
      createTestLogger(),
    );
    await reopenedStorage.initialize();
    expect(
      (await reopenedStorage.get(agent.id))?.goalSubmissions?.map((entry) => entry.text),
    ).toEqual(["First goal", "Ship the goal bar", "Ship the goal tools"]);
    nativeGoal = { ...nativeGoal!, status: "complete", tokensUsed: 123, timeUsedSeconds: 4 };
    native.child.stdout.write(
      JSON.stringify({
        method: "thread/goal/updated",
        params: { threadId: nativeGoal.threadId, turnId: null, goal: nativeGoal },
      }) + "\n",
    );
    await second.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.goalState?.goal?.status === "complete",
    );
    await observation.release();
    await second.close();
    second = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
    await second.connect();
    expect((await second.getAgentGoal(agent.id)).goal).toMatchObject({
      status: "complete",
      tokensUsed: 123,
    });
    await first.clearAgentGoal(agent.id);
    expect(await second.getAgentGoal(agent.id)).toMatchObject({ status: "ready", goal: null });
    native.assertNoErrors();
    await first.archiveAgent(agent.id);
    await expect(first.setAgentGoal(agent.id, { status: "active" })).rejects.toThrow("archived");
  } finally {
    await first.close();
    await second.close();
    await daemon.close();
  }
}, 30000);
