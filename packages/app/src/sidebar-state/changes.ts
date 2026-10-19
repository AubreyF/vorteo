import type { SidebarStatePatch } from "@getpaseo/protocol/sidebar-state";

const listeners = new Set<(patch: SidebarStatePatch) => void>();

/** Only user commands enter the outbox. Hydration and remote snapshots never echo. */
export function recordSidebarChange(patch: SidebarStatePatch): void {
  for (const listener of listeners) listener(patch);
}

export function subscribeSidebarChanges(listener: (patch: SidebarStatePatch) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
