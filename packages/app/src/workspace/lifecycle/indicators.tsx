import { View, Pressable, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ShieldCheck, Repeat2 } from "lucide-react-native";
import { router } from "expo-router";
import { useVortonTouch } from "@/vorton-touch";
import { StatusBadge } from "@/components/ui/status-badge";
import { useWorkspaceScheduled } from "./scheduled";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";

const Shield = withUnistyles(ShieldCheck);
const Repeat = withUnistyles(Repeat2);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const shield = <Shield size={12} uniProps={muted} />;
const repeat = <Repeat size={12} uniProps={muted} />;

function openSchedules(event: GestureResponderEvent) {
  event.stopPropagation();
  router.push("/schedules");
}

export function WorkspaceLifecycleIndicators({ workspace }: { workspace: SidebarWorkspaceEntry }) {
  const touch = useVortonTouch();
  const scheduled = useWorkspaceScheduled(workspace.serverId, workspace.workspaceId);
  if (!scheduled && !workspace.protected) return null;
  return (
    <>
      {workspace.protected ? (
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
          accessibilityLabel="Scheduled workspace. Open schedules"
          style={[styles.badgeSlot, touch && styles.touchTarget]}
          testID={`workspace-scheduled-${workspace.workspaceId}`}
          onPress={openSchedules}
        >
          <StatusBadge label="Scheduled" leading={repeat} size="xs" shape="row" />
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
