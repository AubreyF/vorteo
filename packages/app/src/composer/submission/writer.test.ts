import { afterEach, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import type { UserMessageItem } from "@/types/stream";
import { awaitMessageSubmissionOutcome, createMessageSubmissionWriter } from "./writer";

const CANONICAL_ONLY_SERVER_ID = "canonical-only";

function submittedMessage(clientMessageId: string): UserMessageItem {
  return {
    kind: "user_message",
    id: clientMessageId,
    clientMessageId,
    text: "hello",
    timestamp: new Date("2026-07-31T10:00:00.000Z"),
  };
}

function initializeSession(serverId: string, features: Record<string, boolean>): void {
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: "0.2.6",
    features,
  });
}

function submissionIds(serverId: string): string[] {
  return (
    useSessionStore.getState().sessions[serverId]?.messageSubmissions.get("agent-1") ?? []
  ).map((submission) => submission.clientMessageId);
}

afterEach(() => {
  useSessionStore.getState().clearSession(CANONICAL_ONLY_SERVER_ID);
});

test("tracks submissions when canonical prompts are supported", () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });

  createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID).begin(
    "agent-1",
    submittedMessage("canonical-only-message"),
  );

  expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual(["canonical-only-message"]);
});

test("a lost send resolves accepted once the host timeline shows it", async () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });
  createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID).begin(
    "agent-1",
    submittedMessage("lost-reply"),
  );

  const outcome = awaitMessageSubmissionOutcome(CANONICAL_ONLY_SERVER_ID, "agent-1", "lost-reply");
  useSessionStore.getState().setAgentStreamState(CANONICAL_ONLY_SERVER_ID, "agent-1", {
    acknowledgedClientMessageIds: ["lost-reply"],
  });

  await expect(outcome).resolves.toBe("accepted");
});

test("a lost send resolves unconfirmed after a reconnect resync without it", async () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });
  createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID).begin(
    "agent-1",
    submittedMessage("never-arrived"),
  );

  const outcome = awaitMessageSubmissionOutcome(
    CANONICAL_ONLY_SERVER_ID,
    "agent-1",
    "never-arrived",
  );
  const store = useSessionStore.getState();
  store.bumpHistorySyncGeneration(CANONICAL_ONLY_SERVER_ID);
  store.markAgentHistorySynchronized(CANONICAL_ONLY_SERVER_ID, "agent-1");

  await expect(outcome).resolves.toBe("unconfirmed");
});

test("a lost send resolves unconfirmed when the host stays silent", async () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });
  createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID).begin(
    "agent-1",
    submittedMessage("silent"),
  );

  await expect(
    awaitMessageSubmissionOutcome(CANONICAL_ONLY_SERVER_ID, "agent-1", "silent", 5),
  ).resolves.toBe("unconfirmed");
});
