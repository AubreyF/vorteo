import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

interface HostSchedules {
  serverId: string;
  schedules: readonly ScheduleSummary[];
  agents: ReadonlyMap<string, { workspaceId?: string; archivedAt?: Date | null }>;
}

export type WorkspaceScheduleState = "scheduled" | "paused";

export function scheduledWorkspaceStates(
  hosts: readonly HostSchedules[],
  now: number,
): ReadonlyMap<string, WorkspaceScheduleState> {
  const states = new Map<string, WorkspaceScheduleState>();
  for (const host of hosts) {
    for (const schedule of host.schedules) {
      const ended =
        schedule.status === "completed" ||
        (schedule.expiresAt !== null && Date.parse(schedule.expiresAt) <= now);
      if (ended || schedule.target.type !== "agent") continue;
      const agent = host.agents.get(schedule.target.agentId);
      if (!agent?.workspaceId || agent.archivedAt) continue;
      const key = `${host.serverId}:${agent.workspaceId}`;
      // An active schedule takes precedence when a workspace also has paused schedules.
      if (schedule.status === "active") states.set(key, "scheduled");
      else if (!states.has(key)) states.set(key, "paused");
    }
  }
  return states;
}
