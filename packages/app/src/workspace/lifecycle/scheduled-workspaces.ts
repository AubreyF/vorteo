import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

interface HostSchedules {
  serverId: string;
  schedules: readonly ScheduleSummary[];
  agents: ReadonlyMap<string, { workspaceId?: string; archivedAt?: Date | null }>;
}

export function scheduledWorkspaceKeys(
  hosts: readonly HostSchedules[],
  now: number,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const host of hosts) {
    for (const schedule of host.schedules) {
      const ended =
        schedule.status === "completed" ||
        (schedule.expiresAt !== null && Date.parse(schedule.expiresAt) <= now);
      if (ended || schedule.target.type !== "agent") continue;
      const agent = host.agents.get(schedule.target.agentId);
      if (agent?.workspaceId && !agent.archivedAt)
        keys.add(`${host.serverId}:${agent.workspaceId}`);
    }
  }
  return keys;
}
