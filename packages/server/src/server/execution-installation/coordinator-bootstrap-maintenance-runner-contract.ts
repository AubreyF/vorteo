import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { MaintenanceServiceJob } from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  readProtectedDocument,
  readBootstrapPreparedFile,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import {
  inspectMaintenanceLauncherPlan,
  verifyMaintenanceLauncherArtifacts,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import {
  MaintenanceRecoveryPlanSchema,
  inspectMaintenanceRecoveryPlan,
} from "./coordinator-bootstrap-maintenance-recovery-plan.js";
import { MaintenanceLauncherSetupSchema } from "./coordinator-bootstrap-maintenance-setup.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import { requireUnclaimedMaintenanceExecutor } from "./maintenance/service-recovery.js";
import {
  recoveryAccessModule,
  selectedServiceRunnerModules,
  unclaimedExecutorModules,
} from "./coordinator-bootstrap-runner-modules.js";

export async function verifySelectedServiceRunner(input: {
  directory: string;
  writableMountRoots: readonly string[];
  recoveryAccess: boolean;
}) {
  const files: string[] = [...selectedServiceRunnerModules];
  if (input.recoveryAccess) files.push(recoveryAccessModule);
  for (const name of files) {
    const local = await readProtectedDocument(fileURLToPath(new URL(name, import.meta.url)));
    const sha256 = createHash("sha256").update(local).digest("hex");
    await readBootstrapPreparedFile(
      {
        path: path.join(
          input.directory,
          "packages/server/dist/server/server/execution-installation",
          name,
        ),
        sha256,
      },
      input.writableMountRoots,
    );
  }
}

/** A delayed child belongs to the reserved runtime, not today's selected role.
 * Exact known claim code and protected reviewed artifacts make terminal status
 * an effective fence. Unknown older implementations remain unresolved. */
export async function verifyUnclaimedMaintenanceExecutor(input: {
  job: MaintenanceServiceJob;
  stateDirectory: string;
  account: { uid: number; home: string };
  writableMountRoots?: readonly string[];
  signal: AbortSignal;
}) {
  const executor = requireUnclaimedMaintenanceExecutor(input.job);
  const assertSetup = retainServiceFiles([executor.setup.path]);
  const setupBytes = await readBootstrapPreparedFile(
    executor.setup,
    input.writableMountRoots ?? [],
  );
  assertSetup();
  const setup = MaintenanceLauncherSetupSchema.parse(JSON.parse(setupBytes.toString("utf8")));
  if (
    !isDeepStrictEqual(
      [setup.enrollmentStateDirectory, setup.target, setup.sourceCommit, setup.identitySha256],
      [input.stateDirectory, executor.target, executor.sourceCommit, executor.identitySha256],
    ) ||
    (executor.target === "recovery-launcher" &&
      setup.control?.recoveryAccess?.serviceExecutorVersion !== 1)
  )
    throw new BootstrapRequestConflict("Unclaimed reserved runner setup is incompatible");
  const assertAdmission = retainServiceFiles([setup.nativeAdmission.path]);
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse((await readBootstrapPreparedFile(setup.nativeAdmission, [])).toString("utf8")),
  );
  assertAdmission();
  const writableMountRoots = await inspectBootstrapWritableMountRoots(admission);
  if (input.writableMountRoots && !isDeepStrictEqual(input.writableMountRoots, writableMountRoots))
    throw new BootstrapRequestConflict("Unclaimed reserved runner mount custody changed");
  const roots = { ...input, writableMountRoots };
  const planFile = path.join(
    setup.installationRoot,
    "maintenance-services",
    executor.target,
    "plans",
    `${executor.planSha256}.json`,
  );
  await assertBootstrapPathsProtected(
    [planFile, executor.runtimeDirectory, executor.setup.path],
    writableMountRoots,
  );
  const assertPlan = retainServiceFiles([planFile]);
  const value: unknown = JSON.parse((await readProtectedDocument(planFile)).toString("utf8"));
  assertPlan();
  const recovery = MaintenanceRecoveryPlanSchema.safeParse(value);
  const inspected = recovery.success
    ? inspectMaintenanceRecoveryPlan(recovery.data, input.account)
    : inspectMaintenanceLauncherPlan(value, input.account);
  const plan = "predecessor" in inspected ? inspected.predecessor.plan : inspected.plan;
  const slot = [plan.previous, plan.candidate].find(
    (item) =>
      item &&
      item.directory === executor.runtimeDirectory &&
      item.sourceCommit === executor.sourceCommit &&
      item.artifactSha256 === executor.artifactSha256 &&
      isDeepStrictEqual(item.setup, executor.setup) &&
      isDeepStrictEqual(item.node, executor.node) &&
      isDeepStrictEqual(item.entrypoint, executor.entrypoint),
  );
  if (
    inspected.planSha256 !== executor.planSha256 ||
    inspected.identitySha256 !== executor.identitySha256 ||
    plan.identity.installationId !== input.job.proposal.installationId ||
    !slot
  )
    throw new BootstrapRequestConflict("Unclaimed reserved runner differs from its retained plan");
  const names: string[] = [...unclaimedExecutorModules];
  if (executor.target === "recovery-launcher") names.push(recoveryAccessModule);
  const directory = path.join(
    executor.runtimeDirectory,
    "packages/server/dist/server/server/execution-installation",
  );
  const assertFiles = retainServiceFiles([
    planFile,
    executor.setup.path,
    executor.node.path,
    executor.entrypoint.path,
    setup.nativeAdmission.path,
    ...(executor.target === "recovery-launcher"
      ? [path.join(executor.runtimeDirectory, "packages/server/package.json")]
      : []),
    ...names.map((name) => path.join(directory, name)),
  ]);
  for (const name of names) {
    input.signal.throwIfAborted();
    const bytes = await readProtectedDocument(fileURLToPath(new URL(name, import.meta.url)));
    await readBootstrapPreparedFile(
      {
        path: path.join(directory, name),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      writableMountRoots,
    );
  }
  await verifyMaintenanceLauncherArtifacts({ ...roots, plan });
  const assertCurrent = () => {
    input.signal.throwIfAborted();
    assertSetup();
    assertAdmission();
    assertPlan();
    assertFiles();
  };
  assertCurrent();
  return { assertCurrent };
}
