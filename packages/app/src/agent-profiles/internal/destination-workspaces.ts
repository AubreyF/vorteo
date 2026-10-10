import type {
  FetchWorkspacesOptions,
  FetchWorkspacesEntry,
  FetchWorkspacesPageInfo,
} from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface NewDestinationWorkspace {
  client: Pick<DaemonClient, "createWorkspace">;
  project: NonNullable<WorkspaceDescriptorPayload["projectMembership"]>;
  directory: string;
  title: string;
  idempotencyKey: string;
}

export async function createDestinationWorkspace(input: NewDestinationWorkspace) {
  const result = await input.client.createWorkspace({
    source: { kind: "directory", path: input.directory },
    projectMembership: input.project,
    title: input.title.trim() || "New workspace",
    idempotencyKey: input.idempotencyKey,
  });
  if (result.error) throw new Error(result.error);
  if (!result.workspace) throw new Error("Workspace creation is incomplete. Retry to recover it.");
  return result.workspace;
}

export interface DestinationWorkspaceClient {
  fetchWorkspaces(
    options?: Pick<FetchWorkspacesOptions, "page">,
  ): Promise<{ entries: FetchWorkspacesEntry[]; pageInfo: FetchWorkspacesPageInfo }>;
}

export async function readDestinationWorkspaces(client: DestinationWorkspaceClient) {
  const entries: WorkspaceDescriptorPayload[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.fetchWorkspaces({ page: { limit: 100, cursor } });
    entries.push(...page.entries.filter((item) => !item.archivingAt));
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}
