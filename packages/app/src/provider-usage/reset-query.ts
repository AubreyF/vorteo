import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

// Shared workflows name a provider family; reset credits belong to configured accounts.
export function resetProviderIds(
  entries: readonly Pick<ProviderSnapshotEntry, "provider" | "enabled">[] | undefined,
): string[] {
  return (entries ?? []).filter((entry) => entry.enabled).map((entry) => entry.provider);
}

export function providerResetQueryOptions(input: {
  serverId: string | null;
  providerId: string;
  clientGeneration: number | undefined;
  client: Pick<DaemonClient, "readProviderReset"> | null;
  enabled: boolean;
  poll?: boolean;
}) {
  return {
    queryKey: ["providerReset", input.serverId, input.providerId, input.clientGeneration],
    queryFn: async () => {
      if (!input.client) throw new Error("Host unavailable");
      return (await input.client.readProviderReset(input.providerId)).view;
    },
    enabled: input.enabled,
    refetchInterval: input.enabled && input.poll ? 60_000 : (false as const),
    dataShape: "value" as const,
    staleTimeMs: 60_000,
    retry: false as const,
    refetchOnWindowFocus: false as const,
  };
}
