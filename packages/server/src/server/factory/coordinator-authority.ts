import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AgentProfileSchema, type AgentProfile } from "@getpaseo/protocol/agent-profile";
import type { AgentStorage } from "../agent/agent-storage.js";
import type {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  PersistedWorkspaceRecord,
} from "../workspace-registry.js";
import type { FactoryMembershipAuthority } from "../workspace-lifecycle/factory-membership-service.js";
import type { FactoryObservationBinding } from "./observation-service.js";
import type { ControllerOwnership } from "./ownership.js";

interface CoordinatorAuthorityInput {
  owner: Pick<ControllerOwnership, "identity" | "assertCurrent">;
  binding: FactoryObservationBinding;
  operationId: string;
  provider: string;
  profile: AgentProfile;
  projects: Pick<FileBackedProjectRegistry, "get" | "getLoadedRecord">;
  workspaces: Pick<FileBackedWorkspaceRegistry, "get" | "getLoadedRecord">;
  agents: Pick<AgentStorage, "get" | "getLoadedRecord">;
}

interface CoordinatorMembershipAuthority {
  authority: FactoryMembershipAuthority;
  revision: string;
}

function workspaceIdentity(record: PersistedWorkspaceRecord) {
  const { factoryMembership, updatedAt, ...identity } = record;
  return { factoryMembership, updatedAt, identity };
}

/**
 * Native startup authority for protecting an owner-selected retained pair.
 * This grants no execution permit and cannot retire custody or disable an owner.
 * No worker, configured plugin or RPC may supply the owner or launch profile.
 */
export async function captureFactoryCoordinatorAuthority(
  input: CoordinatorAuthorityInput,
): Promise<CoordinatorMembershipAuthority> {
  const captured = { ...input };
  const readers = {
    assertOwner: input.owner.assertCurrent,
    project: input.projects.getLoadedRecord,
    workspace: input.workspaces.getLoadedRecord,
    agent: input.agents.getLoadedRecord,
  };
  const binding = structuredClone(input.binding);
  const owner = structuredClone(input.owner.identity);
  const profile = AgentProfileSchema.parse(structuredClone(input.profile));
  const identities = Object.values(binding.coordinators);
  if (
    !input.operationId ||
    !input.provider ||
    !profile.id ||
    owner.installationId !== binding.installationId ||
    identities.some((identity) => !identity.workspaceId || !identity.agentId) ||
    identities[0].workspaceId === identities[1].workspaceId ||
    identities[0].agentId === identities[1].agentId
  )
    throw new Error("Factory coordinator authority requires exact native installation identities.");

  function assertSource(): void {
    readers.assertOwner.call(captured.owner);
    const replaced = (Object.keys(captured) as Array<keyof CoordinatorAuthorityInput>).some(
      (key) => input[key] !== captured[key],
    );
    if (
      replaced ||
      captured.owner.assertCurrent !== readers.assertOwner ||
      captured.projects.getLoadedRecord !== readers.project ||
      captured.workspaces.getLoadedRecord !== readers.workspace ||
      captured.agents.getLoadedRecord !== readers.agent ||
      !isDeepStrictEqual(input.owner.identity, owner) ||
      !isDeepStrictEqual(input.binding, binding) ||
      !isDeepStrictEqual(input.profile, profile)
    )
      throw new Error("Factory coordinator owner, binding or configured launch changed.");
  }

  assertSource();
  const project = structuredClone(await captured.projects.get(binding.projectId));
  const members = await Promise.all(
    (["factory", "builds"] as const).map(async (role) => {
      const identity = binding.coordinators[role];
      const workspace = structuredClone(await captured.workspaces.get(identity.workspaceId));
      const agent = structuredClone(await captured.agents.get(identity.agentId));
      const membership = {
        installationId: binding.installationId,
        serverId: binding.serverId,
        projectId: binding.projectId,
        role,
      };
      if (
        !workspace ||
        workspace.workspaceId !== identity.workspaceId ||
        workspace.projectId !== binding.projectId ||
        workspace.archivedAt ||
        (workspace.factoryMembership &&
          !isDeepStrictEqual(workspace.factoryMembership, membership)) ||
        !agent ||
        agent.id !== identity.agentId ||
        agent.workspaceId !== identity.workspaceId ||
        agent.cwd !== workspace.cwd ||
        agent.archivedAt ||
        agent.provider !== captured.provider ||
        !isDeepStrictEqual(agent.config?.profileLaunch?.profile, profile)
      )
        throw new Error(
          "Factory coordinator differs from the configured native account or profile.",
        );
      return { role, workspace, agent, membership };
    }),
  );
  if (
    !project ||
    project.projectId !== binding.projectId ||
    project.archivedAt ||
    project.kind !== "git" ||
    project.rootPath !== binding.projectRoot ||
    project.projectKey !== `remote:github.com/${binding.repository.toLowerCase()}`
  )
    throw new Error("Factory coordinator native repository binding differs.");

  function assertCurrent(): void {
    assertSource();
    if (!isDeepStrictEqual(captured.projects.getLoadedRecord(binding.projectId), project))
      throw new Error("Factory coordinator native project changed.");
    for (const member of members) {
      const current = captured.workspaces.getLoadedRecord(member.workspace.workspaceId);
      const agent = captured.agents.getLoadedRecord(member.agent.id);
      if (!current || !isDeepStrictEqual(agent, member.agent))
        throw new Error("Factory coordinator native identity changed.");
      const before = workspaceIdentity(member.workspace);
      const after = workspaceIdentity(current);
      const unchanged = isDeepStrictEqual(current, member.workspace);
      const bound =
        isDeepStrictEqual(after.factoryMembership, member.membership) &&
        isDeepStrictEqual(after.identity, before.identity);
      // The only permitted transition is this exact retained relationship.
      if (!unchanged && !bound) throw new Error("Factory coordinator native workspace changed.");
    }
  }

  assertCurrent();
  // A local precondition digest, not a global journal ordering or shipment proof.
  const revision = createHash("sha256")
    .update(JSON.stringify({ owner, binding, project, members, operationId: captured.operationId }))
    .digest("hex");
  const authority: FactoryMembershipAuthority = {
    async authorize(request) {
      assertCurrent();
      const member = members.find((entry) => entry.role === request.role);
      if (
        request.action !== "bind" ||
        request.operationId !== captured.operationId ||
        !member ||
        request.workspace.workspaceId !== member.workspace.workspaceId ||
        !isDeepStrictEqual(
          request.workspace,
          captured.workspaces.getLoadedRecord(member.workspace.workspaceId),
        )
      )
        throw new Error("Factory coordinator authority cannot authorize this operation.");
      return {
        workspaceId: member.workspace.workspaceId,
        operationId: captured.operationId,
        membership: structuredClone(member.membership),
        revision,
        assertCurrent,
      };
    },
  };
  return { authority, revision };
}
