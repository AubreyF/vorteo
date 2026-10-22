import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { ChevronRight, GripVertical } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { groupInstallationProviders, type ProviderFamily } from "./shared-providers-model";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type {
  InstallationSettingsSnapshot,
  InstallationSettings,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useInstallationSettings } from "@/execution-installation/settings";
import { openProviderSettings } from "@/navigation/settings-navigation";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { ProvidersSection } from "./providers-section";
import { environmentLabel } from "./provider-connection-status";

const ThemedGrip = withUnistyles(GripVertical);
const ThemedChevron = withUnistyles(ChevronRight);
const gripColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** "2 connections", or what is wrong when nothing is enabled. */
function familySummary(family: ProviderFamily): string {
  const count = family.accounts.length;
  const connections = count === 1 ? "1 connection" : `${count} connections`;
  return family.enabled ? connections : `Off · ${connections}`;
}

function ProviderFamilyCard({
  family,
  snapshot,
  busy,
  save,
  drag,
  dragHandleProps,
}: {
  family: ProviderFamily;
  snapshot: InstallationSettingsSnapshot;
  busy: boolean;
  save(update: InstallationSettingsUpdate): void;
  drag(): void;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
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
  const open = useCallback(() => openProviderSettings(family.id), [family.id]);
  const titleStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.title,
      (hovered || pressed) && styles.titleHovered,
    ],
    [],
  );
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
        <Pressable
          onPress={open}
          style={titleStyle}
          accessibilityRole="button"
          accessibilityLabel={`Open ${family.name}`}
          testID={`provider-family-open-${family.id}`}
        >
          <View style={styles.content}>
            <Text style={settingsStyles.rowTitle}>{family.name}</Text>
            <Text style={settingsStyles.rowHint}>{familySummary(family)}</Text>
          </View>
          <ThemedChevron size={16} uniProps={gripColor} />
        </Pressable>
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
        Restore provider
      </Button>
    </View>
  );
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
  const [adding, setAdding] = useState(false);
  const [useDev, setUseDev] = useState(false);
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
  // Installs and sign-ins run on Host; the Dev container is the rare exception.
  const host = environments.find((environment) => environment.kind === "host");
  const dev = environments.find((environment) => environment.kind === "container");
  const target = (useDev ? dev : host) ?? host ?? dev;
  const other = target === host ? dev : host;
  const switchTarget = useCallback(() => setUseDev((value) => !value), []);
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
  const addHeader = useMemo(() => ({ title: "Add provider" }), []);
  const reorder = useCallback(
    (ordered: ProviderFamily[]) => {
      const rank = new Map(ordered.map((family, index) => [family.id, index]));
      return change.mutateAsync({
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
        drag={drag}
        dragHandleProps={dragHandleProps}
      />
    ),
    [data, change],
  );
  return (
    <View>
      <SettingsSection
        title="Providers"
        status={change.isPending ? "Saving provider settings..." : null}
        info="Providers and their connections work in every environment. Open a provider to manage its connections, profiles and model defaults."
      >
        {change.isError ? <Alert variant="error" description={change.error.message} /> : null}
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
          Install or sign in once. Vorteo shares providers with every environment.
        </Text>
        {removedFamilies.map((family) => (
          <RestoreProviderRow
            key={family.id}
            family={family}
            restore={restore}
            busy={change.isPending}
          />
        ))}
        {target ? <ProvidersSection serverId={target.serverId} runtimeOnly /> : null}
        {other ? (
          <Button variant="ghost" size="sm" onPress={switchTarget}>
            {`Install in ${environmentLabel(other)} instead`}
          </Button>
        ) : null}
      </AdaptiveModalSheet>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { marginVertical: theme.spacing[2] },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  title: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
  titleHovered: { backgroundColor: theme.colors.surface2 },
  content: { flex: 1, minWidth: 120 },
  dragHandle: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
}));
