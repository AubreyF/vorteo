import { materializeSharedProfiles } from "@getpaseo/protocol/provider-preferences";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useCallback, useMemo } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { supportsAgentProfiles } from "./capabilities";
import { ensureDefaultProfile } from "./default-profile";

export interface UseAgentProfilesResult {
  /** `null` until the daemon config has arrived. */
  profiles: AgentProfile[] | null;
  legacyProfiles: AgentProfile[];
  /** False on daemons that predate agent profiles, or while disconnected. */
  isSupported: boolean;
  supportsLaunch: boolean;
  supportsSharedPreferences: boolean;
  /** Writes the whole list; there is no per-profile RPC. */
  saveProfiles: (next: AgentProfile[]) => Promise<void>;
}

export function useAgentProfiles(serverId: string | null): UseAgentProfilesResult {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const supportsSharedPreferences = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.sharedProviderPreferences === true,
  );
  const profiles = useMemo(() => {
    if (!config) return null;
    if (supportsSharedPreferences && config.sharedProviderPreferences) {
      const providerIds = entries?.map((entry) => entry.provider) ?? Object.keys(config.providers);
      return materializeSharedProfiles({
        preferences: config.sharedProviderPreferences,
        providers: config.providers,
        providerIds,
      });
    }
    return config.agentProfiles ?? [];
  }, [config, entries, supportsSharedPreferences]);
  const supportsLaunch = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.agentProfileLaunch === true,
  );
  const isSupported = useSessionStore((state) => {
    return supportsAgentProfiles(state.sessions[serverId ?? ""]?.serverInfo?.features);
  });

  const saveProfiles = useCallback(
    async (next: AgentProfile[]) => {
      await patchConfig({
        agentProfiles: ensureDefaultProfile(next),
        ...(supportsLaunch ? { expectedAgentProfiles: config?.agentProfiles ?? [] } : {}),
      });
    },
    [patchConfig, config, supportsLaunch],
  );

  return {
    profiles,
    legacyProfiles: config?.agentProfiles ?? [],
    supportsSharedPreferences,
    isSupported,
    supportsLaunch,
    saveProfiles,
  };
}
