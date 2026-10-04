import { useCallback, useMemo, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { ProfileHandoffModal, readProfileHandoff, useAgentProfiles } from "@/agent-profiles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import type { WorkspaceStructureHostPlacement } from "@/projects/workspace-structure";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { generateMessageId } from "@/types/stream";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { OTHER_CHATS_WARNING, readWorkspaceChats, recreateInProject } from "./recreate";

interface Props {
  workspace: SidebarWorkspacePlacement;
  project: SidebarProjectEntry;
  onClose: () => void;
}
interface Review {
  source: AgentSnapshotPayload;
  context: string;
  target: WorkspaceStructureHostPlacement;
  profile: AgentProfile;
  otherChats: boolean;
}
interface Selection {
  chatId: string | null;
  serverId: string;
  profileId: string | null;
  review: Review | null;
}
type Action =
  | { type: "chat"; id: string }
  | { type: "host"; id: string }
  | { type: "profile"; id: string }
  | { type: "review"; review: Review };
function reduce(state: Selection, action: Action): Selection {
  switch (action.type) {
    case "chat":
      return { ...state, chatId: action.id };
    case "host":
      return { ...state, serverId: action.id, profileId: null };
    case "profile":
      return { ...state, profileId: action.id };
    case "review":
      return { ...state, review: action.review };
  }
}

function useRecreationForm({ workspace, project, onClose }: Props) {
  const [state, dispatch] = useReducer(reduce, {
    chatId: null,
    serverId:
      project.hosts.find((host) => host.serverId === workspace.serverId)?.serverId ??
      project.hosts[0]?.serverId ??
      "",
    profileId: null,
    review: null,
  });
  const [requestId] = useState(generateMessageId);
  const sourceClient = useHostRuntimeClient(workspace.serverId);
  const destinationClient = useHostRuntimeClient(state.serverId);
  const hosts = useHosts();
  const { profiles, supportsLaunch } = useAgentProfiles(state.serverId);
  const supportsCreation = useSessionStore((store) => {
    const features = store.sessions[state.serverId]?.serverInfo?.features;
    return features?.workspaceMultiplicity === true && features.workspaceRequestReceipts === true;
  });
  const chats = useFetchQuery({
    dataShape: "value",
    immutableWhen: () => true,
    queryKey: ["project-recreation-chats", workspace.serverId, workspace.workspaceId, requestId],
    queryFn: () => {
      if (!sourceClient) throw new Error("Reconnect the source environment to load its chats.");
      return readWorkspaceChats(sourceClient, workspace.workspaceId);
    },
    retry: false,
  });
  const chat = chats.data?.find((entry) => entry.id === state.chatId) ?? null;
  const profile = profiles?.find((entry) => entry.id === state.profileId) ?? null;
  const target = project.hosts.find((entry) => entry.serverId === state.serverId) ?? null;
  const hasOtherChats = (chats.data?.length ?? 0) > 1;
  const prepare = useMutation({
    mutationFn: async () => {
      if (!sourceClient || !chat || !target || !profile)
        throw new Error("Choose a chat, destination environment and profile.");
      const latest = await sourceClient.fetchAgent(chat.id);
      if (!latest || latest.agent.workspaceId !== workspace.workspaceId)
        throw new Error("The source chat is no longer in this workspace. Close and try again.");
      const context = await readProfileHandoff(sourceClient, latest.agent);
      const currentChats = await readWorkspaceChats(sourceClient, workspace.workspaceId);
      return {
        source: latest.agent,
        context,
        target,
        profile,
        otherChats: currentChats.length > 1,
      };
    },
    onSuccess: (review) => dispatch({ type: "review", review }),
  });
  const review = state.review;
  const confirm = useCallback(
    async (context: string) => {
      if (!review) throw new Error("Review a chat before recreating it.");
      if (!sourceClient || !destinationClient)
        throw new Error("Reconnect both environments before recreating this workspace.");
      if (!supportsLaunch || !supportsCreation)
        throw new Error("Update the destination environment before recreating workspaces.");
      const result = await recreateInProject({
        sourceClient,
        destinationClient,
        source: review.source,
        target: review.target,
        profile: review.profile,
        context,
        workspaceName: workspace.name,
        idempotencyKey: requestId,
      });
      onClose();
      router.push(
        buildHostAgentDetailRoute(review.target.serverId, result.agentId, result.workspaceId),
      );
    },
    [
      review,
      sourceClient,
      destinationClient,
      supportsLaunch,
      supportsCreation,
      workspace.name,
      requestId,
      onClose,
    ],
  );

  const busy = prepare.isPending;
  const selectChat = useCallback((id: string) => dispatch({ type: "chat", id }), []);
  const selectHost = useCallback((id: string) => dispatch({ type: "host", id }), []);
  const selectProfile = useCallback((id: string) => dispatch({ type: "profile", id }), []);
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  const retry = useCallback(() => {
    void chats.refetch();
  }, [chats]);
  const prepareHandoff = useCallback(() => {
    if (!busy) prepare.mutate();
  }, [busy, prepare]);
  const available = supportsLaunch && supportsCreation;
  const canPrepare = Boolean(chat && target && profile && available && !busy);
  return {
    chat,
    profile,
    target,
    profiles,
    hosts,
    chats,
    prepare,
    review,
    busy,
    available,
    canPrepare,
    confirm,
    selectChat,
    selectHost,
    selectProfile,
    close,
    retry,
    prepareHandoff,
    hasOtherChats,
  };
}

export function ProjectRecreationModal(props: Props) {
  const { project, onClose } = props;
  const form = useRecreationForm(props);
  const { review, busy, hasOtherChats, canPrepare, chats, prepare } = form;
  const header = useMemo(
    () => ({ title: `Recreate in ${project.projectName}` }),
    [project.projectName],
  );
  if (review) {
    return (
      <ProfileHandoffModal
        name={review.profile.name}
        title={`Recreate in ${project.projectName}`}
        description={`Start one new chat with ${review.profile.name} in ${review.target.iconWorkingDir}. The destination profile's current permissions apply. Files and Git changes are not copied. The original workspace stays available. ${review.target.worktreeSupport === "supported" ? "A new Git worktree will be created." : "The new chat will use the destination project's existing folder."}`}
        warning={review.otherChats ? OTHER_CHATS_WARNING : undefined}
        confirmLabel={review.otherChats ? "Recreate anyway" : "Recreate workspace"}
        initialContext={review.context}
        onClose={onClose}
        onConfirm={form.confirm}
      />
    );
  }
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={form.close}
      desktopMaxWidth={640}
      testID="project-recreation-modal"
    >
      <View style={styles.body}>
        <Text style={styles.text}>
          Choose one chat to continue in a new workspace in this project. Review its handoff before
          starting. The original workspace stays available; files, Git changes, other chats,
          attachments and tool results are not copied.
        </Text>
        {hasOtherChats ? (
          <Alert
            variant="warning"
            title="Other chats will not be copied"
            description={OTHER_CHATS_WARNING}
          />
        ) : null}
        <RecreationFields form={form} project={project} />
        {!form.available ? (
          <Text style={styles.text} accessibilityRole="alert">
            Connect and update the destination environment to enable workspace recreation.
          </Text>
        ) : null}
        {chats.error ? (
          <>
            <Text style={styles.text} accessibilityRole="alert">
              {toErrorMessage(chats.error)}
            </Text>
            <Button onPress={form.retry}>Retry loading chats</Button>
          </>
        ) : null}
        {prepare.error ? (
          <Text style={styles.text} accessibilityRole="alert">
            {toErrorMessage(prepare.error)}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button variant="ghost" disabled={busy} onPress={onClose}>
            Cancel
          </Button>
          <Button disabled={!canPrepare} onPress={form.prepareHandoff} testID="recreation-review">
            {busy ? "Preparing..." : "Review handoff"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));

function RecreationFields({
  form,
  project,
}: {
  form: ReturnType<typeof useRecreationForm>;
  project: SidebarProjectEntry;
}) {
  const { chat, chats, profile, profiles, target, hosts, busy } = form;
  const chatDisplay = useMemo(() => (chat ? { label: chat.title ?? chat.id } : null), [chat]);
  const profileDisplay = useMemo(() => (profile ? { label: profile.name } : null), [profile]);
  const hostDisplay = useMemo(
    () =>
      target
        ? {
            label:
              hosts.find((host) => host.serverId === target.serverId)?.label ?? target.serverId,
          }
        : null,
    [hosts, target],
  );
  return (
    <>
      <SelectField
        label="Chat to recreate"
        value={chat?.id ?? null}
        selectedDisplay={chatDisplay}
        options={(chats.data ?? []).map((entry) => ({
          id: entry.id,
          value: entry.id,
          label: entry.title ?? entry.id,
          description: entry.status,
        }))}
        onChange={form.selectChat}
        placeholder="Choose a chat"
        emptyText="This workspace has no chats to recreate."
        loading={chats.isPending}
        disabled={busy || chats.isPending}
        testID="recreation-chat"
      />
      <SelectField
        label="Destination environment"
        value={target?.serverId ?? null}
        selectedDisplay={hostDisplay}
        options={project.hosts.map((host) => ({
          id: host.serverId,
          value: host.serverId,
          label: hosts.find((entry) => entry.serverId === host.serverId)?.label ?? host.serverId,
          description: host.iconWorkingDir,
        }))}
        onChange={form.selectHost}
        placeholder="Choose an environment"
        emptyText="No destination environments available"
        disabled={busy}
        testID="recreation-environment"
      />
      <SelectField
        label="Destination profile"
        value={profile?.id ?? null}
        selectedDisplay={profileDisplay}
        options={(profiles ?? []).map((entry) => ({
          id: entry.id,
          value: entry.id,
          label: entry.name,
          description: `${entry.provider} / ${entry.model ?? "default model"}`,
        }))}
        onChange={form.selectProfile}
        placeholder="Choose a profile"
        emptyText="Add a profile in the destination environment's settings."
        loading={profiles === null}
        disabled={busy || profiles === null}
        testID="recreation-profile"
      />
    </>
  );
}
