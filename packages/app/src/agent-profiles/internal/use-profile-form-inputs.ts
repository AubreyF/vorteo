import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { selectProfileCatalogSources } from "@/execution-installation/profile-catalog";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type { AgentProfileFormModel, AgentProfileFormState } from "./profile-form-model";

/**
 * Profiles outlive individual workspaces, so catalogs use each daemon's home
 * directory (`cwd: null` for the snapshot, `~` for the feature listing) rather
 * than in a workspace. A profile that resolved against one project's directory
 * would name models the next project cannot launch. Installation profiles also
 * compare included environments before choosing an automatic default.
 */
const HOME_SCOPE_CWD = "~";

export function useAgentProfileFormCatalog(input: {
  serverId: string;
  model: AgentProfileFormModel;
  sharedScope: { providerType: string } | undefined;
}): void {
  const { entries } = useProvidersSnapshot(input.serverId, { cwd: null });
  const providerType = input.sharedScope?.providerType;
  const installation = providerType ? readExecutionInstallation() : null;
  const hostId = installation?.environments.find((item) => item.kind === "host")?.serverId ?? null;
  const devId =
    installation?.environments.find((item) => item.kind === "container")?.serverId ?? null;
  const { entries: hostEntries } = useProvidersSnapshot(hostId, {
    cwd: null,
    enabled: hostId !== null,
  });
  const { entries: devEntries } = useProvidersSnapshot(devId, {
    cwd: null,
    enabled: devId !== null,
  });
  const hostConnected = useHostRuntimeIsConnected(hostId ?? "");
  const devConnected = useHostRuntimeIsConnected(devId ?? "");
  const { config: hostConfig } = useDaemonConfig(hostId);
  const { config: devConfig } = useDaemonConfig(devId);

  useEffect(() => {
    if (!entries) {
      return;
    }
    if (hostId && devId && providerType) {
      const hostSource = selectProfileCatalogSources([
        { serverId: hostId, entries: hostEntries, providers: hostConfig?.providers },
      ]).get(providerType);
      const devSource = selectProfileCatalogSources([
        { serverId: devId, entries: devEntries, providers: devConfig?.providers },
      ]).get(providerType);
      input.model.applySharedProviderCatalog({
        entries,
        environments: [
          {
            kind: "host",
            provider: hostSource?.provider,
            entries: hostConnected && hostConfig ? hostEntries : undefined,
          },
          {
            kind: "container",
            provider: devSource?.provider,
            entries: devConnected && devConfig ? devEntries : undefined,
          },
        ],
      });
    } else {
      input.model.applyProviderCatalog(entries);
    }
  }, [
    entries,
    input.model,
    providerType,
    hostId,
    devId,
    hostEntries,
    devEntries,
    hostConnected,
    devConnected,
    hostConfig,
    devConfig,
  ]);
}

export function useAgentProfileFormFeatures(input: {
  serverId: string;
  model: AgentProfileFormModel;
  state: AgentProfileFormState;
}): void {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const request = input.state.featureRequest;
  const requestKey = input.state.featureRequestKey;

  // `dataShape: "value"` and not `"list"`: a list shape keeps the previous
  // page's data while the next request is in flight, which would hand the
  // features of one provider/model combination to the key of another.
  const featuresQuery = useFetchQuery({
    queryKey: ["agentProfileFeatures", input.serverId, requestKey],
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    enabled: Boolean(client && isConnected && request),
    retry: false,
    queryFn: async () => {
      if (!client || !request) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.listProviderFeatures({ ...request, cwd: HOME_SCOPE_CWD });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.features ?? [];
    },
  });

  const { data, isError } = featuresQuery;
  const { model } = input;

  useEffect(() => {
    if (!requestKey || !data) {
      return;
    }
    model.applyFeatures(requestKey, data);
  }, [data, model, requestKey]);

  useEffect(() => {
    if (!requestKey || !isError) {
      return;
    }
    model.applyFeaturesUnavailable(requestKey);
  }, [isError, model, requestKey]);
}
