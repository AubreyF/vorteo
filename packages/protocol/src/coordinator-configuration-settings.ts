import { z } from "zod";
import type { CoordinatorBootstrapPlan } from "./coordinator-bootstrap.js";
import {
  EngineRestartConfigurationSchema,
  EngineRecoveryConfigurationSchema,
  RecoveryOriginSchema,
  FactoryGateConfigurationSchema,
  FactoryRuntimeAdoptionConfigurationSchema,
  HostLauncherUpdateConfigurationSchema,
} from "./execution-installation.js";
import { PreviewMonitorConfigurationSchema } from "./preview-monitor-maintenance.js";

export interface ReviewedConfigurationSettingDefinition {
  /** Location in the coordinator's installation configuration. */
  path: readonly [string] | readonly [string, string];
  /** The value a plan may set; `null` in a change removes the setting. */
  value: z.ZodType;
  /** Whether an owner-reviewed runner renewal may carry the change. */
  renewal: boolean;
  /** COMPAT(bootstrapConfigurationChanges): the plan field that set this before
   * `configurationChanges`. Retain until 2027-04-23, the latest legacy field date.
   * Settings added after the registry have none and change only through
   * `configurationChanges`. */
  legacyField?: keyof CoordinatorBootstrapPlan;
}

type ReviewedConfigurationRegistry = Record<string, ReviewedConfigurationSettingDefinition>;

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
  engineRecovery: {
    path: ["container", "engineRecovery"],
    value: EngineRecoveryConfigurationSchema,
    renewal: true,
  },
  recoveryOrigin: {
    path: ["recoveryOrigin"],
    value: RecoveryOriginSchema,
    renewal: true,
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

/**
 * Every configuration change a plan makes, from `configurationChanges` and the
 * legacy per-setting fields, in registry order. Refuses unknown settings, invalid
 * values and a setting named twice, including once each way.
 */
export function planConfigurationChanges(
  plan: CoordinatorBootstrapPlan,
  registry: ReviewedConfigurationRegistry = REVIEWED_CONFIGURATION_SETTINGS,
): PlanConfigurationChanges {
  const names = Object.keys(registry);
  const found = new Map<string, unknown>();
  for (const entry of plan.configurationChanges ?? []) {
    if (!Object.hasOwn(registry, entry.setting))
      return { ok: false, reason: `Unknown configuration setting: ${entry.setting}` };
    if (found.has(entry.setting))
      return { ok: false, reason: `Configuration setting named twice: ${entry.setting}` };
    found.set(entry.setting, entry.value);
  }
  for (const setting of names) {
    const legacy = legacyValue(plan, registry[setting]);
    if (legacy === undefined) continue;
    if (found.has(setting))
      return { ok: false, reason: `Configuration setting named twice: ${setting}` };
    found.set(setting, legacy);
  }
  const changes: ReviewedConfigurationChange[] = [];
  for (const setting of names) {
    if (!found.has(setting)) continue;
    const value = found.get(setting);
    // Every name here is a registry key; the default registry types it exactly.
    const name = setting as ReviewedConfigurationSetting;
    if (value === null) {
      changes.push({ setting: name, value: null });
      continue;
    }
    const parsed = registry[setting].value.safeParse(value);
    if (!parsed.success)
      return { ok: false, reason: `Invalid value for configuration setting: ${setting}` };
    changes.push({ setting: name, value: parsed.data });
  }
  return { ok: true, changes };
}

/** The setting's legacy plan field value; a registry-only setting has none. */
function legacyValue(
  plan: CoordinatorBootstrapPlan,
  definition: ReviewedConfigurationSettingDefinition,
): unknown {
  return definition.legacyField === undefined ? undefined : plan[definition.legacyField];
}

/** Whether a plan changes any registered setting, valid or not. */
export function plansConfigurationChange(
  plan: CoordinatorBootstrapPlan,
  registry: ReviewedConfigurationRegistry = REVIEWED_CONFIGURATION_SETTINGS,
): boolean {
  return (
    plan.configurationChanges !== undefined ||
    Object.values(registry).some((definition) => legacyValue(plan, definition) !== undefined)
  );
}
