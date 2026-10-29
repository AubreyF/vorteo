import { z } from "zod";
import { sidebarFolderEntry } from "@getpaseo/protocol/sidebar-folders";
import type { SidebarFolder } from "@getpaseo/protocol/sidebar-state";
import type { SidebarFolderState } from "@/sidebar-folders/store";
import {
  ROOT_FOLDER_SCOPE,
  projectFolderScope,
  sidebarFolderIdsWithItems,
  type SidebarTreeRow,
} from "@/sidebar-folders/tree";
import type { SidebarDropTop } from "@/sidebar-drop/resolve";

export const SidebarFocusSectionSchema = z.enum(["standing", "factory"]);
export type SidebarFocusSection = z.infer<typeof SidebarFocusSectionSchema>;

export const SidebarFocusTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectKey: z.string() }),
  z.object({ kind: z.literal("folder"), folderId: z.string() }),
  z.object({
    kind: z.literal("section"),
    projectKey: z.string(),
    section: SidebarFocusSectionSchema,
  }),
]);
export type SidebarFocusTarget = z.infer<typeof SidebarFocusTargetSchema>;

/** The focused item plus its ancestors at the time of focusing, outermost first. */
export const StoredSidebarFocusSchema = z.object({
  target: SidebarFocusTargetSchema,
  ancestors: z.array(SidebarFocusTargetSchema),
});
export type StoredSidebarFocus = z.infer<typeof StoredSidebarFocusSchema>;

export interface SidebarFocusProject {
  name: string;
  sections: readonly SidebarFocusSection[];
}

/** What the sidebar currently lists, so focus can find its targets and their ancestors. */
export interface SidebarFocusWorld {
  folders: Readonly<Record<string, SidebarFolder>>;
  /** Project view keys to root folders, and workspace keys to project folders. */
  itemFolder: Readonly<Record<string, string>>;
  /** Listed projects after filters, by view key. */
  projects: ReadonlyMap<string, SidebarFocusProject>;
  /** Folders a filter emptied out of the list. */
  hiddenFolderIds: ReadonlySet<string>;
}

export interface SidebarFocusProjectInput extends SidebarFocusProject {
  key: string;
  workspaceKeys: readonly string[];
}

export function buildSidebarFocusWorld(input: {
  folderState: SidebarFolderState;
  projects: readonly SidebarFocusProjectInput[];
  hideEmptyFolders: boolean;
}): SidebarFocusWorld {
  const { folderState, projects, hideEmptyFolders } = input;
  const hiddenFolderIds = new Set<string>();
  if (hideEmptyFolders) {
    const kept = sidebarFolderIdsWithItems({
      state: folderState,
      scope: ROOT_FOLDER_SCOPE,
      keys: projects.map((project) => project.key),
    });
    for (const project of projects) {
      const projectKept = sidebarFolderIdsWithItems({
        state: folderState,
        scope: projectFolderScope(project.key),
        keys: project.workspaceKeys,
      });
      for (const id of projectKept) kept.add(id);
    }
    for (const id of Object.keys(folderState.sidebarFolders)) {
      if (!kept.has(id)) hiddenFolderIds.add(id);
    }
  }
  return {
    folders: folderState.sidebarFolders,
    itemFolder: folderState.itemFolder,
    projects: new Map(
      projects.map((project) => [project.key, { name: project.name, sections: project.sections }]),
    ),
    hiddenFolderIds,
  };
}

export interface SidebarFocusCrumb {
  key: string;
  label: string;
  /** Null for "All projects", which leaves focus. */
  target: SidebarFocusTarget | null;
}

export interface SidebarFocusLabels {
  allProjects: string;
  standing: string;
  factory: string;
}

function parentOf(target: SidebarFocusTarget, world: SidebarFocusWorld): SidebarFocusTarget | null {
  if (target.kind === "section") return { kind: "project", projectKey: target.projectKey };
  if (target.kind === "project") {
    const folderId = world.itemFolder[target.projectKey];
    const folder = folderId === undefined ? undefined : world.folders[folderId];
    return folder?.scope.kind === "root" ? { kind: "folder", folderId: folder.id } : null;
  }
  const folder = world.folders[target.folderId];
  if (!folder) return null;
  if (folder.parentId !== null) return { kind: "folder", folderId: folder.parentId };
  return folder.scope.kind === "project"
    ? { kind: "project", projectKey: folder.scope.projectKey }
    : null;
}

function isListed(target: SidebarFocusTarget, world: SidebarFocusWorld): boolean {
  if (target.kind === "project") return world.projects.has(target.projectKey);
  if (target.kind === "section") {
    return world.projects.get(target.projectKey)?.sections.includes(target.section) === true;
  }
  const folder = world.folders[target.folderId];
  if (!folder || world.hiddenFolderIds.has(folder.id)) return false;
  return folder.scope.kind === "root" || world.projects.has(folder.scope.projectKey);
}

/** What the store keeps for a newly focused target: it and its ancestors, for later fallback. */
export function storedSidebarFocus(
  target: SidebarFocusTarget,
  world: SidebarFocusWorld,
): StoredSidebarFocus {
  return { target, ancestors: sidebarFocusAncestors(target, world) };
}

/** Ancestors of a listed target, outermost first. */
export function sidebarFocusAncestors(
  target: SidebarFocusTarget,
  world: SidebarFocusWorld,
): SidebarFocusTarget[] {
  const ancestors: SidebarFocusTarget[] = [];
  const seen = new Set<string>();
  let current = parentOf(target, world);
  while (current !== null && !seen.has(sidebarFocusKey(current))) {
    seen.add(sidebarFocusKey(current));
    ancestors.unshift(current);
    current = parentOf(current, world);
  }
  return ancestors;
}

/**
 * The item focus shows now: the stored target while it is listed, otherwise its nearest
 * listed ancestor, otherwise null for all projects. Deleted, archived and filtered items all
 * fall back this way.
 */
export function resolveSidebarFocus(
  stored: StoredSidebarFocus | null,
  world: SidebarFocusWorld,
): SidebarFocusTarget | null {
  if (stored === null) return null;
  if (isListed(stored.target, world)) return stored.target;
  const known = isKnown(stored.target, world)
    ? sidebarFocusAncestors(stored.target, world)
    : stored.ancestors;
  for (const ancestor of known.toReversed()) {
    if (isListed(ancestor, world)) return ancestor;
  }
  return null;
}

function isKnown(target: SidebarFocusTarget, world: SidebarFocusWorld): boolean {
  return target.kind !== "folder" || world.folders[target.folderId] !== undefined;
}

export function sidebarFocusKey(target: SidebarFocusTarget): string {
  if (target.kind === "folder") return `folder:${target.folderId}`;
  if (target.kind === "project") return `project:${target.projectKey}`;
  return `section:${target.section}:${target.projectKey}`;
}

export function isSameSidebarFocus(
  left: SidebarFocusTarget | null,
  right: SidebarFocusTarget | null,
): boolean {
  if (left === null || right === null) return left === right;
  return sidebarFocusKey(left) === sidebarFocusKey(right);
}

function labelOf(
  target: SidebarFocusTarget,
  world: SidebarFocusWorld,
  labels: SidebarFocusLabels,
): string {
  if (target.kind === "folder") return world.folders[target.folderId]?.name ?? "";
  if (target.kind === "project") return world.projects.get(target.projectKey)?.name ?? "";
  return labels[target.section];
}

/** "All projects", then each ancestor, then the focused item. */
export function sidebarFocusTrail(input: {
  target: SidebarFocusTarget;
  world: SidebarFocusWorld;
  labels: SidebarFocusLabels;
}): SidebarFocusCrumb[] {
  const { target, world, labels } = input;
  const path = [...sidebarFocusAncestors(target, world), target];
  return [
    { key: "all", label: labels.allProjects, target: null },
    ...path.map((entry) => ({
      key: sidebarFocusKey(entry),
      label: labelOf(entry, world, labels),
      target: entry,
    })),
  ];
}

/** The project whose block holds the focused item, or null for a root folder. */
export function sidebarFocusProjectKey(
  target: SidebarFocusTarget,
  world: SidebarFocusWorld,
): string | null {
  if (target.kind !== "folder") return target.projectKey;
  const folder = world.folders[target.folderId];
  return folder?.scope.kind === "project" ? folder.scope.projectKey : null;
}

/**
 * What lies beneath the focused row, as the top level: its descendants with depths rebased so
 * its direct children sit at depth 0. The focused row itself is not listed; the breadcrumb
 * names it instead.
 */
export function focusTreeRows<T>(
  rows: readonly SidebarTreeRow<T>[],
  key: string,
): SidebarTreeRow<T>[] {
  const start = rows.findIndex((row) => row.key === key);
  if (start < 0) return [];
  const base = rows[start]!.depth + 1;
  const focused: SidebarTreeRow<T>[] = [];
  for (let index = start + 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.depth < base) break;
    focused.push({ ...row, depth: row.depth - base });
  }
  return focused;
}

/**
 * Root-list rows while focused. A root folder lists its contents. Anything inside a project
 * keeps only that project's block at depth 0, which then renders without its header.
 */
export function sidebarFocusRootRows<T>(
  rows: readonly SidebarTreeRow<T>[],
  target: SidebarFocusTarget,
  world: SidebarFocusWorld,
): SidebarTreeRow<T>[] {
  const projectKey = sidebarFocusProjectKey(target, world);
  if (projectKey === null) {
    return target.kind === "folder" ? focusTreeRows(rows, sidebarFolderEntry(target.folderId)) : [];
  }
  const row = rows.find((entry) => entry.key === projectKey);
  return row ? [{ ...row, depth: 0 }] : [];
}

/** The container that receives top-level drops in the focused root list. */
export function sidebarFocusRootDropTop(
  target: SidebarFocusTarget,
  world: SidebarFocusWorld,
): SidebarDropTop {
  if (target.kind !== "folder" || sidebarFocusProjectKey(target, world) !== null) return null;
  return {
    key: sidebarFolderEntry(target.folderId),
    kind: "rootFolder",
    projectKey: null,
    section: null,
  };
}

/**
 * How a project block renders under focus: unfocused, as the focused project, or as the frame
 * around a focused folder or section inside it.
 */
export type SidebarProjectBlockFocus =
  | { kind: "project" }
  | { kind: "folder"; folderId: string }
  | { kind: "section"; section: SidebarFocusSection };

export interface SidebarProjectBlockLevels {
  /** The project's own row. Hidden whenever the project or something inside it is focused. */
  showHeader: boolean;
  /** Level of the ordinary list's depth-0 rows. */
  childLevel: number;
  /** Level of the Standing and Factory headings; null when the focused section hides it. */
  sectionLevel: number | null;
  /** Level of Standing and Factory workspaces. */
  sectionItemLevel: number;
}

/** Hierarchy level of a project's direct children when the project row is shown. */
export const PROJECT_CHILD_LEVEL = 1;

/** Focused contents are the top level, so they start at level 0 under the breadcrumb. */
export function sidebarProjectBlockLevels(
  focus: SidebarProjectBlockFocus | null,
): SidebarProjectBlockLevels {
  if (focus === null) {
    return {
      showHeader: true,
      childLevel: PROJECT_CHILD_LEVEL,
      sectionLevel: PROJECT_CHILD_LEVEL,
      sectionItemLevel: PROJECT_CHILD_LEVEL + 1,
    };
  }
  if (focus.kind === "section") {
    return { showHeader: false, childLevel: 0, sectionLevel: null, sectionItemLevel: 0 };
  }
  return { showHeader: false, childLevel: 0, sectionLevel: 0, sectionItemLevel: 1 };
}

export function isSidebarSectionShown(
  focus: SidebarProjectBlockFocus | null,
  section: SidebarFocusSection,
): boolean {
  if (focus === null || focus.kind === "project") return true;
  return focus.kind === "section" && focus.section === section;
}

function folderPath(state: SidebarFolderState, folderId: string | null): string[] {
  const path: string[] = [];
  let current = folderId;
  while (current !== null && !path.includes(current)) {
    const folder = state.sidebarFolders[current];
    if (!folder) break;
    path.push(current);
    current = folder.parentId;
  }
  return path;
}

/**
 * View-only copy with every folder on the way to the focused item unfolded: the focused
 * folder, its folder ancestors and the project's root folders. Stored folding is unchanged.
 */
export function expandSidebarFocusPath(
  state: SidebarFolderState,
  target: SidebarFocusTarget,
  world: SidebarFocusWorld,
): SidebarFolderState {
  const projectKey = sidebarFocusProjectKey(target, world);
  const folderIds = [
    ...(target.kind === "folder" ? folderPath(state, target.folderId) : []),
    ...(projectKey === null ? [] : folderPath(state, world.itemFolder[projectKey] ?? null)),
  ];
  if (!folderIds.some((id) => state.collapsedFolders[id] === true)) return state;
  const collapsedFolders = { ...state.collapsedFolders };
  for (const id of folderIds) delete collapsedFolders[id];
  return { ...state, collapsedFolders };
}

/** Whether a row's Focus button shows, and whether it is a hover-only extra. */
export function sidebarRowFocusVisibility(input: {
  isHovered: boolean;
  /** Touch, compact and native layouts, where rows cannot be hovered. */
  hoverUnavailable: boolean;
}): { button: boolean; hoverOnly: boolean } {
  return {
    button: input.isHovered || input.hoverUnavailable,
    hoverOnly: input.isHovered && !input.hoverUnavailable,
  };
}

/**
 * Whether the breadcrumb's trailing actions show. Hidden actions stay mounted and focusable,
 * so keyboard focus inside them reveals them exactly as hover does.
 */
export function sidebarBreadcrumbActionsVisible(input: {
  isHovered: boolean;
  hasFocusWithin: boolean;
  hoverUnavailable: boolean;
}): boolean {
  return input.isHovered || input.hasFocusWithin || input.hoverUnavailable;
}
