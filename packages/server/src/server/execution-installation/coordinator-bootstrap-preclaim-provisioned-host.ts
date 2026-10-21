import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type BootstrapPreclaimRecoveryPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import {
  BootstrapAdmissionSetupSchema,
  readPrivateBootstrapConfiguration,
  inspectBootstrapWritableMountRoots,
  readBootstrapHostBinding,
} from "./coordinator-bootstrap-host.js";
import { deriveBootstrapRenewal, verifyRetainedRenewal } from "./coordinator-bootstrap-renewal.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import {
  PreclaimRepairProvisioningSchema,
  resolvePreclaimRepairFiles,
  verifyPreclaimRepairProvisioning,
  assertPreclaimRepairOriginal,
} from "./coordinator-bootstrap-preclaim-provisioning.js";
import { readProtectedDocument } from "./coordinator-bootstrap-artifact.js";
import {
  validatePreclaimRecoveryPlan,
  PreclaimRecoveryReviews,
} from "./coordinator-bootstrap-preclaim-recovery.js";
import { FileBootstrapPreclaimJournal } from "./coordinator-bootstrap-preclaim-journal.js";
import {
  PreclaimRunnerSetupSchema,
  derivePreclaimHostRuntime,
  verifyManagedPreclaimPreparation,
  prepareNativePreclaimLaunch,
  createDispatchingPreclaimReview,
  readPreclaimDispatchObservation,
  launchPreclaimObservation,
} from "./coordinator-bootstrap-launch.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";

type HostInput = Parameters<typeof derivePreclaimHostRuntime>[0];
interface ProvisionedHostInput extends HostInput {
  plan: BootstrapPreclaimRecoveryPlan;
  provisioning: NonNullable<HostInput["provisioning"]>;
}

/** The admitted controller observes the genuine Host. Its own repair artifact
 * never becomes the selected Host release or acquires the Host's source receipt. */
export async function deriveProvisionedPreclaimHostRuntime(input: ProvisionedHostInput) {
  const uid = process.getuid?.();
  const context = input.provisioning;
  if (process.platform !== "darwin" || uid === undefined || input.ports)
    throw new BootstrapRequestConflict(
      "Native preclaim provisioning cannot override inspection ports",
    );
  if (input.setupFile !== path.join(context.installationRoot, "coordinator-bootstrap-runner.json"))
    throw new BootstrapRequestConflict("Preclaim repair requires its fixed installation anchor");
  const setup = BootstrapRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(input.setupFile, uid),
  );
  if (setup.daemonId !== input.daemonId || setup.renewal)
    throw new BootstrapRequestConflict("Preclaim repair anchor changed");
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  const binding = { ...context, plan: input.plan, writableMountRoots: roots };
  assertPreclaimRepairOriginal(binding);
  const { receipt } = await verifyPreclaimRepairProvisioning(binding);
  const config = z
    .object({ sourceUpdates: z.object({ currentReleaseLink: z.string().startsWith("/") }) })
    .parse(readPrivateBootstrapConfiguration(admission.configurationFile, uid));
  const selected = await realpath(config.sourceUpdates.currentReleaseLink);
  const hostRuntime = await deriveBootstrapRenewal({
    setupFile: input.setupFile,
    setup,
    hostPid: input.plan.hostProcess.pid,
    moduleFile: path.join(
      selected,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-launch.js",
    ),
    ...(input.ownerCancellation
      ? {}
      : { dispatchedRequest: { id: input.original.id, planSha256: input.original.planSha256 } }),
  });
  if (
    !hostRuntime?.renewal ||
    !isDeepStrictEqual(hostRuntime.renewal.hostProcess, input.plan.hostProcess)
  )
    throw new BootstrapRequestConflict("Preclaim repair observed another selected Host");
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: roots,
  });
  const control = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
  const args = [
    hostRuntime.node.path,
    receipt.runtime.entrypoint.path,
    context.installationRoot,
    "preclaim-repair-control",
    context.admissionSha256,
  ];
  if (
    !isDeepStrictEqual(control, context.controlProcess) ||
    !isDeepStrictEqual(process.argv, args) ||
    control.executable !== hostRuntime.node.path ||
    control.argumentsSha256 !== createHash("sha256").update(JSON.stringify(args)).digest("hex")
  )
    throw new BootstrapRequestConflict("Preclaim repair controller is not the admitted process");
  const renewal = {
    ...hostRuntime.renewal,
    request: {
      id: input.original.id,
      revision: input.original.revision,
      planSha256: input.original.planSha256,
    },
  };
  assertPreclaimRepairOriginal(binding);
  await verifyPreclaimRepairProvisioning(binding);
  return {
    ...hostRuntime,
    runtimeDirectory: receipt.runtime.directory,
    runtimeSha256: receipt.runtime.artifactSha256,
    entrypoint: receipt.runtime.entrypoint,
    ownerLauncher: receipt.runtime.ownerLauncher,
    ownershipVerifier: receipt.runtime.ownershipVerifier,
    renewal,
    provisioning: { ...context, hostRuntime: { ...hostRuntime, renewal } },
  };
}

export function assertProvisionedPreclaimRuntimeBinding(input: {
  setup: z.infer<typeof PreclaimRunnerSetupSchema>;
  receipt: z.infer<typeof PreclaimRepairProvisioningSchema>;
  plan: BootstrapPreclaimRecoveryPlan;
}) {
  const { setup, receipt, plan } = input;
  const provision = setup.provisioning;
  if (!provision) throw new BootstrapRequestConflict("Explicit preclaim provisioning required");
  const host = provision.hostRuntime;
  const runtime = receipt.runtime;
  if (
    setup.runtimeDirectory !== runtime.directory ||
    setup.runtimeSha256 !== runtime.artifactSha256 ||
    !isDeepStrictEqual(setup.entrypoint, runtime.entrypoint) ||
    !isDeepStrictEqual(setup.ownerLauncher, runtime.ownerLauncher) ||
    !isDeepStrictEqual(setup.ownershipVerifier, runtime.ownershipVerifier) ||
    !isDeepStrictEqual(setup.node, host.node) ||
    setup.daemonId !== host.daemonId ||
    setup.admissionSetupFile !== host.admissionSetupFile ||
    !isDeepStrictEqual(setup.renewal, host.renewal) ||
    !isDeepStrictEqual(setup.renewal.configuration, plan.selectedConfiguration) ||
    !isDeepStrictEqual(setup.renewal.hostProcess, plan.hostProcess) ||
    !isDeepStrictEqual(setup.original, {
      id: plan.original.id,
      revision: plan.original.revision,
      planSha256: plan.original.planSha256,
    }) ||
    !isDeepStrictEqual(setup.renewal.request, setup.original) ||
    setup.stateDirectory !== plan.original.plan.state.directory ||
    setup.stateDirectory !== path.join(provision.installationRoot, "state/coordinator") ||
    setup.selectedLauncherFile !== plan.selectedLauncher.path
  )
    throw new BootstrapRequestConflict("Provisioned preclaim runtime binding changed");
  assertPreclaimControlBinding({ setup, provision, plan });
}

export function assertPreclaimControlBinding(input: {
  setup: Pick<z.infer<typeof BootstrapRunnerSetupSchema>, "node" | "entrypoint">;
  provision: Pick<
    NonNullable<z.infer<typeof PreclaimRunnerSetupSchema>["provisioning"]>,
    "installationRoot" | "admissionSha256" | "controlProcess"
  >;
  plan: BootstrapPreclaimRecoveryPlan;
}) {
  const { setup, provision, plan } = input;
  const control = provision.controlProcess;
  const args = [
    setup.node.path,
    setup.entrypoint.path,
    provision.installationRoot,
    "preclaim-repair-control",
    provision.admissionSha256,
  ];
  if (
    [plan.hostProcess.pid, plan.executor.identity.pid, plan.coordinatorProcess.pid].includes(
      control.pid,
    ) ||
    control.uid !== plan.hostProcess.uid ||
    control.bootId !== plan.hostProcess.bootId ||
    control.executable !== setup.node.path ||
    control.argumentsSha256 !== createHash("sha256").update(JSON.stringify(args)).digest("hex")
  )
    throw new BootstrapRequestConflict("Provisioned preclaim control binding changed");
}

export async function verifyProvisionedPreclaimRuntime(input: {
  setup: z.infer<typeof PreclaimRunnerSetupSchema>;
  plan: BootstrapPreclaimRecoveryPlan;
  writableMountRoots: readonly string[];
  retained: boolean;
}) {
  const provision = input.setup.provisioning;
  if (!provision) throw new BootstrapRequestConflict("Explicit preclaim provisioning required");
  const { receipt } = await verifyPreclaimRepairProvisioning({
    ...provision,
    plan: input.plan,
    writableMountRoots: input.writableMountRoots,
  });
  assertProvisionedPreclaimRuntimeBinding({ ...input, receipt });
  await verifyRetainedRenewal(provision.hostRuntime, undefined, input.retained);
  return provision.hostRuntime;
}

export async function createProvisionedPreclaimRecoveryReview(input: {
  installationRoot: string;
  admissionSha256: string;
}) {
  const setupFile = path.join(input.installationRoot, "coordinator-bootstrap-runner.json");
  const setup = BootstrapRunnerSetupSchema.parse(
    JSON.parse((await readProtectedDocument(setupFile)).toString("utf8")),
  );
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse((await readProtectedDocument(setup.admissionSetupFile)).toString("utf8")),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  const files = await resolvePreclaimRepairFiles({ ...input, writableMountRoots: roots });
  const plan = validatePreclaimRecoveryPlan(
    JSON.parse((await readProtectedDocument(files.plan)).toString("utf8")),
  );
  await verifyPreclaimRepairProvisioning({ ...input, plan, writableMountRoots: roots });
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: roots,
  });
  const controlProcess = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
  const context = {
    setupFile,
    daemonId: setup.daemonId,
    plan,
    original: plan.original,
    provisioning: { ...input, controlProcess },
  };
  const state = plan.original.plan.state.directory;
  const journal = new FileBootstrapPreclaimJournal(state);
  const readBinding = () => {
    const binding = readBootstrapHostBinding(plan.selectedConfiguration.path, setup.daemonId);
    if (binding.stateDirectory !== state)
      throw new BootstrapRequestConflict("Preclaim repair state changed");
    return binding.binding;
  };
  const reviews = new PreclaimRecoveryReviews(journal, readBinding, async (candidate) => {
    if (!isDeepStrictEqual(candidate, plan))
      throw new BootstrapRequestConflict("Only the admitted preclaim plan is permitted");
    await verifyManagedPreclaimPreparation(context, candidate);
  });
  const service = createDispatchingPreclaimReview(reviews, (request) =>
    prepareNativePreclaimLaunch({ ...context, request }),
  );
  return {
    ...service,
    controlProcess,
    reconcile: (identity: Parameters<typeof launchPreclaimObservation>[1]) =>
      launchPreclaimObservation(state, identity),
    list: () =>
      service.list().map((request) =>
        Object.assign({}, request, {
          dispatch: readPreclaimDispatchObservation(state, request),
        }),
      ),
  };
}
