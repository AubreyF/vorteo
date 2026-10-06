import { ProviderLoginPanel } from "./login-panel";
import { useCallback, useMemo, useState } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { AlertTriangle } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { CompactAccountButton } from "./compact-account-button";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { accountProviderKind, providerConnectionAction } from "./connection-action";
import { providerUsageQueryKey } from "./use-provider-usage";
import { retainLastKnownUsage } from "./usage-cache";
import type { ProviderUsage, ProviderUsageListPayload } from "./types";

import type { Theme } from "@/styles/theme";

const warningPalette = (theme: Theme) => ({ color: theme.colors.destructive });
const Warning = withUnistyles(AlertTriangle);
export function AccountDisconnectedIcon({ size = 18 }: { size?: number }) {
  return <Warning size={size} uniProps={warningPalette} />;
}
const reconnectIcon = <AccountDisconnectedIcon size={16} />;

type CheckState = { kind: "idle" } | { kind: "pending" } | { kind: "result"; message: string };

export function ProviderReconnectControl({
  usage,
  serverId,
  name,
  providerId = usage?.providerId ?? "",
}: {
  usage: ProviderUsage | undefined;
  serverId: string | null;
  name: string;
  providerId?: string;
}) {
  const { config } = useDaemonConfig(serverId);
  const claude = accountProviderKind(providerId, config?.providers) === "claude";
  const action = providerConnectionAction({
    providerId,
    providers: config?.providers,
    usage,
  });
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const cache = useQueryClient();
  const [recovery, setRecovery] = useState<NonNullable<ProviderUsage["authRecovery"]> | null>(null);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const header = useMemo(() => ({ title: `${action ?? "Connect"} ${name}` }), [action, name]);
  const pending = check.kind === "pending";
  const checkConnection = useCallback(async () => {
    if (!client || !connected || !usage || pending) return;
    setCheck({ kind: "pending" });
    try {
      const payload = await client.listProviderUsage({ forceRefresh: true });
      const account = payload.providers.find((entry) => entry.providerId === usage.providerId);
      const key = providerUsageQueryKey(serverId);
      cache.setQueryData(
        key,
        retainLastKnownUsage(payload, cache.getQueryData<ProviderUsageListPayload>(key)),
      );
      let message = "Connection could not be verified. Try again shortly.";
      if (account?.authRecovery)
        message = "The account still needs sign-in. Complete the steps above, then try again.";
      else if (account?.status === "available")
        message = "Account connected. Usage is available again.";
      setCheck({ kind: "result", message });
    } catch {
      setCheck({
        kind: "result",
        message: "Connection check failed. Check the host connection and try again.",
      });
    }
  }, [client, connected, usage, pending, cache, serverId]);
  const open = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      setRecovery(usage?.authRecovery ?? { method: "device_code", instructions: "" });
      setCheck({ kind: "idle" });
    },
    [usage?.authRecovery],
  );
  const close = useCallback(() => setRecovery(null), []);

  return (
    <>
      {action ? (
        <CompactAccountButton
          tone="danger"
          leftIcon={action === "Reconnect" ? reconnectIcon : undefined}
          accessibilityLabel={`${name}: ${action} account`}
          testID={`provider-${action.toLowerCase()}-${providerId}`}
          onPress={open}
        >
          {action}
        </CompactAccountButton>
      ) : null}
      {recovery !== null ? (
        <AdaptiveModalSheet
          visible
          header={header}
          onClose={close}
          desktopMaxWidth={560}
          testID="provider-reconnect-dialog"
        >
          <View style={styles.body}>
            {recovery.method === "device_code" || claude ? (
              <ProviderLoginPanel
                serverId={serverId}
                providerId={providerId}
                name={name}
                provider={claude ? "claude" : "codex"}
              />
            ) : (
              <>
                <Text style={styles.text}>
                  The provider rejected this account’s authentication.
                </Text>
                <Text selectable style={styles.text}>
                  {recovery.instructions}
                </Text>
                {!connected ? (
                  <Text style={styles.warning}>
                    Reconnect to the host before checking this account.
                  </Text>
                ) : null}
                {check.kind === "result" ? (
                  <Text accessibilityLiveRegion="polite" style={styles.text}>
                    {check.message}
                  </Text>
                ) : null}
                <Button
                  variant="outline"
                  loading={pending}
                  disabled={pending || !connected}
                  onPress={checkConnection}
                >
                  {pending ? "Checking connection" : "Check connection"}
                </Button>
              </>
            )}
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}
const styles = StyleSheet.create((theme) => ({
  warning: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  body: { padding: theme.spacing[4], gap: theme.spacing[4] },
}));
