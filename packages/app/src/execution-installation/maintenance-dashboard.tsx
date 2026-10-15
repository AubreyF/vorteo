import type { InstallationEnrollmentStatus } from "@getpaseo/protocol/installation-enrollment";
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import { useVortonTouch } from "@/vorton-touch";
import {
  currentMaintenanceStatus,
  maintenanceHeadline,
  maintenanceTargetLabels,
} from "./maintenance-dashboard-model";

interface MaintenanceDashboardProps {
  status: InstallationEnrollmentStatus | null;
  error: string | null;
  refreshing: boolean;
  onRefresh(): void;
}

/** Both independent recovery and normal installation views render this observation. */
export function MaintenanceDashboard({
  status,
  error,
  refreshing,
  onRefresh,
}: MaintenanceDashboardProps) {
  const touch = useVortonTouch();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const deadline = Date.parse(status?.validUntil ?? "");
    setNow(Date.now());
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(2_147_483_647, deadline - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [status]);
  const current = status ? currentMaintenanceStatus(status, now) : null;
  const savedHeadline = current ? maintenanceHeadline(current) : null;
  const headline = error ? unavailableHeadline : savedHeadline;
  return (
    <View testID="installation-maintenance-dashboard" style={styles.dashboard}>
      <View style={styles.heading} testID="installation-health-headline">
        <Text style={settingsStyles.rowTitle}>Installation health</Text>
        {headline ? <StatusBadge label={headline.label} variant={headline.variant} /> : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {error}
        </Text>
      ) : null}
      {headline ? (
        <Text style={styles.hint}>{headline.explanation}</Text>
      ) : (
        <Text style={styles.hint}>
          Installation status is unavailable. Refresh to check the maintenance service.
        </Text>
      )}
      {status ? (
        <>
          <Text style={styles.hint}>
            Activation: {status.completedSteps} of {status.totalSteps} steps verified.
          </Text>
          {current?.services.map((service) => (
            <View
              key={service.target}
              style={styles.service}
              testID={`maintenance-service-${service.target}`}
            >
              <View style={styles.serviceTitle}>
                <Text style={settingsStyles.rowTitle}>
                  {maintenanceTargetLabels[service.target]}
                </Text>
                <StatusBadge
                  label={readinessLabels[service.readiness]}
                  variant={readinessVariants[service.readiness]}
                />
              </View>
              <Text style={styles.hint}>{service.reason}</Text>
              <Text style={styles.hint}>
                {service.enabled ? "Automatic maintenance enabled" : "Automatic maintenance off"}
                {service.observedAt
                  ? ` · Observed ${new Date(service.observedAt).toLocaleString()}`
                  : ""}
              </Text>
            </View>
          ))}
          <Text style={styles.hint}>
            Status checked {new Date(status.checkedAt).toLocaleString()}.
          </Text>
        </>
      ) : null}
      <View style={styles.actions}>
        <Button
          variant="ghost"
          size={touch ? "md" : "sm"}
          loading={refreshing}
          disabled={refreshing}
          onPress={onRefresh}
        >
          Refresh status
        </Button>
      </View>
    </View>
  );
}

const readinessLabels = {
  ready: "Ready",
  blocked: "Needs attention",
  unknown: "Unverified",
} as const;
const unavailableHeadline = {
  label: "Status unavailable",
  variant: "warning" as const,
  explanation: "Last known status is shown. Refresh before relying on service readiness.",
};
const readinessVariants = { ready: "success", blocked: "error", unknown: "warning" } as const;
const styles = StyleSheet.create((theme) => ({
  dashboard: { padding: theme.spacing[4], gap: theme.spacing[2] },
  heading: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  service: { paddingVertical: theme.spacing[2], gap: theme.spacing[1] },
  serviceTitle: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  actions: { alignItems: "flex-end" },
}));
