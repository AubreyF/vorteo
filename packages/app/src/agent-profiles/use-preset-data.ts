import { useMemo } from "react";
import { useFetchQueries } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { resetProviderIds, providerResetQueryOptions } from "@/provider-usage/reset-query";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";

export function usePresetData(serverId: string | null, active: boolean) {
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsResets = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.providerResetManagement === true,
  );
  const clientGeneration = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.clientGeneration,
  );
  const enabled = Boolean(active && connected && client && supportsResets);
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const providers = useMemo(() => resetProviderIds(entries), [entries]);
  const resets = useFetchQueries(
    providers.map((providerId) =>
      providerResetQueryOptions({
        serverId,
        providerId,
        clientGeneration,
        client,
        enabled,
        poll: true,
      }),
    ),
  );
  const { view } = useProviderUsage(serverId, {
    enabled: active,
    pollActivity: active,
  });
  return {
    view,
    resetLoadingProviders: new Set(providers.filter((_, index) => resets[index]?.isFetching)),
  };
}
