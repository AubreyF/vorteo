/**
 * One provider's page under Accounts & profiles.
 *
 * A connection belongs to the installation, not to an environment: rows show
 * one combined status ("Ready everywhere") and environments only appear when
 * something differs or the owner opens Environment access. Profiles and model
 * defaults for the provider sit below its connections, and removing the
 * provider is a quiet row at the bottom of the page.
 */
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react-native";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type {
  InstallationSettings,
  InstallationSettingsSnapshot,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import { SharedProviderSection } from "@/agent-profiles/settings/shared-provider-section";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { selectProfileCatalogSources } from "@/execution-installation/profile-catalog";
import { readExecutionInstallation } from "@/execution-installation/policy";
import {
  requestInstallationSettings,
  useInstallationSettings,
} from "@/execution-installation/settings";
import { InstallationSettingsStatus } from "@/execution-installation/settings-status";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { ProviderLoginPanel } from "@/provider-usage/login-panel";
import { ProviderReconnectControl } from "@/provider-usage/reconnect-control";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import {
  describeSecretDelivery,
  useProviderSecrets,
} from "@/execution-installation/provider-secrets";
import type { ProviderSecretsStatus } from "@getpaseo/protocol/provider-secrets";
import { SettingsInput } from "@/components/settings";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { returnFromSettings } from "@/navigation/settings-navigation";
import { ProvidersSection } from "./providers-section";
import {
  classifyEnvironment,
  describeConnectionStatus,
  environmentLabel,
  type EnvironmentState,
} from "./provider-connection-status";
import {
  groupInstallationProviders,
  type ProviderAccount,
  type ProviderFamily,
} from "./shared-providers-model";

const ThemedMore = withUnistyles(MoreHorizontal);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColor = (theme: Theme) => ({ color: theme.colors.foreground });

export function providerTypeLabel(type: string): string {
  return AGENT_PROVIDER_DEFINITIONS.find((manifest) => manifest.id === type)?.label ?? type;
}

export function providerName(provider: InstallationProvider) {
  return provider.policy.label ?? providerTypeLabel(provider.providerType);
}

/** Removal needs every environment to understand shared removal before it is offered. */
export function useProviderRemovalCapability(environments: InstallationEnvironment[]) {
  const hostId = environments.find((environment) => environment.kind === "host")?.serverId ?? null;
  const devId =
    environments.find((environment) => environment.kind === "container")?.serverId ?? null;
  const hostRemoval = useHostFeature(hostId, "installationProviderRemoval");
  const devRemoval = useHostFeature(devId, "installationProviderRemoval");
  return hostRemoval && (!devId || devRemoval);
}

function isExcluded(settings: InstallationSettings, serverId: string, providerId: string) {
  return settings.resourceExclusions[serverId]?.providerIds?.includes(providerId) ?? false;
}

// ---------------------------------------------------------------------------
// Environment state for one connection
// ---------------------------------------------------------------------------

/**
 * One environment's view of a connection. Called once for Host and once for
 * the Dev container so hook order stays fixed; a missing environment reports
 * `none` and is left out of the combined status.
 */
function useEnvironmentState(
  provider: InstallationProvider,
  environment: InstallationEnvironment | undefined,
  settings: InstallationSettings,
): EnvironmentState | null {
  const serverId = environment?.serverId ?? null;
  const localId = serverId ? provider.bindings[serverId] : undefined;
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const catalog = useProvidersSnapshot(localId ? serverId : null);
  const { view } = useProviderUsage(serverId, { enabled: Boolean(localId && connected) });
  if (!environment) return null;
  const usage =
    view.kind === "ready"
      ? view.payload.providers.find((item) => item.providerId === localId)
      : undefined;
  const entry = catalog.entries?.find((item) => item.provider === localId);
  return {
    environment,
    usage,
    ...classifyEnvironment({
      bound: Boolean(localId),
      excluded: isExcluded(settings, environment.serverId, provider.id),
      connected,
      needsSignIn: Boolean(usage?.authRecovery),
      entry,
      settled: !catalog.isLoading && !catalog.isFetching,
    }),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ProviderDetailPage({ providerType }: { providerType: string }) {
  if (!readExecutionInstallation())
    return <Alert description="Provider pages need a configured installation." />;
  return (
    <View style={styles.page}>
      <InstallationSettingsStatus>
        <ProviderDetail providerType={providerType} />
      </InstallationSettingsStatus>
    </View>
  );
}

function ProviderDetail({ providerType }: { providerType: string }) {
  const { data, installation, save } = useInstallationSettings();
  const environments = useMemo(() => installation?.environments ?? [], [installation]);
  const change = useMutation({ mutationFn: save });
  const definitions = useMemo(
    () =>
      (change.isPending ? change.variables?.settings.providerDefinitions : undefined) ??
      data?.settings?.providerDefinitions ??
      null,
    [data, change.isPending, change.variables],
  );
  const family = useMemo(
    () => groupInstallationProviders(definitions ?? []).find((entry) => entry.id === providerType),
    [definitions, providerType],
  );
  const canRemove = useProviderRemovalCapability(environments);
  if (!data?.settings || !definitions)
    return <Alert description="Complete shared provider migration to manage this provider." />;
  if (!family) {
    const removed = groupInstallationProviders(definitions, "removed").some(
      (entry) => entry.id === providerType,
    );
    return (
      <Alert
        description={
          removed
            ? `${providerTypeLabel(providerType)} was removed. Restore it from Add provider in Accounts & profiles.`
            : `${providerTypeLabel(providerType)} is not in this installation. Add it from Accounts & profiles.`
        }
      />
    );
  }
  const snapshot = data as InstallationSettingsSnapshot & { settings: InstallationSettings };
  return (
    <>
      {change.isError ? <Alert variant="error" description={change.error.message} /> : null}
      <ProviderEnabledCard
        family={family}
        snapshot={snapshot}
        busy={change.isPending}
        save={change.mutate}
      />
      <ConnectionsSection
        family={family}
        snapshot={snapshot}
        environments={environments}
        busy={change.isPending}
        save={change.mutate}
        saveAsync={change.mutateAsync}
        saving={change.isPending}
      />
      <ProviderProfiles providerType={providerType} environments={environments} />
      {canRemove ? (
        <RemoveProviderRow
          family={family}
          snapshot={snapshot}
          busy={change.isPending}
          saveAsync={change.mutateAsync}
        />
      ) : null}
    </>
  );
}

function ProviderEnabledCard({
  family,
  snapshot,
  busy,
  save,
}: {
  family: ProviderFamily;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
}) {
  const toggle = useCallback(
    (enabled: boolean) =>
      save({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings.providerDefinitions?.map((entry) =>
            entry.providerType === family.id && !entry.removed
              ? { ...entry, policy: { ...entry.policy, enabled } }
              : entry,
          ),
        },
      }),
    [save, snapshot, family.id],
  );
  return (
    <View style={[settingsStyles.card, styles.firstCard]} testID="provider-detail-enabled">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Use {family.name}</Text>
          <Text style={settingsStyles.rowHint}>Available for new chats in every environment</Text>
        </View>
        <Switch
          value={family.enabled}
          onValueChange={toggle}
          disabled={busy}
          accessibilityLabel={`Enable ${family.name} everywhere`}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

type SettingsSave = ReturnType<typeof useInstallationSettings>["save"];

function ConnectionsSection({
  family,
  snapshot,
  environments,
  busy,
  save,
  saveAsync,
  saving,
}: {
  family: ProviderFamily;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  environments: InstallationEnvironment[];
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  saveAsync: SettingsSave;
  saving: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<ProviderAccount | null>(null);
  const [details, setDetails] = useState<ProviderAccount | null>(null);
  const [keys, setKeys] = useState<ProviderAccount | null>(null);
  const secrets = useProviderSecrets();
  const closeKeys = useCallback(() => setKeys(null), []);
  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const closeRename = useCallback(() => setRenaming(null), []);
  const closeDetails = useCallback(() => setDetails(null), []);
  const rename = useCallback(
    async (name: string) => {
      if (!renaming) return;
      const ids = new Set(renaming.definitions.map((entry) => entry.id));
      await saveAsync({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings.providerDefinitions?.map((provider) =>
            ids.has(provider.id)
              ? { ...provider, policy: { ...provider.policy, label: name.trim() } }
              : provider,
          ),
        },
      });
    },
    [renaming, saveAsync, snapshot],
  );
  const addButton = useMemo(
    () => (
      <Button variant="ghost" size="sm" onPress={openAdd} testID="provider-detail-add-connection">
        Add connection
      </Button>
    ),
    [openAdd],
  );
  // Details always reads the latest definitions, not the copy captured when opened.
  const currentDetails = details
    ? family.accounts.find((account) => account.id === details.id)
    : undefined;
  return (
    <SettingsSection
      title="Connections"
      trailing={addButton}
      status={saving ? "Saving..." : null}
      info="A connection works in every environment. Use Environment access only to keep it out of a specific environment."
      testID="provider-detail-connections"
    >
      <View style={settingsStyles.card}>
        {family.accounts.map((account, index) => (
          <ConnectionRow
            key={account.id}
            account={account}
            snapshot={snapshot}
            environments={environments}
            first={index === 0}
            busy={busy}
            save={save}
            onRename={setRenaming}
            onDetails={setDetails}
            onKeys={setKeys}
            secrets={secrets.byDefinition.get(primaryDefinition(account, environments).id)}
          />
        ))}
      </View>
      <AddConnectionSheet visible={adding} environments={environments} onClose={closeAdd} />
      {currentDetails ? (
        <EnvironmentAccessSheet
          account={currentDetails}
          snapshot={snapshot}
          environments={environments}
          busy={busy}
          save={save}
          onClose={closeDetails}
        />
      ) : null}
      {keys ? (
        <ApiKeysSheet
          name={keys.name}
          definitionId={primaryDefinition(keys, environments).id}
          status={secrets.byDefinition.get(primaryDefinition(keys, environments).id)}
          environments={environments}
          setSecret={secrets.setSecret}
          clearSecret={secrets.clearSecret}
          onClose={closeKeys}
        />
      ) : null}
      {renaming ? (
        <AdaptiveRenameModal
          key={renaming.id}
          visible
          title="Rename connection"
          initialValue={renaming.name}
          onClose={closeRename}
          onSubmit={rename}
          testID="shared-provider-rename-dialog"
        />
      ) : null}
    </SettingsSection>
  );
}

function primaryDefinition(account: ProviderAccount, environments: InstallationEnvironment[]) {
  const host = environments.find((environment) => environment.kind === "host");
  return (
    (host && account.definitions.find((entry) => entry.bindings[host.serverId])) ??
    account.definitions[0]!
  );
}

function ConnectionRow({
  account,
  snapshot,
  environments,
  first,
  busy,
  save,
  onRename,
  onDetails,
  onKeys,
  secrets,
}: {
  account: ProviderAccount;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  environments: InstallationEnvironment[];
  first: boolean;
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  onRename(account: ProviderAccount): void;
  onDetails(account: ProviderAccount): void;
  onKeys(account: ProviderAccount): void;
  secrets: ProviderSecretsStatus | undefined;
}) {
  const provider = primaryDefinition(account, environments);
  const host = environments.find((environment) => environment.kind === "host");
  const dev = environments.find((environment) => environment.kind === "container");
  const hostState = useEnvironmentState(provider, host, snapshot.settings);
  const devState = useEnvironmentState(provider, dev, snapshot.settings);
  const states = [hostState, devState].filter((state): state is EnvironmentState => !!state);
  const status = describeConnectionStatus(states);
  const usage = states.find((state) => state.kind === "ready" && state.usage)?.usage;
  const error = states.find((state) => state.error)?.error ?? null;
  const name = account.name === "Default connection" ? providerName(provider) : account.name;
  // Sign-ins run on Host; the Dev container receives access from there.
  const signInEnvironment =
    host && provider.bindings[host.serverId] ? host : states[0]?.environment;
  const signInId = signInEnvironment ? provider.bindings[signInEnvironment.serverId] : undefined;
  const signInUsage = states.find((state) => state.environment === signInEnvironment)?.usage;
  const open = useProviderSettingsStore((state) => state.open);
  const showModels = useCallback(() => {
    if (signInEnvironment && signInId)
      open({ serverId: signInEnvironment.serverId, provider: signInId });
  }, [open, signInEnvironment, signInId]);
  const rename = useCallback(() => onRename(account), [onRename, account]);
  const details = useCallback(() => onDetails(account), [onDetails, account]);
  const keys = useCallback(() => onKeys(account), [onKeys, account]);

  const toggle = useCallback(
    (enabled: boolean) => {
      const ids = new Set(account.definitions.map((entry) => entry.id));
      save({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings.providerDefinitions?.map((entry) =>
            ids.has(entry.id) ? { ...entry, policy: { ...entry.policy, enabled } } : entry,
          ),
        },
      });
    },
    [account, snapshot, save],
  );
  const attention = states.some((state) => state.kind === "attention" || state.kind === "offline");
  return (
    <View
      style={[settingsStyles.row, !first && settingsStyles.rowBorder, styles.connection]}
      testID={`provider-account-${account.id}`}
    >
      <View style={styles.connectionHeading}>
        <ConnectionStatusLines
          accountId={account.id}
          name={name}
          status={status}
          attention={attention}
          error={error}
          secrets={secrets}
          states={states}
        />
        <View style={styles.controls}>
          {signInEnvironment && signInId ? (
            <ProviderReconnectControl
              serverId={signInEnvironment.serverId}
              providerId={signInId}
              name={name}
              usage={signInUsage}
            />
          ) : null}
          <Switch
            value={account.enabled}
            onValueChange={toggle}
            disabled={busy}
            accessibilityLabel={`Enable ${name}`}
          />
          <ConnectionMenu
            name={name}
            accountId={account.id}
            onModels={signInId ? showModels : undefined}
            onRename={rename}
            onDetails={details}
            onKeys={keys}
          />
        </View>
      </View>
      {usage?.windows.length ? (
        <View style={styles.usage} testID={`provider-connection-usage-${account.id}`}>
          {usage.windows.map((window) => (
            <ProviderUsageWindowBar key={window.id} window={window} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Environments a Codex-style sign-in still has to reach, read from the coordinator's hint. */
function pendingSignIns(
  secrets: ProviderSecretsStatus | undefined,
  states: readonly EnvironmentState[],
): string[] {
  return (secrets?.accountSignIn?.environments ?? [])
    .filter((environment) =>
      states.some(
        (state) =>
          state.environment.serverId === environment.serverId &&
          (state.kind === "attention" || state.kind === "none"),
      ),
    )
    .map((environment) => `Sign in on ${environment.label}`);
}

function ConnectionStatusLines({
  accountId,
  name,
  status,
  attention,
  error,
  secrets,
  states,
}: {
  accountId: string;
  name: string;
  status: string;
  attention: boolean;
  error: string | null;
  secrets: ProviderSecretsStatus | undefined;
  states: readonly EnvironmentState[];
}) {
  const delivery = describeSecretDelivery(secrets);
  const signIns = pendingSignIns(secrets, states);
  return (
    <View style={settingsStyles.rowContent}>
      <Text style={settingsStyles.rowTitle}>{name}</Text>
      <Text
        style={attention ? settingsStyles.rowError : settingsStyles.rowHint}
        testID={`provider-connection-status-${accountId}`}
      >
        {status}
      </Text>
      {error ? (
        <Text style={settingsStyles.rowHint} numberOfLines={2}>
          {error}
        </Text>
      ) : null}
      {delivery ? (
        <Text style={settingsStyles.rowHint} testID={`provider-connection-keys-${accountId}`}>
          {delivery}
        </Text>
      ) : null}
      {signIns.length ? (
        <Text style={settingsStyles.rowHint}>
          {`${signIns.join(" · ")}. Codex keeps a separate sign-in in each environment.`}
        </Text>
      ) : null}
    </View>
  );
}

function ConnectionMenu({
  name,
  accountId,
  onModels,
  onRename,
  onDetails,
  onKeys,
}: {
  name: string;
  accountId: string;
  onModels?: () => void;
  onRename(): void;
  onDetails(): void;
  onKeys(): void;
}) {
  const triggerStyle = useCallback(
    ({ hovered, open }: PressableStateCallbackType & { hovered?: boolean; open?: boolean }) => [
      styles.menuButton,
      (hovered || open) && styles.menuButtonHovered,
    ],
    [],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={`${name} actions`}
        testID={`provider-connection-menu-${accountId}`}
      >
        {({ hovered, open }) => (
          <ThemedMore size={16} uniProps={hovered || open ? foregroundColor : mutedColor} />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        {onModels ? (
          <DropdownMenuItem onSelect={onModels} testID={`provider-connection-models-${accountId}`}>
            Models
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onKeys} testID={`provider-connection-keys-menu-${accountId}`}>
          API keys
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename} testID={`provider-connection-rename-${accountId}`}>
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDetails} testID={`provider-connection-access-${accountId}`}>
          Environment access
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Sign-ins and runtime installs happen on Host unless the owner picks the Dev container. */
function AddConnectionSheet({
  visible,
  environments,
  onClose,
}: {
  visible: boolean;
  environments: InstallationEnvironment[];
  onClose(): void;
}) {
  const host = environments.find((environment) => environment.kind === "host");
  const dev = environments.find((environment) => environment.kind === "container");
  const [useDev, setUseDev] = useState(false);
  const target = (useDev ? dev : host) ?? host ?? dev;
  const other = target === host ? dev : host;
  const switchTarget = useCallback(() => setUseDev((value) => !value), []);
  const header = useMemo(() => ({ title: "Add connection" }), []);
  return (
    <AdaptiveModalSheet
      testID="provider-add-connection-sheet"
      visible={visible}
      onClose={onClose}
      header={header}
    >
      <Text style={settingsStyles.rowHint}>
        Sign in once. Vorteo shares the connection with every environment.
      </Text>
      {target ? <ProvidersSection serverId={target.serverId} runtimeOnly /> : null}
      {other ? (
        <Button variant="ghost" size="sm" onPress={switchTarget}>
          {`Install in ${environmentLabel(other)} instead`}
        </Button>
      ) : null}
    </AdaptiveModalSheet>
  );
}

// ---------------------------------------------------------------------------
// API keys, stored once by the coordinator and delivered everywhere
// ---------------------------------------------------------------------------

const SECRET_STATUS_LABEL = {
  delivered: "Has the current keys",
  pending: "Receiving keys",
  failed: "Not delivered",
  excluded: "Off here",
} as const;

function ApiKeysSheet({
  name,
  definitionId,
  status,
  environments,
  setSecret,
  clearSecret,
  onClose,
}: {
  name: string;
  definitionId: string;
  status: ProviderSecretsStatus | undefined;
  environments: InstallationEnvironment[];
  setSecret(definitionId: string, name: string, value: string): Promise<void>;
  clearSecret(definitionId: string, name: string): Promise<void>;
  onClose(): void;
}) {
  const header = useMemo(() => ({ title: `${name}: API keys` }), [name]);
  const [keyName, setKeyName] = useState(status?.secrets[0]?.name ?? "");
  const [value, setValue] = useState("");
  const [formKey, setFormKey] = useState(0);
  const saving = useMutation({
    mutationFn: () => setSecret(definitionId, keyName.trim(), value),
    onSuccess: () => {
      setValue("");
      setFormKey((key) => key + 1);
    },
  });
  const clearing = useMutation({
    mutationFn: (secretName: string) => clearSecret(definitionId, secretName),
  });
  const save = useCallback(() => saving.mutate(), [saving]);
  const error = saving.error ?? clearing.error;
  const labelFor = (serverId: string) => {
    const environment = environments.find((entry) => entry.serverId === serverId);
    return environment ? environmentLabel(environment) : serverId;
  };
  return (
    <AdaptiveModalSheet testID="provider-keys-sheet" visible onClose={onClose} header={header}>
      <Text style={settingsStyles.rowHint}>
        Save a key once. Vorteo stores it on Host and delivers it to every environment within a few
        seconds. Saved values are never shown again.
      </Text>
      {error ? <Alert variant="error" description={error.message} /> : null}
      {status?.conflicts.map((conflict) => (
        <Alert
          key={conflict.name}
          description={`${conflict.name} has different values in ${conflict.serverIds.map(labelFor).join(" and ")}. Set it here to use one value everywhere.`}
        />
      ))}
      {status?.secrets.length ? (
        <View style={settingsStyles.card}>
          {status.secrets.map((secret, index) => (
            <SecretRow
              key={secret.name}
              name={secret.name}
              detail={`${secret.last4 ? `Ends in ${secret.last4} · ` : ""}${secret.source === "imported" ? "Imported" : "Saved"} ${new Date(secret.updatedAt).toLocaleString()}`}
              first={index === 0}
              busy={clearing.isPending}
              onClear={clearing.mutate}
            />
          ))}
        </View>
      ) : null}
      <View style={settingsStyles.card} key={formKey}>
        <SettingsInput
          label="Key name"
          hint="Environment variable, ending in _KEY, _TOKEN, _SECRET or _PASSWORD"
          initialValue={keyName}
          onChangeText={setKeyName}
          placeholder="ZAI_API_KEY"
        />
        <SettingsInput
          label="Value"
          initialValue=""
          onChangeText={setValue}
          placeholder="Paste the key"
          secureTextEntry
        />
      </View>
      <Button
        onPress={save}
        disabled={saving.isPending || !keyName.trim() || !value}
        testID="provider-keys-save"
      >
        {saving.isPending ? "Saving" : "Save key"}
      </Button>
      {status?.environments.length ? (
        <View style={settingsStyles.card}>
          {status.environments.map((environment, index) => (
            <View
              key={environment.serverId}
              style={[settingsStyles.row, index > 0 && settingsStyles.rowBorder]}
            >
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>{labelFor(environment.serverId)}</Text>
                <Text
                  style={
                    environment.status === "failed"
                      ? settingsStyles.rowError
                      : settingsStyles.rowHint
                  }
                >
                  {environment.message ?? SECRET_STATUS_LABEL[environment.status]}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function SecretRow({
  name,
  detail,
  first,
  busy,
  onClear,
}: {
  name: string;
  detail: string;
  first: boolean;
  busy: boolean;
  onClear(name: string): void;
}) {
  const clear = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: `Remove ${name}?`,
      message: "Vorteo removes this key from every environment it delivered it to.",
      confirmLabel: "Remove key",
      destructive: true,
    });
    if (confirmed) onClear(name);
  }, [name, onClear]);
  const onPress = useCallback(() => {
    void clear();
  }, [clear]);
  return (
    <View style={[settingsStyles.row, !first && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{name}</Text>
        <Text style={settingsStyles.rowHint}>{detail}</Text>
      </View>
      <Button variant="ghost" size="sm" onPress={onPress} disabled={busy}>
        Remove
      </Button>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Environment access (the rare per-environment view)
// ---------------------------------------------------------------------------

function EnvironmentAccessSheet({
  account,
  snapshot,
  environments,
  busy,
  save,
  onClose,
}: {
  account: ProviderAccount;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  environments: InstallationEnvironment[];
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  onClose(): void;
}) {
  const provider = primaryDefinition(account, environments);
  const header = useMemo(() => ({ title: `${account.name}: environment access` }), [account.name]);
  const host = environments.find((environment) => environment.kind === "host");
  const claudeHost =
    provider.providerType === "claude" && host && provider.bindings[host.serverId] ? host : null;
  return (
    <AdaptiveModalSheet testID="provider-manage-sheet" visible onClose={onClose} header={header}>
      <Text style={settingsStyles.rowHint}>
        Connections are shared by every environment. Turn one off here only when an environment must
        not use it.
      </Text>
      {claudeHost ? (
        <ProviderLoginPanel
          serverId={claudeHost.serverId}
          providerId={provider.bindings[claudeHost.serverId]!}
          name={providerName(provider)}
          provider="claude"
        />
      ) : null}
      <View style={settingsStyles.card}>
        {environments.map((environment, index) => (
          <EnvironmentAccessRow
            key={environment.serverId}
            provider={provider}
            environment={environment}
            snapshot={snapshot}
            first={index === 0}
            busy={busy}
            save={save}
          />
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}

function EnvironmentAccessRow({
  provider,
  environment,
  snapshot,
  first,
  busy,
  save,
}: {
  provider: InstallationProvider;
  environment: InstallationEnvironment;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  first: boolean;
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
}) {
  const state = useEnvironmentState(provider, environment, snapshot.settings);
  const localId = provider.bindings[environment.serverId];
  const excluded = isExcluded(snapshot.settings, environment.serverId, provider.id);
  const catalog = useProvidersSnapshot(localId ? environment.serverId : null);
  const entry = catalog.entries?.find((item) => item.provider === localId);
  const location = environmentLabel(environment);
  const toggle = useCallback(
    (included: boolean) => {
      const settings = snapshot.settings;
      const previous = settings.resourceExclusions[environment.serverId];
      const ids = new Set(previous?.providerIds ?? []);
      if (included) ids.delete(provider.id);
      else ids.add(provider.id);
      save({
        expectedRevision: snapshot.revision,
        settings: {
          resourceExclusions: {
            ...settings.resourceExclusions,
            [environment.serverId]: {
              ...previous,
              terminalProfileIds: previous?.terminalProfileIds ?? [],
              metadataProviderIds: previous?.metadataProviderIds ?? [],
              providerIds: [...ids],
            },
          },
        },
      });
    },
    [snapshot, environment.serverId, provider.id, save],
  );
  return (
    <View
      style={[settingsStyles.row, !first && settingsStyles.rowBorder, styles.connection]}
      testID={`shared-provider-environment-${provider.id}-${environment.serverId}`}
    >
      <View style={styles.connectionHeading}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{location}</Text>
          <Text style={settingsStyles.rowHint}>{state?.label ?? "Checking"}</Text>
          {state?.error && !excluded ? (
            <Text style={settingsStyles.rowHint} numberOfLines={3}>
              {state.error}
            </Text>
          ) : null}
        </View>
        <View style={styles.controls}>
          {localId ? (
            <ProviderReconnectControl
              serverId={environment.serverId}
              providerId={localId}
              name={providerName(provider)}
              usage={state?.usage}
            />
          ) : null}
          <Switch
            value={!excluded}
            onValueChange={toggle}
            disabled={busy || !localId}
            accessibilityLabel={`Use ${providerName(provider)} in ${location}`}
          />
        </View>
      </View>
      {localId ? (
        <ProviderConnectionActions
          provider={provider}
          environment={environment}
          name={providerName(provider)}
          canRemove={entry?.source === "custom"}
        />
      ) : null}
    </View>
  );
}

function ProviderConnectionActions({
  provider,
  environment,
  name,
  canRemove,
}: {
  provider: InstallationProvider;
  environment: InstallationEnvironment;
  name: string;
  canRemove: boolean;
}) {
  const client = useHostRuntimeClient(environment.serverId);
  const connected = useHostRuntimeIsConnected(environment.serverId);
  const supported = useHostFeature(environment.serverId, "providerCredentialRemoval");
  const { save } = useInstallationSettings();
  const location = environmentLabel(environment);
  const { config } = useDaemonConfig(environment.serverId);
  const retainedId = provider.bindings[environment.serverId];
  const removed = config?.providers[retainedId]?.removed === true;
  const restoration = useMutation({
    mutationFn: async () => {
      if (!client || !connected) throw new Error(`Reconnect to ${location} and try again.`);
      await client.patchDaemonConfig({
        providers: { [retainedId]: { removed: false, enabled: false } },
      });
    },
  });
  const { mutate: restoreBinding } = restoration;
  const restore = useCallback(() => restoreBinding(), [restoreBinding]);
  const removal = useMutation({
    mutationFn: async () => {
      if (!client || !connected) throw new Error(`Reconnect to ${location} and try again.`);
      const snapshot = await requestInstallationSettings();
      const settings = snapshot.settings;
      const definition = settings?.providerDefinitions?.find((entry) => entry.id === provider.id);
      const localId = definition?.bindings[environment.serverId];
      if (!settings || !localId)
        throw new Error("This connection changed. Reload Settings before removing it.");
      const { plan } = await client.previewProviderRemoval(localId);
      let credentials = "Credentials stored by an external CLI will remain.";
      if (plan.credentials === "managed")
        credentials =
          "Its managed account directory, including credentials stored there, will be permanently deleted. Local connection settings remain for recovery.";
      else if (plan.credentials === "shared")
        credentials = `Credentials shared with ${plan.sharedWith.join(", ")} will remain.`;
      const confirmed = await confirmDialog({
        title: `Remove ${name} from ${location}?`,
        message: `${credentials} The connection stays available in other environments. It will be turned off in ${location}.`,
        confirmLabel: "Remove connection",
        destructive: true,
      });
      if (!confirmed) return;
      restoration.reset();
      const previous = settings.resourceExclusions[environment.serverId];
      await save({
        expectedRevision: snapshot.revision,
        settings: {
          resourceExclusions: {
            ...settings.resourceExclusions,
            [environment.serverId]: {
              ...previous,
              terminalProfileIds: previous?.terminalProfileIds ?? [],
              metadataProviderIds: previous?.metadataProviderIds ?? [],
              providerIds: [...new Set([...(previous?.providerIds ?? []), provider.id])],
            },
          },
        },
      });
      await client.removeProvider(localId, plan.revision);
    },
  });
  const { mutate } = removal;
  const remove = useCallback(() => mutate(), [mutate]);
  const error = removal.error ?? restoration.error;
  if (!canRemove && !removed && !error && !restoration.isSuccess) return null;
  return (
    <View style={styles.removal}>
      {removed && supported ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={!connected || restoration.isPending}
          onPress={restore}
          testID={`shared-provider-restore-${provider.id}-${environment.serverId}`}
        >
          {restoration.isPending ? "Restoring" : `Restore in ${location}`}
        </Button>
      ) : null}
      {restoration.isSuccess ? (
        <Text style={settingsStyles.rowHint}>
          Connection restored. Sign in if needed, then turn it back on above.
        </Text>
      ) : null}
      {canRemove && supported ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={!connected || removal.isPending}
          onPress={remove}
          testID={`shared-provider-remove-${provider.id}-${environment.serverId}`}
        >
          {removal.isPending ? "Removing" : `Remove from ${location}`}
        </Button>
      ) : null}
      {error ? (
        <Alert
          variant="error"
          testID={`shared-provider-remove-error-${provider.id}-${environment.serverId}`}
          description={error.message}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Profiles, defaults and removal
// ---------------------------------------------------------------------------

function ProviderProfiles({
  providerType,
  environments,
}: {
  providerType: string;
  environments: InstallationEnvironment[];
}) {
  const hostId = environments.find((environment) => environment.kind === "host")?.serverId ?? null;
  const devId =
    environments.find((environment) => environment.kind === "container")?.serverId ?? null;
  const hostCatalog = useProvidersSnapshot(hostId);
  const devCatalog = useProvidersSnapshot(devId);
  const { config: hostConfig } = useDaemonConfig(hostId);
  const { config: devConfig } = useDaemonConfig(devId);
  // Profiles read models from whichever environment has this provider ready.
  const target =
    selectProfileCatalogSources([
      { serverId: hostId, entries: hostCatalog.entries, providers: hostConfig?.providers },
      { serverId: devId, entries: devCatalog.entries, providers: devConfig?.providers },
    ]).get(providerType) ?? (hostId ? { serverId: hostId, provider: providerType } : null);
  if (!target) return null;
  return <SharedProviderSection serverId={target.serverId} provider={target.provider} />;
}

function RemoveProviderRow({
  family,
  snapshot,
  busy,
  saveAsync,
}: {
  family: ProviderFamily;
  snapshot: InstallationSettingsSnapshot & { settings: InstallationSettings };
  busy: boolean;
  saveAsync: SettingsSave;
}) {
  const remove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: `Remove ${family.name} from Vorteo?`,
      message: `${family.name} stops appearing for new chats in every environment. Saved profiles, credentials and chat history stay, and you can restore it from Add provider.`,
      confirmLabel: "Remove provider",
      destructive: true,
    });
    if (!confirmed) return;
    await saveAsync({
      expectedRevision: snapshot.revision,
      settings: {
        providerDefinitions: snapshot.settings.providerDefinitions?.map((entry) =>
          entry.providerType === family.id
            ? { ...entry, removed: true, policy: { ...entry.policy, enabled: false } }
            : entry,
        ),
      },
    });
    returnFromSettings({ kind: "provider", providerType: family.id });
  }, [family, snapshot, saveAsync]);
  const onPress = useCallback(() => {
    void remove();
  }, [remove]);
  const textStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.removeRow,
      hovered && styles.removeRowHovered,
    ],
    [],
  );
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      style={textStyle}
      testID={`provider-detail-remove-${family.id}`}
    >
      <Text style={styles.removeText}>{`Remove ${family.name} from Vorteo`}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { gap: theme.spacing[2] },
  firstCard: { marginBottom: theme.spacing[4] },
  connection: { flexDirection: "column", alignItems: "stretch", gap: theme.spacing[2] },
  connectionHeading: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  usage: { gap: theme.spacing[2] },
  removal: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  menuButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonHovered: { backgroundColor: theme.colors.surface2 },
  removeRow: {
    marginTop: theme.spacing[6],
    paddingVertical: theme.spacing[3],
    alignSelf: "flex-start",
    borderRadius: theme.borderRadius.md,
  },
  removeRowHovered: { opacity: 0.8 },
  removeText: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
