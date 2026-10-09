import { isDeepStrictEqual } from "node:util";
import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import { captureFactoryCoordinatorAuthority } from "./coordinator-authority.js";
import type { FactoryObservationBinding } from "./observation-service.js";
import type {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import type { ControllerOwnership } from "./ownership.js";
import { FactoryMembershipService } from "../workspace-lifecycle/factory-membership-service.js";

type Role = "factory" | "builds";
type AuthorityInput = Parameters<typeof captureFactoryCoordinatorAuthority>[0];

interface BindingInput {
  owner: Pick<ControllerOwnership, "identity" | "assertCurrent">;
  binding: FactoryObservationBinding;
  operationId: string;
  provider: string;
  profileId: string;
}

interface BinderDependencies {
  serverId: string;
  projects: FileBackedProjectRegistry;
  workspaces: FileBackedWorkspaceRegistry;
  agents: AuthorityInput["agents"];
  readProfiles(): AgentProfile[];
}

export class FactoryCoordinatorBindingError extends Error {
  constructor(
    readonly operationId: string,
    readonly completedRoles: readonly Role[],
    readonly uncertainRole: Role,
    cause: unknown,
  ) {
    super("Factory coordinator binding requires reconciliation before retry.", { cause });
    this.name = "FactoryCoordinatorBindingError";
  }
}

/** Startup-only operation. Calling it requires separately reviewed owner adoption. */
export function createFactoryCoordinatorBinder(deps: BinderDependencies) {
  return async function bindCoordinators(input: BindingInput) {
    const captured = { ...input };
    const binding = structuredClone(input.binding);
    const { operationId, provider, profileId } = captured;
    if (binding.serverId !== deps.serverId)
      throw new Error("Factory coordinator binding belongs to another daemon.");
    const readProfiles = deps.readProfiles;
    const configured = readProfiles().filter((profile) => profile.id === profileId);
    if (configured.length !== 1)
      throw new Error("Factory coordinator profile is unavailable or ambiguous.");
    const profile = structuredClone(configured[0]);
    const originalOwner = captured.owner;
    const assertOwner = originalOwner.assertCurrent;
    const owner = {
      identity: originalOwner.identity,
      assertCurrent() {
        assertOwner.call(originalOwner);
        const current = readProfiles().filter((entry) => entry.id === profile.id);
        if (
          (Object.keys(captured) as Array<keyof BindingInput>).some(
            (key) => input[key] !== captured[key],
          ) ||
          !isDeepStrictEqual(input.binding, binding) ||
          originalOwner.assertCurrent !== assertOwner ||
          deps.readProfiles !== readProfiles ||
          current.length !== 1 ||
          !isDeepStrictEqual(current[0], profile)
        )
          throw new Error("Factory configured profile or retained owner changed.");
      },
    };
    const grant = await captureFactoryCoordinatorAuthority({
      owner,
      binding,
      operationId,
      provider,
      profile,
      projects: deps.projects,
      workspaces: deps.workspaces,
      agents: deps.agents,
    });
    const service = new FactoryMembershipService({
      serverId: deps.serverId,
      projects: deps.projects,
      workspaces: deps.workspaces,
      authority: grant.authority,
    });
    const completed: Role[] = [];
    for (const role of ["factory", "builds"] as const) {
      try {
        await service.bind({
          operationId,
          workspaceId: binding.coordinators[role].workspaceId,
          installationId: binding.installationId,
          expectedRevision: grant.revision,
          role,
        });
        completed.push(role);
      } catch (error) {
        // Persistence failures may happen after the write. Never undo protection
        // or automatically retry the other member under a changed authority.
        throw new FactoryCoordinatorBindingError(operationId, [...completed], role, error);
      }
    }
    return { revision: grant.revision, coordinators: structuredClone(binding.coordinators) };
  };
}
