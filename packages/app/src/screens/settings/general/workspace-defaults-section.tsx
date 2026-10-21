import { useCallback, useState } from "react";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { useAppSettings } from "@/hooks/use-settings";
import type { WorkspaceDefaults } from "@/hooks/use-settings/storage";
import { useHosts } from "@/runtime/host-runtime";
import {
  readExecutionInstallation,
  installationDefaultServerId,
} from "@/execution-installation/policy";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useAgentProfiles } from "@/agent-profiles/internal/use-agent-profiles";
import { installationProviderReference } from "@getpaseo/protocol/installation-settings";
import { resolveProviderType } from "@getpaseo/protocol/provider-preferences";

export function WorkspaceDefaultsSection() {
  const { settings, updateSettings } = useAppSettings();
  const defaults = settings.workspaceDefaults;
  const hosts = useHosts();
  const installation = readExecutionInstallation();
  const environments = installation
    ? installation.environments.map((environment) => ({
        value: environment.serverId,
        label: environment.kind === "host" ? "Host" : "Dev container",
      }))
    : hosts.map((host) => ({ value: host.serverId, label: host.label }));
  const serverId =
    defaults.environment ?? installationDefaultServerId(installation) ?? hosts[0]?.serverId ?? null;
  const { config } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const { profiles } = useAgentProfiles(serverId);
  const [operation, setOperation] = useState<{ pending: boolean; error: string | null }>({
    pending: false,
    error: null,
  });
  const providers = config?.providers ?? {};
  // Accounts that are not installed cannot start a workspace, so they get no default row.
  const accounts = (entries ?? [])
    .filter((entry) => entry.enabled && entry.status !== "unavailable")
    .map((entry) => ({
      value: installationProviderReference(entry.provider, providers),
      label: entry.label ?? entry.provider,
      provider: entry.provider,
    }));
  const save = useCallback(
    async (change: Partial<WorkspaceDefaults>) => {
      setOperation({ pending: true, error: null });
      try {
        await updateSettings((current) => ({
          workspaceDefaults: { ...current.workspaceDefaults, ...change },
        }));
        setOperation({ pending: false, error: null });
      } catch (error) {
        setOperation({
          pending: false,
          error: error instanceof Error ? error.message : "Could not save workspace defaults",
        });
      }
    },
    [updateSettings],
  );
  const changeEnvironment = useCallback(
    (value: string) => void save({ environment: value || null }),
    [save],
  );
  const changeAccount = useCallback(
    (value: string) => void save({ account: value || null }),
    [save],
  );
  return (
    <SettingsSection
      title="New workspace"
      info="Choose the environment and account for new workspaces, and a default profile for each account. Explicit workspace selections take precedence."
    >
      {operation.error ? <Alert variant="error" description={operation.error} /> : null}
      <SettingsCard>
        <SettingsSelect
          label="Default environment"
          value={defaults.environment ?? ""}
          options={[{ value: "", label: "Automatic" }, ...environments]}
          onValueChange={changeEnvironment}
          disabled={operation.pending}
        />
        <SettingsSelect
          label="Default account"
          value={defaults.account ?? ""}
          options={[{ value: "", label: "Automatic" }, ...accounts]}
          onValueChange={changeAccount}
          disabled={operation.pending}
        />
        {accounts.map((account) => {
          const type = resolveProviderType(account.provider, providers);
          const choices = (profiles ?? [])
            .filter((profile) => profile.provider === type || profile.provider === account.provider)
            .map((profile) => ({ value: profile.id, label: profile.name }));
          return (
            <AccountProfileDefault
              key={account.value}
              account={account.value}
              label={account.label}
              choices={choices}
              defaults={defaults}
              save={save}
              disabled={operation.pending}
            />
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}

interface AccountProfileDefaultProps {
  account: string;
  label: string;
  choices: { value: string; label: string }[];
  defaults: WorkspaceDefaults;
  save: (change: Partial<WorkspaceDefaults>) => Promise<void>;
  disabled: boolean;
}
function AccountProfileDefault({
  account,
  label,
  choices,
  defaults,
  save,
  disabled,
}: AccountProfileDefaultProps) {
  const change = useCallback(
    (value: string) =>
      void save({ profilesByAccount: { ...defaults.profilesByAccount, [account]: value } }),
    [save, defaults.profilesByAccount, account],
  );
  return (
    <SettingsSelect
      label={`${label} default profile`}
      value={defaults.profilesByAccount[account] ?? ""}
      options={[{ value: "", label: "Provider default" }, ...choices]}
      onValueChange={change}
      disabled={disabled}
    />
  );
}
