import { isDeepStrictEqual } from "node:util";
import type { SkillPreview } from "@getpaseo/protocol/skill-library";
import {
  InstallationSettingsAdmissionError,
  type InstallationSettingsAdmission,
} from "./admission.js";

export function assertInstallationSkillChange(
  admission: InstallationSettingsAdmission,
  preview: SkillPreview,
): void {
  const catalog = admission.settings.skillLibrary;
  if (!catalog)
    throw new InstallationSettingsAdmissionError(
      "Complete shared personal skill migration before changing packages.",
    );
  const definition = catalog.find((skill) => skill.name === preview.name);
  const excluded =
    definition !== undefined &&
    admission.settings.resourceExclusions[admission.serverId]?.skillIdentities?.includes(
      definition.identity,
    ) === true;
  const permitted =
    !excluded &&
    preview.action !== "remove" &&
    definition !== undefined &&
    definition.sha256 === preview.afterHash &&
    isDeepStrictEqual(definition.source, preview.source);
  if (!permitted)
    throw new InstallationSettingsAdmissionError(
      "Shared personal skills must be edited through the installation coordinator. Reload the current definition before retrying.",
    );
}
