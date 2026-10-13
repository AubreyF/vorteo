import { useCallback, useMemo, useState } from "react";
import { SidebarWorkspaceList } from "@/components/sidebar-workspace-list";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { resolveSidebarProjectIconTargets } from "@/utils/sidebar-project-row-model";
import { SidebarWidthContext } from "./sidebar-width";
import { SidebarInsetContext } from "./sidebar-separator";

/** The compact flyout uses the same project, workspace and managed-group controls as the sidebar. */
export function ProjectRailList({
  project,
  workspaceEntries,
  width,
  onNavigate,
}: {
  project: SidebarProjectEntry;
  workspaceEntries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  width: number;
  onNavigate: () => void;
}) {
  const projects = useMemo(() => [project], [project]);
  const targets = useMemo(() => resolveSidebarProjectIconTargets(projects), [projects]);
  const pinned = useMemo(() => ({ pinnedChats: [], unpinnedProjects: projects }), [projects]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (key: string) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  return (
    <SidebarWidthContext.Provider value={width}>
      <SidebarInsetContext.Provider value={2}>
        <SidebarWorkspaceList
          workspaceGroups={EMPTY_GROUPS}
          projectIconTargets={targets}
          pinnedGroups={pinned}
          projects={projects}
          hasProjectsBeforeFilter
          hasActiveProjectFilter={false}
          workspaceEntriesByKey={workspaceEntries}
          collapsedProjectKeys={collapsed}
          onToggleProjectCollapsed={toggle}
          shortcutIndexByWorkspaceKey={EMPTY_SHORTCUTS}
          groupMode="project"
          onWorkspacePress={onNavigate}
        />
      </SidebarInsetContext.Provider>
    </SidebarWidthContext.Provider>
  );
}
const EMPTY_GROUPS: never[] = [];
const EMPTY_SHORTCUTS = new Map<string, number>();
