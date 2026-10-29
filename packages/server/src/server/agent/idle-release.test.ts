import pino from "pino";
import { expect, test } from "vitest";
import { startIdleSessionRelease, type IdleCandidate } from "./idle-release.js";

const logger = pino({ level: "silent" });
const MINUTE = 60_000;
const START = Date.parse("2026-10-28T12:00:00.000Z");
const SESSION = {} as IdleCandidate["session"];

function harness(
  agents: IdleCandidate[],
  refuse: Set<string> = new Set(),
  gate: (agentId: string) => Promise<void> = async () => {},
) {
  let now = START;
  const released: string[] = [];
  const release = startIdleSessionRelease({
    manager: {
      listAgents: () => agents.map((agent) => ({ ...agent })),
      releaseIdleSession: async (agentId, expected) => {
        await gate(agentId);
        if (refuse.has(agentId)) return false;
        // Mirrors the manager: an agent that changed after the sample is kept.
        const current = agents.find((agent) => agent.id === agentId);
        if (
          !current ||
          current.updatedAt.getTime() !== expected.updatedAt ||
          current.session !== expected.session
        )
          return false;
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
    {
      id: "old",
      lifecycle: "idle" as const,
      updatedAt: new Date(START - 20 * 24 * 60 * MINUTE),
      session: SESSION,
    },
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
    { id: "busy", lifecycle: "running", updatedAt: new Date(START), session: SESSION },
    { id: "active", lifecycle: "idle", updatedAt: new Date(START), session: SESSION },
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
  const agents: IdleCandidate[] = [
    { id: "goal", lifecycle: "idle", updatedAt: new Date(START), session: SESSION },
  ];
  const refuse = new Set(["goal"]);
  const { release, advance } = harness(agents, refuse);
  await release.runOnce();
  advance(30 * MINUTE);
  expect(await release.runOnce()).toEqual([]);
  refuse.clear();
  advance(MINUTE);
  expect(await release.runOnce()).toEqual(["goal"]);
});

test("a later candidate that ran again while an earlier release was closing keeps its session", async () => {
  const agents: IdleCandidate[] = [
    { id: "first", lifecycle: "idle", updatedAt: new Date(START), session: SESSION },
    { id: "second", lifecycle: "idle", updatedAt: new Date(START), session: SESSION },
  ];
  let unblock = () => {};
  const blocked = new Promise<void>((resolve) => (unblock = resolve));
  const { release, advance } = harness(agents, new Set(), (agentId) =>
    agentId === "first" ? blocked : Promise.resolve(),
  );
  await release.runOnce();
  advance(30 * MINUTE);
  const pass = release.runOnce();
  // While the first close is in progress, the second agent runs a turn and goes idle again.
  agents[1] = { ...agents[1]!, updatedAt: new Date(START + 30 * MINUTE) };
  unblock();
  expect(await pass).toEqual(["first"]);
  // The change restarts the period: the next pass samples it, then waits a full period again.
  advance(MINUTE);
  expect(await release.runOnce()).toEqual([]);
  advance(29 * MINUTE);
  expect(await release.runOnce()).toEqual([]);
  advance(MINUTE);
  expect(await release.runOnce()).toEqual(["second"]);
});

test("a reopened session restarts the idle period even when its update time is unchanged", async () => {
  const agents: IdleCandidate[] = [
    { id: "reopened", lifecycle: "idle", updatedAt: new Date(START), session: SESSION },
  ];
  const { release, advance } = harness(agents);
  await release.runOnce();
  advance(20 * MINUTE);
  agents[0] = { ...agents[0]!, session: {} as IdleCandidate["session"] };
  await release.runOnce();
  advance(20 * MINUTE);
  expect(await release.runOnce()).toEqual([]);
  advance(10 * MINUTE);
  expect(await release.runOnce()).toEqual(["reopened"]);
});
