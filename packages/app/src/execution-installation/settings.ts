import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  InstallationSettingsSnapshotSchema,
  type InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import { useFetchQuery } from "@/data/query";
import { readExecutionInstallation } from "./policy";
import { OwnerAccessExpired } from "./client";

export async function requestInstallationSettings(update?: InstallationSettingsUpdate) {
  const response = await fetch(`/api/installation/owner/${update ? "settings" : "settings/read"}`, {
    method: update ? "PATCH" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update ?? {}),
  });
  if (response.status === 401)
    throw new OwnerAccessExpired("Unlock Installation controls in General settings to continue.");
  if (response.status === 409)
    throw new Error("Shared settings changed. Reload and review the current values before saving.");
  if (!response.ok) throw new Error("Unable to access shared installation settings.");
  return InstallationSettingsSnapshotSchema.parse(await response.json());
}

export function useInstallationSettings(enabled = true) {
  const installation = readExecutionInstallation();
  const queryClient = useQueryClient();
  const installationId = installation?.installationId;
  const query = useFetchQuery({
    queryKey: ["installation-settings", installationId],
    queryFn: () => requestInstallationSettings(),
    enabled: enabled && installation !== null,
    refetchInterval: 5000,
    retry: false,
    dataShape: "value",
    staleTimeMs: 5000,
  });
  const save = useCallback(
    async (update: InstallationSettingsUpdate) => {
      const saved = await requestInstallationSettings(update);
      queryClient.setQueryData(["installation-settings", installationId], saved);
      return saved;
    },
    [queryClient, installationId],
  );
  return { ...query, installation, save };
}
