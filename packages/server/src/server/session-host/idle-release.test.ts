import pino from "pino";
import { expect, test } from "vitest";
import {
  selectIdleHostedAgents,
  startHostedIdleRelease,
  type ReleasableAgent,
} from "./idle-release.js";

const logger = pino({ level: "silent" });
const NOW = Date.parse("2026-10-22T12:00:00.000Z");

function agent(overrides: Partial<ReleasableAgent> & { id: string }): ReleasableAgent {
  return {
    lifecycle: "idle",
    activeTurnId: null,
    pendingPermissions: { size: 0 },
    updatedAt: new Date(NOW - 10 * 60_000),
    session: { isDurablyHosted: () => true },
    ...overrides,
  };
}

test("only idle, quiet, hosted agents without a turn or a pending permission are released", () => {
  const agents = [
    agent({ id: "idle-hosted" }),
    agent({ id: "running", lifecycle: "running", activeTurnId: "turn-1" }),
    agent({ id: "idle-with-turn", activeTurnId: "turn-2" }),
    agent({ id: "permission", pendingPermissions: { size: 1 } }),
    agent({ id: "recent", updatedAt: new Date(NOW - 60_000) }),
    agent({ id: "local", session: { isDurablyHosted: () => false } }),
    agent({ id: "closed", lifecycle: "closed", session: null }),
  ];
  expect(selectIdleHostedAgents(agents, NOW, 5 * 60_000).map((a) => a.id)).toEqual(["idle-hosted"]);
});

test("nothing is released unless the host reports a pending upgrade", async () => {
  const closed: string[] = [];
  let pending = false;
  const release = startHostedIdleRelease({
    manager: {
      listAgents: () => [agent({ id: "a" }), agent({ id: "b" })],
      closeAgent: async (id) => void closed.push(id),
    },
    connector: { upgradePending: async () => pending },
    logger,
    now: () => NOW,
  });
  expect(await release.runOnce()).toEqual([]);
  expect(closed).toEqual([]);
  pending = true;
  expect(await release.runOnce()).toEqual(["a", "b"]);
  expect(closed).toEqual(["a", "b"]);
  release.stop();
});

test("a release that fails for one agent still releases the others and is reported", async () => {
  const closed: string[] = [];
  const release = startHostedIdleRelease({
    manager: {
      listAgents: () => [agent({ id: "a" }), agent({ id: "b" })],
      closeAgent: async (id) => {
        if (id === "a") throw new Error("busy");
        closed.push(id);
      },
    },
    connector: { upgradePending: async () => true },
    logger,
    now: () => NOW,
  });
  expect(await release.runOnce()).toEqual(["b"]);
  expect(closed).toEqual(["b"]);
  release.stop();
});

test("a connector without the flag never releases anything", async () => {
  const release = startHostedIdleRelease({
    manager: { listAgents: () => [agent({ id: "a" })], closeAgent: async () => {} },
    connector: {},
    logger,
  });
  expect(await release.runOnce()).toEqual([]);
  release.stop();
});
