import {
  canonicalProfileId,
  resolveProviderType,
  sharedWorkflowProfileId,
} from "@getpaseo/protocol/provider-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { Button } from "@/components/ui/button";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { SidebarCallout, SidebarCalloutDescriptionText } from "@/components/sidebar-callout";
import { useSessionStore } from "@/stores/session-store";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useAgentProfiles } from "./internal/use-agent-profiles";
import {
  useAgentProfilePicker,
  type AgentProfileApplyTarget,
} from "./internal/use-agent-profile-picker";
import { profilePermissionMismatch } from "./permission-mismatch";

export function ProfilePermissionWarning({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const { profiles, legacyProfiles, supportsLaunch, accountIndependent } =
    useAgentProfiles(serverId);
  const { config } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const agent = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId]?.agents.get(agentId);
      return {
        profileId: session?.profile?.id,
        provider: session?.provider,
        mode: session?.currentModeId,
        running: session?.status === "running" || session?.turn.phase === "open",
      };
    }),
  );
  const preferences = config?.sharedProviderPreferences;
  const binding = agent.profileId ? preferences?.legacyProfiles[agent.profileId] : undefined;
  const oldProfileId = binding
    ? sharedWorkflowProfileId(binding.provider, binding.workflowId)
    : agent.profileId;
  const profileId =
    agent.profileId && preferences && accountIndependent
      ? canonicalProfileId(agent.profileId, preferences, config.providers)
      : oldProfileId;
  const profile =
    profiles?.find((candidate) => candidate.id === profileId) ??
    legacyProfiles.find((candidate) => candidate.id === profileId);
  if (!profile || !supportsLaunch || !agent.provider) return null;
  const providerType = resolveProviderType(agent.provider, config?.providers ?? {});
  if (profile.provider !== agent.provider && profile.provider !== providerType) return null;
  const entry = entries?.find((candidate) => candidate.provider === agent.provider);
  const mismatch = profilePermissionMismatch(profile, agent.mode, entry);
  if (!mismatch) return null;
  return (
    <PermissionWarningAction
      serverId={serverId}
      agentId={agentId}
      profileId={profile.id}
      provider={agent.provider}
      running={agent.running}
      current={mismatch.current}
      expected={mismatch.expected}
    />
  );
}

interface PermissionWarningActionProps {
  serverId: string;
  agentId: string;
  profileId: string;
  provider: string;
  running: boolean;
  current: string;
  expected: string;
}

function PermissionWarningAction({
  serverId,
  agentId,
  profileId,
  provider,
  running,
  current,
  expected,
}: PermissionWarningActionProps) {
  const providers = useMemo(() => [provider], [provider]);
  const target = useMemo<AgentProfileApplyTarget>(
    () => ({ kind: "agent", agentId, availableModeIds: null }),
    [agentId],
  );
  const picker = useAgentProfilePicker({ serverId, availableProviders: providers, target });
  const recreate = useCallback(
    () => picker?.applyProfile(profileId, { provider }),
    [picker, profileId, provider],
  );
  const runningHint = running ? " Stop this chat before recreating it." : "";
  const description = useMemo(
    () => (
      <>
        <SidebarCalloutDescriptionText>
          {`This chat uses ${current}. The saved profile uses ${expected}. Recreate the chat to use the updated permissions.${runningHint}`}
        </SidebarCalloutDescriptionText>
        <Button
          variant="outline"
          size="md"
          onPress={recreate}
          disabled={running || !picker || Boolean(picker.isApplying)}
          testID="profile-permission-recreate"
        >
          {picker?.isApplying ? "Preparing..." : "Recreate chat"}
        </Button>
      </>
    ),
    [current, expected, runningHint, recreate, running, picker],
  );
  return (
    <>
      <SidebarCallout
        title="Profile permissions changed"
        description={description}
        testID="profile-permission-warning"
      />
      {picker?.handoffElement}
    </>
  );
}
