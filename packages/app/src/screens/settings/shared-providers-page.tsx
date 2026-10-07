import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import {
  groupInstallationProviders,
  type ProviderFamily,
  type ProviderAccount,
} from "./shared-providers-model";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type {
  InstallationSettingsSnapshot,
  InstallationSettings,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsTabs } from "@/components/settings/settings-tabs";
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
import type { Theme } from "@/styles/theme";
import { ProvidersSection } from "./providers-section";

const ThemedGrip = withUnistyles(GripVertical);
const gripColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface RenameRequest {
  ids: string[];
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

function ProviderFamilyCard({
  family,
  snapshot,
  busy,
  save,
  manage,
  drag,
  remove,
  canRemove,
  dragHandleProps,
}: {
  family: ProviderFamily;
  snapshot: InstallationSettingsSnapshot;
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  manage(account: ProviderAccount): void;
  drag(): void;
  remove(family: ProviderFamily): void;
  canRemove: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(
    (enabled: boolean) =>
      save({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings?.providerDefinitions?.map((entry) =>
            entry.providerType === family.id && !entry.removed
              ? { ...entry, policy: { ...entry.policy, enabled } }
              : entry,
          ),
        },
      }),
    [save, snapshot, family.id],
  );
  const removeFamily = useCallback(() => remove(family), [remove, family]);
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  return (
    <View style={[settingsStyles.card, styles.card]} testID={`provider-family-${family.id}`}>
      <View style={styles.heading}>
        <View
          {...dragHandleProps?.attributes}
          {...(!busy ? dragHandleProps?.listeners : undefined)}
          ref={dragHandleProps?.setActivatorNodeRef}
          accessibilityLabel={`Reorder ${family.name}`}
          testID={`provider-family-drag-${family.id}`}
        >
          <Pressable onLongPress={drag} disabled={busy} style={styles.dragHandle}>
            <ThemedGrip size={18} uniProps={gripColor} />
          </Pressable>
        </View>
        <Button
          variant="ghost"
          onPress={toggleExpanded}
          accessibilityState={expandedState}
          leftIcon={expanded ? ChevronDown : ChevronRight}
          style={[styles.content, styles.familyTitle]}
        >
          {family.name}
        </Button>
        <Switch
          value={family.enabled}
          onValueChange={toggle}
          disabled={busy}
          accessibilityLabel={`Enable ${family.name} everywhere`}
        />
      </View>
      {expanded && canRemove ? (
        <Button variant="outline" disabled={busy} onPress={removeFamily}>
          Remove provider
        </Button>
      ) : null}
      {expanded
        ? family.accounts.map((account) => (
            <ProviderAccountRow
              key={account.id}
              account={account}
              manage={manage}
              snapshot={snapshot}
              save={save}
              busy={busy}
            />
          ))
        : null}
    </View>
  );
}

function ProviderAccountRow({
  account,
  manage,
  snapshot,
  save,
  busy,
}: {
  account: ProviderAccount;
  snapshot: InstallationSettingsSnapshot;
  save(update: InstallationSettingsUpdate): void;
  busy: boolean;
  manage(account: ProviderAccount): void;
}) {
  const open = useCallback(() => manage(account), [manage, account]);
  const toggle = useCallback(
    (enabled: boolean) => {
      const ids = new Set(account.definitions.map((entry) => entry.id));
      save({
        expectedRevision: snapshot.revision,
        settings: {
          providerDefinitions: snapshot.settings?.providerDefinitions?.map((entry) =>
            ids.has(entry.id) ? { ...entry, policy: { ...entry.policy, enabled } } : entry,
          ),
        },
      });
    },
    [account, snapshot, save],
  );
  return (
    <View style={styles.heading} testID={`provider-account-${account.id}`}>
      <Text style={[settingsStyles.rowTitle, styles.content]}>{account.name}</Text>
      <Switch
        value={account.enabled}
        onValueChange={toggle}
        disabled={busy}
        accessibilityLabel={`Enable ${account.name}`}
      />
      <Button variant="outline" onPress={open}>
        Manage
      </Button>
    </View>
  );
}

function RestoreProviderRow({
  family,
  restore,
  busy,
}: {
  family: ProviderFamily;
  restore(family: ProviderFamily): void;
  busy: boolean;
}) {
  const onRestore = useCallback(() => restore(family), [restore, family]);
  return (
    <View style={styles.heading}>
      <Text style={[settingsStyles.rowTitle, styles.content]}>{family.name}</Text>
      <Button variant="outline" onPress={onRestore} disabled={busy}>
        Restore disabled provider
      </Button>
    </View>
  );
}

function useProviderRemovalCapability(environments: InstallationEnvironment[]) {
  const hostId = environments.find((environment) => environment.kind === "host")?.serverId ?? null;
  const devId =
    environments.find((environment) => environment.kind === "container")?.serverId ?? null;
  const hostRemoval = useHostFeature(hostId, "installationProviderRemoval");
  const devRemoval = useHostFeature(devId, "installationProviderRemoval");
  const canRemove = hostRemoval && (!devId || devRemoval);
  return canRemove;
}

function familyKey(family: ProviderFamily) {
  return family.id;
}

type ProviderCatalogSnapshot = InstallationSettingsSnapshot & {
  settings: InstallationSettings & { providerDefinitions: InstallationProvider[] };
};

export function SharedProvidersPage() {
  const { data, installation, save } = useInstallationSettings();
  const environments = useMemo(() => installation?.environments ?? [], [installation]);
  const snapshot = useMemo(
    () =>
      data?.settings?.providerDefinitions
        ? {
            ...data,
            settings: { ...data.settings, providerDefinitions: data.settings.providerDefinitions },
          }
        : null,
    [data],
  );
  if (!snapshot)
    return <Alert description="Complete shared provider migration to manage the catalog." />;
  return <ProviderCatalog data={snapshot} environments={environments} save={save} />;
}

function ProviderCatalog({
  data,
  environments,
  save,
}: {
  data: ProviderCatalogSnapshot;
  environments: InstallationEnvironment[];
  save: ReturnType<typeof useInstallationSettings>["save"];
}) {
  const [renaming, setRenaming] = useState<RenameRequest | null>(null);
  const [managing, setManaging] = useState<ProviderAccount | null>(null);
  const [adding, setAdding] = useState(false);
  const [runtimeServerId, setRuntimeServerId] = useState<string | null>(null);
  const change = useMutation({ mutationFn: save });
  const definitions = useMemo(
    () =>
      [
        ...((change.isPending ? change.variables?.settings.providerDefinitions : undefined) ??
          data.settings.providerDefinitions ??
          []),
      ].sort(
        (left, right) =>
          (left.policy.order ?? Number.MAX_SAFE_INTEGER) -
          (right.policy.order ?? Number.MAX_SAFE_INTEGER),
      ),
    [data.settings.providerDefinitions, change.isPending, change.variables],
  );
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
            renaming.ids.includes(provider.id)
              ? { ...provider, policy: { ...provider.policy, label: name.trim() } }
              : provider,
          ),
        },
      });
    },
    [renaming, save],
  );
  const removedFamilies = useMemo(
    () => groupInstallationProviders(definitions, "removed"),
    [definitions],
  );
  const restore = useCallback(
    (family: ProviderFamily) => {
      change.mutate({
        expectedRevision: data.revision,
        settings: {
          providerDefinitions: data.settings.providerDefinitions.map((entry) =>
            entry.providerType === family.id
              ? { ...entry, removed: false, policy: { ...entry.policy, enabled: false } }
              : entry,
          ),
        },
      });
    },
    [data, change],
  );
  const families = useMemo(() => groupInstallationProviders(definitions), [definitions]);
  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const closeManage = useCallback(() => setManaging(null), []);
  const addHeader = useMemo(() => ({ title: "Add provider" }), []);
  const currentAccount = families
    .flatMap((family) => family.accounts)
    .find((account) => account.id === managing?.id);
  const manageHeader = useMemo(
    () => ({ title: currentAccount?.name ?? "Provider" }),
    [currentAccount],
  );
  const canRemove = useProviderRemovalCapability(environments);
  const remove = useCallback(
    async (family: ProviderFamily) => {
      const confirmed = await confirmDialog({
        title: `Remove ${family.name}?`,
        message:
          "Remove this provider from the shared list and prevent new launches in every environment. Saved profiles, credentials and existing task histories remain. You can restore it from Add provider.",
        confirmLabel: "Remove provider",
        destructive: true,
      });
      if (!confirmed) return;
      change.mutate({
        expectedRevision: data.revision,
        settings: {
          providerDefinitions: data.settings.providerDefinitions.map((entry) =>
            entry.providerType === family.id
              ? { ...entry, removed: true, policy: { ...entry.policy, enabled: false } }
              : entry,
          ),
        },
      });
    },
    [data, change],
  );
  const reorder = useCallback(
    (ordered: ProviderFamily[]) => {
      const rank = new Map(ordered.map((family, index) => [family.id, index]));
      change.mutate({
        expectedRevision: data.revision,
        settings: {
          providerDefinitions: data.settings.providerDefinitions.map((entry) => ({
            ...entry,
            policy: { ...entry.policy, order: rank.get(entry.providerType) ?? ordered.length },
          })),
        },
      });
    },
    [data, change],
  );
  const renderFamily = useCallback(
    ({ item, drag, dragHandleProps }: DraggableRenderItemInfo<ProviderFamily>) => (
      <ProviderFamilyCard
        family={item}
        snapshot={data}
        busy={change.isPending}
        save={change.mutate}
        manage={setManaging}
        drag={drag}
        dragHandleProps={dragHandleProps}
        remove={remove}
        canRemove={canRemove}
      />
    ),
    [data, change, remove, canRemove],
  );
  const selectedDefinition =
    currentAccount?.definitions.find((entry) => entry.bindings[selectedServerId]) ??
    currentAccount?.definitions[0];
  const renameSelected = useCallback(() => {
    if (selectedDefinition && data)
      setRenaming({
        provider: selectedDefinition,
        snapshot: data,
        ids: managing?.definitions.map((entry) => entry.id) ?? [selectedDefinition.id],
      });
  }, [selectedDefinition, data, managing]);
  const manageEnvironment = environments.find(
    (environment) => environment.serverId === selectedServerId,
  );
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
          data={families}
          keyExtractor={familyKey}
          renderItem={renderFamily}
          onDragEnd={reorder}
          scrollEnabled={false}
          useDragHandle
          testID="shared-provider-order-list"
        />
        <Button variant="outline" onPress={openAdd}>
          Add provider
        </Button>
      </SettingsSection>
      <AdaptiveModalSheet
        testID="provider-add-sheet"
        visible={adding}
        onClose={closeAdd}
        header={addHeader}
      >
        {change.isError ? <Alert variant="error" description={change.error.message} /> : null}
        <Text style={settingsStyles.rowHint}>
          Choose where authentication or runtime installation is needed. Provider settings are
          shared.
        </Text>
        <SettingsTabs
          options={options}
          value={selectedServerId}
          onValueChange={setRuntimeServerId}
          testID="provider-runtime-environment"
        />
        {removedFamilies.map((family) => (
          <RestoreProviderRow
            key={family.id}
            family={family}
            restore={restore}
            busy={change.isPending}
          />
        ))}
        {selectedServerId ? <ProvidersSection serverId={selectedServerId} runtimeOnly /> : null}
      </AdaptiveModalSheet>
      <AdaptiveModalSheet
        testID="provider-manage-sheet"
        visible={managing !== null}
        onClose={closeManage}
        header={manageHeader}
      >
        <Text style={settingsStyles.rowHint}>
          Local sign-in and runtime details. Availability exceptions are managed in Environments.
        </Text>
        <SettingsTabs
          options={options}
          value={selectedServerId}
          onValueChange={setRuntimeServerId}
        />
        {selectedDefinition ? (
          <Button variant="outline" onPress={renameSelected}>
            Rename
          </Button>
        ) : null}
        {selectedDefinition && manageEnvironment ? (
          <ProviderEnvironment
            provider={selectedDefinition}
            environment={manageEnvironment}
            excluded={
              data.settings.resourceExclusions[manageEnvironment.serverId]?.providerIds?.includes(
                selectedDefinition.id,
              ) ?? false
            }
          />
        ) : null}
      </AdaptiveModalSheet>
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
  familyTitle: { justifyContent: "flex-start" },
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
