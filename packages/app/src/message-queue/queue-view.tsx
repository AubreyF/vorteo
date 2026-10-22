import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  TaskCardRow,
  TaskCardRowLeading,
  useTaskCardRowActionStyle,
} from "@/agent-stream/task-card-row";
import { TruncatedText } from "@/components/ui/truncated-text";
import { useCardDisclosure } from "@/agent-stream/use-card-disclosure";
import { CardDisclosure, CollapsibleCardBody } from "@/agent-stream/card-disclosure";
import { CardHeaderStatus } from "@/components/ui/card-header-status";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { TaskCard, TaskCardHeader, TaskCardAction } from "@/agent-stream/task-card";
import { CountBadge } from "@/components/ui/count-badge";
import { QueueMessageIndicator } from "./queue-indicator";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { ListDragHandle } from "@/components/list-drag-handle";
import { QueueDragScrollContext } from "./drag-scroll";
import { queueReorderAction } from "./reorder";
import { SharedQueueAttachments } from "./shared-attachments";
import { QueueAttachmentSummary } from "./attachment-summary";
import { ArrowUp, Pencil, RotateCw, Play, Pause, MoreVertical } from "lucide-react-native";
import { useVortonTouch } from "@/vorton-touch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isQueueGoalError } from "./goal-error";
import { useReportActionError } from "@/hooks/use-action-error";
import { toErrorMessage } from "@/utils/error-messages";
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
  const [expanded, setExpanded] = useCardDisclosure("queue");
  useEffect(() => {
    if (reviewRequest > 0) setExpanded(true);
  }, [reviewRequest, setExpanded]);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), [setExpanded]);
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
    <TaskCard flushBody testID="shared-message-queue" bodyVisible={expanded}>
      <TaskCardHeader testID="message-queue-header">
        <QueueHeader control={control} expanded={expanded} toggleExpanded={toggleExpanded} />
      </TaskCardHeader>

      <CollapsibleCardBody expanded={expanded} testID="message-queue-body">
        {!(goalErrorHandled && isQueueGoalError(snapshot?.deliveryError)) ? (
          <QueueDeliveryError control={control} />
        ) : null}
        {edits.error ? (
          <Text style={[styles.error, taskCardStyles.proseInset]} accessibilityRole="alert">
            {toErrorMessage(edits.error)}
          </Text>
        ) : null}
        {control.error ? (
          <View style={styles.row}>
            <Text style={[styles.error, taskCardStyles.proseInset]} accessibilityRole="alert">
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
  const snapshot = control.snapshot;
  let status: string | null = null;
  if (snapshot?.paused) status = "Paused";
  if (!control.connected) status = "Offline";
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
        title="Queue"
        expanded={expanded}
        onPress={toggleExpanded}
        testID="message-queue-toggle"
        count={countBadge}
      />
      <TaskCardAction
        iconOnly
        accessibilityLabel={snapshot?.paused ? "Resume queue" : "Pause queue"}
        testID="message-queue-pause-resume"
        leftIcon={snapshot?.paused ? Play : Pause}
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
  const reportError = useReportActionError();
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
        reportError(failure);
      }
    },
    [snapshot, control, release, reportError],
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
      <Text style={[styles.error, taskCardStyles.proseInset]} accessibilityRole="alert">
        {toErrorMessage(snapshot.deliveryError)}
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
      <TaskCardRow>
        <TaskCardRowLeading>
          <QueueMessageIndicator record={record} />
          <QueueAttachmentSummary
            count={attachments.length}
            hasMedia={attachments.some((attachment) => attachment.kind === "image")}
          />
        </TaskCardRowLeading>
        <TruncatedText
          selectable
          style={[taskCardStyles.rowText, styles.summaryText]}
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {describePendingChange(record)}
        </TruncatedText>
      </TaskCardRow>
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
  const reportError = useReportActionError();
  const keepCopy = useCallback(() => {
    void control.keepLocalCopy(record).catch(reportError);
  }, [control, record, reportError]);
  const removeCopy = useCallback(() => {
    void control.removeLocalCopy(record).catch(reportError);
  }, [control, record, reportError]);
  const retry = useCallback(() => {
    void control.retry(record).catch(reportError);
  }, [record, control, reportError]);
  return (
    <View>
      {record.error && !record.dismissed ? (
        <Text style={[styles.secondary, taskCardStyles.proseInset]}>Could not synchronize</Text>
      ) : null}
      {record.dismissed ? (
        <Text style={[styles.secondary, taskCardStyles.proseInset]}>
          Kept locally. This change will not be sent.
        </Text>
      ) : null}
      {record.error && !record.dismissed ? (
        <Text style={[styles.error, taskCardStyles.proseInset]} accessibilityRole="alert">
          {toErrorMessage(record.error.message)}
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
  const reportError = useReportActionError();
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
      .catch(reportError)
      .finally(() => setBusy(false));
  }, [record, current, refresh, reportError]);
  if (!record.error || operation.kind !== "edit") return null;
  return (
    <Button size="sm" variant="outline" disabled={busy} onPress={review}>
      {current?.delivery.status === "queued"
        ? "Review against current message"
        : "Review saved copy"}
    </Button>
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
  const savingRecord =
    record ??
    control.pending.find(
      (pending) =>
        !pending.error &&
        !pending.dismissed &&
        pending.operation.kind === "edit" &&
        pending.operation.messageId === row.id,
    ) ??
    null;
  const attachments = row.shared ? row.shared.attachments : pendingAttachments(row.local);
  const text = row.shared ? describeQueuedMessage(row.shared) : describePendingChange(row.local);
  const edits = useQueueEditDrafts();
  const editing = edits.drafts.filter((draft) => draft.original.id === row.id);
  const reportError = useReportActionError();
  const edit = useCallback(() => {
    if (!item) return;
    void edits.open(item).catch(reportError);
  }, [edits, item, reportError]);
  const [details, setDetails] = useState(false);
  const toggleDetails = useCallback(() => setDetails((value) => !value), []);
  return (
    <View
      style={[taskCardStyles.item, dragInfo.isActive && styles.dragActive]}
      testID={`queue-message-${row.id}`}
    >
      {!editing.length ? (
        <TaskCardRow>
          <TaskCardRowLeading>
            <QueueMessageIndicator record={savingRecord}>
              {item ? (
                <ListDragHandle
                  inset={false}
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
          </TaskCardRowLeading>
          <TruncatedText
            selectable={!!record}
            style={[taskCardStyles.rowText, styles.summaryText]}
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {text}
          </TruncatedText>
          {item ? (
            <QueueActions
              item={item}
              control={control}
              edit={edit}
              details={details}
              toggleDetails={toggleDetails}
            />
          ) : null}
        </TaskCardRow>
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
      {item && "reason" in item.delivery ? (
        <Text style={[styles.error, taskCardStyles.proseInset]} accessibilityRole="alert">
          {toErrorMessage(item.delivery.reason)}
        </Text>
      ) : null}
      {item?.delivery.status === "uncertain" ? (
        <Text style={[styles.secondary, taskCardStyles.proseInset]}>
          The host could not confirm delivery. Retrying may send this message again.
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
  const rowActionStyle = useTaskCardRowActionStyle();
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
    <View style={taskCardStyles.actions}>
      <QueuePrimaryActions
        queued={queued}
        canMutate={control.canMutate}
        sendRequested={!control.canSendNow}
        dispatching={
          item.delivery.status === "dispatching" ||
          control.pending.some(
            (record) =>
              !record.error &&
              !record.dismissed &&
              record.operation.kind === "send_now" &&
              record.operation.messageId === item.id,
          )
        }
        edit={edit}
        sendNow={sendNow}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel="Queued message actions"
          style={[rowActionStyle, styles.menuTrigger]}
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
  dispatching,
  edit,
  sendNow,
}: {
  queued: boolean;
  canMutate: boolean;
  sendRequested: boolean;
  dispatching: boolean;
  edit: () => void;
  sendNow: () => void;
}) {
  const touch = useVortonTouch();
  const rowActionStyle = useTaskCardRowActionStyle();
  if (!queued && !dispatching) return null;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        style={rowActionStyle}
        leftIcon={Pencil}
        accessibilityLabel="Edit queued message"
        disabled={!canMutate || dispatching}
        onPress={edit}
      />
      <View style={styles.sendAction}>
        <Button
          size="sm"
          variant="ghost"
          style={rowActionStyle}
          leftIcon={ArrowUp}
          accessibilityLabel={dispatching ? "Sending queued message" : "Send queued message now"}
          disabled={!canMutate || sendRequested || dispatching}
          onPress={sendNow}
        />
        {dispatching ? (
          <View pointerEvents="none" style={styles.sendProgress} testID="queue-send-progress">
            <ThemedSendingSpinner size={touch ? 28 : 20} />
          </View>
        ) : null}
      </View>
    </>
  );
}

const ThemedSendingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

const ThemedMore = withUnistyles(MoreVertical);
const mutedIconMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const styles = StyleSheet.create((theme) => ({
  sendAction: { position: "relative" },
  sendProgress: { position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
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
  inlineAction: { minHeight: 44, alignSelf: "flex-start" },
  menuTrigger: {
    alignItems: "center",
    justifyContent: "center",
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
