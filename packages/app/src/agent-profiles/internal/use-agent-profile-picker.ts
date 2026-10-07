import {
  resolveProviderType,
  isSharedWorkflowProfile,
} from "@getpaseo/protocol/provider-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { workspaceOwner } from "@/task-environments/workspaces";
import { resolveTaskDirectory } from "@/task-environments/directory";
import { useHosts } from "@/runtime/host-runtime";
import { generateMessageId } from "@/types/stream";
import { selectWorkspaceStructureProjects } from "@/stores/session-store-hooks/selectors";
import type { HostProjectListItem } from "@/projects/host-project-model";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { createElement, useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { router } from "expo-router";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import {
  createProfileSuccessor,
  createEnvironmentProfileSuccessor,
  readProfileHandoff,
} from "./successor";
import { ProfileHandoffModal } from "../handoff-modal";
import type {
  AgentProfile,
  AgentSnapshotPayload,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { useTranslation } from "react-i18next";
import { mergeCreateAgentSelectionPreferences } from "@/create-agent-preferences/preferences";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import {
  materializeAgentProfile,
  reconcileMaterializedProfileMode,
  toAgentConfigApply,
  type MaterializedAgentProfile,
} from "./materialize-profile";
import { buildAgentProfilePickerSummary } from "./profile-summary";
import { useAgentProfiles } from "./use-agent-profiles";

/** The draft composer owns profile application as one state transition. */
export interface DraftAgentProfileControls {
  project?: HostProjectListItem | null;
  applyProfile: (profile: MaterializedAgentProfile) => void;
}

export type AgentProfileApplyTarget =
  | {
      kind: "agent";
      agentId: string;
      availableModeIds: readonly string[] | null;
    }
  | { kind: "draft"; controls: DraftAgentProfileControls };

/** Everything the model picker renders for one profile. It never sees the profile itself. */
export interface AgentProfilePickerRow {
  id: string;
  provider: string;
  /** Empty when the profile names no model. */
  modelId: string;
  unavailable?: boolean;
  /** Icon registry key and identity colour; either may be empty for the default glyph. */
  icon: string;
  color: string;
  name: string;
  /** "Claude Code · Opus 5 · Plan · Think hard" */
  summary: string;
  localEndpoint?: { status: "reachable" | "unreachable"; checkedAt: string };
}

export interface AgentProfilePicker {
  currentEnvironmentOnly?: boolean;
  refreshStatus?: () => void;
  isRefreshingStatus?: boolean;
  isLoadingStatus?: boolean;
  handoffElement?: ReactElement | null;
  isApplying?: boolean;
  rows: AgentProfilePickerRow[];
  applyDestinationProfile?: (serverId: string, profile: AgentProfile) => void;
  applyProfile: (
    profileId: string,
    choices?: Partial<Pick<AgentProfile, "provider" | "model" | "thinkingOptionId">>,
  ) => void;
}

interface PendingHandoff {
  source: AgentSnapshotPayload;
  destinationServerId?: string;
  destinationProject?: NonNullable<WorkspaceDescriptorPayload["projectMembership"]>;
  destinationDirectory?: string;
  workspaceName?: string;
  idempotencyKey?: string;
  profile: AgentProfile;
  context: string;
  serverId: string;
}

export interface UseAgentProfilePickerInput {
  serverId: string | null;
  /**
   * Providers this composer can actually run; pass a stable reference. A profile
   * naming anything else is hidden rather than shown as a row that cannot do
   * what it says — a live agent is one provider's process and cannot switch, and
   * the draft form ignores a provider the host does not offer.
   */
  availableProviders: readonly string[];
  target: AgentProfileApplyTarget;
}

/**
 * The agent-profiles section of the model picker: the rows to draw, and what
 * pressing one does. A supported host returns an empty row list when there is
 * nothing applicable so the picker can retain its settings shortcut without
 * pinning an empty section. Unsupported or still-loading hosts return `null`.
 */
export function useAgentProfilePicker(
  input: UseAgentProfilePickerInput,
): AgentProfilePicker | null {
  const { serverId, availableProviders, target } = input;
  const { config: daemonConfig } = useDaemonConfig(serverId);
  const hosts = useHosts();
  const activeWorkspace = useActiveWorkspaceSelection();
  const activeWorkspaceId =
    activeWorkspace?.serverId === serverId ? activeWorkspace.workspaceId : null;
  const { t } = useTranslation();
  const {
    profiles,
    legacyProfiles,
    isSupported,
    supportsLaunch: hostSupportsLaunch,
  } = useAgentProfiles(serverId);
  // Profiles are host config, so their labels read from the host-wide catalog
  // rather than a workspace's. That is also the key the settings section uses,
  // so every composer on a host shares one query instead of adding its own.
  const {
    entries,
    refresh: refreshProviders,
    isRefreshing,
    isLoading,
  } = useProvidersSnapshot(serverId, { cwd: null });
  const { updatePreferences } = useFormPreferences();
  const supportsLaunch = hostSupportsLaunch;
  const client = useSessionStore((state) => state.sessions[serverId ?? ""]?.client ?? null);
  const toast = useToast();
  const [isApplying, setIsApplying] = useState(false);
  const applyingRef = useRef(false);
  const [handoff, setHandoff] = useState<PendingHandoff | null>(null);
  const closeHandoff = useCallback(() => setHandoff(null), []);
  const confirmHandoff = useCallback(
    async (context: string, workspace?: WorkspaceDescriptorPayload) => {
      if (!client || !handoff || handoff.serverId !== serverId)
        throw new Error("Reconnect to the original host before handing off.");
      if (handoff.destinationServerId) {
        const destinationClient =
          useSessionStore.getState().sessions[handoff.destinationServerId]?.client;
        if (!destinationClient || !workspace)
          throw new Error("Reconnect and select a destination workspace.");
        const successor = await createEnvironmentProfileSuccessor({
          sourceClient: client,
          destinationClient,
          source: handoff.source,
          sourceServerId: handoff.serverId,
          profile: handoff.profile,
          reviewedContext: context,
          workspaceId: workspace.id,
          idempotencyKey: handoff.idempotencyKey,
        });
        setHandoff(null);
        router.push(
          buildHostAgentDetailRoute(
            handoff.destinationServerId,
            successor.id,
            successor.workspaceId,
          ),
        );
        return;
      }
      const successor = await createProfileSuccessor(
        client,
        handoff.source,
        handoff.profile,
        context,
      );
      setHandoff(null);
      router.push(buildHostAgentDetailRoute(handoff.serverId, successor.id, successor.workspaceId));
    },
    [client, handoff, serverId],
  );
  const handoffElement = handoff
    ? createElement(ProfileHandoffModal, {
        key: `${handoff.source.id}:${handoff.profile.id}:${handoff.destinationServerId ?? serverId}`,
        name: handoff.profile.name,
        destinationServerId: handoff.destinationServerId,
        destinationProject: handoff.destinationProject,
        destinationDirectory: handoff.destinationDirectory,
        workspaceName: handoff.workspaceName,
        title: handoff.destinationServerId
          ? `Continue in ${hosts.find((host) => host.serverId === handoff.destinationServerId)?.label ?? "another environment"}`
          : undefined,
        initialContext: handoff.context,
        onClose: closeHandoff,
        onConfirm: confirmHandoff,
      })
    : null;
  const createSuccessor = useCallback(
    async (profile: AgentProfile) => {
      if (target.kind !== "agent" || !client || !serverId || applyingRef.current) return;
      applyingRef.current = true;
      setIsApplying(true);
      try {
        const source = await client.fetchAgent(target.agentId);
        if (!source) throw new Error("Source task not found.");
        const context = await readProfileHandoff(client, source.agent);
        setHandoff({ source: source.agent, profile, context, serverId });
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        applyingRef.current = false;
        setIsApplying(false);
      }
    },
    [target, client, serverId, toast],
  );

  const applyDestinationProfile = useCallback(
    (destinationServerId: string, profile: AgentProfile) => {
      if (target.kind === "draft") return;
      if (!client || !serverId || applyingRef.current) return;
      applyingRef.current = true;
      setIsApplying(true);
      void (async () => {
        try {
          const fetched = await client.fetchAgent(target.agentId);
          if (!fetched) throw new Error("Source task not found.");
          const source = fetched.agent;
          const context = await readProfileHandoff(client, source);
          const sessions = useSessionStore.getState().sessions;
          const workspaceId = source?.workspaceId ?? activeWorkspaceId;
          const sourceWorkspace = workspaceId
            ? sessions[serverId]?.workspaces.get(workspaceId)
            : null;
          const destinationClient = sessions[destinationServerId]?.client;
          const supportsMembership =
            sessions[destinationServerId]?.serverInfo?.features?.workspaceProjectMembership;
          if (!destinationClient) throw new Error("Reconnect to the selected environment.");
          if (!supportsMembership)
            throw new Error("Update the selected environment to keep this thread in its project.");
          const projects = selectWorkspaceStructureProjects(
            useSessionStore.getState(),
            Object.keys(sessions),
          );
          const owner = workspaceOwner(
            { serverId, workspaceId: workspaceId ?? "" },
            sourceWorkspace ?? undefined,
          );
          const selectedProject = projects.find((project) =>
            project.workspaceKeys.includes(`${owner.serverId}:${owner.workspaceId}`),
          );
          if (!selectedProject)
            throw new Error("Select a project before choosing a profile from another environment.");
          const destinationProject = {
            key: selectedProject.viewKey,
            name: selectedProject.projectName,
          };
          const destinationDirectory =
            (await resolveTaskDirectory({
              source: client,
              destination: destinationClient,
              directory: source.cwd,
            })) ?? "";
          setHandoff({
            source,
            profile,
            context,
            serverId,
            destinationServerId,
            destinationProject,
            destinationDirectory,
            workspaceName: sourceWorkspace?.name ?? "New workspace",
            idempotencyKey: generateMessageId(),
          });
        } catch (error) {
          toast.error(toErrorMessage(error));
        } finally {
          applyingRef.current = false;
          setIsApplying(false);
        }
      })();
    },
    [client, serverId, target, toast, activeWorkspaceId],
  );

  const applicableProfiles = useMemo(() => {
    if (!isSupported || !profiles) {
      return [];
    }
    const available = new Set(availableProviders);
    // Keep configured launch rows in place while provider catalogs load or refresh.
    return supportsLaunch
      ? profiles
      : profiles.filter((profile) => available.has(profile.provider));
  }, [availableProviders, isSupported, profiles, supportsLaunch]);

  const formatFeatureCount = useCallback(
    (count: number) =>
      count === 1
        ? t("settings.host.agentProfiles.featureCountOne", { count })
        : t("settings.host.agentProfiles.featureCount", { count }),
    [t],
  );

  const rows = useMemo<AgentProfilePickerRow[]>(
    () =>
      applicableProfiles.map((profile) => ({
        id: profile.id,
        unavailable: !availableProviders.some(
          (provider) =>
            provider === profile.provider ||
            (isSharedWorkflowProfile(profile.id) &&
              resolveProviderType(provider, daemonConfig?.providers ?? {}) === profile.provider),
        ),
        provider: profile.provider,
        modelId: profile.model?.trim() ?? "",
        icon: profile.icon ?? "",
        color: profile.color ?? "",
        name: profile.name,
        localEndpoint: entries
          ?.find((entry) => entry.provider === profile.provider)
          ?.models?.find((model) => model.id === profile.model?.trim())?.localEndpoint,
        summary: buildAgentProfilePickerSummary({
          profile,
          entries,
          formatFeatureCount,
        }),
      })),
    [applicableProfiles, availableProviders, entries, formatFeatureCount, daemonConfig],
  );

  const persistSelection = useCallback(
    (resolved: MaterializedAgentProfile) => {
      void updatePreferences((current) =>
        mergeCreateAgentSelectionPreferences({
          preferences: current,
          provider: resolved.provider,
          modelId: resolved.modelId,
          modeId: resolved.modeId,
          thinkingOptionId: resolved.thinkingOptionId,
          ...(Object.keys(resolved.featureValues).length > 0
            ? { featureValues: resolved.featureValues }
            : {}),
        }),
      ).catch((error) => {
        console.warn("[useAgentProfilePicker] persist profile selection failed", error);
      });
    },
    [updatePreferences],
  );

  const applyProfile = useCallback(
    (
      profileId: string,
      choices?: Partial<Pick<AgentProfile, "provider" | "model" | "thinkingOptionId">>,
    ) => {
      const saved =
        applicableProfiles.find((entry) => entry.id === profileId) ??
        legacyProfiles.find((entry) => entry.id === profileId);
      if (!saved) return;
      const compatibleAccounts = availableProviders.filter(
        (candidate) =>
          candidate === saved.provider ||
          (saved.id.startsWith("shared-profile/") &&
            resolveProviderType(candidate, daemonConfig?.providers ?? {}) === saved.provider),
      );
      const preferred = daemonConfig?.sharedProviderPreferences?.defaultProvider;
      const defaultAccount =
        compatibleAccounts.find((candidate) => candidate === preferred) ?? compatibleAccounts[0];
      const provider = choices?.provider ?? defaultAccount;
      if (!provider || !compatibleAccounts.includes(provider)) {
        toast.error("The selected account is unavailable. Choose another account.");
        return;
      }
      const profile = { ...saved, ...choices, provider };
      const resolved = materializeAgentProfile(profile);

      if (target.kind === "draft") {
        if (!supportsLaunch) {
          if (profile.instructions || profile.workerProfileId) {
            toast.error(
              "Enable Vorteo Mode on a supported host to launch a preset with instructions or workers.",
            );
            return;
          }
          delete resolved.profileId;
        }
        target.controls.applyProfile(resolved);
        return;
      }

      if (supportsLaunch) {
        void createSuccessor(profile);
        return;
      }

      const reconciled = reconcileMaterializedProfileMode(resolved, target.availableModeIds);
      if (!reconciled) {
        return;
      }
      persistSelection(reconciled);
      if (!client) {
        return;
      }
      void client
        .applyAgentConfig(target.agentId, toAgentConfigApply(reconciled))
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.warn("[useAgentProfilePicker] applyAgentConfig failed", error);
          toast.error(toErrorMessage(error));
        });
    },
    [
      applicableProfiles,
      daemonConfig,
      legacyProfiles,
      availableProviders,
      client,
      persistSelection,
      target,
      toast,
      supportsLaunch,
      createSuccessor,
    ],
  );

  const refreshStatus = useCallback(() => {
    const providers = [
      ...new Set(rows.filter((row) => row.localEndpoint).map((row) => row.provider)),
    ];
    if (!providers.length) return;
    void refreshProviders(providers).catch((error) => toast.error(toErrorMessage(error)));
  }, [rows, refreshProviders, toast]);

  const isLoadingStatus =
    isLoading ||
    Boolean(
      entries?.some(
        (entry) =>
          entry.enabled &&
          entry.status === "loading" &&
          profiles?.some((profile) => profile.provider === entry.provider),
      ),
    );

  return useMemo(
    () =>
      isSupported && profiles !== null
        ? {
            rows,
            currentEnvironmentOnly: target.kind === "draft",
            applyProfile,
            applyDestinationProfile,
            isApplying,
            handoffElement,
            refreshStatus,
            isRefreshingStatus: isRefreshing,
            isLoadingStatus,
          }
        : null,
    [
      applyProfile,
      applyDestinationProfile,
      target.kind,
      isSupported,
      profiles,
      rows,
      isApplying,
      handoffElement,
      refreshStatus,
      isRefreshing,
      isLoadingStatus,
    ],
  );
}
