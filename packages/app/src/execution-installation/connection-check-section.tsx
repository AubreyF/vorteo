import React, { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import {
  checkInstallationConnection,
  connectionSessionDescription,
  installationConnectionTargets,
  type ConnectionCheckResult,
  type ConnectionSession,
} from "./connection-check";

interface CheckedConnection extends ConnectionCheckResult {
  session: ConnectionSession | null;
}
/** Independent of owner unlock and daemon availability, so diagnostics survive a failed connection. */
export function InstallationConnectionCheckSection({
  installation,
  sessionFor,
}: {
  installation: ExecutionInstallation;
  sessionFor: (serverId: string) => ConnectionSession;
}) {
  const [results, setResults] = useState<CheckedConnection[]>([]);
  const [checking, setChecking] = useState(false);
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
    try {
      await Promise.all(
        installationConnectionTargets(installation).map(async (target) => {
          const result = await checkInstallationConnection(target, { signal: controller.signal });
          if (generation.current !== request) return;
          const session = target.serverId ? sessionFor(target.serverId) : null;
          setResults((previous) => [...previous, { ...result, session }]);
        }),
      );
    } finally {
      if (generation.current === request) {
        inFlight.current = null;
        setChecking(false);
      }
    }
  }, [installation, sessionFor]);
  const targets = installationConnectionTargets(installation);
  return (
    <SettingsSection
      title="Connection check"
      testID="installation-connection-check"
      status={checking ? "Checking this device..." : null}
      info="Tests this device's route to the installation, Host and Dev. Network reachability and authenticated app connections are reported separately."
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
                  </>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </SettingsSection>
  );
}
function connectionBadge(result: ConnectionCheckResult | undefined, checking: boolean) {
  if (result?.state === "reachable") return { label: "Reached", variant: "success" as const };
  if (result) return { label: "Failed", variant: "error" as const };
  return { label: checking ? "Checking" : "Not checked", variant: "muted" as const };
}

const styles = StyleSheet.create((theme) => ({
  result: { flex: 1, minWidth: 0 },
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
