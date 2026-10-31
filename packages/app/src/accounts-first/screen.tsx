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
import {
  ACCOUNT_PROVIDER_LABELS,
  type ExistingConnection,
} from "@/provider-usage/existing-connection";
import { useInstallationConnectOnce } from "@/provider-usage/use-provider-login";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import type { Theme } from "@/styles/theme";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import {
  accountsFirstConnections,
  accountsFirstServerId,
  decideAccountsFirst,
  type AccountProvider,
  type AccountsFirstConnection,
  type AccountsFirstDecision,
} from "./model";
import { accountsFirstHydration, useAccountsFirstStore } from "./store";

const ClaudeIcon = withUnistyles(ClaudeMark);
const CodexIcon = withUnistyles(CodexMark);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });

// How long the first screen waits for the Host to connect before judging without its usage.
const HOST_USAGE_GRACE_MS = 5000;

type ConnectionsState = Parameters<typeof decideAccountsFirst>[0]["connections"];

function connectionsState(input: {
  settings: ReturnType<typeof useInstallationSettings>;
  usage: ReturnType<typeof useProviderUsage>;
  connectOnce: ReturnType<typeof useInstallationConnectOnce>;
  hostServerId: string | null;
  graceOver: boolean;
}): ConnectionsState {
  const { settings, usage, connectOnce } = input;
  if (settings.isError) return { status: "error" };
  if (!settings.data || !input.hostServerId) return { status: "loading" };
  if (connectOnce.claude === undefined || connectOnce.codex === undefined)
    return { status: "loading" };
  const ready = usage.view.kind === "ready";
  if (!ready && usage.canFetch && usage.view.kind === "loading") return { status: "loading" };
  // The Host runtime connects after the page loads; give it a moment before deciding.
  if (!ready && !usage.canFetch && !input.graceOver) return { status: "loading" };
  return {
    status: "ready",
    connections: accountsFirstConnections({
      definitions: settings.data.settings?.providerDefinitions,
      hostServerId: input.hostServerId,
      hostUsage: usage.view.kind === "ready" ? usage.view.payload.providers : undefined,
      connectOnce: { claude: connectOnce.claude, codex: connectOnce.codex },
    }),
  };
}

/**
 * Whether the home screen should show the accounts first screen: an installation page with an
 * enabled provider that is not connected yet, whose owner has not skipped this screen on this
 * device.
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
  // Keep reading while the screen shows, so a connection made in it appears as Connected.
  const check =
    decision !== "hide" &&
    hydrated &&
    installationId !== null &&
    !dismissed.includes(installationId);
  const settings = useInstallationSettings(check);
  const usage = useProviderUsage(serverKey, { enabled: check });
  const connectOnce = useInstallationConnectOnce(check);
  const [graceOver, setGraceOver] = useState(false);
  const waitingForHost = check && !usage.canFetch && !graceOver;
  useEffect(() => {
    if (!waitingForHost) return;
    const timer = setTimeout(() => setGraceOver(true), HOST_USAGE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [waitingForHost]);
  const connections = connectionsState({
    settings,
    usage,
    connectOnce,
    hostServerId: serverKey,
    graceOver,
  });
  const next = decideAccountsFirst({
    previous: decision,
    installationId,
    hydrated,
    dismissed,
    connections,
  });
  useEffect(() => {
    if (next !== decision) setDecision(next);
  }, [next, decision]);
  const dismiss = useCallback(() => {
    if (installationId) dismissInstallation(installationId);
  }, [installationId, dismissInstallation]);
  return {
    visible: next === "show" && serverKey !== null,
    serverId: serverKey,
    dismiss,
    connections: connections.status === "ready" ? connections.connections : NO_CONNECTIONS,
    codexConnectOnce: connectOnce.codex === true,
  };
}

const NO_CONNECTIONS: readonly AccountsFirstConnection[] = [];

/** The home screen, or the accounts first screen in its place while it applies. */
export function AccountsFirstGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { visible, serverId, dismiss, connections, codexConnectOnce } = useAccountsFirst();
  const openAccounts = useCallback(() => {
    router.push(buildSettingsSectionRoute("accounts"));
  }, [router]);
  if (!visible || !serverId) return children;
  return (
    <AccountsFirstScreen
      serverId={serverId}
      connections={connections}
      codexConnectOnce={codexConnectOnce}
      onDone={dismiss}
      onOpenAccounts={openAccounts}
    />
  );
}

const SHARED_SIGN_IN = "Sign in once. Host and Dev share the connection.";
// Only while `codexHostRefresh` is off: Codex accounts then keep one sign-in per environment.
const CODEX_PER_ENVIRONMENT =
  "Signs in on the Host. Dev needs its own sign-in until one-time Codex sign-in is on.";

/** "Connected as Claude 1." or the Host's own CLI sign-in with its plan. */
export function connectedText(provider: AccountProvider, connection: ExistingConnection): string {
  if (!connection.isDefault) return `Connected as ${connection.name}.`;
  const plan = connection.plan ? `, ${connection.plan} plan` : "";
  return `Connected through the Host's ${ACCOUNT_PROVIDER_LABELS[provider]} sign-in${plan}.`;
}

function ProviderRow({
  entry,
  serverId,
  codexConnectOnce,
  divider,
  onCreated,
}: {
  entry: AccountsFirstConnection;
  serverId: string;
  codexConnectOnce: boolean;
  divider: boolean;
  onCreated: () => void;
}) {
  const claude = entry.provider === "claude";
  const AddButton = claude ? AddClaudeAccountButton : AddCodexAccountButton;
  let detail = claude || codexConnectOnce ? SHARED_SIGN_IN : CODEX_PER_ENVIRONMENT;
  if (entry.connection) detail = connectedText(entry.provider, entry.connection);
  return (
    <View
      style={divider ? styles.rowWithDivider : styles.row}
      testID={`accounts-first-${entry.provider}`}
    >
      {claude ? (
        <ClaudeIcon size={24} uniProps={foreground} />
      ) : (
        <CodexIcon size={24} uniProps={foreground} />
      )}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{claude ? "Claude" : "Codex (ChatGPT)"}</Text>
        <Text style={styles.muted} testID={`accounts-first-${entry.provider}-status`}>
          {detail}
        </Text>
      </View>
      <AddButton
        serverId={serverId}
        label={entry.connection ? "Add another" : "Connect"}
        onCreated={onCreated}
      />
    </View>
  );
}

export function AccountsFirstScreen({
  serverId,
  connections,
  codexConnectOnce,
  onDone,
  onOpenAccounts,
}: {
  serverId: string;
  connections: readonly AccountsFirstConnection[];
  codexConnectOnce: boolean;
  onDone: () => void;
  onOpenAccounts: () => void;
}) {
  const installationName = useInstallationName();
  const [added, setAdded] = useState(false);
  const markAdded = useCallback(() => setAdded(true), []);
  const shown = connections.filter((entry) => entry.enabled);
  const anyConnected = added || shown.some((entry) => entry.connection !== null);
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
          {shown.map((entry, index) => (
            <ProviderRow
              key={entry.provider}
              entry={entry}
              serverId={serverId}
              codexConnectOnce={codexConnectOnce}
              divider={index > 0}
              onCreated={markAdded}
            />
          ))}
        </View>
        <View style={styles.footer}>
          <Button
            variant={anyConnected ? "default" : "ghost"}
            onPress={onDone}
            testID="accounts-first-done"
          >
            {anyConnected ? "Continue" : "Skip for now"}
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
  rowWithDivider: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    minHeight: 72,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
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
