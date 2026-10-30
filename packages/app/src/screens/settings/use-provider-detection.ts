import { useMemo } from "react";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { ProviderDetectionSource } from "./shared-providers-model";

/**
 * Host and Dev provider snapshots for the shared catalog's default rule. The snapshots are
 * pushed when a daemon re-checks its providers, so detection follows them without polling.
 */
export function useProviderDetection(
  environments: readonly InstallationEnvironment[],
): ProviderDetectionSource[] {
  const hostId = environments.find((environment) => environment.kind === "host")?.serverId ?? null;
  const devId =
    environments.find((environment) => environment.kind === "container")?.serverId ?? null;
  const { entries: hostEntries, isLoading: hostLoading } = useProvidersSnapshot(hostId);
  const { entries: devEntries, isLoading: devLoading } = useProvidersSnapshot(devId);
  return useMemo(() => {
    const sources: ProviderDetectionSource[] = [];
    // An environment that is offline reports nothing; leave it out rather than wait for it.
    if (hostId && (hostEntries || hostLoading))
      sources.push({ serverId: hostId, kind: "host", entries: hostEntries });
    if (devId && (devEntries || devLoading))
      sources.push({ serverId: devId, kind: "container", entries: devEntries });
    return sources;
  }, [hostId, devId, hostEntries, hostLoading, devEntries, devLoading]);
}
