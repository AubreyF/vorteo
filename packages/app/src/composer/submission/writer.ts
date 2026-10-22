import type { MessageSubmissionWriter } from "@/composer/actions";
import { useSessionStore } from "@/stores/session-store";
import {
  appendSubmittedUserMessage,
  removeSubmittedUserMessage,
  type UserMessageItem,
} from "@/types/stream";

function appendUntrackedSubmission(serverId: string, agentId: string, message: UserMessageItem) {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) return;
  const tail = session.agentStreamTail.get(agentId) ?? [];
  const head = session.agentStreamHead.get(agentId) ?? [];
  useSessionStore
    .getState()
    .setAgentStreamState(serverId, agentId, appendSubmittedUserMessage({ tail, head, message }));
}

function removeUntrackedSubmission(
  serverId: string,
  agentId: string,
  clientMessageId: string,
): void {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) return;
  const tail = session.agentStreamTail.get(agentId) ?? [];
  const head = session.agentStreamHead.get(agentId) ?? [];
  useSessionStore
    .getState()
    .setAgentStreamState(
      serverId,
      agentId,
      removeSubmittedUserMessage({ tail, head, clientMessageId }),
    );
}

function createUntrackedMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  return {
    begin: (agentId, message) => appendUntrackedSubmission(serverId, agentId, message),
    accept: () => undefined,
    reject: (agentId, clientMessageId) => {
      removeUntrackedSubmission(serverId, agentId, clientMessageId);
      return "rejected";
    },
  };
}

// Covers several reconnect backoff steps on a flaky network without leaving the composer busy forever.
const SUBMISSION_OUTCOME_TIMEOUT_MS = 60_000;

/**
 * Resolves "accepted" once the host timeline contains the submitted message, or "unconfirmed"
 * once the agent's history has been resynchronized after a reconnect without it, or on timeout.
 */
export async function awaitMessageSubmissionOutcome(
  serverId: string,
  agentId: string,
  clientMessageId: string,
  timeoutMs = SUBMISSION_OUTCOME_TIMEOUT_MS,
): Promise<"accepted" | "unconfirmed"> {
  const generationAtFailure =
    useSessionStore.getState().sessions[serverId]?.historySyncGeneration ?? 0;
  const decide = (): "accepted" | "unconfirmed" | null => {
    const session = useSessionStore.getState().sessions[serverId];
    if (!session) return "unconfirmed";
    const submission = session.messageSubmissions
      .get(agentId)
      ?.find((item) => item.clientMessageId === clientMessageId);
    if (!submission) return "unconfirmed";
    if (submission.providerAcknowledged) return "accepted";
    const resynchronized =
      session.historySyncGeneration > generationAtFailure &&
      session.agentHistorySyncGeneration.get(agentId) === session.historySyncGeneration;
    return resynchronized ? "unconfirmed" : null;
  };
  const immediate = decide();
  if (immediate) return immediate;
  return await new Promise((resolve) => {
    let settled = false;
    let stopWatching: () => void = () => undefined;
    const finish = (outcome: "accepted" | "unconfirmed") => {
      if (settled) return;
      settled = true;
      stopWatching();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish(decide() ?? "unconfirmed"), timeoutMs);
    const unsubscribe = useSessionStore.subscribe(() => {
      const outcome = decide();
      if (outcome) finish(outcome);
    });
    stopWatching = () => {
      clearTimeout(timer);
      unsubscribe();
    };
  });
}

export function createMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  const supportsTrackedMessageSubmissions =
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features
      ?.canonicalSubmittedPrompts === true;
  if (!supportsTrackedMessageSubmissions) {
    // COMPAT(canonicalSubmittedPrompts): added in v0.2.6; remove the gate after 2027-01-31 once daemon floor >= v0.2.6.
    return createUntrackedMessageSubmissionWriter(serverId);
  }
  return {
    begin: (agentId, message) =>
      useSessionStore.getState().beginAgentMessageSubmission(serverId, agentId, message),
    accept: (agentId, clientMessageId) =>
      useSessionStore.getState().acceptAgentMessageSubmission(serverId, agentId, clientMessageId),
    reject: (agentId, clientMessageId) =>
      useSessionStore.getState().rejectAgentMessageSubmission(serverId, agentId, clientMessageId),
    awaitOutcome: (agentId, clientMessageId) =>
      awaitMessageSubmissionOutcome(serverId, agentId, clientMessageId),
  };
}

export function handoffCreatedAgentMessageSubmission(
  serverId: string,
  agentId: string,
  message: UserMessageItem,
): boolean {
  return useSessionStore.getState().handoffCreatedAgentUserMessage(serverId, agentId, message);
}
