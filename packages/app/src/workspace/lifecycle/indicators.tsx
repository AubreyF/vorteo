import { View, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ShieldCheck, Repeat2 } from "lucide-react-native";
import { router } from "expo-router";
import { useVortonTouch } from "@/vorton-touch";
import { Button } from "@/components/ui/button";
import { useWorkspaceScheduled } from "./scheduled";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";

const Shield = withUnistyles(ShieldCheck);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function openSchedules(event: GestureResponderEvent) {
  event.stopPropagation();
  router.push("/schedules");
}

export function WorkspaceLifecycleIndicators({ workspace }: { workspace: SidebarWorkspaceEntry }) {
  const touch = useVortonTouch();
  const scheduled = useWorkspaceScheduled(workspace.serverId, workspace.workspaceId);
  if (!scheduled && !workspace.protected) return null;
  return (
    <View style={styles.row}>
      {scheduled ? (
        <Button
          variant="ghost"
          size="xs"
          style={touch ? styles.touchTarget : undefined}
          testID={`workspace-scheduled-${workspace.workspaceId}`}
          leftIcon={Repeat2}
          onPress={openSchedules}
        >
          Scheduled
        </Button>
      ) : null}
      {workspace.protected ? (
        <View
          accessible
          accessibilityLabel="Protected workspace"
          testID={`workspace-shield-${workspace.workspaceId}`}
        >
          <Shield size={14} uniProps={muted} />
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  touchTarget: { minHeight: 44 },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
}));
