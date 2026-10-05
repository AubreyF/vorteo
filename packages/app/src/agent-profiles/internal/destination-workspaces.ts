import type {
  FetchWorkspacesOptions,
  FetchWorkspacesEntry,
  FetchWorkspacesPageInfo,
} from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";

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
