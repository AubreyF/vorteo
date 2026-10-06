import { Buffer } from "buffer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { QueueAttachment, QueuePresentation } from "@getpaseo/protocol/message-queue";
import { AttachmentLightbox } from "@/components/attachment-lightbox";
import { Button } from "@/components/ui/button";
import { useHosts } from "@/runtime/host-runtime";
import { useDownloadStore } from "@/stores/download-store";

import { presentQueueContext, type QueueContext } from "./context-presentation";
import { requireQueueClient } from "./runtime";

export function SharedQueueAttachments({
  serverId,
  agentId,
  messageId,
  presentation,
}: {
  serverId?: string;
  agentId?: string;
  messageId?: string;
  presentation?: QueuePresentation;
}) {
  if (
    !serverId ||
    !agentId ||
    !messageId ||
    !presentation ||
    (!presentation.attachments.length && !presentation.context?.length)
  )
    return null;
  return (
    <View style={styles.list}>
      {presentation.context?.map((context, index) => (
        // Context is an ordered captured snapshot without individual IDs.
        // eslint-disable-next-line react/no-array-index-key
        <SharedContext key={index} context={context} />
      ))}
      {presentation.attachments.map((attachment) => (
        <SharedAttachment
          key={attachment.id}
          serverId={serverId}
          agentId={agentId}
          messageId={messageId}
          attachment={attachment}
        />
      ))}
    </View>
  );
}

function SharedContext({ context }: { context: QueueContext }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const content = useMemo(() => presentQueueContext(context), [context]);
  return (
    <View>
      <Button variant="ghost" size="sm" style={styles.touch} onPress={toggle}>
        {expanded ? "Hide" : "View"} {content.title}
      </Button>
      {expanded ? (
        <ScrollView style={styles.context}>
          <Text selectable style={styles.text}>
            {content.text}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function SharedAttachment({
  serverId,
  agentId,
  messageId,
  attachment,
}: {
  serverId: string;
  agentId: string;
  messageId: string;
  attachment: QueueAttachment;
}) {
  const hosts = useHosts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const source = useMemo(() => (uri ? { type: "uri" as const, uri } : null), [uri]);
  const close = useCallback(() => setUri(null), []);
  const open = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const client = requireQueueClient(serverId);
      const result = await client.getMessageQueueAttachment({
        agentId,
        messageId,
        attachmentId: attachment.id,
      });
      if (result.error || !result.file)
        throw new Error(result.error?.message ?? "Attachment is unavailable.");
      const file = result.file;
      if (
        file.attachment.kind === "image" &&
        /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(file.attachment.mimeType)
      ) {
        const { bytes } = await client.readFile(
          file.cwd,
          file.path,
          undefined,
          file.attachment.size + 1,
        );
        if (bytes.length !== file.attachment.size) throw new Error("Attachment size changed.");
        if (mounted.current)
          setUri(
            `data:${file.attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
          );
      } else {
        await useDownloadStore.getState().startDownload({
          serverId,
          scopeId: `queue:${agentId}`,
          fileName: file.attachment.fileName,
          path: file.path,
          daemonProfile: hosts.find((host) => host.serverId === serverId),
          requestFileDownloadToken: async () => {
            const download = await client.getMessageQueueAttachment({
              agentId,
              messageId,
              attachmentId: attachment.id,
              download: true,
            });
            return {
              token: download.file?.downloadToken ?? null,
              fileName: download.file?.attachment.fileName ?? null,
              mimeType: download.file?.attachment.mimeType ?? null,
              error: download.error?.message ?? null,
            };
          },
        });
      }
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : "Could not open attachment.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [serverId, agentId, messageId, attachment.id, hosts]);
  const press = useCallback(() => {
    void open();
  }, [open]);
  return (
    <View>
      <Button variant="ghost" size="sm" style={styles.touch} onPress={press} disabled={busy}>
        {busy ? "Loading..." : attachment.fileName}
      </Button>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <AttachmentLightbox source={source} onClose={close} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  context: { maxHeight: 180 },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  list: { gap: theme.spacing[1] },
  touch: { minHeight: 44, minWidth: 44, alignSelf: "flex-start" },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
