import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import type { InstallationPlugin } from "@getpaseo/protocol/plugin-installation";
import type { InstallationSettingsUpdate } from "@getpaseo/protocol/installation-settings";
import { formatPluginIdentity } from "@getpaseo/protocol/plugin-source-reference";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { useInstallationSettings } from "@/execution-installation/settings";
import { resolveInstallationPluginSource } from "@/execution-installation/plugins";
import { PluginSettingsMenuItems } from "@/plugins/settings";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { PluginLogsSheet } from "./plugins-page";
import { openSharedPluginForm, type SharedPluginSourceKind } from "./shared-plugin-form-model";

const SOURCE_KINDS: SegmentedControlOption<SharedPluginSourceKind>[] = [
  { value: "managed", label: "Git or npm" },
  { value: "directory", label: "Local directories" },
];

function useSharedPluginForm(plugin: InstallationPlugin | null) {
  const { save } = useInstallationSettings();
  const source = plugin?.source;
  const [model] = useState(() =>
    openSharedPluginForm(
      { resolve: resolveInstallationPluginSource, save },
      {
        source: source && source.kind !== "directory" ? formatPluginIdentity(source.identity) : "",
        updateId: plugin?.id,
      },
    ),
  );
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}

function SharedPluginForm({
  plugin,
  onClose,
}: {
  plugin: InstallationPlugin | null;
  onClose(): void;
}) {
  const { data } = useInstallationSettings();
  const { model, state } = useSharedPluginForm(plugin);
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const busy = state.phase === "resolving" || state.phase === "saving";
  const resolved = state.resolved;
  let revision = "";
  if (resolved?.kind === "directory") revision = "Local directories";
  else if (resolved)
    revision = resolved.kind === "git" ? resolved.target.commit : resolved.target.version;
  const kindOptions = useMemo(
    () => SOURCE_KINDS.map((option) => Object.assign({}, option, { disabled: busy })),
    [busy],
  );
  const sourceLabel = state.sourceKind === "directory" ? "Plugin ID" : "Source";
  const header = useMemo(
    () => ({ title: plugin ? "Update shared plugin" : "Add shared plugin" }),
    [plugin],
  );
  const prepare = useCallback(() => {
    if (data) void model.prepare(data);
  }, [data, model]);
  const submit = useCallback(async () => {
    if (await model.submit()) onClose();
  }, [model, onClose]);
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="shared-plugin-form">
      <View style={styles.form}>
        {!plugin ? (
          <Field label="Install from">
            <SegmentedControl
              options={kindOptions}
              value={state.sourceKind}
              onValueChange={model.setSourceKind}
              size={size}
            />
          </Field>
        ) : null}
        <Field label={sourceLabel}>
          <FormTextInput
            initialValue={state.source}
            resetKey={state.resetKey}
            onChangeText={model.setSource}
            editable={!busy}
            size={size}
            accessibilityLabel={sourceLabel}
            testID="shared-plugin-source"
          />
        </Field>
        {resolved ? (
          <SettingsCard>
            <SettingsRow label={resolved.id} hint={revision} />
          </SettingsCard>
        ) : null}
        {state.error ? <Alert variant="error" description={state.error} /> : null}
        <View style={styles.controls}>
          <Button
            size={size}
            variant="outline"
            disabled={busy || !data || !state.source.trim()}
            onPress={prepare}
            testID="shared-plugin-prepare"
          >
            {state.phase === "resolving" ? "Preparing..." : "Review plugin"}
          </Button>
          <Button
            size={size}
            variant="default"
            disabled={state.phase !== "review"}
            onPress={submit}
            testID="shared-plugin-save"
          >
            {state.phase === "saving" ? "Saving..." : "Save shared plugin"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function PluginEnvironment({
  serverId,
  label,
  pluginId,
  excluded,
}: {
  serverId: string;
  label: string;
  pluginId: string;
  excluded: boolean;
}) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "pluginManagement");
  const logsSupported = useHostFeature(serverId, "pluginLogs");
  const [logsOpen, setLogsOpen] = useState(false);
  const plugins = useFetchQuery({
    queryKey: ["plugins", serverId],
    queryFn: async () => {
      if (!client) throw new Error("Environment is disconnected");
      return client.listPlugins();
    },
    enabled: Boolean(client && connected && supported),
    dataShape: "list",
    staleTimeMs: 1000,
    refetchInterval: 5000,
  });
  const reload = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("Environment is disconnected");
      return client.reloadPlugin(pluginId);
    },
    onSuccess: () => {
      void plugins.refetch();
    },
  });
  const openLogs = useCallback(() => setLogsOpen(true), []);
  const closeLogs = useCallback(() => setLogsOpen(false), []);
  const reloadPlugin = useCallback(() => reload.mutate(), [reload]);
  const plugin = plugins.data?.find((item) => item.id === pluginId);
  let status = "Waiting to install";
  if (plugin) status = plugin.status;
  status = environmentStatus({
    status,
    pending: plugins.isPending,
    supported,
    connected,
    excluded,
  });
  if (reload.isSuccess) status = `Reloaded: ${status}`;
  const error = reload.error?.message ?? plugins.error?.message ?? plugin?.error;
  const pending = reload.isPending;
  return (
    <SettingsRow
      label={label}
      hint={status}
      error={error}
      testID={`shared-plugin-environment-${pluginId}-${serverId}`}
    >
      {plugin && connected ? (
        <DropdownMenu compactMode="sheet">
          <DropdownTrigger
            accessibilityRole="button"
            accessibilityLabel={`${pluginId}: ${label} actions`}
            disabled={pending}
          >
            {pending ? "Reloading..." : "Actions"}
          </DropdownTrigger>
          <DropdownMenuContent align="end" width={220} sheetTitle={`${pluginId}: ${label}`}>
            <PluginSettingsMenuItems serverId={serverId} pluginId={pluginId} disabled={pending} />
            {logsSupported ? <DropdownMenuItem onSelect={openLogs}>Logs</DropdownMenuItem> : null}
            <DropdownMenuItem
              disabled={!plugin.enabled || excluded || pending}
              onSelect={reloadPlugin}
            >
              Reload
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {logsOpen && client ? (
        <PluginLogsSheet
          client={client}
          pluginId={pluginId}
          serverId={serverId}
          onClose={closeLogs}
        />
      ) : null}
    </SettingsRow>
  );
}

interface EnvironmentStatusInput {
  status: string;
  pending: boolean;
  supported: boolean;
  connected: boolean;
  excluded: boolean;
}
function environmentStatus(input: EnvironmentStatusInput): string {
  if (input.excluded) return "Excluded";
  if (!input.connected) return "Disconnected";
  if (!input.supported) return "Update environment to manage plugins";
  if (input.pending) return "Loading...";
  return input.status;
}

interface SharedPluginCardProps {
  plugin: InstallationPlugin;
  snapshot: NonNullable<ReturnType<typeof useInstallationSettings>["data"]>;
  installation: NonNullable<ReturnType<typeof useInstallationSettings>["installation"]>;
  pending: boolean;
  save(update: InstallationSettingsUpdate): void;
  edit(plugin: InstallationPlugin): void;
}
function SharedPluginCard({
  plugin,
  snapshot,
  installation,
  pending,
  save,
  edit,
}: SharedPluginCardProps) {
  const toggle = useCallback(
    (enabled: boolean) => {
      const plugins = snapshot.settings?.plugins;
      if (!plugins) return;
      save({
        expectedRevision: snapshot.revision,
        settings: {
          plugins: plugins.map((entry) =>
            entry.id === plugin.id ? Object.assign({}, entry, { enabled }) : entry,
          ),
        },
      });
    },
    [snapshot, save, plugin.id],
  );
  const update = useCallback(() => {
    if (plugin.source.kind === "directory") router.push("/settings/environments");
    else edit(plugin);
  }, [edit, plugin]);
  const remove = useCallback(async () => {
    const settings = snapshot.settings;
    const plugins = settings?.plugins;
    if (!settings || !plugins) return;
    const confirmed = await confirmDialog({
      title: `Remove ${plugin.id}?`,
      message:
        "Remove this shared definition and disable its copies in every environment. Local files and private plugin settings are retained.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    const exclusions = structuredClone(settings.resourceExclusions);
    for (const environment of Object.values(exclusions)) {
      if (environment.pluginIds)
        environment.pluginIds = environment.pluginIds.filter((id) => id !== plugin.id);
    }
    save({
      expectedRevision: snapshot.revision,
      settings: {
        plugins: plugins.filter((entry) => entry.id !== plugin.id),
        resourceExclusions: exclusions,
      },
    });
  }, [snapshot, save, plugin.id]);
  return (
    <SettingsSection title={plugin.id} testID={`shared-plugin-${plugin.id}`}>
      <SettingsCard>
        <SettingsRow
          label="Enabled"
          hint={
            plugin.source.kind === "directory"
              ? "Local directory"
              : formatPluginIdentity(plugin.source.identity)
          }
        >
          <View style={styles.controls}>
            <Switch
              accessibilityLabel={`${plugin.id}: enabled everywhere`}
              value={plugin.enabled}
              disabled={pending}
              onValueChange={toggle}
            />
            <Button variant="outline" size="sm" onPress={update}>
              {plugin.source.kind === "directory" ? "Directories" : "Update"}
            </Button>
            <Button variant="outline" size="sm" disabled={pending} onPress={remove}>
              Remove
            </Button>
          </View>
        </SettingsRow>
        {installation.environments.map((environment) => (
          <PluginEnvironment
            key={environment.serverId}
            serverId={environment.serverId}
            label={environment.kind === "host" ? "Host" : "Dev container"}
            pluginId={plugin.id}
            excluded={
              snapshot.settings?.resourceExclusions[environment.serverId]?.pluginIds?.includes(
                plugin.id,
              ) ?? false
            }
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

export function SharedPluginsPage() {
  const { data, installation, save } = useInstallationSettings();
  const [form, setForm] = useState<{ plugin: InstallationPlugin | null } | null>(null);
  const mutation = useMutation({
    mutationFn: (update: InstallationSettingsUpdate) => save(update),
  });
  const add = useCallback(() => setForm({ plugin: null }), []);
  const edit = useCallback((plugin: InstallationPlugin) => setForm({ plugin }), []);
  const close = useCallback(() => setForm(null), []);
  const toggle = useCallback(
    (pluginsEnabled: boolean) => {
      if (data) mutation.mutate({ expectedRevision: data.revision, settings: { pluginsEnabled } });
    },
    [data, mutation],
  );
  const addButton = useMemo(
    () => (
      <Button variant="outline" size="sm" onPress={add} testID="shared-plugin-add">
        Add plugin
      </Button>
    ),
    [add],
  );
  const settings = data?.settings;
  if (!installation || !data || !settings) return null;
  const plugins = settings.plugins;
  if (!plugins)
    return <Text style={settingsStyles.rowHint}>Reading existing plugin catalogs...</Text>;
  return (
    <View testID="shared-plugins-page">
      <SettingsSection title="Plugins" trailing={addButton}>
        <SettingsCard>
          <SettingsRow label="Enable plugins">
            <Switch
              accessibilityLabel="Enable plugins everywhere"
              value={settings.pluginsEnabled}
              disabled={mutation.isPending}
              onValueChange={toggle}
            />
          </SettingsRow>
        </SettingsCard>
        {mutation.isPending ? <Text style={settingsStyles.rowHint}>Saving...</Text> : null}
        {mutation.error ? <Alert variant="error" description={mutation.error.message} /> : null}
        {plugins.length === 0 ? (
          <Text style={settingsStyles.rowHint}>No plugins installed</Text>
        ) : null}
      </SettingsSection>
      {plugins.map((plugin) => (
        <SharedPluginCard
          key={plugin.id}
          plugin={plugin}
          snapshot={data}
          installation={installation}
          pending={mutation.isPending}
          save={mutation.mutate}
          edit={edit}
        />
      ))}
      {form ? (
        <SharedPluginForm key={form.plugin?.id ?? "new"} plugin={form.plugin} onClose={close} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[4] },
  controls: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
}));
