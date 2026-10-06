import { ExecutionEnvironmentIcon } from "@/execution-installation/environment-icon";
import { EnvironmentPresetMenu } from "./environment-preset-menu";
import { AccountDisconnectedIcon } from "@/provider-usage/reconnect-control";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { ActivityIndicator, Text, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Combobox } from "@/components/ui/combobox";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePresetData } from "./use-preset-data";
import type { AgentProfilePicker } from "./internal/use-agent-profile-picker";
import { useAgentProfiles } from "./internal/use-agent-profiles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useVortonTouch } from "@/vorton-touch";
import { RemainingRing } from "@/provider-usage/remaining-ring";
import { useCompactProfileName } from "./use-compact-profile-name";
import { canonicalProfileId } from "@getpaseo/protocol/provider-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
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
  activeProfileId?: string;
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
  selectedProfileId: storedProfileId,
  selectedProfileName,
  activeProfileId,
  currentProvider,
  currentModel,
  currentThinkingOptionId,
  disabled,
}: PresetControlsProps) {
  const [open, setOpen] = useState(false);
  const panelActive = useRetainedPanelActive();
  const touch = useVortonTouch();
  const selectionDisabled = disabled || Boolean(profiles.isApplying);
  const controlsRef = useRef<View>(null);
  const triggerAccessibilityState = useMemo(
    () => ({ expanded: open, busy: Boolean(profiles.isApplying) }),
    [open, profiles.isApplying],
  );
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
  const { profiles: definitions, accountIndependent } = useAgentProfiles(serverId);
  const { config } = useDaemonConfig(serverId);
  const preferences = config?.sharedProviderPreferences;
  const selectedProfileId =
    storedProfileId && preferences && accountIndependent
      ? canonicalProfileId(storedProfileId, preferences, config.providers)
      : storedProfileId;
  const hasLocalEndpoint = profiles.rows.some((row) => Boolean(row.localEndpoint));
  const active = panelActive;
  const { view } = usePresetData(serverId, profiles, active);
  // Refresh visible usage in the background without gating the menu.
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
    setOpen(false);
  }, [serverId, active]);
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
      view,
      now,
    });
  const show = useCallback(() => {
    setOpen(true);
  }, []);
  const select = useCallback(
    (
      id: string,
      choices?: Partial<Pick<AgentProfile, "provider" | "model" | "thinkingOptionId">>,
    ) => {
      if (disabled || profiles.isApplying) return;
      profiles.applyProfile(id, choices);
      setOpen(false);
    },
    [disabled, profiles],
  );
  const closeMenu = useCallback(() => setOpen(false), []);
  return (
    <View ref={controlsRef} style={controlsStyle} testID="preset-controls">
      <View ref={anchorRef} collapsable={false} style={styles.trigger}>
        <ComboboxTrigger
          style={styles.toolbarTrigger}
          accessibilityRole="button"
          accessibilityState={triggerAccessibilityState}
          onPress={show}
          disabled={selectionDisabled}
          accessibilityLabel={accessibilityLabel}
          testID="agent-preset-selector"
        >
          <PresetStatusIcon
            waiting={Boolean(profiles.isApplying)}
            showWarning={showWarning}
            showRing={showRing}
            remaining={remaining}
            stale={Boolean(statusLabel)}
          />
          <ExecutionEnvironmentIcon serverId={serverId} />
          <Text style={styles.toolbarText} numberOfLines={1}>
            {triggerLabel}
          </Text>
        </ComboboxTrigger>
      </View>
      <Combobox
        options={EMPTY_OPTIONS}
        value={selectedProfileId ?? ""}
        onSelect={select}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        title=""
        mobileSnapPoints={PROFILE_SNAP_POINTS}
        desktopPlacement="top-start"
        desktopMinWidth={Math.min(1040, width - 32)}
        desktopFixedHeight={520}
        desktopPreventInitialFlash
        desktopLockWidth
        desktopChildrenScrollEnabled={false}
        mobileChildrenScrollEnabled={false}
        keepOpenOnSelect
      >
        <EnvironmentPresetMenu
          now={now}
          key={`${open}-${isCompact}`}
          serverId={serverId}
          profiles={profiles}
          selectedId={selectedProfileId}
          activeProfileId={
            activeProfileId && preferences && accountIndependent
              ? canonicalProfileId(activeProfileId, preferences, config.providers)
              : activeProfileId
          }
          compact={isCompact}
          disabled={selectionDisabled}
          onApply={select}
          onClose={closeMenu}
          currentProvider={currentProvider}
          currentModel={currentModel}
          currentThinkingOptionId={currentThinkingOptionId}
        />
      </Combobox>
    </View>
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
  pendingRing: { width: 28, height: 28, marginRight: theme.spacing[1] },
  ring: { marginRight: theme.spacing[1] },
}));
