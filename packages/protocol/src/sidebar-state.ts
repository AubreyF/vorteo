import { z } from "zod";
import { normalizeSidebarFolders, validateSidebarFolderPatch } from "./sidebar-folders.js";

const KeysSchema = z.array(z.string().min(1).max(8192)).max(10000);
const FlagsSchema = z.record(z.string(), z.boolean());
const FolderIdSchema = z.string().min(1).max(200);
const ItemKeySchema = z.string().min(1).max(8192);

export const SidebarFolderScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }),
  z.object({ kind: z.literal("project"), projectKey: ItemKeySchema }),
]);
export type SidebarFolderScope = z.infer<typeof SidebarFolderScopeSchema>;

/** Folders only organize the sidebar. They never correspond to anything on disk. */
export const SidebarFolderSchema = z.object({
  id: FolderIdSchema,
  name: z.string().min(1).max(200),
  parentId: FolderIdSchema.nullable(),
  scope: SidebarFolderScopeSchema,
  createdAt: z.string(),
});
export type SidebarFolder = z.infer<typeof SidebarFolderSchema>;

export const SidebarStateSchema = z.object({
  projectOrder: KeysSchema,
  pinnedWorkspaceOrder: KeysSchema,
  workspaceOrderByProject: z.record(z.string(), KeysSchema),
  collapsedProjects: FlagsSchema,
  collapsedWorkspaceGroups: FlagsSchema,
  collapsedPinned: z.boolean(),
  groupMode: z.enum(["project", "status"]),
  hostFilters: KeysSchema,
  projectFilters: KeysSchema,
  labelFilters: z.array(z.string()),
  // Folder fields are absent until a client that sees `features.sidebarFolders` writes them.
  sidebarFolders: z.record(FolderIdSchema, SidebarFolderSchema).optional(),
  /** Project view keys map to root folders; `serverId:workspaceId` keys to project folders. */
  itemFolder: z.record(ItemKeySchema, FolderIdSchema).optional(),
  /** Keys are `root`, `folder:<id>` or `project:<viewKey>`; entries are item keys or `folder:<id>`. */
  childOrder: z.record(z.string(), KeysSchema).optional(),
  collapsedFolders: z.record(FolderIdSchema, z.boolean()).optional(),
});
export type SidebarState = z.infer<typeof SidebarStateSchema>;
/** In folder records a `null` value removes that key; other records merge by key. */
export const SidebarStatePatchSchema = SidebarStateSchema.partial().extend({
  sidebarFolders: z.record(FolderIdSchema, SidebarFolderSchema.nullable()).optional(),
  itemFolder: z.record(ItemKeySchema, FolderIdSchema.nullable()).optional(),
  childOrder: z.record(z.string(), KeysSchema.nullable()).optional(),
  collapsedFolders: z.record(FolderIdSchema, z.boolean().nullable()).optional(),
});
export type SidebarStatePatch = z.infer<typeof SidebarStatePatchSchema>;
export const SidebarStateChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("initialize"), state: SidebarStatePatchSchema }),
  z.object({ type: z.literal("patch"), patch: SidebarStatePatchSchema }),
]);
export type SidebarStateChange = z.infer<typeof SidebarStateChangeSchema>;
export const SidebarStateSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  state: SidebarStateSchema.nullable(),
});
export type SidebarStateSnapshot = z.infer<typeof SidebarStateSnapshotSchema>;

export function emptySidebarState(): SidebarState {
  return {
    projectOrder: [],
    pinnedWorkspaceOrder: [],
    workspaceOrderByProject: {},
    collapsedProjects: {},
    collapsedWorkspaceGroups: {},
    collapsedPinned: false,
    groupMode: "project",
    hostFilters: [],
    projectFilters: [],
    labelFilters: [],
  };
}

/** Patches address individual projects so unrelated device edits survive. */
export function mergeSidebarStatePatch(
  left: SidebarStatePatch,
  right: SidebarStatePatch,
): SidebarStatePatch {
  const result = { ...left, ...right };
  if (right.workspaceOrderByProject)
    result.workspaceOrderByProject = {
      ...left.workspaceOrderByProject,
      ...right.workspaceOrderByProject,
    };
  if (right.collapsedProjects)
    result.collapsedProjects = { ...left.collapsedProjects, ...right.collapsedProjects };
  if (right.collapsedWorkspaceGroups)
    result.collapsedWorkspaceGroups = {
      ...left.collapsedWorkspaceGroups,
      ...right.collapsedWorkspaceGroups,
    };
  if (right.sidebarFolders)
    result.sidebarFolders = { ...left.sidebarFolders, ...right.sidebarFolders };
  if (right.itemFolder) result.itemFolder = { ...left.itemFolder, ...right.itemFolder };
  if (right.childOrder) result.childOrder = { ...left.childOrder, ...right.childOrder };
  if (right.collapsedFolders)
    result.collapsedFolders = { ...left.collapsedFolders, ...right.collapsedFolders };
  return result;
}

function withoutRemovedKeys<T>(
  record: Record<string, T | null> | undefined,
): Record<string, T> | undefined {
  if (!record) return undefined;
  const kept: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) if (value !== null) kept[key] = value;
  return kept;
}

/**
 * Applies a patch and then repairs the folder tree, so every device and the Host reach the same
 * structure even when concurrent edits conflict. Removing a folder moves its contents to its parent.
 */
export function applySidebarStatePatch(
  state: SidebarState,
  patch: SidebarStatePatch,
): SidebarState {
  validateSidebarFolderPatch(patch);
  const merged = mergeSidebarStatePatch(state, patch);
  const next = SidebarStateSchema.parse({
    ...merged,
    sidebarFolders: withoutRemovedKeys(merged.sidebarFolders),
    itemFolder: withoutRemovedKeys(merged.itemFolder),
    childOrder: withoutRemovedKeys(merged.childOrder),
    collapsedFolders: withoutRemovedKeys(merged.collapsedFolders),
  });
  return normalizeSidebarFolders({ previous: state, patch, next });
}
