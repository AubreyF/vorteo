import { isDeepStrictEqual } from "node:util";
import {
  factorySetup,
  FactorySetupSchema,
  FactoryInstallInputSchema,
  FactoryInstallResultSchema,
  type FactoryInstallResult,
  type FactorySetup,
} from "@getpaseo/server/factory-operations";
import type { FileBackedProjectRegistry } from "../workspace-registry.js";
import {
  FactoryInstallStartupChangedError,
  isNativeFactoryStartupAdapter,
  type NativeFactoryInstaller,
} from "./native-install-startup.js";
import {
  nativeFactoryInstallAdapterOrigin,
  holdNativeFactoryInstallAdapter,
} from "./native-install-adapter.js";

interface SetupDependencies {
  serverId: string;
  projects: Pick<FileBackedProjectRegistry, "get" | "getLoadedRecord">;
  installer?: () => NativeFactoryInstaller | null;
  now?(): string;
}

/** Read-only setup. Only a currently dispatchable, native-branded owner can advertise installation. */
export class NativeFactorySetupService {
  constructor(private readonly deps: SetupDependencies) {}

  async install(value: unknown): Promise<FactoryInstallResult> {
    const request = FactoryInstallInputSchema.parse(value);
    const { serverId } = this.deps;
    const identity = {
      schemaVersion: 1 as const,
      serverId,
      projectId: request.projectId,
      operationId: request.operationId,
    };
    if (request.expectedServerId !== serverId)
      return {
        ...identity,
        outcome: "refused",
        code: "identity_mismatch",
        reason: "Factory installation belongs to another serving daemon.",
      };
    const resolveInstaller = this.deps.installer;
    const installer = resolveInstaller?.();
    const origin = installer && nativeFactoryInstallAdapterOrigin(installer.adapter);
    if (
      !installer ||
      !isNativeFactoryStartupAdapter(installer.adapter) ||
      installer.projectId !== request.projectId ||
      !origin ||
      origin.serverId !== serverId ||
      origin.projectId !== request.projectId ||
      origin.runtime.factoryInstallation !== installer.adapter
    )
      return {
        ...identity,
        outcome: "refused",
        code: "unavailable",
        reason: "A dispatchable native Factory installer is unavailable for this project.",
      };
    try {
      const result = FactoryInstallResultSchema.parse(await installer.adapter.install(request));
      if (
        result.serverId !== serverId ||
        result.projectId !== request.projectId ||
        result.operationId !== request.operationId ||
        this.deps.serverId !== serverId ||
        this.deps.installer !== resolveInstaller ||
        resolveInstaller?.() !== installer ||
        !nativeFactoryInstallAdapterOrigin(installer.adapter)
      )
        throw new FactoryInstallStartupChangedError();
      return result;
    } catch {
      holdNativeFactoryInstallAdapter(installer.adapter);
      return {
        ...identity,
        outcome: "uncertain",
        installationId: null,
        reason:
          "Factory installation dispatch changed or lost its response; native reconciliation is required.",
        reconciliationRequired: true,
      };
    }
  }

  private async readInstaller(
    projectId: string,
    project: Awaited<ReturnType<SetupDependencies["projects"]["get"]>>,
    installer: NativeFactoryInstaller,
    resolveInstaller: SetupDependencies["installer"],
  ): Promise<FactorySetup> {
    const { projects, serverId } = this.deps;
    const origin = nativeFactoryInstallAdapterOrigin(installer.adapter);
    if (
      !origin ||
      !isNativeFactoryStartupAdapter(installer.adapter) ||
      origin.serverId !== serverId ||
      origin.projectId !== projectId ||
      origin.runtime.factoryInstallation !== installer.adapter
    )
      throw new FactoryInstallStartupChangedError();
    const setup = FactorySetupSchema.parse(await installer.adapter.readSetup(projectId));
    if (
      setup.serverId !== serverId ||
      setup.projectId !== projectId ||
      this.deps.projects !== projects ||
      this.deps.serverId !== serverId ||
      this.deps.installer !== resolveInstaller ||
      resolveInstaller?.() !== installer ||
      !nativeFactoryInstallAdapterOrigin(installer.adapter) ||
      !isDeepStrictEqual(projects.getLoadedRecord(projectId), project)
    )
      throw new FactoryInstallStartupChangedError();
    return setup;
  }

  async read(input: unknown): Promise<FactorySetup> {
    const { projectId } = factorySetup.input.parse(input);
    const { projects, serverId } = this.deps;
    const resolveInstaller = this.deps.installer;
    const observed = await projects.get(projectId);
    const project = structuredClone(observed);
    const checkpoint = project?.factoryInstallation;
    const installer = resolveInstaller?.();
    if (project && !project.archivedAt && installer?.projectId === projectId) {
      return this.readInstaller(projectId, project, installer, resolveInstaller);
    }
    let state: FactorySetup["state"] = "unavailable";
    let installationId: string | null = null;
    let reason = "The selected native project is unavailable on this daemon.";
    if (project && !project.archivedAt) {
      reason = "A reconciled startup-owned Factory installer is unavailable.";
      if (checkpoint) {
        state = "held";
        const matches = checkpoint.serverId === serverId && checkpoint.projectId === projectId;
        if (matches) {
          installationId = checkpoint.installationId;
          reason =
            "Retained Factory installation requires native owner and attachment reconciliation.";
        } else
          reason = "Retained Factory installation identity does not match this daemon and project.";
      }
    }
    if (project?.archivedAt && checkpoint) {
      state = "held";
      reason =
        "The archived native project retains a Factory installation requiring reconciliation.";
    }
    if (
      this.deps.projects !== projects ||
      this.deps.serverId !== serverId ||
      this.deps.installer !== resolveInstaller ||
      !isDeepStrictEqual(projects.getLoadedRecord(projectId), project)
    )
      throw new Error("Native Factory project changed during setup observation.");
    const observedAt = this.deps.now ? this.deps.now() : new Date().toISOString();
    return FactorySetupSchema.parse({
      schemaVersion: 1,
      serverId,
      projectId,
      installationId,
      revision: null,
      observedAt,
      state,
      reason,
      operations: { install: false, pause: false, resume: false, stop: false, disable: false },
    });
  }
}
