import { isDeepStrictEqual } from "node:util";
import {
  activityReceipts,
  factorySnapshot,
  type FactorySnapshot,
  type ActivityReceipts,
} from "@getpaseo/server/factory-contracts";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";

export interface FactoryObservationBinding {
  serverId: string;
  projectId: string;
  projectRoot: string;
  repository: string;
  installationId: string;
  coordinators: Record<"factory" | "builds", { workspaceId: string; agentId: string }>;
}

/** Supplied only by the existing startup-owned controller, never plugin settings. */
export interface NativeFactoryObservationProvider {
  binding: FactoryObservationBinding;
  assertCurrent(): void;
  snapshot(input: { projectId: string }): Promise<unknown>;
  /** The producer owns durable host/project/filter-bound cursors and verification. */
  receipts(input: {
    projectId: string | null;
    cursor: string | null;
    limit: number;
  }): Promise<unknown>;
}

export class NativeFactoryObservationService {
  private readonly binding: FactoryObservationBinding;

  constructor(
    private readonly provider: NativeFactoryObservationProvider,
    private readonly deps: {
      serverId: string;
      projects: Pick<ProjectRegistry, "get">;
      workspaces: Pick<WorkspaceRegistry, "get">;
      agents: Pick<AgentStorage, "get">;
    },
  ) {
    this.binding = structuredClone(provider.binding);
    const binding = this.binding;
    const identities = [
      binding.serverId,
      binding.projectId,
      binding.projectRoot,
      binding.installationId,
    ];
    if (
      identities.some((value) => typeof value !== "string" || !value.trim()) ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(binding.repository) ||
      binding.serverId !== deps.serverId
    )
      throw new Error("Factory observation binding is invalid.");
    const { factory, builds } = binding.coordinators;
    if (
      !factory.workspaceId ||
      !factory.agentId ||
      !builds.workspaceId ||
      !builds.agentId ||
      factory.workspaceId === builds.workspaceId ||
      factory.agentId === builds.agentId
    )
      throw new Error("Factory requires two exact distinct retained coordinators.");
  }

  static supports(method: string): method is "factory.snapshot" | "activity.receipts" {
    return method === "factory.snapshot" || method === "activity.receipts";
  }

  async invoke(method: "factory.snapshot" | "activity.receipts", input: unknown): Promise<unknown> {
    if (method === "factory.snapshot") return this.snapshot(input);
    return this.receipts(input);
  }

  private assertCurrent(): void {
    this.provider.assertCurrent();
    if (!isDeepStrictEqual(this.provider.binding, this.binding))
      throw new Error("Factory observation owner binding changed.");
  }

  private async readNativeBinding() {
    this.assertCurrent();
    const binding = this.binding;
    const project = await this.deps.projects.get(binding.projectId);
    if (
      !project ||
      project.projectId !== binding.projectId ||
      project.archivedAt ||
      project.kind !== "git" ||
      project.rootPath !== binding.projectRoot ||
      project.projectKey !== `remote:github.com/${binding.repository.toLowerCase()}`
    )
      throw new Error("Factory native project binding is unavailable.");
    const coordinators = await Promise.all(
      (["factory", "builds"] as const).map(async (role) => {
        const identity = binding.coordinators[role];
        const workspace = await this.deps.workspaces.get(identity.workspaceId);
        const agent = await this.deps.agents.get(identity.agentId);
        const expected = {
          installationId: binding.installationId,
          projectId: binding.projectId,
          serverId: binding.serverId,
          role,
        };
        if (
          !workspace ||
          workspace.workspaceId !== identity.workspaceId ||
          workspace.projectId !== binding.projectId ||
          !isDeepStrictEqual(workspace.factoryMembership, expected) ||
          !agent ||
          agent.id !== identity.agentId ||
          agent.workspaceId !== identity.workspaceId
        )
          throw new Error("Factory native coordinator identity is unavailable.");
        return {
          role,
          workspaceId: workspace.workspaceId,
          agentId: agent.id,
          archived: Boolean(workspace.archivedAt || agent.archivedAt),
        };
      }),
    );
    this.assertCurrent();
    return {
      projectId: project.projectId,
      root: project.rootPath,
      key: project.projectKey,
      coordinators,
    };
  }

  private assertProject(projectId: string | null): void {
    if (projectId !== null && projectId !== this.binding.projectId)
      throw new Error("Factory observation belongs to another project.");
  }

  private async snapshot(input: unknown): Promise<FactorySnapshot> {
    const request = factorySnapshot.input.parse(input);
    this.assertProject(request.projectId);
    const before = await this.readNativeBinding();
    const snapshot = factorySnapshot.output.parse(await this.provider.snapshot(request));
    if (
      snapshot.serverId !== this.binding.serverId ||
      snapshot.projectId !== request.projectId ||
      snapshot.installationId !== this.binding.installationId
    )
      throw new Error("Factory snapshot identity differs from its native owner.");
    if (Object.values(snapshot.capabilities).some(Boolean))
      throw new Error("Factory mutation capabilities are unavailable in this read-only service.");
    if (snapshot.freshness.state === "current" && (!snapshot.revision || !snapshot.observedAt))
      throw new Error(
        "Current Factory observation requires a coherent revision and observation time.",
      );
    for (const native of before.coordinators) {
      const reported = snapshot.coordinators.find((entry) => entry.role === native.role);
      if (
        !reported ||
        reported.workspaceId !== native.workspaceId ||
        reported.agentId !== native.agentId
      )
        throw new Error("Factory snapshot coordinator identity differs.");
      if (
        native.archived &&
        (reported.status !== "recovery" || snapshot.admission.state === "open")
      )
        throw new Error("Archived Factory coordinators require a visible recovery hold.");
    }
    const workIdentities = await this.readWorkIdentities(snapshot);
    this.validateSnapshotLinks(snapshot);
    if (!isDeepStrictEqual(before, await this.readNativeBinding()))
      throw new Error("Factory native binding changed during observation.");
    if (!isDeepStrictEqual(workIdentities, await this.readWorkIdentities(snapshot)))
      throw new Error("Factory native work identity changed during observation.");
    return snapshot;
  }

  private async readWorkIdentities(snapshot: FactorySnapshot) {
    this.assertCurrent();
    const identities = await Promise.all(
      snapshot.work.map(async (work) => {
        if (work.workspaceId === null && work.agentId === null) return null;
        const agent = work.agentId === null ? null : await this.deps.agents.get(work.agentId);
        if (work.agentId !== null && (!agent || agent.id !== work.agentId || !agent.workspaceId))
          throw new Error("Factory native work agent identity is unavailable.");
        const workspaceId = work.workspaceId ?? agent?.workspaceId;
        if (!workspaceId) throw new Error("Factory native work workspace identity is unavailable.");
        if (agent !== null && agent.workspaceId !== workspaceId)
          throw new Error("Factory native work agent/workspace association differs.");
        const workspace = await this.readWorkWorkspace(workspaceId);
        return {
          ...workspace,
          agentId: agent?.id ?? null,
          agentArchivedAt: agent?.archivedAt ?? null,
        };
      }),
    );
    this.assertCurrent();
    return identities;
  }

  private async readWorkWorkspace(workspaceId: string) {
    const workspace = await this.deps.workspaces.get(workspaceId);
    const membership = workspace?.factoryMembership;
    if (
      !workspace ||
      workspace.workspaceId !== workspaceId ||
      workspace.projectId !== this.binding.projectId ||
      !membership ||
      membership.serverId !== this.binding.serverId ||
      membership.projectId !== this.binding.projectId ||
      membership.installationId !== this.binding.installationId ||
      !["factory", "builds", "worker"].includes(membership.role)
    )
      throw new Error("Factory native work workspace identity is unavailable.");
    return {
      workspaceId,
      membership: structuredClone(membership),
      workspaceArchivedAt: workspace.archivedAt ?? null,
    };
  }

  private validateSnapshotLinks(snapshot: FactorySnapshot): void {
    for (const issue of snapshot.issues) this.assertGithubLink(issue.url, `issues/${issue.number}`);
    for (const work of snapshot.work) {
      if (work.issueUrl) this.assertGithubLink(work.issueUrl, /^issues\/[1-9][0-9]*$/);
      if (work.prUrl) this.assertGithubLink(work.prUrl, /^pull\/[1-9][0-9]*$/);
    }
    if (snapshot.builds.latestRelease)
      this.assertGithubLink(snapshot.builds.latestRelease.url, /^releases\/tag\/[^/]+$/);
  }

  private async receipts(input: unknown): Promise<ActivityReceipts> {
    const request = activityReceipts.input.parse(input);
    this.assertProject(request.projectId);
    const before = await this.readNativeBinding();
    const output = activityReceipts.output.parse(await this.provider.receipts(request));
    if (
      output.producer.serverId !== this.binding.serverId ||
      output.producer.pluginId !== "factory"
    )
      throw new Error("Factory receipt producer identity differs.");
    if (output.receipts && output.receipts.length > request.limit)
      throw new Error("Factory receipt producer exceeded the requested bound.");
    for (const receipt of output.receipts ?? []) {
      if (
        receipt.projectId !== this.binding.projectId ||
        (receipt.provenance.source === "factory_controller" &&
          receipt.installationId !== this.binding.installationId)
      )
        throw new Error("Factory receipt identity or filter differs.");
      if (receipt.delivery) {
        if (receipt.delivery.repository !== this.binding.repository)
          throw new Error("Factory delivery repository differs.");
        this.assertGithubLink(
          receipt.delivery.url,
          receipt.kind === "merge" ? /^pull\/[1-9][0-9]*$/ : /^releases\/tag\/[^/]+$/,
        );
        if (receipt.url !== null && receipt.url !== receipt.delivery.url)
          throw new Error("Factory shipment link differs from its delivery identity.");
      }
    }
    if (!isDeepStrictEqual(before, await this.readNativeBinding()))
      throw new Error("Factory native binding changed during receipt observation.");
    return output;
  }

  private assertGithubLink(value: string, path: string | RegExp): void {
    const url = new URL(value);
    const prefix = `/${this.binding.repository}/`;
    const suffix = url.pathname.slice(prefix.length);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(prefix) ||
      !(typeof path === "string" ? suffix === path : path.test(suffix))
    )
      throw new Error("Factory GitHub URL does not match the bound repository and delivery.");
  }
}

/** Optional startup projection; absence retains the existing unavailable observer. */
export function createNativeFactoryObservationResolver(
  runtime: { factoryObservation?: NativeFactoryObservationProvider } | undefined,
  dependencies: ConstructorParameters<typeof NativeFactoryObservationService>[1],
): () => NativeFactoryObservationService | null {
  const provider = runtime?.factoryObservation;
  let service: NativeFactoryObservationService | null = null;
  // Observation failure must not disrupt the controller or recreate its owner.
  // Capture the startup provider once; plugin reload only resolves this same service.
  return () => {
    if (!provider) return null;
    service ??= new NativeFactoryObservationService(provider, dependencies);
    return service;
  };
}
