import path from "node:path";
import { constants, openSync, closeSync, writeFileSync, fsyncSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  BootstrapRequestConflict,
  openBootstrapRequests,
  assertCoordinatorLifecycleIdle,
} from "./coordinator-bootstrap.js";
import { FileEnrollmentJournal, enrollmentManifestDigest } from "./maintenance/authorization.js";
import { MaintenanceLauncherIntentSchema } from "./coordinator-bootstrap-maintenance-selection.js";
import {
  inspectMaintenanceLauncherPlan,
  type MaintenanceLauncherPlan,
} from "./coordinator-bootstrap-maintenance-launcher.js";

/** A launcher effect consumes its existing activation reservation under the same
 * exclusion as coordinator and queue claims. The immutable intent is not a new
 * queue. If its creation or synchronization is uncertain, observe it; never
 * retry registration, selection or process launch from this entrypoint. */
export function reserveMaintenanceLauncherEffect(input: {
  plan: MaintenanceLauncherPlan;
  /** From the verified launcher setup, not the target's private state path. */
  enrollmentStateDirectory: string;
  account: { uid: number; home: string };
  grantId: string;
  grantRevision: string;
  stepId: string;
  generation: string;
  /** Synchronous independent custody recheck inside lifecycle exclusion. */
  assertCurrent(): void;
}) {
  const inspected = inspectMaintenanceLauncherPlan(input.plan, input.account);
  const directory = input.enrollmentStateDirectory;
  const bootstrap = new FileBootstrapRequestJournal(directory);
  const enrollment = new FileEnrollmentJournal(directory);
  return bootstrap.withRecoveryTransaction((requests) => {
    if (openBootstrapRequests(requests).some((request) => request.execution))
      throw new BootstrapRequestConflict(
        "Coordinator execution must finish before launcher replacement",
      );
    assertCoordinatorLifecycleIdle(bootstrap.readLifecycle());
    const state = enrollment.readUnderLifecycleLock();
    if (state.status !== "enrolled")
      throw new BootstrapRequestConflict("Launcher enrollment is absent");
    const { grant, activation } = state;
    const target = grant.manifest.targets.find(
      (item) => item.target === inspected.plan.identity.target,
    );
    const step = grant.manifest.steps.find((item) => item.id === input.stepId);
    const progress = activation.steps.find((item) => item.id === input.stepId);
    if (
      grant.id !== input.grantId ||
      grant.revision !== input.grantRevision ||
      grant.manifest.installationId !== inspected.plan.identity.installationId ||
      grant.paused ||
      grant.revokedAt ||
      grant.disabledTargets.includes(inspected.plan.identity.target) ||
      target?.identitySha256 !== inspected.identitySha256 ||
      !target.operations.includes("replacement")
    )
      throw new BootstrapRequestConflict("Standing grant no longer admits launcher replacement");
    assertLauncherStep(input, inspected.planSha256, step, progress);
    if (typeof input.assertCurrent !== "function" || input.assertCurrent() !== undefined)
      throw new BootstrapRequestConflict("Launcher custody requires a synchronous native recheck");
    const intent = MaintenanceLauncherIntentSchema.parse({
      version: 1,
      id: randomUUID(),
      operation: "maintenance-launcher-replacement",
      grantId: grant.id,
      grantRevision: grant.revision,
      manifestSha256: enrollmentManifestDigest(grant.manifest),
      stepId: input.stepId,
      generation: input.generation,
      planSha256: inspected.planSha256,
      identitySha256: inspected.identitySha256,
      createdAt: new Date().toISOString(),
    });
    const file = path.join(
      directory,
      `maintenance-launcher-${progress!.id}-${input.generation}.json`,
    );
    const fd = openSync(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(intent));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const parent = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    return { file, intent };
  });
}

function assertLauncherStep(
  input: Parameters<typeof reserveMaintenanceLauncherEffect>[0],
  planSha256: string,
  step: import("@getpaseo/protocol/installation-enrollment").EnrollmentStep | undefined,
  progress: import("@getpaseo/protocol/installation-enrollment").EnrollmentStepProgress | undefined,
) {
  const artifact = (slot: MaintenanceLauncherPlan["candidate"] | null) =>
    slot && {
      sourceCommit: slot.sourceCommit,
      artifactSha256: slot.artifactSha256,
    };
  if (
    step?.target !== input.plan.identity.target ||
    step.operation !== "replacement" ||
    step.planSha256 !== planSha256 ||
    !isDeepStrictEqual(step.candidate, artifact(input.plan.candidate)) ||
    !isDeepStrictEqual(step.previous, artifact(input.plan.previous)) ||
    progress?.status !== "reserved" ||
    progress.generation !== input.generation ||
    progress.grantRevision !== input.grantRevision
  )
    throw new BootstrapRequestConflict("Launcher effect differs from the reserved activation step");
}
