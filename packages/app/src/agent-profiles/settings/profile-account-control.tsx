import { useCallback } from "react";
import { AddCodexAccountButton } from "@/provider-usage/add-account";
import type { CreatedCodexAccount } from "@/provider-usage/account-form";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { ProviderReconnectControl } from "@/provider-usage/reconnect-control";
import type { SelectFieldDisplay } from "@/components/ui/select-field";

export function ProfileAccountControl({
  serverId,
  providerId,
  display,
  onSelect,
}: {
  serverId: string;
  providerId: string;
  display: SelectFieldDisplay | null;
  onSelect: (providerId: string, display: SelectFieldDisplay) => void;
}) {
  const created = useCallback(
    (account: CreatedCodexAccount) => onSelect(account.providerId, { label: account.name }),
    [onSelect],
  );
  return (
    <>
      <AddCodexAccountButton serverId={serverId} onCreated={created} />
      <AccountControl
        serverId={serverId}
        providerId={providerId}
        name={display?.label ?? providerId}
      />
    </>
  );
}

function AccountControl({
  serverId,
  providerId,
  name,
}: {
  serverId: string;
  providerId: string;
  name: string;
}) {
  const { view } = useProviderUsage(serverId);
  const usage =
    view.kind === "ready"
      ? view.payload.providers.find((entry) => entry.providerId === providerId)
      : undefined;
  return (
    <ProviderReconnectControl
      key={providerId}
      serverId={serverId}
      providerId={providerId}
      name={name}
      usage={usage}
    />
  );
}
