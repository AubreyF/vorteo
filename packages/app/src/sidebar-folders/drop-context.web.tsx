import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SidebarFolderScope } from "@getpaseo/protocol/sidebar-state";
import { sidebarFolderContainerKey } from "@getpaseo/protocol/sidebar-folders";
import type {
  DraggableListDropTarget,
  DraggableListExternalDrop,
} from "@/components/draggable-list.types";
import { moveSidebarEntry } from "./actions";
import type { SidebarTreeRow } from "./tree";

const TARGET_PREFIX = "sidebar-folder:";

interface FolderTarget extends DraggableListDropTarget {
  scopeKey: string;
}

interface FolderDropContext {
  targets: FolderTarget[];
  register: (target: Omit<FolderTarget, "element">, element: HTMLDivElement | null) => void;
  highlighted: string | null;
  setHighlighted: (id: string | null) => void;
}

const Context = createContext<FolderDropContext | null>(null);
const targetStyle = { position: "relative" } as const;

function scopeKeyOf(scope: SidebarFolderScope): string {
  return sidebarFolderContainerKey(scope, null);
}

/** Web and Electron register folder rows as drop targets for the sortable lists around them. */
export function SidebarFolderDropProvider({ children }: PropsWithChildren) {
  const [targets, setTargets] = useState<FolderTarget[]>([]);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const register = useCallback(
    (target: Omit<FolderTarget, "element">, element: HTMLDivElement | null) => {
      setTargets((previous) => {
        const next = previous.filter((entry) => entry.id !== target.id);
        return element ? [...next, { ...target, element }] : next;
      });
    },
    [],
  );
  const value = useMemo(
    () => ({ targets, register, highlighted, setHighlighted }),
    [targets, register, highlighted],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function SidebarFolderDropTarget({
  folderId,
  scope,
  children,
}: PropsWithChildren<{ folderId: string; scope: SidebarFolderScope }>) {
  const context = useContext(Context);
  const register = context?.register;
  const id = `${TARGET_PREFIX}${folderId}`;
  const scopeKey = scopeKeyOf(scope);
  const ref = useCallback(
    (element: HTMLDivElement | null) => register?.({ id, scopeKey }, element),
    [register, id, scopeKey],
  );
  if (!context) return children;
  return (
    <div ref={ref} style={targetStyle}>
      <View style={context.highlighted === id ? styles.target : undefined}>{children}</View>
    </div>
  );
}

/**
 * Drop targets for one scope's sortable list: its folder rows, plus any existing targets such as
 * other projects for workspace moves. Dropping on a folder row moves the row into that folder.
 */
export function useSidebarFolderDrop<T>(input: {
  scope: SidebarFolderScope;
  enabled: boolean;
  existing?: DraggableListExternalDrop<T>;
}): DraggableListExternalDrop<SidebarTreeRow<T>> | undefined {
  const { scope, enabled, existing } = input;
  const context = useContext(Context);
  const scopeKey = scopeKeyOf(scope);
  return useMemo(() => {
    const folderTargets =
      context && enabled ? context.targets.filter((target) => target.scopeKey === scopeKey) : [];
    if (!existing && folderTargets.length === 0) return undefined;
    return {
      targets: [...(existing?.targets ?? []), ...folderTargets],
      onDrop: (row, targetId) => {
        if (targetId.startsWith(TARGET_PREFIX)) {
          const targetFolderId = targetId.slice(TARGET_PREFIX.length);
          moveSidebarEntry({ scope, entry: row.key, targetFolderId });
          return;
        }
        if (row.kind === "item") existing?.onDrop(row.item, targetId);
      },
      onTargetChange: (targetId, row) => {
        const isFolder = targetId?.startsWith(TARGET_PREFIX) === true;
        context?.setHighlighted(isFolder ? targetId : null);
        const item = row?.kind === "item" ? row.item : undefined;
        existing?.onTargetChange(isFolder ? null : targetId, item);
      },
    };
  }, [context, enabled, existing, scope, scopeKey]);
}

const styles = StyleSheet.create((theme) => ({
  target: {
    backgroundColor: theme.colors.surfaceSidebarHover,
    borderRadius: theme.borderRadius.md,
  },
}));
