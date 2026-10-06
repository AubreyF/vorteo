import { expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import type { SkillPreview } from "@getpaseo/protocol/skill-library";
import {
  readInstallationSettingsForLaunch,
  type InstallationSettingsAdmission,
} from "./admission.js";
import { assertInstallationSkillChange } from "./skill-admission.js";
import { readInstallationSettings } from "./projection.js";

test("shared skill changes require current content and provenance and preserve physical packages on removal", () => {
  const source = { repository: "example/skills", revision: "a".repeat(40), directory: "review" };
  const definition = {
    name: "review",
    identity: "github:example/skills/review",
    sha256: "b".repeat(64),
    source,
  };
  const admission: InstallationSettingsAdmission = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host",
    revision: 1,
    installationInstructions: "",
    settings: {
      ...readInstallationSettings(
        MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
      ),
      skillLibrary: [definition],
    },
  };
  const preview: SkillPreview = {
    id: "preview",
    name: "review",
    action: "install",
    source,
    target: "/local/review",
    beforeHash: null,
    afterHash: definition.sha256,
    changes: [],
    createdAt: "now",
  };
  for (const action of ["install", "restore", "link", "consolidate"] as const)
    expect(() => assertInstallationSkillChange(admission, { ...preview, action })).not.toThrow();
  expect(() =>
    assertInstallationSkillChange(admission, { ...preview, afterHash: "c".repeat(64) }),
  ).toThrow("coordinator");
  expect(() => assertInstallationSkillChange(admission, { ...preview, source: null })).toThrow(
    "coordinator",
  );
  expect(() =>
    assertInstallationSkillChange(admission, { ...preview, action: "remove", afterHash: null }),
  ).toThrow("coordinator");
  admission.settings.resourceExclusions.host = {
    terminalProfileIds: [],
    metadataProviderIds: [],
    skillIdentities: [definition.identity],
  };
  expect(() => assertInstallationSkillChange(admission, preview)).toThrow("coordinator");
  admission.settings.resourceExclusions = {};
  admission.settings.skillLibrary = [];
  expect(() => assertInstallationSkillChange(admission, preview)).toThrow("coordinator");
  delete admission.settings.skillLibrary;
  expect(() => assertInstallationSkillChange(admission, preview)).toThrow("migration");
});

test("new task settings reject another environment and incomplete skill migration", async () => {
  const binding = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const admission: InstallationSettingsAdmission = {
    ...binding,
    installationInstructions: "",
    settings: { ...readInstallationSettings(settings), skillLibrary: [] },
  };
  await expect(
    readInstallationSettingsForLaunch(settings, {
      read: async () => ({ ...admission, serverId: "other" }),
    }),
  ).rejects.toThrow("different installation or environment");
  delete admission.settings.skillLibrary;
  await expect(
    readInstallationSettingsForLaunch(settings, { read: async () => admission }),
  ).rejects.toThrow("migration");
  admission.settings.skillLibrary = [];
  await expect(
    readInstallationSettingsForLaunch(settings, { read: async () => admission }),
  ).resolves.toEqual(admission);
});
