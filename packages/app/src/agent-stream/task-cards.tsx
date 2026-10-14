import { useIsCompactFormFactor } from "@/constants/layout";
import { InlineFilesCard } from "./inline-files-card";
import { JournalCard } from "@/journal/card";
import { AgentHistoryTracks } from "@/panels/agent-tracks";
import { useCallback, useState } from "react";
import { GoalBar } from "@/goals/goal-bar";
import { GoalDetails } from "@/goals/goal-details";
import { useAgentGoal } from "@/goals/use-agent-goal";
import { SharedQueueView } from "@/message-queue/queue-view";
import { useMessageQueue } from "@/message-queue/use-message-queue";
import { goalQueueNotice } from "@/goals/goal-presentation";
import { LegacyQueueImport } from "@/message-queue/legacy-import";
import { PanePortal } from "@/panels/pane-context";

const ignoreCreatedDraft = () => {};

export function AgentTaskCards({
  serverId,
  agentId,
  workspaceId,
  cwd,
  queueHostName,
}: {
  serverId: string;
  agentId: string;
  workspaceId?: string;
  cwd: string;
  queueHostName?: string;
}) {
  const compact = useIsCompactFormFactor();
  const queue = useMessageQueue(serverId, agentId);
  const goal = useAgentGoal(serverId, agentId);
  const [queueReviewRequest, setQueueReviewRequest] = useState(0);
  const reviewMessages = useCallback(() => setQueueReviewRequest((value) => value + 1), []);
  const [expanded, setExpanded] = useState(false);
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => setExpanded(false), []);
  const queueCards = (
    <>
      <LegacyQueueImport serverId={serverId} agentId={agentId} cwd={cwd} />
      <SharedQueueView
        serverId={serverId}
        agentId={agentId}
        control={queue}
        goalErrorHandled={goal.supported}
        reviewRequest={queueReviewRequest}
      />
    </>
  );
  return (
    <>
      <GoalBar
        control={goal}
        onExpand={open}
        queueNotice={goalQueueNotice(goal.state, queue.snapshot, queue.error)}
        onReviewMessages={reviewMessages}
      />
      {workspaceId ? (
        <AgentHistoryTracks
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          cwd={cwd}
        />
      ) : (
        <JournalCard serverId={serverId} agentId={agentId} />
      )}
      {compact && workspaceId ? (
        <InlineFilesCard serverId={serverId} workspaceId={workspaceId} cwd={cwd} />
      ) : null}
      {/* The portal transport captures its host on mount; remount when moving the queue. */}
      {queueHostName ? (
        <PanePortal key={queueHostName} hostName={queueHostName}>
          {queueCards}
        </PanePortal>
      ) : (
        queueCards
      )}
      {expanded && goal.supported ? (
        <GoalDetails control={goal} draft="" onClose={close} onCreated={ignoreCreatedDraft} />
      ) : null}
    </>
  );
}
