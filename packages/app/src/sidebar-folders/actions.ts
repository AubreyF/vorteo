import { useCallback } from "react";
import { create } from "zustand";
import { isSameSidebarFolderScope } from "@getpaseo/protocol/sidebar-folders";
import type { SidebarFolderScope } from "@getpaseo/protocol/sidebar-state";
import { commitSidebarPatch } from "@/sidebar-state/local";
import { useSidebarSyncStatus } from "@/sidebar-state/use-sidebar-sync";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarFolderStore } from "./store";
import {
  createSidebarFolderPatch,
  moveSidebarEntryPatch,
  reorderSidebarRowsPatch,
  type SidebarTreeRow,
} from "./tree";

export function useSidebarFoldersSupported(): boolean {
  return useSidebarSyncStatus((state) => state.foldersSupported);
}

/** The scope's full flat order, which every folder move rewrites for older clients. */
function scopeKeys(scope: SidebarFolderScope): string[] {
  const order = useSidebarOrderStore.getState();
  if (scope.kind === "root") return order.projectOrder;
  return order.workspaceOrderByProject[scope.projectKey] ?? [];
}

function createFolderId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createSidebarFolder(input: {
  scope: SidebarFolderScope;
  parentId: string | null;
  name: string;
}): void {
  commitSidebarPatch(
    createSidebarFolderPatch({
      state: useSidebarFolderStore.getState(),
      scope: input.scope,
      parentId: input.parentId,
      folder: {
        id: createFolderId(),
        name: input.name.trim(),
        createdAt: new Date().toISOString(),
      },
      keys: scopeKeys(input.scope),
    }),
  );
}

export function renameSidebarFolder(folderId: string, name: string): void {
  const folder = useSidebarFolderStore.getState().sidebarFolders[folderId];
  if (!folder) return;
  commitSidebarPatch({ sidebarFolders: { [folderId]: { ...folder, name: name.trim() } } });
}

/** Contents move up to the parent folder; nothing is archived or touched on disk. */
export function removeSidebarFolder(folderId: string): void {
  commitSidebarPatch({ sidebarFolders: { [folderId]: null } });
}

export function toggleSidebarFolderCollapsed(folderId: string): void {
  const collapsed = useSidebarFolderStore.getState().collapsedFolders[folderId] === true;
  commitSidebarPatch({ collapsedFolders: { [folderId]: !collapsed } });
}

export function moveSidebarEntry(input: {
  scope: SidebarFolderScope;
  entry: string;
  targetFolderId: string | null;
}): void {
  const patch = moveSidebarEntryPatch({
    state: useSidebarFolderStore.getState(),
    scope: input.scope,
    entry: input.entry,
    targetFolderId: input.targetFolderId,
    before: null,
    keys: scopeKeys(input.scope),
  });
  if (patch) commitSidebarPatch(patch);
}

/** Places an entry where a sidebar drop resolved it, keeping siblings a filter hides in order. */
export function placeSidebarEntry(input: {
  scope: SidebarFolderScope;
  entry: string;
  targetFolderId: string | null;
  before: string | null;
  after: string | null;
  keys: readonly string[];
}): void {
  const patch = moveSidebarEntryPatch({
    state: useSidebarFolderStore.getState(),
    scope: input.scope,
    entry: input.entry,
    targetFolderId: input.targetFolderId,
    before: input.before,
    after: input.after,
    keys: [...new Set([...scopeKeys(input.scope), ...input.keys])],
  });
  if (patch) commitSidebarPatch(patch);
}

export function reorderSidebarRows<T>(input: {
  scope: SidebarFolderScope;
  rows: readonly SidebarTreeRow<T>[];
  movedKey: string;
}): void {
  const patch = reorderSidebarRowsPatch({
    state: useSidebarFolderStore.getState(),
    scope: input.scope,
    rows: input.rows,
    movedKey: input.movedKey,
    keys: scopeKeys(input.scope),
  });
  if (patch) commitSidebarPatch(patch);
}

export type SidebarFolderDialogRequest =
  | { kind: "create"; scope: SidebarFolderScope; parentId: string | null }
  | { kind: "rename"; folderId: string }
  | { kind: "move"; scope: SidebarFolderScope; entry: string; title: string };

export const useSidebarFolderDialog = create<{
  request: SidebarFolderDialogRequest | null;
  open: (request: SidebarFolderDialogRequest) => void;
  close: () => void;
}>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/** Opens New folder for a scope, or returns null when the sidebar host cannot store folders. */
export function useCreateSidebarFolderAction(
  scope: SidebarFolderScope,
  parentId: string | null,
): (() => void) | null {
  const supported = useSidebarFoldersSupported();
  const open = useCallback(
    () => useSidebarFolderDialog.getState().open({ kind: "create", scope, parentId }),
    [scope, parentId],
  );
  return supported ? open : null;
}

/** Opens Move to folder, or returns null when the scope has no folder to move into. */
export function useMoveToSidebarFolderAction(input: {
  scope: SidebarFolderScope;
  entry: string;
  title: string;
}): (() => void) | null {
  const { scope, entry, title } = input;
  const supported = useSidebarFoldersSupported();
  const hasFolders = useSidebarFolderStore((state) =>
    Object.values(state.sidebarFolders).some((folder) =>
      isSameSidebarFolderScope(folder.scope, scope),
    ),
  );
  const open = useCallback(
    () => useSidebarFolderDialog.getState().open({ kind: "move", scope, entry, title }),
    [scope, entry, title],
  );
  return supported && hasFolders ? open : null;
}
