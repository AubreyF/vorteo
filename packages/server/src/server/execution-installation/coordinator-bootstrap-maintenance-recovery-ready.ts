import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  MaintenanceServiceEvidenceRecordSchema,
  MaintenanceServiceObservationSchema,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { inspectRetainedMaintenanceRecoveryEffect } from "./coordinator-bootstrap-maintenance-recovery-binding.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import {
  verifyMaintenanceLauncherProcess,
  renderMaintenanceUserLauncher,
  maintenanceUserLauncher,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { readProtectedDocument } from "./coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import type { MaintenanceServiceNativeObservation } from "./maintenance/service-execution.js";
import type { NativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Context = ReturnType<typeof inspectRetainedMaintenanceRecoveryEffect>;

/** Verify the selected recovery generation independently of its readiness.
 * A restored rollback slot belongs to this new job, not its failed predecessor. */
export async function verifyMaintenanceRecoveryObservation(input: {
  retained: unknown;
  plan: unknown;
  account: { uid: number; home: string };
  reader: NativeBootstrapServiceReader;
  result: MaintenanceServiceNativeObservation;
}) {
  const context = inspectRetainedMaintenanceRecoveryEffect(input);
  const record = requireRecoveryObservation(context, input.result);
  const identity = context.identity;
  if (identity.environment !== "host" || !identity.selectionPath)
    throw new BootstrapRequestConflict("Recovery readiness requires native selection custody");
  const native = record.native;
  if (
    !native.process ||
    !native.service.registered ||
    native.service.domain !== identity.serviceDomain ||
    native.service.label !== identity.serviceLabel ||
    native.service.launcherPath !== identity.launcherPath ||
    native.selection.path !== identity.selectionPath ||
    native.selection.sourceCommit !== context.selected.sourceCommit ||
    native.selection.artifactSha256 !== context.selected.artifactSha256
  )
    throw new BootstrapRequestConflict("Recovery readiness names another native target");
  const assertFiles = retainServiceFiles([
    identity.launcherPath,
    identity.selectionPath,
    context.selected.setup.path,
    context.selected.node.path,
    context.selected.entrypoint.path,
  ]);
  const launcher = await readProtectedDocument(identity.launcherPath);
  const selection = await readProtectedDocument(identity.selectionPath);
  if (
    !launcher.equals(renderMaintenanceUserLauncher(context.plan.original, context.slot)) ||
    hash(launcher) !== native.service.launcherSha256 ||
    hash(JSON.stringify(maintenanceUserLauncher(context.plan.original, context.slot))) !==
      native.service.registrationSha256 ||
    hash(selection) !== native.selection.receiptSha256
  )
    throw new BootstrapRequestConflict("Recovery readiness differs from selected native files");
  const startup = await readMaintenanceLauncherStartup({
    setupFile: context.selected.setup.path,
    account: input.account,
  });
  requireSelectedGeneration(context, startup);
  const actual = await verifyMaintenanceLauncherProcess({
    plan: context.plan.original,
    account: input.account,
    selected: context.slot,
    pid: native.process.pid,
    reader: input.reader,
  });
  if (!isDeepStrictEqual(actual, native.process) || actual.bootId !== native.bootId)
    throw new BootstrapRequestConflict("Recovery ready process lifetime changed");
  const assertCurrent = () => {
    assertFiles();
    if (input.result.assertCurrent() !== undefined)
      throw new BootstrapRequestConflict("Recovery readiness requires synchronous native custody");
  };
  assertCurrent();
  return assertCurrent;
}

function requireSelectedGeneration(
  context: Context,
  startup: Awaited<ReturnType<typeof readMaintenanceLauncherStartup>>,
) {
  const selection = startup.selection;
  if (
    !isDeepStrictEqual(startup.selected, context.selected) ||
    !isDeepStrictEqual(startup.plan.identity, context.identity) ||
    selection.version !== 3 ||
    selection.requestId !== context.job.id ||
    selection.requestRevision !== context.reservation.requestRevision ||
    selection.generation !== context.reservation.generation ||
    selection.intentId !== context.intent.id ||
    selection.planSha256 !== context.planSha256 ||
    selection.slot !== context.slot
  )
    throw new BootstrapRequestConflict("Recovery selected runtime belongs to another generation");
}

export async function verifyMaintenanceRecoveryReady(
  input: Parameters<typeof verifyMaintenanceRecoveryObservation>[0],
) {
  const assertCurrent = await verifyMaintenanceRecoveryObservation(input);
  if (!input.result.ready) throw new BootstrapRequestConflict("Recovery candidate is not ready");
  return assertCurrent;
}

function requireRecoveryObservation(context: Context, result: MaintenanceServiceNativeObservation) {
  const { record: value, assertCurrent: _assert, ...observation } = result;
  const observed = MaintenanceServiceObservationSchema.parse(observation);
  const record = MaintenanceServiceEvidenceRecordSchema.parse(value);
  const age = Date.now() - Date.parse(observed.observedAt);
  const expected = {
    requestId: context.job.id,
    requestRevision: context.reservation.requestRevision,
    planSha256: context.planSha256,
    identitySha256: context.identitySha256,
    sourceCommit: context.selected.sourceCommit,
    artifactSha256: context.selected.artifactSha256,
    observedAt: observed.observedAt,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (
      observed[key as keyof typeof observed] !== expectedValue ||
      record[key as keyof typeof record] !== expectedValue
    )
      throw new BootstrapRequestConflict("Recovery observation differs from retained generation");
  }
  if (
    observed.outcome !== "candidate" ||
    observed.generation !== context.reservation.generation ||
    hash(JSON.stringify(record)) !== observed.evidenceSha256 ||
    age < 0 ||
    age >= 30_000 ||
    Date.parse(observed.observedAt) < Date.parse(context.intent.consumedAt)
  )
    throw new BootstrapRequestConflict("Recovery readiness is not a fresh post-intent observation");
  return record;
}
