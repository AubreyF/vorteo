import { isDeepStrictEqual } from "node:util";
import {
  factorySetup,
  FactorySetupSchema,
  type FactorySetup,
} from "@getpaseo/server/factory-operations";
import type { FileBackedProjectRegistry } from "../workspace-registry.js";

interface SetupDependencies {
  serverId: string;
  projects: Pick<FileBackedProjectRegistry, "get" | "getLoadedRecord">;
  now?(): string;
}

/** Read-only native setup observation. No installer is advertised by this service. */
export class NativeFactorySetupService {
  constructor(private readonly deps: SetupDependencies) {}

  async read(input: unknown): Promise<FactorySetup> {
    const { projectId } = factorySetup.input.parse(input);
    const { projects, serverId } = this.deps;
    const observed = await projects.get(projectId);
    const project = structuredClone(observed);
    const checkpoint = project?.factoryInstallation;
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
