import { readExecutionInstallation } from "@/execution-installation/policy";
import { claudeSetupRequest } from "./claude-setup-login";
import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { providerUsageQueryKey } from "./use-provider-usage";

export function useProviderLogin(
  serverId: string | null,
  providerId: string,
  provider: "claude" | "codex" = "codex",
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const hostConnected = useHostRuntimeIsConnected(serverId ?? "");
  const installation = readExecutionInstallation();
  const sharedClaude =
    provider === "claude" &&
    Boolean(installation?.environments.some((environment) => environment.serverId === serverId));
  const connected = sharedClaude || hostConnected;
  const cache = useQueryClient();
  const key = useMemo(() => ["providerLogin", serverId, providerId], [serverId, providerId]);
  const action = useMutation({
    gcTime: 0,
    mutationFn: async (operation: "start" | "cancel" | "sign-out" | { code: string }) => {
      if ((!client && !sharedClaude) || !connected)
        throw new Error("Reconnect to the host and try again.");
      await cache.cancelQueries({ queryKey: key });
      if (operation === "sign-out") {
        if (!sharedClaude) throw new Error("Installation subscription connection required.");
        return (await claudeSetupRequest(serverId!, providerId, "sign-out")).login;
      }
      if (operation === "start") {
        if (sharedClaude) return (await claudeSetupRequest(serverId!, providerId, "start")).login;
        return (await client!.startProviderLogin(providerId)).state;
      }
      const state = cache.getQueryData<ProviderLoginState>(key);
      if (!state || state.status === "idle")
        throw new Error("Refresh the sign-in status and try again.");
      if (sharedClaude)
        return (
          await claudeSetupRequest(
            serverId!,
            providerId,
            typeof operation === "object" ? "submit" : "cancel",
            {
              attemptId: state.attemptId,
              ...(typeof operation === "object" ? { code: operation.code } : {}),
            },
          )
        ).login;
      if (typeof operation === "object")
        return (await client!.submitProviderLoginCode(providerId, state.attemptId, operation.code))
          .state;
      return (await client!.cancelProviderLogin(providerId, state.attemptId)).state;
    },
    onSuccess: (state) => cache.setQueryData(key, state),
  });
  const enabled = Boolean((client || sharedClaude) && connected && !action.isPending);
  const query = useFetchQuery({
    queryKey: key,
    queryFn: async () => {
      if (sharedClaude) return (await claudeSetupRequest(serverId!, providerId, "read")).login;
      if (!client) throw new Error("Host unavailable");
      return (await client.readProviderLogin(providerId)).state;
    },
    enabled,
    refetchInterval: enabled ? 2000 : false,
    staleTimeMs: 0,
    dataShape: "value",
    gcTime: 0,
    retry: false,
  });
  const synchronization = useFetchQuery({
    queryKey: ["claude-setup-connection", installation?.installationId, serverId, providerId],
    queryFn: async () => (await claudeSetupRequest(serverId!, providerId, "read")).connection,
    enabled: sharedClaude,
    refetchInterval: sharedClaude ? 2000 : false,
    staleTimeMs: 0,
    dataShape: "value",
    gcTime: 0,
    retry: false,
  });
  const { mutate, reset } = action;
  const { refetch } = query;
  const start = useCallback(() => mutate("start"), [mutate]);
  const { mutateAsync } = action;
  const submitCode = useCallback(
    async (code: string) => {
      try {
        return await mutateAsync({ code });
      } finally {
        reset();
      }
    },
    [mutateAsync, reset],
  );
  const signOut = useCallback(() => mutate("sign-out"), [mutate]);
  const cancel = useCallback(() => mutate("cancel"), [mutate]);
  const refresh = useCallback(() => {
    reset();
    void refetch();
  }, [reset, refetch]);
  const completedId = query.data?.status === "succeeded" ? query.data.attemptId : null;
  useEffect(() => {
    if (!completedId) return;
    void cache.invalidateQueries({ queryKey: providerUsageQueryKey(serverId) });
    void cache.invalidateQueries({ queryKey: ["providerReset", serverId, providerId] });
  }, [cache, completedId, serverId, providerId]);
  return {
    state: query.data,
    sharedClaude,
    synchronization: synchronization.data,
    connected,
    busy: action.isPending || query.isLoading,
    actionPending: action.isPending,
    readFailed: query.isError,
    actionFailed: action.isError,
    refreshing: query.isFetching,
    start,
    cancel,
    signOut,
    submitCode,
    refresh,
  };
}
