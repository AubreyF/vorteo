import pino from "pino";
import { expect, test } from "vitest";
import { startIdleSessionRelease, type IdleCandidate } from "./idle-release.js";

const logger = pino({ level: "silent" });
const MINUTE = 60_000;
const START = Date.parse("2026-10-28T12:00:00.000Z");

function harness(agents: IdleCandidate[], refuse: Set<string> = new Set()) {
  let now = START;
  const released: string[] = [];
  const release = startIdleSessionRelease({
    manager: {
      listAgents: () => agents.map((agent) => ({ ...agent })),
      releaseIdleSession: async (agentId) => {
        if (refuse.has(agentId)) return false;
        released.push(agentId);
        const index = agents.findIndex((agent) => agent.id === agentId);
        agents.splice(index, 1);
        return true;
      },
    },
    logger,
    idleMs: 30 * MINUTE,
    intervalMs: 0,
    now: () => now,
  });
  return {
    released,
    release,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("an agent loaded only to be read is released once it has been idle for the full period", async () => {
  // Last turn weeks ago: the idle period counts from when the agent was first seen loaded.
  const agents = [
    { id: "old", lifecycle: "idle" as const, updatedAt: new Date(START - 20 * 24 * 60 * MINUTE) },
  ];
  const { release, released, advance } = harness(agents);
  expect(await release.runOnce()).toEqual([]);
  advance(29 * MINUTE);
  expect(await release.runOnce()).toEqual([]);
  advance(MINUTE);
  expect(await release.runOnce()).toEqual(["old"]);
  expect(released).toEqual(["old"]);
});

test("running agents and agents that changed restart their idle period", async () => {
  const agents: IdleCandidate[] = [
    { id: "busy", lifecycle: "running", updatedAt: new Date(START) },
    { id: "active", lifecycle: "idle", updatedAt: new Date(START) },
  ];
  const { release, advance } = harness(agents);
  await release.runOnce();
  advance(20 * MINUTE);
  agents[1] = { ...agents[1]!, updatedAt: new Date(START + 20 * MINUTE) };
  await release.runOnce();
  advance(20 * MINUTE);
  expect(await release.runOnce()).toEqual([]);
  advance(10 * MINUTE);
  expect(await release.runOnce()).toEqual(["active"]);
});

test("an agent the manager keeps is offered again on later passes", async () => {
  const agents: IdleCandidate[] = [{ id: "goal", lifecycle: "idle", updatedAt: new Date(START) }];
  const refuse = new Set(["goal"]);
  const { release, advance } = harness(agents, refuse);
  await release.runOnce();
  advance(30 * MINUTE);
  expect(await release.runOnce()).toEqual([]);
  refuse.clear();
  advance(MINUTE);
  expect(await release.runOnce()).toEqual(["goal"]);
});
