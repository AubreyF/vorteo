import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ProviderSecretsReadResponseSchema,
  type ProviderSecretsReadResponse,
  type ProviderSecretsStatus,
} from "@getpaseo/protocol/provider-secrets";
import { useFetchQuery } from "@/data/query";
import { readExecutionInstallation } from "./policy";
import { OwnerAccessExpired } from "./client";

type SecretsAction = "read" | "set" | "clear";

/** Calls the coordinator's owner routes for shared provider keys. Values are never returned. */
async function requestProviderSecrets(
  action: SecretsAction,
  body: Record<string, string> = {},
): Promise<ProviderSecretsReadResponse> {
  const response = await fetch(`/api/installation/owner/provider-secrets/${action}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 401)
    throw new OwnerAccessExpired("Unlock Installation controls in General settings to continue.");
  if (response.status === 404)
    throw new Error("Shared keys are not available. Update the installation and try again.");
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const message =
      detail && typeof detail === "object" && "error" in detail && typeof detail.error === "string"
        ? detail.error
        : "Unable to save the key.";
    throw new Error(message);
  }
  return ProviderSecretsReadResponseSchema.parse(await response.json());
}

/** Shared key status for every provider definition, keyed by definition id. */
export function useProviderSecrets(enabled = true) {
  const installation = readExecutionInstallation();
  const queryClient = useQueryClient();
  const key = useMemo(
    () => ["installation-provider-secrets", installation?.installationId],
    [installation?.installationId],
  );
  const query = useFetchQuery({
    queryKey: key,
    queryFn: () => requestProviderSecrets("read"),
    enabled: enabled && installation !== null,
    refetchInterval: 5000,
    retry: false,
    dataShape: "value",
    staleTimeMs: 5000,
  });
  const byDefinition = useMemo(
    () =>
      new Map<string, ProviderSecretsStatus>(
        (query.data?.definitions ?? []).map((status) => [status.definitionId, status]),
      ),
    [query.data],
  );
  // set and clear return only the changed definition, so merge it into the cached list.
  const merge = useCallback(
    (changed: ProviderSecretsReadResponse) => {
      queryClient.setQueryData<ProviderSecretsReadResponse>(key, (previous) => {
        const ids = new Set(changed.definitions.map((status) => status.definitionId));
        return {
          definitions: [
            ...(previous?.definitions ?? []).filter((status) => !ids.has(status.definitionId)),
            ...changed.definitions,
          ],
        };
      });
    },
    [queryClient, key],
  );
  const setSecret = useCallback(
    async (definitionId: string, name: string, value: string) =>
      merge(await requestProviderSecrets("set", { definitionId, name, value })),
    [merge],
  );
  const clearSecret = useCallback(
    async (definitionId: string, name: string) =>
      merge(await requestProviderSecrets("clear", { definitionId, name })),
    [merge],
  );
  return { ...query, byDefinition, setSecret, clearSecret };
}

/** One line for a connection row when shared keys have not reached every environment yet. */
export function describeSecretDelivery(status: ProviderSecretsStatus | undefined): string | null {
  if (!status || status.ready || status.secrets.length === 0) return null;
  if (status.conflicts.length)
    return `Different ${status.conflicts.map((conflict) => conflict.name).join(", ")} values found. Set the key once to use it everywhere.`;
  const waiting = status.environments.find(
    (environment) => environment.status === "failed" || environment.status === "pending",
  );
  return waiting?.message ?? null;
}
