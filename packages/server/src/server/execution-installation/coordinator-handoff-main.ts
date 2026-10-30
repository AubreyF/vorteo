import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { writePrivateFileAtomicSync } from "../private-files.js";
import {
  HandoffPlanSchema,
  pointLink,
  readCurrentLink,
  runCoordinatorSwap,
  runRestore,
  type HandoffPorts,
} from "./coordinator-handoff.js";
import { createServiceControl } from "./service-control.js";
import { createInstallationSnapshots, dockerSnapshotPorts } from "./snapshots.js";

// Detached helper started by the coordinator: node coordinator-handoff-main.js <plan.json>.
const planFile = process.argv[2];
if (!planFile) throw new Error("Usage: coordinator-handoff-main <plan-file>");
const plan = HandoffPlanSchema.parse(JSON.parse(readFileSync(planFile, "utf8")));
const ports: HandoffPorts = {
  services: createServiceControl(plan.services),
  now: () => new Date(),
  sleep: (ms) => sleep(ms),
  async fetchHealth(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Health check answered ${response.status}`);
    return response.json();
  },
};
if (plan.kind === "coordinator-swap") {
  const outcome = await runCoordinatorSwap(plan, {
    ...ports,
    readLink: readCurrentLink,
    pointLink,
  });
  writePrivateFileAtomicSync(plan.outcomeFile, JSON.stringify(outcome, null, 2));
  console.log(`Coordinator handoff ${outcome.status}: ${outcome.detail}`);
} else {
  const snapshots = createInstallationSnapshots({
    root: plan.snapshotRoot,
    sources: () => [],
    ports: { now: ports.now, ...dockerSnapshotPorts },
  });
  const status = await runRestore(plan, {
    ...ports,
    snapshots,
    importDocker: dockerSnapshotPorts.importDocker,
    writeStatus: (next) =>
      writePrivateFileAtomicSync(plan.statusFile, JSON.stringify(next, null, 2)),
  });
  console.log(`Snapshot restore ${status.status}: ${status.detail}`);
}
