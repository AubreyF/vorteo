import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProfile, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

type HandoffClient = Pick<
  DaemonClient,
  "fetchAgentTimeline" | "fetchAgent" | "fetchAgents" | "createAgent"
>;

export async function readProfileHandoff(client: HandoffClient, source: AgentSnapshotPayload) {
  if (source.activeTurn || source.status === "running") {
    throw new Error("Stop the current task before handing it to another preset.");
  }
  const timeline = await client.fetchAgentTimeline(source.id, { direction: "tail", limit: 100 });
  const messages = timeline.entries
    .flatMap((entry) => {
      const item = entry.item;
      if (item.type !== "user_message" && item.type !== "assistant_message") return [];
      return [`${item.type}:\n${item.text}`];
    })
    .slice(-30);
  return messages.join("\n\n").slice(-50_000);
}

/** Uses recorded text, never asks the exhausted provider to summarize itself. */
export async function createProfileSuccessor(
  client: HandoffClient,
  source: AgentSnapshotPayload,
  profile: AgentProfile,
  reviewedContext: string,
) {
  await validateTaskHandoff(client, source, reviewedContext);
  return client.createAgent({
    config: {
      provider: profile.provider,
      profileId: profile.id,
      model: profile.model,
      thinkingOptionId: profile.thinkingOptionId,
      cwd: source.cwd,
      title: source.title ?? "Continued task",
    },
    workspaceId: source.workspaceId,
    labels: { "paseo:continued-from": source.id },
    initialPrompt:
      `Continue task ${source.id} using the selected preset. Review the working tree before changing anything. ` +
      `The following is user-reviewed handoff context, initially drawn from at most 30 recent text messages. ` +
      `Attachments, tool results and hidden provider state are not transferred automatically. Ask for missing context when necessary.\n\n<recorded-context>\n${reviewedContext}\n</recorded-context>`,
  });
}

export async function validateTaskHandoff(
  client: HandoffClient,
  source: AgentSnapshotPayload,
  reviewedContext: string,
) {
  if (source.activeTurn || source.status === "running") {
    throw new Error("Stop the current task before handing it to another preset.");
  }
  const children = await client.fetchAgents({
    filter: {
      labels: { [PARENT_AGENT_ID_LABEL]: source.id },
      statuses: ["running", "initializing"],
    },
    page: { limit: 1 },
  });
  if (children.entries.length)
    throw new Error("Stop this task's active workers before creating a successor.");
  if (!reviewedContext.trim() || reviewedContext.length > 50_000) {
    throw new Error("Provide handoff context between 1 and 50,000 characters.");
  }
  const current = await client.fetchAgent(source.id);
  if (!current || current.agent.activeTurn || current.agent.updatedAt !== source.updatedAt) {
    throw new Error("The source task changed. Review it and retry the handoff.");
  }
}
