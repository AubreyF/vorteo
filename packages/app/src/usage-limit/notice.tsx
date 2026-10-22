import type { AgentUsageLimitResumeAction } from "@getpaseo/protocol/usage-limit";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { useShallow } from "zustand/shallow";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useReportActionError } from "@/hooks/use-action-error";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { usageLimitNotice } from "./model";

/** Shown above the composer while the thread waits for its account's usage limit to reset. */
export function UsageLimitNotice({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { supported, hold, archived } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agentDetails.get(agentId) ?? session?.agents.get(agentId);
      return {
        supported: session?.serverInfo?.features?.usageLimitResume === true,
        hold: agent?.usageLimitHold,
        archived: agent?.archivedAt != null,
      };
    }),
  );
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const reportError = useReportActionError();
  const mutation = useMutation({
    mutationFn: async (action: AgentUsageLimitResumeAction) => {
      if (!client || !connected) throw new Error("Reconnect to the host and try again.");
      return client.setAgentUsageLimitResume(agentId, action);
    },
    onError: reportError,
    retry: false,
  });
  const { mutate } = mutation;
  const resumeNow = useCallback(() => mutate("resume_now"), [mutate]);
  const dontResume = useCallback(() => mutate("dont_resume"), [mutate]);
  if (!supported || archived) return null;
  const notice = usageLimitNotice(hold, { now: new Date() });
  if (!notice) return null;
  const disabled = !connected || mutation.isPending;
  const pendingAction = mutation.isPending ? mutation.variables : null;
  return (
    <Alert variant="warning" size="sm" description={notice.message} testID="usage-limit-notice">
      {notice.canStopResume ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          loading={pendingAction === "dont_resume"}
          onPress={dontResume}
          testID="usage-limit-dont-resume"
        >
          {"Don't resume"}
        </Button>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        loading={pendingAction === "resume_now"}
        onPress={resumeNow}
        testID="usage-limit-resume-now"
      >
        Resume now
      </Button>
    </Alert>
  );
}
