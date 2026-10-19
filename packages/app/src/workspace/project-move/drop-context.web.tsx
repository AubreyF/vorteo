import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { Text, View } from "react-native";
import { Ban } from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";
import { projectMoveBlockedReason } from "./policy";
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
  onTargetChange: (id: string | null, workspace?: SidebarWorkspacePlacement) => void;
  blockedReason: string | null;
}
const Context = createContext<DropContext | null>(null);
const targetStyle = { position: "relative" } as const;
const blockedTargetStyle = { position: "relative", cursor: "not-allowed" } as const;
function targetId(projectKey: string) {
  return `move-project:${projectKey}`;
}

export function ProjectMoveProvider({
  projects,
  children,
}: PropsWithChildren<{ projects: SidebarProjectEntry[] }>) {
  const [targets, setTargets] = useState<DraggableListDropTarget[]>([]);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const onTargetChange = useCallback((id: string | null, workspace?: SidebarWorkspacePlacement) => {
    setHighlighted(id);
    setBlockedReason(
      id && workspace
        ? projectMoveBlockedReason(
            selectWorkspace(useSessionStore.getState(), workspace.serverId, workspace.workspaceId),
          )
        : null,
    );
  }, []);
  const register = useCallback((id: string, element: HTMLDivElement | null) => {
    setTargets((previous) => {
      const next = previous.filter((target) => target.id !== id);
      return element ? [...next, { id, element }] : next;
    });
  }, []);
  const onDrop = useCallback(
    (workspace: SidebarWorkspacePlacement, id: string) => {
      if (
        projectMoveBlockedReason(
          selectWorkspace(useSessionStore.getState(), workspace.serverId, workspace.workspaceId),
        )
      )
        return;
      const project = projects.find((entry) => targetId(entry.viewKey) === id);
      if (project && project.viewKey !== workspace.projectViewKey)
        moveWorkspaceToProject(workspace, project.viewKey);
    },
    [projects],
  );
  const value = useMemo(
    () => ({ targets, register, onDrop, highlighted, onTargetChange, blockedReason }),
    [targets, register, onDrop, highlighted, onTargetChange, blockedReason],
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
    <div
      ref={ref}
      style={context.highlighted === id && context.blockedReason ? blockedTargetStyle : targetStyle}
    >
      <View style={context.highlighted === id ? styles.target : undefined}>{children}</View>
      {context.highlighted === id && context.blockedReason ? (
        <View style={styles.blocked} pointerEvents="none" testID="project-drop-blocked">
          <Tooltip open enabledOnMobile>
            <TooltipTrigger>
              <View accessible accessibilityLabel={context.blockedReason}>
                <Ban size={18} color="currentColor" />
              </View>
            </TooltipTrigger>
            <TooltipContent side="right">
              <Text style={styles.explanation}>{context.blockedReason}</Text>
            </TooltipContent>
          </Tooltip>
        </View>
      ) : null}
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
  blocked: { position: "absolute", right: 12, top: 8, color: theme.colors.foregroundMuted },
  explanation: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, maxWidth: 260 },
  target: {
    backgroundColor: theme.colors.surfaceSidebarHover,
    borderRadius: theme.borderRadius.md,
  },
}));
