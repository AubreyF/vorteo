import path from "node:path";
import { readMaintenanceRecoverySelection } from "./coordinator-bootstrap-maintenance-recovery-startup.js";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
} from "./coordinator-bootstrap-maintenance-selection.js";

/** Stable setup does not contain its own artifact or manifest digest. Those
 * pins live in the reviewed plan, avoiding a self-referential digest cycle. */
export const MaintenanceLauncherSetupSchema = z.strictObject({
  version: z.literal(1),
  installationRoot: z.string().startsWith("/"),
  enrollmentStateDirectory: z.string().startsWith("/"),
  identitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  target: z.enum(["maintenance-controller", "recovery-launcher"]),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  control: z
    .strictObject({
      admissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  nativeAdmission: z.strictObject({
    path: z.string().startsWith("/"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

/** Protected startup loading is observation-only. Native process and artifact
 * verification follow this binding; callers must not dispatch from it alone. */
export async function readMaintenanceLauncherStartup(input: {
  setupFile: string;
  account: { uid: number; home: string };
}) {
  const read = async (file: string) =>
    JSON.parse((await readProtectedDocument(file)).toString("utf8"));
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
  const intentFile =
    selection.version === 1
      ? path.join(
          setup.enrollmentStateDirectory,
          `maintenance-launcher-${selection.stepId}-${selection.generation}.json`,
        )
      : path.join(setup.enrollmentStateDirectory, "restart-jobs.json");
  const journal = new FileEnrollmentJournal(setup.enrollmentStateDirectory);
  const enrollment = journal.read();
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
  const readContext = async () => {
    const common = { plan, account: input.account, enrollment, retained, selection };
    if (selection.version === 1)
      return inspectMaintenanceLauncherSelection({ ...common, intent: await read(intentFile) });
    if (selection.version === 2) return inspectMaintenanceServiceSelection(common);
    return readMaintenanceRecoverySelection({
      ...common,
      stateDirectory: setup.enrollmentStateDirectory,
    });
  };
  const context = await readContext();
  if (
    !isDeepStrictEqual(identity, context.plan.identity) ||
    setup.sourceCommit !== context.selected.sourceCommit ||
    input.setupFile !== context.selected.setup.path
  )
    throw new BootstrapRequestConflict("Launcher startup is not the selected reviewed slot");
  // Selection and grant may change during disk reads. Never return a mixed
  // observation; the native verifier must re-read this binding before effects.
  if (
    !isDeepStrictEqual(selection, await read(identity.selectionPath)) ||
    !isDeepStrictEqual(enrollment, journal.read()) ||
    !isDeepStrictEqual(retained, readRetained())
  )
    throw new BootstrapRequestConflict("Launcher selection changed during startup");
  return { ...context, setup, planFile, intentFile };
}

/** Called by the selected immutable runner. It has no service mutation ports.
 * Native mount, executable, loaded plist and lifetime checks are independent of
 * the stored descriptor; a descriptor alone never establishes native custody. */
export async function verifyNativeMaintenanceLauncherStartup(input: {
  setupFile: string;
  account: { uid: number; home: string };
}) {
  const context = await readMaintenanceLauncherStartup(input);
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
  if (
    !isDeepStrictEqual(context, await readMaintenanceLauncherStartup(input)) ||
    !isDeepStrictEqual(observed, await reader.inspectProcess(process.pid)) ||
    !isDeepStrictEqual(roots, await inspectBootstrapWritableMountRoots(admission))
  )
    throw new BootstrapRequestConflict("Maintenance startup changed during native verification");
  return { ...context, process: observed };
}
