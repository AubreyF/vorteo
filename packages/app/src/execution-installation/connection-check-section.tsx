import React, { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import { isWeb } from "@/constants/platform";
import { StyleSheet } from "react-native-unistyles";
import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import {
  connectionSessionDescription,
  installationConnectionTargets,
  type ConnectionSession,
  type ConnectionCheckTarget,
} from "./connection-check";

import {
  diagnoseConnection,
  inspectConnectionDevice,
  connectionDiagnosis,
  connectionDiagnosticReport,
  type ConnectionDiagnostic,
  type DeviceDiagnostic,
} from "./connection-diagnostics";

/** Independent of owner unlock and daemon availability, so diagnostics survive a failed connection. */
export function InstallationConnectionCheckSection({
  installation,
  sessionFor,
  build = null,
}: {
  installation: ExecutionInstallation;
  build?: string | null;
  sessionFor: (serverId: string) => ConnectionSession;
}) {
  const [results, setResults] = useState<ConnectionDiagnostic[]>([]);
  const [checking, setChecking] = useState(false);
  const [device, setDevice] = useState<DeviceDiagnostic | null>(null);
  const [feedback, setFeedback] = useState("");
  const [showReport, setShowReport] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      generation.current++;
      inFlight.current?.abort();
    },
    [],
  );
  const check = useCallback(async () => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    const request = ++generation.current;
    setChecking(true);
    setResults([]);
    setDevice(null);
    setFeedback("");
    try {
      await Promise.all([
        inspectConnectionDevice().then((value) => {
          if (generation.current === request) setDevice(value);
          return value;
        }),
        ...installationConnectionTargets(installation).map(async (target) => {
          const result = await diagnoseConnection(target, sessionFor, controller.signal);
          if (generation.current !== request) return;
          setResults((previous) => [...previous, result]);
        }),
      ]);
    } finally {
      if (generation.current === request) {
        inFlight.current = null;
        setChecking(false);
      }
    }
  }, [installation, sessionFor]);
  const targets = installationConnectionTargets(installation);
  const orderedResults = targets.flatMap((target) =>
    results.filter((result) => result.target.id === target.id),
  );
  const report = connectionDiagnosticReport(device, orderedResults, build);
  const copy = useCallback(async () => {
    try {
      if (isWeb) await navigator.clipboard.writeText(report);
      else {
        const clipboard = await import("expo-clipboard");
        const copied = await clipboard.setStringAsync(report);
        if (!copied) throw new Error("Clipboard unavailable");
      }
      setFeedback(
        "Diagnostic report copied. It contains endpoint addresses and browser details, but no passwords or tokens.",
      );
    } catch {
      setFeedback(
        "Clipboard access failed. The report is shown below and can be selected and copied.",
      );
      setShowReport(true);
    }
  }, [report]);
  const toggleReport = useCallback(() => setShowReport((value) => !value), []);
  return (
    <SettingsSection
      title="Connection check"
      testID="installation-connection-check"
      status={checking ? "Checking this device..." : null}
      info="Runs health HTTP, WebSocket transport and cross-origin access checks, then compares the saved app connection. Probes send no passwords or tokens and never restart services."
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Check this device</Text>
            <Text style={settingsStyles.rowHint}>
              See which connection is failing without entering addresses.
            </Text>
          </View>
          <Button variant="outline" size="md" onPress={check} disabled={checking}>
            Check connection
          </Button>
        </View>
        {device ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={styles.result}>
              <Text style={settingsStyles.rowTitle}>This device</Text>
              <Text style={settingsStyles.rowHint}>
                Browser network hint: {booleanLabel(device.online, "Online", "Offline")}. Secure
                context: {booleanLabel(device.secureContext, "Yes", "No")}.
              </Text>
              <Text
                style={
                  device.localNetworkPermission === "denied"
                    ? settingsStyles.rowError
                    : settingsStyles.rowHint
                }
              >
                Browser local-network permission: {device.localNetworkPermission}.
              </Text>
              {device.localNetworkPermission === "denied" ? (
                <Text style={settingsStyles.rowError}>
                  Allow Local network access in the site browser settings, then run the check again.
                </Text>
              ) : null}
              <Text style={settingsStyles.rowHint}>
                The browser cannot inspect macOS permissions, Tailscale connection settings or DNS
                configuration. Unknown evidence is never reported as a confirmed cause.
              </Text>
              {build ? (
                <Text selectable style={styles.address}>
                  Interface source: {build.slice(0, 12)}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}
        {targets.map((target) => {
          const result = results.find((item) => item.target.id === target.id);
          const badge = connectionBadge(result, checking);
          return (
            <View
              key={target.id}
              style={[settingsStyles.row, settingsStyles.rowBorder]}
              testID={`connection-check-${target.id}`}
            >
              <View style={styles.result}>
                <View style={styles.title}>
                  <Text style={settingsStyles.rowTitle}>{target.label}</Text>
                  <StatusBadge label={badge.label} variant={badge.variant} />
                </View>
                <Text selectable style={styles.address}>
                  {target.url}
                </Text>
                {result ? (
                  <>
                    <Text
                      style={
                        result.state === "failed" ? settingsStyles.rowError : settingsStyles.rowHint
                      }
                    >
                      {result.detail}
                    </Text>
                    <Text style={settingsStyles.rowHint}>{connectionDiagnosis(result)}</Text>
                    <Text style={settingsStyles.rowHint}>
                      Health HTTP: {result.httpStatus ?? result.failure ?? result.state}
                    </Text>
                    {result.socket ? (
                      <Text style={settingsStyles.rowHint}>
                        WebSocket: {result.socket.detail} ({result.socket.elapsedMs} ms).
                      </Text>
                    ) : null}
                    {result.crossOrigin ? (
                      <Text style={settingsStyles.rowHint}>
                        Cross-origin check: {result.crossOrigin.detail}.
                      </Text>
                    ) : null}
                    {target.serverId ? (
                      <Text style={settingsStyles.rowHint}>
                        {connectionSessionDescription(result.session)}
                      </Text>
                    ) : null}
                    {result.session?.endpoint ? (
                      <Text selectable style={styles.address}>
                        App address: {result.session.endpoint}
                      </Text>
                    ) : null}
                    <Text style={settingsStyles.rowHint}>
                      Checked {new Date(result.checkedAt).toLocaleTimeString()} · {result.elapsedMs}{" "}
                      ms
                    </Text>
                    {result.failure === "network" || result.failure === "timeout" ? (
                      <OpenBrowserError target={target} onError={setFeedback} />
                    ) : null}
                  </>
                ) : null}
              </View>
            </View>
          );
        })}
        {results.length ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={styles.result}>
              <Text style={settingsStyles.rowHint}>
                The report includes results from this device, private endpoint addresses and
                interface version. It excludes credentials and saved storage.
              </Text>
              <View style={styles.actions}>
                <Button variant="outline" size="md" onPress={copy} disabled={checking}>
                  Copy diagnostic report
                </Button>
                <Button variant="outline" size="md" onPress={toggleReport}>
                  {showReport ? "Hide report" : "Show report"}
                </Button>
              </View>
              {feedback ? (
                <Text accessibilityLiveRegion="polite" style={settingsStyles.rowHint}>
                  {feedback}
                </Text>
              ) : null}
              {showReport ? (
                <Text selectable testID="connection-diagnostic-report" style={styles.address}>
                  {report}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}
function booleanLabel(value: boolean | null, yes: string, no: string) {
  if (value === null) return "Unavailable";
  return value ? yes : no;
}
function OpenBrowserError({
  target,
  onError,
}: {
  target: ConnectionCheckTarget;
  onError: (message: string) => void;
}) {
  const open = useCallback(async () => {
    try {
      await Linking.openURL(target.url);
    } catch {
      onError(
        "The browser could not open the health page. The in-app results and report remain available.",
      );
    }
  }, [target.url, onError]);
  return (
    <Button variant="outline" size="md" onPress={open}>
      Open {target.label} browser error
    </Button>
  );
}
function connectionBadge(result: ConnectionDiagnostic | undefined, checking: boolean) {
  if (result?.state === "reachable") return { label: "Reached", variant: "success" as const };
  if (result) return { label: "Failed", variant: "error" as const };
  return { label: checking ? "Checking" : "Not checked", variant: "muted" as const };
}

const styles = StyleSheet.create((theme) => ({
  result: { flex: 1, minWidth: 0 },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  title: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  address: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
}));
