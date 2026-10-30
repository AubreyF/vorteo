import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  InstallationUpgrade,
  UpgradeDecision,
} from "@getpaseo/protocol/installation-upgrades";
import { useFetchQuery } from "@/data/query";
import type { InstallationClient } from "./client";
import { activeUpgrade } from "./installation-upgrades-model";

export const INSTALLATION_UPGRADES_KEY = ["installation-upgrades"] as const;
export const INSTALLATION_SNAPSHOTS_KEY = ["installation-snapshots"] as const;

function requireClient(client: InstallationClient | null): InstallationClient {
  if (!client) throw new Error("Unlock installation controls first");
  return client;
}

/**
 * Upgrade status shared by the update section and Installation controls. Data is null when the
 * coordinator predates upgrades. Active upgrades refresh every five seconds.
 */
export function useInstallationUpgradeStatus(client: InstallationClient | null) {
  return useFetchQuery({
    dataShape: "value",
    queryKey: INSTALLATION_UPGRADES_KEY,
    queryFn: () => requireClient(client).upgradeStatus(),
    enabled: client !== null,
    staleTimeMs: 0,
    refetchInterval: (query) => (activeUpgrade(query.state.data) ? 5000 : 60_000),
    retry: false,
  });
}

export function useInstallationUpgradeActions(client: InstallationClient | null) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: INSTALLATION_UPGRADES_KEY });
  const create = useMutation({
    mutationFn: (release: string) => requireClient(client).requestUpgrade(release),
    onSettled: refresh,
  });
  const decide = useMutation({
    mutationFn: (input: { upgrade: InstallationUpgrade; decision: UpgradeDecision["decision"] }) =>
      requireClient(client).decideUpgrade(input.upgrade, input.decision),
    onSettled: refresh,
  });
  return { create, decide };
}

/** Snapshot list; data is null when the coordinator predates snapshots. */
export function useInstallationSnapshots(client: InstallationClient | null, restoring: boolean) {
  return useFetchQuery({
    dataShape: "value",
    queryKey: INSTALLATION_SNAPSHOTS_KEY,
    queryFn: () => requireClient(client).snapshots(),
    enabled: client !== null,
    staleTimeMs: 0,
    // A restore restarts the coordinator; poll quickly so the page reloads when it returns.
    refetchInterval: (query) =>
      restoring || query.state.data?.restore?.status === "running" ? 3000 : 60_000,
    retry: false,
  });
}
