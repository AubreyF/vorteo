import { userInfo } from "node:os";
import { resolveNativeMaintenanceExecutorSetup } from "./coordinator-bootstrap-maintenance-service-producer.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import { readBootstrapPreparedFile } from "./coordinator-bootstrap-artifact.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import { createMaintenanceServiceInspectionPorts } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import { inspectSelectedMaintenanceExecutor } from "./coordinator-bootstrap-maintenance-executor-evidence.js";
import { readRegisteredMaintenanceRuntimeReadiness } from "./coordinator-bootstrap-maintenance-service-status.js";
import type { EnrollmentServiceObservation } from "./maintenance/status.js";

/** Read-only health from configured registration, native custody and the exact
 * process-owned listener. No grant authority or lifecycle request is needed.
 * Launcher is deliberately omitted until its native readiness role exists. */
export async function observeNativeMaintenanceServices(input: {
  installationId: string;
  stateDirectory: string;
  signal: AbortSignal;
}): Promise<EnrollmentServiceObservation[]> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([readNativeMaintenanceHealth({ ...input, signal }), stopped]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function readNativeMaintenanceHealth(input: {
  installationId: string;
  stateDirectory: string;
  signal: AbortSignal;
}): Promise<EnrollmentServiceObservation[]> {
  const resolved = await resolveNativeMaintenanceExecutorSetup(input);
  input.signal.throwIfAborted();
  const owner = userInfo();
  const account = { uid: owner.uid, home: owner.homedir };
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
  input.signal.throwIfAborted();
  const ports = await createMaintenanceServiceInspectionPorts({ ...admission, writableMountRoots });
  const current = await inspectSelectedMaintenanceExecutor({
    ...input,
    setupFile: resolved.executorSetupFile,
    account,
    writableMountRoots,
    ports,
  });
  input.signal.throwIfAborted();
  const { executor } = current;
  const health = await readRegisteredMaintenanceRuntimeReadiness({
    installationRoot: current.startup.setup.installationRoot,
    writableMountRoots,
    expected: {
      installationId: input.installationId,
      target: executor.target,
      identitySha256: executor.identitySha256,
      sourceCommit: executor.sourceCommit,
      artifactSha256: executor.artifactSha256,
      process: executor.native.process,
    },
    signal: input.signal,
    assertCurrent: current.assertCurrent,
  });
  health.assertCurrent();
  input.signal.throwIfAborted();
  return [
    {
      target: executor.target,
      identitySha256: executor.identitySha256,
      readiness: health.ready ? "ready" : "blocked",
      reason: health.ready
        ? "Native service and current runtime readiness verified."
        : "The verified native runtime is not ready.",
      observedAt: new Date().toISOString(),
      selectedSource: executor.sourceCommit,
    },
  ];
}
