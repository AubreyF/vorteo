import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import {
  InstallationProfilesSnapshotSchema,
  type InstallationProfilesPatch,
} from "@getpaseo/protocol/execution-installation";
import { z } from "zod";
import { readExecutionInstallation } from "./policy";
import { OwnerAccessExpired } from "./client";

async function requestProfiles(patch?: InstallationProfilesPatch) {
  const route = patch ? "profiles" : "profiles/read";
  const response = await fetch(`/api/installation/owner/${route}`, {
    method: patch ? "PATCH" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch ?? {}),
  });
  if (response.status === 401) {
    throw new OwnerAccessExpired(
      "Unlock Installation controls in General settings to edit profiles.",
    );
  }
  if (!response.ok) {
    const detail = z.object({ error: z.string() }).safeParse(await response.json());
    throw new Error(detail.success ? detail.data.error : "Unable to load installation profiles.");
  }
  return InstallationProfilesSnapshotSchema.parse(await response.json());
}

export function useInstallationProfiles() {
  const installation = readExecutionInstallation();
  const queryClient = useQueryClient();
  const query = useFetchQuery({
    queryKey: ["installation-profiles", installation?.installationId],
    queryFn: () => requestProfiles(),
    enabled: installation !== null,
    refetchInterval: 5000,
    retry: false,
    dataShape: "value",
    staleTimeMs: 5000,
  });
  const save = useCallback(
    async (patch: InstallationProfilesPatch) => {
      const saved = await requestProfiles(patch);
      queryClient.setQueryData(["installation-profiles", installation?.installationId], saved);
      return saved;
    },
    [queryClient, installation?.installationId],
  );
  return { ...query, installation, save };
}
