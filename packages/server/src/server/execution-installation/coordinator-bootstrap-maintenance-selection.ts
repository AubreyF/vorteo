import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { InstallationEnrollmentStateSchema } from "@getpaseo/protocol/installation-enrollment";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { enrollmentManifestDigest } from "./maintenance/authorization.js";
import { inspectMaintenanceLauncherPlan } from "./coordinator-bootstrap-maintenance-launcher.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const MaintenanceLauncherIntentSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  operation: z.literal("maintenance-launcher-replacement"),
  grantId: z.uuid(),
  grantRevision: z.uuid(),
  manifestSha256: digest,
  stepId: z.uuid(),
  generation: z.uuid(),
  planSha256: digest,
  identitySha256: digest,
  createdAt: z.string().datetime(),
});

/** Selection binds to the retained effect rather than minting a new attempt.
 * The previous slot is the same reviewed rollback, not an arbitrary downgrade. */
export const MaintenanceLauncherSelectionSchema = z.strictObject({
  version: z.literal(1),
  intentId: z.uuid(),
  stepId: z.uuid(),
  generation: z.uuid(),
  planSha256: digest,
  slot: z.enum(["candidate", "previous"]),
});

/** Read-only startup binding. Revocation may leave an already loaded process
 * available for status and observation; it never restores dispatch authority.
 * Native process, protected files and artifact bytes must also be verified. */
export function inspectMaintenanceLauncherSelection(input: {
  plan: unknown;
  account: { uid: number; home: string };
  enrollment: unknown;
  intent: unknown;
  selection: unknown;
}) {
  const inspected = inspectMaintenanceLauncherPlan(input.plan, input.account);
  const intent = MaintenanceLauncherIntentSchema.parse(input.intent);
  const selection = MaintenanceLauncherSelectionSchema.parse(input.selection);
  const state = InstallationEnrollmentStateSchema.parse(input.enrollment);
  if (state.status !== "enrolled")
    throw new BootstrapRequestConflict("Launcher selection has no enrollment");
  const { grant, activation } = state;
  const step = grant.manifest.steps.find((item) => item.id === intent.stepId);
  const progress = activation.steps.find((item) => item.id === intent.stepId);
  assertSelectionAuthority(inspected, intent, state);
  const artifact = (release: typeof inspected.plan.previous) =>
    release && { sourceCommit: release.sourceCommit, artifactSha256: release.artifactSha256 };
  if (
    step?.target !== inspected.plan.identity.target ||
    step.operation !== "replacement" ||
    step.planSha256 !== inspected.planSha256 ||
    !isDeepStrictEqual(step.candidate, artifact(inspected.plan.candidate)) ||
    !isDeepStrictEqual(step.previous, artifact(inspected.plan.previous)) ||
    !progress ||
    progress.status === "pending" ||
    progress.generation !== intent.generation ||
    progress.grantRevision !== intent.grantRevision
  )
    throw new BootstrapRequestConflict("Launcher selection differs from its activation step");
  const selected = inspected.plan[selection.slot];
  if (
    !selected ||
    selection.intentId !== intent.id ||
    selection.stepId !== intent.stepId ||
    selection.generation !== intent.generation ||
    selection.planSha256 !== inspected.planSha256
  )
    throw new BootstrapRequestConflict("Launcher selected slot differs from retained intent");
  return { ...inspected, intent, selection, selected };
}

function assertSelectionAuthority(
  inspected: ReturnType<typeof inspectMaintenanceLauncherPlan>,
  intent: z.infer<typeof MaintenanceLauncherIntentSchema>,
  state: Extract<z.infer<typeof InstallationEnrollmentStateSchema>, { status: "enrolled" }>,
) {
  const { grant, activation } = state;
  const target = grant.manifest.targets.find(
    (item) => item.target === inspected.plan.identity.target,
  );
  if (
    grant.id !== intent.grantId ||
    grant.manifest.installationId !== inspected.plan.identity.installationId ||
    enrollmentManifestDigest(grant.manifest) !== intent.manifestSha256 ||
    activation.manifestSha256 !== intent.manifestSha256 ||
    target?.identitySha256 !== inspected.identitySha256 ||
    !target.operations.includes("replacement") ||
    intent.identitySha256 !== inspected.identitySha256 ||
    intent.planSha256 !== inspected.planSha256
  )
    throw new BootstrapRequestConflict("Launcher selection authority differs from enrollment");
}
