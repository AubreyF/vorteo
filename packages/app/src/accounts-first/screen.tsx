import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { VorteoLogo } from "@/components/icons/paseo-logo";
import { ClaudeIcon as ClaudeMark } from "@/components/icons/claude-icon";
import { CodexIcon as CodexMark } from "@/components/icons/codex-icon";
import { Button } from "@/components/ui/button";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { useInstallationSettings } from "@/execution-installation/settings";
import { useInstallationName } from "@/execution-installation/installation-name";
import { AddClaudeAccountButton, AddCodexAccountButton } from "@/provider-usage/add-account";
import type { Theme } from "@/styles/theme";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { accountsFirstServerId, decideAccountsFirst, type AccountsFirstDecision } from "./model";
import { accountsFirstHydration, useAccountsFirstStore } from "./store";

const ClaudeIcon = withUnistyles(ClaudeMark);
const CodexIcon = withUnistyles(CodexMark);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });

/**
 * Whether the home screen should show the accounts first screen: an installation page whose
 * owner has not connected any account and has not skipped this screen on this device.
 */
export function useAccountsFirst() {
  const installation = readExecutionInstallation();
  const installationId = installation?.installationId ?? null;
  const serverKey = installation ? accountsFirstServerId(installation.environments) : null;
  const dismissed = useAccountsFirstStore((state) => state.dismissedInstallations);
  const dismissInstallation = useAccountsFirstStore((state) => state.dismiss);
  const hydrated = useSyncExternalStore(
    accountsFirstHydration.subscribe,
    accountsFirstHydration.get,
    accountsFirstHydration.get,
  );
  const [decision, setDecision] = useState<AccountsFirstDecision>("pending");
  const check =
    decision === "pending" &&
    hydrated &&
    installationId !== null &&
    !dismissed.includes(installationId);
  const settings = useInstallationSettings(check);
  let settingsState: Parameters<typeof decideAccountsFirst>[0]["settings"] = { status: "loading" };
  if (settings.isError) settingsState = { status: "error" };
  else if (settings.data)
    settingsState = { status: "ready", definitions: settings.data.settings?.providerDefinitions };
  const next = decideAccountsFirst({
    previous: decision,
    installationId,
    hydrated,
    dismissed,
    settings: settingsState,
  });
  useEffect(() => {
    if (next !== decision) setDecision(next);
  }, [next, decision]);
  const dismiss = useCallback(() => {
    if (installationId) dismissInstallation(installationId);
  }, [installationId, dismissInstallation]);
  return { visible: next === "show" && serverKey !== null, serverId: serverKey, dismiss };
}

/** The home screen, or the accounts first screen in its place while it applies. */
export function AccountsFirstGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { visible, serverId, dismiss } = useAccountsFirst();
  const openAccounts = useCallback(() => {
    router.push(buildSettingsSectionRoute("accounts"));
  }, [router]);
  if (!visible || !serverId) return children;
  return <AccountsFirstScreen serverId={serverId} onDone={dismiss} onOpenAccounts={openAccounts} />;
}

export function AccountsFirstScreen({
  serverId,
  onDone,
  onOpenAccounts,
}: {
  serverId: string;
  onDone: () => void;
  onOpenAccounts: () => void;
}) {
  const installationName = useInstallationName();
  const [added, setAdded] = useState(false);
  const markAdded = useCallback(() => setAdded(true), []);
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      testID="accounts-first-screen"
    >
      <View style={styles.content}>
        <VorteoLogo size={64} />
        <View style={styles.copy}>
          <Text style={styles.title} accessibilityRole="header">
            Connect your AI accounts
          </Text>
          <Text style={styles.text}>
            {`Connect each account once for ${installationName}. Your agents in every environment can use it, and you can add more accounts later.`}
          </Text>
        </View>
        <View style={styles.list}>
          <View style={styles.row} testID="accounts-first-claude">
            <ClaudeIcon size={24} uniProps={foreground} />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Claude</Text>
              <Text style={styles.muted}>Sign in once. Host and Dev share the connection.</Text>
            </View>
            <AddClaudeAccountButton serverId={serverId} label="Connect" onCreated={markAdded} />
          </View>
          <View style={[styles.row, styles.rowDivider]} testID="accounts-first-codex">
            <CodexIcon size={24} uniProps={foreground} />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Codex (ChatGPT)</Text>
              <Text style={styles.muted}>
                Signs in on the Host. Dev still asks for its own sign-in in Accounts & profiles.
              </Text>
            </View>
            <AddCodexAccountButton serverId={serverId} label="Connect" onCreated={markAdded} />
          </View>
        </View>
        <View style={styles.footer}>
          <Button
            variant={added ? "default" : "ghost"}
            onPress={onDone}
            testID="accounts-first-done"
          >
            {added ? "Continue" : "Skip for now"}
          </Button>
          <Button variant="ghost" onPress={onOpenAccounts} testID="accounts-first-open-settings">
            Other providers
          </Button>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: { flex: 1 },
  container: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: { xs: "flex-start", md: "center" },
    padding: theme.spacing[6],
    paddingTop: { xs: theme.spacing[8], md: theme.spacing[6] },
  },
  content: {
    width: "100%",
    maxWidth: 520,
    alignItems: "center",
    gap: theme.spacing[6],
  },
  copy: { alignItems: "center", gap: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  list: {
    width: "100%",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    minHeight: 72,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  rowText: { flex: 1, gap: theme.spacing[1] },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
}));
