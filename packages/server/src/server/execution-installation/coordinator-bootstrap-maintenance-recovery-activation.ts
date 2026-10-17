import path from "node:path";
import { userInfo } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { constants, openSync, closeSync, writeFileSync, fsyncSync, lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { EnrollmentStep } from "@getpaseo/protocol/installation-enrollment";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  BootstrapRequestConflict,
  assertCoordinatorLifecycleIdle,
  openBootstrapRequests,
} from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { readPrivateBootstrapConfiguration } from "./coordinator-bootstrap-private-configuration.js";
import {
  readProtectedDocument,
  readBootstrapPreparedFile,
} from "./coordinator-bootstrap-artifact.js";
import { MaintenanceLauncherSetupSchema } from "./coordinator-bootstrap-maintenance-setup.js";
import {
  MaintenanceLauncherPlanSchema,
  inspectMaintenanceLauncherPlan,
  verifyMaintenanceLauncherArtifacts,
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
  reserveActivationStep,
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
  launchRetainedMaintenanceService,
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

interface PreparedRecoveryActivation {
  assertCurrent(): void;
  launch(invocation: readonly string[]): Promise<unknown>;
  observe(invocation: readonly string[]): Promise<unknown>;
}

interface RecoveryActivationParentPorts {
  prepare(step: EnrollmentStep): Promise<PreparedRecoveryActivation>;
}

/** Child exit alone never permits coordinator migration. Reopen the addressed
 * enrollment and require this exact generation's verified terminal receipt. */
function requireVerifiedRecovery(input: {
  journal: FileEnrollmentJournal;
  grantId: string;
  manifestSha256: string;
  stepId: string;
  generation: string;
  grantRevision: string;
}) {
  const current = input.journal.read();
  if (current.status !== "enrolled")
    throw new BootstrapRequestConflict("Recovery enrollment disappeared");
  const verified = current.activation.steps.find((item) => item.id === input.stepId);
  if (
    current.grant.id !== input.grantId ||
    current.grant.approval.manifestSha256 !== input.manifestSha256 ||
    verified?.status !== "succeeded" ||
    verified.generation !== input.generation ||
    verified.grantRevision !== input.grantRevision
  )
    throw new BootstrapRequestConflict(
      "Recovery page is not verified before coordinator migration",
    );
}

/** The successful reservation owns the only child launch. Reopening any reserved
 * generation is observation-only, even when the child never created an intent. */
export async function activateRecoveryBeforeCoordinator(
  input: {
    journal: FileEnrollmentJournal;
    manifestSha256: string;
    coordinatorStepId: string;
  },
  ports: RecoveryActivationParentPorts,
) {
  return withinMaintenanceExecutionDeadline(Date.now() + 95_000, async (checkDeadline) => {
    const state = input.journal.read();
    if (
      state.status !== "enrolled" ||
      state.grant.approval.manifestSha256 !== input.manifestSha256 ||
      state.grant.manifest.provisioning?.coordinatorStepId !== input.coordinatorStepId
    )
      throw new BootstrapRequestConflict("Recovery activation belongs to another enrollment");
    const recovery = state.grant.manifest.steps.filter(
      (step) => step.target === "recovery-launcher",
    );
    const coordinator = state.grant.manifest.steps.find(
      (step) => step.id === input.coordinatorStepId,
    );
    const step = recovery[0];
    if (
      recovery.length !== 1 ||
      !step ||
      step.operation !== "replacement" ||
      step.previous !== null ||
      coordinator?.target !== "coordinator" ||
      !coordinator.dependsOn.includes(step.id)
    )
      throw new BootstrapRequestConflict(
        "Coordinator migration requires its initial recovery page",
      );
    const prepared = await ports.prepare(step);
    checkDeadline();
    const initial = state.activation.steps.find((item) => item.id === step.id);
    if (!initial) throw new BootstrapRequestConflict("Recovery activation progress is missing");
    let selected = initial;
    const dispatch = initial.status === "pending";
    if (dispatch) {
      const reserved = reserveActivationStep(input.journal, {
        grantRevision: state.grant.revision,
        stepId: step.id,
        assertCurrent: () => {
          checkDeadline();
          if (prepared.assertCurrent() !== undefined)
            throw new BootstrapRequestConflict("Recovery parent custody must remain synchronous");
        },
      });
      if (reserved.status !== "enrolled")
        throw new BootstrapRequestConflict("Recovery activation reservation disappeared");
      const progress = reserved.activation.steps.find((item) => item.id === step.id);
      if (!progress)
        throw new BootstrapRequestConflict("Recovery activation reservation is missing");
      selected = progress;
    }
    if (selected.status === "pending")
      throw new BootstrapRequestConflict("Recovery activation has no reserved generation");
    const invocation = [state.grant.id, selected.grantRevision, step.id, selected.generation];
    checkDeadline();
    if (dispatch) await prepared.launch(invocation);
    else await prepared.observe(invocation);
    checkDeadline();
    requireVerifiedRecovery({
      journal: input.journal,
      grantId: state.grant.id,
      manifestSha256: input.manifestSha256,
      stepId: step.id,
      generation: selected.generation,
      grantRevision: selected.grantRevision,
    });
  });
}

/** Called only by the already verified enrollment controller. Candidate paths
 * come from the protected manifest and canonical plan, never the owner request. */
export async function activateNativeRecoveryBeforeCoordinator(input: {
  installationRoot: string;
  stateDirectory: string;
  installationId: string;
  manifestSha256: string;
  coordinatorStepId: string;
  verifyParent(): Promise<readonly string[]>;
}) {
  const deadline = Date.now() + 95_000;
  const journal = new FileEnrollmentJournal(input.stateDirectory);
  return activateRecoveryBeforeCoordinator(
    { ...input, journal },
    {
      async prepare(step) {
        const account = userInfo();
        if (process.platform !== "darwin" || account.uid !== process.getuid?.())
          throw new BootstrapRequestConflict("Recovery activation requires native Host custody");
        const writableMountRoots = await input.verifyParent();
        const planFile = path.join(
          input.installationRoot,
          "maintenance-services",
          "recovery-launcher",
          "plans",
          `${step.planSha256}.json`,
        );
        const plan = MaintenanceLauncherPlanSchema.parse(
          JSON.parse((await readProtectedDocument(planFile)).toString("utf8")),
        );
        const inspected = await verifyMaintenanceLauncherArtifacts({
          plan,
          account: { uid: account.uid, home: account.homedir },
          writableMountRoots,
        });
        const setup = MaintenanceLauncherSetupSchema.parse(
          JSON.parse(
            (await readBootstrapPreparedFile(plan.candidate.setup, writableMountRoots)).toString(
              "utf8",
            ),
          ),
        );
        const enrollment = journal.read();
        const targetIdentity =
          enrollment.status === "enrolled"
            ? enrollment.grant.manifest.targets.find(
                (target) => target.target === "recovery-launcher",
              )?.identitySha256
            : undefined;
        if (
          inspected.planSha256 !== step.planSha256 ||
          inspected.identitySha256 !== targetIdentity ||
          step.candidate.sourceCommit !== plan.candidate.sourceCommit ||
          step.candidate.artifactSha256 !== plan.candidate.artifactSha256 ||
          plan.previous !== null ||
          plan.identity.installationId !== input.installationId ||
          plan.identity.installationRoot !== input.installationRoot ||
          setup.installationRoot !== input.installationRoot ||
          setup.enrollmentStateDirectory !== input.stateDirectory ||
          setup.target !== "recovery-launcher" ||
          !setup.control?.recoveryAccess
        )
          throw new BootstrapRequestConflict(
            "Recovery candidate differs from the enrolled installation",
          );
        const runner = path.join(
          plan.candidate.directory,
          "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
        );
        const localRunner = await readProtectedDocument(
          fileURLToPath(new URL("./coordinator-bootstrap-runner.js", import.meta.url)),
        );
        await readBootstrapPreparedFile(
          { path: runner, sha256: hash(localRunner.toString("utf8")) },
          writableMountRoots,
        );
        const admission = BootstrapAdmissionSetupSchema.parse(
          JSON.parse(
            (await readBootstrapPreparedFile(setup.nativeAdmission, writableMountRoots)).toString(
              "utf8",
            ),
          ),
        );
        const reader = await createNativeBootstrapServiceReader({
          ...admission,
          writableMountRoots,
        });
        const custody = await createMaintenanceChildCustody({
          expected: await reader.inspectProcess(process.pid),
          ...admission,
          writableMountRoots,
        });
        const assertFiles = retainServiceFiles([
          planFile,
          plan.candidate.setup.path,
          setup.nativeAdmission.path,
          runner,
          fileURLToPath(import.meta.url),
        ]);
        if (!isDeepStrictEqual(writableMountRoots, await input.verifyParent()))
          throw new BootstrapRequestConflict("Recovery parent mount custody changed");
        const assertCurrent = () => {
          if (Date.now() >= deadline)
            throw new BootstrapRequestConflict("Recovery activation parent deadline elapsed");
          assertFiles();
          custody.assertCurrent();
        };
        const invoke = (
          role: "maintenance-recovery-registration" | "maintenance-recovery-observation",
          invocation: readonly string[],
        ) => {
          assertCurrent();
          const { stepId, generation } = inspectRecoveryActivationInvocation(invocation);
          // Registration is launched once per durable reservation. Repeated
          // read-only reopening must not create an unbounded diagnostic stream.
          const diagnosticFile =
            role === "maintenance-recovery-registration"
              ? path.join(
                  input.stateDirectory,
                  `maintenance-recovery-registration-${stepId}-${generation}-${randomUUID()}.stderr`,
                )
              : undefined;
          return launchRetainedMaintenanceService({
            node: plan.candidate.node.path,
            args: [runner, plan.candidate.setup.path, role, ...invocation],
            deadline,
            diagnosticFile,
          });
        };
        return {
          assertCurrent() {
            assertCurrent();
            const bootstrap = new FileBootstrapRequestJournal(input.stateDirectory);
            if (openBootstrapRequests(bootstrap.read()).length > 0)
              throw new BootstrapRequestConflict(
                "Existing coordinator work must reconcile before recovery activation",
              );
            assertCoordinatorLifecycleIdle(bootstrap.readLifecycle());
          },
          launch: (invocation) => invoke("maintenance-recovery-registration", invocation),
          observe: (invocation) => invoke("maintenance-recovery-observation", invocation),
        };
      },
    },
  );
}

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
  options?: { observationOnly: true },
) {
  const progress = requireActivationBinding(input);
  const retained = readRetainedIntent(input);
  if (!retained && options?.observationOnly)
    throw new BootstrapRequestConflict(
      "Recovery launch is uncertain; no effect intent is available",
    );
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
export async function runNativeRecoveryActivation(
  setupFile: string,
  args: readonly string[],
  options?: { observationOnly: true },
) {
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
      options?.observationOnly
        ? "maintenance-recovery-observation"
        : "maintenance-recovery-registration",
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
    return reconcileRecoveryAccessActivation(input, ports, options);
  });
}
