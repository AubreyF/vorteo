import { isDeepStrictEqual } from "node:util";
import { WorkspaceFactoryMembershipSchema } from "@getpaseo/protocol/messages";
import type {
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";

type Membership = NonNullable<PersistedWorkspaceRecord["factoryMembership"]>;
type MembershipAction = "bind" | "cleanup" | "disable";

/** Supplied by the daemon's reconciled installation owner, never a client request. */
export interface FactoryMembershipAuthority {
  authorize(input: {
    action: MembershipAction;
    operationId: string;
    workspace: PersistedWorkspaceRecord;
    role: Membership["role"];
  }): Promise<{
    workspaceId: string;
    operationId: string;
    membership: Membership;
    revision: string;
    /** Rechecks captured owner generation and reconciliation before persistence. */
    assertCurrent(): void;
  }>;
}

interface MemberOperation {
  operationId: string;
  workspaceId: string;
  installationId: string;
  expectedRevision: string;
}

export class FactoryMembershipPersistedError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly operationId: string,
    cause: unknown,
  ) {
    super("Factory relationship persisted but authority changed; reconcile before retry.", {
      cause,
    });
    this.name = "FactoryMembershipPersistedError";
  }
}

/**
 * Internal lifecycle seam. There is deliberately no ordinary wire setter.
 * The authority adapter must verify native custody and retained evidence before
 * authorizing cleanup or owner disable. This service does not settle executions.
 */
export class FactoryMembershipService {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      serverId: string;
      projects: ProjectRegistry;
      workspaces: WorkspaceRegistry;
      authority: FactoryMembershipAuthority;
    },
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  bind(input: MemberOperation & { role: Membership["role"] }): Promise<PersistedWorkspaceRecord> {
    return this.serialize(async () => {
      const workspace = await this.readWorkspace(input.workspaceId);
      if (workspace.archivedAt)
        throw new Error("Restore the exact workspace before Factory binding.");
      const project = await this.deps.projects.get(workspace.projectId);
      if (!project || project.archivedAt) throw new Error("Factory project is unavailable.");
      const lease = await this.authorize(input, workspace, "bind", input.role);
      const registry = this.deps.workspaces;
      if (!registry.bindFactoryMember)
        throw new Error("Native registry does not support atomic Factory role reservation.");
      const updated = await registry.bindFactoryMember({
        expected: workspace,
        membership: lease.membership,
        assertCurrent: lease.assertCurrent,
      });
      if (!updated) throw new Error("Workspace disappeared before Factory binding.");
      try {
        lease.assertCurrent();
      } catch (error) {
        throw new FactoryMembershipPersistedError(input.workspaceId, input.operationId, error);
      }
      return updated;
    });
  }

  retire(
    input: MemberOperation & { action: "cleanup" | "disable" },
  ): Promise<PersistedWorkspaceRecord> {
    return this.serialize(async () => {
      const workspace = await this.readWorkspace(input.workspaceId);
      const membership = workspace.factoryMembership;
      if (!membership) throw new Error("Workspace has no retained Factory relationship.");
      if (input.action === "cleanup" && membership.role !== "worker")
        throw new Error("Persistent Factory coordinators require reconciled owner disable.");
      const lease = await this.authorize(input, workspace, input.action, membership.role);
      if (!isDeepStrictEqual(membership, lease.membership))
        throw new Error("Retirement authority does not match retained Factory membership.");
      const updated = await this.deps.workspaces.update(workspace.workspaceId, (current) => {
        lease.assertCurrent();
        if (!isDeepStrictEqual(current, workspace))
          throw new Error("Workspace changed before Factory retirement.");
        const { factoryMembership: retired, ...retained } = current;
        if (!retired) throw new Error("Factory relationship was removed before retirement.");
        return { ...retained, updatedAt: new Date().toISOString() };
      });
      if (!updated) throw new Error("Workspace disappeared before Factory retirement.");
      return updated;
    });
  }

  private async readWorkspace(workspaceId: string): Promise<PersistedWorkspaceRecord> {
    const workspace = await this.deps.workspaces.get(workspaceId);
    if (!workspace) throw new Error("Factory workspace is unavailable.");
    return structuredClone(workspace);
  }

  private async authorize(
    input: MemberOperation,
    workspace: PersistedWorkspaceRecord,
    action: MembershipAction,
    role: Membership["role"],
  ) {
    const lease = await this.deps.authority.authorize({
      action,
      operationId: input.operationId,
      workspace: structuredClone(workspace),
      role,
    });
    const membership = WorkspaceFactoryMembershipSchema.parse(lease.membership);
    if (
      !input.expectedRevision ||
      !input.operationId ||
      lease.operationId !== input.operationId ||
      lease.workspaceId !== input.workspaceId ||
      lease.revision !== input.expectedRevision ||
      membership.installationId !== input.installationId ||
      membership.serverId !== this.deps.serverId ||
      membership.projectId !== workspace.projectId ||
      membership.role !== role
    ) {
      throw new Error("Factory installation authority changed or does not match this member.");
    }
    lease.assertCurrent();
    return { ...lease, membership };
  }
}
