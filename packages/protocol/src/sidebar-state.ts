import { z } from "zod";

const KeysSchema = z.array(z.string().min(1).max(8192)).max(10000);
const FlagsSchema = z.record(z.string(), z.boolean());

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
});
export type SidebarState = z.infer<typeof SidebarStateSchema>;
export const SidebarStatePatchSchema = SidebarStateSchema.partial();
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
  return result;
}

export function applySidebarStatePatch(
  state: SidebarState,
  patch: SidebarStatePatch,
): SidebarState {
  return SidebarStateSchema.parse(mergeSidebarStatePatch(state, patch));
}
