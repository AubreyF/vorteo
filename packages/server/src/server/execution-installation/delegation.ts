import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const AgentIdSchema = z.string().uuid();
export const DelegationRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list") }),
  z.strictObject({ operation: z.literal("workspaces") }),
  z.strictObject({ operation: z.literal("providers") }),
  z.strictObject({ operation: z.literal("inspect"), agentId: AgentIdSchema }),
  z.strictObject({
    operation: z.literal("activity"),
    agentId: AgentIdSchema,
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.strictObject({ operation: z.literal("stop"), agentId: AgentIdSchema }),
  z.strictObject({
    operation: z.literal("send"),
    agentId: AgentIdSchema,
    messageId: z.string().uuid(),
    text: z.string().min(1).max(12000),
  }),
  z.strictObject({
    operation: z.literal("create"),
    idempotencyKey: z.string().uuid(),
    provider: z.string().min(1),
    workspaceId: z.string().min(1),
    title: z.string().min(1).max(200),
    initialPrompt: z.string().min(1).max(12000),
    model: z.string().optional(),
  }),
]);

export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;
export type DelegationClient = Pick<
  DaemonClient,
  | "fetchWorkspaces"
  | "listAvailableProviders"
  | "fetchAgents"
  | "fetchAgent"
  | "fetchAgentTimeline"
  | "cancelAgent"
  | "sendAgentMessage"
  | "createAgent"
>;

/** This surface only addresses the configured container. It cannot select a host. */
export async function delegateToContainer(
  client: DelegationClient,
  request: DelegationRequest,
): Promise<unknown> {
  switch (request.operation) {
    case "workspaces":
      return client.fetchWorkspaces();
    case "providers":
      return client.listAvailableProviders();
    case "list":
      return client.fetchAgents({ filter: { includeArchived: false } });
    case "inspect":
      return client.fetchAgent({ agentId: request.agentId });
    case "activity":
      return client.fetchAgentTimeline(request.agentId, { limit: request.limit ?? 30 });
    case "stop":
      await client.cancelAgent(request.agentId);
      return { stopped: request.agentId };
    case "send":
      await client.sendAgentMessage(request.agentId, request.text, {
        messageId: request.messageId,
        origin: "agent",
      });
      return { sent: request.messageId, agentId: request.agentId };
    case "create": {
      let cursor: string | undefined;
      let cwd: string | undefined;
      do {
        const page = await client.fetchWorkspaces({ page: { limit: 200, cursor } });
        const workspace = page.entries.find((entry) => entry.id === request.workspaceId);
        if (workspace) {
          cwd = workspace.workspaceDirectory;
          break;
        }
        cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      } while (cursor);
      if (!cwd) throw new Error("Container workspace was not found");
      return client.createAgent({
        provider: request.provider,
        cwd,
        workspaceId: request.workspaceId,
        title: request.title,
        initialPrompt: request.initialPrompt,
        origin: "agent",
        idempotencyKey: request.idempotencyKey,
        model: request.model,
      });
    }
  }
}
