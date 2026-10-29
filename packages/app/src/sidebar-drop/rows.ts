import type { DraggableListExternalDrop } from "@/components/draggable-list.types";
import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";
import type { SidebarTreeRow } from "@/sidebar-folders/tree";
import type { SidebarDropRow, SidebarDropSection, SidebarDropTop } from "./resolve";

const FOLDER_PREFIX = "folder:";

/** The folder id inside a `folder:<id>` row key, or null for item rows. */
export function folderIdOfEntry(key: string): string | null {
  return key.startsWith(FOLDER_PREFIX) ? key.slice(FOLDER_PREFIX.length) : null;
}

/** Root list rows: root folders and project blocks, which drag as single rows. */
export function describeRootRow<T>(row: SidebarTreeRow<T>): SidebarDropRow {
  if (row.kind === "folder") {
    return {
      key: row.key,
      kind: "rootFolder",
      depth: row.depth,
      expanded: !row.collapsed,
      projectKey: null,
      section: null,
    };
  }
  return {
    key: row.key,
    kind: "project",
    depth: row.depth,
    expanded: false,
    projectKey: row.key,
    section: null,
  };
}

/** A project's ordinary list: project folders and workspaces. */
export function workRowDescriber(projectKey: string) {
  return function describeWorkRow<T>(row: SidebarTreeRow<T>): SidebarDropRow {
    const folder = row.kind === "folder";
    return {
      key: row.key,
      kind: folder ? "projectFolder" : "workspace",
      depth: row.depth,
      expanded: folder ? !row.collapsed : false,
      projectKey,
      section: null,
    };
  };
}

export function projectDropTop(projectKey: string): SidebarDropTop {
  return { key: projectKey, kind: "project", projectKey, section: null };
}

export function sectionDropTop(projectKey: string, section: SidebarDropSection): SidebarDropTop {
  return { key: `${section}:${projectKey}`, kind: "section", projectKey, section };
}

/** Standing and Factory lists: workspaces only, each at the section's top level. */
export function sectionWorkspaceDescriber(projectKey: string, section: SidebarDropSection) {
  return function describeSectionWorkspace(workspace: SidebarWorkspacePlacement): SidebarDropRow {
    return {
      key: workspace.workspaceKey,
      kind: "workspace",
      depth: 0,
      expanded: false,
      projectKey,
      section,
    };
  };
}

/** Lets a list of tree rows offer its item rows to targets that take items, such as projects. */
export function treeRowExternalDrop<T>(
  drop: DraggableListExternalDrop<T> | undefined,
): DraggableListExternalDrop<SidebarTreeRow<T>> | undefined {
  if (!drop) return undefined;
  return {
    targets: drop.targets,
    onDrop: (row, targetId) => {
      if (row.kind === "item") drop.onDrop(row.item, targetId);
    },
    onTargetChange: (targetId, row) =>
      drop.onTargetChange(targetId, row?.kind === "item" ? row.item : undefined),
  };
}
