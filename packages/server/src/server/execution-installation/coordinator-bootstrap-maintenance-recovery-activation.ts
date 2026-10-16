import path from "node:path";
import { userInfo } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { constants, openSync, closeSync, writeFileSync, fsyncSync, lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";
import { readPrivateBootstrapConfiguration } from "./coordinator-bootstrap-private-configuration.js";
import {
  readProtectedDocument,
  readBootstrapPreparedFile,
} from "./coordinator-bootstrap-artifact.js";
import { MaintenanceLauncherSetupSchema } from "./coordinator-bootstrap-maintenance-setup.js";
import {
  MaintenanceLauncherPlanSchema,
  inspectMaintenanceLauncherPlan,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { MaintenanceLauncherIntentSchema } from "./coordinator-bootstrap-maintenance-selection.js";
import {
  activateMaintenanceRecoveryAccess,
  observeMaintenanceRecoveryAccessRegistration,
  type RecoveryRegistrationInput,
  type RecoveryRegistrationPorts,
} from "./coordinator-bootstrap-maintenance-recovery-registration.js";
import {
  FileEnrollmentJournal,
  observeActivationStep,
  reconcileActivationStep,
} from "./maintenance/authorization.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { createMaintenanceChildCustody } from "./coordinator-bootstrap-maintenance-child-custody.js";
import { createNativeRecoveryRegistrationPorts } from "./coordinator-bootstrap-maintenance-recovery-native-ports.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import {
  withinMaintenanceExecutionDeadline,
  resolveNativeMaintenanceExecutorSetup,
} from "./coordinator-bootstrap-maintenance-service-producer.js";
import { inspectSelectedMaintenanceExecutor } from "./coordinator-bootstrap-maintenance-executor-evidence.js";
import { createMaintenanceServiceInspectionPorts } from "./coordinator-bootstrap-maintenance-service-inspection.js";

const InvocationSchema = z.tuple([
  z.string().uuid(),
  z.string().uuid(),
  z.string().uuid(),
  z.string().uuid(),
]);
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/** Identifiers select an already reserved enrollment generation. They cannot
 * supply a plan, replacement source, native command or another installation. */
export function inspectRecoveryActivationInvocation(args: readonly string[]) {
  const [grantId, grantRevision, stepId, generation] = InvocationSchema.parse(args);
  return { grantId, grantRevision, stepId, generation };
}

function requireActivationBinding(input: RecoveryRegistrationInput) {
  const journal = new FileEnrollmentJournal(input.enrollmentStateDirectory);
  // This helper is also called from the journal's transaction. No nested lock.
  const state = journal.readPolicySnapshot();
  if (state.status !== "enrolled") throw new BootstrapRequestConflict("Recovery is not enrolled");
  const inspected = inspectMaintenanceLauncherPlan(input.plan, input.account);
  const step = state.grant.manifest.steps.find((item) => item.id === input.stepId);
  const progress = state.activation.steps.find((item) => item.id === input.stepId);
  const target = state.grant.manifest.targets.find((item) => item.target === "recovery-launcher");
  if (
    state.grant.id !== input.grantId ||
    state.grant.manifest.installationId !== input.plan.identity.installationId ||
    target?.identitySha256 !== inspected.identitySha256 ||
    step?.target !== "recovery-launcher" ||
    step.operation !== "replacement" ||
    step.planSha256 !== inspected.planSha256 ||
    !isDeepStrictEqual(step.candidate, {
      sourceCommit: input.plan.candidate.sourceCommit,
      artifactSha256: input.plan.candidate.artifactSha256,
    }) ||
    step.previous !== null ||
    !progress ||
    progress.status === "pending" ||
    progress.generation !== input.generation ||
    progress.grantRevision !== input.grantRevision
  )
    throw new BootstrapRequestConflict("Recovery invocation differs from its exact activation");
  return progress;
}

function readRetainedIntent(input: RecoveryRegistrationInput) {
  const file = path.join(
    input.enrollmentStateDirectory,
    `maintenance-launcher-${input.stepId}-${input.generation}.json`,
  );
  try {
    lstatSync(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  return {
    file,
    intent: MaintenanceLauncherIntentSchema.parse(
      readPrivateBootstrapConfiguration(file, input.account.uid),
    ),
  };
}

async function retainObservation(directory: string, receipt: unknown) {
  const bytes = JSON.stringify(receipt);
  const sha256 = hash(bytes);
  const file = path.join(directory, `maintenance-observation-${sha256}.json`);
  let fd: number;
  let created = true;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    created = false;
    if (hash((await readProtectedDocument(file)).toString("utf8")) !== sha256)
      throw new BootstrapRequestConflict("Retained recovery observation changed");
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    if (created) writeFileSync(fd, bytes);
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
  if (hash((await readProtectedDocument(file)).toString("utf8")) !== sha256)
    throw new BootstrapRequestConflict("Published recovery observation changed");
  return sha256;
}

/** One invocation, one generation. Any retained intent, including an uncertain
 * command result, enters observation only. Revocation never prevents observation. */
export async function reconcileRecoveryAccessActivation(
  input: RecoveryRegistrationInput,
  ports: RecoveryRegistrationPorts,
) {
  const progress = requireActivationBinding(input);
  const retained = readRetainedIntent(input);
  if (!retained && progress.status !== "reserved")
    throw new BootstrapRequestConflict(
      "Completed recovery activation has no retained effect intent",
    );
  const observation = retained
    ? await observeMaintenanceRecoveryAccessRegistration(input, ports, retained)
    : await activateMaintenanceRecoveryAccess(input, ports);
  const { assertCurrent: assertObservation, ...receipt } = observation;
  const assertCurrent = () => {
    requireActivationBinding(input);
    if (input.assertCurrent() !== undefined || assertObservation() !== undefined)
      throw new BootstrapRequestConflict("Recovery activation custody must remain synchronous");
  };
  assertCurrent();
  const journal = new FileEnrollmentJournal(input.enrollmentStateDirectory);
  if (progress.status === "succeeded") return { ...receipt, activationSettled: true as const };
  const observationSha256 = await retainObservation(input.enrollmentStateDirectory, receipt);
  if (progress.status === "recovery_required")
    reconcileActivationStep(journal, {
      id: observation.intent.id,
      stepId: input.stepId,
      generation: input.generation,
      failedObservationSha256: progress.observationSha256,
      observationSha256,
      assertCurrent,
    });
  else
    observeActivationStep(journal, {
      stepId: input.stepId,
      generation: input.generation,
      outcome: "succeeded",
      observationSha256,
      assertCurrent,
    });
  return { ...receipt, activationSettled: true as const };
}

/** Bounded native role, not a queue consumer. The protected candidate setup and
 * enrollment manifest select every file before any authority is consumed. */
export async function runNativeRecoveryActivation(setupFile: string, args: readonly string[]) {
  return withinMaintenanceExecutionDeadline(Date.now() + 90_000, async (checkDeadline) => {
    const account = userInfo();
    if (process.platform !== "darwin" || account.uid !== process.getuid?.())
      throw new BootstrapRequestConflict("Recovery activation requires native Host custody");
    const invocation = inspectRecoveryActivationInvocation(args);
    const setup = MaintenanceLauncherSetupSchema.parse(
      readPrivateBootstrapConfiguration(setupFile, account.uid),
    );
    const state = new FileEnrollmentJournal(setup.enrollmentStateDirectory).read();
    if (state.status !== "enrolled" || setup.target !== "recovery-launcher")
      throw new BootstrapRequestConflict("Exact initial recovery enrollment is unavailable");
    const step = state.grant.manifest.steps.find((item) => item.id === invocation.stepId);
    if (!step || step.target !== "recovery-launcher")
      throw new BootstrapRequestConflict("Recovery step is not in the retained manifest");
    const planFile = path.join(
      setup.installationRoot,
      "maintenance-services",
      "recovery-launcher",
      "plans",
      `${step.planSha256}.json`,
    );
    const plan = MaintenanceLauncherPlanSchema.parse(
      JSON.parse((await readProtectedDocument(planFile)).toString("utf8")),
    );
    if (
      plan.candidate.setup.path !== setupFile ||
      plan.identity.installationRoot !== setup.installationRoot
    )
      throw new BootstrapRequestConflict("Recovery setup differs from the reviewed candidate");
    const admission = BootstrapAdmissionSetupSchema.parse(
      JSON.parse((await readBootstrapPreparedFile(setup.nativeAdmission, [])).toString("utf8")),
    );
    const writableMountRoots = await inspectBootstrapWritableMountRoots(admission);
    checkDeadline();
    const moduleFile = fileURLToPath(new URL("./coordinator-bootstrap-runner.js", import.meta.url));
    const expectedModule = path.join(
      plan.candidate.directory,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
    );
    if (
      moduleFile !== expectedModule ||
      process.argv[1] !== moduleFile ||
      (await realpath(process.execPath)) !== plan.candidate.node.path
    )
      throw new BootstrapRequestConflict(
        "Recovery activation module is outside its pinned runtime",
      );
    const assertFiles = retainServiceFiles([
      planFile,
      setupFile,
      moduleFile,
      fileURLToPath(import.meta.url),
      setup.nativeAdmission.path,
    ]);
    const reader = await createNativeBootstrapServiceReader({ ...admission, writableMountRoots });
    const processIdentity = BootstrapProcessIdentitySchema.parse(
      await reader.inspectProcess(process.pid),
    );
    const expectedArgs = [
      plan.candidate.node.path,
      moduleFile,
      setupFile,
      "maintenance-recovery-registration",
      ...args,
    ];
    if (processIdentity.argumentsSha256 !== hash(JSON.stringify(expectedArgs)))
      throw new BootstrapRequestConflict("Recovery activation native arguments changed");
    const custody = await createMaintenanceChildCustody({
      expected: processIdentity,
      ...admission,
      writableMountRoots,
    });
    const input = {
      ...invocation,
      plan,
      enrollmentStateDirectory: setup.enrollmentStateDirectory,
      account: { uid: account.uid, home: account.homedir },
      writableMountRoots,
      assertCurrent() {
        checkDeadline();
        assertFiles();
        custody.assertCurrent();
      },
    };
    requireActivationBinding(input);
    const executors = [custody];
    const parent = BootstrapProcessIdentitySchema.parse(await reader.inspectProcess(process.ppid));
    if (parent.executable === plan.candidate.node.path) {
      // Shared runtime files do not make an arbitrary parent safe to exclude.
      // Only the independently selected controller can share this executor node.
      const selected = await resolveNativeMaintenanceExecutorSetup({
        installationId: plan.identity.installationId,
        stateDirectory: setup.enrollmentStateDirectory,
      });
      const inspected = await inspectSelectedMaintenanceExecutor({
        setupFile: selected.executorSetupFile,
        account: input.account,
        stateDirectory: setup.enrollmentStateDirectory,
        writableMountRoots,
        ports: await createMaintenanceServiceInspectionPorts({ ...admission, writableMountRoots }),
      });
      if (!isDeepStrictEqual(parent, inspected.executor.native.process))
        throw new BootstrapRequestConflict(
          "Recovery activation parent is not the selected controller",
        );
      executors.push({ process: parent, assertCurrent: inspected.assertCurrent });
    }
    const ports = await createNativeRecoveryRegistrationPorts(input, executors);
    checkDeadline();
    return reconcileRecoveryAccessActivation(input, ports);
  });
}
