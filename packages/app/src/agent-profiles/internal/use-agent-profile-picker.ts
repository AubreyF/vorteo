import { generateMessageId } from "@/types/stream";
import { readDestinationWorkspaces, resolveDestinationDirectory } from "./destination-workspaces";
import { selectWorkspaceStructureProjects } from "@/stores/session-store-hooks/selectors";
import type { HostProjectListItem } from "@/projects/host-project-model";
import { generateDraftId } from "@/stores/draft-keys";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
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
  refreshStatus?: () => void;
  isRefreshingStatus?: boolean;
  isLoadingStatus?: boolean;
  handoffElement?: ReactElement | null;
  isApplying?: boolean;
  rows: AgentProfilePickerRow[];
  applyDestinationProfile?: (serverId: string, profile: AgentProfile) => void;
  applyProfile: (
    profileId: string,
    choices?: Pick<AgentProfile, "model" | "thinkingOptionId">,
  ) => void;
}

interface PendingHandoff {
  source: AgentSnapshotPayload | null;
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
        if (handoff.source) {
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
        const current = await readDestinationWorkspaces(destinationClient);
        const destination = current.find((item) => item.id === workspace.id && !item.archivingAt);
        if (!destination) throw new Error("The destination workspace is no longer available.");
        const resolved = materializeAgentProfile(handoff.profile);
        navigateToWorkspace({
          serverId: handoff.destinationServerId,
          workspaceId: destination.id,
          target: {
            kind: "draft",
            draftId: generateDraftId(),
            setup: {
              provider: resolved.provider,
              profileId: resolved.profileId,
              cwd: destination.workspaceDirectory ?? destination.projectRootPath,
              model: resolved.modelId || null,
              modeId: resolved.modeId || null,
              thinkingOptionId: resolved.thinkingOptionId || null,
              featureValues: resolved.featureValues,
            },
          },
        });
        setHandoff(null);
        return;
      }
      if (!handoff.source) throw new Error("Source task not found.");
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
        key: `${handoff.source?.id ?? "draft"}:${handoff.profile.id}:${handoff.destinationServerId ?? serverId}`,
        name: handoff.profile.name,
        destinationServerId: handoff.destinationServerId,
        destinationProject: handoff.destinationProject,
        destinationDirectory: handoff.destinationDirectory,
        workspaceName: handoff.workspaceName,
        draft: handoff.source === null,
        ...(handoff.source === null
          ? {
              title: `Use ${handoff.profile.name}`,
              confirmLabel: "Open draft",
              description:
                "Open a thread in this project using the selected environment. Your original draft and its attachments stay in place.",
            }
          : {}),
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
      if (!client || !serverId || applyingRef.current) return;
      applyingRef.current = true;
      setIsApplying(true);
      void (async () => {
        try {
          let source: AgentSnapshotPayload | null = null;
          let context = "";
          if (target.kind === "agent") {
            const fetched = await client.fetchAgent(target.agentId);
            if (!fetched) throw new Error("Source task not found.");
            source = fetched.agent;
            context = await readProfileHandoff(client, source);
          }
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
          const draftProject = target.kind === "draft" ? target.controls.project : null;
          const selectedProject =
            draftProject ??
            projects.find((project) =>
              project.workspaceKeys.includes(`${serverId}:${workspaceId}`),
            );
          if (!selectedProject)
            throw new Error("Select a project before choosing a profile from another environment.");
          const destinationProject = {
            key: selectedProject.viewKey,
            name: selectedProject.projectName,
          };
          const destinationDirectory = await resolveDestinationDirectory({
            client: destinationClient,
            project: destinationProject,
            repositoryKey: selectedProject.projectKey,
          });
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
        unavailable: !availableProviders.includes(profile.provider),
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
    [applicableProfiles, availableProviders, entries, formatFeatureCount],
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
    (profileId: string, choices?: Pick<AgentProfile, "model" | "thinkingOptionId">) => {
      const saved =
        applicableProfiles.find((entry) => entry.id === profileId) ??
        legacyProfiles.find((entry) => entry.id === profileId);
      const profile = saved ? { ...saved, ...choices } : undefined;
      if (!profile || !availableProviders.includes(profile.provider)) {
        return;
      }
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
