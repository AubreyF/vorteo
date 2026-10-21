import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import type { DaemonClient } from "../test-utils/daemon-client.js";
import {
  createInstallation,
  HOST_LOSS_CONTINUATION,
  leftovers,
  RESTART_CONTINUATION,
  summarizeTimeline,
  thisRepoRoot,
  waitUntil,
  type Installation,
} from "./durable-sessions.harness.e2e.js";

/**
 * The worker-kill scenario of durable-sessions.e2e.test.ts on real Claude Haiku: a hosted turn
 * running `sleep 20` must survive SIGKILL of the daemon worker and finish once, with no failure
 * and no continuation. It uses the invoking user's Claude login (HOME and CLAUDE_CONFIG_DIR) and
 * spends a small amount of quota, so it runs only on request, on macOS:
 *
 *   DURABLE_SESSIONS_REAL_CLAUDE=1 npx vitest run <this file> --bail=1
 */

const ENABLED = process.env.DURABLE_SESSIONS_REAL_CLAUDE === "1" && process.platform === "darwin";
const MODEL = "claude-haiku-4-5";
const SLEEP_COMMAND = "sleep 20";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanups.splice(0).toReversed()) await step();
});

afterAll(async () => {
  if (!ENABLED) return;
  // Matches this run's jobs, directories, and processes by path and environment.
  expect(await leftovers()).toEqual({ jobs: [], directories: [], processes: [] });
});

async function closeQuietly(client: DaemonClient): Promise<void> {
  await client.close().catch(() => {});
}

interface ToolCallRow {
  type: string;
  callId?: string;
  status?: string;
}

/** Tool calls in the timeline that ran the sleep command. */
async function sleepCalls(client: DaemonClient, agentId: string): Promise<ToolCallRow[]> {
  const timeline = await client.fetchAgentTimeline(agentId, { direction: "tail", limit: 1_000 });
  return timeline.entries
    .map((entry) => entry.item as ToolCallRow)
    .filter((item) => item.type === "tool_call" && JSON.stringify(item).includes(SLEEP_COMMAND));
}

describe.skipIf(!ENABLED)("durable sessions with real Claude", () => {
  test("a worker killed during a real tool call is replaced and the hosted turn completes once", async () => {
    const install: Installation = await createInstallation({ provider: "real" });
    cleanups.push(() => install.cleanup());
    const tree = { repoRoot: thisRepoRoot };
    const host = await install.startHost(tree);
    const supervisor = await install.startSupervisor(tree);
    const firstWorker = supervisor.workers[0]!;

    const client = await install.client();
    const agent = await client.createAgent({
      config: {
        provider: "claude",
        model: MODEL,
        modeId: "bypassPermissions",
        cwd: path.join(install.root, "work"),
        title: "durable sessions real e2e",
      },
      initialPrompt: `Use the Bash tool to run \`${SLEEP_COMMAND}\` exactly once. When it finishes, reply with the single word DONE.`,
    });
    // Kill the worker while the provider is inside the 20 second tool call.
    await waitUntil(
      "the sleep tool call to start",
      async () => (await sleepCalls(client, agent.id)).length > 0,
      120_000,
      500,
    );
    await client.close();
    const killedAt = Date.now();
    process.kill(firstWorker, "SIGKILL");
    await supervisor.waitForWorker([firstWorker]);

    const next = await install.client();
    cleanups.push(() => closeQuietly(next));
    const finished = await waitUntil(
      "the hosted turn to finish",
      async () => {
        const current = (await next.fetchAgent(agent.id))?.agent;
        return current?.status === "idle" ? current : null;
      },
      180_000,
      1_000,
    );
    const doneMs = Date.now() - killedAt;

    const calls = await sleepCalls(next, agent.id);
    expect(new Set(calls.map((call) => call.callId)).size).toBe(1);
    expect(calls.at(-1)?.status).toBe("completed");
    const summary = await summarizeTimeline(next, agent.id);
    expect(summary.systemErrors).toEqual([]);
    expect(
      summary.userMessages.filter(
        (text) => text.includes(HOST_LOSS_CONTINUATION) || text.includes(RESTART_CONTINUATION),
      ),
    ).toEqual([]);
    expect((finished as { lastError?: unknown }).lastError ?? null).toBeNull();
    expect((await next.readMessageQueue(agent.id)).snapshot?.items ?? []).toEqual([]);
    expect((await install.host()).pid).toBe(host.pid);
    process.stdout.write(`[real worker kill] turn done ${doneMs} ms after the kill\n`);
  }, 420_000);
});
