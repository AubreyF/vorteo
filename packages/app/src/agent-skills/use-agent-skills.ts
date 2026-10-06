import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  AgentSkillSelection,
  AgentSkillsSaveResult,
  AgentSkillsStatus,
} from "@getpaseo/protocol/messages";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useInstallationSettings } from "@/execution-installation/settings";
import {
  previewInstallationSkills,
  installationSkillStatus,
  installationSkillConfirmations,
} from "@/execution-installation/skills";
import { confirmDialog } from "@/utils/confirm-dialog";

export function useAgentSkills(serverId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const localConnected = useHostRuntimeIsConnected(serverId);
  const localSupported = useHostFeature(serverId, "skillManagement");
  const { installation, data: shared, save: saveShared } = useInstallationSettings();
  const managed = Boolean(
    installation?.environments.some((environment) => environment.serverId === serverId),
  );
  const sharedSelection = shared?.settings?.skills?.selection;
  const connected = managed || localConnected;
  const supported = managed || localSupported;
  const installationId = installation?.installationId;
  const queryKey = useMemo(
    () =>
      managed
        ? (["installation", installationId, "agent-skills"] as const)
        : (["host", serverId, "agent-skills"] as const),
    [managed, installationId, serverId],
  );
  const reportedQueryError = useRef<Error | null>(null);
  const report = useCallback(
    (message: string, error: Error) => {
      console.error(`[Agent skills: ${serverId}]`, error);
      toast.error(message);
    },
    [serverId, toast],
  );
  const query = useFetchQuery<AgentSkillsStatus, Error>({
    queryKey,
    queryFn: async () => {
      if (managed) {
        if (!installation || !sharedSelection)
          throw new Error("Load shared skill settings before continuing.");
        const preview = await previewInstallationSkills(sharedSelection);
        return installationSkillStatus({
          preview,
          environments: installation.environments,
          selection: sharedSelection,
        });
      }
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.getAgentSkillsStatus();
    },
    enabled: managed ? Boolean(sharedSelection) : supported && client !== null,
    refetchInterval: managed ? 5000 : false,
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });
  useEffect(() => {
    if (!query.error || query.error === reportedQueryError.current) return;
    reportedQueryError.current = query.error;
    report(t("settings.host.skills.statusFailed"), query.error);
  }, [query.error, report, t]);
  const setStatus = useCallback(
    (status: AgentSkillsStatus) => queryClient.setQueryData(queryKey, status),
    [queryClient, queryKey],
  );
  const reconcile = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.reconcileAgentSkills();
    },
    onSuccess: setStatus,
    onError: (error: Error) => report(t("settings.host.skills.updateFailed"), error),
  });
  const uninstall = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.uninstallAgentSkills();
    },
    onSuccess: setStatus,
    onError: (error: Error) => report(t("settings.host.skills.uninstallFailed"), error),
  });
  const save = useMutation<
    AgentSkillsSaveResult,
    Error,
    { selection: AgentSkillSelection; confirmedRemovals: readonly string[] }
  >({
    mutationFn: async ({ selection, confirmedRemovals }) => {
      if (managed) {
        if (!installation || !shared?.settings)
          throw new Error("Load shared skill settings before saving.");
        const preview = await previewInstallationSkills(selection);
        const status = installationSkillStatus({
          preview,
          environments: installation.environments,
          selection,
        });
        if (status.confirmationRequired?.removals.some((name) => !confirmedRemovals.includes(name)))
          return status;
        await saveShared({
          expectedRevision: shared.revision,
          settings: { skills: { selection } },
          confirmedSkillRemovals: installationSkillConfirmations({
            preview,
            environments: installation.environments,
            confirmed: confirmedRemovals,
          }),
        });
        return { ...status, confirmationRequired: null };
      }
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.saveAgentSkillsSelection(selection, confirmedRemovals);
    },
    onSuccess: (result) => {
      if (!result.confirmationRequired) setStatus(result);
    },
    onError: (error) => report(t("settings.host.skills.saveSelectionFailed"), error),
  });
  const isWorking = reconcile.isPending || uninstall.isPending || save.isPending;
  const refetch = query.refetch;
  const reconcileAsync = reconcile.mutateAsync;
  const uninstallAsync = uninstall.mutateAsync;
  const saveAsync = save.mutateAsync;
  const saveWithConfirmation = useCallback(
    async (selection: AgentSkillSelection) => {
      const result = await saveAsync({ selection, confirmedRemovals: [] });
      if (!result.confirmationRequired) return;
      const removals = result.confirmationRequired.removals;
      const confirmed = await confirmDialog({
        title: t("settings.host.skills.removeTitle"),
        message: t("settings.host.skills.removeMessage", { skills: removals.join(", ") }),
        confirmLabel: t("settings.host.skills.actions.remove"),
        destructive: true,
      });
      if (!confirmed) return;
      const retry = await saveAsync({ selection, confirmedRemovals: removals });
      if (retry.confirmationRequired) throw new Error(t("settings.host.skills.saveFailed"));
    },
    [saveAsync, t],
  );
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const runReconcile = useCallback(async () => {
    if (managed) {
      if (!sharedSelection) return;
      await saveWithConfirmation(sharedSelection).catch((error: Error) =>
        report(t("settings.host.skills.updateFailed"), error),
      );
      return;
    }
    await reconcileAsync().catch(() => undefined);
  }, [reconcileAsync, managed, sharedSelection, saveWithConfirmation, report, t]);
  const runUninstall = useCallback(async () => {
    if (managed) {
      await saveWithConfirmation({ mode: "custom", skills: [] }).catch((error: Error) =>
        report(t("settings.host.skills.uninstallFailed"), error),
      );
      return;
    }
    await uninstallAsync().catch(() => undefined);
  }, [uninstallAsync, managed, saveWithConfirmation, report, t]);
  const saveSelection = useCallback(
    (selection: AgentSkillSelection, confirmedRemovals: readonly string[] = []) =>
      saveAsync({ selection, confirmedRemovals }),
    [saveAsync],
  );
  return {
    managed,
    connected,
    supported,
    status: query.data ?? null,
    error: query.error,
    isLoading: query.isLoading,
    isWorking,
    refresh,
    reconcile: runReconcile,
    uninstall: runUninstall,
    saveSelection,
  };
}
