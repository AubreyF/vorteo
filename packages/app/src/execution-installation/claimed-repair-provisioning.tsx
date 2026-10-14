import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsExpansion } from "@/components/settings/settings-expansion";
import { useRouter } from "expo-router";
import { z } from "zod";
import { BootstrapClaimedRepairStatusSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { isWeb } from "@/constants/platform";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { SidebarCallout } from "@/components/sidebar-callout";
import { settingsStyles } from "@/styles/settings";
import { readExecutionInstallation } from "./policy";

type Status = z.infer<typeof BootstrapClaimedRepairStatusSchema>;
/** This setup step admits the exact repair runtime. Recovery approval remains
 * a separate visible decision and no process effects occur here. */
export function ClaimedRepairProvisioning({ banner = false }: { banner?: boolean }) {
  const installation = readExecutionInstallation();
  const router = useRouter();
  const installationId = installation?.installationId;
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligible = isWeb && installation?.origin === window.location.origin;
  const refresh = useCallback(async () => {
    if (!eligible || !installationId) return;
    const response = await fetch("/api/installation/claimed-repair/status", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (
      response.status === 404 ||
      !response.headers.get("content-type")?.includes("application/json")
    )
      return;
    if (!response.ok) throw new Error("Repair setup is unavailable");
    const next = BootstrapClaimedRepairStatusSchema.parse(await response.json());
    if (next.installationId !== installationId) throw new Error("Repair installation changed");
    setStatus(next);
  }, [eligible, installationId]);
  useEffect(() => {
    if (!eligible) return;
    const read = () => {
      void refresh().catch(() =>
        setError("Repair setup is unavailable. Refresh to check its retained state."),
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
      const response = await fetch("/api/installation/claimed-repair/owner", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerPassword}` },
        body: JSON.stringify({
          type: "installation.claimed_repair.provision.request",
          admissionSha256: proposal.admissionSha256,
          ownerPassword,
        }),
      });
      if (!response.ok || (await response.json()).provisioned !== true)
        throw new Error(
          "Provisioning was not confirmed. Check the owner password and retained status before retrying.",
        );
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Provisioning was not confirmed");
    } finally {
      setBusy(false);
    }
  }, [status, busy, password, refresh]);
  const toggleDetails = useCallback(() => setDetails((value) => !value), []);
  const enable = useCallback(() => {
    void provision();
  }, [provision]);
  if (!eligible || !status?.provisioning) return null;
  if (banner)
    return (
      <SidebarCallout
        title="Coordinator repair setup required"
        description="Enable the protected repair runtime in Installation controls. This does not restart running work."
        actions={[
          {
            label: "Review repair setup",
            onPress: () =>
              router.push({
                pathname: "/settings/[section]",
                params: { section: "general", installation: "1" },
              }),
          },
        ]}
      />
    );
  return (
    <View testID="claimed-repair-provisioning" style={styles.card}>
      <Text style={settingsStyles.rowTitle}>Enable coordinator repair controls</Text>
      <Text style={styles.text}>
        Admit this protected repair runtime for the stalled coordinator operation. This prepares a
        recovery review without stopping processes or changing the selected coordinator. Review and
        approve recovery separately afterward.
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
            Original operation: {status.provisioning.originalId}
          </Text>
        </SettingsExpansion>
      ) : null}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <EditingTextInput
        secureTextEntry
        key={busy ? "busy" : "idle"}
        initialValue=""
        onChangeText={setPassword}
        placeholder="Owner password"
        accessibilityLabel="Repair setup owner password"
        editable={!busy}
      />
      <Button disabled={busy || !password} onPress={enable}>
        {busy ? "Verifying repair runtime" : "Enable repair controls"}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
