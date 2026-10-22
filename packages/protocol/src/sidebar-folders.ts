import type {
  SidebarFolder,
  SidebarFolderScope,
  SidebarState,
  SidebarStatePatch,
} from "./sidebar-state.js";

export const SIDEBAR_ROOT_CONTAINER = "root";

export function sidebarFolderEntry(folderId: string): string {
  return `folder:${folderId}`;
}

/** The `childOrder` key that lists the children of a folder, or of a scope's top level. */
export function sidebarFolderContainerKey(
  scope: SidebarFolderScope,
  folderId: string | null,
): string {
  if (folderId !== null) return sidebarFolderEntry(folderId);
  return scope.kind === "root" ? SIDEBAR_ROOT_CONTAINER : `project:${scope.projectKey}`;
}

export function isSameSidebarFolderScope(
  left: SidebarFolderScope,
  right: SidebarFolderScope,
): boolean {
  if (left.kind === "root" || right.kind === "root") return left.kind === right.kind;
  return left.projectKey === right.projectKey;
}

export class SidebarFolderPatchError extends Error {
  constructor(
    readonly folderId: string,
    readonly reason: "id_mismatch" | "own_parent",
  ) {
    super(
      reason === "id_mismatch"
        ? `Sidebar folder ${folderId} must be stored under its own id.`
        : `Sidebar folder ${folderId} cannot be its own parent.`,
    );
    this.name = "SidebarFolderPatchError";
  }
}

/** Rejects folder records that are malformed whatever the stored state. */
export function validateSidebarFolderPatch(patch: SidebarStatePatch): void {
  for (const [key, folder] of Object.entries(patch.sidebarFolders ?? {})) {
    if (folder === null) continue;
    if (folder.id !== key) throw new SidebarFolderPatchError(key, "id_mismatch");
    if (folder.parentId === key) throw new SidebarFolderPatchError(key, "own_parent");
  }
}

type Folders = Record<string, SidebarFolder>;

interface FolderRepair {
  folders: Folders;
  itemFolder: Record<string, string>;
  childOrder: Record<string, string[]>;
  collapsedFolders: Record<string, boolean>;
}

function depthOf(folders: Folders, id: string): number {
  let depth = 0;
  const seen = new Set<string>();
  let parentId = folders[id]?.parentId ?? null;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = folders[parentId]?.parentId ?? null;
  }
  return depth;
}

/** The nearest ancestor that survives the removal, using the tree as it stood before the patch. */
function survivingAncestor(input: {
  previous: Folders;
  current: Folders;
  removedId: string;
}): string | null {
  const seen = new Set<string>();
  let parentId = input.previous[input.removedId]?.parentId ?? null;
  while (parentId !== null && !input.current[parentId] && !seen.has(parentId)) {
    seen.add(parentId);
    parentId = input.previous[parentId]?.parentId ?? null;
  }
  return parentId;
}

function spliceEntries(list: string[], entry: string, replacement: string[]): string[] {
  const index = list.indexOf(entry);
  if (index < 0) return [...list, ...replacement];
  return [...list.slice(0, index), ...replacement, ...list.slice(index + 1)];
}

function removeFolders(repair: FolderRepair, previous: Folders, removedIds: string[]): void {
  const removed = new Set(removedIds);
  const replacement = new Map(
    removedIds.map((id) => [
      id,
      survivingAncestor({ previous, current: repair.folders, removedId: id }),
    ]),
  );
  // Deepest first, so a removed child's contents travel up through a removed parent.
  const ordered = [...removedIds].sort(
    (left, right) =>
      depthOf(previous, right) - depthOf(previous, left) || left.localeCompare(right),
  );
  for (const id of ordered) {
    const folder = previous[id]!;
    const entries = repair.childOrder[sidebarFolderEntry(id)] ?? [];
    delete repair.childOrder[sidebarFolderEntry(id)];
    const parentId =
      folder.parentId !== null && removed.has(folder.parentId)
        ? folder.parentId
        : (replacement.get(id) ?? null);
    const parentKey = sidebarFolderContainerKey(folder.scope, parentId);
    const siblings = repair.childOrder[parentKey];
    if (siblings)
      repair.childOrder[parentKey] = spliceEntries(siblings, sidebarFolderEntry(id), entries);
    else if (entries.length > 0) repair.childOrder[parentKey] = entries;
    delete repair.collapsedFolders[id];
  }
  for (const folder of Object.values(repair.folders)) {
    if (folder.parentId !== null && removed.has(folder.parentId))
      repair.folders[folder.id] = { ...folder, parentId: replacement.get(folder.parentId) ?? null };
  }
  for (const [itemKey, folderId] of Object.entries(repair.itemFolder)) {
    if (!removed.has(folderId)) continue;
    const parentId = replacement.get(folderId) ?? null;
    if (parentId === null) delete repair.itemFolder[itemKey];
    else repair.itemFolder[itemKey] = parentId;
  }
}

function isValidParent(folders: Folders, folder: SidebarFolder, parentId: string): boolean {
  const parent = folders[parentId];
  return parent !== undefined && isSameSidebarFolderScope(parent.scope, folder.scope);
}

function cycleThrough(folders: Folders, id: string): string[] | null {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = folders[current]?.parentId ?? null;
  }
  if (current !== id) return null;
  return path;
}

function wouldCreateCycle(folders: Folders, id: string, parentId: string): boolean {
  const seen = new Set<string>();
  let current: string | null = parentId;
  while (current !== null && !seen.has(current)) {
    if (current === id) return true;
    seen.add(current);
    current = folders[current]?.parentId ?? null;
  }
  return false;
}

/** Concurrent moves can form a cycle. The move this patch made yields, back to its old parent. */
function breakCycles(repair: FolderRepair, previous: Folders, changed: ReadonlySet<string>): void {
  for (const id of Object.keys(repair.folders).sort()) {
    let cycle = cycleThrough(repair.folders, id);
    while (cycle) {
      const members = [...cycle].sort();
      const cut = members.find((member) => changed.has(member)) ?? members[0]!;
      const folder = repair.folders[cut]!;
      const previousParent = previous[cut]?.parentId ?? null;
      const restored =
        previousParent !== null &&
        isValidParent(repair.folders, folder, previousParent) &&
        !wouldCreateCycle(repair.folders, cut, previousParent);
      repair.folders[cut] = { ...folder, parentId: restored ? previousParent : null };
      cycle = cycleThrough(repair.folders, id);
    }
  }
}

function workspaceOwners(state: SidebarState): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const [projectKey, workspaceKeys] of Object.entries(state.workspaceOrderByProject)) {
    for (const workspaceKey of workspaceKeys) {
      const projects = owners.get(workspaceKey) ?? new Set<string>();
      projects.add(projectKey);
      owners.set(workspaceKey, projects);
    }
  }
  return owners;
}

/**
 * Projects belong in root folders and workspaces in folders of their own project. The kind of
 * key is only known when the flat orders mention it, so unknown keys follow the folder's scope.
 */
function isPlacementAllowed(input: {
  itemKey: string;
  folder: SidebarFolder;
  projectKeys: ReadonlySet<string>;
  owners: ReadonlyMap<string, ReadonlySet<string>>;
}): boolean {
  const projects = input.owners.get(input.itemKey);
  const isProject = input.projectKeys.has(input.itemKey);
  if (input.folder.scope.kind === "root") return isProject || projects === undefined;
  if (isProject && projects === undefined) return false;
  return projects === undefined || projects.has(input.folder.scope.projectKey);
}

function pruneMissingFolders(repair: FolderRepair, state: SidebarState): void {
  const projectKeys = new Set(state.projectOrder);
  const owners = workspaceOwners(state);
  for (const [itemKey, folderId] of Object.entries(repair.itemFolder)) {
    const folder = repair.folders[folderId];
    if (!folder || !isPlacementAllowed({ itemKey, folder, projectKeys, owners }))
      delete repair.itemFolder[itemKey];
  }
  const isMissingFolder = (entry: string) =>
    entry.startsWith("folder:") && !repair.folders[entry.slice("folder:".length)];
  for (const [containerKey, entries] of Object.entries(repair.childOrder)) {
    if (isMissingFolder(containerKey)) {
      delete repair.childOrder[containerKey];
      continue;
    }
    if (entries.some(isMissingFolder))
      repair.childOrder[containerKey] = entries.filter((entry) => !isMissingFolder(entry));
  }
  for (const folderId of Object.keys(repair.collapsedFolders)) {
    if (!repair.folders[folderId]) delete repair.collapsedFolders[folderId];
  }
}

/**
 * Repairs the folder tree after a patch: removed folders hand their contents to their parent,
 * parents must exist in the same scope, cycles are broken and misplaced items return to the top.
 */
export function normalizeSidebarFolders(input: {
  previous: SidebarState;
  patch: SidebarStatePatch;
  next: SidebarState;
}): SidebarState {
  const { previous, patch, next } = input;
  const { sidebarFolders, itemFolder, childOrder, collapsedFolders, ...base } = next;
  const hasFolderState =
    sidebarFolders !== undefined ||
    itemFolder !== undefined ||
    childOrder !== undefined ||
    collapsedFolders !== undefined;
  if (!hasFolderState) return base;

  const previousFolders = previous.sidebarFolders ?? {};
  const repair: FolderRepair = {
    folders: { ...sidebarFolders },
    itemFolder: { ...itemFolder },
    childOrder: { ...childOrder },
    collapsedFolders: { ...collapsedFolders },
  };
  const patchedFolders = Object.entries(patch.sidebarFolders ?? {});
  const removedIds = patchedFolders
    .filter(([id, folder]) => folder === null && previousFolders[id] && !repair.folders[id])
    .map(([id]) => id);
  if (removedIds.length > 0) removeFolders(repair, previousFolders, removedIds);

  for (const folder of Object.values(repair.folders)) {
    if (folder.parentId !== null && !isValidParent(repair.folders, folder, folder.parentId))
      repair.folders[folder.id] = { ...folder, parentId: null };
  }
  const changed = new Set(patchedFolders.filter(([, folder]) => folder !== null).map(([id]) => id));
  breakCycles(repair, previousFolders, changed);
  pruneMissingFolders(repair, next);

  return {
    ...base,
    sidebarFolders: repair.folders,
    itemFolder: repair.itemFolder,
    childOrder: repair.childOrder,
    collapsedFolders: repair.collapsedFolders,
  };
}
