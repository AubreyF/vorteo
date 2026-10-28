import { create } from "zustand";
import type { SidebarFolderState } from "@/sidebar-folders/store";
import type { SidebarDragKind } from "./resolve";

const FOLDER_PREFIX = "folder:";

export interface SidebarDragSession {
  key: string;
  kind: SidebarDragKind;
}

/**
 * The drag in progress. Never persisted and never written to the shared sidebar state, so
 * ending the drag, by drop or cancel, restores the exact folding it started with.
 */
export const useSidebarDragSession = create<{
  session: SidebarDragSession | null;
  begin: (session: SidebarDragSession) => void;
  end: () => void;
}>((set) => ({
  session: null,
  begin: (session) => set({ session }),
  end: () => set({ session: null }),
}));

function isRootLevelDrag(session: SidebarDragSession | null): session is SidebarDragSession {
  return session?.kind === "project" || session?.kind === "rootFolder";
}

function folderIdOf(key: string): string | null {
  return key.startsWith(FOLDER_PREFIX) ? key.slice(FOLDER_PREFIX.length) : null;
}

function ancestorFolderIds(state: SidebarFolderState, session: SidebarDragSession): Set<string> {
  const ids = new Set<string>();
  const ownFolder = folderIdOf(session.key);
  let current =
    ownFolder === null
      ? (state.itemFolder[session.key] ?? null)
      : (state.sidebarFolders[ownFolder]?.parentId ?? null);
  while (current !== null && !ids.has(current)) {
    ids.add(current);
    current = state.sidebarFolders[current]?.parentId ?? null;
  }
  return ids;
}

/**
 * Folding as the drag view shows it. While a project or root folder is dragged, every root
 * folder folds except those holding the dragged row, so each target is one row. A dragged
 * folder always folds, hiding the rows that move with it.
 */
export function dragViewFolderState(
  state: SidebarFolderState,
  session: SidebarDragSession | null,
): SidebarFolderState {
  if (session === null || session.kind === "workspace") return state;
  const draggedFolder = folderIdOf(session.key);
  const collapsedFolders = { ...state.collapsedFolders };
  if (draggedFolder !== null) collapsedFolders[draggedFolder] = true;
  if (isRootLevelDrag(session)) {
    const keepOpen = ancestorFolderIds(state, session);
    for (const folder of Object.values(state.sidebarFolders)) {
      if (folder.scope.kind === "root" && !keepOpen.has(folder.id)) {
        collapsedFolders[folder.id] = true;
      }
    }
  }
  return { ...state, collapsedFolders };
}

/** While a project or root folder is dragged, every project folds to its header row. */
export function dragViewCollapsedProjects(
  collapsed: ReadonlySet<string>,
  projectKeys: readonly string[],
  session: SidebarDragSession | null,
): ReadonlySet<string> {
  return isRootLevelDrag(session) ? new Set(projectKeys) : collapsed;
}
