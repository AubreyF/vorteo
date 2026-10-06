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
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import type {
  DraggableListDropTarget,
  DraggableListExternalDrop,
} from "@/components/draggable-list.types";
import { moveWorkspaceToProject } from "./request";

interface DropContext {
  targets: DraggableListDropTarget[];
  register: (id: string, element: HTMLDivElement | null) => void;
  onDrop: (workspace: SidebarWorkspacePlacement, id: string) => void;
  highlighted: string | null;
  onTargetChange: (id: string | null) => void;
}
const Context = createContext<DropContext | null>(null);
function targetId(projectKey: string) {
  return `move-project:${projectKey}`;
}

export function ProjectMoveProvider({
  projects,
  children,
}: PropsWithChildren<{ projects: SidebarProjectEntry[] }>) {
  const [targets, setTargets] = useState<DraggableListDropTarget[]>([]);
  const [highlighted, onTargetChange] = useState<string | null>(null);
  const register = useCallback((id: string, element: HTMLDivElement | null) => {
    setTargets((previous) => {
      const next = previous.filter((target) => target.id !== id);
      return element ? [...next, { id, element }] : next;
    });
  }, []);
  const onDrop = useCallback(
    (workspace: SidebarWorkspacePlacement, id: string) => {
      const project = projects.find((entry) => targetId(entry.viewKey) === id);
      if (project && project.viewKey !== workspace.projectViewKey)
        moveWorkspaceToProject(workspace, project.viewKey);
    },
    [projects],
  );
  const value = useMemo(
    () => ({ targets, register, onDrop, highlighted, onTargetChange }),
    [targets, register, onDrop, highlighted],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function ProjectDropTarget({
  projectKey,
  children,
}: PropsWithChildren<{ projectKey: string }>) {
  const context = useContext(Context);
  const register = context?.register;
  const id = targetId(projectKey);
  const ref = useCallback(
    (element: HTMLDivElement | null) => register?.(id, element),
    [register, id],
  );
  if (!context) return children;
  return (
    <div ref={ref}>
      <View style={context.highlighted === id ? styles.target : undefined}>{children}</View>
    </div>
  );
}

export function useWorkspaceProjectDrop(
  projectKey?: string,
): DraggableListExternalDrop<SidebarWorkspacePlacement> | undefined {
  const context = useContext(Context);
  return useMemo(() => {
    if (!context) return undefined;
    return {
      targets: context.targets.filter((target) => target.id !== targetId(projectKey ?? "")),
      onDrop: context.onDrop,
      onTargetChange: context.onTargetChange,
    };
  }, [context, projectKey]);
}
const styles = StyleSheet.create((theme) => ({
  target: {
    backgroundColor: theme.colors.surfaceSidebarHover,
    borderRadius: theme.borderRadius.md,
  },
}));
