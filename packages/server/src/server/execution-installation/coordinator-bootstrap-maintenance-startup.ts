import path from "node:path";
import { readMaintenanceRecoverySelection } from "./coordinator-bootstrap-maintenance-recovery-startup.js";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { maintenanceServiceCustodyBinding } from "./coordinator-bootstrap-maintenance-service-binding.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import { z } from "zod";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  readProtectedDocument,
  readBootstrapPreparedFile,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import {
  createNativeBootstrapServiceReader,
  readBootstrapLauncher,
} from "./coordinator-bootstrap-service.js";
import {
  maintenanceUserLauncher,
  verifyMaintenanceLauncherArtifacts,
  verifyMaintenanceLauncherProcess,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { FileEnrollmentJournal } from "./maintenance/authorization.js";
import { readEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import {
  MaintenanceLauncherSelectionSchema,
  MaintenanceServiceSelectionSchema,
  MaintenanceRecoverySelectionSchema,
  inspectMaintenanceServiceSelection,
  inspectMaintenanceLauncherSelection,
  inspectMaintenanceRecoverySelection,
} from "./coordinator-bootstrap-maintenance-selection.js";

import { MaintenanceLauncherSetupSchema } from "./coordinator-bootstrap-maintenance-setup.js";
export { MaintenanceLauncherSetupSchema } from "./coordinator-bootstrap-maintenance-setup.js";

interface StartupInput {
  setupFile: string;
  account: { uid: number; home: string };
}
interface StartupReadPorts {
  readDocument: typeof readProtectedDocument;
}
const startupReadPorts: StartupReadPorts = { readDocument: readProtectedDocument };
type SelectionContext =
  | ReturnType<typeof inspectMaintenanceLauncherSelection>
  | ReturnType<typeof inspectMaintenanceServiceSelection>
  | ReturnType<typeof inspectMaintenanceRecoverySelection>;

function startupCustodyBinding(context: SelectionContext) {
  if ("job" in context) return { ...context, job: maintenanceServiceCustodyBinding(context.job) };
  return context;
}

/** Protected startup loading is observation-only. Native process and artifact
 * verification follow this binding; callers must not dispatch from it alone. */
export async function readMaintenanceLauncherStartup(
  input: StartupInput,
  ports = startupReadPorts,
) {
  return (await readMaintenanceStartupProof(input, ports)).context;
}

/** Retained selection custody only. Native lifetime and dispatch authority
 * require their independent checks. */
export async function readMaintenanceStartupProof(input: StartupInput, ports = startupReadPorts) {
  const assertFiles = [retainServiceFiles([input.setupFile])];
  const read = async (file: string) =>
    JSON.parse((await ports.readDocument(file)).toString("utf8"));
  const setup = MaintenanceLauncherSetupSchema.parse(await read(input.setupFile));
  const identity = readEnrollmentNativeIdentity(
    setup.enrollmentStateDirectory,
    setup.identitySha256,
  );
  if (
    identity.environment !== "host" ||
    identity.target !== setup.target ||
    identity.installationRoot !== setup.installationRoot ||
    identity.custodyOwnerUid !== input.account.uid ||
    !identity.selectionPath
  )
    throw new BootstrapRequestConflict("Launcher setup differs from enrolled native identity");
  assertFiles.push(retainServiceFiles([identity.selectionPath]));
  const selection = z
    .union([
      MaintenanceLauncherSelectionSchema,
      MaintenanceServiceSelectionSchema,
      MaintenanceRecoverySelectionSchema,
    ])
    .parse(await read(identity.selectionPath));
  const base = path.join(setup.installationRoot, "maintenance-services", setup.target);
  if (identity.selectionPath !== path.join(base, "selection.json"))
    throw new BootstrapRequestConflict("Launcher selection path differs from enrolled custody");
  const planFile = path.join(base, "plans", `${selection.planSha256}.json`);
  assertFiles.push(retainServiceFiles([planFile]));
  const intentFile =
    selection.version === 1
      ? path.join(
          setup.enrollmentStateDirectory,
          `maintenance-launcher-${selection.stepId}-${selection.generation}.json`,
        )
      : path.join(setup.enrollmentStateDirectory, "restart-jobs.json");
  const journal = new FileEnrollmentJournal(setup.enrollmentStateDirectory);
  const enrollment = journal.readPolicySnapshot();
  const plan = await read(planFile);
  const readRetained = () => {
    if (selection.version === 1) return undefined;
    const matches = new FileBootstrapRequestJournal(setup.enrollmentStateDirectory)
      .readLifecycle()
      .filter((job) => job.id === selection.requestId);
    if (matches.length !== 1)
      throw new BootstrapRequestConflict("Selected maintenance job is missing or ambiguous");
    return matches[0];
  };
  const retained = readRetained();
  let assertHistoryCurrent: () => void = () => undefined;
  const readContext = async () => {
    const common = { plan, account: input.account, enrollment, retained, selection };
    if (selection.version === 1) {
      assertFiles.push(retainServiceFiles([intentFile]));
      return inspectMaintenanceLauncherSelection({ ...common, intent: await read(intentFile) });
    }
    if (selection.version === 2) return inspectMaintenanceServiceSelection(common);
    const proof = await readMaintenanceRecoverySelection({
      ...common,
      stateDirectory: setup.enrollmentStateDirectory,
    });
    assertHistoryCurrent = proof.assertCurrent;
    return proof.context;
  };
  const context = await readContext();
  if (
    !isDeepStrictEqual(identity, context.plan.identity) ||
    setup.sourceCommit !== context.selected.sourceCommit ||
    input.setupFile !== context.selected.setup.path
  )
    throw new BootstrapRequestConflict("Launcher startup is not the selected reviewed slot");
  if (!isDeepStrictEqual(selection, await read(identity.selectionPath)))
    throw new BootstrapRequestConflict("Launcher selection changed during startup");
  // Revalidate retained selection against fresh enrollment synchronously.
  // Revocation can preserve observation, but never creates effect authority.
  const freshContext = (): SelectionContext => {
    const current = {
      plan,
      account: input.account,
      enrollment: journal.readPolicySnapshot(),
      retained: readRetained(),
      selection,
    };
    if (selection.version === 1)
      return inspectMaintenanceLauncherSelection({ ...current, intent: context.intent });
    if (selection.version === 2) return inspectMaintenanceServiceSelection(current);
    return inspectMaintenanceRecoverySelection(current);
  };
  const latest = freshContext();
  if (!isDeepStrictEqual(startupCustodyBinding(context), startupCustodyBinding(latest)))
    throw new BootstrapRequestConflict("Launcher selection changed during startup");
  const assertCurrent = () => {
    for (const assertFile of assertFiles) assertFile();
    assertHistoryCurrent();
    if (!isDeepStrictEqual(startupCustodyBinding(latest), startupCustodyBinding(freshContext())))
      throw new BootstrapRequestConflict("Launcher selection changed after startup verification");
    if (
      !isDeepStrictEqual(
        identity,
        readEnrollmentNativeIdentity(setup.enrollmentStateDirectory, setup.identitySha256),
      )
    )
      throw new BootstrapRequestConflict("Launcher enrolled identity changed during startup");
  };
  assertCurrent();
  return { context: { ...latest, setup, planFile, intentFile }, assertCurrent };
}

/** Called by the selected immutable runner. It has no service mutation ports.
 * Native mount, executable, loaded plist and lifetime checks are independent of
 * the stored descriptor; a descriptor alone never establishes native custody. */
export async function verifyNativeMaintenanceLauncherStartup(input: {
  setupFile: string;
  account: { uid: number; home: string };
}) {
  const proof = await readMaintenanceStartupProof(input);
  const context = proof.context;
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(context.setup.nativeAdmission, [])).toString("utf8"),
    ),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  await assertBootstrapPathsProtected(
    [
      input.setupFile,
      context.planFile,
      context.intentFile,
      context.setup.enrollmentStateDirectory,
      context.setup.nativeAdmission.path,
    ],
    roots,
  );
  await verifyMaintenanceLauncherArtifacts({
    plan: context.plan,
    account: input.account,
    writableMountRoots: roots,
  });
  const expectedModule = path.join(
    context.selected.directory,
    "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-maintenance-startup.js",
  );
  const launcher = maintenanceUserLauncher(context.plan, context.selection.slot);
  if (
    fileURLToPath(import.meta.url) !== expectedModule ||
    (await realpath(process.execPath)) !== context.selected.node.path ||
    !isDeepStrictEqual(process.argv, launcher.ProgramArguments)
  )
    throw new BootstrapRequestConflict(
      "Maintenance startup is outside its selected immutable runtime",
    );
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: roots,
  });
  const observed = await verifyMaintenanceLauncherProcess({
    plan: context.plan,
    account: input.account,
    selected: context.selection.slot,
    pid: process.pid,
    reader,
  });
  const launcherBytes = await readProtectedDocument(context.plan.identity.launcherPath);
  const decoded = await readBootstrapLauncher(
    {
      path: context.plan.identity.launcherPath,
      sha256: createHash("sha256").update(launcherBytes).digest("hex"),
    },
    roots,
  );
  if (!isDeepStrictEqual(decoded, launcher))
    throw new BootstrapRequestConflict(
      "Maintenance registered launcher differs from selected slot",
    );
  const current = await readMaintenanceStartupProof(input);
  if (
    !isDeepStrictEqual(startupCustodyBinding(context), startupCustodyBinding(current.context)) ||
    !isDeepStrictEqual(observed, await reader.inspectProcess(process.pid)) ||
    !isDeepStrictEqual(roots, await inspectBootstrapWritableMountRoots(admission))
  )
    throw new BootstrapRequestConflict("Maintenance startup changed during native verification");
  proof.assertCurrent();
  current.assertCurrent();
  return { ...context, process: observed };
}
