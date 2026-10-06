import { CountBadge } from "@/components/ui/count-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { isNative } from "@/constants/platform";
import { QueueDragScrollContext } from "./drag-scroll";
import { queueReorderAction } from "./reorder";
import { SharedQueueAttachments } from "./shared-attachments";
import { QueueAttachmentSummary } from "./attachment-summary";
import {
  ArrowUp,
  Pencil,
  RotateCw,
  Play,
  Pause,
  MoreHorizontal,
  GripVertical,
  TriangleAlert,
} from "lucide-react-native";
import { useVortonTouch } from "@/vorton-touch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isQueueGoalError } from "./goal-error";
import { useCallback, useState, useRef, useContext, useEffect, type Ref } from "react";
import { Text, View, Pressable } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { QueueItem } from "@getpaseo/protocol/message-queue";
import { Button } from "@/components/ui/button";
import { QueueEditDraftProvider, useQueueEditDrafts } from "./edit-draft-context";
import { reviewRejectedQueueEdit } from "./edit-draft-runtime";
import { lazy, Suspense } from "react";
const QueueEditEditor = lazy(() =>
  import("./edit-editor").then((module) => ({ default: module.QueueEditEditor })),
);
import { type MessageQueueControl } from "./use-message-queue";
import { canKeepRejectedChange, type OutboxRecord } from "./outbox-record";

function describePendingChange(record: OutboxRecord): string {
  const operation = record.operation;
  switch (operation.kind) {
    case "enqueue":
    case "edit": {
      if (operation.text.trim()) return operation.text;
      const names = [
        ...operation.attachments.map((attachment) => attachment.fileName),
        ...record.localAttachments.map((attachment) => attachment.metadata.fileName ?? "Image"),
      ];
      return names.length ? [...new Set(names)].join(", ") : "Attached context";
    }
    case "pause":
      return operation.paused ? "Pause queue" : "Resume queue";
    case "reorder":
      return "Reorder queued messages";
    case "delete":
      return "Remove queued message";
    case "send_now":
      return "Send queued message now";
    case "resolve":
      return operation.action === "retry" ? "Retry queued message" : "Discard queued message";
  }
}

export function SharedQueueView(props: {
  serverId: string;
  agentId: string;
  control: MessageQueueControl;
  goalErrorHandled?: boolean;
}) {
  return (
    <QueueEditDraftProvider serverId={props.serverId} agentId={props.agentId}>
      <Suspense fallback={null}>
        <QueueViewContent {...props} />
      </Suspense>
    </QueueEditDraftProvider>
  );
}

function QueueViewContent({
  serverId,
  agentId,
  control,
  goalErrorHandled = false,
}: {
  serverId: string;
  agentId: string;
  control: MessageQueueControl;
  goalErrorHandled?: boolean;
}) {
  const edits = useQueueEditDrafts();
  const snapshot = control.snapshot;
  if (
    !control.visible ||
    (!showSharedQueue(control, goalErrorHandled) && !edits.drafts.length && !edits.error)
  )
    return null;
  const hasMessages = hasQueueMessages(control);
  return (
    <View
      style={hasMessages ? taskCardStyles.container : undefined}
      testID={hasMessages ? "shared-message-queue" : "queue-recovery-status"}
    >
      {hasMessages ? <QueueHeader control={control} /> : null}
      {!(goalErrorHandled && isQueueGoalError(snapshot?.deliveryError)) ? (
        <QueueDeliveryError control={control} />
      ) : null}
      {edits.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {edits.error.message}
        </Text>
      ) : null}
      {control.loading ? <Text style={styles.secondary}>Loading queue...</Text> : null}
      {control.error ? (
        <View style={styles.row}>
          <Text style={styles.error} accessibilityRole="alert">
            {control.error}
          </Text>
          <Button variant="ghost" size="sm" style={styles.inlineAction} onPress={control.refresh}>
            Retry
          </Button>
        </View>
      ) : null}
      <View>
        <QueueRows control={control} serverId={serverId} agentId={agentId} />
        {control.pending.map((record, index) => (
          <PendingRow
            key={record.operation.operationId}
            record={record}
            control={control}
            separated={index > 0 || !!snapshot?.items.length}
          />
        ))}
      </View>
    </View>
  );
}

function QueueHeader({ control }: { control: MessageQueueControl }) {
  const touch = useVortonTouch();
  const snapshot = control.snapshot;
  const toggle = useCallback(() => {
    if (snapshot)
      void control
        .mutate({ kind: "pause", paused: !snapshot.paused, expectedRevision: snapshot.revision })
        .catch(() => {});
  }, [control, snapshot]);
  return (
    <View style={[taskCardStyles.header, touch && taskCardStyles.touchHeader]}>
      <Text style={taskCardStyles.heading}>Message queue</Text>
      <QueueCountBadge control={control} />
      <View style={styles.heading} />
      {!control.connected ? <Text style={styles.secondary}>Offline</Text> : null}
      {control.connected && snapshot?.paused ? <Text style={styles.secondary}>Paused</Text> : null}
      <Button
        variant="ghost"
        size="sm"
        accessibilityLabel={snapshot?.paused ? "Resume queue" : "Pause queue"}
        testID="message-queue-pause-resume"
        leftIcon={snapshot?.paused ? Play : Pause}
        style={touch && styles.touch}
        disabled={!control.canMutate || !snapshot}
        onPress={toggle}
      />
    </View>
  );
}

const queueItemKey = (item: QueueItem) => item.id;
const EMPTY_QUEUE_ITEMS: QueueItem[] = [];

function QueueRows({
  control,
  serverId,
  agentId,
}: {
  control: MessageQueueControl;
  serverId: string;
  agentId: string;
}) {
  const snapshot = control.snapshot;
  const [preview, setPreview] = useState<{ revision: number; items: QueueItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRevision = useRef<number | null>(null);
  const edits = useQueueEditDrafts();
  const onDragActive = useContext(QueueDragScrollContext);
  const release = useCallback(() => onDragActive(false), [onDragActive]);
  useEffect(() => release, [release]);
  const enabled =
    control.canMutate &&
    !edits.drafts.length &&
    !preview &&
    !!snapshot &&
    snapshot.items.length > 1 &&
    snapshot.items.every((item) => item.delivery.status === "queued");
  const begin = useCallback(() => {
    startedRevision.current = snapshot?.revision ?? null;
    setError(null);
    onDragActive(true);
  }, [snapshot, onDragActive]);
  const drop = useCallback(
    (items: QueueItem[]) => {
      release();
      if (!snapshot || !control.canMutate) return;
      try {
        const action = queueReorderAction(snapshot, startedRevision.current, items);
        if (!action) return;
        setPreview({ revision: snapshot.revision, items });
        void control
          .mutate(action)
          .catch(() => {})
          .finally(() => setPreview(null));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Could not reorder the queue.");
      }
    },
    [snapshot, control, release],
  );
  const renderRow = useCallback(
    (info: DraggableRenderItemInfo<QueueItem>) => (
      <QueueRow
        item={info.item}
        index={info.index}
        control={control}
        serverId={serverId}
        agentId={agentId}
        dragInfo={info}
        reorderEnabled={enabled}
      />
    ),
    [control, serverId, agentId, enabled],
  );
  const queuedItems =
    preview && preview.revision === snapshot?.revision
      ? preview.items
      : (snapshot?.items ?? EMPTY_QUEUE_ITEMS);
  const items = [...queuedItems];
  for (const draft of edits.drafts) {
    if (!items.some((item) => item.id === draft.original.id)) items.push(draft.original);
  }
  return (
    <>
      <DraggableList
        data={items}
        keyExtractor={queueItemKey}
        renderItem={renderRow}
        onDragBegin={begin}
        onDragEnd={drop}
        onDragRelease={release}
        scrollEnabled={false}
        useDragHandle
        touchActivation="movement"
      />
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </>
  );
}

// A plain web activator lets dnd-kit own Space/arrow keys without a Pressable
// consuming the key event first. Native still uses press-in to acquire the drag.
const DragHandleSurface = isNative ? Pressable : View;

function QueueDragHandle({
  info,
  disabled,
}: {
  info: DraggableRenderItemInfo<QueueItem>;
  disabled: boolean;
}) {
  const touch = useVortonTouch();
  const handle = disabled ? undefined : info.dragHandleProps;
  return (
    <DragHandleSurface
      {...handle?.attributes}
      {...handle?.listeners}
      ref={handle?.setActivatorNodeRef as Ref<View> | undefined}
      onPressIn={isNative && !disabled ? info.drag : undefined}
      tabIndex={disabled ? -1 : 0}
      accessibilityRole="button"
      accessibilityLabel="Reorder queued message"
      accessibilityHint="Drag to change the message order."
      aria-disabled={disabled}
      testID={`queue-drag-${info.item.id}`}
      style={[
        styles.dragHandle,
        touch && styles.touch,
        info.isActive && styles.dragGrabbing,
        disabled && styles.dragDisabled,
      ]}
    >
      <ThemedGrip size={14} uniProps={mutedIconMapping} />
    </DragHandleSurface>
  );
}

function QueueCountBadge({ control }: { control: MessageQueueControl }) {
  const count = control.snapshot?.items.length ?? 0;
  return (
    <CountBadge
      label={String(count)}
      accessibilityLabel={`${count} queued messages`}
      testID="message-queue-card-count"
    />
  );
}

function hasQueueMessages(control: MessageQueueControl): boolean {
  return Boolean(
    control.snapshot?.items.length ||
    control.pending.some(
      ({ operation }) => operation.kind === "enqueue" || operation.kind === "edit",
    ),
  );
}

function showSharedQueue(control: MessageQueueControl, goalErrorHandled: boolean): boolean {
  if (!control.visible || (!control.supported && !control.pending.length)) return false;
  const snapshot = control.snapshot;
  return Boolean(
    snapshot?.items.length ||
    (snapshot?.deliveryError && !(goalErrorHandled && isQueueGoalError(snapshot.deliveryError))) ||
    control.pending.length ||
    control.error ||
    control.loading,
  );
}

function QueueDeliveryError({ control }: { control: MessageQueueControl }) {
  const snapshot = control.snapshot;
  const retry = useCallback(() => {
    if (!snapshot) return;
    void control
      .mutate({ kind: "pause", paused: false, expectedRevision: snapshot.revision })
      .catch(() => {});
  }, [control, snapshot]);
  if (!snapshot?.deliveryError) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.error} accessibilityRole="alert">
        {snapshot.deliveryError}
      </Text>
      {!isQueueGoalError(snapshot.deliveryError) ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.inlineAction}
          accessibilityLabel="Retry delivery"
          leftIcon={RotateCw}
          disabled={!control.canMutate}
          onPress={retry}
        />
      ) : null}
    </View>
  );
}

function PendingRow({
  record,
  control,
  separated,
}: {
  record: OutboxRecord;
  control: MessageQueueControl;
  separated: boolean;
}) {
  const touch = useVortonTouch();
  const localStatus = record.dismissed ? "Kept on this device" : "Queued on this device";
  const attachments =
    record.operation.kind === "enqueue" || record.operation.kind === "edit"
      ? [...record.operation.attachments, ...record.localAttachments]
      : [];
  const [error, setError] = useState<string | null>(null);
  const keepCopy = useCallback(() => {
    setError(null);
    void control
      .keepLocalCopy(record)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Could not keep the local copy."),
      );
  }, [control, record]);
  const removeCopy = useCallback(() => {
    setError(null);
    void control
      .removeLocalCopy(record)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Could not remove the local copy."),
      );
  }, [control, record]);
  const retry = useCallback(() => {
    setError(null);
    void control
      .retry(record)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Retry failed."),
      );
  }, [record, control]);
  return (
    <View style={[taskCardStyles.item, separated && taskCardStyles.separator]}>
      {record.error ? <Text style={styles.secondary}>Could not synchronize</Text> : null}
      {record.dismissed ? (
        <Text style={styles.secondary}>Kept locally. This change will not be sent.</Text>
      ) : null}
      <View style={styles.summary}>
        <Tooltip enabledOnDesktop enabledOnMobile>
          <TooltipTrigger
            accessibilityRole="button"
            accessibilityLabel={localStatus}
            style={[styles.localStatus, touch && styles.touch]}
          >
            <ThemedWarning size={14} uniProps={warningIconMapping} />
          </TooltipTrigger>
          <TooltipContent side="top">
            <Text style={styles.tooltipText}>{localStatus}</Text>
          </TooltipContent>
        </Tooltip>
        <QueueAttachmentSummary
          count={attachments.length}
          hasMedia={attachments.some((attachment) => attachment.kind === "image")}
        />
        <Text
          selectable
          style={[taskCardStyles.rowText, styles.summaryText]}
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {describePendingChange(record)}
        </Text>
      </View>
      {record.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {record.error.message}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {record.error && !record.dismissed ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.inlineAction}
          disabled={!control.connected}
          onPress={retry}
        >
          Retry synchronization
        </Button>
      ) : null}
      <ReviewRejectedEdit record={record} control={control} />
      {canKeepRejectedChange(record) ? (
        <Button variant="ghost" size="sm" style={styles.inlineAction} onPress={keepCopy}>
          Keep local copy and continue queue
        </Button>
      ) : null}
      {record.dismissed ? (
        <Button variant="ghost" size="sm" style={styles.inlineAction} onPress={removeCopy}>
          Remove local copy
        </Button>
      ) : null}
    </View>
  );
}

function ReviewRejectedEdit({
  record,
  control,
}: {
  record: OutboxRecord;
  control: MessageQueueControl;
}) {
  const { refresh } = useQueueEditDrafts();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = record.operation;
  const current =
    operation.kind === "edit"
      ? control.snapshot?.items.find((item) => item.id === operation.messageId)
      : undefined;
  const review = useCallback(() => {
    setBusy(true);
    void reviewRejectedQueueEdit(record, current)
      .then(refresh)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Could not recover this edit."),
      )
      .finally(() => setBusy(false));
  }, [record, current, refresh]);
  if (!record.error || operation.kind !== "edit") return null;
  return (
    <View>
      <Button size="sm" variant="outline" disabled={busy} onPress={review}>
        {current?.delivery.status === "queued"
          ? "Review against current message"
          : "Review saved copy"}
      </Button>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function QueueRow({
  serverId,
  agentId,
  item,
  index,
  control,
  dragInfo,
  reorderEnabled,
}: {
  serverId: string;
  agentId: string;
  item: QueueItem;
  index: number;
  control: MessageQueueControl;
  dragInfo: DraggableRenderItemInfo<QueueItem>;
  reorderEnabled: boolean;
}) {
  const edits = useQueueEditDrafts();
  const editing = edits.drafts.filter((draft) => draft.original.id === item.id);
  const [editError, setEditError] = useState<string | null>(null);
  const edit = useCallback(() => {
    void edits
      .open(item)
      .catch((failure: unknown) =>
        setEditError(failure instanceof Error ? failure.message : "Could not open queue edit."),
      );
  }, [edits, item]);
  const [details, setDetails] = useState(false);
  const toggleDetails = useCallback(() => setDetails((value) => !value), []);
  return (
    <View
      style={[
        taskCardStyles.item,
        index > 0 && taskCardStyles.separator,
        dragInfo.isActive && styles.dragActive,
      ]}
      testID={`queue-message-${item.id}`}
    >
      {!editing.length ? (
        <View style={styles.summary}>
          <QueueDragHandle info={dragInfo} disabled={!reorderEnabled} />
          <QueueAttachmentSummary
            count={item.attachments.length}
            hasMedia={item.attachments.some((attachment) => attachment.kind === "image")}
          />
          <Text
            style={[taskCardStyles.rowText, styles.summaryText]}
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {item.text ||
              item.attachments.map((attachment) => attachment.fileName).join(", ") ||
              "Attached context"}
          </Text>
          <QueueActions
            item={item}
            control={control}
            edit={edit}
            details={details}
            toggleDetails={toggleDetails}
          />
        </View>
      ) : null}
      {details && !editing.length ? (
        <SharedQueueAttachments
          serverId={serverId}
          agentId={agentId}
          messageId={item.id}
          presentation={item}
        />
      ) : null}
      {item.delivery.status === "dispatching" ? (
        <Text style={styles.secondary}>Sending...</Text>
      ) : null}
      {"reason" in item.delivery ? (
        <Text style={styles.error} accessibilityRole="alert">
          {item.delivery.reason}
        </Text>
      ) : null}
      {item.delivery.status === "uncertain" ? (
        <Text style={styles.secondary}>
          The host could not confirm delivery. Retrying may send this message again.
        </Text>
      ) : null}
      {editError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {editError}
        </Text>
      ) : null}
      {editing.map((draft) => (
        <QueueEditEditor
          key={draft.id}
          draft={draft}
          current={control.snapshot?.items.find((entry) => entry.id === item.id)}
        />
      ))}
    </View>
  );
}

function QueueActions({
  item,
  control,
  edit,
  details,
  toggleDetails,
}: {
  item: QueueItem;
  control: MessageQueueControl;
  edit: () => void;
  details: boolean;
  toggleDetails: () => void;
}) {
  const touch = useVortonTouch();
  const queued = item.delivery.status === "queued";
  const sendNow = useCallback(() => {
    void control
      .mutate({
        kind: "send_now",
        messageId: item.id,
        expectedRevision: item.revision,
        expectedTurnId: control.activeTurnId,
      })
      .catch(() => {});
  }, [control, item]);
  const blocked = item.delivery.status === "uncertain" || item.delivery.status === "failed";
  const remove = useCallback(() => {
    void control
      .mutate({ kind: "delete", messageId: item.id, expectedRevision: item.revision })
      .catch(() => {});
  }, [control, item]);
  const retry = useCallback(() => {
    void control
      .mutate({
        kind: "resolve",
        action: "retry",
        messageId: item.id,
        expectedRevision: item.revision,
      })
      .catch(() => {});
  }, [control, item]);
  const discard = useCallback(() => {
    void control
      .mutate({
        kind: "resolve",
        action: "discard",
        messageId: item.id,
        expectedRevision: item.revision,
      })
      .catch(() => {});
  }, [control, item]);
  return (
    <View style={[taskCardStyles.actions, !touch && taskCardStyles.actionInset]}>
      <QueuePrimaryActions
        queued={queued}
        canMutate={control.canMutate}
        sendRequested={!!item.sendNow}
        edit={edit}
        sendNow={sendNow}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityLabel="Queued message actions"
          style={[styles.menuTrigger, touch && styles.touch]}
        >
          <ThemedMore size={16} uniProps={mutedIconMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={220}>
          {item.attachments.length || item.context?.length ? (
            <DropdownMenuItem onSelect={toggleDetails}>
              {details ? "Hide attachments" : "View attachments"}
            </DropdownMenuItem>
          ) : null}
          {queued ? (
            <DropdownMenuItem destructive disabled={!control.canMutate} onSelect={remove}>
              Remove message
            </DropdownMenuItem>
          ) : null}
          {blocked ? (
            <>
              <DropdownMenuItem disabled={!control.canMutate} onSelect={retry}>
                Retry delivery
              </DropdownMenuItem>
              <DropdownMenuItem destructive disabled={!control.canMutate} onSelect={discard}>
                Discard message
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function QueuePrimaryActions({
  queued,
  canMutate,
  sendRequested,
  edit,
  sendNow,
}: {
  queued: boolean;
  canMutate: boolean;
  sendRequested: boolean;
  edit: () => void;
  sendNow: () => void;
}) {
  const touch = useVortonTouch();
  return (
    <>
      {" "}
      {queued ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            style={[taskCardStyles.iconAction, touch && styles.touch]}
            leftIcon={Pencil}
            accessibilityLabel="Edit queued message"
            disabled={!canMutate}
            onPress={edit}
          />
          <Button
            size="sm"
            variant="ghost"
            style={[taskCardStyles.iconAction, touch && styles.touch]}
            leftIcon={ArrowUp}
            accessibilityLabel="Send queued message now"
            disabled={!canMutate || sendRequested}
            onPress={sendNow}
          />
        </>
      ) : null}
    </>
  );
}

const ThemedGrip = withUnistyles(GripVertical);
const ThemedWarning = withUnistyles(TriangleAlert);
const ThemedMore = withUnistyles(MoreHorizontal);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[1] },
  summary: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  summaryText: { flex: 1, minWidth: 0 },
  localStatus: {
    width: 24,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  heading: {
    flex: 1,
  },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm, flexShrink: 1 },
  touch: { minHeight: 44, minWidth: 44 },
  inlineAction: { minHeight: 44, alignSelf: "flex-start" },
  menuTrigger: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
  dragHandle: {
    width: 24,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
    _web: { cursor: "grab" },
    touchAction: "none",
  },
  dragGrabbing: { _web: { cursor: "grabbing" } },
  dragDisabled: { opacity: 0.35, _web: { cursor: "auto" } },
  dragActive: { backgroundColor: theme.colors.surface2 },
  editorActions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  editor: { gap: theme.spacing[2], paddingTop: theme.spacing[2] },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    minHeight: 80,
    padding: 0,
    borderWidth: 0,
    textAlignVertical: "top",
  },
}));
