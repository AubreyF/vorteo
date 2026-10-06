import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuItem } from "@/components/ui/menu";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";

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
  if (!supported) return null;
  return (
    <>
      <MenuItem
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
