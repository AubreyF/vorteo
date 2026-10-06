import { ExecutionEnvironmentIcon } from "@/execution-installation/environment-icon";
import { CliUpdateWarning } from "@/provider-selection/cli-update-warning";
import { useVortonTouch } from "@/vorton-touch";
import { ProfileAction } from "./profile-action";
import { ProfileSelectorTile, ProfileLoading } from "./profile-selector-tile";
import { sharedChoiceState, type LaunchChoices } from "./shared-choices";
import { useCallback, useMemo, useReducer, type ReactNode } from "react";
import { Keyboard, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile, ProviderPreferences } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { ProfileDetailsView } from "./profile-details-view";
import { type AccountPresets } from "./account-presets";
import type { AgentProfilePickerRow } from "./internal/use-agent-profile-picker";
import {
  isSharedWorkflowProfile,
  resolveProviderType,
  sharedWorkflowProfileId,
} from "@getpaseo/protocol/provider-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";

import { withUnistyles } from "react-native-unistyles";
import { type ProviderIconComponent, useProviderIcon } from "@/components/provider-icons";
import { settingsStyles } from "@/styles/settings";
import { selectorNavigation, type SelectorSection } from "./selector-navigation";

const ThemedChevronUp = withUnistyles(ChevronUp, (theme) => ({
  size: theme.iconSize.sm,
  color: theme.colors.foregroundMuted,
}));
const ThemedChevronDown = withUnistyles(ChevronDown, (theme) => ({
  size: theme.iconSize.sm,
  color: theme.colors.foregroundMuted,
}));

export interface PresetEnvironment {
  serverId: string;
  label: string;
  available: boolean;
  description?: string;
}

interface AccountPresetMenuProps {
  serverId: string | null;
  environments: PresetEnvironment[];
  onEnvironment: (serverId: string) => void;
  loading?: boolean;
  error?: string | null;
  accounts: AccountPresets[];
  definitions: readonly AgentProfile[];
  entries: ProviderSnapshotEntry[] | undefined;
  inspectedId: string | undefined;
  selectedId: string | undefined;
  activeProfileId: string | undefined;
  activeServerId: string | null;
  compact: boolean;
  disabled: boolean;
  currentProvider?: string;
  currentModel?: string | null;
  currentThinkingOptionId?: string | null;
  onInspect: (id: string) => void;
  onApply: (id: string, choices?: LaunchChoices) => void;
  onManage: () => void;
  renderRail: (row: AgentProfilePickerRow) => ReactNode;
  renderBadge: (row: AgentProfilePickerRow) => ReactNode;
  renderAccountDetails: (row: AgentProfilePickerRow) => ReactNode;
}

export function AccountPresetMenu(props: AccountPresetMenuProps) {
  const { accounts, inspectedId, selectedId, compact, onInspect, onEnvironment } = props;
  const touch = useVortonTouch();
  const headerSize = compact || touch ? "md" : "sm";
  const [navigation, dispatch] = useReducer(selectorNavigation, {
    section: "profile",
  });
  const account =
    accounts.find((group) => group.rows.some((row) => row.id === inspectedId)) ?? accounts[0];
  const inspected = account?.rows.find((row) => row.id === inspectedId) ?? account?.rows[0];
  const environment = props.environments.find((item) => item.serverId === props.serverId);
  const { preferences, family, retainWorkflow } = useSharedChoices(props, account);
  const inspectAccount = useCallback(
    (id: string) => {
      onInspect(retainWorkflow(id));
      Keyboard.dismiss();
      dispatch({ type: "account" });
    },
    [onInspect, retainWorkflow],
  );
  const selectEnvironment = useCallback(
    (id: string) => {
      onEnvironment(id);
      dispatch({ type: "environment" });
    },
    [onEnvironment],
  );
  const showSection = useCallback(
    (section: SelectorSection) => dispatch({ type: "section", section }),
    [],
  );
  const list = useMemo(
    () => (
      <AccountList
        accounts={accounts}
        account={account}
        selectedId={selectedId}
        serverId={props.serverId}
        loading={props.loading}
        error={props.error}
        onInspect={inspectAccount}
        renderBadge={props.renderBadge}
        renderAccountDetails={props.renderAccountDetails}
      />
    ),
    [accounts, account, selectedId, props, inspectAccount],
  );
  const profileHeading = useMemo(
    () =>
      compact ? (
        <SectionButton section="profile" label="Profile" expanded onSection={showSection} />
      ) : (
        <Text style={styles.cardHeading}>Profile</Text>
      ),
    [compact, showSection],
  );
  const details = useMemo(
    () =>
      account && inspected ? (
        <AccountChoices
          {...props}
          account={account}
          inspected={inspected}
          preferences={preferences}
          family={family}
          heading={profileHeading}
        />
      ) : (
        <View style={[settingsStyles.card, styles.detailCard]}>
          {profileHeading}
          {props.loading ? (
            <ProfileLoading label="Loading profiles" />
          ) : (
            <Text style={styles.empty}>Select an account</Text>
          )}
        </View>
      ),
    [account, inspected, props, preferences, family, profileHeading],
  );
  const environments = useMemo(
    () => (
      <View style={styles.accountList}>
        {props.environments.map((item) => (
          <EnvironmentButton
            key={item.serverId}
            environment={item}
            selected={item.serverId === props.serverId}
            onSelect={selectEnvironment}
          />
        ))}
      </View>
    ),
    [props.environments, props.serverId, selectEnvironment],
  );
  const environmentIcon = useMemo(
    () => <ExecutionEnvironmentIcon serverId={props.serverId} />,
    [props.serverId],
  );
  return (
    <View style={styles.root} testID="account-preset-menu">
      <View style={styles.header}>
        <Text style={styles.menuTitle}>Choose profile</Text>
        {!compact ? (
          <Button
            variant="ghost"
            size={headerSize}
            onPress={props.onManage}
            testID="preset-manage-profiles"
          >
            Manage profiles
          </Button>
        ) : null}
      </View>
      {compact ? (
        <CompactSelector
          navigation={navigation.section}
          onSection={showSection}
          environmentLabel={environment?.label ?? "Current environment"}
          accountLabel={account?.label ?? "Select account"}
          environmentIcon={environmentIcon}
          environments={environments}
          accounts={list}
          details={details}
        />
      ) : (
        <View style={styles.split}>
          <View
            style={[settingsStyles.card, styles.environmentCard]}
            testID="preset-environment-card"
          >
            <Text style={styles.cardHeading}>Environment</Text>
            <ScrollView>{environments}</ScrollView>
          </View>
          <View style={[settingsStyles.card, styles.accountCard]}>
            <Text style={styles.cardHeading}>Account</Text>
            <ScrollView keyboardShouldPersistTaps="handled">{list}</ScrollView>
          </View>
          <View style={styles.profileCard}>{details}</View>
        </View>
      )}
    </View>
  );
}

function AccountList({
  accounts,
  account,
  selectedId,
  serverId,
  loading,
  error,
  onInspect,
  renderBadge,
  renderAccountDetails,
}: {
  accounts: AccountPresets[];
  account: AccountPresets | undefined;
  selectedId: string | undefined;
  serverId: string | null;
  loading?: boolean;
  error?: string | null;
  onInspect: (id: string) => void;
  renderBadge: AccountPresetMenuProps["renderBadge"];
  renderAccountDetails: AccountPresetMenuProps["renderAccountDetails"];
}) {
  const empty = !loading && !error && !accounts.length;
  return (
    <View style={styles.accountList}>
      {accounts.map((group) => (
        <AccountButton
          key={group.provider}
          serverId={serverId}
          group={group}
          active={group === account}
          selectedId={selectedId}
          onInspect={onInspect}
          renderBadge={renderBadge}
          renderAccountDetails={renderAccountDetails}
        />
      ))}
      {loading ? <ProfileLoading label="Loading accounts" /> : null}
      {error ? (
        <Text style={styles.empty} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {empty ? <Text style={styles.empty}>No matching accounts</Text> : null}
    </View>
  );
}

function CompactSelector({
  navigation,
  onSection,
  environmentLabel,
  accountLabel,
  environmentIcon,
  environments,
  accounts,
  details,
}: {
  navigation: SelectorSection;
  onSection: (section: SelectorSection) => void;
  environmentLabel: string;
  accountLabel: string;
  environmentIcon: ReactNode;
  environments: ReactNode;
  accounts: ReactNode;
  details: ReactNode;
}) {
  return (
    <View style={styles.compactBody}>
      <View style={settingsStyles.card}>
        <SectionButton
          section="environment"
          label="Environment"
          value={environmentLabel}
          icon={environmentIcon}
          expanded={navigation === "environment"}
          onSection={onSection}
        />
        {navigation === "environment" ? (
          <BottomSheetScrollView style={styles.compactList}>{environments}</BottomSheetScrollView>
        ) : null}
      </View>
      <View style={settingsStyles.card}>
        <SectionButton
          section="account"
          label="Account"
          value={accountLabel}
          expanded={navigation === "account"}
          onSection={onSection}
        />
        {navigation === "account" ? (
          <BottomSheetScrollView style={styles.compactList} keyboardShouldPersistTaps="handled">
            {accounts}
          </BottomSheetScrollView>
        ) : null}
      </View>
      <View style={navigation === "profile" && styles.compactProfile}>
        {navigation === "profile" ? (
          details
        ) : (
          <View style={settingsStyles.card}>
            <SectionButton
              section="profile"
              label="Profile"
              expanded={false}
              onSection={onSection}
            />
          </View>
        )}
      </View>
    </View>
  );
}
function SectionButton({
  section,
  label,
  value,
  icon,
  expanded,
  onSection,
}: {
  section: SelectorSection;
  label: string;
  value?: string;
  icon?: ReactNode;
  expanded: boolean;
  onSection: (section: SelectorSection) => void;
}) {
  const press = useCallback(() => onSection(section), [section, onSection]);
  const leadingIcon = useMemo(() => (icon ? <View>{icon}</View> : null), [icon]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const chevron = useMemo(
    () => (expanded ? <ThemedChevronUp /> : <ThemedChevronDown />),
    [expanded],
  );
  return (
    <Button
      variant="ghost"
      size="md"
      onPress={press}
      leftIcon={leadingIcon}
      style={styles.sectionButton}
      accessibilityLabel={`${label}${value ? `: ${value}` : ""}`}
      accessibilityState={accessibilityState}
      trailing={chevron}
      testID={`preset-section-${section}`}
    >
      {label}
      {value ? `   ${value}` : ""}
    </Button>
  );
}
function EnvironmentButton({
  environment,
  selected,
  onSelect,
}: {
  environment: PresetEnvironment;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const environmentIcon = useMemo(
    () => <ExecutionEnvironmentIcon serverId={environment.serverId} />,
    [environment.serverId],
  );
  const select = useCallback(
    () => onSelect(environment.serverId),
    [onSelect, environment.serverId],
  );
  return (
    <ProfileSelectorTile
      label={environment.label}
      leading={environmentIcon}
      selected={selected}
      disabled={!environment.available}
      subtitle={environment.available ? (environment.description ?? "Connected") : "Disconnected"}
      onPress={select}
      testID={`preset-environment-${environment.serverId}`}
    />
  );
}

function useSharedChoices(props: AccountPresetMenuProps, account: AccountPresets | undefined) {
  const { config } = useDaemonConfig(props.serverId);
  const providerType = account
    ? resolveProviderType(account.provider, config?.providers ?? {})
    : "";
  const family = useMemo(
    () =>
      (props.entries ?? []).filter(
        (entry) => resolveProviderType(entry.provider, config?.providers ?? {}) === providerType,
      ),
    [props.entries, config, providerType],
  );
  const preferences = config?.sharedProviderPreferences?.providers[providerType];
  const retainWorkflow = useCallback(
    (id: string) => {
      const target = props.definitions.find((profile) => profile.id === id);
      const current = props.definitions.find(
        (profile) => profile.id === (props.inspectedId ?? props.selectedId),
      );
      if (!target || !current || !isSharedWorkflowProfile(current.id)) return id;
      const ancestry = config?.providers ?? {};
      if (
        resolveProviderType(target.provider, ancestry) !==
        resolveProviderType(current.provider, ancestry)
      )
        return id;
      const matching = sharedWorkflowProfileId(
        target.provider,
        decodeURIComponent(current.id.split("/")[2]),
      );
      return props.definitions.some((profile) => profile.id === matching) ? matching : id;
    },
    [props.definitions, props.inspectedId, props.selectedId, config],
  );
  return { preferences, family, retainWorkflow };
}

function ProviderGlyph({
  Icon,
  size,
  color,
}: {
  Icon: ProviderIconComponent;
  size: number;
  color: string;
}) {
  return <Icon size={size} color={color} />;
}
const ThemedProviderGlyph = withUnistyles(ProviderGlyph, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
}));

function AccountButton({
  serverId,
  group,
  active,
  selectedId,
  onInspect,
  renderBadge,
  renderAccountDetails,
}: {
  serverId: string | null;
  group: AccountPresets;
  active: boolean;
  selectedId: string | undefined;
  onInspect: (id: string) => void;
  renderBadge: AccountPresetMenuProps["renderBadge"];
  renderAccountDetails: AccountPresetMenuProps["renderAccountDetails"];
}) {
  const select = useCallback(
    () => onInspect(group.rows.find((row) => row.id === selectedId)?.id ?? group.rows[0].id),
    [group, selectedId, onInspect],
  );
  const ProviderIcon = useProviderIcon(group.provider, serverId);
  const icon = useMemo(() => <ThemedProviderGlyph Icon={ProviderIcon} />, [ProviderIcon]);

  return (
    <ProfileSelectorTile
      leading={icon}
      badge={renderBadge(group.rows[0])}
      subtitle={renderAccountDetails(group.rows[0])}
      label={group.label}
      selected={active}
      onPress={select}
      testID={`preset-account-${group.provider}`}
    />
  );
}

function AccountChoices({
  account,
  inspected,
  preferences,
  family,
  heading,
  ...props
}: AccountPresetMenuProps & {
  account: AccountPresets;
  inspected: AgentProfilePickerRow;
  preferences: ProviderPreferences | undefined;
  family: ProviderSnapshotEntry[];
  heading: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const grid = !props.compact && width >= 1100;
  const DetailScrollView = props.compact ? BottomSheetScrollView : ScrollView;
  const entry = props.entries?.find((candidate) => candidate.provider === account.provider);
  const definition = props.definitions.find((profile) => profile.id === inspected.id);
  const shared = isSharedWorkflowProfile(inspected.id);
  const selection = useMemo(
    () =>
      definition
        ? sharedChoiceState({ profile: definition, choices: {}, entry, preferences, family })
        : null,
    [definition, entry, preferences, family],
  );
  const selectionUnavailable = shared && Boolean(selection?.unavailable);
  const { onApply } = props;
  const apply = useCallback(() => onApply(inspected.id), [onApply, inspected.id]);
  const isActive =
    props.serverId === props.activeServerId && inspected.id === props.activeProfileId;
  const hasSelection = Boolean(props.inspectedId || props.activeProfileId);
  const showAction = hasSelection && !isActive;
  const actionLabel = props.activeProfileId ? "Switch to Profile" : "Activate Profile";
  return (
    <View style={styles.detail} testID={`preset-choices-${account.provider}`}>
      <View style={[settingsStyles.card, styles.detailCard]} testID="preset-profile-card">
        {heading}
        <DetailScrollView
          testID="preset-profile-scroll"
          style={styles.detailScroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.choices}>
            <CliUpdateWarning update={entry?.cliUpdate} />
            {props.compact && !inspected.localEndpoint ? props.renderRail(inspected) : null}
            <View style={[styles.profileList, grid && styles.profileGrid]}>
              {account.rows.map((row) => (
                <ProfileChoice
                  key={row.id}
                  row={row}
                  grid={grid}
                  selected={hasSelection && row.id === inspected.id}
                  definition={props.definitions.find((profile) => profile.id === row.id)}
                  entry={entry}
                  onInspect={props.onInspect}
                />
              ))}
            </View>
            {selectionUnavailable ? (
              <Text style={styles.summary}>
                This saved profile is unavailable on this account. Choose another profile or update
                it in Settings.
              </Text>
            ) : null}
            {inspected.localEndpoint ? props.renderRail(inspected) : null}
            {definition ? (
              <ProfileDetailsView serverId={props.serverId} profile={definition} compact />
            ) : null}
            <WorkflowInstructions definition={definition} definitions={props.definitions} />
          </View>
        </DetailScrollView>
      </View>
      <ProfileAction
        visible={showAction}
        disabled={props.disabled || inspected.unavailable || selectionUnavailable}
        onPress={apply}
        label={actionLabel}
      />
    </View>
  );
}

function WorkflowInstructions({
  definition,
  definitions,
}: {
  definition: AgentProfile | undefined;
  definitions: readonly AgentProfile[];
}) {
  return (
    <>
      {definition?.instructions ? (
        <>
          <Text style={styles.label}>Instructions</Text>
          <Text style={[styles.summary, styles.sectionContent]}>{definition.instructions}</Text>
        </>
      ) : null}
      {definition?.workerProfileId ? (
        <>
          <Text style={styles.label}>Workers</Text>
          <Text style={[styles.summary, styles.sectionContent]}>
            {definitions.find((profile) => profile.id === definition.workerProfileId)?.name ??
              definition.workerProfileId}{" "}
            · Up to {definition.maxWorkers ?? 2}
          </Text>
        </>
      ) : null}
    </>
  );
}

function ProfileChoice({
  row,
  grid,
  selected,
  definition,
  entry,
  onInspect,
}: {
  row: AgentProfilePickerRow;
  grid: boolean;
  selected: boolean;
  definition: AgentProfile | undefined;
  entry: ProviderSnapshotEntry | undefined;
  onInspect: (id: string) => void;
}) {
  const select = useCallback(() => onInspect(row.id), [onInspect, row.id]);
  const model = entry?.models?.find((item) => item.id === definition?.model);
  const reasoning =
    model?.thinkingOptions?.find((item) => item.id === definition?.thinkingOptionId)?.label ??
    definition?.thinkingOptionId;
  const summary = [model?.label ?? definition?.model ?? "Provider default model", reasoning]
    .filter(Boolean)
    .join(" · ");
  return (
    <ProfileSelectorTile
      label={row.name}
      subtitle={summary}
      selected={selected}
      onPress={select}
      style={grid ? styles.gridChoice : undefined}
      testID={`preset-row-${row.id}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    paddingLeft: theme.spacing[6],
  },
  menuTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  split: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  environmentCard: { flex: 1.1, minWidth: 260 },
  accountCard: { flex: 1.1, minWidth: 260 },
  profileCard: { flex: 1.7, minWidth: 0 },
  cardHeading: {
    padding: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  accountList: { padding: theme.spacing[2], gap: theme.spacing[1] },
  profileList: { gap: theme.spacing[2] },
  profileGrid: { flexDirection: "row", flexWrap: "wrap" },
  gridChoice: { width: "48%", flexGrow: 1 },
  sectionContent: {
    paddingHorizontal: theme.spacing[3],
    lineHeight: Math.ceil(theme.fontSize.base * 1.5),
  },
  compactBody: { flex: 1, minHeight: 0, padding: theme.spacing[3], gap: theme.spacing[2] },
  compactList: { maxHeight: 220 },
  compactProfile: { flex: 1, minHeight: 0 },
  sectionButton: { justifyContent: "space-between" },
  detail: { flex: 1, minHeight: 0 },
  detailCard: { flex: 1, minHeight: 0, overflow: "hidden" },
  account: {
    padding: theme.spacing[1],
  },
  detailScroll: { flex: 1, minHeight: 0 },
  choices: { padding: theme.spacing[2], gap: theme.spacing[3] },
  heading: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  label: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  summary: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  empty: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
