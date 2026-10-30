import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { HandoffOutcome } from "./coordinator-handoff.js";
import {
  createUpgradeJournal,
  InstallationUpgrades,
  type AdoptionOutcome,
  type UpgradeJournal,
  type UpgradePorts,
} from "./release-upgrades.js";

const RELEASE_COMMIT = "b".repeat(40);
const INSTALLED_COMMIT = "a".repeat(40);

let directory: string;
let journal: UpgradeJournal;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "release-upgrades-"));
  journal = createUpgradeJournal(directory);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** Records every effect in order. Defaults describe a healthy upgrade. */
function fakePorts(changes: Partial<UpgradePorts> = {}) {
  const calls: string[] = [];
  let clock = Date.parse("2026-10-30T12:00:00Z");
  let hostJob: "running" | "succeeded" | "failed" = "running";
  let outcome: HandoffOutcome | null = null;
  let devImage = "sha256:old";
  let adoption: AdoptionOutcome | null = null;
  const ports: UpgradePorts = {
    now: () => new Date(clock),
    adoptionRequired: false,
    launchAdoption: () => {
      calls.push("adopt");
    },
    adoptionOutcome: () => adoption,
    adoptionDeadlineMs: 60_000,
    hasContainer: true,
    coordinatorReplacement: null,
    currentCommit: () => INSTALLED_COMMIT,
    resolveRelease: async () => RELEASE_COMMIT,
    snapshot: async () => {
      calls.push("snapshot");
      return "20261030T120000000Z";
    },
    fetchRelease: async () => {
      calls.push("fetch");
    },
    requestHostUpdate: async () => {
      calls.push("host-request");
      return "00000000-0000-4000-8000-00000000000a";
    },
    hostUpdate: () => ({ status: hostJob, detail: `Host job ${hostJob}` }),
    hostRelease: () => "/releases/new",
    runningRelease: () => "/releases/old",
    coordinatorRelease: () => "/releases/old",
    launchCoordinatorSwap: (_upgrade, next, previous) => {
      calls.push(`swap ${previous} -> ${next}`);
    },
    coordinatorOutcome: () => outcome,
    coordinatorDeadlineMs: 60_000,
    devImage: async () => devImage,
    buildDevImage: async () => {
      calls.push("dev-build");
      return "sha256:new";
    },
    replaceDevImage: async (image) => {
      calls.push(`dev-replace ${image}`);
      devImage = image;
    },
    verifyDev: async () => {
      calls.push("dev-verify");
    },
    ...changes,
  };
  return {
    ports,
    calls,
    finishHost: (status: "succeeded" | "failed") => {
      hostJob = status;
    },
    reportCoordinator: (status: HandoffOutcome["status"]) => {
      outcome = {
        id: "00000000-0000-4000-8000-000000000000",
        status,
        detail: `Coordinator ${status}`,
        finishedAt: new Date(clock).toISOString(),
      };
    },
    advanceClock: (ms: number) => {
      clock += ms;
    },
    setDevImage: (image: string) => {
      devImage = image;
    },
    reportAdoption: (status: AdoptionOutcome["status"]) => {
      adoption = { status, detail: `Adoption ${status}` };
    },
  };
}

async function approved(upgrades: InstallationUpgrades) {
  const pending = await upgrades.request("release-940");
  expect(pending).toMatchObject({ status: "pending", sourceCommit: RELEASE_COMMIT });
  return upgrades.decide(pending.id, pending.revision, "approve");
}

function statuses(upgrades: InstallationUpgrades) {
  const [upgrade] = upgrades.list();
  return { status: upgrade.status, steps: upgrade.steps.map((step) => step.status) };
}

test("runs every step in order and records each one", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  await upgrades.drain();
  expect(fake.calls).toEqual(["snapshot", "fetch", "host-request"]);
  expect(statuses(upgrades).steps).toEqual([
    "succeeded",
    "succeeded",
    "running",
    "pending",
    "pending",
  ]);
  fake.finishHost("succeeded");
  await upgrades.drain();
  expect(fake.calls.at(-1)).toBe("swap /releases/old -> /releases/new");
  fake.reportCoordinator("succeeded");
  await upgrades.drain();
  expect(fake.calls.slice(-3)).toEqual(["dev-build", "dev-replace sha256:new", "dev-verify"]);
  expect(statuses(upgrades)).toEqual({
    status: "succeeded",
    steps: ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"],
  });
  expect(upgrades.list()[0].snapshotId).toBe("20261030T120000000Z");
});

test("a restarted coordinator resumes from the journal without repeating finished effects", async () => {
  const first = fakePorts();
  const upgrades = new InstallationUpgrades(journal, first.ports);
  await approved(upgrades);
  await upgrades.drain();
  first.finishHost("succeeded");
  await upgrades.drain();
  expect(first.calls.filter((call) => call.startsWith("swap"))).toHaveLength(1);

  // The helper restarted the coordinator onto the new release and reported success.
  const second = fakePorts({ runningRelease: () => "/releases/new" });
  second.finishHost("succeeded");
  second.reportCoordinator("succeeded");
  const resumed = new InstallationUpgrades(journal, second.ports);
  await resumed.drain();
  expect(second.calls).toEqual(["dev-build", "dev-replace sha256:new", "dev-verify"]);
  expect(statuses(resumed).status).toBe("succeeded");
});

test("a coordinator rollback fails the upgrade and leaves Dev untouched", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  fake.reportCoordinator("rolled-back");
  await upgrades.drain();
  expect(statuses(upgrades)).toEqual({
    status: "failed",
    steps: ["succeeded", "succeeded", "succeeded", "rolled-back", "skipped"],
  });
  expect(fake.calls).not.toContain("dev-build");
});

test("a silent coordinator helper is judged by the running release after its deadline", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  expect(statuses(upgrades).steps[3]).toBe("running");
  fake.advanceClock(61_000);
  await upgrades.drain();
  expect(statuses(upgrades)).toMatchObject({ status: "failed" });
  expect(upgrades.list()[0].steps[3].detail).toContain("did not report");
});

test("an unhealthy Dev image rolls back to the previous image", async () => {
  const fake = fakePorts();
  fake.ports.verifyDev = async () => {
    fake.calls.push("dev-verify");
    throw new Error("Dev did not answer");
  };
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  fake.reportCoordinator("succeeded");
  await upgrades.drain();
  expect(fake.calls.slice(-4)).toEqual([
    "dev-build",
    "dev-replace sha256:new",
    "dev-verify",
    "dev-replace sha256:old",
  ]);
  expect(statuses(upgrades)).toEqual({
    status: "failed",
    steps: ["succeeded", "succeeded", "succeeded", "succeeded", "rolled-back"],
  });
  expect(upgrades.list()[0].detail).toContain("previous image");
});

test("a coordinator that restarted while Dev was recreated verifies before replacing again", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  fake.reportCoordinator("succeeded");
  // Crash inside replaceDevImage after Dev already runs the new image.
  fake.ports.replaceDevImage = async (image) => {
    fake.setDevImage(image);
    throw new Error("coordinator stopped");
  };
  fake.ports.devImage = async () => "sha256:old";
  await upgrades.drain().catch(() => undefined);
  const record = journal.read()[0];
  expect(record.private.devImage).toBe("sha256:new");

  const second = fakePorts({ runningRelease: () => "/releases/new" });
  second.setDevImage("sha256:new");
  // Rebuild the journal state as it was persisted just before the crash.
  journal.write([
    {
      ...record,
      status: "running",
      steps: record.steps.map((step, index) =>
        index === 4 ? { ...step, status: "running", detail: "" } : step,
      ),
      private: { ...record.private, devReplacing: true },
    },
  ]);
  const resumed = new InstallationUpgrades(journal, second.ports);
  await resumed.drain();
  expect(second.calls).toEqual(["dev-verify"]);
  expect(statuses(resumed).status).toBe("succeeded");
});

test("a Host-only installation skips the Dev step", async () => {
  const fake = fakePorts({ hasContainer: false });
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  fake.finishHost("succeeded");
  await upgrades.drain();
  await upgrades.drain();
  fake.reportCoordinator("succeeded");
  await upgrades.drain();
  expect(statuses(upgrades)).toEqual({
    status: "succeeded",
    steps: ["succeeded", "succeeded", "succeeded", "succeeded", "skipped"],
  });
});

test("a failed Host build stops before the coordinator and Dev", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  await approved(upgrades);
  await upgrades.drain();
  fake.finishHost("failed");
  await upgrades.drain();
  expect(statuses(upgrades)).toEqual({
    status: "failed",
    steps: ["succeeded", "succeeded", "failed", "skipped", "skipped"],
  });
  expect(fake.calls).toEqual(["snapshot", "fetch", "host-request"]);
});

test("approval names the reviewed revision and only one upgrade is active", async () => {
  const fake = fakePorts();
  const upgrades = new InstallationUpgrades(journal, fake.ports);
  const pending = await upgrades.request("release-940");
  await expect(upgrades.request("release-941")).rejects.toThrow("already pending");
  expect(() =>
    upgrades.decide(pending.id, "00000000-0000-4000-8000-0000000000ff", "approve"),
  ).toThrow("changed");
  await upgrades.drain();
  expect(fake.calls).toEqual([]);
  const rejected = upgrades.decide(pending.id, pending.revision, "reject");
  expect(rejected.status).toBe("rejected");
  const current = fakePorts({ currentCommit: () => RELEASE_COMMIT });
  await expect(
    new InstallationUpgrades(journal, current.ports).request("release-940"),
  ).rejects.toThrow("already runs");
  expect(JSON.stringify(upgrades.list())).not.toContain("private");
});

test("an installation from before the installer adopts its layout before the snapshot", async () => {
  const legacy = fakePorts({ adoptionRequired: true });
  const upgrades = new InstallationUpgrades(journal, legacy.ports);
  await approved(upgrades);
  await upgrades.drain();
  await upgrades.drain();
  // Launched once, then waiting: the engine restarts this coordinator when it is done.
  expect(legacy.calls).toEqual(["adopt"]);
  expect(statuses(upgrades).steps[0]).toBe("running");
  expect(upgrades.list()[0].steps[0].detail).toContain("installer layout");

  // The restarted coordinator has the deployment block and finds the engine's outcome.
  const adopted = fakePorts();
  const resumed = new InstallationUpgrades(journal, adopted.ports);
  await resumed.drain();
  expect(adopted.calls).toEqual([]);
  adopted.reportAdoption("succeeded");
  await resumed.drain();
  expect(adopted.calls).toEqual(["snapshot", "fetch", "host-request"]);
});

test("a failed adoption fails the upgrade before any snapshot or Host change", async () => {
  const legacy = fakePorts({ adoptionRequired: true });
  const upgrades = new InstallationUpgrades(journal, legacy.ports);
  await approved(upgrades);
  await upgrades.drain();
  legacy.reportAdoption("failed");
  await upgrades.drain();
  expect(statuses(upgrades)).toEqual({
    status: "failed",
    steps: ["failed", "skipped", "skipped", "skipped", "skipped"],
  });
  expect(upgrades.list()[0].detail).toContain("Adoption failed");
  expect(legacy.calls).toEqual(["adopt"]);
});

test("an adoption that never reports fails after its deadline", async () => {
  const legacy = fakePorts({ adoptionRequired: true });
  const upgrades = new InstallationUpgrades(journal, legacy.ports);
  await approved(upgrades);
  await upgrades.drain();
  legacy.advanceClock(60_001);
  await upgrades.drain();
  expect(statuses(upgrades).status).toBe("failed");
  expect(upgrades.list()[0].detail).toContain("did not report");
});
