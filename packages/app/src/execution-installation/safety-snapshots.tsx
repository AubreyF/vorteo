import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  InstallationSnapshot,
  SnapshotRestoreStatus,
} from "@getpaseo/protocol/installation-upgrades";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isWeb } from "@/constants/platform";
import { toErrorMessage } from "@/utils/error-messages";
import { useVortonTouch } from "@/vorton-touch";
import type { InstallationClient } from "./client";
import { installationHasDev, readExecutionInstallation } from "./policy";
import {
  restoreProgress,
  snapshotPartsSummary,
  snapshotReasonLabel,
  snapshotRestorePlan,
  sortedSnapshots,
} from "./installation-upgrades-model";
import { INSTALLATION_SNAPSHOTS_KEY, useInstallationSnapshots } from "./use-installation-upgrades";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Safety snapshots in Installation controls: list, take one now, and restore one after a
 * confirmation that names every part it replaces. Hidden when the coordinator predates them.
 */
export function SafetySnapshotsCard({ client }: { client: InstallationClient | null }) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const queryClient = useQueryClient();
  const [restore, setRestore] = useState<SnapshotRestoreStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const query = useInstallationSnapshots(client, restore !== null);
  const unreachable = useRef(false);
  const list = query.data;

  useEffect(() => {
    if (!restore) return;
    if (query.isError) {
      unreachable.current = true;
      return;
    }
    const progress = restoreProgress(list, restore.id, unreachable.current);
    if (progress === "reload" && isWeb) window.location.reload();
    if (progress === "failed") {
      setActionError(list?.restore?.detail || "The restore failed.");
      setRestore(null);
    }
  }, [list, query.isError, query.dataUpdatedAt, restore]);

  const take = useMutation({
    mutationFn: () => {
      if (!client) throw new Error("Unlock installation controls first");
      return client.takeSnapshot();
    },
    onMutate: () => setActionError(null),
    onError: (error) => setActionError(toErrorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: INSTALLATION_SNAPSHOTS_KEY }),
  });
  const takeSnapshot = useCallback(() => take.mutate(), [take]);

  const restoreSnapshot = useCallback(
    async (snapshot: InstallationSnapshot) => {
      if (!client) return;
      const plan = snapshotRestorePlan(
        snapshot,
        installationHasDev(readExecutionInstallation()),
        formatTime,
      );
      const confirmed = await confirmDialog({
        title: plan.title,
        message: plan.message,
        confirmLabel: "Restore snapshot",
        destructive: true,
      });
      if (!confirmed) return;
      setActionError(null);
      try {
        unreachable.current = false;
        setRestore(await client.restoreSnapshot(snapshot, plan.parts));
      } catch (error) {
        setActionError(toErrorMessage(error));
      }
    },
    [client],
  );

  // COMPAT(installationUpgrades): older coordinators answer 404, so the card stays hidden.
  if (!client || !list) return null;
  const snapshots = sortedSnapshots(list);
  const busy = take.isPending || restore !== null || list.restore?.status === "running";
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="safety-snapshots">
      <View style={styles.header}>
        <Text style={settingsStyles.rowTitle}>Safety snapshots</Text>
        {list.available ? (
          <Button
            variant="outline"
            size={controlSize}
            onPress={takeSnapshot}
            disabled={busy}
            loading={take.isPending}
            testID="safety-snapshot-take"
          >
            Take snapshot
          </Button>
        ) : null}
      </View>
      <Text style={styles.text}>{list.detail}</Text>
      {restore ? (
        <Text
          accessibilityLiveRegion="polite"
          style={styles.text}
          testID="safety-snapshot-restoring"
        >
          Restoring; Vorteo will reload when the coordinator is back.
        </Text>
      ) : null}
      {!restore && list.restore ? <RestoreStatusRow status={list.restore} /> : null}
      {snapshots.map((snapshot) => (
        <SnapshotRow
          key={snapshot.id}
          snapshot={snapshot}
          disabled={busy || !list.available}
          controlSize={controlSize}
          onRestore={restoreSnapshot}
        />
      ))}
      {list.available && snapshots.length === 0 ? (
        <Text style={styles.text}>No snapshots yet.</Text>
      ) : null}
      {actionError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {actionError}
        </Text>
      ) : null}
    </View>
  );
}

const RESTORE_BADGES = {
  running: { label: "Restoring", variant: "warning" },
  succeeded: { label: "Restored", variant: "success" },
  failed: { label: "Restore failed", variant: "error" },
} as const;

function RestoreStatusRow({ status }: { status: SnapshotRestoreStatus }) {
  const badge = RESTORE_BADGES[status.status];
  return (
    <View style={styles.item} testID="safety-snapshot-restore-status">
      <View style={styles.header}>
        <Text style={styles.label}>Restore of {status.snapshotId}</Text>
        <StatusBadge label={badge.label} variant={badge.variant} />
      </View>
      <Text style={styles.text}>
        {status.step}
        {status.detail ? `: ${status.detail}` : ""}
      </Text>
    </View>
  );
}

function SnapshotRow({
  snapshot,
  disabled,
  controlSize,
  onRestore,
}: {
  snapshot: InstallationSnapshot;
  disabled: boolean;
  controlSize: "sm" | "md";
  onRestore(snapshot: InstallationSnapshot): Promise<void>;
}) {
  const restore = useCallback(() => void onRestore(snapshot), [onRestore, snapshot]);
  return (
    <View style={styles.item} testID={`safety-snapshot-${snapshot.id}`}>
      <View style={styles.header}>
        <View style={styles.summary}>
          <Text style={styles.label}>{formatTime(snapshot.createdAt)}</Text>
          <Text style={styles.text}>{snapshotReasonLabel(snapshot)}</Text>
        </View>
        <Button
          variant="ghost"
          size={controlSize}
          onPress={restore}
          disabled={disabled || snapshot.parts.length === 0}
          testID={`safety-snapshot-restore-${snapshot.id}`}
        >
          Restore
        </Button>
      </View>
      <Text style={styles.text}>{snapshotPartsSummary(snapshot)}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  cardBody: { padding: theme.spacing[4], gap: theme.spacing[2] },
  header: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  item: { gap: theme.spacing[1] },
  summary: { flexShrink: 1, gap: theme.spacing[1] },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
