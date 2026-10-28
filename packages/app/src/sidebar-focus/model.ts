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

/** The root-list row that carries the focus: the root folder itself or the project. */
export function sidebarFocusRootRowKey(
  target: SidebarFocusTarget,
  world: SidebarFocusWorld,
): string {
  if (target.kind !== "folder") return target.projectKey;
  const folder = world.folders[target.folderId];
  return folder?.scope.kind === "project"
    ? folder.scope.projectKey
    : sidebarFolderEntry(target.folderId);
}

/**
 * The focused row as the top level, with what lies beneath it in the same list. Depths are
 * rebased so the focused row sits at depth 0.
 */
export function focusTreeRows<T>(
  rows: readonly SidebarTreeRow<T>[],
  key: string,
): SidebarTreeRow<T>[] {
  const start = rows.findIndex((row) => row.key === key);
  if (start < 0) return [];
  const base = rows[start]!.depth;
  const focused: SidebarTreeRow<T>[] = [];
  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (index > start && row.depth <= base) break;
    focused.push({ ...row, depth: row.depth - base });
  }
  return focused;
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
