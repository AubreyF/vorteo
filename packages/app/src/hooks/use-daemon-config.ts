import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  MutableDaemonConfigSchema,
  type MutableDaemonConfig,
  type MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import { useReplicaQuery } from "@/data/query";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useInstallationSettings } from "@/execution-installation/settings";
import {
  sharedProviderSettingsPatch,
  sharedSettingsPatch,
  withSharedSettings,
} from "@/execution-installation/settings-policy";
import { readExecutionInstallation } from "@/execution-installation/policy";

interface UseDaemonConfigResult {
  config: MutableDaemonConfig | null;
  isLoading: boolean;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<MutableDaemonConfig | undefined>;
}

export function useDaemonConfig(serverId: string | null): UseDaemonConfigResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryKey = useMemo(() => daemonConfigQueryKey(serverId), [serverId]);
  const managed = Boolean(
    readExecutionInstallation()?.environments.some(
      (environment) => environment.serverId === serverId,
    ),
  );
  const { data: shared, save: saveShared } = useInstallationSettings(managed);

  const configQuery = useReplicaQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected),
    pushEvent: "status:daemon_config_changed",
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.getDaemonConfig();
      return result.config;
    },
  });

  const patchConfig = useCallback(
    async (patch: MutableDaemonConfigPatch) => {
      if (managed) {
        const settings =
          sharedProviderSettingsPatch(patch, { settings: shared?.settings, serverId }) ??
          sharedSettingsPatch(patch, configQuery.data);
        if (settings) {
          if (!shared?.settings)
            throw new Error(
              "Load shared settings and resolve migration differences before saving.",
            );
          const saved = await saveShared({
            expectedRevision: shared.revision,
            settings,
          });
          if (!saved.settings) return undefined;
          const local =
            configQuery.data ?? MutableDaemonConfigSchema.parse({ mcp: saved.settings.mcp });
          return withSharedSettings(local, saved.settings, serverId ?? undefined);
        }
      }
      if (!client) {
        return undefined;
      }
      const result = await client.patchDaemonConfig(patch);
      queryClient.setQueryData(queryKey, result.config);
      return result.config;
    },
    [client, queryClient, queryKey, managed, shared, saveShared, configQuery.data, serverId],
  );

  let config = configQuery.data ?? null;
  if (managed && shared?.settings) {
    const local = config ?? MutableDaemonConfigSchema.parse({ mcp: shared.settings.mcp });
    config = withSharedSettings(local, shared.settings, serverId ?? undefined);
  }
  return {
    config,
    isLoading: configQuery.isLoading,
    patchConfig,
  };
}
