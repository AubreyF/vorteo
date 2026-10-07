import { ChooserReveal } from "./chooser-reveal";
import { ExecutionEnvironmentIcon } from "@/execution-installation/environment-icon";
import { CliUpdateWarning } from "@/provider-selection/cli-update-warning";
import { useVortonTouch } from "@/vorton-touch";
import { ProfileAction } from "./profile-action";
import { ProfileSelectorTile, ProfileLoading } from "./profile-selector-tile";
import { profileCatalogState, sharedChoiceState, type LaunchChoices } from "./shared-choices";
import { useCallback, useMemo, useReducer, useState, type ReactNode } from "react";
import {
  Keyboard,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { ProfileDetailsView } from "./profile-details-view";
import { type AccountPresets } from "./account-presets";
import type { AgentProfilePickerRow } from "./internal/use-agent-profile-picker";

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
  hideEnvironment?: boolean;
  onEnvironment: (serverId: string) => void;
  loading?: boolean;
  error?: string | null;
  accounts: AccountPresets[];
  definitions: readonly AgentProfile[];
  entries: ProviderSnapshotEntry[] | undefined;
  inspectedId: string | undefined;
  inspectedProvider: string | undefined;
  onAccount: (provider: string) => void;
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
  onRetry: () => void;
  retrying: boolean;
  renderRail: (row: AgentProfilePickerRow) => ReactNode;
  renderBadge: (row: AgentProfilePickerRow) => ReactNode;
  renderAccountDetails: (row: AgentProfilePickerRow) => ReactNode;
}

export function AccountPresetMenu(props: AccountPresetMenuProps) {
  const { accounts, inspectedId, compact, onEnvironment } = props;
  const touch = useVortonTouch();
  const headerSize = compact || touch ? "md" : "sm";
  const [navigation, dispatch] = useReducer(selectorNavigation, {
    section: "profile",
  });
  const account =
    accounts.find((group) => group.provider === props.inspectedProvider) ?? accounts[0];
  const rows = useMemo(() => {
    const entry = props.entries?.find((item) => item.provider === account?.provider);
    return (account?.rows ?? []).filter((row) => {
      const profile = props.definitions.find((item) => item.id === row.id);
      return profile && !sharedChoiceState({ profile, choices: {}, entry }).unavailable;
    });
  }, [account, props.entries, props.definitions]);
  const inspected = rows.find((row) => row.id === inspectedId) ?? rows[0];
  const environment = props.environments.find((item) => item.serverId === props.serverId);
  const { onAccount } = props;
  const inspectAccount = useCallback(
    (id: string) => {
      onAccount(id);
      Keyboard.dismiss();
      dispatch({ type: "account" });
    },
    [onAccount],
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
        serverId={props.serverId}
        loading={props.loading}
        error={props.error}
        onInspect={inspectAccount}
        renderBadge={props.renderBadge}
        renderAccountDetails={props.renderAccountDetails}
      />
    ),
    [accounts, account, props, inspectAccount],
  );
  const profileLabel = inspected?.id === inspectedId ? inspected?.name : undefined;
  const profileHeading = useMemo(
    () =>
      compact ? (
        <SectionButton
          section="profile"
          label="Profile"
          value={profileLabel}
          expanded
          onSection={showSection}
        />
      ) : (
        <ColumnHeading section="profile" label="Profile" />
      ),
    [compact, showSection, profileLabel],
  );
  const details = useMemo(
    () =>
      account ? (
        <AccountChoices
          {...props}
          account={account}
          inspected={inspected}
          rows={rows}
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
    [account, inspected, rows, props, profileHeading],
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
          hideEnvironment={props.hideEnvironment}
          navigation={navigation.section}
          onSection={showSection}
          environmentLabel={environment?.label ?? "Current environment"}
          accountLabel={account?.label ?? ""}
          profileLabel={profileLabel}
          environmentIcon={environmentIcon}
          environments={environments}
          accounts={list}
          details={details}
        />
      ) : (
        <View style={styles.split}>
          {!props.hideEnvironment ? (
            <View
              style={[settingsStyles.card, styles.environmentCard]}
              testID="preset-environment-card"
            >
              <ColumnHeading section="environment" label="Environment" />
              <ScrollView>{environments}</ScrollView>
            </View>
          ) : null}
          <View style={[settingsStyles.card, styles.accountCard]}>
            <ColumnHeading section="account" label="Account" />
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
  serverId,
  loading,
  error,
  onInspect,
  renderBadge,
  renderAccountDetails,
}: {
  accounts: AccountPresets[];
  account: AccountPresets | undefined;
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
      {accounts.map((group, index) => (
        <ChooserReveal
          key={`${serverId}:${group.provider}`}
          index={index}
          testID={`preset-reveal-account-${group.provider}`}
        >
          <AccountButton
            serverId={serverId}
            group={group}
            active={group === account}
            onInspect={onInspect}
            renderBadge={renderBadge}
            renderAccountDetails={renderAccountDetails}
          />
        </ChooserReveal>
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
  hideEnvironment,
  navigation,
  onSection,
  environmentLabel,
  accountLabel,
  profileLabel,
  environmentIcon,
  environments,
  accounts,
  details,
}: {
  navigation: SelectorSection;
  onSection: (section: SelectorSection) => void;
  environmentLabel: string;
  accountLabel: string;
  profileLabel?: string;
  environmentIcon: ReactNode;
  environments: ReactNode;
  hideEnvironment?: boolean;
  accounts: ReactNode;
  details: ReactNode;
}) {
  return (
    <View style={styles.compactBody}>
      {!hideEnvironment ? (
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
      ) : null}
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
              value={profileLabel}
              expanded={false}
              onSection={onSection}
            />
          </View>
        )}
      </View>
    </View>
  );
}
const sectionNumbers: Record<SelectorSection, number> = { environment: 1, account: 2, profile: 3 };

function StepIcon({ section }: { section: SelectorSection }) {
  return (
    <View
      style={styles.stepIcon}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={styles.stepNumber}>{sectionNumbers[section]}</Text>
    </View>
  );
}

function ColumnHeading({ section, label }: { section: SelectorSection; label: string }) {
  return (
    <View
      style={styles.cardHeading}
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${sectionNumbers[section]}. ${label}`}
    >
      <StepIcon section={section} />
      <Text style={styles.cardHeadingText}>{label}</Text>
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
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const content = useMemo(
    () => (
      <View style={styles.sectionRow}>
        <View style={styles.sectionLabelHalf}>
          <View style={styles.sectionIcons}>
            <StepIcon section={section} />
            {icon}
          </View>
          <Text style={styles.sectionLabel} numberOfLines={1}>
            {label}
            {value ? ":" : ""}
          </Text>
        </View>
        <View style={styles.sectionValueHalf}>
          <Text style={styles.sectionValue} numberOfLines={1}>
            {value ?? ""}
          </Text>
          {expanded ? <ThemedChevronUp /> : <ThemedChevronDown />}
        </View>
      </View>
    ),
    [section, icon, label, value, expanded],
  );
  return (
    <Button
      variant="ghost"
      size="md"
      onPress={press}
      style={styles.sectionButton}
      accessibilityLabel={`${sectionNumbers[section]}. ${label}${value ? `: ${value}` : ""}`}
      accessibilityState={accessibilityState}
      trailing={content}
      testID={`preset-section-${section}`}
    />
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
  onInspect,
  renderBadge,
  renderAccountDetails,
}: {
  serverId: string | null;
  group: AccountPresets;
  active: boolean;
  onInspect: (id: string) => void;
  renderBadge: AccountPresetMenuProps["renderBadge"];
  renderAccountDetails: AccountPresetMenuProps["renderAccountDetails"];
}) {
  const select = useCallback(() => onInspect(group.provider), [group.provider, onInspect]);
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

interface AccountChoicesProps extends AccountPresetMenuProps {
  account: AccountPresets;
  inspected: AgentProfilePickerRow | undefined;
  rows: AgentProfilePickerRow[];
  heading: ReactNode;
}

function AccountChoices(props: AccountChoicesProps) {
  const entry = props.entries?.find((candidate) => candidate.provider === props.account.provider);
  const catalogState = profileCatalogState(entry);
  const loading = !props.error && catalogState === "loading";
  let catalogError = props.error;
  if (catalogState === "error") {
    catalogError = props.error ?? entry?.error ?? "Could not load profiles for this account.";
  }
  if (!loading && !catalogError) return <ReadyAccountChoices {...props} />;
  return (
    <View style={[settingsStyles.card, styles.detailCard]} testID="preset-profile-card">
      {props.heading}
      {loading ? (
        <ProfileLoading label="Loading profiles" />
      ) : (
        <View style={styles.choices}>
          <Text style={styles.summary} testID="preset-catalog-error">
            {catalogError}
          </Text>
          <Button
            variant="ghost"
            size="md"
            onPress={props.onRetry}
            disabled={props.retrying}
            testID="preset-retry-profiles"
          >
            {props.retrying ? "Retrying…" : "Retry"}
          </Button>
        </View>
      )}
    </View>
  );
}

function ReadyAccountChoices({ account, inspected, rows, heading, ...props }: AccountChoicesProps) {
  const { width } = useWindowDimensions();
  const [listWidth, setListWidth] = useState(0);
  const measureList = useCallback((event: LayoutChangeEvent) => {
    setListWidth(event.nativeEvent.layout.width);
  }, []);
  const grid = props.compact ? listWidth >= 340 : width >= 1100;
  const DetailScrollView = props.compact ? BottomSheetScrollView : ScrollView;
  const inspectedId = inspected?.id;
  const entry = props.entries?.find((candidate) => candidate.provider === account.provider);
  const saved = props.definitions.find((profile) => profile.id === inspectedId);
  const definition = useMemo(
    () => (saved ? { ...saved, provider: account.provider } : undefined),
    [saved, account.provider],
  );
  const { onApply } = props;
  const apply = useCallback(() => {
    if (inspected) onApply(inspected.id, { provider: account.provider });
  }, [onApply, inspected, account.provider]);
  const isActive =
    props.serverId === props.activeServerId &&
    account.provider === props.currentProvider &&
    inspectedId === props.activeProfileId;
  const hasSelection = Boolean(inspected && inspected.id === props.inspectedId);
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
            {props.compact && inspected ? props.renderRail(inspected) : null}
            <View onLayout={measureList} style={[styles.profileList, grid && styles.profileGrid]}>
              {rows.map((row, index) => (
                <ChooserReveal
                  key={`${props.serverId}:${account.provider}:${row.id}`}
                  index={index}
                  sweep
                  style={grid ? styles.gridChoice : undefined}
                  testID={`preset-reveal-profile-${row.id}`}
                >
                  <ProfileChoice
                    row={row}
                    selected={hasSelection && row.id === inspectedId}
                    definition={props.definitions.find((profile) => profile.id === row.id)}
                    entry={entry}
                    onInspect={props.onInspect}
                  />
                </ChooserReveal>
              ))}
            </View>
            <ChooserReveal
              key={`${props.serverId}:${inspectedId}`}
              sweep
              style={styles.profileDetails}
            >
              {rows.length === 0 ? (
                <Text style={styles.summary} testID="preset-no-compatible-profiles">
                  No saved profiles match this account’s available models and reasoning levels.
                  Manage profiles to review their requirements.
                </Text>
              ) : null}
              {inspected?.localEndpoint ? props.renderRail(inspected) : null}
              {definition ? (
                <ProfileDetailsView serverId={props.serverId} profile={definition} compact />
              ) : null}
              <WorkflowInstructions definition={definition} definitions={props.definitions} />
            </ChooserReveal>
          </View>
        </DetailScrollView>
      </View>
      <ProfileAction
        visible={showAction}
        disabled={props.disabled || inspected?.unavailable}
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
  selected,
  definition,
  entry,
  onInspect,
}: {
  row: AgentProfilePickerRow;
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
    paddingTop: 0,
    gap: theme.spacing[2],
  },
  environmentCard: { flex: 0.9, minWidth: 240 },
  accountCard: { flex: 1.3, minWidth: 320 },
  profileCard: { flex: 1.7, minWidth: 0 },
  sectionIcons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginRight: theme.spacing[2],
  },
  stepIcon: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.foreground,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumber: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: theme.iconSize.md - 2,
  },
  cardHeading: {
    padding: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cardHeadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  accountList: { padding: theme.spacing[2], gap: theme.spacing[1] },
  profileList: { gap: theme.spacing[2] },
  profileDetails: { gap: theme.spacing[3] },
  profileGrid: { flexDirection: "row", flexWrap: "wrap" },
  gridChoice: { width: "48%", flexGrow: 1 },
  sectionContent: {
    paddingHorizontal: theme.spacing[3],
    lineHeight: Math.ceil(theme.fontSize.base * 1.5),
  },
  compactBody: { flex: 1, minHeight: 0, padding: theme.spacing[3], gap: theme.spacing[2] },
  compactList: { maxHeight: 220 },
  compactProfile: { flex: 1, minHeight: 0 },
  sectionButton: { paddingHorizontal: theme.spacing[2], borderRadius: theme.borderRadius.lg },
  sectionRow: { flex: 1, flexDirection: "row", alignItems: "center" },
  sectionLabelHalf: {
    width: "50%",
    flexDirection: "row",
    alignItems: "center",
    paddingRight: theme.spacing[2],
  },
  sectionLabel: {
    flex: 1,
    textAlign: "right",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  sectionValueHalf: {
    width: "50%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
  },
  sectionValue: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
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
