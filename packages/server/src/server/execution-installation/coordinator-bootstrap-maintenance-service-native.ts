import path from "node:path";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import type { MaintenanceServiceNativeObservation } from "./maintenance/service-execution.js";
import {
  verifyRetainedProcessExited,
  type NativeBootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { claimMaintenanceServiceEffect } from "./coordinator-bootstrap-maintenance-service-claim.js";
import {
  inspectMaintenanceServiceExecution,
  inspectRetainedMaintenanceServiceEffect,
} from "./coordinator-bootstrap-maintenance-service-binding.js";
import { readProtectedDocument } from "./coordinator-bootstrap-artifact.js";
import {
  verifyMaintenanceLauncherArtifacts,
  verifyMaintenanceLauncherProcess,
  renderMaintenanceUserLauncher,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { selectMaintenanceFiles } from "./coordinator-bootstrap-maintenance-file-selection.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import {
  MaintenanceServiceObservationSchema,
  MaintenanceServiceEvidenceRecordSchema,
} from "@getpaseo/protocol/maintenance-service";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const nativeCommand = {
  async run(args: readonly string[]) {
    await promisify(execFile)("/bin/launchctl", [...args], {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10_000,
      maxBuffer: 8192,
    });
  },
};
type Claim = Parameters<typeof claimMaintenanceServiceEffect>[0];

/** Native effect ports belong to the selected immutable executor, not HTTP input.
 * The sole coordinator queue reserves work; this function consumes its existing
 * reservation exactly once. An interrupted command leaves the intent retained.
 * Callers must observe that attempt or prepare a new visible recovery request. */
export async function executeMaintenanceServiceReplacement(
  input: Claim & {
    reader: NativeBootstrapServiceReader;
    writableMountRoots: readonly string[];
    /** Revalidates this selected executor, including process birth and runtime. */
    requireExecutor(): Promise<unknown>;
    /** Fresh candidate health from its independent protected status endpoint. */
    readCandidateObservation(signal: AbortSignal): Promise<MaintenanceServiceNativeObservation>;
  },
  command: { run(args: readonly string[]): Promise<void> } = nativeCommand,
): Promise<MaintenanceServiceNativeObservation> {
  const requireExecutor = async () => {
    const observed = BootstrapProcessIdentitySchema.parse(await input.requireExecutor());
    if (
      observed.pid !== process.pid ||
      observed.uid !== process.getuid?.() ||
      !isDeepStrictEqual(observed, BootstrapProcessIdentitySchema.parse(input.executor))
    )
      throw new BootstrapRequestConflict("Native executor lifetime changed");
  };
  await requireExecutor();
  const journal = new FileBootstrapRequestJournal(input.stateDirectory);
  const retained = journal.readLifecycle().find((job) => job.id === input.requestId);
  const context = inspectMaintenanceServiceExecution({ ...input, retained });
  const { plan } = context;
  const identity = plan.identity;
  if (identity.environment !== "host" || !plan.previous || !identity.selectionPath)
    throw new BootstrapRequestConflict(
      "Service replacement requires a retained previous Host slot",
    );
  const previous = input.evidence.native.process;
  if (!previous || previous.pid === process.pid)
    throw new BootstrapRequestConflict("Service replacement requires an independent executor");
  assertNativeTarget(input.evidence.native, context, "previous");
  await verifyMaintenanceLauncherArtifacts(input);
  const startup = await readMaintenanceLauncherStartup({
    setupFile: plan.previous.setup.path,
    account: input.account,
  });
  if (
    !isDeepStrictEqual(startup.plan.identity, identity) ||
    !isDeepStrictEqual(startup.selected, plan.previous)
  )
    throw new BootstrapRequestConflict("Previous service selection differs from reviewed runtime");
  const launcher = await readProtectedDocument(identity.launcherPath);
  const selection = await readProtectedDocument(identity.selectionPath);
  if (
    hash(launcher) !== input.evidence.native.service.launcherSha256 ||
    hash(selection) !== input.evidence.native.selection.receiptSha256
  )
    throw new BootstrapRequestConflict("Service files differ from native admission");
  const verifyPrevious = async () => {
    const observed = await verifyMaintenanceLauncherProcess({
      plan,
      account: input.account,
      selected: "previous",
      pid: previous.pid,
      reader: input.reader,
    });
    if (!isDeepStrictEqual(previous, observed))
      throw new BootstrapRequestConflict("Previous service lifetime changed");
  };
  await verifyPrevious();
  const claimed = claimMaintenanceServiceEffect(input);
  const requireClaim = () => {
    const current = journal.readLifecycle().find((job) => job.id === claimed.id);
    if (!isDeepStrictEqual(current, claimed))
      throw new BootstrapRequestConflict("Native service effect ownership changed");
  };
  // Recheck after durable consumption, before the first native command. Errors
  // from here are uncertain attempts, never permission to enter execute again.
  await requireExecutor();
  await verifyPrevious();
  requireClaim();
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  await command.run(["bootout", service]);
  await input.reader.verifyProcessExited(previous.pid);
  await input.reader.verifyServiceAbsent(service);
  await requireExecutor();
  await verifyMaintenanceLauncherArtifacts(input);
  await input.reader.verifyServiceAbsent(service);
  const nextSelection = {
    version: 2,
    requestId: claimed.id,
    requestRevision: input.reservation.requestRevision,
    intentId: claimed.effectIntent!.id,
    generation: input.reservation.generation,
    planSha256: context.planSha256,
    slot: "candidate",
  };
  // Only file publication is inside this transaction. Native commands and
  // asynchronous inspection never run while the lifecycle lock is held.
  journal.withRecoveryTransaction(() => {
    requireClaim();
    selectMaintenanceFiles({
      attemptFile: path.join(
        input.stateDirectory,
        `maintenance-selection-${claimed.effectIntent!.id}.json`,
      ),
      reservationSha256: hash(JSON.stringify(input.reservation)),
      launcher: {
        path: identity.launcherPath,
        previousSha256: hash(launcher),
        bytes: renderMaintenanceUserLauncher(plan, "candidate"),
      },
      selection: {
        path: identity.selectionPath!,
        previousSha256: hash(selection),
        bytes: Buffer.from(JSON.stringify(nextSelection)),
      },
      assertCurrent: requireClaim,
    });
  });
  await requireExecutor();
  await input.reader.verifyServiceAbsent(service);
  requireClaim();
  await command.run(["bootstrap", identity.serviceDomain, identity.launcherPath]);
  const result = await readBoundedCandidateObservation((signal) =>
    input.readCandidateObservation(signal),
  );
  const observed = result.record.native.process;
  if (!observed) throw new BootstrapRequestConflict("Candidate process evidence is absent");
  const actual = await verifyMaintenanceLauncherProcess({
    plan,
    account: input.account,
    selected: "candidate",
    pid: observed.pid,
    reader: input.reader,
  });
  if (!isDeepStrictEqual(observed, actual) || actual.bootId !== previous.bootId)
    throw new BootstrapRequestConflict("Candidate native lifetime changed");
  if (result.outcome !== "candidate" || !result.ready)
    throw new BootstrapRequestConflict("Candidate observation differs from reserved replacement");
  verifyServiceObservation(result, context);
  const evidence = result.record.native;
  assertNativeTarget(evidence, context, "candidate");
  if (
    evidence.service.launcherSha256 !== hash(await readProtectedDocument(identity.launcherPath)) ||
    evidence.selection.receiptSha256 !== hash(await readProtectedDocument(identity.selectionPath))
  )
    throw new BootstrapRequestConflict(
      "Candidate service observation names different native files",
    );
  result.assertCurrent();
  requireClaim();
  return result;
}

/** A consumed intent can be observed after revocation or executor loss. There
 * are no native effect ports here, and the exact reservation remains immutable. */
export async function observeMaintenanceServiceReplacement(
  input: Pick<Claim, "stateDirectory" | "requestId" | "reservation" | "plan" | "account"> & {
    reader: NativeBootstrapServiceReader;
    writableMountRoots: readonly string[];
    readObservation(signal: AbortSignal): Promise<MaintenanceServiceNativeObservation>;
  },
): Promise<MaintenanceServiceNativeObservation> {
  const journal = new FileBootstrapRequestJournal(input.stateDirectory);
  const retained = journal.readLifecycle().find((job) => job.id === input.requestId);
  const context = inspectRetainedMaintenanceServiceEffect({ ...input, retained });
  if (!isDeepStrictEqual(context.reservation, input.reservation))
    throw new BootstrapRequestConflict("Native observation reservation changed");
  const identity = context.plan.identity;
  if (identity.environment !== "host" || !identity.selectionPath)
    throw new BootstrapRequestConflict("Native observation requires enrolled Host custody");
  await verifyMaintenanceLauncherArtifacts(input);
  const result = await readBoundedCandidateObservation((signal) => input.readObservation(signal));
  verifyServiceObservation(result, context);
  const evidence = result.record.native;
  await verifyObservedServiceFiles(evidence, identity);
  if (result.outcome === "unknown") {
    if (evidence.process || evidence.service.registered)
      throw new BootstrapRequestConflict("Unknown service absence is not proven");
    await input.reader.verifyServiceAbsent(`${identity.serviceDomain}/${identity.serviceLabel}`);
    const observer = BootstrapProcessIdentitySchema.parse(
      await input.reader.inspectProcess(process.pid),
    );
    if (
      observer.pid !== process.pid ||
      observer.uid !== input.account.uid ||
      observer.bootId !== evidence.bootId
    )
      throw new BootstrapRequestConflict("Native absence boot identity changed");
  } else {
    const observed = evidence.process;
    if (!observed) throw new BootstrapRequestConflict("Observed service process is absent");
    const actual = await verifyMaintenanceLauncherProcess({
      plan: context.plan,
      account: input.account,
      selected: result.outcome,
      pid: observed.pid,
      reader: input.reader,
    });
    if (!isDeepStrictEqual(observed, actual) || actual.bootId !== evidence.bootId)
      throw new BootstrapRequestConflict("Observed service lifetime changed");
    assertNativeTarget(evidence, context, result.outcome);
    const selected = context.plan[result.outcome]!;
    const startup = await readMaintenanceLauncherStartup({
      setupFile: selected.setup.path,
      account: input.account,
    });
    if (
      !isDeepStrictEqual(startup.selected, selected) ||
      !isDeepStrictEqual(startup.plan.identity, identity)
    )
      throw new BootstrapRequestConflict("Observed service selection differs from retained slot");
    if (
      result.outcome === "candidate" &&
      (startup.selection.version !== 2 ||
        startup.selection.requestId !== context.job.id ||
        startup.selection.intentId !== context.intent.id ||
        startup.selection.generation !== context.reservation.generation)
    )
      throw new BootstrapRequestConflict("Candidate selection belongs to another attempt");
  }
  const settled = await settleServiceObservation(result, context, input.reader);
  const assertCurrent = () => {
    result.assertCurrent();
    if (
      !isDeepStrictEqual(
        retained,
        journal.readLifecycle().find((job) => job.id === input.requestId),
      )
    )
      throw new BootstrapRequestConflict("Retained native observation changed");
  };
  assertCurrent();
  return { ...settled, assertCurrent };
}

/** A ready old service does not mean a live consumed executor has finished.
 * Preserve its independently verified native evidence, but never let that
 * observation release queue exclusion while future effects remain possible. */
async function settleServiceObservation(
  result: MaintenanceServiceNativeObservation,
  context: ReturnType<typeof inspectRetainedMaintenanceServiceEffect>,
  reader: NativeBootstrapServiceReader,
): Promise<MaintenanceServiceNativeObservation> {
  if (result.outcome === "candidate") {
    if (Date.parse(result.observedAt) < Date.parse(context.intent.consumedAt))
      throw new BootstrapRequestConflict("Candidate observation predates its consumed intent");
    return result;
  }
  if (result.outcome !== "previous") return result;
  try {
    await verifyRetainedProcessExited(reader, context.intent.executor);
    return result;
  } catch {
    const record = MaintenanceServiceEvidenceRecordSchema.parse({
      ...result.record,
      sourceCommit: null,
      artifactSha256: null,
    });
    return {
      ...result,
      outcome: "unknown",
      ready: false,
      sourceCommit: null,
      artifactSha256: null,
      record,
      evidenceSha256: hash(JSON.stringify(record)),
    };
  }
}

async function verifyObservedServiceFiles(
  evidence: MaintenanceServiceNativeObservation["record"]["native"],
  identity: Extract<
    ReturnType<typeof inspectMaintenanceServiceExecution>["plan"]["identity"],
    { environment: "host" }
  >,
) {
  if (
    evidence.service.domain !== identity.serviceDomain ||
    evidence.service.label !== identity.serviceLabel ||
    evidence.service.launcherPath !== identity.launcherPath ||
    evidence.selection.path !== identity.selectionPath ||
    evidence.service.launcherSha256 !== hash(await readProtectedDocument(identity.launcherPath)) ||
    evidence.selection.receiptSha256 !== hash(await readProtectedDocument(identity.selectionPath!))
  )
    throw new BootstrapRequestConflict("Native observation differs from retained service files");
}

function verifyServiceObservation(
  value: MaintenanceServiceNativeObservation,
  context: ReturnType<typeof inspectMaintenanceServiceExecution>,
) {
  const { record: _record, assertCurrent: _assertCurrent, ...observation } = value;
  const result = MaintenanceServiceObservationSchema.parse(observation);
  const record = MaintenanceServiceEvidenceRecordSchema.parse(value.record);
  const { reservation } = context;
  const release = result.outcome === "unknown" ? null : context.plan[result.outcome];
  if ((result.outcome !== "unknown" && !release) || (result.outcome === "unknown" && result.ready))
    throw new BootstrapRequestConflict("Unknown native service cannot establish readiness");
  verifyObservationFreshness(result, record);
  if (
    result.requestId !== context.job.id ||
    result.requestRevision !== reservation.requestRevision ||
    result.generation !== reservation.generation ||
    result.planSha256 !== context.planSha256 ||
    result.identitySha256 !== context.identitySha256 ||
    result.sourceCommit !== (release?.sourceCommit ?? null) ||
    result.artifactSha256 !== (release?.artifactSha256 ?? null) ||
    !observationRecordMatches(record, result)
  )
    throw new BootstrapRequestConflict("Candidate observation differs from reserved replacement");
}

function verifyObservationFreshness(
  result: ReturnType<typeof MaintenanceServiceObservationSchema.parse>,
  record: MaintenanceServiceNativeObservation["record"],
) {
  const age = Date.now() - Date.parse(result.observedAt);
  if (age < 0 || age >= 30_000 || result.observedAt !== record.observedAt)
    throw new BootstrapRequestConflict("Candidate native observation is not fresh");
}

function observationRecordMatches(
  record: MaintenanceServiceNativeObservation["record"],
  result: ReturnType<typeof MaintenanceServiceObservationSchema.parse>,
) {
  return (
    hash(JSON.stringify(record)) === result.evidenceSha256 &&
    record.requestId === result.requestId &&
    record.requestRevision === result.requestRevision &&
    record.planSha256 === result.planSha256 &&
    record.identitySha256 === result.identitySha256 &&
    record.sourceCommit === result.sourceCommit &&
    record.artifactSha256 === result.artifactSha256
  );
}

function assertNativeTarget(
  native: MaintenanceServiceNativeObservation["record"]["native"],
  context: ReturnType<typeof inspectMaintenanceServiceExecution>,
  slot: "previous" | "candidate",
) {
  const { identity } = context.plan;
  const release = context.plan[slot];
  if (
    identity.environment !== "host" ||
    !release ||
    !native.service.registered ||
    native.service.domain !== identity.serviceDomain ||
    native.service.label !== identity.serviceLabel ||
    native.service.launcherPath !== identity.launcherPath ||
    native.selection.path !== identity.selectionPath ||
    native.selection.sourceCommit !== release.sourceCommit ||
    native.selection.artifactSha256 !== release.artifactSha256
  )
    throw new BootstrapRequestConflict("Service native evidence names a different target");
}

/** An observation deadline never retries an effect or establishes target failure.
 * A transport that ignores abort may finish later, but cannot resume execution. */
async function readBoundedCandidateObservation(
  read: (signal: AbortSignal) => Promise<MaintenanceServiceNativeObservation>,
): Promise<MaintenanceServiceNativeObservation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new BootstrapRequestConflict("Candidate readiness observation timed out");
      reject(error);
      controller.abort(error);
    }, 30_000);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => read(controller.signal)), deadline]);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
