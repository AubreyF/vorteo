import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  resolveProviderType,
  type ProviderAncestry,
} from "@getpaseo/protocol/provider-preferences";

interface EnvironmentCatalog {
  serverId: string | null;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  providers: Record<string, ProviderAncestry> | undefined;
}

interface ProfileCatalogSource {
  serverId: string;
  provider: string;
}

function catalogPriority(entry: ProviderSnapshotEntry): number {
  if (!entry.enabled) return 0;
  if (entry.status === "ready") return 2;
  return 1;
}

export function selectProfileCatalogSources(
  catalogs: readonly EnvironmentCatalog[],
): Map<string, ProfileCatalogSource> {
  const sources = new Map<string, ProfileCatalogSource>();
  const priorities = new Map<string, number>();
  for (const catalog of catalogs) {
    if (!catalog.serverId) continue;
    for (const entry of catalog.entries ?? []) {
      const type = resolveProviderType(entry.provider, catalog.providers ?? {});
      const priority = catalogPriority(entry);
      // Preserve environment order on ties, but never let a disabled base hide a ready account.
      if (priority <= (priorities.get(type) ?? -1)) continue;
      sources.set(type, { serverId: catalog.serverId, provider: entry.provider });
      priorities.set(type, priority);
    }
  }
  return sources;
}
