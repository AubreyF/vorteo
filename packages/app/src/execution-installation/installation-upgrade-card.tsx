import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { InstallationUpgrade } from "@getpaseo/protocol/installation-upgrades";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import { useVortonTouch } from "@/vorton-touch";
import type { InstallationClient } from "./client";
import {
  activeUpgrade,
  upgradeApprovalText,
  upgradeStatusLabel,
  upgradeStepRows,
  type UpgradeStepRow,
} from "./installation-upgrades-model";
import {
  useInstallationUpgradeActions,
  useInstallationUpgradeStatus,
} from "./use-installation-upgrades";

const STATUS_VARIANTS: Record<InstallationUpgrade["status"], StatusBadgeVariant> = {
  pending: "warning",
  approved: "warning",
  running: "warning",
  succeeded: "success",
  failed: "error",
  rejected: "muted",
  cancelled: "muted",
};

const STEP_STATUS_LABELS: Record<UpgradeStepRow["status"], string> = {
  pending: "Waiting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
  "rolled-back": "Rolled back",
};

/** A pending or running upgrade in Installation controls. Details live in Vorteo updates. */
export function InstallationUpgradeCard({ client }: { client: InstallationClient | null }) {
  const status = useInstallationUpgradeStatus(client);
  const upgrade = activeUpgrade(status.data);
  if (!client || !status.data || !upgrade) return null;
  return (
    <View style={[styles.cardBody, settingsStyles.rowBorder]} testID="installation-upgrade-card">
      <InstallationUpgradeDetails
        client={client}
        upgrade={upgrade}
        hasDev={status.data.container}
      />
    </View>
  );
}

/** One upgrade with its steps, plus Approve and Reject while it waits for the owner. */
export function InstallationUpgradeDetails({
  client,
  upgrade,
  hasDev,
}: {
  client: InstallationClient;
  upgrade: InstallationUpgrade;
  hasDev: boolean;
}) {
  const controlSize = useVortonTouch() ? "md" : "sm";
  const { decide } = useInstallationUpgradeActions(client);
  const approve = useCallback(
    () => decide.mutate({ upgrade, decision: "approve" }),
    [decide, upgrade],
  );
  const reject = useCallback(
    () => decide.mutate({ upgrade, decision: "reject" }),
    [decide, upgrade],
  );
  const pending = upgrade.status === "pending";
  return (
    <View style={styles.item} testID={`installation-upgrade-${upgrade.id}`}>
      <View style={styles.header}>
        <Text style={settingsStyles.rowTitle}>Upgrade to {upgrade.release}</Text>
        <StatusBadge
          label={upgradeStatusLabel(upgrade)}
          variant={STATUS_VARIANTS[upgrade.status]}
        />
      </View>
      {pending ? <Text style={styles.text}>{upgradeApprovalText(hasDev)}</Text> : null}
      {upgrade.detail ? <Text style={styles.text}>{upgrade.detail}</Text> : null}
      {upgradeStepRows(upgrade).map((step) => (
        <Text key={step.name} style={styles.text} testID={`installation-upgrade-step-${step.name}`}>
          {`${step.label}: ${STEP_STATUS_LABELS[step.status]}${step.detail ? `. ${step.detail}` : ""}`}
        </Text>
      ))}
      {pending ? (
        <View style={styles.actions}>
          <Button
            size={controlSize}
            onPress={approve}
            disabled={decide.isPending}
            testID="installation-upgrade-approve"
          >
            Approve upgrade
          </Button>
          <Button
            variant="outline"
            size={controlSize}
            onPress={reject}
            disabled={decide.isPending}
            testID="installation-upgrade-reject"
          >
            Reject
          </Button>
        </View>
      ) : null}
      {decide.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {toErrorMessage(decide.error)}
        </Text>
      ) : null}
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
  item: { gap: theme.spacing[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
