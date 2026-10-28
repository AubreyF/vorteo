import {
  isSameSidebarFolderScope,
  sidebarFolderContainerKey,
  sidebarFolderEntry,
} from "@getpaseo/protocol/sidebar-folders";
import type {
  SidebarFolder,
  SidebarFolderScope,
  SidebarStatePatch,
} from "@getpaseo/protocol/sidebar-state";
import type { SidebarFolderState } from "./store";

const FOLDER_PREFIX = "folder:";

export const ROOT_FOLDER_SCOPE: SidebarFolderScope = { kind: "root" };

export function projectFolderScope(projectKey: string): SidebarFolderScope {
  return { kind: "project", projectKey };
}

export interface SidebarFolderRow {
  kind: "folder";
  key: string;
  folder: SidebarFolder;
  depth: number;
  collapsed: boolean;
  /** Items anywhere below this folder, for the collapsed count. */
  itemCount: number;
}

export interface SidebarItemRow<T> {
  kind: "item";
  key: string;
  item: T;
  depth: number;
  folderId: string | null;
}

export type SidebarTreeRow<T> = SidebarFolderRow | SidebarItemRow<T>;

export interface SidebarFolderDestination {
  folder: SidebarFolder;
  depth: number;
}

/** The children of each folder in one scope; the `null` entry lists the scope's top level. */
type ScopeChildren = Map<string | null, string[]>;

function folderIdOf(entry: string): string | null {
  return entry.startsWith(FOLDER_PREFIX) ? entry.slice(FOLDER_PREFIX.length) : null;
}

function scopeFolders(state: SidebarFolderState, scope: SidebarFolderScope): SidebarFolder[] {
  return Object.values(state.sidebarFolders)
    .filter((folder) => isSameSidebarFolderScope(folder.scope, scope))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}

function itemParent(input: {
  state: SidebarFolderState;
  scope: SidebarFolderScope;
  key: string;
}): string | null {
  const folderId = input.state.itemFolder[input.key];
  if (folderId === undefined) return null;
  const folder = input.state.sidebarFolders[folderId];
  return folder && isSameSidebarFolderScope(folder.scope, input.scope) ? folderId : null;
}

/**
 * Stored order first. Items it does not mention keep their place in the flat order: each sits
 * before the next item that follows it there, so new workspaces still appear at the top.
 */
function orderChildren(input: {
  stored: readonly string[];
  items: readonly string[];
  folders: readonly string[];
}): string[] {
  const members = new Set([...input.items, ...input.folders]);
  const sequence = [...new Set(input.stored.filter((entry) => members.has(entry)))];
  const placed = new Set(sequence);
  for (let index = input.items.length - 1; index >= 0; index -= 1) {
    const key = input.items[index]!;
    if (placed.has(key)) continue;
    const successor = input.items.slice(index + 1).find((next) => placed.has(next));
    const position = successor === undefined ? sequence.length : sequence.indexOf(successor);
    sequence.splice(position, 0, key);
    placed.add(key);
  }
  for (const entry of input.folders) if (!placed.has(entry)) sequence.push(entry);
  return sequence;
}

function buildScopeChildren(input: {
  state: SidebarFolderState;
  scope: SidebarFolderScope;
  keys: readonly string[];
}): ScopeChildren {
  const { state, scope } = input;
  const items = new Map<string | null, string[]>();
  for (const key of input.keys) {
    const parent = itemParent({ state, scope, key });
    items.set(parent, [...(items.get(parent) ?? []), key]);
  }
  const folders = new Map<string | null, string[]>();
  const all = scopeFolders(state, scope);
  for (const folder of all)
    folders.set(folder.parentId, [
      ...(folders.get(folder.parentId) ?? []),
      sidebarFolderEntry(folder.id),
    ]);
  const children: ScopeChildren = new Map();
  for (const parent of [null, ...all.map((folder) => folder.id)]) {
    children.set(
      parent,
      orderChildren({
        stored: state.childOrder[sidebarFolderContainerKey(scope, parent)] ?? [],
        items: items.get(parent) ?? [],
        folders: folders.get(parent) ?? [],
      }),
    );
  }
  return children;
}

function countItems(children: ScopeChildren, parent: string | null): number {
  let count = 0;
  for (const entry of children.get(parent) ?? []) {
    const folderId = folderIdOf(entry);
    count += folderId === null ? 1 : countItems(children, folderId);
  }
  return count;
}

/**
 * One scope as a flat list of rows with depth, so a single sortable list can show nested
 * folders. Collapsed folders hide their contents; `hideEmptyFolders` drops folders whose
 * subtree has no listed item, which is how filters hide empty folders.
 */
export function buildSidebarTreeRows<T>(input: {
  state: SidebarFolderState;
  scope: SidebarFolderScope;
  items: readonly T[];
  getKey: (item: T) => string;
  hideEmptyFolders: boolean;
}): SidebarTreeRow<T>[] {
  const itemByKey = new Map(input.items.map((item) => [input.getKey(item), item]));
  const children = buildScopeChildren({
    state: input.state,
    scope: input.scope,
    keys: [...itemByKey.keys()],
  });
  const rows: SidebarTreeRow<T>[] = [];
  function walk(parent: string | null, depth: number) {
    for (const entry of children.get(parent) ?? []) {
      const folderId = folderIdOf(entry);
      if (folderId === null) {
        rows.push({
          kind: "item",
          key: entry,
          item: itemByKey.get(entry)!,
          depth,
          folderId: parent,
        });
        continue;
      }
      const itemCount = countItems(children, folderId);
      if (input.hideEmptyFolders && itemCount === 0) continue;
      const collapsed = input.state.collapsedFolders[folderId] === true;
      const folder = input.state.sidebarFolders[folderId]!;
      rows.push({ kind: "folder", key: entry, folder, depth, collapsed, itemCount });
      if (!collapsed) walk(folderId, depth + 1);
    }
  }
  walk(null, 0);
  return rows;
}

/** Folders in one scope whose subtree holds at least one of `keys`; filters hide the rest. */
export function sidebarFolderIdsWithItems(input: {
  state: SidebarFolderState;
  scope: SidebarFolderScope;
  keys: readonly string[];
}): Set<string> {
  const children = buildScopeChildren(input);
  const kept = new Set<string>();
  for (const folder of scopeFolders(input.state, input.scope)) {
    if (countItems(children, folder.id) > 0) kept.add(folder.id);
  }
  return kept;
}

/** Every item key in display order with all folders expanded: the flat order older clients read. */
export function flattenSidebarScope(input: {
  state: SidebarFolderState;
  scope: SidebarFolderScope;
  keys: readonly string[];
}): string[] {
  const children = buildScopeChildren(input);
  const keys: string[] = [];
  function walk(parent: string | null) {
    for (const entry of children.get(parent) ?? []) {
      const folderId = folderIdOf(entry);
      if (folderId === null) keys.push(entry);
      else walk(folderId);
    }
  }
  walk(null);
  return keys;
}

function isWithin(state: SidebarFolderState, folderId: string | null, ancestorId: string): boolean {
  const seen = new Set<string>();
  let current = folderId;
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = state.sidebarFolders[current]?.parentId ?? null;
  }
  return false;
}

/** Folders an entry can move into, in display order. A folder cannot move into itself. */
export function listSidebarFolderDestinations(input: {
  state: SidebarFolderState;
  scope: SidebarFolderScope;
  movingFolderId: string | null;
}): SidebarFolderDestination[] {
  const children = buildScopeChildren({ state: input.state, scope: input.scope, keys: [] });
  const destinations: SidebarFolderDestination[] = [];
  function walk(parent: string | null, depth: number) {
    for (const entry of children.get(parent) ?? []) {
      const folderId = folderIdOf(entry)!;
      if (folderId === input.movingFolderId) continue;
      destinations.push({ folder: input.state.sidebarFolders[folderId]!, depth });
      walk(folderId, depth + 1);
    }
  }
  walk(null, 0);
  return destinations;
}

export function sidebarEntryParent(input: {
  state: SidebarFolderState;
  scope: SidebarFolderScope;
  entry: string;
}): string | null {
  const folderId = folderIdOf(input.entry);
  if (folderId === null)
    return itemParent({ state: input.state, scope: input.scope, key: input.entry });
  return input.state.sidebarFolders[folderId]?.parentId ?? null;
}

/** The flat order field that older clients read for this scope. */
function flatOrderPatch(scope: SidebarFolderScope, order: string[]): SidebarStatePatch {
  if (scope.kind === "root") return { projectOrder: order };
  return { workspaceOrderByProject: { [scope.projectKey]: order } };
}

function withoutNulls<T>(record: Record<string, T | null>): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) if (value !== null) kept[key] = value;
  return kept;
}

function sameList(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((key, index) => key === right[index])
  );
}

/**
 * Moves an item or `folder:<id>` entry into a folder (`null` for the scope's top level), before
 * `before`, else after `after`, else at the end. Returns null when nothing would change or the
 * move is impossible.
 * `keys` is the scope's full flat order, which the patch rewrites to match the new tree.
 */
export function moveSidebarEntryPatch(input: {
  state: SidebarFolderState;
  scope: SidebarFolderScope;
  entry: string;
  targetFolderId: string | null;
  before: string | null;
  after?: string | null;
  keys: readonly string[];
}): SidebarStatePatch | null {
  const { state, scope, entry, targetFolderId, before, keys } = input;
  const after = input.after ?? null;
  const movingFolderId = folderIdOf(entry);
  if (movingFolderId !== null && isWithin(state, targetFolderId, movingFolderId)) return null;
  const children = buildScopeChildren({ state, scope, keys });
  const sourceFolderId = sidebarEntryParent({ state, scope, entry });
  const sourceList = (children.get(sourceFolderId) ?? []).filter((key) => key !== entry);
  const targetList =
    sourceFolderId === targetFolderId
      ? [...sourceList]
      : (children.get(targetFolderId) ?? []).filter((key) => key !== entry);
  let position = before === null ? -1 : targetList.indexOf(before);
  if (position < 0 && after !== null) {
    const anchor = targetList.indexOf(after);
    position = anchor < 0 ? -1 : anchor + 1;
  }
  targetList.splice(position < 0 ? targetList.length : position, 0, entry);
  const targetKey = sidebarFolderContainerKey(scope, targetFolderId);
  if (sourceFolderId === targetFolderId && sameList(children.get(targetFolderId), targetList))
    return null;

  const childOrder: Record<string, string[]> = {
    [sidebarFolderContainerKey(scope, sourceFolderId)]: sourceList,
    [targetKey]: targetList,
  };
  const moving = movingFolderId === null ? null : state.sidebarFolders[movingFolderId]!;
  const sidebarFolders = moving ? { [moving.id]: { ...moving, parentId: targetFolderId } } : null;
  const itemFolder = moving ? null : { [entry]: targetFolderId };
  const next: SidebarFolderState = {
    ...state,
    childOrder: { ...state.childOrder, ...childOrder },
    sidebarFolders: { ...state.sidebarFolders, ...sidebarFolders },
    itemFolder: withoutNulls({ ...state.itemFolder, ...itemFolder }),
  };
  return {
    childOrder,
    ...(sidebarFolders ? { sidebarFolders } : { itemFolder: itemFolder! }),
    ...flatOrderPatch(scope, flattenSidebarScope({ state: next, scope, keys })),
  };
}

/**
 * Turns a dropped flat list back into a tree move. The dropped row joins the parent of the row
 * now below it, directly before that row; with nothing below, it goes to the end of the scope.
 */
export function reorderSidebarRowsPatch<T>(input: {
  state: SidebarFolderState;
  scope: SidebarFolderScope;
  rows: readonly SidebarTreeRow<T>[];
  movedKey: string;
  keys: readonly string[];
}): SidebarStatePatch | null {
  const index = input.rows.findIndex((row) => row.key === input.movedKey);
  if (index < 0) return null;
  const below = input.rows[index + 1];
  const targetFolderId =
    below === undefined
      ? null
      : sidebarEntryParent({ state: input.state, scope: input.scope, entry: below.key });
  return moveSidebarEntryPatch({
    state: input.state,
    scope: input.scope,
    entry: input.movedKey,
    targetFolderId,
    before: below?.key ?? null,
    keys: input.keys,
  });
}

export function createSidebarFolderPatch(input: {
  state: SidebarFolderState;
  scope: SidebarFolderScope;
  parentId: string | null;
  folder: { id: string; name: string; createdAt: string };
  keys: readonly string[];
}): SidebarStatePatch {
  const children = buildScopeChildren({ state: input.state, scope: input.scope, keys: input.keys });
  const folder: SidebarFolder = { ...input.folder, parentId: input.parentId, scope: input.scope };
  return {
    sidebarFolders: { [folder.id]: folder },
    childOrder: {
      [sidebarFolderContainerKey(input.scope, input.parentId)]: [
        ...(children.get(input.parentId) ?? []),
        sidebarFolderEntry(folder.id),
      ],
    },
  };
}
