import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";

export function splitStandingWorkspaces(
  workspaces: readonly SidebarWorkspacePlacement[],
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
) {
  const work: SidebarWorkspacePlacement[] = [];
  const standing: SidebarWorkspacePlacement[] = [];
  for (const workspace of workspaces) {
    const group = entries.get(workspace.workspaceKey)?.standing ? standing : work;
    group.push(workspace);
  }
  return { work, standing };
}

export function splitFactoryWorkspaces(
  workspaces: readonly SidebarWorkspacePlacement[],
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  supportedHosts: ReadonlyMap<string, boolean>,
) {
  const factory: SidebarWorkspacePlacement[] = [];
  const remaining: SidebarWorkspacePlacement[] = [];
  for (const workspace of workspaces) {
    const entry = entries.get(workspace.workspaceKey);
    const supported = supportedHosts.get(workspace.serverId) === true;
    if (supported && entry?.factoryMembership) factory.push(workspace);
    else remaining.push(workspace);
  }
  return { ...splitStandingWorkspaces(remaining, entries), factory };
}

/** Native members determine observation routes even when a project spans hosts. */
export function factoryOverviewTargets(
  workspaces: readonly SidebarWorkspacePlacement[],
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  availableHosts: ReadonlySet<string>,
) {
  const targets = new Map<
    string,
    { serverId: string; projectId: string; installationId: string }
  >();
  const ambiguous = new Set<string>();
  for (const workspace of workspaces) {
    const entry = entries.get(workspace.workspaceKey);
    const membership = entry?.factoryMembership;
    if (
      !membership ||
      !availableHosts.has(workspace.serverId) ||
      membership.serverId !== workspace.serverId ||
      entry?.serverId !== workspace.serverId
    )
      continue;
    const key = JSON.stringify([membership.serverId, membership.projectId]);
    const previous = targets.get(key);
    if (previous && previous.installationId !== membership.installationId) ambiguous.add(key);
    targets.set(key, {
      serverId: membership.serverId,
      projectId: membership.projectId,
      installationId: membership.installationId,
    });
  }
  return Array.from(targets.entries())
    .filter(([key]) => !ambiguous.has(key))
    .map(([, target]) => target);
}
