import type { DaemonServerInfo, WorkspaceDescriptor } from "@/stores/session-store";
import { systemWorkspaceKind } from "@/workspace/lifecycle/system-workspace";

export const SYSTEM_SOURCE_TITLE = "Vorteo source";

export interface SystemWorkspaceLink {
  workspaceId: string;
  title: string;
}

export interface SystemHostSummary {
  serverId: string;
  label: string;
  managed: SystemWorkspaceLink[];
  /** The operator's source checkout in the System project, once it exists. */
  source: SystemWorkspaceLink | null;
  /** Offered only on hosts that advertise source setup and have no checkout yet. */
  canSetUpSource: boolean;
}

interface SystemHostSession {
  serverInfo?: DaemonServerInfo | null;
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>;
}

function workspaceTitle(workspace: WorkspaceDescriptor): string {
  return workspace.title?.trim() || workspace.name;
}

function isSourceCheckout(workspace: WorkspaceDescriptor): boolean {
  return (
    workspaceTitle(workspace) === SYSTEM_SOURCE_TITLE ||
    workspace.workspaceKind === "local_checkout"
  );
}

/** One summary per connected host that advertises the System project, in host order. */
export function buildSystemHostSummaries(input: {
  hosts: readonly { serverId: string; label: string }[];
  sessions: Readonly<Record<string, SystemHostSession | undefined>>;
}): SystemHostSummary[] {
  return input.hosts.flatMap((host) => {
    const session = input.sessions[host.serverId];
    const features = session?.serverInfo?.features;
    if (!session || features?.systemProject !== true) return [];
    const managed: SystemWorkspaceLink[] = [];
    let source: SystemWorkspaceLink | null = null;
    for (const workspace of session.workspaces.values()) {
      const kind = systemWorkspaceKind(workspace, true);
      const link = { workspaceId: workspace.id, title: workspaceTitle(workspace) };
      if (kind === "managed") managed.push(link);
      else if (kind === "operator" && !source && isSourceCheckout(workspace)) source = link;
    }
    managed.sort((left, right) => left.title.localeCompare(right.title));
    return [
      {
        serverId: host.serverId,
        label: host.label,
        managed,
        source,
        canSetUpSource: features.systemProjectSource === true && source === null,
      },
    ];
  });
}
