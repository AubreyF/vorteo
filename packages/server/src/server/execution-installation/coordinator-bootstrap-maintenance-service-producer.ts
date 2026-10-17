import { inspectMaintenanceServicePresence } from "./coordinator-bootstrap-maintenance-absence.js";
import { observeConsumedMaintenanceServiceAbsence } from "./coordinator-bootstrap-maintenance-recovery-inspection.js";
import { inspectRetainedMaintenanceServiceEffect } from "./coordinator-bootstrap-maintenance-service-binding.js";
import { inspectRetainedMaintenanceRecoveryEffect } from "./coordinator-bootstrap-maintenance-recovery-binding.js";
import { verifyRetainedProcessExited } from "./coordinator-bootstrap-service.js";
import { verifySelectedServiceRunner } from "./coordinator-bootstrap-maintenance-runner-contract.js";
import { inspectMaintenanceRecoveryPlan } from "./coordinator-bootstrap-maintenance-recovery-plan.js";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FileEnrollmentJournal } from "./maintenance/authorization.js";
import { readEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import {
  MaintenanceLauncherSelectionSchema,
  MaintenanceServiceSelectionSchema,
  MaintenanceRecoverySelectionSchema,
} from "./coordinator-bootstrap-maintenance-selection.js";
import {
  inspectMaintenanceLauncherPlan,
  verifyMaintenanceLauncherArtifacts,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { userInfo } from "node:os";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  MaintenanceServiceJobSchema,
  type MaintenanceServiceJob,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  readProtectedDocument,
  readBootstrapPreparedFile,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import { inspectMaintenanceServiceInvocation } from "./coordinator-bootstrap-maintenance-service-runner.js";
import {
  createMaintenanceServiceInspectionPorts,
  inspectMaintenanceServiceReadiness,
} from "./coordinator-bootstrap-maintenance-service-inspection.js";
import {
  observeMaintenanceServiceReplacement,
  readBoundedMaintenanceInspection,
} from "./coordinator-bootstrap-maintenance-service-native.js";
import { observeMaintenanceRecovery } from "./coordinator-bootstrap-maintenance-recovery-native.js";
import type { MaintenanceServiceExecutor } from "./maintenance/service-execution.js";

import {
  inspectSelectedMaintenanceExecutor,
  bindMaintenanceExecutorEvidence,
  requireReservedMaintenanceExecutor,
  maintenanceRecoveryBootWitness,
  inspectMaintenanceTargetEvidence,
  inspectMaintenanceCoordinatorWitness,
} from "./coordinator-bootstrap-maintenance-executor-evidence.js";

const invocationDeadlineMs = 25_000;

/** Construction is read-only. The selected, protected runtime must contain this
 * exact runner implementation. Enrollment policy is checked at effect claim,
 * not here, so revocation never removes retained observation support. */
export interface NativeMaintenanceServiceExecutorInput {
  executorSetupFile: string;
  installationId: string;
  stateDirectory: string;
  executorTarget?: "maintenance-controller" | "recovery-launcher";
}

export async function createNativeMaintenanceServiceExecutor(
  input: NativeMaintenanceServiceExecutorInput,
): Promise<MaintenanceServiceExecutor> {
  const executorTarget = input.executorTarget ?? "maintenance-controller";
  const owner = userInfo();
  const account = { uid: owner.uid, home: owner.homedir };
  // Construction verifies discovery, but every operation resolves again. A
  // compatible controller replacement must not require restarting this consumer.
  const stateDirectory = input.stateDirectory;
  const journal = new FileBootstrapRequestJournal(stateDirectory);
  const attempted = new Set<string>();
  const refresh = async () => {
    const resolved = await resolveNativeMaintenanceRoleSetup({ ...input, target: executorTarget });
    const startup = await readMaintenanceLauncherStartup({
      setupFile: resolved.executorSetupFile,
      account,
    });
    if (
      executorTarget === "recovery-launcher" &&
      startup.setup.control?.recoveryAccess?.serviceExecutorVersion !== 1
    )
      throw new BootstrapRequestConflict(
        "Selected recovery page does not provide exact service execution",
      );
    const admission = BootstrapAdmissionSetupSchema.parse(
      JSON.parse(
        (await readBootstrapPreparedFile(startup.setup.nativeAdmission, [])).toString("utf8"),
      ),
    );
    const writableMountRoots = await inspectBootstrapWritableMountRoots(admission);
    await assertBootstrapPathsProtected(
      [resolved.executorSetupFile, startup.planFile, startup.intentFile],
      writableMountRoots,
    );
    const ports = await createMaintenanceServiceInspectionPorts({
      ...admission,
      writableMountRoots,
    });
    await verifySelectedServiceRunner({
      directory: startup.selected.directory,
      writableMountRoots,
      recoveryAccess: executorTarget === "recovery-launcher",
    });
    await verifyMaintenanceLauncherArtifacts({ plan: startup.plan, account, writableMountRoots });
    return {
      startup,
      account,
      stateDirectory,
      writableMountRoots,
      ports,
      resolved,
      admission,
    };
  };
  const initial = await refresh();
  // Observation uses retained, protected inspection tools, not a live executor
  // admission. A stopped/replaced controller or revoked grant cannot erase an
  // already reserved generation's read-only recovery path.
  const observationRuntime = async () => {
    await readBootstrapPreparedFile(
      initial.startup.setup.nativeAdmission,
      initial.writableMountRoots,
    );
    const roots = await inspectBootstrapWritableMountRoots(initial.admission);
    if (!isDeepStrictEqual(roots, initial.writableMountRoots))
      throw new BootstrapRequestConflict("Observation tool custody changed");
    return {
      ...initial,
      ports: await createMaintenanceServiceInspectionPorts({
        ...initial.admission,
        writableMountRoots: roots,
      }),
    };
  };
  const load = async (request: MaintenanceServiceJob, observation = false) => {
    const { startup, ...runtime } = await (observation ? observationRuntime() : refresh());
    const { writableMountRoots } = runtime;
    const retained = requireCurrentServiceRequest(journal, request);
    const planFile = path.join(
      startup.setup.installationRoot,
      "maintenance-services",
      retained.target,
      "plans",
      `${retained.proposal.planSha256}.json`,
    );
    await assertBootstrapPathsProtected([planFile, stateDirectory], writableMountRoots);
    const plan: unknown = JSON.parse((await readProtectedDocument(planFile)).toString("utf8"));
    requireCurrentServiceRequest(journal, request);
    return { plan, ...runtime };
  };
  const inspectExecutor = async (context: Awaited<ReturnType<typeof load>>) => {
    const current = await inspectSelectedMaintenanceExecutor({
      ...context,
      setupFile: context.resolved.executorSetupFile,
      expectedTarget: executorTarget,
    });
    await verifySelectedServiceRunner({
      directory: current.startup.selected.directory,
      writableMountRoots: context.writableMountRoots,
      recoveryAccess: executorTarget === "recovery-launcher",
    });
    current.assertCurrent();
    return current;
  };
  const observe: MaintenanceServiceExecutor["observe"] = async (request, reservation) => {
    const context = await load(request, true);
    const observationInput = {
      ...context,
      requestId: request.id,
      reservation,
      reader: context.ports.reader,
      readObservation: (signal: AbortSignal) =>
        inspectMaintenanceServiceReadiness({
          ...context,
          requestId: request.id,
          signal,
        }),
    };
    const consumed = requireCurrentServiceRequest(journal, request);
    if (consumed.effectIntent) {
      const effect =
        consumed.operation === "replacement"
          ? inspectRetainedMaintenanceServiceEffect({ ...observationInput, retained: consumed })
          : inspectRetainedMaintenanceRecoveryEffect({ ...observationInput, retained: consumed });
      const identity = "identity" in effect ? effect.identity : effect.plan.identity;
      if (identity.environment !== "host")
        throw new BootstrapRequestConflict("Consumed observation requires enrolled Host custody");
      if (
        inspectMaintenanceServicePresence(`${identity.serviceDomain}/${identity.serviceLabel}`) ===
        "absent"
      ) {
        // Counter-role discovery also hashes runtime files. The exact child must
        // be gone before any new artifact reader can disturb its native inventory.
        await verifyRetainedProcessExited(context.ports.reader, effect.intent.executor);
        return readBoundedMaintenanceInspection(
          async (signal) => {
            requireCurrentServiceRequest(journal, request);
            const target =
              request.target === "maintenance-controller"
                ? "recovery-launcher"
                : "maintenance-controller";
            const resolved = await resolveNativeMaintenanceRoleSetup({ ...input, target });
            signal.throwIfAborted();
            const counter = await inspectSelectedMaintenanceExecutor({
              ...context,
              setupFile: resolved.executorSetupFile,
              expectedTarget: target,
            });
            const coordinatorCustody = await inspectMaintenanceCoordinatorWitness({
              ...context,
              installationId: input.installationId,
            });
            signal.throwIfAborted();
            requireCurrentServiceRequest(journal, request);
            return observeConsumedMaintenanceServiceAbsence({
              ...context,
              request,
              reader: context.ports.reader,
              currentBoot: maintenanceRecoveryBootWitness(counter),
              coordinatorCustody,
              signal,
            });
          },
          { timeoutMs: 30_000, detail: "Consumed native absence inspection timed out" },
        );
      }
    }
    if (request.operation === "replacement")
      return observeMaintenanceServiceReplacement(observationInput);
    const retained = requireCurrentServiceRequest(journal, request);
    if (!retained.effectIntent) {
      if (!retained.reservation || !isDeepStrictEqual(retained.reservation, reservation))
        throw new BootstrapRequestConflict("Unclaimed observation reservation changed");
      await verifyRecordedMaintenanceChildExited({
        requestId: request.id,
        generation: retained.reservation.generation,
        stateDirectory,
        reader: context.ports.reader,
      });
      requireCurrentServiceRequest(journal, request);
    }
    return observeMaintenanceRecovery({
      ...observationInput,
      readUnclaimedEvidence: async (signal) => {
        // This is absence observation, not a new-effect admission. Revocation
        // preserves it; missing live boot custody remains uncertainty.
        const fresh = await load(request);
        const current = await inspectExecutor(fresh);
        const coordinatorCustody = await inspectMaintenanceCoordinatorWitness({
          ...fresh,
          installationId: input.installationId,
        });
        signal.throwIfAborted();
        return inspectMaintenanceTargetEvidence({
          ...fresh,
          request,
          reader: fresh.ports.reader,
          coordinatorCustody,
          currentBoot: maintenanceRecoveryBootWitness(current),
          signal,
        });
      },
    });
  };
  const requireSupportedEffect = (request: MaintenanceServiceJob) => {
    if (
      executorTarget === "recovery-launcher" &&
      (request.operation === "replacement" ||
        request.target !== "maintenance-controller" ||
        !request.proposal.recoveryOf)
    )
      throw new BootstrapRequestConflict(
        "Recovery page execution requires linked controller recovery or rollback",
      );
  };
  return {
    ...(executorTarget === "recovery-launcher"
      ? { operations: ["recovery", "rollback"] as const }
      : {}),
    inspect: async (request) => {
      requireSupportedEffect(request);
      const context = await load(request);
      const current = await inspectExecutor(context);
      const target = await readBoundedMaintenanceInspection(
        async (signal) => {
          const coordinatorCustody =
            request.operation === "replacement"
              ? undefined
              : await inspectMaintenanceCoordinatorWitness({
                  ...context,
                  installationId: input.installationId,
                });
          signal.throwIfAborted();
          return inspectMaintenanceTargetEvidence({
            ...context,
            request,
            reader: context.ports.reader,
            currentBoot: maintenanceRecoveryBootWitness(current),
            coordinatorCustody,
            signal,
          });
        },
        { timeoutMs: 10_000, detail: "Native maintenance evidence inspection timed out" },
      );
      requireCurrentServiceRequest(journal, request);
      return bindMaintenanceExecutorEvidence(target, current);
    },
    observe,
    execute: async (request, reservation) => {
      requireSupportedEffect(request);
      const deadline = Date.now() + invocationDeadlineMs;
      // The existing queue durably reserves before calling execute and reopens
      // reservations as observation-only. This set also rejects concurrent calls
      // in one consumer before the child has persisted its exclusive intent.
      const key = `${request.id}:${reservation.generation}`;
      if (attempted.has(key))
        throw new BootstrapRequestConflict(
          "Native service launch is already attempted; observe its retained generation",
        );
      attempted.add(key);
      return withinMaintenanceExecutionDeadline(deadline, async (assertWithinDeadline) => {
        const context = await load(request);
        inspectMaintenanceServiceInvocation(
          [request.id, reservation.requestRevision, reservation.generation, reservation.planSha256],
          { ...context, retained: request, reservation },
        );
        const current = await inspectExecutor(context);
        requireReservedMaintenanceExecutor(request, current.executor);
        const roots = await inspectBootstrapWritableMountRoots(context.admission);
        if (!isDeepStrictEqual(roots, context.writableMountRoots))
          throw new BootstrapRequestConflict("Native executor mount custody changed");
        requireCurrentServiceRequest(journal, request);
        current.assertCurrent();
        assertWithinDeadline();
        await launchRetainedMaintenanceService({
          node: current.startup.selected.node.path,
          args: [
            current.startup.selected.entrypoint.path,
            current.startup.selected.setup.path,
            "maintenance-service",
            request.id,
            reservation.requestRevision,
            reservation.generation,
            reservation.planSha256,
          ],
          deadline,
          diagnosticFile: path.join(
            stateDirectory,
            `maintenance-service-${request.id}-${reservation.generation}.stderr`,
          ),
        });
        // Child exit is never a success receipt. Independently inspect the exact
        // retained generation; a child without intent remains unresolved.
        const retained = journal.readLifecycle().find((job) => job.id === request.id);
        assertWithinDeadline();
        const observation = await observe(MaintenanceServiceJobSchema.parse(retained), reservation);
        assertWithinDeadline();
        return observation;
      });
    },
  };
}

/** The single total budget covers validation, child exit and observation.
 * Timeout discards late results; the guarded launch boundary prevents a late
 * validation result from starting a child. It never signals an existing child. */
export async function withinMaintenanceExecutionDeadline<T>(
  deadline: number,
  run: (assertWithinDeadline: () => void) => Promise<T>,
): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const assertWithinDeadline = () => {
    if (expired || Date.now() >= deadline)
      throw new BootstrapRequestConflict("Native service execution deadline elapsed; observe only");
  };
  assertWithinDeadline();
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => run(assertWithinDeadline))
        .then((result) => {
          assertWithinDeadline();
          return result;
        }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            expired = true;
            reject(
              new BootstrapRequestConflict(
                "Native service execution deadline elapsed; observe only",
              ),
            );
          },
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}

function requireCurrentServiceRequest(
  journal: FileBootstrapRequestJournal,
  request: MaintenanceServiceJob,
) {
  const parsed = MaintenanceServiceJobSchema.parse(request);
  const matches = journal.readLifecycle().filter((job) => job.id === parsed.id);
  if (matches.length !== 1 || !isDeepStrictEqual(matches[0], parsed))
    throw new BootstrapRequestConflict(
      "Native service request changed before observation or launch",
    );
  return parsed;
}

/** Diagnostics only add a conservative refusal before artifact collection.
 * PID absence removes that refusal; full native absence and the locked claim
 * fence remain mandatory. A missing entry is not proof that no child exists. */
export async function verifyRecordedMaintenanceChildExited(input: {
  requestId: string;
  generation: string;
  stateDirectory: string;
  reader: { verifyProcessExited(pid: number): Promise<void> };
}): Promise<void> {
  const requestId = z.string().uuid().parse(input.requestId);
  const generation = z.string().uuid().parse(input.generation);
  const file = path.join(
    input.stateDirectory,
    `maintenance-service-${requestId}-${generation}.stderr`,
  );
  let bytes: Buffer;
  try {
    bytes = await readProtectedDocument(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const child = z.strictObject({
    phase: z.literal("child-entry"),
    pid: z.number().int().min(2).max(2147483647),
    at: z.iso.datetime(),
  });
  const launch = z.strictObject({ phase: z.literal("launch-attempt"), at: z.iso.datetime() });
  const entries: number[] = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    // The same descriptor carries ordinary text verification and error lines.
    // Structured diagnostic records must still parse exactly.
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new BootstrapRequestConflict(
        "Native child diagnostic is incomplete; defer observation",
      );
    }
    const parsed = z.union([child, launch]).safeParse(value);
    if (!parsed.success)
      throw new BootstrapRequestConflict("Native child diagnostic is malformed; defer observation");
    if (parsed.data.phase === "child-entry") entries.push(parsed.data.pid);
  }
  if (entries.length > 1)
    throw new BootstrapRequestConflict("Native child diagnostic is ambiguous; defer observation");
  if (entries.length === 1) await input.reader.verifyProcessExited(entries[0]!);
}

/** One launch, no retry or signal. A lost reply, nonzero exit or elapsed bound
 * leaves the queue's reservation intact and must be reconciled by observation. */
export function launchRetainedMaintenanceService(
  input: { node: string; args: readonly string[]; deadline: number; diagnosticFile?: string },
  closeDiagnostic: (descriptor: number) => void = closeSync,
): Promise<void> {
  if (Date.now() >= input.deadline)
    return Promise.reject(new BootstrapRequestConflict("Native service launch deadline elapsed"));
  return new Promise((resolve, reject) => {
    // The queue and child own authority. This exclusive private file records
    // preclaim refusals that would otherwise disappear with the detached child.
    const diagnostic = input.diagnosticFile
      ? openSync(
          input.diagnosticFile,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        )
      : undefined;
    let closeFailed = false;
    const closeParentDiagnostic = () => {
      if (diagnostic === undefined) return;
      try {
        closeDiagnostic(diagnostic);
      } catch {
        closeFailed = true;
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      if (Date.now() >= input.deadline)
        throw new BootstrapRequestConflict("Native service launch deadline elapsed");
      if (diagnostic !== undefined)
        writeSync(
          diagnostic,
          JSON.stringify({ phase: "launch-attempt", at: new Date().toISOString() }) + "\n",
        );
      child = spawn(input.node, [...input.args], {
        detached: true,
        stdio: ["ignore", "ignore", diagnostic ?? "ignore"],
        env: { PATH: "/usr/bin:/bin" },
      });
    } catch (error) {
      closeParentDiagnostic();
      reject(error);
      return;
    }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      if (error) reject(error);
      else if (closeFailed)
        reject(
          new BootstrapRequestConflict("Native service diagnostic cleanup failed; observe only"),
        );
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          new BootstrapRequestConflict("Native service launch outcome is uncertain; observe only"),
        ),
      Math.max(1, input.deadline - Date.now()),
    );
    child.once("error", () =>
      finish(
        new BootstrapRequestConflict("Native service launch outcome is uncertain; observe only"),
      ),
    );
    child.once("exit", (code) =>
      finish(
        code === 0
          ? undefined
          : new BootstrapRequestConflict(
              "Native service child did not verify completion; observe only",
            ),
      ),
    );
    closeParentDiagnostic();
  });
}

/** The server supplies only its existing InstallationConfig.public.installationId
 * and InstallationConfig.stateDir. No job, request body or caller digest chooses
 * a runtime. The existing enrollment descriptor and selection supply the path.
 * Paused/revoked grants remain readable; this function grants no effects. */
export async function resolveNativeMaintenanceExecutorSetup(input: {
  installationId: string;
  stateDirectory: string;
}) {
  return resolveNativeMaintenanceRoleSetup({ ...input, target: "maintenance-controller" });
}

/** Explicit role discovery does not choose a fallback executor or authorize
 * effects. Recovery admission must separately bind this role's native proof. */
export async function resolveNativeMaintenanceRoleSetup(input: {
  installationId: string;
  stateDirectory: string;
  target: "maintenance-controller" | "recovery-launcher";
}) {
  const journal = new FileEnrollmentJournal(input.stateDirectory);
  const state = journal.read();
  if (state.status !== "enrolled" || state.grant.manifest.installationId !== input.installationId)
    throw new BootstrapRequestConflict(
      "Configured installation has no matching maintenance enrollment",
    );
  const target = state.grant.manifest.targets.find((entry) => entry.target === input.target);
  if (!target) throw new BootstrapRequestConflict("Maintenance role is not enrolled");
  const identity = readEnrollmentNativeIdentity(input.stateDirectory, target.identitySha256);
  if (
    identity.environment !== "host" ||
    identity.target !== input.target ||
    identity.installationId !== input.installationId ||
    !identity.selectionPath
  )
    throw new BootstrapRequestConflict(
      "Maintenance role descriptor differs from configured installation",
    );
  const base = path.join(identity.installationRoot, "maintenance-services", input.target);
  if (identity.selectionPath !== path.join(base, "selection.json"))
    throw new BootstrapRequestConflict("Maintenance role selector is outside canonical custody");
  const selection = z
    .union([
      MaintenanceLauncherSelectionSchema,
      MaintenanceServiceSelectionSchema,
      MaintenanceRecoverySelectionSchema,
    ])
    .parse(JSON.parse((await readProtectedDocument(identity.selectionPath)).toString("utf8")));
  const owner = userInfo();
  const account = { uid: owner.uid, home: owner.homedir };
  const value: unknown = JSON.parse(
    (
      await readProtectedDocument(path.join(base, "plans", `${selection.planSha256}.json`))
    ).toString("utf8"),
  );
  const native = inspectSelectedMaintenancePlan({ value, selection, account });
  const { selected, identity: nativeIdentity } = native;
  if (
    !selected ||
    native.planSha256 !== selection.planSha256 ||
    !isDeepStrictEqual(nativeIdentity, identity)
  )
    throw new BootstrapRequestConflict("Maintenance role selection differs from its retained plan");
  const startup = await readMaintenanceLauncherStartup({
    setupFile: selected.setup.path,
    account,
  });
  if (
    startup.setup.enrollmentStateDirectory !== input.stateDirectory ||
    startup.setup.target !== input.target ||
    startup.planSha256 !== selection.planSha256 ||
    !isDeepStrictEqual(startup.selection, selection) ||
    !isDeepStrictEqual(startup.selected, selected) ||
    !isDeepStrictEqual(state, journal.read())
  )
    throw new BootstrapRequestConflict("Maintenance role registration changed during resolution");
  // Fresh external discovery must not open runtime artifacts while the exact
  // selected recovery is still running. Candidate startup uses its own verifier.
  if ("recoveryPlan" in startup && startup.job.status === "running")
    throw new BootstrapRequestConflict("Selected maintenance recovery is still being reconciled");
  return {
    installationId: input.installationId,
    stateDirectory: input.stateDirectory,
    executorSetupFile: selected.setup.path,
  };
}

interface SelectedMaintenancePlanInput {
  value: unknown;
  selection:
    | z.infer<typeof MaintenanceLauncherSelectionSchema>
    | z.infer<typeof MaintenanceServiceSelectionSchema>
    | z.infer<typeof MaintenanceRecoverySelectionSchema>;
  account: { uid: number; home: string };
}

function inspectSelectedMaintenancePlan(input: SelectedMaintenancePlanInput) {
  const { value, selection, account } = input;
  if (selection.version === 3) {
    const recovery = inspectMaintenanceRecoveryPlan(value, account);
    if (recovery.slot !== selection.slot)
      throw new BootstrapRequestConflict(
        "Maintenance recovery selector differs from its reviewed slot",
      );
    return recovery;
  }
  const native = inspectMaintenanceLauncherPlan(value, account);
  return {
    planSha256: native.planSha256,
    identity: native.plan.identity,
    selected: native.plan[selection.slot],
  };
}
