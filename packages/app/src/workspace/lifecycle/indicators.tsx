import { useCallback } from "react";
import { View, Pressable, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Factory, LockKeyhole, Repeat2 } from "lucide-react-native";
import { router } from "expo-router";
import { useVortonTouch } from "@/vorton-touch";
import { StatusBadge } from "@/components/ui/status-badge";
import { useWorkspaceScheduleState } from "./scheduled";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";
import { FACTORY_MANAGED_EXPLANATION, useFactoryMembership } from "./factory-membership";
import { hasFactoryTag } from "./factory-tag";

const Shield = withUnistyles(LockKeyhole);
const Repeat = withUnistyles(Repeat2);
const FactoryIcon = withUnistyles(Factory);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const shield = <Shield size={12} uniProps={muted} />;
const repeat = <Repeat size={12} uniProps={muted} />;
function FactoryIndicator({ managed, workspaceId }: { managed: boolean; workspaceId: string }) {
  return (
    <View
      style={styles.badgeSlot}
      accessible
      accessibilityLabel={managed ? FACTORY_MANAGED_EXPLANATION : "Factory workspace"}
      testID={`workspace-factory-${workspaceId}`}
    >
      <FactoryIcon size={14} uniProps={muted} />
    </View>
  );
}

export function WorkspaceLifecycleIndicators({ workspace }: { workspace: SidebarWorkspaceEntry }) {
  const touch = useVortonTouch();
  const scheduled = useWorkspaceScheduleState(workspace.serverId, workspace.workspaceId);
  const membership = useFactoryMembership(workspace.serverId, workspace.workspaceId);
  const factory = Boolean(membership) || hasFactoryTag(workspace.labels);
  const label = scheduled === "paused" ? "Paused" : "Scheduled";
  const openSchedules = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      router.push({
        pathname: "/schedules",
        params: {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
        },
      });
    },
    [workspace.serverId, workspace.workspaceId],
  );
  if (!scheduled && !workspace.protected && !factory) return null;
  return (
    <>
      {factory ? (
        <FactoryIndicator managed={Boolean(membership)} workspaceId={workspace.workspaceId} />
      ) : null}
      {workspace.protected && !factory ? (
        <View
          style={styles.badgeSlot}
          accessible
          accessibilityLabel="Protected workspace"
          testID={`workspace-shield-${workspace.workspaceId}`}
        >
          <StatusBadge label="Protected" leading={shield} size="xs" shape="row" />
        </View>
      ) : null}
      {scheduled ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label} workspace. Open schedules`}
          style={[styles.badgeSlot, touch && styles.touchTarget]}
          testID={`workspace-scheduled-${workspace.workspaceId}`}
          onPress={openSchedules}
        >
          <StatusBadge label={label} leading={repeat} size="xs" shape="row" />
        </Pressable>
      ) : null}
    </>
  );
}
const styles = StyleSheet.create({
  badgeSlot: { minWidth: 0, flexShrink: 1 },
  // Keep the visual badge compact inside a full-height touch target.
  touchTarget: { minHeight: 44, justifyContent: "center" },
});
