import { useAppSettings } from "@/hooks/use-settings";
import { installationProviderReference } from "@getpaseo/protocol/installation-settings";
import { sharedChoiceState } from "./shared-choices";
import { defaultProfile } from "./internal/default-profile";
import {
  isSharedWorkflowProfile,
  sharedWorkflowProfileId,
} from "@getpaseo/protocol/provider-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useCallback, useMemo, useState } from "react";
import { useAgentProfiles } from "./internal/use-agent-profiles";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "@/execution-installation/policy";
import {
  isEnvironmentAllowed,
  isProfileAllowed,
  readProjectPolicy,
} from "@/projects/project-policy";
import { AccountPresetMenu, type PresetEnvironment } from "./account-preset-menu";
import { accountPresets } from "./account-presets";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import {
  formatLocalEndpointSummary,
  formatWorkerActivity,
} from "@/provider-usage/local-endpoint-summary";
import { AccountUsageBadge, AccountUsageDetails } from "./account-usage";
import { PresetUsageRail } from "./preset-usage-rail";
import { usePresetData } from "./use-preset-data";
import type {
  AgentProfilePicker,
  AgentProfilePickerRow,
} from "./internal/use-agent-profile-picker";
import type { LaunchChoices } from "./shared-choices";
import { useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

interface EnvironmentPresetMenuProps {
  inline?: boolean;
  serverId: string | null;
  profiles: AgentProfilePicker;
  selectedId?: string;
  activeProfileId?: string;
  compact: boolean;
  disabled: boolean;
  now: number;
  currentProvider?: string;
  currentModel?: string | null;
  currentThinkingOptionId?: string | null;
  onApply: (id: string, choices?: LaunchChoices) => void;
  onClose: () => void;
}
export function EnvironmentPresetMenu(props: EnvironmentPresetMenuProps) {
  const { settings } = useAppSettings();
  const [inspectedServerId, setServerId] = useState(props.serverId);
  const serverId = props.profiles.selectEnvironment ? props.serverId : inspectedServerId;
  const selectEnvironment = useCallback(
    (id: string) => {
      if (props.profiles.selectEnvironment) props.profiles.selectEnvironment(id);
      else setServerId(id);
    },
    [props.profiles],
  );
  const [inspectedByServer, setInspectedByServer] = useState<Record<string, string>>({});
  const [accountByServer, setAccountByServer] = useState<Record<string, string>>({});
  const { config } = useDaemonConfig(serverId);
  const hosts = useHosts();
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const installation = readExecutionInstallation();
  const serverIds = useMemo(
    () =>
      installation?.environments.map((item) => item.serverId) ?? hosts.map((host) => host.serverId),
    [installation, hosts],
  );
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const projectPolicy = useMemo(
    () => readProjectPolicy(config, props.profiles.projectPath),
    [config, props.profiles.projectPath],
  );
  const environments = useMemo<PresetEnvironment[]>(() => {
    if (installation)
      return [...installation.environments]
        .filter((item) => isEnvironmentAllowed(projectPolicy, item.kind))
        .sort((a, b) => Number(b.kind === "host") - Number(a.kind === "host"))
        .map((item) => ({
          serverId: item.serverId,
          label: item.kind === "host" ? "Host" : "Dev container",
          description: item.kind === "host" ? "Full host access" : "Safer isolated workspace",
          available: statuses.get(item.serverId) === "online",
        }));
    return hosts.map((host) => ({
      serverId: host.serverId,
      label: host.label,
      available: statuses.get(host.serverId) === "online",
    }));
  }, [installation, hosts, statuses, projectPolicy]);
  const { profiles: definitions, isSupported, accountIndependent } = useAgentProfiles(serverId);
  const { entries, isLoading, error, refresh, isRefreshing } = useProvidersSnapshot(serverId, {
    cwd: null,
  });
  const environmentKind = installation?.environments.find(
    (item) => item.serverId === serverId,
  )?.kind;
  const rows = useMemo<AgentProfilePickerRow[]>(
    () =>
      (definitions ?? [])
        .filter(
          (profile) => !environmentKind || !profile.excludedEnvironments?.includes(environmentKind),
        )
        .filter((profile) => isProfileAllowed(projectPolicy, profile))
        .filter(
          (profile) =>
            accountIndependent ||
            entries?.find((item) => item.provider === profile.provider)?.enabled !== false,
        )
        .map((profile) => {
          const entry = entries?.find((item) => item.provider === profile.provider);
          const model = entry?.models?.find((item) => item.id === profile.model);
          return {
            id: profile.id,
            provider: profile.provider,
            modelId: profile.model ?? "",
            name: profile.name,
            summary: model?.label ?? profile.model ?? "",
            icon: profile.icon ?? "",
            color: profile.color ?? "",
            unavailable: entry?.status !== "ready" || !entry.enabled,
            localEndpoint: model?.localEndpoint,
          };
        }),
    [definitions, entries, accountIndependent, environmentKind, projectPolicy],
  );
  const { view, resetLoadingProviders } = usePresetData(serverId, true);
  const accounts = useMemo(
    () =>
      accountPresets({
        rows,
        definitions: definitions ?? [],
        entries,
        query: "",
        providers: config?.providers,
        accountIndependent,
      }),
    [rows, definitions, entries, config, accountIndependent],
  );
  const sameEnvironment = serverId === props.serverId;
  const selectedId = sameEnvironment ? props.selectedId : undefined;
  const inspectedId = inspectedByServer[serverId ?? ""] ?? selectedId;
  const inspectedProvider =
    accountByServer[serverId ?? ""] ?? (sameEnvironment ? props.currentProvider : undefined);
  const inspect = useCallback(
    (id: string) => setInspectedByServer((current) => ({ ...current, [serverId ?? ""]: id })),
    [serverId],
  );
  const apply = useCallback(
    (id: string, choices?: LaunchChoices) => {
      if (sameEnvironment) {
        props.onApply(id, choices);
        return;
      }
      const profile = definitions?.find((item) => item.id === id);
      if (profile && serverId && props.profiles.applyDestinationProfile) {
        props.profiles.applyDestinationProfile(serverId, { ...profile, ...choices });
        props.onClose();
      }
    },
    [sameEnvironment, props, definitions, serverId],
  );
  const inspectAccount = useCallback(
    (provider: string) => {
      setAccountByServer((current) => ({ ...current, [serverId ?? ""]: provider }));
      if (props.inline) {
        const account = accounts.find((item) => item.provider === provider);
        const entry = entries?.find((item) => item.provider === provider);
        const compatible = (definitions ?? []).filter(
          (profile) =>
            account?.rows.some((row) => row.id === profile.id) &&
            !sharedChoiceState({ profile, choices: {}, entry }).unavailable,
        );
        const reference = installationProviderReference(provider, config?.providers ?? {});
        const preferredId = settings.workspaceDefaults.profilesByAccount[reference];
        const profile = defaultProfile(compatible, preferredId);
        if (profile) apply(profile.id, { provider });
      } else if (!accountIndependent) {
        const account = accounts.find((item) => item.provider === provider);
        const matchingId =
          inspectedId && isSharedWorkflowProfile(inspectedId)
            ? sharedWorkflowProfileId(provider, decodeURIComponent(inspectedId.split("/")[2]))
            : undefined;
        const row = account?.rows.find((item) => item.id === matchingId) ?? account?.rows[0];
        if (row) setInspectedByServer((current) => ({ ...current, [serverId ?? ""]: row.id }));
      }
    },
    [
      serverId,
      accounts,
      accountIndependent,
      inspectedId,
      props.inline,
      entries,
      definitions,
      config,
      settings,
      apply,
    ],
  );
  const inspectProfile = useCallback(
    (id: string) => {
      if (props.disabled) return;
      if (props.inline) apply(id, { provider: inspectedProvider ?? accounts[0]?.provider });
      else inspect(id);
    },
    [props.disabled, props.inline, apply, inspectedProvider, accounts, inspect],
  );
  const { onClose } = props;
  const manage = useCallback(() => {
    const account = accounts.find((item) => item.provider === inspectedProvider) ?? accounts[0];
    if (!serverId || !account) return;
    onClose();
    useProviderSettingsStore
      .getState()
      .open({ serverId, provider: account.provider, tab: "profiles" });
  }, [accounts, inspectedProvider, serverId, onClose]);
  const retry = useCallback(() => {
    const account = accounts.find((item) => item.provider === inspectedProvider) ?? accounts[0];
    void refresh(account ? [account.provider] : undefined).catch(() => undefined);
  }, [accounts, inspectedProvider, refresh]);
  const renderRail = useCallback(
    (row: AgentProfilePickerRow) => (
      <PresetUsageRail
        view={view}
        showConnectionActions={false}
        showResetControl={false}
        now={props.now}
        localStatus={
          row.localEndpoint
            ? `${formatLocalEndpointSummary(row.localEndpoint, props.now)?.replace("Local endpoint", "Local")} · ${formatWorkerActivity(
                view.kind === "ready" ? view.payload.workerActivity : undefined,
                row.provider,
                props.now,
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
    [view, serverId, props.now],
  );
  const renderBadge = useCallback(
    (row: AgentProfilePickerRow) =>
      row.localEndpoint ? null : (
        <AccountUsageBadge
          view={view}
          providerId={row.provider}
          now={props.now}
          compact={props.inline}
        />
      ),
    [view, props.now, props.inline],
  );
  const renderAccountDetails = useCallback(
    (row: AgentProfilePickerRow) => (
      <AccountUsageDetails
        view={view}
        providerId={row.provider}
        now={props.now}
        serverId={serverId}
        name={row.name}
        resetLoading={resetLoadingProviders.has(row.provider)}
        localStatus={
          row.localEndpoint
            ? (formatLocalEndpointSummary(row.localEndpoint, props.now) ?? "Local endpoint")
            : undefined
        }
      />
    ),
    [view, props.now, serverId, resetLoadingProviders],
  );
  let availabilityError = error;
  if (!connected) availabilityError = "Reconnect to this environment to select a profile";
  else if (!isSupported && !isLoading)
    availabilityError = "This environment does not support profiles";
  return (
    <AccountPresetMenu
      inline={props.inline}
      serverId={serverId}
      environments={environments}
      onEnvironment={selectEnvironment}
      accounts={accounts}
      definitions={definitions ?? []}
      entries={entries}
      activeProfileId={props.activeProfileId}
      activeServerId={props.serverId}
      inspectedId={inspectedId}
      inspectedProvider={inspectedProvider}
      onAccount={inspectAccount}
      compact={props.compact}
      disabled={props.disabled || !connected}
      loading={isLoading || definitions === null}
      error={availabilityError}
      currentProvider={sameEnvironment ? props.currentProvider : undefined}
      currentModel={sameEnvironment ? props.currentModel : undefined}
      currentThinkingOptionId={sameEnvironment ? props.currentThinkingOptionId : undefined}
      onInspect={inspectProfile}
      onApply={apply}
      onManage={manage}
      onRetry={retry}
      retrying={isRefreshing}
      renderRail={renderRail}
      renderBadge={renderBadge}
      renderAccountDetails={renderAccountDetails}
    />
  );
}
