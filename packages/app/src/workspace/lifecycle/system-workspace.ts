import type { WorkspaceDescriptor } from "@/stores/session-store";

export const SYSTEM_MANAGED_EXPLANATION = "Managed by Vorteo System";
export const SYSTEM_PROJECT_TITLE = "Vorteo System";

type SystemFields = Pick<WorkspaceDescriptor, "projectSystem" | "systemMembership">;

/** Membership markers count only on a host that advertises the System project. */
export function systemWorkspaceKind(
  workspace: SystemFields | null | undefined,
  supported: boolean,
): "managed" | "operator" | null {
  if (!supported || !workspace?.projectSystem) return null;
  return workspace.systemMembership ? "managed" : "operator";
}

export function isSystemManagedWorkspace(
  workspace: SystemFields | null | undefined,
  supported: boolean,
): boolean {
  return systemWorkspaceKind(workspace, supported) === "managed";
}
