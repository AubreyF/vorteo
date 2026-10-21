import React, { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import type {
  MaintenanceServiceQueueStatus,
  MaintenanceServiceView,
} from "@getpaseo/protocol/maintenance-service-status";

export interface MaintenanceServiceQueueProps {
  status: MaintenanceServiceQueueStatus | null;
  error: string | null;
  refreshing: boolean;
  busy: boolean;
  onRefresh(): void;
  onCancel(job: MaintenanceServiceView): void;
}

/** These are durable request receipts, not current service health observations. */
export function MaintenanceServiceQueue({
  status,
  error,
  refreshing,
  busy,
  onRefresh,
  onCancel,
}: MaintenanceServiceQueueProps) {
  return (
    <View style={styles.queue} testID="maintenance-request-queue">
      <View style={styles.heading}>
        <Text style={settingsStyles.rowTitle}>Maintenance requests</Text>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          loading={refreshing}
          onPress={onRefresh}
        >
          Refresh requests
        </Button>
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {error}
        </Text>
      ) : null}
      {!status ? <Text style={styles.hint}>Request status has not been retrieved.</Text> : null}
      {status && !status.available ? (
        <Text style={styles.hint}>
          Maintenance execution is unavailable. Recorded requests remain visible.
        </Text>
      ) : null}
      {status?.jobs.length === 0 ? <Text style={styles.hint}>No maintenance requests.</Text> : null}
      {status?.jobs.map((job) => (
        <MaintenanceRequestRow
          key={job.id}
          job={job}
          disabled={busy || Boolean(error)}
          onCancel={onCancel}
        />
      ))}
    </View>
  );
}
function MaintenanceRequestRow({
  job,
  disabled,
  onCancel,
}: {
  job: MaintenanceServiceView;
  disabled: boolean;
  onCancel(job: MaintenanceServiceView): void;
}) {
  const cancel = useCallback(() => onCancel(job), [onCancel, job]);
  return (
    <View style={styles.request} testID={`maintenance-request-${job.id}`}>
      <View style={styles.heading}>
        <Text style={settingsStyles.rowTitle}>
          {job.target === "maintenance-controller" ? "Maintenance controller" : "Recovery launcher"}
        </Text>
        <StatusBadge label={labels[job.status]} variant={variants[job.status]} />
      </View>
      <Text style={styles.hint}>{job.reason}</Text>
      <Text style={styles.hint}>{job.detail}</Text>
      {job.dispatchAfter && job.status === "approved" ? (
        <Text style={styles.hint}>
          Eligible after {new Date(job.dispatchAfter).toLocaleTimeString()}. You can cancel until
          dispatch.
        </Text>
      ) : null}
      {job.observedAt ? (
        <Text style={styles.hint}>Last checked {new Date(job.observedAt).toLocaleString()}</Text>
      ) : null}
      {job.cancelable ? (
        <View style={styles.actions}>
          <Button variant="outline" size="sm" disabled={disabled} onPress={cancel}>
            Cancel maintenance
          </Button>
        </View>
      ) : null}
    </View>
  );
}
const variants = {
  pending: "warning",
  approved: "warning",
  running: "warning",
  succeeded: "success",
  failed: "error",
  rejected: "warning",
} as const;
const labels = {
  pending: "Requested",
  approved: "Scheduled",
  running: "Outcome unverified",
  succeeded: "Candidate verified",
  failed: "Needs attention",
  rejected: "Closed",
} as const;
const styles = StyleSheet.create((theme) => ({
  queue: { padding: theme.spacing[4], gap: theme.spacing[2] },
  heading: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  request: { paddingVertical: theme.spacing[2], gap: theme.spacing[2] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { alignItems: "flex-end" },
}));
