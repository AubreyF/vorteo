import { createHash } from "node:crypto";
import { z } from "zod";
import { MaintenanceServiceRecoveryLinkSchema } from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  MaintenanceLauncherPlanSchema,
  inspectMaintenanceLauncherPlan,
} from "./coordinator-bootstrap-maintenance-launcher.js";

/** A recovery names one retained rollout and one of its reviewed slots. It
 * cannot smuggle another artifact into authority granted for stabilization. */
export const MaintenanceRecoveryPlanSchema = z.strictObject({
  version: z.literal(2),
  operation: z.enum(["maintenance-service-recovery", "maintenance-service-rollback"]),
  recoveryOf: MaintenanceServiceRecoveryLinkSchema,
  originalPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
  original: MaintenanceLauncherPlanSchema,
});

export function inspectMaintenanceRecoveryPlan(
  value: unknown,
  account: { uid: number; home: string },
) {
  const plan = MaintenanceRecoveryPlanSchema.parse(value);
  const predecessor = inspectMaintenanceLauncherPlan(plan.original, account);
  if (plan.originalPlanSha256 !== predecessor.planSha256) {
    throw new BootstrapRequestConflict("Recovery plan differs from its original reviewed slots");
  }
  const slot = plan.operation === "maintenance-service-recovery" ? "candidate" : "previous";
  const selected = predecessor.plan[slot];
  if (!selected) {
    throw new BootstrapRequestConflict("Recovery plan has no retained compatible rollback slot");
  }
  return {
    plan,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    identitySha256: predecessor.identitySha256,
    identity: predecessor.plan.identity,
    predecessor,
    slot,
    selected,
  };
}

/** Verifies one edge using independently loaded retained plan bytes. Callers
 * traverse every unresolved generation through the existing protected journal. */
export function inspectMaintenanceRecoveryPredecessorPlan(
  recovery: ReturnType<typeof inspectMaintenanceRecoveryPlan>,
  predecessorValue: unknown,
  account: { uid: number; home: string },
) {
  const original = MaintenanceLauncherPlanSchema.safeParse(predecessorValue);
  const previous = original.success
    ? inspectMaintenanceLauncherPlan(original.data, account)
    : inspectMaintenanceRecoveryPlan(predecessorValue, account);
  const originalDigest = original.success
    ? previous.planSha256
    : MaintenanceRecoveryPlanSchema.parse(predecessorValue).originalPlanSha256;
  if (
    previous.planSha256 !== recovery.plan.recoveryOf.planSha256 ||
    originalDigest !== recovery.plan.originalPlanSha256
  ) {
    throw new BootstrapRequestConflict(
      "Recovery immediate predecessor or original history differs",
    );
  }
  return previous;
}
