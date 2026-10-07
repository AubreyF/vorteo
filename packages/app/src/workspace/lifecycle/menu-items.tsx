import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Anchor, ShieldCheck } from "lucide-react-native";
import { MenuHint, MenuItem, MenuSeparator } from "@/components/ui/menu";
import type { Theme } from "@/styles/theme";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";

const StandingIcon = withUnistyles(Anchor);
const ProtectedIcon = withUnistyles(ShieldCheck);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const standingLeading = <StandingIcon size={14} uniProps={muted} />;
const protectedLeading = <ProtectedIcon size={14} uniProps={muted} />;

export function WorkspaceLifecycleMenuItems({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const standing = useSessionStore(
    (state) => selectWorkspace(state, serverId, workspaceId)?.standing === true,
  );
  const protectedWorkspace = useSessionStore(
    (state) => selectWorkspace(state, serverId, workspaceId)?.protected === true,
  );
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceLifecycle === true,
  );
  const mutation = useMutation({
    mutationKey: ["workspace-lifecycle", serverId, workspaceId],
    mutationFn: async (change: { standing?: boolean; protected?: boolean }) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error("Host disconnected. Reconnect and try again.");
      await client.setWorkspaceLifecycle({ workspaceId, ...change });
    },
  });
  const { mutate } = mutation;
  const toggleStanding = useCallback(() => mutate({ standing: !standing }), [mutate, standing]);
  const toggleProtected = useCallback(
    () => mutate({ protected: !protectedWorkspace }),
    [mutate, protectedWorkspace],
  );
  const changingStanding = mutation.isPending && mutation.variables?.standing !== undefined;
  const changingProtection = mutation.isPending && mutation.variables?.protected !== undefined;
  if (!supported)
    return <MenuHint>Update this environment to use Standing and Protected.</MenuHint>;
  return (
    <>
      <MenuItem
        leading={standingLeading}
        testID={`workspace-standing-${workspaceId}`}
        selected={standing}
        closeOnSelect={false}
        disabled={mutation.isPending}
        status={changingStanding ? "pending" : "idle"}
        onSelect={toggleStanding}
      >
        Standing
      </MenuItem>
      <MenuItem
        leading={protectedLeading}
        testID={`workspace-protected-${workspaceId}`}
        selected={protectedWorkspace}
        closeOnSelect={false}
        disabled={mutation.isPending}
        status={changingProtection ? "pending" : "idle"}
        onSelect={toggleProtected}
      >
        Protected
      </MenuItem>
      {mutation.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {mutation.error.message}
        </Text>
      ) : null}
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
