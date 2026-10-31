import { readExecutionInstallation } from "@/execution-installation/policy";
import { claudeFullSignInAvailable, claudeSetupRequest } from "./claude-setup-login";
import {
  codexInstallationRequest,
  codexInstallationSignInAvailable,
} from "./codex-installation-login";
import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { providerUsageQueryKey } from "./use-provider-usage";

/**
 * Whether this account signs in once for the installation through the coordinator. Claude always
 * does inside an installation. Codex does when the coordinator runs Host-owned Codex sign-in;
 * otherwise each environment keeps its own sign-in.
 */
export function useSharedInstallationSignIn(
  serverId: string | null,
  provider: "claude" | "codex",
): boolean {
  const installation = readExecutionInstallation();
  const inInstallation = Boolean(
    installation?.environments.some((environment) => environment.serverId === serverId),
  );
  const codex = useFetchQuery({
    queryKey: ["codex-installation-sign-in", installation?.installationId],
    queryFn: codexInstallationSignInAvailable,
    enabled: inInstallation && provider === "codex",
    staleTimeMs: 60_000,
    dataShape: "value",
    retry: false,
  });
  return inInstallation && (provider === "claude" || codex.data === true);
}

/**
 * Whether connect-once is on for each provider: the coordinator runs Host-owned Claude refresh
 * (`claudeHostRefresh`) or Host-owned Codex sign-in (`codexHostRefresh`). Undefined while the
 * coordinator has not answered. Shares its cache with the sign-in flows that probe the same
 * routes.
 */
export function useInstallationConnectOnce(enabled: boolean): {
  claude: boolean | undefined;
  codex: boolean | undefined;
} {
  const installation = readExecutionInstallation();
  const active = enabled && installation !== null;
  const claude = useFetchQuery({
    queryKey: ["claude-full-sign-in", installation?.installationId],
    queryFn: claudeFullSignInAvailable,
    enabled: active,
    staleTimeMs: 60_000,
    dataShape: "value",
    retry: false,
  });
  const codex = useFetchQuery({
    queryKey: ["codex-installation-sign-in", installation?.installationId],
    queryFn: codexInstallationSignInAvailable,
    enabled: active,
    staleTimeMs: 60_000,
    dataShape: "value",
    retry: false,
  });
  return {
    claude: claude.isError ? false : claude.data,
    codex: codex.isError ? false : codex.data,
  };
}

function installationRequest(
  provider: "claude" | "codex",
  serverId: string,
  providerId: string,
  operation: "read" | "start" | "cancel" | "sign-out",
  attempt?: { attemptId: string },
) {
  return provider === "claude"
    ? claudeSetupRequest(serverId, providerId, operation, attempt)
    : codexInstallationRequest(serverId, providerId, operation, attempt);
}

export function useProviderLogin(
  serverId: string | null,
  providerId: string,
  provider: "claude" | "codex" = "codex",
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const hostConnected = useHostRuntimeIsConnected(serverId ?? "");
  const installation = readExecutionInstallation();
  const shared = useSharedInstallationSignIn(serverId, provider);
  const sharedClaude = shared && provider === "claude";
  const connected = shared || hostConnected;
  const cache = useQueryClient();
  const key = useMemo(() => ["providerLogin", serverId, providerId], [serverId, providerId]);
  const action = useMutation({
    gcTime: 0,
    mutationFn: async (operation: "start" | "cancel" | "sign-out" | { code: string }) => {
      if ((!client && !shared) || !connected)
        throw new Error("Reconnect to the host and try again.");
      await cache.cancelQueries({ queryKey: key });
      if (operation === "sign-out") {
        if (!shared) throw new Error("Installation subscription connection required.");
        return (await installationRequest(provider, serverId!, providerId, "sign-out")).login;
      }
      if (operation === "start") {
        if (shared)
          return (await installationRequest(provider, serverId!, providerId, "start")).login;
        return (await client!.startProviderLogin(providerId)).state;
      }
      const state = cache.getQueryData<ProviderLoginState>(key);
      if (!state || state.status === "idle")
        throw new Error("Refresh the sign-in status and try again.");
      if (sharedClaude && typeof operation === "object")
        return (
          await claudeSetupRequest(serverId!, providerId, "submit", {
            attemptId: state.attemptId,
            code: operation.code,
          })
        ).login;
      if (shared && typeof operation === "object")
        throw new Error("Codex sign-in uses a device code and takes no pasted code.");
      if (shared)
        return (
          await installationRequest(provider, serverId!, providerId, "cancel", {
            attemptId: state.attemptId,
          })
        ).login;
      if (typeof operation === "object")
        return (await client!.submitProviderLoginCode(providerId, state.attemptId, operation.code))
          .state;
      return (await client!.cancelProviderLogin(providerId, state.attemptId)).state;
    },
    onSuccess: (state) => cache.setQueryData(key, state),
  });
  const enabled = Boolean((client || shared) && connected && !action.isPending);
  const query = useFetchQuery({
    queryKey: key,
    queryFn: async () => {
      if (shared) return (await installationRequest(provider, serverId!, providerId, "read")).login;
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
    queryKey: [
      provider === "claude" ? "claude-setup-connection" : "codex-installation-connection",
      installation?.installationId,
      serverId,
      providerId,
    ],
    queryFn: async () =>
      (await installationRequest(provider, serverId!, providerId, "read")).connection,
    enabled: shared,
    refetchInterval: shared ? 2000 : false,
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
    /** One sign-in for the whole installation, through the coordinator. */
    shared,
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
