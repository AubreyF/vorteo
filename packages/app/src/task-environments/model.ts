import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  type DestinationWorkspaceClient,
  readDestinationWorkspaces,
  createDestinationWorkspace,
} from "@/agent-profiles/internal/destination-workspaces";
import { resolveTaskDirectory } from "./directory";
import { sameWorkspaceReference, type WorkspaceEnvironmentReference } from "./workspaces";

interface EnvironmentClient {
  client: DestinationWorkspaceClient &
    Pick<DaemonClient, "browseProjectDirectories" | "createWorkspace">;
  supportsBindings: boolean;
}
export interface TaskEnvironmentState {
  serverId: string;
  directory: string;
  workspaceId: string | null;
  status: "ready" | "resolving" | "folder" | "error";
  error: string | null;
}
interface TaskEnvironmentOptions {
  owner: WorkspaceEnvironmentReference;
  directory: string;
  name: string;
  project: NonNullable<WorkspaceDescriptorPayload["projectMembership"]>;
  getClient(serverId: string): EnvironmentClient | Promise<EnvironmentClient>;
  approveHost(serverId: string): Promise<boolean>;
  saved?: TaskEnvironmentState;
  save(state: TaskEnvironmentState): void;
}

export function openTaskEnvironment(options: TaskEnvironmentOptions) {
  let state: TaskEnvironmentState = options.saved ?? {
    serverId: options.owner.serverId,
    directory: options.directory,
    workspaceId: options.owner.workspaceId,
    status: "ready",
    error: null,
  };
  let revision = 0;
  const approvedEnvironments = new Set([options.owner.serverId, state.serverId]);
  const listeners = new Set<() => void>();
  function publish(next: TaskEnvironmentState) {
    state = next;
    options.save(next);
    for (const listener of listeners) listener();
  }
  async function select(serverId: string) {
    const previousRevision = revision;
    if (!approvedEnvironments.has(serverId) && !(await options.approveHost(serverId))) return;
    if (previousRevision !== revision) return;
    const request = ++revision;
    approvedEnvironments.add(serverId);
    publish({
      serverId,
      directory: "",
      workspaceId: null,
      status: "resolving",
      error: null,
    });
    try {
      const destination = await options.getClient(serverId);
      if (request !== revision) return;
      if (serverId === options.owner.serverId) {
        publish({
          ...state,
          directory: options.directory,
          workspaceId: options.owner.workspaceId,
          status: "ready",
        });
        return;
      }
      if (!destination.supportsBindings)
        throw new Error("Update this environment to create tasks in a shared workspace.");
      const workspaces = await readDestinationWorkspaces(destination.client);
      const binding = workspaces.find((workspace) => {
        const owner = workspace.projectMembership?.environmentOwner;
        return owner && sameWorkspaceReference(owner, options.owner);
      });
      const directory =
        binding?.workspaceDirectory ??
        (await resolveTaskDirectory({
          source: (await options.getClient(options.owner.serverId)).client,
          destination: destination.client,
          directory: options.directory,
        }));
      if (request !== revision) return;
      publish({
        ...state,
        directory: directory ?? "",
        workspaceId: binding?.id ?? null,
        status: directory ? "ready" : "folder",
      });
    } catch (error) {
      if (request !== revision) return;
      publish({
        ...state,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select,
    chooseDirectory(directory: string) {
      revision++;
      publish({ ...state, directory, workspaceId: null, status: "ready", error: null });
    },
    async prepare(): Promise<WorkspaceEnvironmentReference> {
      if (state.status !== "ready" || !state.directory)
        throw new Error(
          "Choose this workspace's folder in the selected environment before starting.",
        );
      const destination = await options.getClient(state.serverId);
      if (state.serverId !== options.owner.serverId && !destination.supportsBindings)
        throw new Error("Update this environment to create tasks in a shared workspace.");
      if (state.workspaceId) return { serverId: state.serverId, workspaceId: state.workspaceId };
      const workspace = await createDestinationWorkspace({
        client: destination.client,
        project: { ...options.project, environmentOwner: options.owner },
        directory: state.directory,
        title: options.name,
        idempotencyKey: `environment:${options.owner.serverId}:${options.owner.workspaceId}:${state.serverId}:${state.directory}`,
      });
      publish({ ...state, workspaceId: workspace.id });
      return { serverId: state.serverId, workspaceId: workspace.id };
    },
    close() {
      revision++;
      listeners.clear();
    },
  };
}
export type TaskEnvironmentModel = ReturnType<typeof openTaskEnvironment>;
