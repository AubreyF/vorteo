import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import { factorySetup, type FactorySetup } from "../shared/operations.js";
import {
  activityReceipts,
  factorySnapshot,
  type ActivityReceipts,
  type FactorySnapshot,
} from "../shared/contracts.js";

export class FactoryProjectUnavailableError extends Error {
  constructor(readonly projectId: string) {
    super("The selected project is unavailable on this daemon.");
    this.name = "FactoryProjectUnavailableError";
  }
}

const adoptionReason =
  "The existing controller has not been adopted into the bundled Factory binding.";

export async function readSetup(
  { projectId }: RpcInput<typeof factorySetup>,
  { paseo, serverId }: PluginHandlerContext,
): Promise<FactorySetup> {
  const response = await paseo.projects.list();
  const project = response.projects.find((entry) => entry.projectId === projectId);
  const reason = project
    ? "A reconciled startup-owned Factory installer is unavailable."
    : "The selected native project is unavailable on this daemon.";
  return {
    schemaVersion: 1,
    serverId,
    projectId,
    installationId: null,
    revision: null,
    observedAt: new Date().toISOString(),
    state: "unavailable",
    reason,
    operations: { install: false, pause: false, resume: false, stop: false, disable: false },
  };
}

export async function readSnapshot(
  { projectId }: RpcInput<typeof factorySnapshot>,
  { paseo, serverId }: PluginHandlerContext,
): Promise<FactorySnapshot> {
  const response = await paseo.projects.list();
  const project = response.projects.find((entry) => entry.projectId === projectId);
  if (!project) throw new FactoryProjectUnavailableError(projectId);

  // A successful project read establishes registry presence, not controller custody.
  // Do not infer an installation from titles, directories, tags or schedule names.
  return {
    schemaVersion: 1,
    serverId,
    projectId,
    revision: null,
    installationId: null,
    observedAt: new Date().toISOString(),
    freshness: { state: "unknown", reason: adoptionReason },
    admission: { state: "unavailable", reason: adoptionReason },
    account: { usagePoints: null, limitPoints: null, observedAt: null, unit: "allowance-points" },
    coordinators: [],
    work: [],
    issues: [],
    builds: { active: null, pending: [], latestRelease: null },
    exceptions: [
      {
        id: "controller-adoption-required",
        title: "Controller adoption required",
        detail: adoptionReason,
      },
    ],
    coverage: {
      work: { complete: false, gaps: [adoptionReason] },
      issues: { complete: false, gaps: [adoptionReason] },
      builds: { complete: false, gaps: [adoptionReason] },
    },
    capabilities: {
      install: false,
      pause: false,
      resume: false,
      stop: false,
      takeover: false,
      disable: false,
      cleanup: false,
    },
  };
}

export function readReceipts(
  { cursor }: RpcInput<typeof activityReceipts>,
  { serverId }: PluginHandlerContext,
): ActivityReceipts {
  const observedAt = new Date().toISOString();
  const cursorState = cursor === null ? "initial" : "expired";
  const gaps = ["Verified controller receipt observation is unavailable."];
  if (cursor !== null)
    gaps.push("The supplied cursor has no retained producer custody; start a new observation.");
  // No cursor is accepted or issued until a durable, host/project-bound feed exists.
  return {
    schemaVersion: 1,
    producer: { serverId, pluginId: "factory" },
    observedAt,
    availability: "unavailable",
    receipts: null,
    nextCursor: null,
    coverage: { from: null, to: observedAt, complete: false, gaps, cursorState },
  };
}
