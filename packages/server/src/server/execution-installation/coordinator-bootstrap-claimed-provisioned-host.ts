import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  verifyManagedClaimedPreparation,
  type ClaimedHostInput,
  type ClaimedHostRuntime,
} from "./coordinator-bootstrap-claimed-host.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  BootstrapAdmissionSetupSchema,
  readPrivateBootstrapConfiguration,
  inspectBootstrapWritableMountRoots,
  readBootstrapHostBinding,
} from "./coordinator-bootstrap-host.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { deriveBootstrapRenewal } from "./coordinator-bootstrap-renewal.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { verifyClaimedRepairProvisioning } from "./coordinator-bootstrap-claimed-provisioning.js";
import {
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import {
  validateClaimedRecoveryPlan,
  ClaimedRecoveryReviews,
} from "./coordinator-bootstrap-claimed-recovery.js";
import { FileClaimedRecoveryReviewJournal } from "./coordinator-bootstrap-claimed-journal.js";
import {
  createDispatchingClaimedReview,
  prepareNativeClaimedLaunch,
  launchClaimedObservation,
  readClaimedDispatchObservation,
} from "./coordinator-bootstrap-claimed-launch.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import type { ClaimedRecoveryReviewService } from "./coordinator-bootstrap-session.js";

/** The independent owner-authenticated admission permits observing the genuine
 * installed Host from this controller. Its runtime is retained unchanged; only
 * the repair executable comes from the separately pinned artifact. */
export async function deriveProvisionedClaimedHostRuntime(
  input: Omit<ClaimedHostInput, "ports" | "provisioning"> & {
    provisioning: NonNullable<ClaimedHostInput["provisioning"]>;
  },
): Promise<ClaimedHostRuntime> {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Provisioned repair requires native Host admission");
  const context = input.provisioning;
  if (input.setupFile !== path.join(context.installationRoot, "coordinator-bootstrap-runner.json"))
    throw new BootstrapRequestConflict("Repair requires the fixed installed bootstrap anchor");
  const setup = BootstrapRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(input.setupFile, uid),
  );
  if (setup.daemonId !== input.daemonId || setup.renewal)
    throw new BootstrapRequestConflict("Repair bootstrap anchor changed");
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  const verified = await verifyClaimedRepairProvisioning({
    installationRoot: context.installationRoot,
    admissionSha256: context.admissionSha256,
    plan: input.plan,
    writableMountRoots: roots,
  });
  const journal = new FileBootstrapRequestJournal(input.plan.original.plan.state.directory);
  journal.verifyUnpromotedClaim(input.plan.original);
  const config = z
    .object({
      sourceUpdates: z.object({
        currentReleaseLink: z.string().startsWith("/"),
      }),
    })
    .parse(readPrivateBootstrapConfiguration(admission.configurationFile, uid));
  const selectedHost = await realpath(config.sourceUpdates.currentReleaseLink);
  const hostRuntime = await deriveBootstrapRenewal({
    setupFile: input.setupFile,
    setup,
    // The owner-pinned plan supplies a process birth, not a daemon RPC claim.
    // Recovery remains possible while the old Host listener is unavailable;
    // native inspection below must match that complete retained identity.
    hostPid: input.plan.hostProcess.pid,
    moduleFile: path.join(
      selectedHost,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-launch.js",
    ),
    dispatchedRequest: {
      id: input.plan.original.id,
      planSha256: input.plan.original.planSha256,
    },
  });
  if (
    !hostRuntime?.renewal ||
    !isDeepStrictEqual(hostRuntime.renewal.hostProcess, input.plan.hostProcess)
  )
    throw new BootstrapRequestConflict("Repair observed Host identity changed");
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: roots,
  });
  const control = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
  const runtime = verified.receipt.runtime;
  const args = [
    hostRuntime.node.path,
    runtime.entrypoint.path,
    context.installationRoot,
    "claimed-repair-control",
    context.admissionSha256,
  ];
  if (
    !isDeepStrictEqual(control, context.controlProcess) ||
    control.uid !== uid ||
    control.executable !== hostRuntime.node.path ||
    control.argumentsSha256 !== createHash("sha256").update(JSON.stringify(args)).digest("hex") ||
    !isDeepStrictEqual(process.argv, args)
  )
    throw new BootstrapRequestConflict("Repair control process is not the provisioned entrypoint");
  const renewal = {
    ...hostRuntime.renewal,
    request: {
      id: input.plan.original.id,
      revision: input.plan.original.revision,
      planSha256: input.plan.original.planSha256,
    },
  };
  await readBootstrapPreparedFile(hostRuntime.renewal.originalSetup, roots);
  await readBootstrapPreparedFile(hostRuntime.renewal.originalAdmission, roots);
  journal.verifyUnpromotedClaim(input.plan.original);
  await verifyClaimedRepairProvisioning({
    ...context,
    plan: input.plan,
    writableMountRoots: roots,
  });
  return {
    ...hostRuntime,
    runtimeDirectory: runtime.directory,
    runtimeSha256: runtime.artifactSha256,
    entrypoint: runtime.entrypoint,
    ownerLauncher: runtime.ownerLauncher,
    ownershipVerifier: runtime.ownershipVerifier,
    renewal,
    provisioning: { ...context, hostRuntime: { ...hostRuntime, renewal } },
  };
}

/** Construction observes retained work; only a fresh exact owner decision
 * invokes launch. Reopening the controller cannot replay approval. */
export async function createProvisionedClaimedRecoveryReview(input: {
  installationRoot: string;
  admissionSha256: string;
}): Promise<
  ClaimedRecoveryReviewService & {
    controlProcess: z.infer<typeof ProcessObservationSchema>;
  }
> {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native repair controller required");
  const setupFile = path.join(input.installationRoot, "coordinator-bootstrap-runner.json");
  const setup = BootstrapRunnerSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid));
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  const plan = validateClaimedRecoveryPlan(
    JSON.parse(
      (
        await readProtectedDocument(path.join(input.installationRoot, "claimed-repair-plan.json"))
      ).toString("utf8"),
    ),
  );
  const verified = await verifyClaimedRepairProvisioning({
    ...input,
    plan,
    writableMountRoots: roots,
  });
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: roots,
  });
  const controlProcess = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
  const controlArgs = [
    setup.node.path,
    verified.receipt.runtime.entrypoint.path,
    input.installationRoot,
    "claimed-repair-control",
    input.admissionSha256,
  ];
  if (
    controlProcess.uid !== uid ||
    controlProcess.executable !== setup.node.path ||
    controlProcess.argumentsSha256 !==
      createHash("sha256").update(JSON.stringify(controlArgs)).digest("hex") ||
    !isDeepStrictEqual(process.argv, controlArgs)
  )
    throw new BootstrapRequestConflict("Repair controls must run from the provisioned entrypoint");
  const context = {
    setupFile,
    daemonId: setup.daemonId,
    provisioning: { ...input, controlProcess },
  };
  const state = plan.original.plan.state.directory;
  const original = new FileBootstrapRequestJournal(state);
  const journal = new FileClaimedRecoveryReviewJournal(state);
  const verify = () => verifyManagedClaimedPreparation({ ...context, plan });
  const current = original.read().find((record) => record.id === plan.original.id);
  if (isDeepStrictEqual(current, plan.original)) {
    await verify();
  } else {
    const matches = journal
      .readReviews()
      .filter((review) => isDeepStrictEqual(review.plan, plan) && review.execution);
    if (matches.length !== 1 || current?.execution?.stage !== "recovery_required")
      throw new BootstrapRequestConflict("Provisioned recovery history is ambiguous");
    journal.inspectEffects(matches[0]);
  }
  const readBinding = () => {
    const result = readBootstrapHostBinding(plan.selectedConfiguration.path, setup.daemonId);
    if (result.stateDirectory !== state)
      throw new BootstrapRequestConflict("Provisioned recovery state changed");
    return result.binding;
  };
  const reviews = new ClaimedRecoveryReviews(journal, readBinding, async (candidate) => {
    if (!isDeepStrictEqual(candidate, plan))
      throw new BootstrapRequestConflict("Only the provisioned recovery plan is admitted");
    await verify();
  });
  const service = createDispatchingClaimedReview(reviews, (request) =>
    prepareNativeClaimedLaunch({ ...context, request }),
  );
  return {
    ...service,
    controlProcess,
    reconcile: (request) => launchClaimedObservation(state, request),
    list: () =>
      service
        .list()
        .filter((request) => isDeepStrictEqual(request.plan, plan))
        .map((request) =>
          Object.assign({}, request, {
            dispatch: readClaimedDispatchObservation(state, request),
          }),
        ),
  };
}
