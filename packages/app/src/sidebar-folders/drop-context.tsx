import type { PropsWithChildren } from "react";
import type { SidebarFolderScope } from "@getpaseo/protocol/sidebar-state";
import type { DraggableListExternalDrop } from "@/components/draggable-list.types";
import type { SidebarTreeRow } from "./tree";

/** Native lists drop into folders by position; only web registers folder rows as targets. */
export function SidebarFolderDropProvider({ children }: PropsWithChildren) {
  return children;
}

export function SidebarFolderDropTarget({
  children,
}: PropsWithChildren<{ folderId: string; scope: SidebarFolderScope }>) {
  return children;
}

export function useSidebarFolderDrop<T>(_input: {
  scope: SidebarFolderScope;
  enabled: boolean;
  existing?: DraggableListExternalDrop<T>;
}): DraggableListExternalDrop<SidebarTreeRow<T>> | undefined {
  return undefined;
}
