import { z } from "zod";
import type { CoordinatorBootstrapPlan } from "./coordinator-bootstrap.js";
import {
  EngineRestartConfigurationSchema,
  FactoryGateConfigurationSchema,
  FactoryRuntimeAdoptionConfigurationSchema,
  HostLauncherUpdateConfigurationSchema,
} from "./execution-installation.js";
import { PreviewMonitorConfigurationSchema } from "./preview-monitor-maintenance.js";

interface ReviewedConfigurationSettingDefinition {
  /** Location in the coordinator's installation configuration. */
  path: readonly [string] | readonly [string, string];
  /** The value a plan may set; `null` in a change removes the setting. */
  value: z.ZodType;
  /** Whether an owner-reviewed runner renewal may carry the change. */
  renewal: boolean;
  /** COMPAT(bootstrapConfigurationChanges): the plan field that set this before
   * `configurationChanges`. Retain until 2027-04-23, the latest legacy field date. */
  legacyField: keyof CoordinatorBootstrapPlan;
}

/**
 * Coordinator configuration settings that a reviewed coordinator update may change.
 * Nothing outside this table can change through `configurationChanges`. Approval
 * policy, source update tooling, the native helper and Dev registration keep their
 * own rules. Entry order is the order changes are applied, matching the
 * pre-registry verifier so expected configurations stay identical.
 */
export const REVIEWED_CONFIGURATION_SETTINGS = {
  factoryRuntimeAdoption: {
    path: ["container", "factoryRuntimeAdoption"],
    value: FactoryRuntimeAdoptionConfigurationSchema,
    renewal: true,
    legacyField: "factoryRuntimeAdoptionConfiguration",
  },
  previewMonitor: {
    path: ["previewMonitor"],
    value: PreviewMonitorConfigurationSchema,
    renewal: false,
    legacyField: "previewMonitorConfiguration",
  },
  claudeHostRefresh: {
    path: ["claudeHostRefresh"],
    value: z.literal(true),
    renewal: true,
    legacyField: "claudeHostRefreshConfiguration",
  },
  engineRestart: {
    path: ["container", "engineRestart"],
    value: EngineRestartConfigurationSchema,
    renewal: true,
    legacyField: "engineRestartConfiguration",
  },
  factoryGate: {
    path: ["container", "factoryGate"],
    value: FactoryGateConfigurationSchema,
    renewal: true,
    legacyField: "factoryGateConfiguration",
  },
  hostLauncherUpdate: {
    path: ["host", "launcherUpdate"],
    value: HostLauncherUpdateConfigurationSchema,
    renewal: true,
    legacyField: "hostLauncherUpdateConfiguration",
  },
} as const satisfies Record<string, ReviewedConfigurationSettingDefinition>;

export type ReviewedConfigurationSetting = keyof typeof REVIEWED_CONFIGURATION_SETTINGS;
export type ReviewedConfigurationValue<S extends ReviewedConfigurationSetting> = z.infer<
  (typeof REVIEWED_CONFIGURATION_SETTINGS)[S]["value"]
>;
export const REVIEWED_CONFIGURATION_SETTING_NAMES = Object.keys(
  REVIEWED_CONFIGURATION_SETTINGS,
) as ReviewedConfigurationSetting[];

export interface ReviewedConfigurationChange {
  setting: ReviewedConfigurationSetting;
  /** The parsed value, or null to remove the setting. */
  value: unknown;
}

export type PlanConfigurationChanges =
  | { ok: true; changes: ReviewedConfigurationChange[] }
  | { ok: false; reason: string };

function isReviewedSetting(setting: string): setting is ReviewedConfigurationSetting {
  return Object.hasOwn(REVIEWED_CONFIGURATION_SETTINGS, setting);
}

/**
 * Every configuration change a plan makes, from `configurationChanges` and the
 * legacy per-setting fields, in registry order. Refuses unknown settings, invalid
 * values and a setting named twice, including once each way.
 */
export function planConfigurationChanges(plan: CoordinatorBootstrapPlan): PlanConfigurationChanges {
  const found = new Map<ReviewedConfigurationSetting, unknown>();
  for (const entry of plan.configurationChanges ?? []) {
    if (!isReviewedSetting(entry.setting))
      return { ok: false, reason: `Unknown configuration setting: ${entry.setting}` };
    if (found.has(entry.setting))
      return { ok: false, reason: `Configuration setting named twice: ${entry.setting}` };
    found.set(entry.setting, entry.value);
  }
  for (const setting of REVIEWED_CONFIGURATION_SETTING_NAMES) {
    const legacy = plan[REVIEWED_CONFIGURATION_SETTINGS[setting].legacyField];
    if (legacy === undefined) continue;
    if (found.has(setting))
      return { ok: false, reason: `Configuration setting named twice: ${setting}` };
    found.set(setting, legacy);
  }
  const changes: ReviewedConfigurationChange[] = [];
  for (const setting of REVIEWED_CONFIGURATION_SETTING_NAMES) {
    if (!found.has(setting)) continue;
    const value = found.get(setting);
    if (value === null) {
      changes.push({ setting, value: null });
      continue;
    }
    const parsed = REVIEWED_CONFIGURATION_SETTINGS[setting].value.safeParse(value);
    if (!parsed.success)
      return { ok: false, reason: `Invalid value for configuration setting: ${setting}` };
    changes.push({ setting, value: parsed.data });
  }
  return { ok: true, changes };
}

/** Whether a plan changes any registered setting, valid or not. */
export function plansConfigurationChange(plan: CoordinatorBootstrapPlan): boolean {
  return (
    plan.configurationChanges !== undefined ||
    REVIEWED_CONFIGURATION_SETTING_NAMES.some(
      (setting) => plan[REVIEWED_CONFIGURATION_SETTINGS[setting].legacyField] !== undefined,
    )
  );
}
