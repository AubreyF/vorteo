import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import type {
  CoordinatorBootstrapPlan,
  CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import { BootstrapRequestConflict, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import {
  readBootstrapPreparedFile,
  readProtectedDocument,
  digestBootstrapArtifact,
} from "./coordinator-bootstrap-artifact.js";
import {
  inspectBootstrapWritableMountRoots,
  BootstrapAdmissionSetupSchema,
  readPrivateBootstrapConfiguration,
  verifyBootstrapConfiguration,
} from "./coordinator-bootstrap-host.js";
import { inspectMaintenanceAdmission } from "./coordinator-bootstrap-maintenance-admission.js";
import { verifyRetainedRenewal, verifyHistoricalRenewal } from "./coordinator-bootstrap-renewal.js";

type Runner = z.infer<typeof BootstrapRunnerSetupSchema>;

/** Read the admitted immutable snapshots without depending on the currently
 * selected Host or a live controller. Watchdog recovery needs this distinction. */
async function readMaintenanceRuntime(setup: Runner) {
  const binding = setup.maintenance;
  if (!binding || !setup.renewal)
    throw new BootstrapRequestConflict("Exact maintenance admission is required");
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, process.getuid!()),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  const directory = path.join(
    binding.installationRoot,
    "maintenance-admissions",
    binding.admissionSha256,
  );
  const receipt = JSON.parse(
    (
      await readBootstrapPreparedFile(
        { path: path.join(directory, "admission.json"), sha256: binding.admissionSha256 },
        roots,
      )
    ).toString("utf8"),
  );
  const read = async (name: string) =>
    JSON.parse((await readProtectedDocument(path.join(directory, name))).toString("utf8"));
  const context = inspectMaintenanceAdmission({
    installationRoot: binding.installationRoot,
    receipt,
    plan: await read("plan.json"),
    hostSetup: await read("host.json"),
    runnerSetup: await read("runner.json"),
  });
  assertMaintenanceExecutionBinding(
    setup,
    context.runner,
    context.receipt.planSha256,
    context.receipt.requestId,
  );
  return { ...context, roots, binding };
}

export function assertMaintenanceExecutionBinding(
  setup: Runner,
  prepared: Runner,
  planSha256: string,
  requestId: string,
) {
  if (
    !setup.maintenance ||
    !setup.renewal ||
    !prepared.renewal ||
    prepared.maintenance ||
    prepared.renewal.request
  )
    throw new BootstrapRequestConflict(
      "Maintenance execution snapshot is not independently admitted",
    );
  const { maintenance: _binding, ...runtime } = setup;
  const { request, ...renewal } = runtime.renewal!;
  if (
    !isDeepStrictEqual({ ...runtime, renewal }, prepared) ||
    (request && (request.planSha256 !== planSha256 || request.id !== requestId))
  )
    throw new BootstrapRequestConflict(
      "Maintenance execution changed its admitted runtime or plan",
    );
}

export async function verifyMaintenanceRunnerPlan(setup: Runner, plan: CoordinatorBootstrapPlan) {
  const context = await readMaintenanceRuntime(setup);
  if (
    !isDeepStrictEqual(context.plan, plan) ||
    coordinatorPlanDigest(plan) !== context.receipt.planSha256
  )
    throw new BootstrapRequestConflict("Maintenance plan differs from owner-admitted proposal");
  verifyBootstrapConfiguration({
    plan,
    configurationFile: context.host.renewal!.configuration.path,
    daemonId: context.host.daemonId,
  });
}

/** Retirement may observe the admitted controller as parent, without treating
 * that controller as the retained Host daemon or granting it new authority. */
export async function verifyMaintenancePreclaimParent(
  setup: Runner,
  parent: z.infer<typeof ProcessObservationSchema>,
) {
  const context = await readMaintenanceRuntime(setup);
  const host = context.host.renewal!;
  const args = [
    setup.node.path,
    setup.entrypoint.path,
    context.binding.installationRoot,
    "maintenance-control",
    context.binding.admissionSha256,
  ];
  if (
    parent.executable !== setup.node.path ||
    parent.uid !== host.hostProcess.uid ||
    parent.bootId !== host.hostProcess.bootId ||
    parent.argumentsSha256 !== createHash("sha256").update(JSON.stringify(args)).digest("hex") ||
    context.receipt.requestId !== setup.renewal?.request?.id ||
    context.receipt.planSha256 !== setup.renewal?.request?.planSha256
  )
    throw new BootstrapRequestConflict("Preclaim parent differs from its admitted controller");
  return host;
}

export async function verifyMaintenanceRetainedRuntime(input: {
  setup: Runner;
  request?: CoordinatorBootstrapRequest;
  watchdog: boolean;
  historical: boolean;
}) {
  const { setup, request, watchdog, historical } = input;
  const context = await readMaintenanceRuntime(setup);
  if (
    request &&
    (request.planSha256 !== context.receipt.planSha256 ||
      !isDeepStrictEqual(request.plan, context.plan) ||
      request.automaticApproval ||
      request.automaticSubmission)
  )
    throw new BootstrapRequestConflict("Maintenance requires its exact manual owner decision");
  for (const file of [setup.entrypoint, setup.ownerLauncher, setup.ownershipVerifier])
    await readBootstrapPreparedFile(file, context.roots);
  if (!watchdog && (await digestBootstrapArtifact(setup.runtimeDirectory)) !== setup.runtimeSha256)
    throw new BootstrapRequestConflict("Admitted maintenance runtime changed");
  const host: Runner = {
    ...context.host,
    renewal: {
      ...context.host.renewal!,
      ...(setup.renewal!.request ? { request: setup.renewal!.request } : {}),
    },
  };
  // Validate original Host provenance, never a fabricated source receipt in the
  // independent maintenance tree. History and native absence proofs remain intact.
  if (historical) await verifyHistoricalRenewal(host);
  else await verifyRetainedRenewal(host, request, watchdog);
}

export async function verifyMaintenanceBeforeDispatch(setup: Runner) {
  const context = await readMaintenanceRuntime(setup);
  const { verifyNativeMaintenanceProposal } =
    await import("./coordinator-bootstrap-maintenance-native.js");
  await verifyNativeMaintenanceProposal(
    {
      ...context.binding,
      plan: context.plan,
      hostSetup: context.host,
      runnerSetup: context.runner,
    },
    setup.renewal?.request,
  );
}
