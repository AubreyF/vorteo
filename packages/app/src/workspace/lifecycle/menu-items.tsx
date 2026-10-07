import { useCallback } from "react";
import { router } from "expo-router";
import { useWorkspaceScheduleState } from "./scheduled";
import { useMutation } from "@tanstack/react-query";
import { Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Repeat2, LockKeyhole } from "lucide-react-native";
import { MenuHint, MenuItem, MenuSeparator } from "@/components/ui/menu";
import type { Theme } from "@/styles/theme";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";

const ScheduleIcon = withUnistyles(Repeat2);
const ProtectedIcon = withUnistyles(LockKeyhole);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const scheduleLeading = <ScheduleIcon size={14} uniProps={muted} />;
const protectedLeading = <ProtectedIcon size={14} uniProps={muted} />;

export function WorkspaceLifecycleMenuItems({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const scheduleState = useWorkspaceScheduleState(serverId, workspaceId);
  const scheduleLabel = scheduleState === "paused" ? "Paused" : "Scheduled";
  const scheduleAction = scheduleState ? "Manage schedules…" : "Add schedule…";
  const openSchedules = useCallback(() => {
    router.push({ pathname: "/schedules", params: { serverId, workspaceId } });
  }, [serverId, workspaceId]);
  const protectedWorkspace = useSessionStore(
    (state) => selectWorkspace(state, serverId, workspaceId)?.protected === true,
  );
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceLifecycle === true,
  );
  const mutation = useMutation({
    mutationKey: ["workspace-lifecycle", serverId, workspaceId],
    mutationFn: async (change: { protected: boolean }) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error("Host disconnected. Reconnect and try again.");
      await client.setWorkspaceLifecycle({ workspaceId, ...change });
    },
  });
  const { mutate } = mutation;
  const toggleProtected = useCallback(
    () => mutate({ protected: !protectedWorkspace }),
    [mutate, protectedWorkspace],
  );
  const changingProtection = mutation.isPending && mutation.variables?.protected !== undefined;
  return (
    <>
      <MenuHint>Standing</MenuHint>
      {scheduleState ? <MenuHint>{scheduleLabel}</MenuHint> : null}
      <MenuItem
        leading={scheduleLeading}
        testID={`workspace-schedules-${workspaceId}`}
        onSelect={openSchedules}
      >
        {scheduleAction}
      </MenuItem>
      <MenuItem
        leading={protectedLeading}
        testID={`workspace-protected-${workspaceId}`}
        selected={protectedWorkspace}
        closeOnSelect={false}
        disabled={!supported || mutation.isPending}
        status={changingProtection ? "pending" : "idle"}
        onSelect={toggleProtected}
      >
        Protected
      </MenuItem>
      <MenuHint>Protected workspaces cannot be archived.</MenuHint>
      {mutation.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {mutation.error.message}
        </Text>
      ) : null}
      {!supported ? <MenuHint>Update this environment to use Protected.</MenuHint> : null}
      <MenuSeparator />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
}));
