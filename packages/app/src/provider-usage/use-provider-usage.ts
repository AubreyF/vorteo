import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { providerUsageCopy } from "./copy";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";

import { PROVIDER_USAGE_STALE_TIME_MS } from "./quota-reading";
import { retainLastKnownUsage } from "./usage-cache";
import { providerUsageView } from "./usage-view";
export { PROVIDER_USAGE_STALE_TIME_MS } from "./quota-reading";

type ProviderUsageClient = Pick<DaemonClient, "listProviderUsage">;

export function providerUsageQueryKey(serverId: string | null | undefined) {
  return ["providerUsage", serverId ?? ""] as const;
}

async function fetchProviderUsage(client: ProviderUsageClient): Promise<ProviderUsageListPayload> {
  return client.listProviderUsage();
}

interface UseProviderUsageOptions {
  enabled?: boolean;
  refreshOnMount?: boolean;
  pollActivity?: boolean;
  pollUsage?: boolean;
}

export function useProviderUsage(
  serverId: string | null | undefined,
  options: UseProviderUsageOptions = {},
): {
  view: ProviderUsageView;
  refresh: () => Promise<void>;
  canFetch: boolean;
} {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  const queryKey = useMemo(() => providerUsageQueryKey(serverId), [serverId]);
  const canFetch = Boolean(serverId && client && isConnected && supportsProviderUsage);
  const enabled = Boolean((options.enabled ?? true) && canFetch);
  let refetchInterval: number | false = false;
  if (enabled && options.pollUsage) refetchInterval = 60_000;
  if (enabled && options.pollActivity) refetchInterval = 15_000;

  const queryFn = useCallback(async () => {
    if (!client) {
      throw new Error(providerUsageCopy.clientUnavailable);
    }
    return retainLastKnownUsage(
      await fetchProviderUsage(client),
      queryClient.getQueryData<ProviderUsageListPayload>(queryKey),
    );
  }, [client, queryClient, queryKey]);

  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime: options.pollActivity ? 15_000 : PROVIDER_USAGE_STALE_TIME_MS,
    gcTime: Infinity,
    refetchOnMount: options.refreshOnMount ? "always" : true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
    refetchInterval,
  });

  const refresh = useCallback(async () => {
    if (!canFetch) return;
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.fetchQuery({
      queryKey,
      queryFn,
      staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    });
  }, [canFetch, queryClient, queryFn, queryKey]);

  const view = useMemo(
    () =>
      providerUsageView({
        hasHost: Boolean(serverId),
        connected: Boolean(client && isConnected),
        supported: supportsProviderUsage,
        data: query.data,
        fetching: query.isFetching,
        error: query.isError ? query.error : undefined,
      }),
    [
      serverId,
      client,
      isConnected,
      supportsProviderUsage,
      query.data,
      query.isFetching,
      query.isError,
      query.error,
    ],
  );

  return { view, refresh, canFetch };
}
