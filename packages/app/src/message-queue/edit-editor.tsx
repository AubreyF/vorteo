import { ActionFooter } from "@/components/ui/action-footer";
import { useCallback, useRef, useState, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ImagePlus, X } from "lucide-react-native";
import type { QueueItem, QueueAttachment } from "@getpaseo/protocol/message-queue";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";
import { useImageAttachmentPicker } from "@/hooks/use-image-attachment-picker";
import { normalizeNativePastedImages } from "@/composer/native-pasted-image";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { AttachmentLightbox } from "@/components/attachment-lightbox";
import { useVortonTouch } from "@/vorton-touch";
import type { AttachmentMetadata } from "@/attachments/types";
import type { NativePastedFile } from "@/composer/native-pasted-image";
import { queueAttachmentStore } from "./attachment-store";
import { SharedQueueAttachments } from "./shared-attachments";
import { useQueueEditDrafts } from "./edit-draft-context";
import { type QueueEditDraft, draftHasChanges, draftHasContent } from "./edit-draft";
import { queueEditDraftSession, queueEditDraftStorage } from "./edit-draft-runtime";
import { QueueEditMediaInput } from "./edit-media-input";

export function QueueEditEditor({
  draft,
  current,
}: {
  draft: QueueEditDraft;
  current: QueueItem | undefined;
}) {
  const touch = useVortonTouch();
  const size = touch ? "md" : "sm";
  const { refresh } = useQueueEditDrafts();
  const [working, setWorking] = useState(draft);
  const latest = useRef(draft);
  const writes = useRef(Promise.resolve());
  const pendingWrites = useRef(0);
  const [persisting, setPersisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const active = useRef(true);
  const { pickImages } = useImageAttachmentPicker(setError);
  const report = useCallback(
    (failure: unknown) =>
      setError(failure instanceof Error ? failure.message : "The queue edit could not be saved."),
    [],
  );
  const update = useCallback(
    (changes: Partial<Pick<QueueEditDraft, "text" | "attachments" | "localAttachments">>) => {
      setWorking((value) => ({ ...value, ...changes }));
      pendingWrites.current += 1;
      setPersisting(true);
      writes.current = writes.current.then(async () => {
        latest.current = await queueEditDraftSession.update(latest.current, {
          ...latest.current,
          ...changes,
        });
        return;
      });
      void writes.current.catch(report).finally(() => {
        pendingWrites.current -= 1;
        if (!pendingWrites.current) setPersisting(false);
      });
    },
    [report],
  );
  const add = useCallback(
    (images: PickedImageAttachmentInput[]) => {
      if (!active.current || saving || processing || !images.length) return;
      setProcessing(true);
      void (async () => {
        const added: QueueEditDraft["localAttachments"] = [];
        try {
          for (const image of images)
            added.push({ kind: "image", metadata: await queueAttachmentStore.save(image) });
          await writes.current;
          if (!active.current) {
            await Promise.all(
              added.map(({ metadata }) => queueAttachmentStore.delete({ attachment: metadata })),
            );
            return;
          }
          const next = await queueEditDraftSession.update(latest.current, {
            ...latest.current,
            localAttachments: [...latest.current.localAttachments, ...added],
          });
          latest.current = next;
          setWorking(next);
        } catch (failure) {
          await Promise.allSettled(
            added.map(({ metadata }) => queueAttachmentStore.delete({ attachment: metadata })),
          );
          report(failure);
        } finally {
          setProcessing(false);
        }
      })();
    },
    [processing, saving, report],
  );
  const choose = useCallback(() => {
    void pickImages()
      .then((images) => {
        if (images) add(images);
        return;
      })
      .catch(report);
  }, [pickImages, add, report]);
  const cancel = useCallback(() => {
    active.current = false;
    setSaving(true);
    void writes.current
      .catch(() => undefined)
      .then(() => queueEditDraftSession.discard(latest.current))
      .then(refresh)
      .catch((failure) => {
        active.current = true;
        report(failure);
      })
      .finally(() => setSaving(false));
  }, [refresh, report]);
  const save = useCallback(() => {
    setSaving(true);
    void writes.current
      .then(() => queueEditDraftSession.save(latest.current))
      .then(refresh)
      .catch(async (failure) => {
        const persisted = (await queueEditDraftStorage.list()).find(
          (entry) => entry.id === draft.id,
        );
        if (persisted) latest.current = persisted;
        report(failure);
        await refresh();
      })
      .finally(() => setSaving(false));
  }, [refresh, report, draft.id]);
  const retryDraft = useCallback(() => {
    writes.current = writes.current
      .catch(() => undefined)
      .then(async () => {
        latest.current = await queueEditDraftSession.update(latest.current, working);
        setError(null);
        return;
      });
    void writes.current.catch(report);
  }, [working, report]);
  const changeText = useCallback((text: string) => update({ text }), [update]);
  const pasteImages = useCallback(
    (files: readonly NativePastedFile[]) => {
      try {
        add(normalizeNativePastedImages(files));
      } catch (failure) {
        report(failure);
      }
    },
    [add, report],
  );
  const contextPresentation = useMemo(
    () => ({ ...draft.original, attachments: [] }),
    [draft.original],
  );
  const source = useMemo(
    () => (preview ? { type: "uri" as const, uri: preview } : null),
    [preview],
  );
  const closePreview = useCallback(() => setPreview(null), []);
  const removeRemote = useCallback(
    (id: string) => update({ attachments: working.attachments.filter((file) => file.id !== id) }),
    [working.attachments, update],
  );
  const removeLocal = useCallback(
    (metadata: AttachmentMetadata) => {
      update({
        localAttachments: working.localAttachments.filter(
          (file) => file.metadata.id !== metadata.id,
        ),
      });
      void writes.current
        .then(() => queueAttachmentStore.delete({ attachment: metadata }))
        .catch(report);
    },
    [working.localAttachments, update, report],
  );
  const openLocal = useCallback(
    (metadata: AttachmentMetadata) => {
      void queueAttachmentStore
        .encodeBase64({ attachment: metadata })
        .then((base64) => setPreview(`data:${metadata.mimeType};base64,${base64}`))
        .catch(report);
    },
    [report],
  );
  const changedElsewhere = current && current.revision !== draft.original.revision;
  const unavailable = !current || current.delivery.status !== "queued";
  const disabled = saving || processing || !!error || !!draft.submissionId;
  return (
    <QueueEditMediaInput add={add} disabled={disabled} onError={setError}>
      <View style={styles.editor} testID={`queue-edit-draft-${draft.id}`}>
        {unavailable ? (
          <Text style={styles.muted}>
            This message is no longer editable in the queue. Your draft is still saved on this
            device.
          </Text>
        ) : null}
        {changedElsewhere ? (
          <Text style={styles.muted}>
            The message changed on another device. Saving this original revision will preserve your
            edit as a conflict for review.
          </Text>
        ) : null}
        {draft.submissionId ? (
          <Text style={styles.muted}>
            This edit may already be saved. Check its queue synchronization status before discarding
            this local draft.
          </Text>
        ) : null}
        <EditingTextInput
          initialValue={working.text}
          onChangeText={changeText}
          multiline
          editable={!saving && !processing && !draft.submissionId}
          onPasteImages={pasteImages}
          onPasteError={setError}
          style={styles.input}
          accessibilityLabel="Edit queued message"
        />
        <SharedQueueAttachments
          serverId={draft.serverId}
          agentId={draft.agentId}
          messageId={draft.original.id}
          presentation={contextPresentation}
        />
        <View style={styles.media}>
          {working.attachments.map((attachment) => (
            <RemoteMedia
              key={attachment.id}
              draft={draft}
              attachment={attachment}
              disabled={disabled}
              remove={removeRemote}
            />
          ))}
          {working.localAttachments.map(({ metadata }) => (
            <LocalMedia
              key={metadata.id}
              metadata={metadata}
              disabled={disabled}
              remove={removeLocal}
              open={openLocal}
            />
          ))}
        </View>
        <DraftSaveStatus error={error} persisting={persisting || processing} />
        {error && !latest.current.submissionId ? (
          <Button size={size} variant="outline" onPress={retryDraft}>
            Retry saving draft
          </Button>
        ) : null}
        <ActionFooter style={styles.actions}>
          <Button
            size={size}
            variant="ghost"
            leftIcon={ImagePlus}
            disabled={disabled}
            onPress={choose}
          >
            Add images
          </Button>
          <View style={styles.saveActions}>
            <Button size={size} variant="outline" disabled={saving || processing} onPress={cancel}>
              Cancel
            </Button>
            <Button
              size={size}
              variant="default"
              disabled={
                disabled || unavailable || !draftHasContent(working) || !draftHasChanges(working)
              }
              onPress={save}
            >
              Save
            </Button>
          </View>
        </ActionFooter>
        <AttachmentLightbox source={source} onClose={closePreview} />
      </View>
    </QueueEditMediaInput>
  );
}
function DraftSaveStatus({ error, persisting }: { error: string | null; persisting: boolean }) {
  if (error) {
    return (
      <Text style={styles.error} accessibilityRole="alert">
        {error}
      </Text>
    );
  }
  return (
    <Text style={styles.muted}>
      {persisting ? "Saving draft on this device..." : "Draft saved on this device"}
    </Text>
  );
}

function RemoteMedia({
  draft,
  attachment,
  disabled,
  remove,
}: {
  draft: QueueEditDraft;
  attachment: QueueAttachment;
  disabled: boolean;
  remove(id: string): void;
}) {
  const touch = useVortonTouch();
  const presentation = useMemo(
    () => ({ ...draft.original, context: [], attachments: [attachment] }),
    [draft.original, attachment],
  );
  const onRemove = useCallback(() => remove(attachment.id), [remove, attachment.id]);
  return (
    <View style={styles.attachment}>
      <SharedQueueAttachments
        serverId={draft.serverId}
        agentId={draft.agentId}
        messageId={draft.original.id}
        presentation={presentation}
      />
      <Button
        size={touch ? "md" : "sm"}
        variant="ghost"
        leftIcon={X}
        accessibilityLabel={`Remove ${attachment.fileName}`}
        disabled={disabled}
        onPress={onRemove}
      />
    </View>
  );
}
function LocalMedia({
  metadata,
  disabled,
  remove,
  open,
}: {
  metadata: AttachmentMetadata;
  disabled: boolean;
  remove(metadata: AttachmentMetadata): void;
  open(metadata: AttachmentMetadata): void;
}) {
  const touch = useVortonTouch();
  const onRemove = useCallback(() => remove(metadata), [remove, metadata]);
  const onOpen = useCallback(() => open(metadata), [open, metadata]);
  const size = touch ? "md" : "sm";
  return (
    <View style={styles.attachment}>
      <Button size={size} variant="ghost" onPress={onOpen}>
        {metadata.fileName ?? "Image"}
      </Button>
      <Button
        size={size}
        variant="ghost"
        leftIcon={X}
        accessibilityLabel={`Remove ${metadata.fileName ?? "image"}`}
        disabled={disabled}
        onPress={onRemove}
      />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  editor: { gap: theme.spacing[2], paddingTop: theme.spacing[2] },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    minHeight: 80,
    padding: 0,
    borderWidth: 0,
    textAlignVertical: "top",
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  media: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  attachment: { flexDirection: "row", alignItems: "center" },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  saveActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
