import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { GripVertical } from "lucide-react-native";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type {
  InstallationSettingsSnapshot,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  requestInstallationSettings,
  useInstallationSettings,
} from "@/execution-installation/settings";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { ProviderReconnectControl } from "@/provider-usage/reconnect-control";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { settingsStyles } from "@/styles/settings";
import { ProvidersSection } from "./providers-section";

const ThemedGrip = withUnistyles(GripVertical, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.foregroundMuted,
}));

interface RenameRequest {
  provider: InstallationProvider;
  snapshot: InstallationSettingsSnapshot;
}

function providerName(provider: InstallationProvider) {
  return (
    provider.policy.label ??
    AGENT_PROVIDER_DEFINITIONS.find((manifest) => manifest.id === provider.providerType)?.label ??
    provider.providerType
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
  const location = environment.kind === "host" ? "Host" : "Dev container";
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
        message: `${credentials} The shared profile and connections in other environments will remain. This provider will be excluded from ${location}.`,
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
          variant="outline"
          disabled={!connected || restoration.isPending}
          onPress={restore}
          testID={`shared-provider-restore-${provider.id}-${environment.serverId}`}
        >
          {restoration.isPending ? "Restoring" : "Restore connection"}
        </Button>
      ) : null}
      {restoration.isSuccess ? (
        <Text style={settingsStyles.rowHint}>
          Connection restored. Sign in if needed, then clear this environment’s exclusion to use it.
        </Text>
      ) : null}
      {canRemove && supported ? (
        <Button
          variant="outline"
          disabled={!connected || removal.isPending}
          onPress={remove}
          testID={`shared-provider-remove-${provider.id}-${environment.serverId}`}
        >
          {removal.isPending ? "Removing" : "Remove connection"}
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

function ProviderEnvironment({
  provider,
  environment,
  excluded,
}: {
  provider: InstallationProvider;
  environment: InstallationEnvironment;
  excluded: boolean;
}) {
  const localId = provider.bindings[environment.serverId];
  const connected = useHostRuntimeIsConnected(environment.serverId);
  const catalog = useProvidersSnapshot(environment.serverId);
  const { view } = useProviderUsage(environment.serverId, {
    enabled: Boolean(localId && connected),
  });
  const open = useProviderSettingsStore((state) => state.open);
  const showModels = useCallback(
    () => open({ serverId: environment.serverId, provider: localId }),
    [open, environment.serverId, localId],
  );
  const entry = catalog.entries?.find((item) => item.provider === localId);
  const usage =
    view.kind === "ready"
      ? view.payload.providers.find((item) => item.providerId === localId)
      : undefined;
  let status = entry?.status ?? "Loading";
  if (!localId) status = "No local binding";
  else if (!connected) status = "Offline";
  else if (excluded) status = "Excluded";
  else if (entry?.enabled === false) status = "Disabled";
  else if (!entry && !catalog.isLoading && !catalog.isFetching)
    status = "Local connection unavailable";
  const name = providerName(provider);
  return (
    <View
      style={styles.environment}
      testID={`shared-provider-environment-${provider.id}-${environment.serverId}`}
    >
      <View style={styles.content}>
        <Text style={settingsStyles.rowTitle}>
          {environment.kind === "host" ? "Host" : "Dev container"}
        </Text>
        <Text style={settingsStyles.rowHint}>{status}</Text>
        {entry?.error && !excluded ? (
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {entry.error}
          </Text>
        ) : null}
      </View>
      {entry ? (
        <View style={styles.controls}>
          <ProviderReconnectControl
            serverId={environment.serverId}
            providerId={localId}
            name={name}
            usage={usage}
          />
          <Button
            variant="outline"
            onPress={showModels}
            disabled={!connected}
            accessibilityLabel={`${name} provider details`}
            testID={`shared-provider-models-${provider.id}-${environment.serverId}`}
          >
            Models and profiles
          </Button>
        </View>
      ) : null}
      <ProviderConnectionActions
        provider={provider}
        environment={environment}
        name={name}
        canRemove={entry?.source === "custom"}
      />
    </View>
  );
}

function ProviderCard({
  item: provider,
  drag,
  dragHandleProps,
  snapshot,
  environments,
  busy,
  save,
  rename,
}: DraggableRenderItemInfo<InstallationProvider> & {
  snapshot: InstallationSettingsSnapshot;
  environments: InstallationEnvironment[];
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  rename(request: RenameRequest): void;
}) {
  const name = providerName(provider);
  const toggle = useCallback(
    (enabled: boolean) =>
      save({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings?.providerDefinitions?.map((entry) =>
            entry.id === provider.id ? { ...entry, policy: { ...entry.policy, enabled } } : entry,
          ),
        },
      }),
    [save, snapshot, provider.id],
  );
  const startRename = useCallback(
    () => rename({ provider, snapshot }),
    [rename, provider, snapshot],
  );
  return (
    <View style={[settingsStyles.card, styles.card]} testID={`shared-provider-${provider.id}`}>
      <View style={styles.heading}>
        <View
          {...dragHandleProps?.attributes}
          {...(!busy ? dragHandleProps?.listeners : undefined)}
          ref={dragHandleProps?.setActivatorNodeRef}
          testID={`shared-provider-drag-${provider.id}`}
        >
          <Pressable
            onLongPress={drag}
            disabled={busy}
            accessibilityLabel={`Reorder ${name}`}
            style={styles.dragHandle}
          >
            <ThemedGrip />
          </Pressable>
        </View>
        <View style={styles.content}>
          <Text style={settingsStyles.rowTitle}>{name}</Text>
          {provider.policy.description ? (
            <Text style={settingsStyles.rowHint}>{provider.policy.description}</Text>
          ) : null}
        </View>
        <View style={styles.controls}>
          <Button
            variant="outline"
            onPress={startRename}
            disabled={busy}
            testID={`shared-provider-rename-${provider.id}`}
          >
            Rename
          </Button>
          <Switch
            value={
              provider.policy.enabled ??
              AGENT_PROVIDER_DEFINITIONS.find((manifest) => manifest.id === provider.providerType)
                ?.enabledByDefault ??
              true
            }
            onValueChange={toggle}
            disabled={busy}
            accessibilityLabel={`Enable ${name} everywhere`}
            testID={`shared-provider-enabled-${provider.id}`}
          />
        </View>
      </View>
      {environments.map((environment) => (
        <ProviderEnvironment
          key={environment.serverId}
          provider={provider}
          environment={environment}
          excluded={
            snapshot.settings?.resourceExclusions[environment.serverId]?.providerIds?.includes(
              provider.id,
            ) ?? false
          }
        />
      ))}
    </View>
  );
}

function providerKey(provider: InstallationProvider) {
  return provider.id;
}

export function SharedProvidersPage() {
  const { data, installation, save } = useInstallationSettings();
  const [renaming, setRenaming] = useState<RenameRequest | null>(null);
  const [runtimeServerId, setRuntimeServerId] = useState<string | null>(null);
  const change = useMutation({ mutationFn: save });
  const definitions = useMemo(
    () =>
      [
        ...((change.isPending ? change.variables?.settings.providerDefinitions : undefined) ??
          data?.settings?.providerDefinitions ??
          []),
      ].sort(
        (left, right) =>
          (left.policy.order ?? Number.MAX_SAFE_INTEGER) -
          (right.policy.order ?? Number.MAX_SAFE_INTEGER),
      ),
    [data?.settings?.providerDefinitions, change.isPending, change.variables],
  );
  const environments = useMemo(() => installation?.environments ?? [], [installation]);
  const selectedServerId =
    runtimeServerId ??
    environments.find((environment) => environment.kind === "host")?.serverId ??
    environments[0]?.serverId;
  const options = useMemo(
    () =>
      environments.map((environment) => ({
        value: environment.serverId,
        label: environment.kind === "host" ? "Host" : "Dev container",
      })),
    [environments],
  );
  const closeRename = useCallback(() => setRenaming(null), []);
  const rename = useCallback(
    async (name: string) => {
      if (!renaming) return;
      await save({
        expectedRevision: renaming.snapshot.revision,
        settings: {
          providerDefinitions: renaming.snapshot.settings?.providerDefinitions?.map((provider) =>
            provider.id === renaming.provider.id
              ? { ...provider, policy: { ...provider.policy, label: name.trim() } }
              : provider,
          ),
        },
      });
    },
    [renaming, save],
  );
  const reorder = useCallback(
    (ordered: InstallationProvider[]) => {
      if (!data) return;
      change.mutate({
        expectedRevision: data.revision,
        settings: {
          providerDefinitions: ordered.map((provider, order) => ({
            ...provider,
            policy: { ...provider.policy, order },
          })),
        },
      });
    },
    [data, change],
  );
  const renderProvider = useCallback(
    (item: DraggableRenderItemInfo<InstallationProvider>) =>
      data ? (
        <ProviderCard
          {...item}
          snapshot={data}
          environments={environments}
          busy={change.isPending}
          save={change.mutate}
          rename={setRenaming}
        />
      ) : (
        <View />
      ),
    [data, environments, change.isPending, change.mutate],
  );
  if (!data?.settings?.providerDefinitions)
    return <Alert description="Complete shared provider migration to manage the catalog." />;
  return (
    <View>
      <SettingsSection
        title="Shared providers"
        info="Changes apply across environments. Manage exclusions in Environment exceptions."
      >
        {change.isError ? <Alert variant="error" description={change.error.message} /> : null}
        {change.isPending ? (
          <Text style={settingsStyles.rowHint}>Saving shared provider settings...</Text>
        ) : null}
        <DraggableList
          data={definitions}
          keyExtractor={providerKey}
          renderItem={renderProvider}
          onDragEnd={reorder}
          useDragHandle
          scrollEnabled={false}
          testID="shared-provider-order-list"
        />
      </SettingsSection>
      {selectedServerId ? (
        <SettingsSection
          title="Account sign-in and runtime installation"
          info="New accounts are shared. Choose where to sign in or install a provider runtime."
        >
          <SegmentedControl
            options={options}
            value={selectedServerId}
            onValueChange={setRuntimeServerId}
            testID="provider-runtime-environment"
          />
          <ProvidersSection serverId={selectedServerId} runtimeOnly />
        </SettingsSection>
      ) : null}
      {renaming ? (
        <AdaptiveRenameModal
          key={renaming.provider.id}
          visible
          title="Rename shared provider"
          initialValue={renaming.provider.policy.label ?? renaming.provider.providerType}
          onClose={closeRename}
          onSubmit={rename}
          testID="shared-provider-rename-dialog"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  removal: { gap: theme.spacing[2], flexShrink: 1 },
  card: { marginVertical: theme.spacing[2] },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  content: { flex: 1, minWidth: 120 },
  controls: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  environment: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  dragHandle: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
}));
