import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { RestartImpact } from "@getpaseo/protocol/execution-installation";

type RestartRecord = Pick<
  AgentSnapshotPayload,
  "id" | "status" | "archivedAt" | "activeTurn" | "pendingPermissions"
>;

export function isInactiveArchivedRestartError(
  impact: RestartImpact["agents"][number],
  record: RestartRecord | undefined,
): boolean {
  return (
    impact.status === "Codex session is not connected" &&
    record?.id === impact.id &&
    Boolean(record.archivedAt) &&
    (record.status === "idle" || record.status === "closed") &&
    record.activeTurn === null &&
    record.pendingPermissions.length === 0
  );
}

// COMPAT(archivedRestartDrain): older workers prepare disconnected archived history.
// A fresh record must establish inactivity; failed or unknown reads remain blockers.
export async function filterArchivedRestartErrors(
  agents: RestartImpact["agents"],
  read: (id: string) => Promise<RestartRecord | undefined>,
): Promise<RestartImpact["agents"]> {
  const blockers: RestartImpact["agents"] = [];
  for (const agent of agents) {
    if (agent.status === "Codex session is not connected") {
      const record = await read(agent.id);
      if (isInactiveArchivedRestartError(agent, record)) continue;
    }
    blockers.push(agent);
  }
  return blockers;
}
