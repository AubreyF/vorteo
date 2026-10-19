import { useIsCompactFormFactor } from "@/constants/layout";
import { InlineFilesCard } from "./inline-files-card";
import { JournalCard } from "@/journal/card";
import { OpenQuestionsCard } from "@/open-questions/card";
import { AgentHistoryTracks } from "@/panels/agent-tracks";
import { useCallback, useState } from "react";
import { GoalBar } from "@/goals/goal-bar";
import { GoalDetails } from "@/goals/goal-details";
import { useAgentGoal } from "@/goals/use-agent-goal";
import { SharedQueueView } from "@/message-queue/queue-view";
import { useMessageQueue } from "@/message-queue/use-message-queue";
import { goalQueueNotice } from "@/goals/goal-presentation";
import { LegacyQueueImport } from "@/message-queue/legacy-import";

const ignoreCreatedDraft = () => {};

export function AgentTaskCards({
  serverId,
  agentId,
  workspaceId,
  cwd,
  onReviewMessages,
  hasWorkspaceCards = false,
}: {
  serverId: string;
  agentId: string;
  workspaceId?: string;
  cwd: string;
  onReviewMessages: () => void;
  hasWorkspaceCards?: boolean;
}) {
  const compact = useIsCompactFormFactor();
  const queue = useMessageQueue(serverId, agentId);
  const goal = useAgentGoal(serverId, agentId);
  const [expanded, setExpanded] = useState(false);
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => setExpanded(false), []);
  return (
    <>
      <GoalBar
        control={goal}
        onExpand={open}
        queueNotice={goalQueueNotice(goal.state, queue.snapshot, queue.error)}
        onReviewMessages={onReviewMessages}
      />
      {workspaceId ? (
        <AgentHistoryTracks
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          cwd={cwd}
        />
      ) : (
        <>
          <OpenQuestionsCard serverId={serverId} agentId={agentId} />
          <JournalCard serverId={serverId} agentId={agentId} />
        </>
      )}
      {compact && workspaceId && !hasWorkspaceCards ? (
        <InlineFilesCard serverId={serverId} workspaceId={workspaceId} cwd={cwd} />
      ) : null}
      {expanded && goal.supported ? (
        <GoalDetails control={goal} draft="" onClose={close} onCreated={ignoreCreatedDraft} />
      ) : null}
    </>
  );
}

/** Keep queue activity in the conversation, outside the retained details dock. */
export function AgentQueueCards({
  serverId,
  agentId,
  cwd,
  reviewRequest,
}: {
  serverId: string;
  agentId: string;
  cwd: string;
  reviewRequest: number;
}) {
  const queue = useMessageQueue(serverId, agentId);
  const goal = useAgentGoal(serverId, agentId);
  return (
    <>
      <LegacyQueueImport serverId={serverId} agentId={agentId} cwd={cwd} />
      <SharedQueueView
        serverId={serverId}
        agentId={agentId}
        control={queue}
        goalErrorHandled={goal.supported}
        reviewRequest={reviewRequest}
      />
    </>
  );
}
