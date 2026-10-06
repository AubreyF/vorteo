import { useMutation } from "@tanstack/react-query";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { useFetchQuery } from "@/data/query";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { CompactAccountButton } from "@/provider-usage/compact-account-button";
import { useToast } from "@/contexts/toast-context";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { ProviderReconnectControl } from "@/provider-usage/reconnect-control";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import type { ProviderUsage } from "@/provider-usage/types";
import { useCallback, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type GestureResponderEvent,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useInstallationSettings } from "@/execution-installation/settings";
import { sharedCatalogProviderEnrollment } from "@/execution-installation/settings-policy";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import {
  buildAcpProviderConfigPatch,
  type AcpProviderCatalogItem,
} from "@/hooks/use-acp-provider-catalog";
import { ProviderCatalogList } from "@/components/provider-catalog-list";
import { useProviderIcon } from "@/components/provider-icons";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { Alert as InlineAlert } from "@/components/ui/alert";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { ChevronRight, GripVertical } from "lucide-react-native";

type ProviderDefinition = ReturnType<typeof buildProviderDefinitions>[number];
type ProviderEntry = NonNullable<ReturnType<typeof useProvidersSnapshot>["entries"]>[number];

type StatusTone = "success" | "warning" | "danger" | "muted" | "loading";

interface ProviderStatus {
  tone: StatusTone;
  label: string;
  modelCount: number | null;
}

function getProviderStatus(
  status: string,
  enabled: boolean,
  modelCount: number,
  t: TFunction,
): ProviderStatus {
  if (!enabled)
    return { tone: "muted", label: t("settings.providers.statuses.disabled"), modelCount: null };
  if (status === "loading") {
    return { tone: "loading", label: t("settings.providers.statuses.loading"), modelCount: null };
  }
  if (status === "error") {
    return { tone: "danger", label: t("settings.providers.statuses.error"), modelCount: null };
  }
  if (status === "ready") {
    return {
      tone: "success",
      label: t("settings.providers.statuses.available"),
      modelCount: modelCount > 0 ? modelCount : null,
    };
  }
  return {
    tone: "warning",
    label: t("settings.providers.statuses.notInstalled"),
    modelCount: null,
  };
}

interface ProviderRowProps {
  usage: ProviderUsage | undefined;
  serverId: string;
  def: ProviderDefinition;
  entry: ProviderEntry;
  enabled: boolean;
  isToggling: boolean;
  isRemoving: boolean;
  canRemove: boolean;
  isFirst: boolean;
  drag?: () => void;
  dragHandleProps?: DraggableListDragHandleProps;
  canReorder?: boolean;
  reorderPending?: boolean;
  onPress: (providerId: string) => void;
  onToggleEnabled: (providerId: string, enabled: boolean) => void;
  onRemove: (providerId: string, providerLabel: string) => void;
  onRename: (provider: ProviderDefinition) => void;
}

function ProviderRow({
  usage,
  serverId,
  def,
  entry,
  enabled,
  isToggling,
  isRemoving,
  canRemove,
  isFirst,
  drag,
  dragHandleProps,
  canReorder,
  reorderPending,
  onPress,
  onToggleEnabled,
  onRemove,
  onRename,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const ProviderIcon = useProviderIcon(def.id, serverId);
  const providerError =
    enabled &&
    entry.status === "error" &&
    typeof entry.error === "string" &&
    entry.error.trim().length > 0
      ? entry.error.trim()
      : null;
  const modelCount = filterSelectableModels(entry.models ?? null)?.length ?? 0;
  const needsCliUpdate = enabled && Boolean(entry.cliUpdate);
  const visibleStatus = useMemo<ProviderStatus>(() => {
    const status = getProviderStatus(entry.status, enabled, modelCount, t);
    return needsCliUpdate ? { ...status, tone: "warning", label: "CLI update needed" } : status;
  }, [entry.status, enabled, modelCount, t, needsCliUpdate]);

  const handlePress = useCallback(() => {
    onPress(def.id);
  }, [def.id, onPress]);
  const handleRename = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onRename(def);
    },
    [def, onRename],
  );
  const handleRemove = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onRemove(def.id, def.label);
    },
    [def.id, def.label, onRemove],
  );
  const handleToggleValueChange = useCallback(
    (value: boolean) => {
      onToggleEnabled(def.id, value);
    },
    [def.id, onToggleEnabled],
  );
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      styles.row,
      isCompact && styles.compactRow,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isCompact],
  );

  return (
    <View style={[styles.draggableRow, !isFirst && settingsStyles.rowBorder]}>
      {canReorder ? (
        <View
          {...dragHandleProps?.attributes}
          {...(!reorderPending ? dragHandleProps?.listeners : undefined)}
          ref={dragHandleProps?.setActivatorNodeRef}
          accessibilityLabel={`Reorder ${def.label}`}
          testID={`provider-drag-${def.id}`}
        >
          <Pressable
            onLongPress={drag}
            disabled={reorderPending}
            accessibilityLabel={`Reorder ${def.label}`}
            style={styles.dragHandle}
          >
            <GripVertical size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      ) : null}
      <Pressable
        style={rowStyle}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={t("settings.providers.providerDetails", { name: def.label })}
      >
        {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
          <>
            <View style={styles.rowContent}>
              <ChevronRight
                size={theme.iconSize.sm}
                color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
              <ProviderIcon size={theme.iconSize.md} color={theme.colors.foreground} />
              <View style={styles.textColumn}>
                <View style={styles.titleRow}>
                  <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                    {def.label}
                  </Text>
                  {!isCompact ? <Text style={styles.separator}>·</Text> : null}
                  <StatusIndicator status={visibleStatus} compact={isCompact} />
                </View>
                {needsCliUpdate && isCompact ? (
                  <Text style={settingsStyles.rowHint}>CLI update needed</Text>
                ) : null}
                {providerError && !isCompact ? (
                  <Text style={styles.errorText} numberOfLines={3}>
                    {providerError}
                  </Text>
                ) : null}
              </View>
            </View>
            <View style={[styles.trailingControls, styles.vortonTrailingControls]}>
              {entry.source === "custom" ? (
                <>
                  <CompactAccountButton
                    onPress={handleRename}
                    disabled={isRemoving}
                    testID={`provider-rename-${def.id}`}
                  >
                    Rename
                  </CompactAccountButton>
                  {canRemove ? (
                    <CompactAccountButton
                      onPress={handleRemove}
                      disabled={isRemoving}
                      loading={isRemoving}
                      testID={`provider-remove-${def.id}`}
                    >
                      Delete
                    </CompactAccountButton>
                  ) : null}
                </>
              ) : null}
              <ProviderReconnectControl
                serverId={serverId}
                providerId={def.id}
                name={def.label}
                usage={usage}
              />
              <Switch
                value={enabled}
                onValueChange={handleToggleValueChange}
                disabled={isToggling || isRemoving}
                accessibilityLabel={t("settings.providers.enableProvider", { name: def.label })}
              />
            </View>
          </>
        )}
      </Pressable>
    </View>
  );
}

function getDotColor(tone: StatusTone, theme: ReturnType<typeof useUnistyles>["theme"]): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

function StatusIndicator({ status, compact }: { status: ProviderStatus; compact: boolean }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const dotStyle = useMemo(
    () => [styles.statusDot, { backgroundColor: getDotColor(status.tone, theme) }],
    [status.tone, theme],
  );

  return (
    <View style={styles.statusRow}>
      {status.tone === "loading" ? (
        <LoadingSpinner size={10} color={theme.colors.foregroundMuted} />
      ) : (
        <View style={dotStyle} />
      )}
      {!compact ? (
        <>
          <Text style={styles.statusLabel}>{status.label}</Text>
          {status.modelCount !== null ? (
            <>
              <Text style={styles.separator}>·</Text>
              <Text style={styles.statusLabel}>
                {status.modelCount === 1
                  ? t("settings.providers.models.one")
                  : t("settings.providers.models.many", { count: status.modelCount })}
              </Text>
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export interface ProvidersSectionProps {
  serverId: string;
  runtimeOnly?: boolean;
}

function ProviderCatalogInstallation({ serverId }: { serverId: string }) {
  const shared = useInstallationSettings();
  const client = useHostRuntimeClient(serverId);
  const { patchConfig } = useDaemonConfig(serverId);
  const { refresh } = useProvidersSnapshot(serverId);
  const install = useMutation({
    mutationFn: async (entry: AcpProviderCatalogItem) => {
      const patch = buildAcpProviderConfigPatch(entry);
      const managed = shared.installation?.environments.some(
        (environment) => environment.serverId === serverId,
      );
      if (managed) {
        if (!client || !shared.data?.settings || shared.data.conflicts)
          throw new Error(
            "Connect this environment and resolve shared settings migration before installing a runtime.",
          );
        const enrollment = sharedCatalogProviderEnrollment(entry.id, patch.providers![entry.id]!, {
          settings: shared.data.settings,
          serverId,
        });
        if (enrollment.settings)
          await shared.save({
            expectedRevision: shared.data.revision,
            settings: enrollment.settings,
          });
        await client.patchDaemonConfig(enrollment.patch);
      } else {
        await patchConfig(patch);
      }
      await refresh([entry.id]);
    },
  });
  const handleInstall = useCallback(
    (entry: AcpProviderCatalogItem) => {
      if (!install.isPending) install.mutate(entry);
    },
    [install],
  );
  const installingProviderId = install.isPending ? install.variables.id : null;
  return (
    <>
      {install.isError ? (
        <InlineAlert
          variant="error"
          description={install.error.message}
          testID="provider-install-error"
        />
      ) : null}
      <ProviderCatalogList
        serverId={serverId}
        installingProviderId={installingProviderId}
        onInstall={handleInstall}
      />
    </>
  );
}

export function ProvidersSection({ serverId, runtimeOnly = false }: ProvidersSectionProps) {
  const { view } = useProviderUsage(serverId, { enabled: true });
  const usageByProvider = useMemo(
    () =>
      new Map(
        view.kind === "ready"
          ? view.payload.providers.map((usage) => [usage.providerId, usage])
          : [],
      ),
    [view],
  );
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsProviderRemoval = useHostFeature(serverId, "providerRemoval");
  const supportsCredentialRemoval = useHostFeature(serverId, "providerCredentialRemoval");
  const client = useHostRuntimeClient(serverId);
  const { entries, isLoading, refresh } = useProvidersSnapshot(serverId);
  const panelActive = useRetainedPanelActive();
  const { config: monitorConfig } = useDaemonConfig(serverId);
  const claudeProviders =
    entries
      ?.filter(
        (entry) =>
          entry.enabled &&
          (entry.provider === "claude" ||
            monitorConfig?.providers[entry.provider]?.extends === "claude"),
      )
      .map((entry) => entry.provider) ?? [];
  const claudeEnabled = claudeProviders.length > 0;
  const monitorClaude = panelActive && isConnected && claudeEnabled;
  useFetchQuery({
    dataShape: "value",
    queryKey: ["claude-authentication-monitor", serverId],
    enabled: monitorClaude,
    queryFn: async () => {
      await refresh(claudeProviders);
      return null;
    },
    staleTimeMs: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const { patchConfig } = useDaemonConfig(serverId);
  const openProviderSettings = useProviderSettingsStore((state) => state.open);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [removingProviderId, setRemovingProviderId] = useState<string | null>(null);
  const removingProviderIdRef = useRef<string | null>(null);
  const [renamingProvider, setRenamingProvider] = useState<ProviderDefinition | null>(null);
  const toast = useToast();

  const providerDefinitions = useMemo(() => buildProviderDefinitions(entries), [entries]);
  const hasServer = serverId.length > 0;
  const closeRename = useCallback(() => setRenamingProvider(null), []);
  const renameProvider = useCallback(
    async (value: string) => {
      if (!renamingProvider) return;
      const result = await patchConfig({
        providers: { [renamingProvider.id]: { label: value.trim() } },
      });
      if (!result) throw new Error("Reconnect to the host and try again.");
    },
    [patchConfig, renamingProvider],
  );

  const handleOpenProviderSettings = useCallback(
    (providerId: string) => {
      openProviderSettings({ serverId, provider: providerId });
    },
    [openProviderSettings, serverId],
  );

  const handleToggleEnabled = useCallback(
    async (providerId: string, enabled: boolean) => {
      setPendingProviderId(providerId);
      try {
        await patchConfig({ providers: { [providerId]: { enabled } } });
      } catch (error) {
        Alert.alert(
          t("settings.providers.updateErrorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setPendingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [patchConfig, t],
  );

  const handleRemoveProvider = useCallback(
    async (providerId: string, providerLabel: string) => {
      if (removingProviderIdRef.current) return;
      removingProviderIdRef.current = providerId;
      setRemovingProviderId(providerId);
      try {
        if (!supportsCredentialRemoval)
          throw new Error("Update this host to delete connections and their managed credentials.");
        if (!client) throw new Error("Reconnect to the host and try again.");
        const { plan } = await client.previewProviderRemoval(providerId);
        let message: string;
        if (plan.credentials === "managed")
          message =
            "Delete this connection and its saved credentials? Its local account data will also be permanently removed.";
        else if (plan.credentials === "shared")
          message = `Delete this connection? Credentials shared with ${plan.sharedWith.join(", ")} will remain for those connections.`;
        else
          message =
            "Delete this connection? Credentials stored by an external CLI will remain. Sign out using that CLI to remove them.";
        const confirmed = await confirmDialog({
          title: t("settings.providers.remove.confirmTitle", { name: providerLabel }),
          message,
          confirmLabel: t("settings.providers.remove.confirm"),
          destructive: true,
        });
        if (!confirmed) return;
        await client.removeProvider(providerId, plan.revision);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        if (removingProviderIdRef.current === providerId) removingProviderIdRef.current = null;
        setRemovingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [t, supportsCredentialRemoval, client, toast],
  );

  return (
    <>
      {!runtimeOnly ? (
        <SettingsSection
          title={t("settings.providers.title")}
          testID="host-page-providers-card"
          style={styles.sectionSpacing}
        >
          {!hasServer || !isConnected ? (
            <View style={[settingsStyles.card, styles.emptyCard]}>
              <Text style={styles.emptyText}>{t("settings.providers.unavailable")}</Text>
            </View>
          ) : null}
          {hasServer && isConnected && isLoading ? (
            <View style={[settingsStyles.card, styles.emptyCard]}>
              <Text style={styles.emptyText}>{t("settings.providers.loading")}</Text>
            </View>
          ) : null}
          {hasServer && isConnected && !isLoading && providerDefinitions.length > 0 ? (
            <ProviderList
              serverId={serverId}
              entries={entries ?? []}
              usageByProvider={usageByProvider}
              pendingProviderId={pendingProviderId}
              removingProviderId={removingProviderId}
              supportsProviderRemoval={supportsProviderRemoval}
              onPress={handleOpenProviderSettings}
              onToggleEnabled={handleToggleEnabled}
              onRemove={handleRemoveProvider}
              onRename={setRenamingProvider}
            />
          ) : null}
        </SettingsSection>
      ) : null}

      {hasServer && isConnected ? (
        <SettingsSection
          title={t("settings.providers.addProvider")}
          testID="host-page-add-provider-card"
          style={styles.addProviderSection}
        >
          <ProviderCatalogInstallation serverId={serverId} />
        </SettingsSection>
      ) : null}
      {renamingProvider ? (
        <AdaptiveRenameModal
          key={renamingProvider.id}
          visible
          title="Rename provider"
          initialValue={renamingProvider.label}
          onClose={closeRename}
          onSubmit={renameProvider}
          testID="provider-rename-dialog"
        />
      ) : null}
    </>
  );
}

interface ProviderListProps extends Pick<
  ProviderRowProps,
  "serverId" | "onPress" | "onToggleEnabled" | "onRemove" | "onRename"
> {
  entries: ProviderEntry[];
  usageByProvider: Map<string, ProviderUsage>;
  pendingProviderId: string | null;
  removingProviderId: string | null;
  supportsProviderRemoval: boolean;
}

function ProviderList({
  serverId,
  entries,
  usageByProvider,
  pendingProviderId,
  removingProviderId,
  supportsProviderRemoval,
  onPress,
  onToggleEnabled,
  onRemove,
  onRename,
}: ProviderListProps) {
  const supportsProviderOrdering = useHostFeature(serverId, "providerOrdering");
  const canReorder = supportsProviderOrdering;
  const { patchConfig } = useDaemonConfig(serverId);
  const reorder = useMutation({
    mutationFn: async (ordered: ProviderEntry[]) => {
      const providers = Object.fromEntries(
        ordered.map((entry, order) => [entry.provider, { order }]),
      );
      const result = await patchConfig({ providers });
      if (!result) throw new Error("Reconnect to the host and try again.");
    },
  });
  const { mutate: saveOrder } = reorder;
  const reorderProviders = useCallback(
    (ordered: ProviderEntry[]) => {
      saveOrder(ordered);
    },
    [saveOrder],
  );

  const renderProvider = useCallback(
    ({ item: entry, index, drag, dragHandleProps }: DraggableRenderItemInfo<ProviderEntry>) => {
      const def = buildProviderDefinitions([entry])[0];
      return (
        <ProviderRow
          key={def.id}
          serverId={serverId}
          def={def}
          usage={usageByProvider.get(def.id)}
          entry={entry}
          enabled={entry.enabled ?? true}
          isToggling={pendingProviderId === def.id}
          isRemoving={removingProviderId === def.id}
          canRemove={supportsProviderRemoval && entry.source === "custom"}
          isFirst={index === 0}
          drag={drag}
          dragHandleProps={dragHandleProps}
          canReorder={canReorder}
          reorderPending={reorder.isPending}
          onPress={onPress}
          onToggleEnabled={onToggleEnabled}
          onRemove={onRemove}
          onRename={onRename}
        />
      );
    },
    [
      serverId,
      usageByProvider,
      pendingProviderId,
      removingProviderId,
      supportsProviderRemoval,
      canReorder,
      reorder.isPending,
      onPress,
      onToggleEnabled,
      onRemove,
      onRename,
    ],
  );

  return (
    <View style={settingsStyles.card}>
      {canReorder ? (
        <DraggableList
          data={reorder.isPending ? reorder.variables : entries}
          keyExtractor={providerKey}
          renderItem={renderProvider}
          onDragEnd={reorderProviders}
          useDragHandle
          scrollEnabled={false}
          testID="provider-order-list"
        />
      ) : (
        entries.map((item, index) => renderProvider({ item, index, drag: noop, isActive: false }))
      )}
      {reorder.isPending ? <Text style={styles.statusLabel}>Saving provider order…</Text> : null}
      {reorder.isError ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {reorder.error.message}
        </Text>
      ) : null}
    </View>
  );
}

function providerKey(entry: ProviderEntry) {
  return entry.provider;
}
function noop() {}

const styles = StyleSheet.create((theme) => ({
  draggableRow: { flexDirection: "row", alignItems: "center" },
  dragHandle: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  sectionSpacing: {
    marginBottom: theme.spacing[4],
  },
  addProviderSection: {
    marginTop: theme.spacing[4],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  row: {
    flex: 1,
    gap: theme.spacing[3],
    minHeight: 56,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  compactRow: {
    flexDirection: "column",
    alignItems: "stretch",
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  rowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  separator: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  trailingControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  vortonTrailingControls: {
    gap: theme.spacing[2],
  },
  menuButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  menuSlot: {
    width: 32,
    height: 32,
  },
  menuButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  menuButtonPressed: {
    backgroundColor: theme.colors.surface3,
  },
}));
