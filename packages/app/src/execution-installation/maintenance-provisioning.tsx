import { useCallback, useEffect, useState, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsExpansion } from "@/components/settings/settings-expansion";
import { useRouter } from "expo-router";
import { z } from "zod";
import { CoordinatorMaintenanceStatusSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { isWeb } from "@/constants/platform";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { MaintenanceNotice } from "./maintenance-notice";
import { settingsStyles } from "@/styles/settings";
import { readExecutionInstallation } from "./policy";

import { MaintenanceClient } from "./maintenance-client";
import { BootstrapPanelModel } from "./bootstrap-model";
import { BootstrapReview, BootstrapBanner } from "./bootstrap-panel";

type Status = z.infer<typeof CoordinatorMaintenanceStatusSchema>;
/** This setup step admits the exact maintenance runtime. Recovery approval remains
 * a separate visible decision and no process effects occur here. */
export function MaintenanceProvisioning({ banner = false }: { banner?: boolean }) {
  const installation = readExecutionInstallation();
  const router = useRouter();
  const installationId = installation?.installationId;
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligible = isWeb && installation?.origin === window.location.origin;
  const client = useMemo(
    () =>
      installationId
        ? new MaintenanceClient(installationId, {
            fetch: (url, init) => fetch(url, init),
            now: Date.now,
          })
        : null,
    [installationId],
  );
  const model = useMemo(() => new BootstrapPanelModel(() => client), [client]);
  const refresh = useCallback(async () => {
    if (!eligible || !client) return;
    const next = await client.status();
    setStatus(next);
    setError(null);
    if (next && (next.available || next.requests > 0)) await model.refresh();
  }, [eligible, client, model]);
  useEffect(() => {
    if (!eligible) return;
    const read = () => {
      void refresh().catch(() =>
        setError("Maintenance setup is unavailable. Refresh to check its retained state."),
      );
    };
    read();
    const timer = setInterval(read, 15_000);
    return () => clearInterval(timer);
  }, [eligible, refresh]);
  const provision = useCallback(async () => {
    const proposal = status?.provisioning;
    if (!proposal || busy || !password) return;
    const ownerPassword = password;
    setPassword("");
    setBusy(true);
    setError(null);
    try {
      if (!client) return;
      await client.provision(proposal.admissionSha256, ownerPassword);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Provisioning was not confirmed");
    } finally {
      setBusy(false);
    }
  }, [status, busy, password, refresh, client]);
  const refreshStatus = useCallback(() => {
    void refresh().catch(() => setError("Maintenance status unavailable"));
  }, [refresh]);
  const toggleDetails = useCallback(() => setDetails((value) => !value), []);
  const enable = useCallback(() => {
    void provision();
  }, [provision]);
  const openReview = useCallback(
    () =>
      router.push({
        pathname: "/settings/[section]",
        params: { section: "general", installation: "1" },
      }),
    [router],
  );
  if (!eligible || !status?.provisioning) return null;
  if (status.requests > 0)
    return banner ? <BootstrapBanner model={model} /> : <BootstrapReview model={model} />;
  const validating = busy || status.phase === "validating";
  if (banner)
    return (
      <MaintenanceNotice
        sidebarOnly
        needsAction={!validating}
        revision={status.provisioning.admissionSha256}
        testID="maintenance-setup-notice"
        title={
          validating
            ? "Coordinator maintenance validation"
            : "Coordinator maintenance setup required"
        }
        description="Enable the protected maintenance runtime in Installation controls. This does not restart running work."
        reviewLabel="Review maintenance setup"
        onReview={openReview}
      />
    );
  return (
    <View testID="maintenance-provisioning" style={styles.card}>
      <Text style={settingsStyles.rowTitle}>Enable coordinator maintenance controls</Text>
      <Text style={styles.text}>
        Enable the reviewed maintenance runtime. This prepares a coordinator update review without
        stopping processes or changing the selected coordinator. Approve that exact update
        separately afterward.
      </Text>
      <Button variant="ghost" onPress={toggleDetails}>
        {details ? "Hide details" : "Details"}
      </Button>
      {details ? (
        <SettingsExpansion>
          <Text selectable style={styles.text}>
            Source: {status.provisioning.sourceCommit}
          </Text>
          <Text selectable style={styles.text}>
            Artifact SHA-256: {status.provisioning.artifactSha256}
          </Text>
          <Text selectable style={styles.text}>
            Prepared request: {status.provisioning.requestId}
          </Text>
        </SettingsExpansion>
      ) : null}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <Button variant="ghost" onPress={refreshStatus}>
        Refresh status
      </Button>
      <EditingTextInput
        secureTextEntry
        key={busy ? "busy" : "idle"}
        initialValue=""
        onChangeText={setPassword}
        placeholder="Owner password"
        accessibilityLabel="Maintenance setup owner password"
        editable={!validating}
      />
      <Button disabled={validating || !password || !!error} onPress={enable}>
        {validating ? "Verifying maintenance runtime" : "Enable maintenance controls"}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
