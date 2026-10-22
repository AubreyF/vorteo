import {
  splitFactoryWorkspaces,
  splitSystemWorkspaces,
  type SidebarSystemGroup,
} from "@/workspace/lifecycle/grouping";
import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  resolveSidebarProjectIconTargets,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  /** The Vorteo System section, rendered after every other group in each mode. */
  systemGroups: SidebarSystemGroup[];
  /**
   * The project icons this projection needs fetched, keyed by `projectViewKey` — one per project,
   * whatever the mode groups by. It sits here rather than beside `useProjectIcons` in the list
   * because it is the same `projects` the rows above are projected from: a mode that renders a
   * row can only ever ask for an icon this list already covers. It used to be derived in the
   * list, under a `groupMode === "status"` gate written when status was the only mode that put
   * icons on rows.
   */
  projectIconTargets: SidebarProjectIconTarget[];
  shortcutModel: SidebarShortcutModel;
}

export interface SidebarProjectionInput {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  factorySupportedHosts?: ReadonlyMap<string, boolean>;
  systemSupportedHosts?: ReadonlyMap<string, boolean>;
}

const EMPTY_HOSTS: ReadonlyMap<string, boolean> = new Map();

export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  const splitPinned = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
  });
  const supportedSystemHosts = input.systemSupportedHosts ?? EMPTY_HOSTS;
  const systemWorkspaceKeys = new Set(
    splitSystemWorkspaces(
      input.projects.flatMap((project) => project.workspaces),
      input.workspaceEntriesByKey,
      supportedSystemHosts,
    ).system.flatMap((group) => group.workspaces.map((workspace) => workspace.workspaceKey)),
  );
  // Pinned system workspaces stay pinned; the rest move from their project into the section.
  const systemSplit = splitSystemWorkspaces(
    splitPinned.unpinnedProjects.flatMap((project) => project.workspaces),
    input.workspaceEntriesByKey,
    supportedSystemHosts,
  );
  const pinnedGroups: PinnedSidebarGroups = {
    pinnedChats: splitPinned.pinnedChats,
    unpinnedProjects: withoutSystemWorkspaces(
      input.projects,
      splitPinned.unpinnedProjects,
      systemWorkspaceKeys,
    ),
  };
  const pinnedWorkspaceKeys = new Set(input.pinnedKeys.pinnedWorkspaceKeys);
  const unpinnedWorkspaces = Array.from(input.workspaceEntriesByKey.values()).filter(
    (workspace) =>
      !pinnedWorkspaceKeys.has(workspace.workspaceKey) &&
      !systemWorkspaceKeys.has(workspace.workspaceKey),
  );
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows.
  const workspaceGroups = buildWorkspaceGroups(input, unpinnedWorkspaces);

  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (input.groupMode === "project") {
    sections.push(
      ...pinnedGroups.unpinnedProjects.flatMap((project) => {
        const collapsed = input.collapsedProjectKeys.has(project.viewKey);
        const groups = splitFactoryWorkspaces(
          project.workspaces,
          input.workspaceEntriesByKey,
          input.factorySupportedHosts ?? new Map(),
        );
        const standingCollapsed =
          collapsed || input.collapsedWorkspaceGroupKeys.has(`standing:${project.viewKey}`);
        return [
          { workspaces: groups.work, collapsed },
          {
            workspaces: groups.factory,
            collapsed:
              collapsed || input.collapsedWorkspaceGroupKeys.has(`factory:${project.viewKey}`),
          },
          { workspaces: groups.standing, collapsed: standingCollapsed },
        ];
      }),
    );
  } else {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  }
  sections.push(
    ...systemSplit.system.map((group) => ({
      workspaces: group.workspaces,
      // Host headings, and so their own collapse, appear only when several hosts contribute.
      collapsed:
        input.collapsedWorkspaceGroupKeys.has(SYSTEM_SECTION_KEY) ||
        (systemSplit.system.length > 1 &&
          input.collapsedWorkspaceGroupKeys.has(`${SYSTEM_SECTION_KEY}:${group.serverId}`)),
    })),
  );

  return {
    pinnedGroups,
    workspaceGroups,
    systemGroups: systemSplit.system,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

export const SYSTEM_SECTION_KEY = "system";

/**
 * A project made only of System project members leaves the project list entirely, even when its
 * remaining members are pinned, so its header never stands empty above the list.
 */
function withoutSystemWorkspaces(
  projects: readonly SidebarProjectEntry[],
  unpinnedProjects: SidebarProjectEntry[],
  systemWorkspaceKeys: ReadonlySet<string>,
): SidebarProjectEntry[] {
  if (systemWorkspaceKeys.size === 0) return unpinnedProjects;
  const systemProjectKeys = new Set(
    projects
      .filter(
        (project) =>
          project.workspaces.length > 0 &&
          project.workspaces.every((workspace) => systemWorkspaceKeys.has(workspace.workspaceKey)),
      )
      .map((project) => project.viewKey),
  );
  return unpinnedProjects.flatMap((project) => {
    if (systemProjectKeys.has(project.viewKey)) return [];
    const workspaces = project.workspaces.filter(
      (workspace) => !systemWorkspaceKeys.has(workspace.workspaceKey),
    );
    return [workspaces.length === project.workspaces.length ? project : { ...project, workspaces }];
  });
}

/** Project mode keeps its project headers and groups nothing; status mode groups the rows. */
function buildWorkspaceGroups(
  input: SidebarProjectionInput,
  unpinnedWorkspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup[] {
  switch (input.groupMode) {
    case "project":
      return [];
    case "status":
      return statusWorkspaceGroups(
        buildStatusGroups(unpinnedWorkspaces, input.projectNamesByViewKey),
      );
  }
}
