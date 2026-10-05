import { ExecutionEnvironmentIcon } from "@/execution-installation/environment-icon";
import { EnvironmentPresetMenu } from "./environment-preset-menu";
import { accountPresets } from "./account-presets";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { AccountDisconnectedIcon } from "@/provider-usage/reconnect-control";
import { ProfileDetailsView } from "./profile-details-view";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { ActivityIndicator, Text, ScrollView, View, useWindowDimensions } from "react-native";
import { EditingTextInput } from "@/components/ui/text-input";
import { StyleSheet } from "react-native-unistyles";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxItem } from "@/components/ui/combobox";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePresetData } from "./use-preset-data";
import {
  formatLocalEndpointSummary,
  formatWorkerActivity,
} from "@/provider-usage/local-endpoint-summary";
import type { AgentProfilePicker } from "./internal/use-agent-profile-picker";
import { useAgentProfiles } from "./internal/use-agent-profiles";
import { PresetUsageRail } from "./preset-usage-rail";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useVortonMode } from "@/vorton-mode";
import { useVortonTouch } from "@/vorton-touch";
import { useCompactProfileName } from "./use-compact-profile-name";
import { presetNickname } from "./nickname";
import { RemainingRing } from "@/provider-usage/remaining-ring";
import { selectedPresetPresentation } from "./selected-preset-presentation";

const PROFILE_SNAP_POINTS = ["90%"];
const EMPTY_OPTIONS: { id: string; label: string }[] = [];

function PresetStatusIcon({
  waiting,
  showWarning,
  showRing,
  remaining,
  stale,
}: {
  waiting: boolean;
  showWarning: boolean;
  showRing: boolean;
  remaining: number | null;
  stale: boolean;
}) {
  if (waiting) return <ActivityIndicator size="small" style={styles.pendingRing} />;
  if (showWarning) return <AccountDisconnectedIcon />;
  if (showRing)
    return (
      <View style={styles.ring}>
        <RemainingRing remaining={remaining} stale={stale} />
      </View>
    );
  return null;
}

interface PresetControlsProps {
  serverId: string | null;
  profiles: AgentProfilePicker;
  selectedProfileId?: string;
  selectedProfileName?: string;
  currentProvider?: string;
  currentModel?: string | null;
  currentThinkingOptionId?: string | null;
  quotaPausedAt?: string;
  onEdit?: () => void;
  disabled: boolean;
}
export function activePresetPicker(input: {
  enabled?: boolean;
  supported: boolean;
  picker: AgentProfilePicker | null;
}) {
  return input.enabled && input.supported ? input.picker : null;
}
export function PresetControls({
  serverId,
  profiles,
  selectedProfileId,
  selectedProfileName,
  currentProvider,
  currentModel,
  currentThinkingOptionId,
  onEdit,
  disabled,
}: PresetControlsProps) {
  const [open, setOpen] = useState(false);
  const [waitingToOpen, setWaitingToOpen] = useState(false);
  const panelActive = useRetainedPanelActive();
  const vortonMode = useVortonMode();
  const touch = useVortonTouch();
  const selectionDisabled = disabled || Boolean(profiles.isApplying);
  const controlsRef = useRef<View>(null);
  const triggerAccessibilityState = useMemo(
    () => ({ expanded: open, busy: waitingToOpen || Boolean(profiles.isApplying) }),
    [open, waitingToOpen, profiles.isApplying],
  );
  const [query, setQuery] = useState("");
  const [inspectedId, setInspectedId] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const anchorRef = useRef<View>(null);
  const isCompact = useIsCompactFormFactor();
  const controlsStyle = useMemo(
    () => [
      styles.controls,
      touch && styles.touchControls,
      touch && isCompact && styles.centerControls,
    ],
    [touch, isCompact],
  );
  const { width } = useWindowDimensions();
  const { profiles: definitions } = useAgentProfiles(serverId);
  const hasLocalEndpoint = profiles.rows.some((row) => Boolean(row.localEndpoint));
  const active = vortonMode && panelActive;
  const { view, ready } = usePresetData(serverId, profiles, active);
  // Warm every row before opening; changing snapshots must not restart the refresh loop.
  const refreshRef = useRef(profiles.refreshStatus);
  refreshRef.current = profiles.refreshStatus;
  const refreshingRef = useRef(profiles.isRefreshingStatus);
  refreshingRef.current = profiles.isRefreshingStatus;
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      const timestamp = Date.now();
      setNow(timestamp);
      if (hasLocalEndpoint && !refreshingRef.current && timestamp - lastRefresh.current >= 60_000) {
        lastRefresh.current = timestamp;
        refreshRef.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [active, hasLocalEndpoint, serverId]);
  useEffect(() => {
    if (waitingToOpen && ready) {
      setWaitingToOpen(false);
      setOpen(true);
    }
  }, [waitingToOpen, ready]);
  useEffect(() => {
    setWaitingToOpen(false);
    setOpen(false);
  }, [serverId, active]);
  const visibleRows = useMemo(
    () =>
      profiles.rows.filter((row) => {
        const nickname = presetNickname({
          name: row.name,
          nickname: definitions?.find((entry) => entry.id === row.id)?.nickname,
        });
        return `${row.name} ${row.summary} ${nickname}`.toLowerCase().includes(query.toLowerCase());
      }),
    [profiles.rows, query, definitions],
  );
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const accounts = useMemo(
    () => accountPresets({ rows: profiles.rows, definitions: definitions ?? [], entries, query }),
    [profiles.rows, definitions, entries, query],
  );
  const options = useMemo(
    () => visibleRows.map((row) => ({ id: row.id, label: row.name })),
    [visibleRows],
  );
  const inspected = useMemo(() => {
    const id = inspectedId ?? selectedProfileId;
    if (vortonMode) {
      const account =
        accounts.find((group) => group.rows.some((row) => row.id === id)) ?? accounts[0];
      return account?.rows.find((row) => row.id === id) ?? account?.rows[0];
    }
    return profiles.rows.find((row) => row.id === id) ?? visibleRows[0];
  }, [vortonMode, accounts, inspectedId, selectedProfileId, profiles.rows, visibleRows]);
  const inspectorRow = useMemo(
    () => (touch && isCompact ? undefined : inspected),
    [touch, isCompact, inspected],
  );
  const definition = definitions?.find((row) => row.id === inspected?.id);
  const worker = definitions?.find((row) => row.id === definition?.workerProfileId);
  const selected = profiles.rows.find((row) => row.id === selectedProfileId);
  const compactName = useCompactProfileName(controlsRef, isCompact);
  const { triggerLabel, showWarning, showRing, remaining, statusLabel, accessibilityLabel } =
    selectedPresetPresentation({
      compactName,
      selectedProfileId,
      selectedProfileName,
      currentProvider,
      selected,
      definitions,
      vortonMode,
      view,
      now,
    });
  const triggerCopy = vortonMode
    ? { label: "Choose profile", accessibilityLabel: "Choose profile" }
    : { label: triggerLabel, accessibilityLabel };
  const show = useCallback(() => {
    setInspectedId(selectedProfileId);
    setQuery("");
    setWaitingToOpen(!ready && !waitingToOpen);
    setOpen(ready);
  }, [selectedProfileId, ready, waitingToOpen]);
  const select = useCallback(
    (id: string, choices?: Pick<AgentProfile, "model" | "thinkingOptionId">) => {
      if (disabled || profiles.isApplying) return;
      setInspectedId(id);
      profiles.applyProfile(id, choices);
      setOpen(false);
    },
    [disabled, profiles],
  );
  const closeMenu = useCallback(() => setOpen(false), []);
  const edit = useCallback(() => {
    setOpen(false);
    const provider = inspected?.provider ?? accounts[0]?.provider ?? entries?.[0]?.provider;
    if (vortonMode && serverId && provider) {
      useProviderSettingsStore.getState().open({ serverId, provider, tab: "profiles" });
    } else {
      onEdit?.();
    }
  }, [onEdit, vortonMode, serverId, inspected, accounts, entries]);
  const footer = useMemo(
    () =>
      onEdit ? (
        <Button variant="ghost" size="sm" textStyle={styles.meta} onPress={edit}>
          Manage profiles
        </Button>
      ) : null,
    [onEdit, edit],
  );
  const renderRail = useCallback(
    (row: AgentProfilePicker["rows"][number]) => (
      <PresetUsageRail
        view={view}
        now={now}
        localStatus={
          row.localEndpoint
            ? `${formatLocalEndpointSummary(row.localEndpoint, now)?.replace("Local endpoint", "Local")} · ${formatWorkerActivity(
                view.kind === "ready" ? view.payload.workerActivity : undefined,
                row.provider,
                now,
              )
                .replace("running provider workers", "workers running")
                .replace("running provider worker", "worker running")}`
            : undefined
        }
        serverId={serverId}
        providerId={row.provider}
        name={row.name}
      />
    ),
    [view, now, serverId],
  );
  return (
    <View ref={controlsRef} style={controlsStyle} testID="preset-controls">
      <View ref={anchorRef} collapsable={false} style={styles.trigger}>
        <ComboboxTrigger
          style={styles.toolbarTrigger}
          accessibilityRole="button"
          accessibilityState={triggerAccessibilityState}
          onPress={show}
          disabled={selectionDisabled}
          accessibilityLabel={triggerCopy.accessibilityLabel}
          testID="agent-preset-selector"
        >
          <PresetStatusIcon
            waiting={waitingToOpen || Boolean(profiles.isApplying)}
            showWarning={showWarning}
            showRing={showRing}
            remaining={remaining}
            stale={Boolean(statusLabel)}
          />
          <ExecutionEnvironmentIcon serverId={serverId} />
          <Text style={styles.toolbarText} numberOfLines={1}>
            {triggerCopy.label}
          </Text>
        </ComboboxTrigger>
      </View>
      <Combobox
        options={vortonMode ? EMPTY_OPTIONS : options}
        value={selectedProfileId ?? ""}
        onSelect={vortonMode ? setInspectedId : select}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        title={vortonMode ? "" : "Presets"}
        mobileSnapPoints={vortonMode ? PROFILE_SNAP_POINTS : undefined}
        onActiveOptionChange={vortonMode ? undefined : setInspectedId}
        desktopPlacement="top-start"
        desktopMinWidth={Math.min(vortonMode ? 880 : 760, width - 32)}
        desktopFixedHeight={vortonMode ? 520 : 440}
        desktopPreventInitialFlash
        desktopLockWidth
        desktopChildrenScrollEnabled={false}
        mobileChildrenScrollEnabled={!vortonMode}
        keepOpenOnSelect
      >
        {vortonMode ? (
          <EnvironmentPresetMenu
            now={now}
            key={`${open}-${isCompact}`}
            serverId={serverId}
            profiles={profiles}
            selectedId={selectedProfileId}
            compact={isCompact}
            disabled={selectionDisabled}
            onApply={select}
            onClose={closeMenu}
            currentProvider={currentProvider}
            currentModel={currentModel}
            currentThinkingOptionId={currentThinkingOptionId}
          />
        ) : (
          <View style={isCompact || width < 760 ? styles.stacked : styles.split}>
            <View style={styles.list}>
              <EditingTextInput
                initialValue={query}
                onChangeText={setQuery}
                placeholder="Search presets"
                accessibilityLabel="Search presets"
                style={styles.search}
                autoFocus
              />
              <ScrollView style={styles.rows} keyboardShouldPersistTaps="handled">
                {visibleRows.map((row) => (
                  <PresetRow
                    key={row.id}
                    row={row}
                    rail={renderRail(row)}
                    selected={row.id === selectedProfileId}
                    active={row.id === inspected?.id}
                    disabled={disabled || profiles.isApplying || row.unavailable}
                    onSelect={select}
                  />
                ))}
                {!visibleRows.length ? <Text style={styles.meta}>No matching presets</Text> : null}
              </ScrollView>
              <View style={styles.manage}>{footer}</View>
            </View>
            {inspectorRow ? (
              <PresetInspector
                serverId={serverId}
                row={inspectorRow}
                definition={definition}
                worker={worker}
                rail={renderRail(inspectorRow)}
              />
            ) : null}
          </View>
        )}
      </Combobox>
    </View>
  );
}
function PresetRow({
  row,
  nickname,
  rail,
  selected,
  active,
  disabled,
  onSelect,
}: {
  row: AgentProfilePicker["rows"][number];
  nickname?: string;
  rail: ReactNode;
  selected: boolean;
  active: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
}) {
  const vortonMode = useVortonMode();
  const press = useCallback(() => onSelect(row.id), [onSelect, row.id]);
  return (
    <ComboboxItem
      style={[styles.row, vortonMode && styles.rowVorton]}
      labelStyle={styles.presetTitle}
      labelNumberOfLines={1}
      testID={`preset-row-${row.id}`}
      label={nickname ? `${nickname} · ${row.name}` : row.name}
      descriptionPlacement="below"
      descriptionSlot={rail}
      selectionPlacement="leading"
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={press}
    />
  );
}
function PresetInspector({
  serverId,
  row,
  definition,
  worker,
  rail,
}: {
  serverId: string | null;
  row: AgentProfilePicker["rows"][number];
  definition?: AgentProfile;
  worker?: AgentProfile;
  rail: ReactNode;
}) {
  let execution = "Direct provider session. No configured workers.";
  if (row.localEndpoint) execution = "Local inference through Pi.";
  if (worker)
    execution = `Supervises ${worker.name}. Up to ${definition?.maxWorkers ?? 2} local workers.`;
  const vortonMode = useVortonMode();
  return (
    <ScrollView
      style={[styles.inspector, vortonMode && styles.inspectorVorton]}
      contentContainerStyle={styles.inspectorContent}
    >
      <Text style={styles.title}>{row.name}</Text>
      {rail}
      <Text style={styles.label}>Configuration</Text>
      <Text style={styles.text}>{row.summary}</Text>
      {vortonMode && definition ? (
        <ProfileDetailsView serverId={serverId} profile={definition} />
      ) : null}
      <Text style={styles.label}>Execution</Text>
      <Text style={styles.text}>{execution}</Text>
      <Text style={styles.label}>Instructions</Text>
      <Text style={styles.text}>
        {definition?.instructions?.trim() || "No profile-specific instructions."}
      </Text>
      {!row.localEndpoint ? (
        <>
          <Text style={styles.label}>On quota exhaustion</Text>
          <Text style={styles.text}>
            Stop and suggest another profile. Never switch automatically.
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}
const styles = StyleSheet.create((theme) => ({
  touchControls: { flex: 1, flexWrap: "nowrap" },
  centerControls: { justifyContent: "center", marginHorizontal: 8 },
  controls: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  trigger: { minWidth: 0, maxWidth: 360, flexShrink: 1 },
  toolbarText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  toolbarTrigger: {
    gap: theme.spacing[2],
    height: 28,
    minHeight: 28,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    borderWidth: 0,
    borderRadius: theme.borderRadius["2xl"],
  },
  split: { flex: 1, minHeight: 0, flexDirection: "row", alignItems: "stretch" },
  row: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    minHeight: 68,
    height: Math.max(68, Math.ceil(theme.fontSize.base * 1.4) * 2 + 24),
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowVorton: { height: "auto" },
  stacked: { flex: 1, flexDirection: "column" },
  list: { flex: 1, minWidth: 0, borderRightWidth: 1, borderRightColor: theme.colors.border },
  rows: { flex: 1, minHeight: 0 },
  presetSearch: { backgroundColor: theme.colors.surface0 },
  presetTitle: {
    fontSize: theme.fontSize.base,
    lineHeight: Math.ceil(theme.fontSize.base * 1.4),
    marginBottom: 2,
    color: theme.colors.foreground,
  },
  search: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    padding: theme.spacing[4],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  manage: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  inspector: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.colors.surface2,
  },
  pendingRing: { width: 28, height: 28, marginRight: theme.spacing[1] },
  ring: { marginRight: theme.spacing[1] },
  manageVorton: { padding: theme.spacing[3] },
  inspectorVorton: { backgroundColor: theme.colors.surface1 },
  inspectorContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  title: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  text: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  label: {
    marginTop: theme.spacing[4],
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  meta: { fontSize: theme.fontSize.base, color: theme.colors.foregroundMuted },
  notice: { width: "100%", fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));
