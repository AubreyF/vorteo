import { expect, test } from "vitest";
import {
  CoordinatorBootstrapPlanSchema,
  type CoordinatorBootstrapPlan,
} from "./coordinator-bootstrap.js";
import {
  REVIEWED_CONFIGURATION_SETTINGS,
  REVIEWED_CONFIGURATION_SETTING_NAMES,
  planConfigurationChanges,
  plansConfigurationChange,
} from "./coordinator-configuration-settings.js";

// Configuration fields with their own rules, outside the registry.
const SPECIAL_CONFIGURATION_FIELDS = ["nativeHelperConfiguration"];

test("every per-setting plan field is registered or deliberately special", () => {
  const legacy = REVIEWED_CONFIGURATION_SETTING_NAMES.map(
    (setting) => REVIEWED_CONFIGURATION_SETTINGS[setting].legacyField,
  );
  const fields = Object.keys(CoordinatorBootstrapPlanSchema.shape).filter((field) =>
    field.endsWith("Configuration"),
  );
  // A new setting belongs in the registry, not in another plan field.
  expect(fields.sort()).toEqual([...legacy, ...SPECIAL_CONFIGURATION_FIELDS].sort());
});

test("an older strict plan schema refuses a listed change instead of ignoring it", () => {
  const older = CoordinatorBootstrapPlanSchema.omit({ configurationChanges: true });
  const plan = { configurationChanges: [{ setting: "claudeHostRefresh", value: true }] };
  expect(
    older.safeParse(plan).error?.issues.some((issue) => issue.code === "unrecognized_keys"),
  ).toBe(true);
});

test("legacy fields and listed changes normalize to the same changes in registry order", () => {
  const launcher = { candidate: "/fixture/candidate.plist", sha256: "c".repeat(64) };
  const legacy = {
    hostLauncherUpdateConfiguration: launcher,
    claudeHostRefreshConfiguration: true,
  } as CoordinatorBootstrapPlan;
  const listed = {
    configurationChanges: [
      { setting: "hostLauncherUpdate", value: launcher },
      { setting: "claudeHostRefresh", value: true },
    ],
  } as CoordinatorBootstrapPlan;
  const expected = {
    ok: true,
    changes: [
      { setting: "claudeHostRefresh", value: true },
      { setting: "hostLauncherUpdate", value: launcher },
    ],
  };
  expect(planConfigurationChanges(legacy)).toEqual(expected);
  expect(planConfigurationChanges(listed)).toEqual(expected);
});

test("any registered change, valid or not, counts as a configuration change", () => {
  expect(plansConfigurationChange({} as CoordinatorBootstrapPlan)).toBe(false);
  for (const setting of REVIEWED_CONFIGURATION_SETTING_NAMES) {
    const field = REVIEWED_CONFIGURATION_SETTINGS[setting].legacyField;
    expect(plansConfigurationChange({ [field]: null } as CoordinatorBootstrapPlan)).toBe(true);
  }
  expect(
    plansConfigurationChange({
      configurationChanges: [{ setting: "unknown", value: 1 }],
    } as CoordinatorBootstrapPlan),
  ).toBe(true);
});
