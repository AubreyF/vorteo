import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useReportActionError } from "@/hooks/use-action-error";
import { commitComposerQueue } from "./commit-composer";
import { messageOutbox, flushMessageOutbox } from "./runtime";
import { isLegacyImportPending, legacyImportOperationId, withLegacyQueueLane } from "./legacy";

export function LegacyQueueImport({
  serverId,
  agentId,
  cwd,
}: {
  serverId: string;
  agentId: string;
  cwd: string;
}) {
  const messages = useSessionStore((state) =>
    state.sessions[serverId]?.queuedMessages.get(agentId),
  );
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.durableMessageQueue === true,
  );
  const connected = useHostRuntimeIsConnected(serverId);
  const [pending, setPending] = useState(false);
  const reportError = useReportActionError();
  const importMessages = useCallback(async () => {
    setPending(true);
    try {
      for (const message of messages ?? []) {
        await withLegacyQueueLane(serverId, agentId, async () => {
          const current =
            useSessionStore.getState().sessions[serverId]?.queuedMessages.get(agentId) ?? [];
          if (!current.some((entry) => entry.id === message.id)) return;
          if (isLegacyImportPending(await messageOutbox.list(), serverId, agentId, message.id))
            return;
          // The legacy row remains until the host acknowledges its stable import ID.
          await commitComposerQueue({
            serverId,
            agentId,
            cwd,
            text: message.text,
            attachments: message.attachments,
            identity: { messageId: message.id, operationId: legacyImportOperationId(message.id) },
          });
        });
      }
      await flushMessageOutbox(serverId);
    } catch (failure) {
      reportError(failure);
    } finally {
      setPending(false);
    }
  }, [serverId, agentId, cwd, messages, reportError]);
  if (!messages?.length) return null;
  return (
    <View style={styles.container} testID="legacy-message-queue-import">
      <Text style={styles.text}>
        {messages.length} local queued message(s) are waiting for import. Keep this device open
        until they are saved.
      </Text>
      {!supported ? (
        <Text style={styles.text}>
          Update the host to import these messages into the shared queue.
        </Text>
      ) : null}
      <Button
        size="sm"
        style={styles.touch}
        loading={pending}
        disabled={!supported || !connected || pending}
        onPress={importMessages}
      >
        Import local messages
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2], padding: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  touch: { minHeight: 44, minWidth: 44 },
}));
