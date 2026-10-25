import { expect, test } from "vitest";
import { z } from "zod";
import {
  CoordinatorBootstrapPlanSchema,
  type CoordinatorBootstrapPlan,
} from "./coordinator-bootstrap.js";
import {
  REVIEWED_CONFIGURATION_SETTINGS,
  REVIEWED_CONFIGURATION_SETTING_NAMES,
  planConfigurationChanges,
  plansConfigurationChange,
  type ReviewedConfigurationSettingDefinition,
} from "./coordinator-configuration-settings.js";

// Configuration fields with their own rules, outside the registry.
const SPECIAL_CONFIGURATION_FIELDS = ["nativeHelperConfiguration"];

test("every per-setting plan field is registered or deliberately special", () => {
  const legacy = REVIEWED_CONFIGURATION_SETTING_NAMES.flatMap((setting) => {
    const definition: ReviewedConfigurationSettingDefinition =
      REVIEWED_CONFIGURATION_SETTINGS[setting];
    return definition.legacyField === undefined ? [] : [definition.legacyField];
  });
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
    const definition: ReviewedConfigurationSettingDefinition =
      REVIEWED_CONFIGURATION_SETTINGS[setting];
    if (definition.legacyField === undefined) continue;
    expect(
      plansConfigurationChange({
        [definition.legacyField]: null,
      } as unknown as CoordinatorBootstrapPlan),
    ).toBe(true);
  }
  expect(
    plansConfigurationChange({
      configurationChanges: [{ setting: "unknown", value: 1 }],
    } as CoordinatorBootstrapPlan),
  ).toBe(true);
});

// A registry with one setting that has a legacy plan field and one added after the
// registry, which changes only through `configurationChanges`.
const MIXED_REGISTRY = {
  claudeHostRefresh: REVIEWED_CONFIGURATION_SETTINGS.claudeHostRefresh,
  registryOnly: { path: ["registryOnly"], value: z.literal(true), renewal: true },
} as const satisfies Record<string, ReviewedConfigurationSettingDefinition>;

test("a registry-only setting changes through configurationChanges alongside legacy fields", () => {
  const plan = {
    claudeHostRefreshConfiguration: true,
    configurationChanges: [{ setting: "registryOnly", value: true }],
  } as CoordinatorBootstrapPlan;
  expect(planConfigurationChanges(plan, MIXED_REGISTRY)).toEqual({
    ok: true,
    changes: [
      { setting: "claudeHostRefresh", value: true },
      { setting: "registryOnly", value: true },
    ],
  });
  const removal = {
    configurationChanges: [{ setting: "registryOnly", value: null }],
  } as CoordinatorBootstrapPlan;
  expect(planConfigurationChanges(removal, MIXED_REGISTRY)).toEqual({
    ok: true,
    changes: [{ setting: "registryOnly", value: null }],
  });
});

test("a registry-only setting refuses invalid values, duplicates and unregistered names", () => {
  const listed = (...entries: Array<{ setting: string; value: unknown }>) =>
    planConfigurationChanges(
      { configurationChanges: entries } as CoordinatorBootstrapPlan,
      MIXED_REGISTRY,
    );
  expect(listed({ setting: "registryOnly", value: false })).toEqual({
    ok: false,
    reason: "Invalid value for configuration setting: registryOnly",
  });
  expect(
    listed({ setting: "registryOnly", value: true }, { setting: "registryOnly", value: true }),
  ).toEqual({ ok: false, reason: "Configuration setting named twice: registryOnly" });
  // The default registry does not know a setting that only a test registry defines.
  expect(
    planConfigurationChanges({
      configurationChanges: [{ setting: "registryOnly", value: true }],
    } as CoordinatorBootstrapPlan),
  ).toEqual({ ok: false, reason: "Unknown configuration setting: registryOnly" });
});

test("a registry-only setting counts as a change only when the plan lists it", () => {
  expect(plansConfigurationChange({} as CoordinatorBootstrapPlan, MIXED_REGISTRY)).toBe(false);
  expect(
    plansConfigurationChange(
      {
        configurationChanges: [{ setting: "registryOnly", value: true }],
      } as CoordinatorBootstrapPlan,
      MIXED_REGISTRY,
    ),
  ).toBe(true);
  expect(
    plansConfigurationChange(
      { claudeHostRefreshConfiguration: true } as CoordinatorBootstrapPlan,
      MIXED_REGISTRY,
    ),
  ).toBe(true);
});
