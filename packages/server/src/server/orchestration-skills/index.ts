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
  const library = new SkillLibrary(path.join(resolvePaseoHome(), "skill-library"));
  return {
    library: {
      read: (request) => controller.runExclusive(() => library.read(request)),
      change: (request) => controller.runExclusive(() => library.change(request)),
    },
    getStatus: () => controller.status(),
    reconcile: () => controller.update(),
    uninstall: () => controller.uninstall(),
    saveSelection: (selection, confirmedRemovals = []) =>
      controller.save({ ...selection, confirmedRemovals }),
    importLegacySelectionIfUnset: (selection) => controller.importLegacySelectionIfUnset(selection),
    autoUpdate: () => controller.autoUpdate(),
  };
}

export type { SkillsSaveResult, SkillsSnapshot } from "./internal/controller.js";
