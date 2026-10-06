import { assertInstallationSkillChange } from "../execution-installation/settings/skill-admission.js";
import { InstallationSettingsAdmissionError } from "../execution-installation/settings/admission.js";
import { SkillLibrary } from "./internal/library.js";
import { resolvePaseoHome } from "../paseo-home.js";
import path from "node:path";
import type { AgentSkillSelection } from "@getpaseo/protocol/messages";

import type { DaemonConfigStore } from "../daemon-config-store.js";
import {
  createSkillsController,
  type SkillsController,
  type SkillsSaveResult,
  type SkillsSnapshot,
} from "./internal/controller.js";
import { resolveSkillTargets } from "./internal/paths.js";
import { createSkillSelectionStore } from "./internal/selection-store.js";

export interface OrchestrationSkills {
  library: Pick<SkillLibrary, "read" | "change">;
  getStatus(): Promise<SkillsSnapshot>;
  previewSelection(selection: AgentSkillSelection): Promise<SkillsSaveResult>;
  reconcile(): Promise<SkillsSnapshot>;
  uninstall(): Promise<SkillsSnapshot>;
  saveSelection(
    selection: AgentSkillSelection,
    confirmedRemovals?: readonly string[],
  ): Promise<SkillsSaveResult>;
  importLegacySelectionIfUnset(selection: AgentSkillSelection): Promise<{
    imported: boolean;
    selection: AgentSkillSelection;
  }>;
  autoUpdate(): Promise<SkillsSnapshot>;
}

export function createOrchestrationSkills(
  configStore: DaemonConfigStore,
  resolveTargets = resolveSkillTargets,
): OrchestrationSkills {
  const controller: SkillsController = createSkillsController({
    resolveTargets,
    selectionStore: createSkillSelectionStore(configStore),
  });
  const library = new SkillLibrary(
    path.join(resolvePaseoHome(), "skill-library"),
    undefined,
    undefined,
    async (preview) => {
      const admission = await configStore.readInstallationSettingsAuthority();
      if (admission) assertInstallationSkillChange(admission, preview);
      else if (process.env.VORTEO_INSTALLATION_CLIENT_CONFIG)
        throw new InstallationSettingsAdmissionError(
          "Complete installation migration before changing personal skills.",
        );
    },
  );
  return {
    library: {
      read: (request) => controller.runExclusive(() => library.read(request)),
      change: (request) => controller.runExclusive(() => library.change(request)),
    },
    getStatus: () => controller.status(),
    previewSelection: (selection) => controller.preview(selection),
    reconcile: () => controller.update(),
    uninstall: () => controller.uninstall(),
    saveSelection: (selection, confirmedRemovals = []) =>
      controller.save({ ...selection, confirmedRemovals }),
    importLegacySelectionIfUnset: (selection) => controller.importLegacySelectionIfUnset(selection),
    autoUpdate: () => controller.autoUpdate(),
  };
}

export type { SkillsSaveResult, SkillsSnapshot } from "./internal/controller.js";
