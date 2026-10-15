import path from "node:path";
import { z } from "zod";
import { FileEnrollmentJournal } from "./maintenance/authorization.js";
import { readEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import {
  MaintenanceLauncherSelectionSchema,
  MaintenanceServiceSelectionSchema,
} from "./coordinator-bootstrap-maintenance-selection.js";
import {
  inspectMaintenanceLauncherPlan,
  verifyMaintenanceLauncherArtifacts,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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
import { inspectMaintenanceServiceExecution } from "./coordinator-bootstrap-maintenance-service-binding.js";
import {
  createMaintenanceServiceInspectionPorts,
  inspectMaintenanceServiceNative,
  inspectMaintenanceServiceReadiness,
} from "./coordinator-bootstrap-maintenance-service-inspection.js";
import { observeMaintenanceServiceReplacement } from "./coordinator-bootstrap-maintenance-service-native.js";
import type { MaintenanceServiceExecutor } from "./maintenance/service-execution.js";

import {
  inspectSelectedMaintenanceExecutor,
  bindMaintenanceExecutorEvidence,
  requireReservedMaintenanceExecutor,
} from "./coordinator-bootstrap-maintenance-executor-evidence.js";

const invocationDeadlineMs = 25_000;

/** Construction is read-only. The selected, protected runtime must contain this
 * exact runner implementation. Enrollment policy is checked at effect claim,
 * not here, so revocation never removes retained observation support. */
export async function createNativeMaintenanceServiceExecutor(input: {
  executorSetupFile: string;
  installationId: string;
  stateDirectory: string;
}): Promise<MaintenanceServiceExecutor> {
  const owner = userInfo();
  const account = { uid: owner.uid, home: owner.homedir };
  // Construction verifies discovery, but every operation resolves again. A
  // compatible controller replacement must not require restarting this consumer.
  const stateDirectory = input.stateDirectory;
  const journal = new FileBootstrapRequestJournal(stateDirectory);
  const attempted = new Set<string>();
  const refresh = async () => {
    const resolved = await resolveNativeMaintenanceExecutorSetup(input);
    const startup = await readMaintenanceLauncherStartup({
      setupFile: resolved.executorSetupFile,
      account,
    });
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
    await verifySelectedServiceRunner(startup.selected.directory, writableMountRoots);
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
    });
    await verifySelectedServiceRunner(
      current.startup.selected.directory,
      context.writableMountRoots,
    );
    current.assertCurrent();
    return current;
  };
  const observe: MaintenanceServiceExecutor["observe"] = async (request, reservation) => {
    const context = await load(request, true);
    return observeMaintenanceServiceReplacement({
      ...context,
      requestId: request.id,
      reservation,
      reader: context.ports.reader,
      readObservation: (signal) =>
        inspectMaintenanceServiceReadiness({
          ...context,
          requestId: request.id,
          signal,
        }),
    });
  };
  return {
    inspect: async (request) => {
      const context = await load(request);
      const current = await inspectExecutor(context);
      const target = await inspectMaintenanceServiceNative({
        ...context,
        request,
      });
      requireCurrentServiceRequest(journal, request);
      return bindMaintenanceExecutorEvidence(target, current);
    },
    observe,
    execute: async (request, reservation) => {
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
        inspectMaintenanceServiceExecution({
          ...context,
          retained: request,
          reservation,
        });
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

async function verifySelectedServiceRunner(directory: string, roots: readonly string[]) {
  for (const name of [
    "coordinator-bootstrap-runner.js",
    "coordinator-bootstrap-maintenance-service-runner.js",
  ]) {
    const local = await readProtectedDocument(fileURLToPath(new URL(name, import.meta.url)));
    const sha256 = createHash("sha256").update(local).digest("hex");
    await readBootstrapPreparedFile(
      {
        path: path.join(
          directory,
          "packages/server/dist/server/server/execution-installation",
          name,
        ),
        sha256,
      },
      roots,
    );
  }
}

/** One launch, no retry or signal. A lost reply, nonzero exit or elapsed bound
 * leaves the queue's reservation intact and must be reconciled by observation. */
export function launchRetainedMaintenanceService(input: {
  node: string;
  args: readonly string[];
  deadline: number;
}): Promise<void> {
  if (Date.now() >= input.deadline)
    return Promise.reject(new BootstrapRequestConflict("Native service launch deadline elapsed"));
  return new Promise((resolve, reject) => {
    const child = spawn(input.node, [...input.args], {
      detached: true,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    });
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.unref();
      if (error) reject(error);
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
  const journal = new FileEnrollmentJournal(input.stateDirectory);
  const state = journal.read();
  if (state.status !== "enrolled" || state.grant.manifest.installationId !== input.installationId)
    throw new BootstrapRequestConflict(
      "Configured installation has no matching maintenance enrollment",
    );
  const target = state.grant.manifest.targets.find(
    (entry) => entry.target === "maintenance-controller",
  );
  if (!target) throw new BootstrapRequestConflict("Maintenance controller is not enrolled");
  const identity = readEnrollmentNativeIdentity(input.stateDirectory, target.identitySha256);
  if (
    identity.environment !== "host" ||
    identity.target !== "maintenance-controller" ||
    identity.installationId !== input.installationId ||
    !identity.selectionPath
  )
    throw new BootstrapRequestConflict(
      "Maintenance controller descriptor differs from configured installation",
    );
  const base = path.join(
    identity.installationRoot,
    "maintenance-services",
    "maintenance-controller",
  );
  if (identity.selectionPath !== path.join(base, "selection.json"))
    throw new BootstrapRequestConflict(
      "Maintenance controller selector is outside canonical custody",
    );
  const selection = z
    .union([MaintenanceLauncherSelectionSchema, MaintenanceServiceSelectionSchema])
    .parse(JSON.parse((await readProtectedDocument(identity.selectionPath)).toString("utf8")));
  const owner = userInfo();
  const account = { uid: owner.uid, home: owner.homedir };
  const native = inspectMaintenanceLauncherPlan(
    JSON.parse(
      (
        await readProtectedDocument(path.join(base, "plans", `${selection.planSha256}.json`))
      ).toString("utf8"),
    ),
    account,
  );
  const selected = native.plan[selection.slot];
  if (
    !selected ||
    native.planSha256 !== selection.planSha256 ||
    !isDeepStrictEqual(native.plan.identity, identity)
  )
    throw new BootstrapRequestConflict(
      "Maintenance controller selection differs from its retained plan",
    );
  const startup = await readMaintenanceLauncherStartup({
    setupFile: selected.setup.path,
    account,
  });
  if (
    startup.setup.enrollmentStateDirectory !== input.stateDirectory ||
    startup.setup.target !== "maintenance-controller" ||
    !isDeepStrictEqual(startup.selected, selected) ||
    !isDeepStrictEqual(state, journal.read())
  )
    throw new BootstrapRequestConflict(
      "Maintenance controller registration changed during resolution",
    );
  return {
    installationId: input.installationId,
    stateDirectory: input.stateDirectory,
    executorSetupFile: selected.setup.path,
  };
}
