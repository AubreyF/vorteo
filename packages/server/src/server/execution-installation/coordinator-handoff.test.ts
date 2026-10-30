import { expect, test } from "vitest";
import {
  runCoordinatorSwap,
  type CoordinatorSwapPlan,
  type SwapPorts,
} from "./coordinator-handoff.js";

const plan: CoordinatorSwapPlan = {
  kind: "coordinator-swap",
  id: "00000000-0000-4000-8000-000000000001",
  releaseLink: "/vorteo/host/coordinator-current",
  previous: "/vorteo/host/releases/old",
  next: "/vorteo/host/releases/new",
  services: {
    coordinator: { launchdService: "gui/501/local.vorteo.fixture.installation" },
    host: { launchdService: "gui/501/local.vorteo.fixture.host" },
  },
  health: {
    url: "http://127.0.0.1:4000/api/installation/health",
    installationId: "00000000-0000-4000-8000-0000000000aa",
    previousPid: 100,
  },
  outcomeFile: "/vorteo/state/coordinator/upgrades/x/coordinator-handoff.json",
  timeoutMs: 5000,
};

/** A fake clock and coordinator: `healthy(target)` decides whether that release answers. */
function ports(healthy: (target: string) => boolean) {
  let clock = 0;
  let link = plan.previous;
  let pid = 100;
  const calls: string[] = [];
  const fake: SwapPorts = {
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    readLink: () => link,
    pointLink: (_link, target) => {
      calls.push(`link ${target}`);
      link = target;
    },
    fetchHealth: async () => {
      if (!healthy(link)) throw new Error("connection refused");
      return { installationId: plan.health.installationId, pid };
    },
    services: {
      stop: async () => undefined,
      start: async () => undefined,
      restart: async (service) => {
        calls.push(`restart ${service}`);
        pid += 1;
      },
    },
  };
  return { fake, calls };
}

test("selects the new release and succeeds when a new coordinator answers", async () => {
  const { fake, calls } = ports(() => true);
  const outcome = await runCoordinatorSwap(plan, fake);
  expect(outcome.status).toBe("succeeded");
  expect(calls).toEqual([`link ${plan.next}`, "restart coordinator"]);
});

test("rolls back to the previous release when the new coordinator never becomes ready", async () => {
  const { fake, calls } = ports((target) => target === plan.previous);
  const outcome = await runCoordinatorSwap(plan, fake);
  expect(outcome.status).toBe("rolled-back");
  expect(calls).toEqual([
    `link ${plan.next}`,
    "restart coordinator",
    `link ${plan.previous}`,
    "restart coordinator",
  ]);
});

test("refuses to act when the release link moved", async () => {
  const { fake, calls } = ports(() => true);
  fake.readLink = () => "/elsewhere";
  expect((await runCoordinatorSwap(plan, fake)).status).toBe("failed");
  expect(calls).toEqual([]);
});
