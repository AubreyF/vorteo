import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProfile, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { validateTaskHandoff } from "@/agent-profiles";
import type { WorkspaceStructureHostPlacement } from "@/projects/workspace-structure";

export const OTHER_CHATS_WARNING =
  "This workspace contains other chats. Recreating only one can lose substantial context in the new workspace. We recommend cancelling and keeping this workspace together. If you continue, the other chats stay in the original workspace and are not copied. The original is not deleted.";

export async function readWorkspaceChats(client: DaemonClient, workspaceId: string) {
  const chats: AgentSnapshotPayload[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.fetchAgents({
      filter: { includeArchived: true },
      page: { limit: 200, cursor },
    });
    for (const { agent } of page.entries) {
      if (agent.workspaceId === workspaceId && !agent.labels[PARENT_AGENT_ID_LABEL])
        chats.push(agent);
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return chats;
}

interface RecreateInput {
  sourceClient: DaemonClient;
  destinationClient: DaemonClient;
  source: AgentSnapshotPayload;
  target: WorkspaceStructureHostPlacement;
  profile: AgentProfile;
  context: string;
  workspaceName: string;
  idempotencyKey: string;
}

export async function recreateInProject(input: RecreateInput) {
  await validateTaskHandoff(input.sourceClient, input.source, input.context);
  const source =
    input.target.worktreeSupport === "supported"
      ? {
          kind: "worktree" as const,
          projectId: input.target.projectId,
          cwd: input.target.iconWorkingDir,
          action: "branch-off" as const,
        }
      : {
          kind: "directory" as const,
          projectId: input.target.projectId,
          path: input.target.iconWorkingDir,
        };
  const result = await input.destinationClient.createWorkspace({
    source,
    title: input.workspaceName,
    idempotencyKey: input.idempotencyKey,
    agent: {
      config: {
        provider: input.profile.provider,
        profileId: input.profile.id,
        model: input.profile.model,
        thinkingOptionId: input.profile.thinkingOptionId,
        cwd: input.target.iconWorkingDir,
        title: input.source.title ?? input.workspaceName,
      },
      labels: { "paseo:continued-from": input.source.id },
      initialPrompt:
        `Continue this task in the destination project. Inspect this project's files and instructions before making changes. ` +
        `The source workspace and its files remain in the original project; files, Git changes, other chats, attachments, tool results and hidden provider state were not copied. ` +
        `This is user-reviewed context from at most 30 recent text messages, not a complete transcript. Ask for missing context when necessary.\n\n<recorded-context>\n${input.context}\n</recorded-context>`,
    },
  });
  if (result.error) throw new Error(result.error);
  if (!result.workspace || !result.agent)
    throw new Error(
      "Creation did not return a workspace and chat. Retry to recover the same request.",
    );
  return { workspaceId: result.workspace.id, agentId: result.agent.id };
}
