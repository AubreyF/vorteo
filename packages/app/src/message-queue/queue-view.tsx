import { CardDisclosure, CollapsibleCardBody } from "@/agent-stream/card-disclosure";
import { CardHeaderStatus } from "@/components/ui/card-header-status";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { TaskCard, TaskCardHeader } from "@/agent-stream/task-card";
import { CountBadge } from "@/components/ui/count-badge";
import { QueueMessageIndicator } from "./queue-indicator";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { ListDragHandle } from "@/components/list-drag-handle";
import { QueueDragScrollContext } from "./drag-scroll";
import { queueReorderAction } from "./reorder";
import { SharedQueueAttachments } from "./shared-attachments";
import { QueueAttachmentSummary } from "./attachment-summary";
import { ArrowUp, Pencil, RotateCw, Play, Pause, MoreHorizontal } from "lucide-react-native";
import { useVortonTouch } from "@/vorton-touch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isQueueGoalError } from "./goal-error";
import { useCallback, useState, useRef, useContext, useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { QueueItem } from "@getpaseo/protocol/message-queue";
import { Button } from "@/components/ui/button";
import { QueueEditDraftProvider, useQueueEditDrafts } from "./edit-draft-context";
import { reviewRejectedQueueEdit } from "./edit-draft-runtime";
import { lazy, Suspense } from "react";
const QueueEditEditor = lazy(() =>
  import("./edit-editor").then((module) => ({
    default: module.QueueEditEditor,
  })),
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
  reviewRequest?: number;
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
  reviewRequest = 0,
}: {
  serverId: string;
  agentId: string;
  control: MessageQueueControl;
  goalErrorHandled?: boolean;
  reviewRequest?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (reviewRequest > 0) setExpanded(true);
  }, [reviewRequest]);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const edits = useQueueEditDrafts();
  const snapshot = control.snapshot;
  if (
    !control.visible ||
    (!showSharedQueue(control, goalErrorHandled) && !edits.drafts.length && !edits.error)
  )
    return null;
  const recovery = control.pending.filter((record) => {
    const operation = record.operation;
    if (operation.kind !== "enqueue") return !!record.error || !!record.dismissed;
    return !!record.error && !!snapshot?.items.some((item) => item.id === operation.messageId);
  });
  return (
    <TaskCard testID="shared-message-queue" bodyVisible={expanded}>
      <TaskCardHeader testID="message-queue-header">
        <QueueHeader control={control} expanded={expanded} toggleExpanded={toggleExpanded} />
      </TaskCardHeader>

      <CollapsibleCardBody expanded={expanded} testID="message-queue-body">
        {!(goalErrorHandled && isQueueGoalError(snapshot?.deliveryError)) ? (
          <QueueDeliveryError control={control} />
        ) : null}
        {edits.error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {edits.error.message}
          </Text>
        ) : null}
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
          {recovery.map((record) => (
            <PendingRow key={record.operation.operationId} record={record} control={control} />
          ))}
        </View>
      </CollapsibleCardBody>
    </TaskCard>
  );
}

function QueueHeader({
  control,
  expanded,
  toggleExpanded,
}: {
  control: MessageQueueControl;
  expanded: boolean;
  toggleExpanded: () => void;
}) {
  const countBadge = useMemo(() => <QueueCountBadge control={control} />, [control]);
  const touch = useVortonTouch();
  const snapshot = control.snapshot;
  const pending = control.pending.filter(
    (record) =>
      !record.error &&
      !record.dismissed &&
      record.operation.kind !== "enqueue" &&
      record.operation.kind !== "reorder",
  );
  const operation = pending[0];
  let status: string | null = null;
  if (snapshot?.paused) status = "Paused";
  if (!control.connected) status = "Offline";
  if (control.loading) status = "Loading queue...";
  if (operation) {
    status =
      operation.operation.kind === "edit" ? "Saving message" : describePendingChange(operation);
    if (pending.length > 1) status += ` (+${pending.length - 1})`;
  }
  const toggle = useCallback(() => {
    if (snapshot)
      void control
        .mutate({
          kind: "pause",
          paused: !snapshot.paused,
          expectedRevision: snapshot.revision,
        })
        .catch(() => {});
  }, [control, snapshot]);
  const headerStatus = useMemo(
    () => <CardHeaderStatus text={status} testID="message-queue-header-status" />,
    [status],
  );
  return (
    <>
      <CardDisclosure
        icon={HEADING_ICON}
        trailing={headerStatus}
        title="Queued messages"
        expanded={expanded}
        onPress={toggleExpanded}
        testID="message-queue-toggle"
        count={countBadge}
      />
      <Button
        variant="ghost"
        size="sm"
        accessibilityLabel={snapshot?.paused ? "Resume queue" : "Pause queue"}
        testID="message-queue-pause-resume"
        leftIcon={snapshot?.paused ? Play : Pause}
        style={[taskCardStyles.iconAction, touch && taskCardStyles.touchAction]}
        disabled={!control.canMutate || !snapshot}
        onPress={toggle}
      />
    </>
  );
}

type QueueDisplayItem =
  | { id: string; shared: QueueItem; local: null }
  | { id: string; shared: null; local: OutboxRecord };

const queueItemKey = (item: QueueDisplayItem) => item.id;
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
  const [savingOrder, setSavingOrder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRevision = useRef<number | null>(null);
  const edits = useQueueEditDrafts();
  const onDragActive = useContext(QueueDragScrollContext);
  const release = useCallback(() => onDragActive(false), [onDragActive]);
  useEffect(() => release, [release]);
  const enabled =
    control.canMutate &&
    !edits.drafts.length &&
    !control.pending.some((record) => record.operation.kind === "enqueue") &&
    !savingOrder &&
    !!snapshot &&
    snapshot.items.length > 1 &&
    snapshot.items.every((item) => item.delivery.status === "queued");
  const begin = useCallback(() => {
    startedRevision.current = snapshot?.revision ?? null;
    setError(null);
    onDragActive(true);
  }, [snapshot, onDragActive]);
  const drop = useCallback(
    (rows: QueueDisplayItem[]) => {
      release();
      const items = rows.flatMap((row) => (row.shared ? [row.shared] : []));
      if (!snapshot || !control.canMutate) return;
      try {
        const action = queueReorderAction(snapshot, startedRevision.current, items);
        if (!action) return;
        setSavingOrder(true);
        return control.mutate(action).finally(() => setSavingOrder(false));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Could not reorder the queue.");
      }
    },
    [snapshot, control, release],
  );
  const renderRow = useCallback(
    (info: DraggableRenderItemInfo<QueueDisplayItem>) => (
      <QueueRow
        item={info.item}
        control={control}
        serverId={serverId}
        agentId={agentId}
        dragInfo={info}
        reorderEnabled={enabled}
      />
    ),
    [control, serverId, agentId, enabled],
  );
  const queuedItems = snapshot?.items ?? EMPTY_QUEUE_ITEMS;
  const items = [...queuedItems];
  for (const draft of edits.drafts) {
    if (!items.some((item) => item.id === draft.original.id)) items.push(draft.original);
  }
  const rows: QueueDisplayItem[] = items.map((item) => ({
    id: item.id,
    shared: item,
    local: null,
  }));
  for (const record of control.pending) {
    if (record.operation.kind !== "enqueue") continue;
    const id = record.operation.messageId;
    if (!rows.some((row) => row.id === id)) rows.push({ id, shared: null, local: record });
  }
  return (
    <>
      <DraggableList
        data={rows}
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
      .mutate({
        kind: "pause",
        paused: false,
        expectedRevision: snapshot.revision,
      })
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

function PendingRow({ record, control }: { record: OutboxRecord; control: MessageQueueControl }) {
  const attachments = pendingAttachments(record);
  return (
    <View style={taskCardStyles.item}>
      <View style={styles.summary}>
        <QueueMessageIndicator record={record} />
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
      <PendingRecovery record={record} control={control} />
    </View>
  );
}

function PendingRecovery({
  record,
  control,
}: {
  record: OutboxRecord;
  control: MessageQueueControl;
}) {
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
    <View>
      {record.error && !record.dismissed ? (
        <Text style={styles.secondary}>Could not synchronize</Text>
      ) : null}
      {record.dismissed ? (
        <Text style={styles.secondary}>Kept locally. This change will not be sent.</Text>
      ) : null}
      {record.error && !record.dismissed ? (
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

function pendingAttachments(record: OutboxRecord) {
  const operation = record.operation;
  if (operation.kind !== "enqueue" && operation.kind !== "edit") return [];
  return [...operation.attachments, ...record.localAttachments];
}

function describeQueuedMessage(item: QueueItem): string {
  return (
    item.text ||
    item.attachments.map((attachment) => attachment.fileName).join(", ") ||
    "Attached context"
  );
}

function QueueRow({
  serverId,
  agentId,
  item: row,
  control,
  dragInfo,
  reorderEnabled,
}: {
  serverId: string;
  agentId: string;
  item: QueueDisplayItem;
  control: MessageQueueControl;
  dragInfo: DraggableRenderItemInfo<QueueDisplayItem>;
  reorderEnabled: boolean;
}) {
  const item = row.shared;
  const record = row.local;
  const attachments = row.shared ? row.shared.attachments : pendingAttachments(row.local);
  const text = row.shared ? describeQueuedMessage(row.shared) : describePendingChange(row.local);
  const edits = useQueueEditDrafts();
  const editing = edits.drafts.filter((draft) => draft.original.id === row.id);
  const [editError, setEditError] = useState<string | null>(null);
  const edit = useCallback(() => {
    if (!item) return;
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
      style={[taskCardStyles.item, dragInfo.isActive && styles.dragActive]}
      testID={`queue-message-${row.id}`}
    >
      {!editing.length ? (
        <View style={styles.summary}>
          <QueueMessageIndicator record={record}>
            {item ? (
              <ListDragHandle
                info={dragInfo}
                disabled={!reorderEnabled}
                label="Reorder queued message"
                testID={`queue-drag-${row.id}`}
              />
            ) : null}
          </QueueMessageIndicator>
          <QueueAttachmentSummary
            count={attachments.length}
            hasMedia={attachments.some((attachment) => attachment.kind === "image")}
          />
          <Text
            selectable={!!record}
            style={[taskCardStyles.rowText, styles.summaryText]}
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {text}
          </Text>
          {item ? (
            <QueueActions
              item={item}
              control={control}
              edit={edit}
              details={details}
              toggleDetails={toggleDetails}
            />
          ) : null}
        </View>
      ) : null}
      {record ? <PendingRecovery record={record} control={control} /> : null}
      {item && details && !editing.length ? (
        <SharedQueueAttachments
          serverId={serverId}
          agentId={agentId}
          messageId={item.id}
          presentation={item}
        />
      ) : null}
      {item?.delivery.status === "dispatching" ? (
        <Text style={styles.secondary}>Sending...</Text>
      ) : null}
      {item && "reason" in item.delivery ? (
        <Text style={styles.error} accessibilityRole="alert">
          {item.delivery.reason}
        </Text>
      ) : null}
      {item?.delivery.status === "uncertain" ? (
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
          current={control.snapshot?.items.find((entry) => entry.id === row.id)}
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
      .mutate({
        kind: "delete",
        messageId: item.id,
        expectedRevision: item.revision,
      })
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
        sendRequested={!control.canSendNow}
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

const ThemedMore = withUnistyles(MoreHorizontal);
const mutedIconMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  summaryText: { flex: 1, minWidth: 0 },
  heading: {
    flex: 1,
  },
  secondary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  touch: { minHeight: 44, minWidth: 44 },
  inlineAction: { minHeight: 44, alignSelf: "flex-start" },
  menuTrigger: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
  dragActive: { backgroundColor: theme.colors.surface2 },
  editorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
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

const HEADING_ICON = <TaskCardIcon kind="messages" />;
