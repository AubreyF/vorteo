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
